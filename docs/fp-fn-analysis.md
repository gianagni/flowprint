# Flowprint M0 — False-positive / false-negative analysis

**Benchmark run:** `bench/results/2026-10-06T08-12-15-878Z.json` (after harness comparator fixes)
**Totals:** OK=69 · MISSING=14 · MISMATCH=6 · CONFIDENTLY_WRONG=1 · HONEST_UNKNOWN=24 · 31.5s

## False positives (analyzer claimed something it shouldn't have)

**None.** Zero true false positives across apps, entry points, routes, and imports.

- The 3 "extra" cal.diy apps (`apps/docs`, `example-apps/credential-sync`,
  `packages/platform/examples/base`) were hand-verified as genuine Next.js apps
  (`next` in deps + router dirs). They are **fixture gaps**, not false positives.
  Filtering them would have been a repo-specific hack; emitting them was correct.
- The proxy/middleware classifier (location + export shape, never filename alone)
  produced no false hits on any repo.

## False negatives (analyzer missed something it should have found)

**No material false negatives.** Every MISSING check was triaged:

| Check | Verdict |
|---|---|
| formbricks routeTs 122 vs 150 / pageTsx 80 vs 123 | **Not FN.** Tree contains exactly 122 route.ts + 80 page.tsx under `app/` dirs; the other 28 + 43 live under `apps/web/modules/` (handler/component modules, not routes). The analyzer found 122/122 and 80/80. The fixture counts are raw tree counts — a fixture semantics issue, documented for fixture v2. |
| openstatus `apps/web/src/app/mcp/route.ts` | **Not FN.** File does not exist in the current clone (moved to `app/(ai)/mcp/route.ts` since research). Tree drift, not a miss. |
| dub 3 route entries (`[domain]/`, `(ee)/admin.dub.co/`, `app.dub.co/` as `(dir)` paths) | **Untestable.** Fixture records directories, analyzer emits files. Fixture granularity issue. |
| cal.diy router-conflict file-by-file check | **Genuine minor gap.** App-vs-Pages same-URL conflict detection not implemented in M0. |
| karakeep intercepting-route UX unknown | **Genuine minor gap.** Analyzer maps intercepting routes to null-URL at I (correct handling) but does not emit the explicit "file mapping over-reports navigable URLs" unknown the fixture expects. |
| Remaining unsurfaced ambiguities (barrel depth, tsconfig preset paths, middleware export shape, deep-import pattern note, [domain] URLs, edge-entry convention) | **Harness strictness / stale expectations**, not capability gaps: the analyzer either handles these (barrels, tsconfig extends incl. bare specifiers, middleware classification all verified working) or surfaces an equivalent unknown under different wording (tRPC, hostname dispatch). |

## Confidently-wrong outcomes

**1 flagged, 0 true.** The single flag is a documented philosophical disagreement:

- openstatus `apps/status-page/.../[domain]/[locale]/(auth)/login/page.tsx`:
  analyzer claims URL skeleton `/[domain]/[locale]/login` at **R**;
  fixture expects **U** on boundedness grounds ("concrete values come from customer DB").
- The analyzer **also** surfaces "concrete URLs" as HONEST_UNKNOWN on the same repo.
- Adjudication: the skeleton *is* syntax-derived per documented Next.js convention;
  the value space *is* unknowable. Conflating them into one U claim loses information.
  The analyzer's split (skeleton R + values U) is the better model.
  **Recommendation for v0.1:** split route URL claims into `skeleton` (R) and
  `concreteValues` (U) as separate claim fields.

All 18 import probes resolve to the correct target with appropriate confidence
(after accounting for the fixture's leaf-file caveat: the analyzer resolves to the
concrete leaf file, which is more precise than the fixture's verified prefix).

## Honesty accounting

- 24 claims correctly surfaced as Unknown (auth gating, env-conditional aliases,
  tRPC surface, computed rewrites, hostname dispatch, middleware rewrites,
  server actions, dynamic-segment value spaces, …).
- The karakeep adversarial case behaves exactly as specified:
  `/api/[[...route]]/route.ts` → URL **U**, "embedded framework detected
  (Hono via hono/factory) — endpoints Unknown". No fake endpoints emitted.
- Resolution honesty: 84–98% of edges resolved at R per repo; the remainder is
  labeled I (dist→src fallback, exports-condition selection, index fallback)
  or U (dynamic specifiers, generated-absent, external boundary) — never silently wrong.
