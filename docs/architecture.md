# Flowprint M0 — Architecture

**Status:** draft (milestone 0 complete, implementation pending).
**Principle:** smallest engine that is actually correct. Framework logic never leaks
into the core resolver. Confidence (R/I/U) is created in the analysis model,
never added later by the renderer.

## Decision log

### D1 — Parser: `oxc-parser` (official NAPI), no `oxc-semantic` in M0
Full spike: [oxc-spike.md](./oxc-spike.md). `oxc-parser@0.153.0` parses modern TS
with zero errors and exposes an ideal module record (`staticImports` /
`staticExports` with per-specifier `isType`, `dynamicImports[]`). `require()`
needs a trivial AST walk (`CallExpression[callee.name==='require']`).

`oxc-semantic` (third-party, v0.1.0, WASI, single unknown maintainer) was verified
functional but is **rejected for M0**: M0's questions (import graph, barrels,
type-only tagging) are fully answered by the module record + a small AST walk.
Full identifier→declaration resolution is NOT needed (no call graph in M0).
Fallback if ever needed: build a first-party `oxc_semantic` NAPI binding
(est. 2–4 days) using `napi/playground` as template — documented in oxc-spike.md.

**Not a STOP condition.** Proceed.

### D2 — SIGSEGV hazard isolation
Upstream issue oxc#24375: deeply nested expressions can uncatchably SIGSEGV the
host via napi. Mitigation: the benchmark harness runs analysis in a worker
thread per repo (`node:worker_threads`); a crash fails that repo's run loudly
instead of killing the whole benchmark. Revisit for v0.1.

### D3 — TypeScript version of the prototype
Prototype is TypeScript run via `tsx`. `pnpm benchmark` → `tsx bench/harness/run.ts`.

## Layer contracts

```
discovery/   filesystem + workspace discovery
    → { apps: AppScan[], workspaces: Workspace[], packageJsons: Map<dir, Pkg> }
parsing/     source parsing (oxc-parser + require() AST walk)
    → ModuleRecord { imports, exports, dynamicImports, requires, errors }
resolution/  module resolution — NO framework logic
    → resolveImport(fromFile, specifier, ctx) : Claim<string|null>
framework/   Next.js App Router detection (App Router only in M0)
    → { routes: RouteInfo[], proxy?: EntryPoint, notes }
model/       assembles AnalysisResult; every claim gets R/I/U HERE
render/      text-only terminal report
```

### discovery/
- Walk repo for `package.json` files (skip `node_modules`, `.git`, `.next`, `dist`, `build`).
- Workspace detection: `package.json#workspaces`, `pnpm-workspace.yaml`, `package.json#name` → dir map.
  Duplicates / placeholders / ghost entries → record, prefer longest-prefix match on
  segment boundaries (per validation P-findings).
- App detection (M0): a directory is a Next.js app candidate if it has an `app/` dir
  with `layout.tsx|js` or `page.tsx|js`, or `package.json` with `next` dependency.
  Framework claim: R when `next` in deps + app/ conventions present; I when
  conventions-only; U otherwise. Next.js version read from the dependency range
  (drives proxy.ts vs middleware.ts expectation — Next ≥16 prefers proxy.ts).

### parsing/
- One `parseSync` per source file (`.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts`).
- Extract: static imports (specifier, imported names, isType), static exports
  (re-export chains: `export *`, `export {x} from`, `export {x as default}`),
  dynamic `import()` (literal arg → candidate edge; non-literal → unresolved marker),
  `require()` via AST walk (literal arg only).
- Parse errors → file marked, partial record kept, never throws.

### resolution/
Pure function of (fromFile, specifier, resolution context). Context built once per
repo: nearest-tsconfig-wins `paths`/`baseUrl` (extends chains: relative, bare,
array, JSONC-with-comments), per-tsconfig `moduleResolution` mode
(NodeNext `.js` / explicit `.ts` / extensionless bundler), workspace name→dir map,
`package.json` `imports` `#`-aliases.
- Relative specifiers → filesystem, mode-aware extension probing.
- tsconfig paths → patterns, nearest config wins.
- Bare specifiers → workspace map first, then node_modules (M0: node_modules
  treated as external boundary — do not descend; mark edge external).
- `exports`-map: M0 supports basic `exports` string + `import`/`require`/`default`
  conditions only. Custom conditions / wildcards / null-blocking / importer-dependent
  → resolve best-effort, else U with reason. (Validation F4/F9: full compat is v0.1+.)
- dist→src fallback: when exports/main point at absent build output, try `src/`
  via tsconfig paths or layout convention → confidence I, reason stated.
- Barrel chains: transitive re-export resolution with cycle protection (in
  resolution layer — it is module semantics, not framework logic).
- `import type` → type-only edge, excluded from runtime graph by default.
- Confidence: R when specifier resolves via proven filesystem hit under a verified
  rule; I when a fallback/heuristic (dist→src, index fallback) was used; U when
  dynamic specifier, missing generated file, or unresolvable.

### framework/ (Next.js App Router only)
- Route file conventions: `app/**/page.{tsx,ts,jsx,js}`, `route.{ts,js}`,
  `layout`, `loading`, `error`, `not-found` (recorded, not routes).
- URL mapping: strip route groups `(…)`, convert `[p]` → `[p]`, `[...p]`,
  `[[...p]]`; parallel slots `@name` noted; intercepting routes `(.)` noted.
- `proxy.ts` AND `middleware.ts` at app root or `src/`: classify by location +
  export shape (`export default` / `export function proxy|middleware` /
  `export const proxy|middleware`), NEVER filename alone. Next ≥16: expect
  `proxy.ts`; ≤15: expect `middleware.ts`; both present → report both, flag.
- Catch-all `route.ts` delegating to a framework adapter (`handle(app)`,
  `fetchRequestHandler`) → route URL R, handler mapping U with reason
  "embedded framework detected" (+ name the framework when the import
  specifier says so, e.g. `hono/vercel` → I "embedded Hono").
- `pages/` directory detected → record as out-of-M0-scope note, its routes U
  with reason "Pages Router out of M0 scope". Do NOT build Pages detection.

### model/
Assembles `AnalysisResult` (see `packages/flowprint/src/model/types.ts`).
Ambiguity registry: every U gets an entry in `unknowns[]` with area/detail/reason.

### render/
Text-only. Sections: Repository, Applications, Entry points, Routes
(`R`/`I`/`U` prefix per claim), Module resolution (% resolved + counts),
Unknown (list). Matches the M0 target UX in the task brief.

## Confidence rules (binding)
- R: filesystem-proven resolution, syntax-derived facts, framework conventions
  matched by location+shape.
- I: dist→src fallback, index-file fallback, wrapper-transparent handlers,
  embedded-framework naming from import specifier.
- U: dynamic specifiers, env/computed config, generated-but-absent files,
  cross-runtime boundaries, anything needing type info.
- Never upgrade I→R because it "looks obvious". Confidently-wrong is the worst outcome.
