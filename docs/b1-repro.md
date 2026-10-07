# Blocker B1 — child_process parser isolation: repro & evidence

## What B1 is

Proven fact (docs/v01-alpha.md §6 blocker #3): deeply nested parens input
(`'(' * 10000 + ')' * 10000`) triggers an **uncatchable native oxc SIGSEGV**
(oxc#24375) that kills the whole OS process (exit 139). `worker_threads`
share the process and cannot contain it. v0.1 must parse in `child_process`.

## What was built

- `packages/flowprint/src/parsing/isolated.ts` — parent-side pool:
  `parseFilesIsolated(repoRoot, rels, opts)` splits files into batches
  (default 200/batch, ≤8 concurrent children), forks one child per batch,
  and collects serialized `ModuleRecord`s over IPC. On child death
  (non-zero exit, signal incl. SIGSEGV, spawn error, timeout) the batch is
  retried with a **binary split** until the crashing file(s) are isolated;
  each becomes a `crashed: true` record ("crashed during parse — file
  skipped"). The parent never throws on child failure — crashes are logged
  loudly on stderr and the scan continues.
- `packages/flowprint/src/parsing/child.ts` — child entry: the ONLY place
  oxc runs. Receives `{ repoRoot, files }`, runs the existing `parseFile`
  logic, posts records back, exits 0. Forked with
  `execArgv: process.execArgv` so the tsx loader resolves the `.ts` entry
  under `pnpm flowprint` (tsx).
- `parsing/index.ts` — `ModuleRecord.crashed?: boolean` + `crashedRecord()`
  constructor (empty edges → excluded from the graph, like skipped files;
  `hasErrors` stays false so "parse errors" and "parse crashes" unknowns
  don't double-count).
- `src/index.ts` — the parse loop and the on-demand `getRecord` path both
  go through `parseFilesIsolated`; crashed files get an explicit
  `[U] parse crashes` unknown. No other layer changed; record content for
  non-crashing files is byte-identical to the direct path (verified on 40
  real files, 0 mismatches — see below).

## Repro

Script: `docs/b1-repro.sh` (run from the m0 root; self-cleaning).
It builds a 3-file repo (crash input + two normal files), first confirms
the input SIGSEGVs oxc **in-process** (exit 139), then runs a full
`pnpm flowprint` scan.

## Observed output (2026-10-06)

```
--- (a) sanity: the input really does SIGSEGV oxc in-process ---
in-process parse exit code: 139 (139 = SIGSEGV, expected)
--- (b) full flowprint scan: child must crash, parent must survive ---
parent exit code: 0 (0 = survived, expected)
--- crash evidence (stderr) ---
[flowprint] PARSE CHILD CRASHED: child died (exit code=null, signal=SIGSEGV); 3 file(s) affected — retrying with binary split. files: src/crash.ts, src/helper.ts, src/index.ts
[flowprint] PARSE CHILD CRASHED: child died (exit code=null, signal=SIGSEGV); 1 file(s) affected — retrying with binary split. files: src/crash.ts
[flowprint] file marked Unknown after parser crash: src/crash.ts — child died (exit code=null, signal=SIGSEGV)
--- report tail (stdout) ---
## Unknown
  [U] parse crashes: 1 file(s) crashed the isolated parser worker and were skipped without records (e.g. src/crash.ts)
      reason: native parser crashes are contained by child_process isolation — no single file may terminate a scan
B1 REPRO: PASS — child crashed (SIGSEGV), parent survived, report complete, file Unknown.
```

Reading the evidence:

- **(a) Child crashes on the input**: stderr shows the child died with
  `signal=SIGSEGV` — the same native crash class as the in-process 139.
- **(b) Parent survives and completes**: parent exit code 0, full report
  rendered (repository/apps/routes/resolution sections all present), and
  `src/crash.ts` is surfaced as `[U] parse crashes` — Unknown, not a
  scan-killer. The two innocent files were still parsed (binary split
  converged on the single bad file; the other half of the batch produced
  real records).
- **No behavior change for non-crashing files**: 40 real `.ts` files from
  `bench/repos/zod` parsed both directly (`parseFile`) and isolated
  (`parseFilesIsolated`); JSON-normalized records matched 40/40, and the
  `namedCallExports` Map revived correctly across the IPC boundary.

## Residual notes

- A child that *hangs* (not just crashes) is killed by the per-batch
  timeout (default 5 min, matching the harness per-repo budget) and handled
  like a crash.
- The 2MB `MAX_PARSE_BYTES` oversize guard and the try/catch around
  `result.program` access are unchanged and still run inside the child.
- `tsc --noEmit` shows one error in `packages/flowprint/src/model/assemble.ts`
  (`boundaries` missing) from in-progress sibling work on explicit
  unsupported boundaries (`src/boundaries/`, `model/types.ts` touched
  2026-10-06 ~10:20 UTC); `src/model/*` is outside B1's touch scope. All
  B1 files typecheck clean.
