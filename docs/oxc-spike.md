# oxc NAPI Spike — Flowprint M0

Tested 2026-10-06. Scratch: `/tmp/oxc-spike` (spike.js, perf.js, samples/).

## Packages tested
- **`oxc-parser@0.153.0`** (official, oxc-project, MIT) — native NAPI parser (ESTree/TS-ESTree AST + module record).
- **`oxc-semantic@0.1.0`** (third-party, publisher `inschrift-spruch-raum`, BSD-3-Clause) — WASI binding exposing Oxc's `SemanticBuilder`. NOT an official oxc package.
- Official oxc repo has **no published semantic NAPI binding**: `napi/` contains only `parser, transform, minify, playground, transform-react, transform-relay` (verified via GitHub API). `napi/playground` runs semantic internally but `oxc-playground` is `"private": true` and **not on npm** (E404).

Docs: https://oxc.rs/docs/guide/usage/parser · d.ts in `node_modules/oxc-parser/src-js/index.d.ts` · https://github.com/oxc-project/oxc/issues/24375 (crash report, FYI)

## 1. Parse TS/TSX/JS/JSX
Sample with `export type *`, `export type * as ns`, decorators, `import type`, import attributes (`with {type:'macro'}`), `using`/`await using` → **0 parse errors**. `ParserOptions`: `lang: js|jsx|ts|tsx|dts`, `sourceType: script|module|commonjs|unambiguous`.

## 2. Module record — EXCELLENT
`ParseResult.module` (`EcmaScriptModule`) gives exactly what M0 needs, no AST walk required:
- `staticImports[]`: `moduleRequest{value,start,end}` + `entries[]` (`importName{kind: Name|NamespaceObject|Default}`, `localName{value}`, **`isType`** per specifier — `import {type Gamma}` → `isType:true`).
- `staticExports[]`: entries with `importName/exportName/localName` kinds (`Name|Default|None`, `All|AllButDefault`) + `isType`. Verified: `export type *` → `importName: AllButDefault, isType:true`; `export {foo as default}`; `export default class Foo` → `exportName.kind: Default, localName: Foo`.
- `hasModuleSyntax`, `importMetas[]`.

## 3. `require()` / dynamic `import()`
- Dynamic imports: `module.dynamicImports[]` = `[{start,end,moduleRequest{start,end}}]` — **2/2 found** in sample (plain + `await import()` with comment). AST also has `ImportExpression` nodes.
- `require()`: **not** in the module record — needs an AST walk for `CallExpression[c callee.name==='require']` (works; found 2/2). With `sourceType:'commonjs'` no special handling observed.

## 4. Syntax-error tolerance — GOOD
Broken file (`import { a from …`, `const x = ;`) → `parseSync` returns a **partial non-null `program`**, `errors[]` with `{severity, message, labels, codeframe}` (line/col, "Expected `,` or `}` but found `from`"), and still yields `module.staticImports` (length 1). No crash.

## 5. Scope/semantic via NAPI — YES, via third-party `oxc-semantic`
`oxc-parser` exposes **no** scope/symbol API. Its `showSemanticErrors` option runs a semantic pass internally but only surfaces diagnostics (e.g. "Identifier `a` has already been declared") — no scope tree.
`oxc-semantic` (`analyzeSync(filename, src, {lang, sourceType})`) returns `{scopes, symbols, references, diagnostics}`:
- `references[i].symbolId` → resolves every read to its symbol; `symbols[i].flags` = `Import` / `BlockScopedVariable` / `Function` / …; `referenceIds` back-links; `isUnresolved` flag for globals.
- Sample: import bindings `alpha, b2, ns, defaultExport` all flagged `Import`; function-param scope nesting correct.
- Caveats: **type-only imports (`import type {Delta}`) produce NO symbol** (erased semantics) — import-specifier extraction must use `oxc-parser`'s `isType` instead. On broken files it returns diagnostics + **empty** scopes/symbols (worse degradation than the parser's partial AST).
- Maturity risk: v0.1.0, single version, published 2026-09-28, unknown maintainer, pinned to Oxc 0.151.0 (vs parser 0.153.0). Node runs it via **WASI** (`ExperimentalWarning`); correlate AST↔semantic by **spans**, not `nodeId`s (version skew).
- It ships a 1.3 MB wasm; LICENSE BSD-3-Clause, copyright "Plugin Authors".

## 6. Performance (Linux x64, Node 24)
| op | result |
|---|---|
| `parseSync` 1001-line / 64 KB TS (avg of 20, warm) | **9.3 ms** |
| 100 such files | **1.08 s** (~10.8 ms/file) |
| `analyzeSync` 1000-line file (avg of 20) | **82 ms** (~9× slower than parse; WASI overhead) |
| ⇒ 100 files semantic analysis | ≈ 8 s (acceptable for an offline M0 benchmark harness) |

## What's MISSING vs M0
1. No official NAPI semantic binding — dependency on a 0.1.0 third-party package for reference resolution.
2. `oxc-semantic` drops type-only imports from the symbol table (use `oxc-parser.isType` to compensate).
3. `require()` needs a manual AST walk (cheap; `visitorKeys`/`Visitor` raw-transfer exists for fast traversal).
4. Known upstream crash: deeply nested expressions can SIGSEGV the host process ([issue #24375](https://github.com/oxc-project/oxc/issues/24375)) — uncatchable; benchmark harness should guard with a worker or depth pre-check.

## Fallback assessment (if `oxc-semantic` were unusable)
DIY scope resolution by walking the oxc AST in JS: module-level import/export + top-level binding tracking is **~1–2 days** (sufficient for M0's import-graph questions). Full JS scoping (closures, destructuring, hoisting, catch params, eval) is **weeks** and bug-prone — do not attempt; prefer vendoring/building our own napi-semantic binding from `oxc_semantic` (estimated **2–4 days** for someone comfortable with napi-rs, using `napi/playground`'s `lib.rs` as the template).

## Verdict: **SUITABLE-WITH-FALLBACK**
`oxc-parser` natively covers items 1–4 and 6 with an ideal module record. Item 5 (identifier→declaration resolution) is covered today only by third-party `oxc-semantic@0.1.0` (functional, verified, but immature + WASI + third-party trust). Fallback path is concrete: build a first-party `oxc_semantic` NAPI binding (2–4 days) using the playground crate as reference. **Not a STOP condition.**
