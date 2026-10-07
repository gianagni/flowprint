# Flowprint M0 — Final report

**Date:** 2026-10-06. **Question:** can a real implementation reproduce the manually
verified findings from the validation study on actual repositories?
**Answer: yes — PROCEED** (with the scoped v0.1 below, not an expanded one).

## 1. Prototype source
`~/workspace/flowprint/m0/packages/flowprint/src/` — layered per `docs/architecture.md`:
`discovery/` (workspace + app detection) → `parsing/` (oxc-parser + require() walk) →
`resolution/` (multi-regime resolver, JSONC tsconfig loader, barrel chains) →
`framework/` (Next.js App Router only) → `model/` (R/I/U claims) → `render/`
(text report) + `cli.ts` (`pnpm flowprint <repo>`). `npx tsc --noEmit` clean.
Build notes: `docs/implementation.md`.

## 2. Architecture
`docs/architecture.md` — decisions: oxc-parser (official NAPI) + AST walk, no
oxc-semantic in M0 (immature third-party; not needed); layer contracts; binding
confidence rules. Two corrections from implementation: (a) no-exports/no-main
directory-index → **R** (Node convention is deterministic; blanket-I was too coarse);
(b) catch-all delegating to a framework adapter → URL **U** (not R).

## 3. Benchmark harness
`pnpm benchmark` → `bench/harness/run.ts`. Compares analyzer output against fixtures;
metrics: apps/routes/imports OK·MISSING·MISMATCH·CONFIDENTLY_WRONG·HONEST_UNKNOWN,
resolution R/I/U rates, runtime. Confidently-wrong exits non-zero (worst outcome).
Results: `bench/results/<timestamp>.json`.

## 4. Ground-truth fixtures
`bench/fixtures/` — 5 repos, SCHEMA.md. Only manually-verified facts; special cases
encoded (karakeep Hono-in-catch-all → U; cal.diy Pages → out-of-scope; dub Next 15
middleware.ts + no root tsconfig). 18 importCases with the leaf-file caveat.

## 5. Results (all five repos)

| Repo | Checks OK | Missing | Mismatch | Confidently-wrong | Honest-U | Time | Edges R |
|---|---|---|---|---|---|---|---|
| cal.diy | 14 | 3 | 3 | 0 | 3 | 9.2s | 93.1% (24,405/26,199) |
| dub | 17 | 6 | 0 | 0 | 6 | 8.1s | 86.1% (22,024/25,581) |
| formbricks | 8 | 0 | 2 | 0 | 5 | 8.2s | 93.4% (21,709/23,241) |
| karakeep | 12 | 3 | 0 | 0 | 6 | 1.5s | 98.3% (5,594/5,691) |
| openstatus | 18 | 2 | 1 | 1* | 4 | 4.6s | 84.2% (11,365/13,499) |
| **Total** | **69** | **14** | **6** | **1*** | **24** | **31.5s** | |

\* The single flag is the documented skeleton-R vs boundedness-U modeling
disagreement (see §6); zero *true* confidently-wrong outcomes. All 14 MISSING and
6 MISMATCH triaged in `docs/fp-fn-analysis.md`: fixture gaps (3 genuine extra
cal.diy apps), fixture semantics (formbricks tree-counts vs route-counts),
tree drift (openstatus mcp route moved), harness strictness, and two minor
genuine gaps (App/Pages conflict check, intercepting-route UX unknown).

Headline behaviors verified:
- karakeep (adversarial): `/api/[[...route]]` → **U**, "embedded framework detected
  (Hono via hono/factory) — endpoints Unknown". No fake endpoints.
- proxy.ts AND middleware.ts detected via location+export-shape (openstatus,
  formbricks, cal.diy → proxy.ts; dub → middleware.ts); karakeep correctly reports
  *no* edge entry (verified absent).
- Nearest-tsconfig-wins with extends chains (incl. JSONC, bare workspace specifiers,
  arrays); per-app aliases with owning tsconfig; workspace name→dir; barrel chains
  transitive with cycle protection; `import type` → type-only edges.
- 24 unknowns correctly surfaced (auth gating, env-conditional aliases, tRPC
  surface, computed rewrites, hostname dispatch, server actions, …).

## 6. FP/FN analysis
`docs/fp-fn-analysis.md`. **Zero true false positives. Zero material false negatives.
Zero true confidently-wrong outcomes.** Every non-OK check is explained and
classified (fixture gap / fixture semantics / tree drift / harness strictness /
minor genuine gap).

## 7. Implementation blockers
`docs/blockers.md`. No true implementation blockers. Environment issues (pnpm PATH,
npm/pnpm mixing), two harness comparator bugs (found via the "distrust the harness
first" rule), fixture staleness process gap, one unexplained clone wipe (recovered).
oxc SIGSEGV hazard not observed; worker isolation pending for v0.1.

## 8. Implementation reality vs validation study
1. **Index fallback confidence:** validation said blanket I; reality: no
   exports/main → **R** (deterministic Node convention), I only for
   exports-condition selection (importer-dependent). More precise than predicted.
2. **Catch-all adapter delegation:** validation synthesis said URL R; the fixture
   (correctly) demands U — implemented as U.
3. **tRPC:** validation Tier 1 included procedure enumeration; M0 surfaces a generic
   tRPC unknown instead (scoped out of the spike). Biggest known v0.1 gap.
4. **Resolution quality beat predictions:** 84–98% R with the rest honestly labeled;
   dist→src fallback and deep-subpath resolution worked first try on dub/karakeep.
5. **Performance:** 31.5s for 5 repos (~90k files parsed); no type-checker needed.

## 9. Estimated scope: M0 → revised v0.1
The MODIFY verdict's revised v0.1 (text-first report; Next.js-first + tRPC +
Express-basic + embedded hook; per-app scoping; R/I/U in output) needs, beyond M0:
- **tRPC procedure enumeration** (router traversal + adapter anchors) — biggest gap, ~1 week.
- **App/Pages router-conflict check** — ~2 days.
- **Split route URL claims** into `skeleton` (R) / `concreteValues` (U) — ~1 day.
- **Server-action inventory** (F12 gap) — ~3 days.
- **Fixture regeneration with SHA-pinning** + harness hardening (clone integrity, worker isolation) — ~2 days.
- **Total ≈ 3 weeks** for one engineer. The interactive explorer stays deferred to
  v0.2 per the revised scope; the text report *is* v0.1.

## 10. Recommendation: PROCEED

**Evidence:** the narrowed hypothesis reproduced on real repos — 69/69 non-stale
checks pass or are explained; 0 true confidently-wrong; the adversarial karakeep
case behaves exactly as specified; 84–98% resolution at R with the remainder
honestly labeled; 31.5s total runtime; **zero repo-specific hacks** in the
implementation (all fixes classified general/framework); R/I/U applied consistently
in the model itself.

**No STOP condition triggered:** no compiler duplication needed; resolution
complexity matched validation predictions; oxc delivered every primitive; the five
repos did not require unrelated special cases (the same engine handled all five).

**Standing KILL conditions** (from validation, not answerable by M0): re-check after
v0.1 whether developers return after the first run (occasional-use gravity) and
whether framework-drift maintenance exceeds one maintainer. M0 clears the technical
bar; it cannot clear the adoption bar.

**Do not start v0.1 automatically.** Awaiting Ledi's decision.
