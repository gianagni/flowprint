/**
 * Flowprint M0 — benchmark runner.
 *
 * Usage: pnpm benchmark
 * Runs the analyzer against every fixture repo (cloned under bench/repos/),
 * compares with ground truth, and prints a metrics report.
 * Results are written to bench/results/<timestamp>.json for the M0 report.
 *
 * v0.1-alpha harness (GAPs 2/3/4):
 *  - GAP 2 (SHA-pinned fixtures): every repo is pinned in bench/harness/pins.json.
 *    Before analysis the clone's HEAD SHA is resolved; drift (no pin entry, or
 *    HEAD != pinned SHA) is recorded as status REPO_DRIFT — the repo is NOT
 *    compared.
 *  - GAP 3 (clone integrity): <repo>/.git must exist and `git rev-parse HEAD`
 *    must match the pin. A repo that is not in its pinned state (missing dir,
 *    missing .git) is REPO_DRIFT; a git failure on a repo that HAS .git is
 *    ANALYZER_FAILURE (integrity failure). Analysis never runs on an
 *    unverified clone.
 *  - GAP 4 (worker isolation): each repo is analyzed in a worker thread
 *    (bench/harness/worker.ts) with a per-repo timeout. Worker crash / error /
 *    timeout is recorded as ANALYZER_FAILURE; the benchmark continues loudly.
 *
 * v2 verdict taxonomy (see bench/harness/compare.ts for the full per-check
 * rules): per-check verdicts are OK / HONEST_UNKNOWN / UNSUPPORTED_FEATURE /
 * FIXTURE_GAP / MISMATCH / CONFIDENTLY_WRONG. Repo-level statuses are
 * OK / REPO_DRIFT / ANALYZER_FAILURE. Every check also records its
 * v0.1-alpha `legacyVerdict`, and every repo its `legacyStatus`, so
 * old-style totals are exact and the 5-repo regression can be compared
 * against the v0.1-alpha baseline.
 *
 * Repo selection: by default every fixture in bench/fixtures/ runs. Pass
 * --slugs a,b,c (or set BENCH_SLUGS=a,b,c) to run a subset, e.g.
 * `pnpm benchmark -- --slugs openstatus,formbricks,caldiy,karakeep,dub`
 * for the v0.1-alpha stage-1 5-repo regression.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { loadFixtures, type Fixture } from './fixture.js';
import { compareRepo, type LegacyCounts, type RepoReport, type VerdictCounts } from './compare.js';
import type { AnalysisResult } from '../../packages/flowprint/src/model/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const m0Root = join(here, '..', '..');
const reposDir = join(m0Root, 'bench', 'repos');
const fixturesDir = join(m0Root, 'bench', 'fixtures');
const resultsDir = join(m0Root, 'bench', 'results');
const workerPath = join(here, 'worker.ts');
const pinsPath = join(here, 'pins.json');

/** Per-repo wall-clock budget for the analysis worker (GAP 4). */
export const WORKER_TIMEOUT_MS = 5 * 60 * 1000;

/** v2 repo statuses. */
export type RepoStatus = 'OK' | 'REPO_DRIFT' | 'ANALYZER_FAILURE';

/** v0.1-alpha repo statuses, kept for exact backward comparison. */
export type LegacyRepoStatus = 'OK' | 'DRIFT' | 'INTEGRITY_FAIL' | 'RUNNER_FAILED';

/**
 * Why a repo did not complete normally. v2 status and legacy status are
 * both derived from this, so the mapping is explicit and exact:
 *   no-pin, sha-drift, repo-missing, no-git -> REPO_DRIFT / DRIFT (no-pin,
 *     sha-drift) or INTEGRITY_FAIL (repo-missing, no-git)
 *   git-fail                               -> ANALYZER_FAILURE / INTEGRITY_FAIL
 *   runner                                 -> ANALYZER_FAILURE / RUNNER_FAILED
 */
export type FailureKind = 'no-pin' | 'sha-drift' | 'repo-missing' | 'no-git' | 'git-fail' | 'runner';

function statusesFor(kind: FailureKind): { status: RepoStatus; legacyStatus: LegacyRepoStatus } {
  switch (kind) {
    case 'no-pin':
    case 'sha-drift':
      return { status: 'REPO_DRIFT', legacyStatus: 'DRIFT' };
    case 'repo-missing':
    case 'no-git':
      // The repo is not in its pinned state (nothing to verify against);
      // v0.1-alpha called these INTEGRITY_FAIL.
      return { status: 'REPO_DRIFT', legacyStatus: 'INTEGRITY_FAIL' };
    case 'git-fail':
      return { status: 'ANALYZER_FAILURE', legacyStatus: 'INTEGRITY_FAIL' };
    case 'runner':
      return { status: 'ANALYZER_FAILURE', legacyStatus: 'RUNNER_FAILED' };
  }
}

