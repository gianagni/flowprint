# Flowprint v0.1-alpha — analyzer gaps 1, 5, 6, 7

**Status:** implemented. `npx tsc --noEmit` clean. No STOP condition triggered.

This document records what changed per gap, the verification evidence, deviations
from the brief, and STOP-condition near-misses. It does not modify the M0 record:
`docs/architecture.md`, `docs/implementation.md`, `docs/m0-report.md` and
`bench/results/*.json` are untouched.

## GAP 1 — Route URL claims split into skeleton / concreteValues

**Changed:**
- `packages/flowprint/src/model/types.ts`: `RouteInfo { file, url }` →
  `RouteInfo { file, skeleton: Claim<string|null>, concreteValues: Claim<string[]|null>, methods }`.
- `packages/flowprint/src/framework/routes.ts`: added `NextConfigSummary` +
  `summarizeNextConfig()` (per-app next.config presence scan: basePath /
  rewrites / redirects, method-style and property-style), and
  `concreteValuesClaim(skeleton, cfg)` implementing the brief's rules:
  skeleton null → concreteValues null (same confidence/reason); dynamic
  segments → U `[]` ("concrete values require runtime data (DB rows, env,
  tenant config)"); fully static + skeleton R + config readable with no
  basePath/rewrites/redirects → R `[skeleton]`; fully static + skeleton R +
  config uncertain/affecting → I `[skeleton]`; fully static + skeleton not R
  → U `[]` (inherits the uncertainty — never upgrades I→R).
- `packages/flowprint/src/framework/index.ts`: adapter-delegated catch-all
  skeleton is now **null** at U (was the mapped URL at U); intercepting routes
  stay null at I; every route gets both claims. `urlClaims` renamed to
  `skeletonClaims` + `concreteValuesClaims` on `FrameworkAppResult`.
- `packages/flowprint/src/model/assemble.ts`, `packages/flowprint/src/render/index.ts`:
  assemble and render both claims (`[R] /skeleton` plus a `concrete:` line).
- `bench/harness/compare.ts`: compares `routes:skeleton` and
  `routes:concreteValues` as separate checks (order-insensitive array
  equality). Legacy `expectedUrl` entries still compare (fallback) so old
  fixtures don't crash the comparator. New fields are read via a local
  `FixtureRouteV01` extension interface — `bench/harness/fixture.ts` was NOT
  touched (sibling-owned).
- `bench/harness/migrate-fixtures-v01.ts` (new, one-shot, idempotent): rewrote
  all 21 routes[] entries across the 5 fixtures per the brief's default mapping
  + the two exceptions (openstatus login; karakeep `[[...route]]`). Fixture JSON
  format preserved (compact single-line); non-routes[] content verified
  byte-identical in meaning (all other keys deep-equal before/after).
- `bench/fixtures/SCHEMA.md`: routes[] section documents the split + analyzer rules.

**Verification:**
- Migration hand-review: all 21 entries match the prescribed mapping
  (openstatus login → skeleton R `/[domain]/[locale]/login`, concreteValues U;
  karakeep catch-all → null U / null U; karakeep intercepting → null I / null I;
  dub metadata I → skeleton I, concreteValues U; static R → R/R).
- `compareRepo` exercised directly against migrated karakeep/openstatus/dub
  fixtures: **0 CONFIDENTLY_WRONG** on all three. karakeep: 8/8 route checks
  OK/HONEST_UNKNOWN. openstatus login adjudication resolves as designed
  (skeleton R OK, concreteValues U HONEST_UNKNOWN).
- CLI on karakeep + dub: skeleton/concreteValues render correctly, no crash.

**Deviation / known tension (documented, not worked around):** the brief's
migration default emits concreteValues R for every old-R static URL, but the
brief's runtime rule downgrades to I when the app's next.config declares
rewrites/redirects/basePath. Result: 5 honest MISMATCHes (I vs R, never WRONG):
openstatus `/agents`, `/api/ai-filters`, `/api/chat` (redirects),
`/llms.txt` (rewrites+redirects); dub `/api/links` (rewrites+redirects);
formbricks `/api/v1/management/surveys` (basePath+rewrites+redirects). The
migration was kept mechanical per the brief rather than fixture-fitted to the
analyzer. Recommendation: revisit the fixture R defaults, or have the harness
treat I-vs-R on concreteValues as acceptable when the reason names config
directives.

