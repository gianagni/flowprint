/**
 * Flowprint M0 — fixture vs actual comparison.
 *
 * v2 verdict taxonomy (per check):
 *   CONFIDENTLY_WRONG — claimed R where ground truth is U, or a wrong
 *                        value claimed as R. Worst outcome; fails the run.
 *   MISMATCH          — genuine value/confidence disagreement between the
 *                        analyzer and the fixture, INCLUDING false negatives
 *                        (fixture expects a claim the analyzer did not
 *                        emit). Needs human adjudication. (v0.1-alpha
 *                        called false negatives MISSING; the MISSING
 *                        verdict is eliminated in v2.)
 *   FIXTURE_GAP       — the analyzer emitted a claim its documented rules
 *                        produce, but the fixture does not cover it
 *                        ("extra app detected"). The fixture is likely
 *                        incomplete. Genuineness is NOT auto-certified —
 *                        see the check detail.
 *   UNSUPPORTED_FEATURE — fixture entry demands a framework-specific
 *                        concept outside the analyzer's documented scope
 *                        (e.g. Hono endpoint enumeration, NestJS DI
 *                        bindings). The analyzer is correctly silent; the
 *                        fixture — not the analyzer — is at fault.
 *   HONEST_UNKNOWN    — the analyzer correctly claims nothing it cannot
 *                        know: an explicit U, or correct silence on an
 *                        ambiguity entry.
 *   OK                — matches.
 *
 * Harness-level verdicts (run.ts repo status, not per-check):
 *   REPO_DRIFT        — no pin entry, SHA drift, or the repo is not in its
 *                        pinned state (repo dir missing / .git missing).
 *   ANALYZER_FAILURE  — integrity failure (git rev-parse fails on a repo
 *                        that has .git), runner crash, or worker timeout.
 *                        Reserved on the per-check Verdict union for future
 *                        per-check failure attribution; not emitted today.
 *
 * Every check also records `legacyVerdict`: the verdict the v0.1-alpha
 * harness would have emitted for the same evidence. Old-style totals are
 * therefore EXACT (counted, not estimated). v0.1-alpha per-check
 * taxonomy: OK / MISSING / MISMATCH / CONFIDENTLY_WRONG / HONEST_UNKNOWN.
 *
 * Legacy -> v2 derivation (documented once, here):
 *   OK -> OK
 *   HONEST_UNKNOWN -> HONEST_UNKNOWN
 *   CONFIDENTLY_WRONG -> CONFIDENTLY_WRONG
 *   MISMATCH (value/confidence disagreement, count drift, edge-entry
 *     false positive) -> MISMATCH
 *   MISMATCH (extra app detected) -> FIXTURE_GAP
 *   MISSING (expected claim not emitted: app / route / tsconfig / alias /
 *     import probe) -> MISMATCH
 *   MISSING (ambiguity not surfaced; entry demands an out-of-scope
 *     framework concept) -> UNSUPPORTED_FEATURE
 *   MISSING (ambiguity not surfaced; otherwise — the analyzer correctly
 *     claims nothing) -> HONEST_UNKNOWN
 */
import type {
  AnalysisResult,
  Claim,
  Confidence,
} from '../../packages/flowprint/src/model/types.js';
import type { UnsupportedBoundary } from '../../packages/flowprint/src/boundaries/types.js';
import type { Fixture, FixtureAmbiguity, FixtureRoute } from './fixture.js';

/**
 * v0.1-alpha route fields (fixture.ts is owned by a sibling agent; the
 * migration script writes these fields into the JSON and compare.ts reads
 * them via this local extension interface).
 */
export interface FixtureRouteV01 extends FixtureRoute {
  expectedSkeleton?: string | null;
  skeletonConfidence?: Confidence;
  expectedConcreteValues?: string[] | null;
  concreteValuesConfidence?: Confidence;
}