/**
 * RepoReport plus harness status. Backward-compatible with the old results
 * JSON: same per-repo fields, plus `status` (v2), `legacyStatus`
 * (v0.1-alpha), `failureKind`, and optional `details`.
 * For non-OK statuses, checks is empty, counts are zero, and
 * resolutionStats is null (no analysis ran).
 */
export interface HarnessRepoReport extends RepoReport {
  status: RepoStatus;
  legacyStatus: LegacyRepoStatus;
  /** Why this repo did not complete normally (absent when status is OK). */
  failureKind?: FailureKind;
  /** Human-readable reason for REPO_DRIFT / ANALYZER_FAILURE. */
  details?: string;
}

interface Pin {
  repo: string;
  expectedSha: string;
  pinnedAt: string;
}
type Pins = Record<string, Pin>;

/** Fail closed: without pins there is nothing trustworthy to compare against. */
async function loadPins(): Promise<Pins> {
  let raw: string;
  try {
    raw = await readFile(pinsPath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read pins file ${pinsPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const pins = JSON.parse(raw) as Pins;
    if (typeof pins !== 'object' || pins === null) throw new Error('not an object');
    return pins;
  } catch (err) {
    throw new Error(`cannot parse pins file ${pinsPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function gitHeadSha(repoPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd: repoPath, timeout: 15000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

type Integrity =
  | { ok: true; actualSha: string }
  | { ok: false; kind: Exclude<FailureKind, 'no-pin' | 'runner'>; reason: string };

/** GAP 3 — verify the clone before any analysis touches it. */
async function checkIntegrity(repoPath: string, pin: Pin): Promise<Integrity> {
  if (!existsSync(repoPath)) return { ok: false, kind: 'repo-missing', reason: `repo directory not present at ${repoPath}` };
  if (!existsSync(join(repoPath, '.git'))) return { ok: false, kind: 'no-git', reason: '.git missing — not a git clone' };
  let actual: string;
  try {
    actual = await gitHeadSha(repoPath);
  } catch (err) {
    return { ok: false, kind: 'git-fail', reason: `git rev-parse HEAD failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (actual !== pin.expectedSha) {
    return { ok: false, kind: 'sha-drift', reason: `SHA mismatch (drift): expected ${pin.expectedSha}, actual ${actual}` };
  }
  return { ok: true, actualSha: actual };
}

/**
 * GAP 4 — run a worker file and return its posted result.
 * Rejects on worker error, non-zero exit without a result, malformed message,
 * or timeout (the worker is terminated). Exported so the isolation behavior
 * can be tested independently of the benchmark (see docs/v01-alpha-harness.md).
 */
export function runWorkerFile(
  workerFile: string,
  data: unknown,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker: Worker;
    try {
      // No execArgv tweaks needed: tsx's ESM loader hooks propagate to
      // worker_threads on this runtime (verified 2026-10-06, node 24 + tsx 4).
      worker = new Worker(workerFile, { workerData: data });
    } catch (err) {
      reject(err);
      return;
    }
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        worker.terminate().finally(() => {
          reject(new Error(`worker timed out after ${timeoutMs}ms and was terminated`));
        });
      });
    }, timeoutMs);
    worker.once('message', (msg: unknown) => {
      finish(() => {
        worker.terminate().finally(() => {
          if (msg !== null && typeof msg === 'object' && 'ok' in msg) {
            const m = msg as { ok: boolean; result?: unknown; error?: unknown };
            if (m.ok) resolve(m.result);
            else reject(new Error(`worker reported error: ${String(m.error ?? 'unknown error')}`));
          } else {
            reject(new Error(`worker posted malformed message: ${JSON.stringify(msg)?.slice(0, 200)}`));
          }
        });
      });
    });
    worker.once('error', (err) => {
      finish(() => reject(err));
    });
    worker.once('exit', (code) => {
      finish(() => reject(new Error(`worker exited before posting a result (exit code ${code})`)));
    });
  });
}

