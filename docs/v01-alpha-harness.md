# Flowprint v0.1-alpha — harness gaps (GAP 2/3/4)

**Date:** 2026-10-06. **Scope:** harness only (`bench/harness/`). No analyzer
changes, no new features. Addresses `docs/blockers.md` B4 (fixture staleness),
B6 (clone wipe), B5/D2 (oxc SIGSEGV isolation).

## Files changed / added

- **Added** `bench/harness/pins.json` — SHA pins for the 5 fixture slugs, seeded
  from `bench/repos/SHAS.txt` and verified live (`git rev-parse HEAD` matched
  for all 5 clones before writing). Schema:
  `{ "<slug>": { "repo": "owner/name", "expectedSha": "<40-hex>", "pinnedAt": "YYYY-MM-DD" } }`.
- **Added** `bench/harness/worker.ts` — worker-thread entry. Receives
  `{ repoPath, probeImports }` via `workerData`, runs `analyzeRepository`,
  posts `{ ok: true, result }` / `{ ok: false, error }`. Passes the
  `AnalysisResult` through opaquely; reads none of its fields.
- **Rewrote** `bench/harness/run.ts` (harness-owned; `compare.ts` untouched):
  - GAP 2: loads `pins.json` (fail-closed: unreadable/missing pins → loud
    `FATAL`, exit 2, no benchmark). Per repo: no pin entry → `DRIFT`;
    `git rev-parse HEAD` != `expectedSha` → `DRIFT` with expected-vs-actual
    SHAs. Drifted repos are **not compared**; the benchmark continues.
  - GAP 3: before any analysis, verifies `<repo>/.git` exists and
    `git rev-parse HEAD` matches the pin. Failures → `INTEGRITY_FAIL` with
    reason; analysis never runs on an unverified clone.
  - GAP 4: per-repo analysis runs in one `node:worker_threads` worker
    (`runAnalysisInWorker`, 5-min timeout via `WORKER_TIMEOUT_MS`).
    Worker error / non-zero exit / malformed message / timeout →
    `RUNNER_FAILED` with the error; the benchmark continues loudly.
  - Results JSON is backward-compatible: same per-repo fields as before,
    plus `status` (`OK` | `DRIFT` | `INTEGRITY_FAIL` | `RUNNER_FAILED`) and
    optional `details` on each report, plus a top-level `meta` block
    (`harness: "worker-isolated"`, `workerTimeoutMs`, `pinsPath`, the pins
    used, per-status counts). Terminal output prints `integrity OK` lines,
    loud `!! <STATUS>:` lines, and a `STATUSES:` summary line.
  - `run.ts` exports `runWorkerFile` / `runAnalysisInWorker` /
    `WORKER_TIMEOUT_MS` / `RepoStatus` / `HarnessRepoReport` for isolated
    testing; `main()` is guarded by an `import.meta.url` check so importing
    the module does not launch the benchmark.
  - `AnalysisResult` is treated as opaque everywhere in `run.ts`: it is cast
    (never constructed or field-walked) at the `compareRepo` boundary, and
    resolution stats print defensively (fields printed only if present).

## Verification evidence

- `npx tsc --noEmit` — clean (before and after all negative tests/restores).
- Full `pnpm benchmark` end-to-end, final clean run
  `bench/results/2026-10-06T09-13-32-416Z.json`: all 5 repos `OK` via workers,
  integrity checks passed, zero drift, results JSON written with the new
  `meta` block. (Totals: OK=69, CONFIDENTLY_WRONG=1 — the 1 is the known,
  documented openstatus `/[domain]/[locale]` skeleton tension from
  `docs/implementation.md`, not a harness artifact.) Notably this run also
  validated the opaque-result handling against the sibling's *new*
  `AnalysisResult` shape (RouteInfo skeleton/concreteValues split etc.) —
  no harness changes were needed.
