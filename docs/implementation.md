# Flowprint M0 — Implementation notes

**Status:** implemented, tested. `analyzeRepository(repoRoot, opts)` exported from
`packages/flowprint/src/index.ts`; `pnpm flowprint <repo-path>` prints the text report.
`npx tsc --noEmit` clean.

## Per-layer summary

### discovery/ (`src/discovery/index.ts`)
- Single recursive walk finds all `package.json` files, skipping `node_modules`,
  `.git`, `.next`, `dist`, `build`, `coverage`, `.turbo`, `.vercel`, `out`, and
  dot-dirs (except `.well-known`, which is a real Next.js route segment).
- Workspace detection: `package.json#workspaces` (array or `{packages}`) plus
  `pnpm-workspace.yaml` `packages:` list (hand-rolled YAML subset parser — only
  the `packages:` key is read). Builds `name → dir` map from every discovered
  package.json.
- Ghost workspaces: only **exact (non-glob)** patterns whose dir has no
  `package.json` are reported (dub's `apps/web/.react-email`). Glob patterns
  (`apps/*`, `packages/**/*`) legitimately match non-workspace dirs — those are
  skipped silently. (First version recorded every `**`-matched subdir as a
  ghost: dozens of false positives on openstatus. Fixed.)
- App candidates: dir has `app/` or `src/app` containing a `layout|page` file
  (bounded deep search), **or** `next` in deps. The model layer only emits
  candidates with actual router evidence (`app/` or `pages/` dirs); a bare
  `next` dependency without router dirs is not an app.

### parsing/ (`src/parsing/index.ts`)
- `parseSync` per file (`.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts`), `lang` from
  extension, `sourceType`: `commonjs` for `.cjs/.cts`, `module` for `.mjs/.mts`,
  `unambiguous` otherwise.
- Module record → static imports (per-specifier `isType`), static exports
  (`export *`, `export {x} from`, pairs for `export {a as b}`), dynamic
  `import()` via AST `ImportExpression` walk (literal → value incl. template
  literals without expressions; non-literal → null marker), `require()` via
  `CallExpression[callee.name==='require']` walk (literal only).
- **Correction to the spike doc:** `export * from 'x'` appears in
  `module.staticExports` (with per-entry `moduleRequest`), **not** in
  `staticImports`. The d.ts puts `moduleRequest` on `StaticExportEntry`, not on
  `StaticExport` (tsc caught this).
- Export shapes for proxy/middleware/adapter detection: default export (+ call
  callee, e.g. `export default auth(...)`), named function/const exports (+
  call-callee for `export const GET = handle(app)`), `'use server'`/`'use client'`
  directives.
- Parse errors → partial record kept, `hasErrors` set, never throws.

### resolution/ (`src/resolution/`)
- `tsconfig.ts`: JSONC-tolerant loader (comment stripper respecting strings,
  trailing commas), `extends` chains (relative, bare workspace specifiers via
  `name→dir`, arrays, implicit `.json`), child-wins merge, cycle protection.
  Effective `paths` are rebased to **absolute** targets (relative targets resolve
  against the *declaring* config's baseUrl — including inherited baseUrls).
  **Fix:** targets like `"lib/*"` (no `./` prefix) are baseUrl-relative per TS
  semantics; only targets naming a known workspace package (e.g. cal.diy's
  `"@prisma/client/*": ["@calcom/prisma/client/*"]`) stay bare for chained
  resolution. First version treated all non-`./` targets as bare → cal.diy
  `@lib/*` and dub `@/lib/*` fell through to "external".
- `index.ts`: `resolveImport(fromFile, specifier, ctx)` —
  1. relative → mode-aware filesystem probe (`bundler`: extensionless probing;
     `nodenext`: explicit `.js`→`.ts` mapping, extensionless → U);
  2. `#`-imports from nearest `package.json#imports` (basic `*` patterns);
  3. tsconfig `paths` (nearest config wins, longest-pattern-first; a matching
     pattern whose targets miss falls through to the next mechanism);
  4. workspace `name→dir`: subpath → filesystem probe (R; dir-without-index →
     R at the directory); bare name → entry rules below;
  5. anything else → external boundary: `null`, **R**, "node_modules boundary,
     not descended in M0" (covers `hono/vercel`, `@prisma/client`).
- Bare-name entry rules: exports `"."` → existing file ⇒ **I** (condition
  selection is importer-dependent); exports → absent dist target ⇒ src fallback
  ⇒ **I** (extensionless probing, so `./dist/index.mjs` → `./src/index.tsx`);
  no exports + `main` ⇒ **R**; no exports + no main ⇒ directory-index
  `index.*` ⇒ **R** (karakeep `@karakeep/api`); otherwise package dir ⇒ **I**.
- `exports`-map: string + `import`/`require`/`default` conditions; single-`*`
  wildcards best-effort; `null` blocking → U with reason; custom conditions →
  best-effort via `default`.
- Barrel chains (`resolveThroughBarrels`): transitive, cycle-protected, named
  re-exports take precedence over `export *` (ES shadowing; caught a real bug
  where `b` resolved to `a.ts`), local definitions shadow re-exports,
  `export * as ns` terminates. Depth-limited; returns `null` on cycles.
- Deep workspace subpath with **no filesystem hit** → the mechanism-derived
  literal path at **I** ("leaf not verified"), never R (R requires filesystem
  proof) and never a fabricated file.

### framework/ (`src/framework/`)
- App Router only. Route files: `page.*`, `route.*`; special files
  (`layout|loading|error|not-found|default|template`) counted in notes, not
  routes; metadata files (`manifest.ts`→`/manifest.webmanifest`,
  `robots.ts`→`/robots.txt`, `sitemap.ts`→`/sitemap.xml`) at **I**.
- URL mapping: route groups `(…)` stripped; `[p]`, `[...p]`, `[[...p]]` kept;
  parallel slots `@name` stripped + noted; intercepting segments
  `(.)/(..)/(...)` → `null` at **I** ("renders inside the intercepted route's
  slot; file→URL mapping over-reports here" — matches karakeep fixture).
- Adapter delegation: `route.ts` importing `handle`/`fetchRequestHandler`-style
  bindings from a framework specifier (`hono|express|elysia|fastify|trpc`) **and**
  assigning the call to route exports → URL **U**,
  "embedded framework detected (Hono via hono/vercel) — endpoints Unknown".
  The *providing* specifier is named (not just the first framework import).
- `proxy.ts`/`middleware.ts` at app root or `src/`, classified by location +
  export shape (`export default` incl. `export default auth(...)`, or named
  `proxy`/`middleware` function/const) — never filename alone. Both present →
  both reported + flagged. Next ≥16 expects `proxy.ts`, ≤15 `middleware.ts`;
  unreadable range (pnpm `catalog:`) → expectation unknown, not guessed.
- `pages/` detected → note + `nextjs-hybrid` id; its routes NOT detected
  (out of M0 scope).

### model/ (`src/model/assemble.ts`, `src/model/types.ts`)
- Assembles `AnalysisResult`; owns final claim objects. Aliases attributed per
  owning tsconfig (own `paths` + inherited preset paths, each with its owner);
  dead alias targets → "stale tsconfig entries" unknowns.
- Resolution stats: every import edge (static + re-export + require + dynamic)
  resolved across all parsed files.
- Unknowns de-duplicated; evidence-triggered (see below).

### render/ (`src/render/index.ts`) + `src/cli.ts`
- Text report: Repository / Applications / Entry points / Routes (`[R|I|U]`
  prefixes, non-R reasons shown) / Module resolution (% + probes) / Unknown.
- `pnpm flowprint <repo-path>` prints it.

## Decisions (with rationale)

1. **Bare workspace name → directory-level I (not the exports-resolved file at R).**
   The entry file depends on exports-map condition selection (`import` vs
   `require` vs `types`), which is importer-dependent. Fixture notes for
   `@openstatus/db` and `@formbricks/logger` explicitly stop at directory level
   (I). Exception: no `exports` and no `main` → Node's legacy directory-index
   convention deterministically selects `index.*` → R (karakeep fixture
   demands R here).
2. **Dynamic-segment URL skeletons stay R.** The skeleton mapping is
   syntax-derived per documented convention. One fixture case (openstatus
   status-page `/[domain]/[locale]/login`) marks U on *boundedness* grounds
   ("concrete values come from customer DB") that no static analyzer can assess
   generally — the fixture's own reason calls the skeleton R. Downgrading all
   dynamic skeletons to U to dodge one check would be fixture-fitting.
   Documented as a known tension (expected: 1 CONFIDENTLY_WRONG, not a crash).
3. **Extra apps are emitted, not filtered.** cal.diy has 3 genuine Next.js apps
   beyond the fixture (`apps/docs`, `example-apps/credential-sync`,
   `packages/platform/examples/base` — all verified: `next` in deps + router
   dirs). The harness flags extras as MISMATCH ("verify whether false positive
   or fixture gap") — these are fixture gaps. Filtering them would be a
   repo-specific hack.
4. **`import type` edges resolve but are flagged `typeOnly`** and excluded from
   the runtime graph; counted separately in stats.
5. **Non-literal `require()`/dynamic `import()`** → U edge + counted, never
   guessed.

## Blockers hit

1. **No pnpm/corepack in the environment** (task said available). Fixed with a
   shim: `npm pack pnpm@10` → `node …/pnpm.cjs`, installed at
   `~/workspace/bin/pnpm` (PATH). Note for the coordinator: `~/workspace/bin`
   must be on PATH for `pnpm` commands, or install pnpm properly.
2. **`npm add` corrupted the pnpm `node_modules`** (esbuild binary version
   mismatch from npm's flat install). Recovered via `pnpm install`; the
   root-owned `~/.config/pnpm/rc` (from an early `pnpm config set --global`)
   can't be edited — worked around with a project-local `.npmrc`
   (`store-dir=…/store/v10`). The `pnpm-lock.yaml` was regenerated for
   `oxc-parser@0.153.0` (fresh write; old file couldn't be overwritten due to
   EPERM chown on overlayfs). Diff verified: only oxc-parser entries added.
3. **Stuck `pnpm install`** — it was blocked on an interactive "reinstall from
   scratch? (Y/n)" prompt. `CI=1` fixes it.
4. **Proxy credentials in env** — an `env | grep -i proxy` debug printed
   credential-bearing proxy URLs into tool output. Noted; not repeated.
   (No secret was written to any file.)

## Fixes classified

**General rules (not repo-specific):**
- `export * from` lives in `staticExports`, not `staticImports` (spike-doc
  correction); re-export specifiers count as import edges.
- tsconfig `paths` targets without `./` are baseUrl-relative; only targets
  naming a known workspace package stay bare (chained aliases).
- dist→src fallback probes extensionless (`.mjs` → `.tsx`).
- Named re-exports shadow `export *` in barrel following (real bug: `b`
  resolved to `a.ts`).
- Ghost workspaces only from exact non-glob patterns (killed `**` noise).
- Workspace deep-subpath miss → mechanism-derived literal path at I, never R.
- Adapter `viaSpecifier` names the specifier that provided the called binding.

**Framework rules:**
- Intercepting routes → `null` URL at I; metadata routes at I; catch-all
  `route.ts` delegating to a framework adapter → URL U naming the framework.
- proxy/middleware classified by location + export shape, never filename alone.

**Repo-specific hacks:** none. (Two deliberate non-changes: the 3 extra cal.diy
apps are real; the openstatus `/[domain]/[locale]` skeleton stays R.)

## Where architecture.md proved wrong or imprecise in practice

1. **"index-file fallback → I" vs karakeep.** The fixture demands **R** for
   `@karakeep/api` → `packages/api/index.ts` (no `exports`, no `main`). The
   architecture's blanket "index fallback → I" is too coarse: Node's legacy
   directory-index convention with no `exports`/`main` is deterministic, and R
   is honest there. The I case is specifically *exports-map condition
   selection*, which is importer-dependent. (Resolution rule table above.)
2. **"Catch-all route.ts delegating → route URL R".** The karakeep fixture
   marks the Hono-mounted `[[...route]]` URL **U** ("a Next-only detector must
   NOT claim this as one API route"). Implemented as U; architecture's R would
   produce CONFIDENTLY_WRONG.
3. **D2 worker isolation is not implemented.** `bench/harness/run.ts` still
   calls `analyzeRepository` directly in-process. No SIGSEGV was observed
   (openstatus: 2703 files, 7.2s, no crash), but the mitigation is pending for
   the coordinator's milestone 6.
4. **`export type *` handling** in the spike doc is accurate; no issues found.
5. **oxc-parser@0.153.0**: `parseSync` + module record behaved exactly as the
   spike documented (incl. partial records on syntax errors). `rawTransfer`
   API exists but was not needed.

## Test outcomes

- **Synthetic repo** (`/tmp/flowprint-test`): 2-app pnpm workspace, extends +
  JSONC tsconfigs, `@/*` aliases, 2-hop barrel + cycle, named-export `proxy.ts`,
  default-export `middleware.ts`, route group `(app)`, `[id]`, `[[...slug]]`
  Hono catch-all, `import type`, literal + non-literal `require()`, broken TS
  file. Hand-verified: apps (2, R), aliases (owner + raw targets), entries
  (proxy/middleware, R), routes (`/`×2 R, `/[id]` R, `/api/[[...slug]]` U with
  Hono reason), methods `[GET,POST]`, barrel chain `a`→`a.ts` / `b`→`b.ts`
  (2 hops), cycle terminates (`null` on missing name), probes incl.
  `hono/vercel`→`null` R (external), type-only flag, broken file → partial
  record + unknown. 16 edges: 15 R, 1 U (non-literal require).
- **Smoke run** `pnpm flowprint bench/repos/openstatus`: completed, exit 0,
  7.2s, 3 apps, 2 proxy.ts entries, 145+ routes, 13,499 edges
  (84.2% R, 822 I, 1,312 U). No crash.
- **Targeted per-repo verification** (`/tmp/verify-m0.mts`, 50 assertions
  across all 5 fixture repos, using fixture importCases as probes): **49/50
  pass**. The one miss is the documented `@openstatus/ui` tension (analyzer I
  vs fixture R — architecture binds R to filesystem proof; the fixture's own
  note says "exact leaf file not verified").
- `npx tsc --noEmit`: clean.
- Full `pnpm benchmark` NOT run (coordinator's milestone 6, per instructions).
  `analyzeRepository` honors `probeImports` (verified).