## GAP 5 — App Router / Pages Router conflict detection

**Changed:**
- `packages/flowprint/src/framework/pages.ts` (new): `collectPagesRoutes()`
  scans `<app>/pages` (fallback `<app>/src/pages`), maps files to URLs via
  Pages conventions (`index`→`/`, `[p]`/`[...p]`/`[[...p]]` kept,
  `pages/api/*` flagged `isApi`), excluding `_app`, `_document`, `_error`,
  `404`, `500`, and `_*` files/dirs. Returns null when no pages/ dir.
- `packages/flowprint/src/framework/index.ts`: compares App Router skeletons
  against Pages URLs; same effective URL → `RouterConflict
  {url, appRouterFile, pagesRouterFile, winner: 'pages'}` on `AppInfo`
  (new model field). Conflicts get an explicit note + Unknown entry; when
  pages/ exists with no conflicts the existing out-of-scope note is unchanged.
- Render: `router conflicts (pages-wins):` lines under Applications.

**Verification:**
- Synthetic repo: `/about` in both routers → conflict emitted, pages-wins;
  `/api/users` (app) vs `/api/legacy` (pages) → correctly no conflict.
- cal.diy (real hybrid): pages/ scanned, 0 conflicts (App Router has no
  `/router` or `/router/embed`) — existing out-of-scope note kept.

**Scope note:** comparison is exact-string on mapped URLs; no fuzzy
dynamic-segment equivalence beyond identical bracket syntax. Pages-only routes
are still not detected (out of scope, per brief).

## GAP 6 — Server Actions inventory

**Changed:**
- `packages/flowprint/src/parsing/index.ts`: `ModuleRecord` gains
  `directiveScopes: DirectiveOccurrence[]` (`'use server'`/`'use client'` with
  scope `module` = directive prologue, `function` = function-body first
  statement + enclosing function name, `other` = inert) and
  `exportShape.asyncFunctionNames` (top-level async function/const names).
  The flat `directives: string[]` is unchanged (backward compatible).