- Negative tests (all against scratch/temp state; real clones and `pins.json`
  / `worker.ts` restored byte-identical afterward, `tsc` re-verified):
  - (a) `pins.json` dub SHA → `deadbeef…`: dub reported
    `DRIFT` ("SHA mismatch (drift): expected deadbeef…, actual d52438d9… —
    comparison skipped"), other 4 repos analyzed normally. Results artifact:
    `bench/results/2026-10-06T09-10-31-192Z.json` (**negative-test artifact,
    not a real benchmark result**).
  - (b) `bench/repos/karakeep/.git` moved aside: karakeep reported
    `INTEGRITY_FAIL` (".git missing — not a git clone"), benchmark continued;
    `.git` restored and `git rev-parse HEAD` re-verified against the pin.
    Results artifact: `bench/results/2026-10-06T09-11-23-631Z.json`
    (**negative-test artifact**; also contains 2 `RUNNER_FAILED` entries
    caused by the sibling's concurrent mid-edit of `assemble.ts` — see below).
  - (c) temporary crashing `worker.ts` (throws for karakeep only): karakeep
    reported `RUNNER_FAILED` with the crash error, remaining repos continued.
    `worker.ts` restored byte-identical. Results artifact:
    `bench/results/2026-10-06T09-14-32-485Z.json` (**negative-test artifact**).

### Isolation proof (GAP 4)

Standalone test driving the real `runWorkerFile` from `run.ts`
(`/tmp/isotest/test.mts`; worker fixtures in `/tmp/isotest/`):

1. **Uncaught throw in worker** → promise rejects with the worker's error;
   parent survives. PASS.
2. **Hung worker** (never posts) → rejects after the 2 s test timeout
   ("worker timed out after 2000ms and was terminated", measured 2048 ms);
   parent survives. PASS.
3. **Real pipeline in worker** (`runAnalysisInWorker` on a scratch repo) →
   resolves. PASS.

Test script (reproducible — import path is the only site-specific part):

```ts
import { runWorkerFile, runAnalysisInWorker } from '<m0>/bench/harness/run.js';
// thrower.mts: `throw new Error('simulated uncatchable parser failure');`
await runWorkerFile('/tmp/isotest/thrower.mts', {}, 10000);   // rejects, parent alive
// hanger.mts: setInterval(()=>{},1000), never posts
await runWorkerFile('/tmp/isotest/hanger.mts', {}, 2000);     // rejects "timed out", parent alive
await runAnalysisInWorker('/tmp/wtest/fakerepo', [], 60000);  // resolves
```

**Real-world containment observed:** during negative test (b), the sibling
agent's concurrent edit left `assemble.ts` calling `.get` on an undefined map
mid-run; the formbricks and openstatus workers failed with
`TypeError: Cannot read properties of undefined (reading 'get')` and the
harness recorded `RUNNER_FAILED` for exactly those two repos while caldiy/dub
completed — i.e. a broken analyzer build was contained per-repo instead of
killing the benchmark.

### ⚠️ Residual risk: worker_threads does NOT contain a native SIGSEGV

D2's goal ("a crash fails that repo's run loudly instead of killing the whole
benchmark") is **only partially achieved** by `worker_threads`, and this was
verified empirically:

- Reproduced the B5 hazard: `oxc-parser` `parseSync` on a file with a
  10,000-deep nested parenthesized expression **SIGSEGVs the process**
  (exit 139). Depth 1,000 parses fine; 10k/50k/100k/200k all die.
- Running the same adversarial input through the real worker path
  (`runAnalysisInWorker`) killed the **entire benchmark driver** (exit 139) —
  no `RUNNER_FAILED`, no continuation. Worker threads share the OS process,
  so a native segfault is process-wide by definition (confirmed again with
  `process.kill(process.pid, 'SIGSEGV')` inside a worker: parent died too).
- What worker isolation *does* contain: uncaught JS exceptions, hangs
  (via timeout + `terminate()`), and worker bootstrap failures — proven above.

**Recommendation for v0.1:** if untrusted repos are in scope, move per-repo
analysis to `child_process` (one process per repo) — only a process boundary
contains SIGSEGV. The `runWorkerFile` protocol (`{ ok, result }` /
`{ ok, false, error }` + timeout) ports directly. This doc's proof tests
double as the acceptance tests for that migration. Not a STOP: the specified
gap is implemented cleanly and strictly improves on in-process analysis.

### tsx + worker_threads notes

- Plain `new Worker('<path>.ts')` works under `tsx` with **no `execArgv`
  tweaks** (verified 2026-10-06: node v24.20.0, tsx 4.23.15) — tsx's ESM loader
  hooks propagate to worker threads.
- `.mts` extension (or a `package.json` with `"type": "module"`) is required
  for entry/test scripts outside the m0 tree; otherwise tsx compiles as CJS
  and top-level await fails.

## Fixture regeneration process (B4)

When a fixture's repo must move to a new SHA (upstream drift, or the existing
B4 staleness cases: openstatus `mcp/route.ts` move, formbricks route counts,
dub `(dir)` entries):

1. `cd bench/repos/<slug> && git fetch origin && git checkout <new-sha>`,
   then `git rev-parse HEAD` → `<new-sha>`.
2. Re-verify **every** fixture fact in `bench/fixtures/<slug>.json` against the
   new tree: app dirs still exist, route files still exist at the recorded
   paths, import-case `fromFile` paths still exist, counts re-taken from the
   tree (label tree-counts vs route-counts per B4). Update the fixture JSON
   (fixture content is sibling-owned — coordinate, do not hand-edit silently).
3. Update `bench/harness/pins.json`: `expectedSha` → `<new-sha>`,
   `pinnedAt` → today.
4. Run `pnpm benchmark`; confirm the repo reports `OK` (not `DRIFT`) and
   review any new MISSING/MISMATCH as potential fixture gaps vs analyzer
   regressions.
5. Note the SHA move and what fixture facts changed in the M0 report log.

`bench/repos/SHAS.txt` remains the human-readable clone record; `pins.json`
is the machine-enforced source of truth the harness checks.

## Deviations from the brief

1. **SHA mismatch → `DRIFT`, not `INTEGRITY_FAIL`.** Both GAP 2(b) and GAP 3
   cover it; the brief's negative test (a) explicitly expects `DRIFT`, so
   drift (a pin/tree divergence question) maps to `DRIFT`, while missing
   `.git` / `rev-parse` failure (a clone-health question) maps to
   `INTEGRITY_FAIL`.
2. **Exit code 1 on any non-`OK` status**, in addition to the pre-existing
   confidently-wrong rule — a benchmark that didn't fully complete should
   not exit 0.
3. **No `execArgv` tweaks** for tsx workers (verified unnecessary).
4. `run.ts` exposes test hooks (`runWorkerFile`, `runAnalysisInWorker`,
   `WORKER_TIMEOUT_MS`) and guards `main()` on import — needed for the
   isolation proof without launching the benchmark.
5. `pins.json` reformatted (2-space, sorted keys) after the negative tests;
   content verified identical to the seeded version.
6. Negative-test runs wrote timestamped files under `bench/results/`; they
   are **not deleted** per the no-delete constraint on that directory, and
   are labeled here as test artifacts (09-10-31 DRIFT, 09-11-23
   INTEGRITY_FAIL, 09-14-32 RUNNER_FAILED). The clean runs are 09-09-30
   (pre-sibling-edit) and **09-13-32 (final)**.