export type Verdict =
  | 'OK'
  | 'ANALYZER_FAILURE'
  | 'HONEST_UNKNOWN'
  | 'UNSUPPORTED_FEATURE'
  | 'FIXTURE_GAP'
  | 'REPO_DRIFT'
  | 'MISMATCH'
  | 'CONFIDENTLY_WRONG';

/** v0.1-alpha per-check verdicts, kept for exact backward comparison. */
export type LegacyVerdict = 'OK' | 'MISSING' | 'MISMATCH' | 'CONFIDENTLY_WRONG' | 'HONEST_UNKNOWN';

export interface CheckResult {
  area: string;
  subject: string;
  verdict: Verdict;
  /** What the v0.1-alpha harness would have emitted for the same evidence. */
  legacyVerdict: LegacyVerdict;
  expected: string;
  actual: string;
  detail: string;
}

/** v2 per-check totals. */
export interface VerdictCounts {
  ok: number;
  honestUnknown: number;
  unsupportedFeature: number;
  fixtureGap: number;
  mismatch: number;
  confidentlyWrong: number;
}

/** v0.1-alpha-style per-check totals (exact, counted from legacyVerdict). */
export interface LegacyCounts {
  ok: number;
  missing: number;
  mismatch: number;
  confidentlyWrong: number;
  honestUnknown: number;
}

export interface RepoReport {
  repo: string;
  durationMs: number;
  checks: CheckResult[];
  counts: VerdictCounts;
  legacyCounts: LegacyCounts;
  resolutionStats: AnalysisResult['resolutionStats'];
}

function fmtClaim<T>(c: Claim<T> | undefined): string {
  if (!c) return '(absent)';
  return `${c.confidence}:${JSON.stringify(c.value)} (${c.reason})`;
}

function checkClaim<T>(
  area: string,
  subject: string,
  expectedValue: T | null,
  expectedConf: 'R' | 'I' | 'U',
  actual: Claim<T | null> | undefined,
  equals: (a: T | null, b: T | null) => boolean = (a, b) => a === b,
): CheckResult {
  const base = {
    area, subject,
    expected: `${expectedConf}:${JSON.stringify(expectedValue)}`,
    actual: fmtClaim(actual ?? undefined),
    detail: '',
  };
  // False negative: the fixture expects a claim the analyzer did not emit.
  // v2: MISMATCH (needs adjudication — MISSING is eliminated).
  if (!actual) {
    return {
      ...base, verdict: 'MISMATCH', legacyVerdict: 'MISSING',
      detail: 'expected claim not emitted (false negative)',
    };
  }
  const valueOk = equals(actual.value, expectedValue);
  if (expectedConf === 'U') {
    if (actual.confidence === 'U') {
      return { ...base, verdict: 'HONEST_UNKNOWN', legacyVerdict: 'HONEST_UNKNOWN', detail: 'correctly marked unknown' };
    }
    if (actual.confidence === 'R') {
      return { ...base, verdict: 'CONFIDENTLY_WRONG', legacyVerdict: 'CONFIDENTLY_WRONG', detail: 'claimed Resolved where ground truth is Unknown' };
    }
    return { ...base, verdict: 'MISMATCH', legacyVerdict: 'MISMATCH', detail: 'claimed Inferred where ground truth is Unknown' };
  }
  if (!valueOk) {
    if (actual.confidence === 'R') {
      return { ...base, verdict: 'CONFIDENTLY_WRONG', legacyVerdict: 'CONFIDENTLY_WRONG', detail: 'wrong value claimed as Resolved' };
    }
    return { ...base, verdict: 'MISMATCH', legacyVerdict: 'MISMATCH', detail: 'wrong value' };
  }
  if (actual.confidence !== expectedConf) {
    return { ...base, verdict: 'MISMATCH', legacyVerdict: 'MISMATCH', detail: `confidence ${actual.confidence} vs expected ${expectedConf}` };
  }
  return { ...base, verdict: 'OK', legacyVerdict: 'OK', detail: '' };
}

/** Loose framework matching: fixture uses human names ("Next.js App Router"),
 *  the analyzer emits ids ("nextjs-app-router"). */