- `packages/flowprint/src/framework/serverActions.ts` (new):
  `inventoryServerActions(appDir, records)` — per-app inventory:
  - prologue `'use server'` → scope R `module` ("file defines server actions
    per Next.js convention"); exported async function names → I list
    ("convention-based: all exports of a 'use server' module are server actions").
  - function-body `'use server'` → scope R `inline`, that function R.
  - `'use server'` + `'use client'` → Unknown (invalid combination, never claimed).
  - misplaced (non-prologue) module-level `'use server'` → Unknown (inert per Next.js).
- `packages/flowprint/src/model/types.ts`: `AppInfo.serverActions: ServerActionInfo[]`.
- `packages/flowprint/src/index.ts`: inventory runs per app candidate; the old
  blanket "server actions not inventoried in M0" unknown is removed; a residual
  unknown covers `'use server'` files outside any app dir.
- Render: `## Server actions` section per app.

**Verification:**
- Synthetic repo: module file → R + I actions (non-async export correctly
  excluded); inline directive → R for that function; client+server file →
  Unknown, not claimed.
- Real repos: dub 67 files inventoried (e.g. `action.ts` → `verifyPassword`
  I); karakeep 1 file (8 actions I); formbricks 67 files. No crashes.

**Honesty notes:** default-exported async functions are not listed (named
exports only — documented limitation); `export { foo }` specifier re-exports
resolve only when `foo` is a top-level async declaration in the same file.

## GAP 7 — tRPC procedure enumeration (validated patterns only)

**Changed:** `packages/flowprint/src/framework/trpc.ts` (new),
`analyzeTrpcSurface(repoRoot, sourceFiles, records, ctx)`:
- **(c) Adapter anchoring:** scans for `fetchRequestHandler`,
  `createExpressMiddleware`, `trpcServer` calls; the callee must be imported
  from a `/trpc/i` specifier (validated: `@trpc/server/adapters/fetch`,
  `@trpc/server/adapters/express`, `@hono/trpc-server`). Extracts literal
  `endpoint:` (mount) and `router:` identifier. Anything else — including
  cal.diy's `createNextApiHandler` — is NOT a validated adapter.
- **(a)(b) Router traversal:** `router({...})` / `createTRPCRouter({...})`
  with literal keys; procedure values = call chains containing
  `.query(` / `.mutation(` / `.subscription(`; nested router identifiers
  resolved same-file or via imports (relative, workspace deep subpath, and
  `export { x } from` re-export hops); `mergeRouters(a, b)` unions.
- **Confidence:** R when keys are literals and the merge chain fully traced;
  I when one hop is heuristic (I-confidence resolution, barrel/index
  re-export, identifier-indirected procedure); anything else (computed/spread
  keys, unresolvable bindings, unmatched shapes) → Unknown, never a procedure.
  Cycles guarded via visited-binding sets.
- Model: `AnalysisResult.trpcProcedures: TrpcProcedure[]
  {procedure, path, mountPath, handlerFile, confidence, reason}`; render
  `## tRPC procedures` (display capped at 80, total shown).
- The old blanket "tRPC procedures not enumerated in M0" unknown is replaced
  by precise per-case unknowns.

**Verification:**
- karakeep: **141 procedures at R**, e.g. `/api/trpc/bookmarks.createBookmark`
  ← `packages/trpc/routers/bookmarks.ts` — spot-checked against source;
  hono-style `trpcServer({ endpoint: "/api/trpc", router: appRouter })`
  anchoring works through the `@karakeep/trpc/routers/_app` import chain.
- openstatus: **188 procedures at I** via `fetchRequestHandler` +
  `mergeRouters(edgeRouter, lambdaRouter)` (I is honest: `@openstatus/api`
  resolves at I through exports-condition selection). A test file that
  genuinely calls `fetchRequestHandler` with the same router is detected as an
  adapter site; its duplicates are deduped.
- cal.diy: 0 procedures + explicit Unknown ("tRPC usage does not match the
  validated adapter patterns — do not generalize"). dub/formbricks: 0, no false
  positives.
- No crashes on any of the 5 repos.

**Scope-creep defenses (held):** no procedure-shape generalization beyond
query/mutation/subscription chains; no mount inference without a validated
adapter; `export default router(...)` and plain-object router values are
Unknown, not enumerated.

## STOP-condition review

No STOP triggered. Near-misses:
1. **GAP 1 migration/runtime tension** (above): honest MISMATCHes, not
   confidently-wrong; documented, not patched around.
2. **GAP 7 test-file adapter site** (openstatus): a `.test.ts` file matched the
   validated adapter pattern because it genuinely calls `fetchRequestHandler`
   with the real router — correctly detected, duplicates deduped. Not excluded:
   excluding test files by path would be a repo-specific hack.
3. No repo-specific hacks added; framework logic stayed in `framework/`;
   `resolution/` untouched.

## Files changed

- `packages/flowprint/src/parsing/index.ts` — directive scopes, async names
- `packages/flowprint/src/model/types.ts` — RouteInfo split, ServerActionInfo,
  RouterConflict, TrpcProcedure, AppInfo/AnalysisResult extensions
- `packages/flowprint/src/model/assemble.ts` — assemble new claims
- `packages/flowprint/src/framework/routes.ts` — next.config summary,
  concreteValuesClaim, adapter skeleton → null
- `packages/flowprint/src/framework/pages.ts` — NEW (GAP 5)
- `packages/flowprint/src/framework/serverActions.ts` — NEW (GAP 6)
- `packages/flowprint/src/framework/trpc.ts` — NEW (GAP 7)
- `packages/flowprint/src/framework/index.ts` — wiring
- `packages/flowprint/src/index.ts` — wiring, blanket unknowns replaced
- `packages/flowprint/src/render/index.ts` — new sections
- `bench/harness/compare.ts` — skeleton/concreteValues checks
- `bench/harness/migrate-fixtures-v01.ts` — NEW (one-shot migration)
- `bench/fixtures/{openstatus,formbricks,caldiy,karakeep,dub}.json` — routes[] migrated
- `bench/fixtures/SCHEMA.md` — routes[] split documented
- `docs/v01-alpha-analyzer.md` — NEW (this file)
