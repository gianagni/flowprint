# Fixture schema — Flowprint M0 benchmark answer key

**Location:** `~/workspace/flowprint/m0/bench/fixtures/<slug>.json`
**Slugs:** `openstatus`, `formbricks`, `caldiy`, `karakeep`, `dub`
**Purpose:** These fixtures are the benchmark's answer key: the set of facts an M0 analyzer is expected to reproduce, each labeled with the confidence the validation research assigned. The benchmark checks *detected vs expected*; it must not penalize the analyzer for facts the research itself left Unknown.

## Confidence model

Every verifiable claim carries `expectedConfidence`:

| Value | Meaning |
|---|---|
| `R` | **Resolved** — proven from syntax, file reads, or documented convention in the research notes |
| `I` | **Inferred** — strong heuristic; research judged it likely but not proven |
| `U` | **Unknown** — needs runtime, types, env, or evaluation the research did not perform |

The benchmark should treat R as must-detect, I as should-detect-or-flag, U as must-not-claim (flag as unknown).

## Top-level fields

| Field | Type | Meaning |
|---|---|---|
| `fixtureVersion` | string | Schema version (`"1.0"`) |
| `repo` | string | `owner/name` |
| `slug` | string | Fixture slug |
| `researched` | string | Date of validation research (`2026-10-06`) |
| `note` | string | Provenance: only manually verified facts from the research are included |
| `apps` | array | Verified Next.js app locations (see below) |
| `routes` | array | Sample of verified route files → URL mappings (see below) |
| `redirects` | array | Verified literal redirect pairs `{source, destination, definedIn, expectedConfidence}` |
| `rewrites` | array | Verified literal rewrite pairs `{source, destination, kind:"rewrite", expectedConfidence}` (cal.diy only) |
| `counts` | object | Verified file counts (tree counts), each with `expectedConfidence` |
| `ambiguities` | array | Known ambiguity cases `{area, detail, expectedConfidence}` — the honesty checklist |
| `noise` | array | Verified generated/test/config noise `{pattern, kind, expectedConfidence}` |
| `excludedFacts` | array | Facts considered but deliberately excluded (see "Deliberately excluded") |
| `provenanceNotes` | array | Research reconciliation notes (e.g. duplicate-study discrepancies) |
| `importCases` | array | Import-resolution test cases (see below) |
| Repo-specific | object | `hybrid`/`pagesRouter` (cal.diy), `workspacePackages` (cal.diy), Hono composition notes (karakeep) |

## `apps[]` fields

| Field | Meaning |
|---|---|
| `name` | Workspace package name from package.json, or `null` if not verified |
| `dir` | Repo-relative app directory |
| `framework` | e.g. `Next.js App Router`, `Next.js hybrid (App Router + Pages Router)` |
| `nextConvention` / `nextVersion` | `proxy.ts` (Next 16 rename) vs `middleware.ts` (Next 15) distinction |
| `entryScripts` | Verified package.json scripts (`dev` etc.), each with confidence |
| `edgeEntry` | `{file, exportShape, configTail|matcher, behaviorVerified, noMiddlewareTs, expectedConfidence}` — the request front door. `exportShape` is the exact export form verified (default vs named), because detectors keyed to one shape miss the other |
| `instrumentation` | Verified `instrumentation*.ts` startup hooks |
| `sourceRoot` | Where source lives (`apps/x/src` vs `apps/x` — verified, not assumed) |
| `tsconfig` | `{path, extends, baseUrl, moduleResolution, selfContained, presetChain[]}` — `extends` may be a workspace-package specifier, a chain, or `null` (self-contained) |
| `aliases` | `[{pattern, targets, ownerTsconfig, expectedConfidence}]` — **every alias names its owning tsconfig**, because aliases live per-app, never (only) at root |
| `jsoncTsconfig` | Present when the tsconfig contains comments (cal.diy) — strict JSON parsers fail |
| `pagesBootstrap` | Verified `pages/_app.tsx` content (cal.diy hybrid) |

## `routes[]` fields (v0.1-alpha)

Route URL claims are split into **skeleton** and **concreteValues** (see
`docs/fp-fn-analysis.md` adjudication): the skeleton is the file-convention URL
with dynamic segments as written (route groups stripped); concreteValues are
the enumerable concrete URLs.

| Field | Meaning |
|---|---|
| `file` | Repo-relative path — **only files explicitly named/verified in the research** |
| `expectedSkeleton` | URL skeleton with route groups stripped and dynamic segments as verified. May be `null` when no skeleton claim is made (intercepting routes, adapter-delegated catch-alls) |
| `skeletonConfidence` | R / I / U for the skeleton |
| `expectedConcreteValues` | Array of concrete URLs (usually `[skeleton]` or `[]`); `null` when no concrete-values claim is made (intercepting routes, adapter-delegated catch-alls) |
| `concreteValuesConfidence` | R / I / U for the concrete values |
| `method` | HTTP method(s) — **only if the research named them**; otherwise omitted |
| `reason` | Required for I/U: why the confidence is what it is |

5–15 route entries per repo is the target; the sample is representative, not exhaustive.

**Analyzer rules for the split** (binding):
- `skeleton`: R when syntax-derived per Next.js convention; intercepting routes → null at I; adapter-delegated catch-all → null at U.
- `concreteValues`: R `[skeleton]` only when the skeleton is fully static AND the app's next.config is readable with no basePath/rewrites/redirects; I `[skeleton]` when config presence/readability is uncertain or such directives exist; U `[]` ("concrete values require runtime data (DB rows, env, tenant config)") whenever dynamic segments exist; null for intercepting routes and adapter-delegated catch-alls.