function frameworkMatches(expected: string, actualValue: string): boolean {
  const e = expected.toLowerCase();
  const a = actualValue.toLowerCase();
  const wantApp = e.includes('app router');
  const wantPages = e.includes('pages router') || (e.includes('pages') && !wantApp);
  const wantHybrid = e.includes('hybrid');
  if (wantHybrid) return a.includes('hybrid') || (a.includes('app-router') && a.includes('pages'));
  if (wantApp && wantPages) return a.includes('app-router') || a.includes('pages');
  if (wantApp) return a.includes('app-router') || a.includes('app router');
  if (wantPages) return a.includes('pages');
  return a.includes('nextjs') || a.includes('next.js');
}

function expectedKindForEdgeFile(file: string): string {
  const base = file.split('/').pop() ?? '';
  if (base.startsWith('proxy.')) return 'proxy';
  if (base.startsWith('middleware.')) return 'middleware';
  return 'unknown-edge';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * v2 UNSUPPORTED_FEATURE heuristic, for ambiguity entries the analyzer did
 * NOT surface as unknown. Precise rule, in precedence order:
 *
 *  1. `scope: 'out-of-scope'` hint on the fixture entry -> out of scope.
 *     (Explicit fixture-author adjudication; the v0.1-alpha triage's
 *     "109 over-specificity" class is annotated this way over time.)
 *  2. `scope: 'in-scope'` hint -> in scope (overrides rule 3; escape hatch
 *     for entries that merely mention an unsupported framework in passing).
 *  3. Otherwise derived: the entry names — case-insensitive, on word
 *     boundaries, in `area` or `detail` — a framework that the analyzer
 *     itself reports as a detected-but-unsupported boundary for THIS repo
 *     (AnalysisResult.boundaries, from the analyzer's documented scope
 *     table in boundaries/detect.ts, Blocker B3). The framework list is
 *     the analyzer's own definition of unsupported: the harness hardcodes
 *     no framework names and no repo-specific logic.
 *
 * Rationale: such an entry demands the analyzer name/claim a concept it
 * is documented not to analyze; silence is correct, and HONEST_UNKNOWN
 * would understate that the fixture — not the analyzer — is at fault.
 *
 * Documented limitation: entries about out-of-scope concepts that name no
 * emitted boundary framework (e.g. an area like "decorator-controller-routes"
 * that never names NestJS) need the explicit `scope` hint (rule 1); until
 * the fixture agent annotates them they stay HONEST_UNKNOWN.
 */
function ambiguityIsOutOfScope(
  amb: FixtureAmbiguity,
  boundaries: UnsupportedBoundary[],
): boolean {
  if (amb.scope === 'out-of-scope') return true;
  if (amb.scope === 'in-scope') return false;
  const hay = `${amb.area} ${amb.detail}`;
  return boundaries.some((b) => new RegExp(`\\b${escapeRegExp(b.name)}\\b`, 'i').test(hay));
}

export function compareRepo(fixture: Fixture, actual: AnalysisResult): RepoReport {
  const checks: CheckResult[] = [];
  const boundaries: UnsupportedBoundary[] = actual.boundaries ?? [];

  // 1. Applications detected (+ framework + tsconfig + aliases)
  for (const app of fixture.apps) {
    const found = actual.apps.find((a) => a.path === app.dir);
    if (!found) {
      checks.push({
        area: 'apps', subject: app.dir, verdict: 'MISMATCH', legacyVerdict: 'MISSING',
        expected: `R:${app.framework}`, actual: '(absent)',
        detail: 'app not detected (false negative)',
      });
      continue;
    }
    const fwOk = frameworkMatches(app.framework, found.framework.value);
    checks.push({
      area: 'apps', subject: `${app.dir} framework`,
      verdict: fwOk ? 'OK' : 'MISMATCH', legacyVerdict: fwOk ? 'OK' : 'MISMATCH',
      expected: `R:${app.framework}`, actual: fmtClaim(found.framework),
      detail: fwOk ? '' : 'framework mismatch',
    });
    if (app.tsconfig?.path) {
      const tsOk = found.tsconfigs.includes(app.tsconfig.path);
      checks.push({
        area: 'apps', subject: `${app.dir} tsconfig`,
        verdict: tsOk ? 'OK' : 'MISMATCH', legacyVerdict: tsOk ? 'OK' : 'MISSING',
        expected: `R:${app.tsconfig.path}`, actual: tsOk ? `R:${app.tsconfig.path}` : `(have: ${found.tsconfigs.join(', ') || 'none'})`,
        detail: tsOk ? '' : 'applicable tsconfig not detected (false negative)',
      });
    }
    for (const al of app.aliases ?? []) {
      const match = found.aliases.find((a) => a.pattern === al.pattern && a.ownerTsconfig === al.ownerTsconfig);
      if (!match) {
        checks.push({
          area: 'apps', subject: `${app.dir} alias ${al.pattern}`,
          verdict: 'MISMATCH', legacyVerdict: 'MISSING',
          expected: `${al.expectedConfidence}:${al.pattern} -> ${al.targets.join(', ')} @ ${al.ownerTsconfig}`,
          actual: '(absent)', detail: 'alias not detected (false negative)',
        });
        continue;
      }
      const targetsOk = JSON.stringify([...match.targets].sort()) === JSON.stringify([...al.targets].sort());
      checks.push(
        checkClaim('apps', `${app.dir} alias ${al.pattern}`, al.targets, al.expectedConfidence,
          { value: match.targets, confidence: match.confidence, reason: match.reason },
          (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort())),
      );
      void targetsOk;
    }
    // 2. Edge entry (proxy.ts / middleware.ts) — incl. expected-absent
    const ee = app.edgeEntry;
    if (ee) {
      const appEntries = actual.entryPoints.filter(
        (e) => e.file === ee.file || e.file.startsWith(app.dir + '/'),
      );
      const edgeEntries = appEntries.filter((e) => {
        const b = e.file.split('/').pop() ?? '';
        return b.startsWith('proxy.') || b.startsWith('middleware.');
      });
      if (ee.file === null) {
        // Verified: no edge front door. Emitting one is a false positive.
        if (edgeEntries.length > 0) {
          checks.push({
            area: 'entry', subject: `${app.dir} edge entry (expected absent)`,
            verdict: 'MISMATCH', legacyVerdict: 'MISMATCH',
            expected: 'absent (verified: no proxy.ts/middleware.ts)',
            actual: edgeEntries.map((e) => e.file).join(', '),
            detail: ee.note ?? 'false positive edge entry',
          });
        } else {
          checks.push({
            area: 'entry', subject: `${app.dir} edge entry (expected absent)`,
            verdict: 'OK', legacyVerdict: 'OK',
            expected: 'absent', actual: 'absent', detail: ee.note ?? '',
          });
        }
      } else {
        const foundEntry = actual.entryPoints.find((e) => e.file === ee.file);
        checks.push(
          checkClaim('entry', ee.file, expectedKindForEdgeFile(ee.file), 'R', foundEntry?.kind, (a, b) => a === b),
        );
      }
    }
  }
  for (const app of actual.apps) {
    if (!fixture.apps.some((a) => a.dir === app.path)) {
      checks.push({
        area: 'apps', subject: app.path,
        verdict: 'FIXTURE_GAP', legacyVerdict: 'MISMATCH',
        expected: '(not in fixture)', actual: fmtClaim(app.framework),
        // Kept verbatim from v0.1-alpha: genuineness is NOT auto-certified.
        detail: 'extra app detected — verify whether false positive or fixture gap',
      });
    }
  }

  // 3. Routes (sampled ground truth) — v0.1-alpha: skeleton and
  // concreteValues compared as separate claims.
  const byFile = new Map(actual.routes.map((r) => [r.file, r]));
  for (const frRaw of fixture.routes) {
    const fr = frRaw as FixtureRouteV01;
    const ar = byFile.get(fr.file);
    const legacy = fr.expectedSkeleton === undefined && fr.skeletonConfidence === undefined;
    if (!ar) {
      checks.push({
        area: 'routes', subject: fr.file,
        verdict: 'MISMATCH', legacyVerdict: 'MISSING',
        expected: legacy
          ? `${fr.expectedConfidence}:${JSON.stringify(fr.expectedUrl)}`
          : `${fr.skeletonConfidence}:${JSON.stringify(fr.expectedSkeleton)}`,
        actual: '(absent)', detail: `route file not detected (false negative)${fr.reason ? ` (${fr.reason})` : ''}`,
      });
      continue;
    }
    if (legacy) {
      checks.push(checkClaim('routes:url', fr.file, fr.expectedUrl, fr.expectedConfidence, ar.skeleton, urlsEqual));
      continue;
    }
    checks.push(
      checkClaim('routes:skeleton', fr.file, fr.expectedSkeleton ?? null, fr.skeletonConfidence ?? 'U', ar.skeleton, urlsEqual),
    );
    checks.push(
      checkClaim(
        'routes:concreteValues', fr.file,
        fr.expectedConcreteValues ?? null, fr.concreteValuesConfidence ?? 'U',
        ar.concreteValues, concreteValuesEqual,
      ),
    );
  }

  // 4. Route file counts (scale check against verified tree counts)
  const countChecks: Array<[string, (r: AnalysisResult['routes'][number]) => boolean]> = [
    ['routeTs', (r) => /\/route\.(ts|js)$/.test(r.file)],
    ['pageTsx', (r) => /\/page\.(tsx|ts|jsx|js)$/.test(r.file)],
  ];
  for (const [key, pred] of countChecks) {
    const fc = fixture.counts?.[key];
    if (!fc) continue;
    const n = actual.routes.filter(pred).length;
    // Counts are tree counts; the analyzer may legitimately exclude some —
    // treat exact match as OK, otherwise MISMATCH (investigate), never WRONG.
    checks.push({
      area: 'routes:count', subject: key,
      verdict: n === fc.value ? 'OK' : 'MISMATCH',
      legacyVerdict: n === fc.value ? 'OK' : 'MISMATCH',
      expected: `${fc.expectedConfidence}:${fc.value}`, actual: String(n),
      detail: n === fc.value ? '' : 'count drift — investigate FP/FN (tolerances TBD in M0 analysis)',
    });
  }

  // 5. Import probes (leaf-file caveat: expectedResolved may be a verified prefix)
  const probeByKey = new Map(actual.importProbes.map((p) => [`${p.fromFile}::${p.specifier}`, p]));
  for (const ic of fixture.importCases) {
    const subject = `${ic.fromFile} :: ${ic.specifier}`;
    const ap = probeByKey.get(`${ic.fromFile}::${ic.specifier}`);
    if (!ap) {
      checks.push({
        area: 'imports', subject,
        verdict: 'MISMATCH', legacyVerdict: 'MISSING',
        expected: `${ic.expectedConfidence}:${JSON.stringify(ic.expectedResolved)}`,
        actual: '(probe not run)', detail: 'harness did not receive a probe result (false negative)',
      });
      continue;
    }
    checks.push(
      checkClaim('imports', subject, ic.expectedResolved, ic.expectedConfidence, ap.resolved, resolvedEqual),
    );
  }

  // 6. Ambiguities: the analyzer must not claim what it cannot know.
  //    - surfaced as unknown            -> HONEST_UNKNOWN (as v0.1-alpha)
  //    - not surfaced + out-of-scope    -> UNSUPPORTED_FEATURE
  //      (fixture demands a concept outside the analyzer's documented
  //      scope; the analyzer is correctly silent)
  //    - not surfaced + otherwise       -> HONEST_UNKNOWN (the analyzer
  //      correctly claims nothing; MISSING is eliminated in v2)
  for (const amb of fixture.ambiguities) {
    const surfaced = actual.unknowns.some(
      (u) =>
        u.area.toLowerCase().includes(amb.area.toLowerCase()) ||
        amb.area.toLowerCase().includes(u.area.toLowerCase()) ||
        u.detail.toLowerCase().includes(amb.area.toLowerCase()),
    );
    const expected = `${amb.expectedConfidence} (must not claim)`;
    if (surfaced) {
      checks.push({
        area: 'ambiguity', subject: amb.area,
        verdict: 'HONEST_UNKNOWN', legacyVerdict: 'HONEST_UNKNOWN',
        expected, actual: 'U (surfaced)',
        detail: amb.detail.slice(0, 200),
      });
      continue;
    }
    if (ambiguityIsOutOfScope(amb, boundaries)) {
      checks.push({
        area: 'ambiguity', subject: amb.area,
        verdict: 'UNSUPPORTED_FEATURE', legacyVerdict: 'MISSING',
        expected, actual: '(not surfaced — correctly silent: concept out of scope)',
        detail: amb.detail.slice(0, 200),
      });
    } else {
      checks.push({
        area: 'ambiguity', subject: amb.area,
        verdict: 'HONEST_UNKNOWN', legacyVerdict: 'MISSING',
        expected, actual: '(not surfaced — correctly claims nothing)',
        detail: amb.detail.slice(0, 200),
      });
    }
  }

  const counts: VerdictCounts = {
    ok: 0, honestUnknown: 0, unsupportedFeature: 0, fixtureGap: 0, mismatch: 0, confidentlyWrong: 0,
  };
  const legacyCounts: LegacyCounts = {
    ok: 0, missing: 0, mismatch: 0, confidentlyWrong: 0, honestUnknown: 0,
  };
  for (const c of checks) {
    switch (c.verdict) {
      case 'OK': counts.ok++; break;
      case 'HONEST_UNKNOWN': counts.honestUnknown++; break;
      case 'UNSUPPORTED_FEATURE': counts.unsupportedFeature++; break;
      case 'FIXTURE_GAP': counts.fixtureGap++; break;
      case 'MISMATCH': counts.mismatch++; break;
      case 'CONFIDENTLY_WRONG': counts.confidentlyWrong++; break;
      default: break; // ANALYZER_FAILURE / REPO_DRIFT are harness-level, never per-check
    }
    switch (c.legacyVerdict) {
      case 'OK': legacyCounts.ok++; break;
      case 'MISSING': legacyCounts.missing++; break;
      case 'MISMATCH': legacyCounts.mismatch++; break;
      case 'CONFIDENTLY_WRONG': legacyCounts.confidentlyWrong++; break;
      case 'HONEST_UNKNOWN': legacyCounts.honestUnknown++; break;
    }
  }
  return { repo: fixture.repo, durationMs: actual.durationMs, checks, counts, legacyCounts, resolutionStats: actual.resolutionStats };
}

function urlsEqual(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const norm = (u: string) => u.replace(/\/+$/, '') || '/';
  return norm(a) === norm(b);
}

/**
 * concreteValues equality: null vs null, or same set of URLs
 * (order-insensitive; analyzer emits single-element or empty arrays).
 */
function concreteValuesEqual(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => urlsEqual(v, sb[i]));
}

/**
 * expectedResolved may be an exact file, a verified directory prefix, or a
 * module path whose leaf the research did not verify (leaf-file caveat).
 * The analyzer legitimately resolves to the concrete leaf file
 * (…/x.ts, …/x/index.ts); that is MORE precise, not wrong.
 * Symmetric: argument order does not matter.
 */
function resolvedEqual(expected: string | null, actual: string | null): boolean {
  if (expected === actual) return true;
  if (expected == null || actual == null) return false;
  const norm = (s: string) =>
    s
      .replace(/\/+$/, '')
      .replace(/\/index\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, '')
      .replace(/\.(d\.ts|ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, '');
  const e = norm(expected);
  const a = norm(actual);
  if (a === e) return true;
  if (a.startsWith(e + '/') || e.startsWith(a + '/')) return true;
  return false;
}