/** GAP 4 — analyze one repo in an isolated worker thread. */
export function runAnalysisInWorker(
  repoPath: string,
  probeImports: Array<{ fromFile: string; specifier: string }>,
  timeoutMs: number = WORKER_TIMEOUT_MS,
): Promise<unknown> {
  return runWorkerFile(workerPath, { repoPath, probeImports }, timeoutMs);
}

const zeroCounts: VerdictCounts = {
  ok: 0, honestUnknown: 0, unsupportedFeature: 0, fixtureGap: 0, mismatch: 0, confidentlyWrong: 0,
};
const zeroLegacyCounts: LegacyCounts = {
  ok: 0, missing: 0, mismatch: 0, confidentlyWrong: 0, honestUnknown: 0,
};

function failedReport(
  fixture: Fixture,
  kind: FailureKind,
  details: string,
  t0: number,
): HarnessRepoReport {
  const { status, legacyStatus } = statusesFor(kind);
  return {
    repo: fixture.repo,
    durationMs: Date.now() - t0,
    checks: [],
    counts: { ...zeroCounts },
    legacyCounts: { ...zeroLegacyCounts },
    // No analysis ran, so there are no stats. Cast (not field access): the
    // AnalysisResult shape is owned by a sibling agent; run.ts treats it as
    // opaque and must not construct or inspect it.
    resolutionStats: null as unknown as RepoReport['resolutionStats'],
    status,
    legacyStatus,
    failureKind: kind,
    details,
  };
}