## `importCases[]` fields

Manually verified import-resolution test cases. Only imports whose **site** (file + specifier as written) was verified in the research appear — fewer honest cases beat invented ones.

| Field | Type | Meaning |
|---|---|---|
| `fromFile` | string | Repo-relative file containing the import (verified) |
| `specifier` | string | Import specifier exactly as written in source |
| `expectedResolved` | string \| null | Repo-relative path the specifier should resolve to, **or `null` if expected unresolvable in the repo graph**. `null` covers two sub-cases, disambiguated in `note`: (a) generated code absent on a fresh clone (e.g. `@prisma/client` before `prisma generate`) — correct handling is "mark as generated-code edge", not a resolution failure; (b) external npm packages (e.g. `hono/vercel`) — correct handling is "external", not an error |
| `expectedConfidence` | R / I / U | Confidence in the resolution |
| `note` | string | Mechanism verified (alias owner, exports-map state, dist-absent fallback, index fallback, …) |

**Leaf-file caveat:** the research verified import *sites* and resolution *mechanisms*, but usually not the exact leaf file. When only the directory/prefix is verified, `expectedResolved` gives that prefix and the `note` says the leaf file was not verified. Confidence reflects the verified portion:
- `R` — mechanism + target prefix verified (e.g. deep subpath via workspace symlink → package dir; alias mapping from the owning tsconfig)
- `I` — heuristic fallback the research endorsed (e.g. dub `@dub/ui` exports→`dist` absent → `src/` fallback; bare `@formbricks/logger` → package dir without verified entry file)
- `U` — not used in current fixtures; reserved for cases where research could not determine resolvability

**Coverage intent per repo:**
- `openstatus`: deep workspace subpaths bypassing exports maps (`@openstatus/db/src/schema`, `@openstatus/ui/lib/...`) — the P6 pattern
- `formbricks`: workspace deep imports (`@formbricks/types/surveys/types`) + app-root absolute alias (`@/app/...`)
- `caldiy`: cross-package source alias with `../` escape context; verified case is `@lib/csp` via the `@lib/*` alias (only verified import site)
- `karakeep`: `@karakeep/api` → `packages/api/index.ts` directory-index fallback (package.json has no `exports`/`main` — verified R); `hono/vercel` → external (`null`)
- `dub`: `@dub/ui` exports→dist-absent → src fallback (I); `@dub/utils/src/constants` deep subpath bypassing exports (R); `@/lib/*` alias cases (R); `@prisma/client` → `null` (generated, R)

## Special cases (encoded exactly as specified)

- **karakeep:** `apps/web/app/api/[[...route]]/route.ts` is a Hono mount. Fixture records: route file detected (`R`), `expectedSkeleton` `null` confidence `U`, `expectedConcreteValues` `null` confidence `U`, reason `"embedded framework detected (Hono) — endpoints Unknown"`. Hono endpoints are **not** listed as expected routes; the 17 router modules are recorded as composition facts (R that they exist and are mounted; per-endpoint paths I/U).
- **cal.diy:** hybrid App+Pages. M0 scope is App Router only. `pagesRouter` object: `detected: R`, `expectedHandling: "detected-but-out-of-M0-scope"`, route expectations confidence `U`, reason `"Pages Router out of M0 scope"`. No Pages route expectations are invented. `middleware.ts` is **not** encoded as an edge entry (duplicate study claimed it; verified tree search disproved it — see `provenanceNotes`).
- **dub:** Next 15 → `middleware.ts` (not `proxy.ts`); no root tsconfig.json (R — must not be expected); per-app/per-package tsconfigs; `@dub/ui` exports→`dist` absent → `src` fallback expected as **I**; dead `@/pages/*` alias and stale `packages/blocks` include must be tolerated, not resolved.
- **openstatus/formbricks:** `proxy.ts` (Next 16) with exact export shapes: openstatus `export default auth(...)` + regex `config.matcher`; formbricks `export const proxy = ...` (named, not default) + literal `config.matcher`.

## Deliberately excluded

General rule: if the research did not verify it, it is not in the fixture.

- **Route `method` fields** — omitted everywhere unless the research named the methods (none of the five repos had per-handler methods verified).
- **tRPC procedure lists** (openstatus, cal.diy, karakeep) — routers not enumerated in research; recorded as I-level ambiguities, not routes.
- **Server-action inventories** — 0/27 repos inventoried in research; always U, never claimed.
- **formbricks:** redirect `/environments/:environmentId/project/:path*` — destination only partially captured in notes; excluded rather than reconstructed.
- **cal.diy:** computed/env-conditional rewrites (locales join, org paths), `pages/` route files, barrel depth.
- **karakeep:** per-endpoint Hono paths (pattern verified on `health.ts` only), tRPC procedures, per-route auth requirements, slot-rendering outcomes.
- **dub:** `middleware.ts` export shape (location verified, shape not read), `[domain]` concrete URLs, `import type` census, `@dub/utils/src/constants` leaf barrel depth.
- **openstatus:** exact session behavior inside the Auth.js wrapper; status-page concrete URLs.
- **All:** exhaustive route enumeration (counts verified; sample is the answer key, not the census).
