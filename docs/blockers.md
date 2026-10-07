# Flowprint M0 — Implementation blockers log

All blockers encountered during M0, with resolutions. "Blocker" here means anything
that stopped or threatened progress — including environment, harness, and fixture
issues, not just analyzer code.

## B1 — pnpm missing / shim confusion (environment) — worked around
`pnpm` was not on PATH for background exec sessions. The implementation agent's
shim (`~/workspace/bin/pnpm` → `/tmp/pnpmshim/package/dist/pnpm.cjs`, pnpm 10.15.0)
works but requires `export PATH="$HOME/workspace/bin:$PATH"`. A previous global
`npm i -g pnpm` install vanished mid-spike (cause unknown). **For v0.1:** install
pnpm properly and persist it on PATH; do not rely on the /tmp shim (tmpfs).

## B2 — `npm add` corrupted pnpm's node_modules (environment) — recovered
Running `npm add` inside the pnpm-managed workspace caused an esbuild binary
version mismatch. Recovered via `pnpm install`. **Rule:** never mix npm and pnpm
in this workspace.

## B3 — Harness comparator bugs masked real results (harness) — fixed
Two bugs in `bench/harness/compare.ts` made all 18 import probes report
"(probe not run)" / MISSING:
1. Map keys built with `::` but looked up with ` :: ` (separator mismatch).
2. `resolvedEqual` was asymmetric while `checkClaim` calls `equals(actual, expected)`
   (swapped argument order) — now symmetric.
**Lesson:** the benchmark initially reported MISSING=29; after fixes the same
analyzer scored OK=69 with zero true confidently-wrong outcomes. Always distrust
a harness before distrusting the analyzer — verify the harness against a direct call.

## B4 — Fixture staleness vs active repos (fixtures) — documented, needs process
- openstatus `apps/web/src/app/mcp/route.ts` (fixture) no longer exists in the
  clone (moved to `app/(ai)/mcp/route.ts`). Tree drift between research date and
  clone HEAD.
- formbricks `routeTs: 150` / `pageTsx: 123` are raw tree counts; true App Router
  routes are 122 / 80 (remainder live under `modules/`, not routes).
- dub route entries recorded as directories (`(dir)` suffix) — unmatchable by
  file-based checks.
**For v0.1:** pin fixtures to clone SHAs (SHAs are recorded in
`bench/repos/SHAS.txt`); regenerate or re-verify fixtures when the SHA moves;
label counts as tree-counts vs route-counts.

## B5 — oxc SIGSEGV hazard (upstream) — not observed, mitigation pending
oxc#24375: deeply nested expressions can uncatchably SIGSEGV the host via napi.
No crash observed across ~90k parsed files in M0. The planned worker-thread
isolation in the harness (`docs/architecture.md` D2) is still pending.
**For v0.1:** implement worker isolation before running on untrusted repos.

## B6 — Clone directory wiped mid-spike (environment) — recovered, cause unknown
`bench/repos/` was found empty (a completed clone plus an in-progress one gone;
background session also gone). The implementation agent denied touching it and its
session log corroborates (read-only `ls`). Cause undetermined — possibly runtime
session cleanup. All five repos re-cloned with SHAs recorded.
**For v0.1:** the harness should verify clone integrity (`.git` present, SHA matches
`SHAS.txt`) before running, and fail loudly otherwise.

## Non-blockers (investigated, cleared)
- **tsx module cache**: suspected of serving stale `compare.ts`; disproven via
  `--no-cache` runs (identical results). The real bug was B3.
- **formbricks route undercount**: suspected analyzer FN; disproven by tree
  census (122/122, 80/80 exact).
- **`export *` in module record**: the spike doc said `staticImports`; tsc caught
  that it's actually on `staticExports` entries. Corrected during implementation.
- **Proxy credentials in env**: noticed during debugging; not written to any file.

## No true implementation blockers
oxc-parser delivered every primitive M0 needed (parse, module record with isType,
dynamic imports, error-tolerant partial records). The multi-regime resolver,
JSONC tsconfig loader with extends chains, barrel chains, and the App Router
detector were all built without duplicating compiler internals. No STOP condition
triggered.