async function runRepo(fixture: Fixture, pins: Pins): Promise<HarnessRepoReport> {
  const t0 = Date.now();
  // Fixture slug == clone directory name (see bench/repos/).
  const repoPath = join(reposDir, fixture.slug);
  console.log(`\n=== ${fixture.repo} ===`);

  // GAP 2(c): no pin entry -> REPO_DRIFT, never compare.
  const pin = pins[fixture.slug];
  if (!pin) {
    return failedReport(
      fixture,
      'no-pin',
      `no pin entry for slug "${fixture.slug}" in ${pinsPath}; refusing to compare against an unpinned fixture`,
      t0,
    );
  }

  // GAP 3: integrity before analysis. GAP 2(a)/(b): drift classification.
  const integrity = await checkIntegrity(repoPath, pin);
  if (!integrity.ok) {
    const details =
      integrity.kind === 'sha-drift'
        ? `${integrity.reason} (pinned ${pin.pinnedAt}) — comparison skipped`
        : integrity.reason;
    return failedReport(fixture, integrity.kind, details, t0);
  }
  console.log(`  integrity OK: HEAD ${integrity.actualSha.slice(0, 12)} == pin (${pin.pinnedAt})`);

  // GAP 4: analyze in a worker thread.
  let actual: AnalysisResult;
  try {
    actual = (await runAnalysisInWorker(repoPath, fixture.importCases.map((ic) => ({
      fromFile: ic.fromFile,
      specifier: ic.specifier,
    })))) as AnalysisResult;
  } catch (err) {
    return failedReport(
      fixture,
      'runner',
      `analysis worker failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
      t0,
    );
  }
  actual.durationMs = Date.now() - t0;
  const report = compareRepo(fixture, actual);
  return { ...report, status: 'OK' as RepoStatus, legacyStatus: 'OK' as LegacyRepoStatus };
}

function printFailedReport(r: HarnessRepoReport): void {
  console.log(`  !! ${r.status}: ${r.details}`);
  console.log(`  duration: ${(r.durationMs / 1000).toFixed(1)}s (no comparison run)`);
}

function fmtCountsV2(c: VerdictCounts): string {
  return `OK=${c.ok} U=${c.honestUnknown} UNSUP=${c.unsupportedFeature} GAP=${c.fixtureGap} ` +
    `MM=${c.mismatch} WRONG=${c.confidentlyWrong}`;
}

function fmtCountsLegacy(c: LegacyCounts): string {
  return `OK=${c.ok} MISS=${c.missing} MM=${c.mismatch} WRONG=${c.confidentlyWrong} U=${c.honestUnknown}`;
}

function printRepoReport(r: HarnessRepoReport): void {
  const c = r.counts;
  console.log(`  duration: ${(r.durationMs / 1000).toFixed(1)}s`);
  console.log(`  checks (v2):     ${fmtCountsV2(c)}`);
  console.log(`  checks (legacy): ${fmtCountsLegacy(r.legacyCounts)}`);
  // resolutionStats belongs to the AnalysisResult shape owned by a sibling
  // agent: print it only when the fields we know are present, never assume it.
  const rs = r.resolutionStats as unknown as Record<string, unknown> | null;
  if (
    rs !== null && typeof rs === 'object' &&
    typeof rs.total === 'number' && typeof rs.resolvedR === 'number' &&
    typeof rs.resolvedI === 'number' && typeof rs.unresolvedU === 'number' &&
    typeof rs.typeOnly === 'number'
  ) {
    console.log(`  resolution: total=${rs.total} R=${rs.resolvedR} I=${rs.resolvedI} U=${rs.unresolvedU} typeOnly=${rs.typeOnly}`);
  } else {
    console.log('  resolution: (stats not present in this result shape)');
  }
  for (const chk of r.checks) {
    if (chk.verdict === 'OK') continue;
    console.log(`  [${chk.verdict}] ${chk.area} :: ${chk.subject}`);
    console.log(`      expected: ${chk.expected}`);
    console.log(`      actual:   ${chk.actual}`);
    if (chk.detail) console.log(`      detail:   ${chk.detail}`);
  }
}

function printSummary(reports: HarnessRepoReport[]): void {
  console.log('\n========== SUMMARY ==========');
  const tot: VerdictCounts = {
    ok: 0, honestUnknown: 0, unsupportedFeature: 0, fixtureGap: 0, mismatch: 0, confidentlyWrong: 0,
  };
  const legTot: LegacyCounts = { ok: 0, missing: 0, mismatch: 0, confidentlyWrong: 0, honestUnknown: 0 };
  const byStatus: Record<RepoStatus, number> = { OK: 0, REPO_DRIFT: 0, ANALYZER_FAILURE: 0 };
  const byLegacyStatus: Record<LegacyRepoStatus, number> = {
    OK: 0, DRIFT: 0, INTEGRITY_FAIL: 0, RUNNER_FAILED: 0,
  };
  let totalMs = 0;
  for (const r of reports) {
    totalMs += r.durationMs;
    byStatus[r.status]++;
    byLegacyStatus[r.legacyStatus]++;
    if (r.status === 'OK') {
      tot.ok += r.counts.ok;
      tot.honestUnknown += r.counts.honestUnknown;
      tot.unsupportedFeature += r.counts.unsupportedFeature;
      tot.fixtureGap += r.counts.fixtureGap;
      tot.mismatch += r.counts.mismatch;
      tot.confidentlyWrong += r.counts.confidentlyWrong;
      legTot.ok += r.legacyCounts.ok;
      legTot.missing += r.legacyCounts.missing;
      legTot.mismatch += r.legacyCounts.mismatch;
      legTot.confidentlyWrong += r.legacyCounts.confidentlyWrong;
      legTot.honestUnknown += r.legacyCounts.honestUnknown;
      console.log(`${r.repo}: ${fmtCountsV2(r.counts)} (legacy: ${fmtCountsLegacy(r.legacyCounts)}) ${(r.durationMs / 1000).toFixed(1)}s`);
    } else {
      console.log(`${r.repo}: ${r.status} (legacy: ${r.legacyStatus}) — ${r.details}`);
    }
  }
  console.log(`TOTAL (v2 taxonomy):     ${fmtCountsV2(tot)} time=${(totalMs / 1000).toFixed(1)}s`);
  console.log(`TOTAL (v0.1-alpha old-style): ${fmtCountsLegacy(legTot)}`);
  console.log(`STATUSES: OK=${byStatus.OK} REPO_DRIFT=${byStatus.REPO_DRIFT} ANALYZER_FAILURE=${byStatus.ANALYZER_FAILURE}`);
  console.log(
    `LEGACY STATUSES: OK=${byLegacyStatus.OK} DRIFT=${byLegacyStatus.DRIFT} ` +
    `INTEGRITY_FAIL=${byLegacyStatus.INTEGRITY_FAIL} RUNNER_FAILED=${byLegacyStatus.RUNNER_FAILED}`,
  );
}

async function main(): Promise<void> {
  // Fail closed: pins are required for every integrity/drift decision below.
  let pins: Pins;
  try {
    pins = await loadPins();
  } catch (err) {
    console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    console.error('Refusing to run the benchmark without SHA pins (GAP 2).');
    process.exit(2);
  }

  const fixtures = await loadFixtures(fixturesDir);
  if (fixtures.length === 0) {
    console.error(`No fixtures found in ${fixturesDir}.`);
    process.exit(2);
  }

  // Optional repo subset: --slugs a,b,c or BENCH_SLUGS=a,b,c. Used for the
  // v0.1-alpha stage-1 5-repo regression without touching fixture semantics.
  const argvIdx = process.argv.indexOf('--slugs');
  const slugArg = argvIdx >= 0 ? process.argv[argvIdx + 1] : undefined;
  const slugFilter = new Set(
    (slugArg ?? process.env.BENCH_SLUGS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const selected =
    slugFilter.size === 0 ? fixtures : fixtures.filter((f) => slugFilter.has(f.slug));
  if (slugFilter.size > 0) {
    const unknown = [...slugFilter].filter((s) => !fixtures.some((f) => f.slug === s));
    if (unknown.length > 0) {
      console.error(`Unknown slugs in filter: ${unknown.join(', ')}`);
      process.exit(2);
    }
    console.log(`Running ${selected.length}/${fixtures.length} fixture(s): ${selected.map((f) => f.slug).join(', ')}`);
  }

  const reports: HarnessRepoReport[] = [];
  for (const fixture of selected) {
    reports.push(await runRepo(fixture, pins));
    const r = reports[reports.length - 1];
    if (r.status === 'OK') printRepoReport(r);
    else printFailedReport(r);
  }

  printSummary(reports);

  await mkdir(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(resultsDir, `${stamp}.json`);
  const statuses = reports.map((r) => r.status);
  const legacyStatuses = reports.map((r) => r.legacyStatus);
  const countStatus = (xs: string[], s: string): number => xs.filter((x) => x === s).length;
  await writeFile(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        meta: {
          harness: 'worker-isolated',
          // v2 verdict taxonomy; every check carries both `verdict` (v2)
          // and `legacyVerdict` (v0.1-alpha), and every repo both `status`
          // and `legacyStatus`, so old-style totals are exact.
          taxonomy: 'v2',
          taxonomyDoc: 'bench/harness/compare.ts (file header documents the v2 taxonomy and the legacy->v2 derivation)',
          legacyVerdicts: ['OK', 'MISSING', 'MISMATCH', 'CONFIDENTLY_WRONG', 'HONEST_UNKNOWN'],
          failureKinds: {
            'no-pin': { status: 'REPO_DRIFT', legacyStatus: 'DRIFT' },
            'sha-drift': { status: 'REPO_DRIFT', legacyStatus: 'DRIFT' },
            'repo-missing': { status: 'REPO_DRIFT', legacyStatus: 'INTEGRITY_FAIL' },
            'no-git': { status: 'REPO_DRIFT', legacyStatus: 'INTEGRITY_FAIL' },
            'git-fail': { status: 'ANALYZER_FAILURE', legacyStatus: 'INTEGRITY_FAIL' },
            runner: { status: 'ANALYZER_FAILURE', legacyStatus: 'RUNNER_FAILED' },
          },
          workerTimeoutMs: WORKER_TIMEOUT_MS,
          pinsPath: 'bench/harness/pins.json',
          pins,
          slugFilter: slugFilter.size === 0 ? null : [...slugFilter],
          statuses: {
            OK: countStatus(statuses, 'OK'),
            REPO_DRIFT: countStatus(statuses, 'REPO_DRIFT'),
            ANALYZER_FAILURE: countStatus(statuses, 'ANALYZER_FAILURE'),
          },
          legacyStatuses: {
            OK: countStatus(legacyStatuses, 'OK'),
            DRIFT: countStatus(legacyStatuses, 'DRIFT'),
            INTEGRITY_FAIL: countStatus(legacyStatuses, 'INTEGRITY_FAIL'),
            RUNNER_FAILED: countStatus(legacyStatuses, 'RUNNER_FAILED'),
          },
        },
        reports,
      },
      null,
      2,
    ),
  );
  console.log(`\nFull results written to ${outPath}`);

  const nonOk = reports.filter((r) => r.status !== 'OK');
  if (nonOk.length > 0) {
    console.log(
      `\n!! ${nonOk.length} repo(s) did not complete normally: ` +
      nonOk.map((r) => `${r.repo}=${r.status}`).join(', '),
    );
    process.exitCode = 1;
  }
  const worst = reports.reduce((n, r) => n + r.counts.confidentlyWrong, 0);
  if (worst > 0) {
    console.log(`\n!! ${worst} CONFIDENTLY-WRONG outcome(s) — the worst category. See above.`);
    process.exitCode = 1;
  }
}

// Guard: importing run.ts (e.g. to test runWorkerFile in isolation) must not
// launch the benchmark.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
