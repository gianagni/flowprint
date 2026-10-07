# Flowprint — Pre-Private-Alpha Hardening Report

**Date:** 2026-10-06. **Scope:** fix exactly 4 release blockers, improve benchmark taxonomy, rerun benchmarks, prepare tester package. No framework expansion, no public release work.
**Status:** complete. All prior evidence preserved (docs/m0-report.md, docs/v01-alpha.md, bench/results/*.json untouched).

**Reading key:** FACT (executed/verified) · INFERENCE (judgment).

---

## 1. Blocker evidence

### B1 — child_process parser isolation: FIXED (proven)
- FACT: `src/parsing/isolated.ts` (new) runs all oxc parsing in `child_process.fork` workers (batches of 200, ≤8 concurrent). Child death (non-zero exit, signal incl. SIGSEGV, spawn error, 5-min timeout) never throws — binary-split retry isolates the crashing file(s), each marked Unknown ("crashed during parse — file skipped"), scan continues.
- FACT (repro, docs/b1-repro.sh + docs/b1-repro.md, exit 0): 10k-deep nested parens input exits **139 (SIGSEGV)** in-process; with isolation the log shows `PARSE CHILD CRASHED: child died (exit code=null, signal=SIGSEGV)`, the **parent exits 0**, full report renders, file surfaces as `[U] parse crashes`.
- FACT: 40/40 real-file round-trip JSON-identical (direct vs isolated parse); `tsc` clean.
- Residual: fork spawn ~150ms amortized; pathological many-crash repos degrade to O(crashes × log n) spawns but complete. `tsx execArgv` propagation assumed and documented.

### B2 — generalized hybrid router detection: FIXED
- FACT (general rule): per app candidate, App Router evidence (`app/` or `src/app` with route-convention files) and Pages Router evidence (`pages/` or `src/pages` with routable pages) are detected **independently per directory** — never one label per app, never gating one detector on the other. Both detectors always run; both route sets reported; pages-wins on same-URL conflicts (unchanged rule). No repo/app names in the implementation (verified by grep).
- FACT (before/after, supabase `apps/studio`): before `[R] nextjs-pages-router` with 4 `app/api/*` routes absent; after `[R] nextjs-hybrid` + "4 route files under apps/studio/app + 289 under apps/studio/pages, 0 same-URL conflicts", all 4 routes at skeleton-R/concrete-I. Benchmark: supabase OK 5→14, MISS −4, MM −1, WRONG=0.
- FACT: cal.diy hybrid still 0 conflicts; other 4 baseline repos byte-identical.

### B3 — explicit unsupported boundaries: FIXED
- FACT: `src/boundaries/detect.ts` — data-driven dependency scan (package table, no per-repo logic); `src/boundaries/types.ts`; `src/render/boundaries.ts` → `renderBoundaries()`; wired into every report after Applications. Supported surface (Next.js, tRPC) never emits.
- FACT (vendure `packages/core`, verified live): section names NestJS / Express / GraphQL / Apollo Server with evidence strings and per-area Supported/Unsupported tables, headed by "absence from the Routes section means absence of analysis, never absence of routes."
- FACT: dub (Next.js+tRPC) and zod emit zero boundaries — supported surface stays silent.

### B4 — per-app analysis first-class: FIXED
- FACT (scoping rule, documented in src/index.ts): discovery always global/fast (package.json walk only); the expensive walk+parse+framework pipeline scopes to exactly ONE app dir; cross-package imports resolve via the global name→dir map with targets outside the app dir never parsed (edges degrade to I/U honestly).
- FACT (CLI): `flowprint <repo>` → discovery list (0.1–0.8s); `flowprint <repo> --app <name|path>` → one-app analysis; `flowprint <appDir>` → direct; `--help` implemented (real output captured below).
- FACT (n8n, the 88.4s problem case): discovery **1.5s**; single-app `packages/cli` **24.2s** (4007 files, 31,861 edges) — well under 60s. Parse phase (B1 isolation) is 60% of that; sub-20s would need worker-throughput work, not a correctness fix.

---

## 2. Benchmark deltas

Full 27-repo run on final code: `bench/results/2026-10-06T10-48-00-844Z.json` (583.7s). New v2 taxonomy + legacy-mapped old-style totals:

| | v0.1-alpha baseline | Now (legacy-mapped) | Delta |
|---|---|---|---|
| OK | 195 | 204 | **+9 (supabase B2 fix)** |
| MISSING | 121 | 117 | −4 |
| MISMATCH | 83 | 82 | −1 |
| CONFIDENTLY_WRONG | 1 | 1 | 0 (same adjudicated react canary) |
| Honest-U | 36 | 36 | 0 |

New taxonomy totals: OK=204, HONEST_UNKNOWN=127, UNSUPPORTED_FEATURE=18, FIXTURE_GAP=66, MISMATCH=24, CONFIDENTLY_WRONG=1. Repo statuses: **27 OK, 0 drift, 0 analyzer failures.**
- FACT: per-repo legacy-count diff shows the ONLY changed repo is supabase (the intended B2 improvement). **Zero regressions.**
- FACT: the 1 WRONG is the same deliberately-probed react `ReactSharedInternals` case (value correct, confidence debatable, no general fix without a repo-specific hack — kept as honesty canary per STOP conditions).

---

## 3. Final CLI UX

Real `--help` output (captured from a live run):
```
flowprint — local-first codebase orientation (M0)

Usage:
  flowprint <repo>                  Discovery: list detected apps and
                                    unsupported boundaries for <repo>.
  flowprint <repo> --app <sel>      Analyze one app in detail. <sel> is a
                                    package name, a repo-relative path
                                    (e.g. apps/web), or "." for the root app.
  flowprint <appDir>                Analyze the app at <appDir> directly
                                    (a package dir inside a repo, or a
                                    standalone repo).
  flowprint --help                  Show this help.

Examples:
  flowprint ~/code/myrepo
  flowprint ~/code/myrepo --app apps/web
  flowprint ~/code/myrepo/apps/web

Notes:
  - Discovery is always repo-wide and fast (package.json walk only).
  - Detailed analysis scopes the expensive file walk + parse to ONE app
    dir; cross-package imports resolve through the repo-wide package map,
    and targets outside the app dir are never parsed (edges degrade to
    I/U honestly instead of inventing).
  - Frameworks detected but outside analysis scope appear under
    "Unsupported boundaries" — absence from Routes never means
    absence of routes.
```
Report sections: Repository → Applications → Unsupported boundaries → Entry points → Routes (App Router / Pages Router, every claim `[R]`/`[I]`/`[U]`) → Module resolution → Unknown. Text-only. No explorer, no AI, no accounts.

---

## 4. Tester package

`tester/` (docs only; verified from a clean state by the packaging agent):
- `tester/README.md` — reproducible install/run: unpack tarball (excludes `node_modules` and the 5.7GB `bench/repos` cache), `pnpm install`, `pnpm flowprint --help`; prerequisites (Node 20+, pnpm, git); troubleshooting (pnpm 12 `minimumReleaseAge` quarantine, `approve-builds esbuild`); **the distribution tarball itself is not yet created — one-command packaging step at handoff time.**
- `tester/INSTRUCTIONS.md` — 30-min time-boxed session: pick an unfamiliar public TS/JS repo (don't read its README first), run discovery then `--app`, time the three orientation questions; explicit NOT-to-do list (no public posting, no private code, read Unsupported boundaries before assuming a miss, don't "help" the tool).
- `tester/feedback-template.md` — one-page form: background, target repo+SHA, 3 timing fields (mm:ss), correctness (quote exact lines), section-by-section usefulness, would-use-again yes/no + why.

---

## 5. Recommended user-testing protocol

- **Who:** 5–10 developers not involved in building Flowprint; mix of Next.js and Node-API backgrounds.
- **What:** each picks one unfamiliar public TS/JS repo (aim for a spread: 3–4 Next.js apps incl. one monorepo, 2–3 Express/Fastify/Hono APIs, 1–2 others). 30-min time-boxed session per tester, feedback template returned privately.
- **Pass/fail (proposed; Ledi decides):**
  1. **Correctness gate (hard):** zero tester-reported confidently-wrong claims (an `[R]`-labeled false statement). Any such report is a release-blocking bug, not a data point.
  2. **Usefulness gate:** ≥60% answer "would use again = yes".
  3. **Timing signal:** median time-to-answer each of the three orientation questions under 5 minutes (informative, not blocking — calibrates the 60-second claim against reality).
- **What the results buy:** section-by-section usefulness rankings prioritize v0.1 work; any unsupported-boundary confusion calibrates the B3 wording; the two standing kill conditions (occasional-use gravity, maintainer-scale drift) get their first real-world signal — which is the actual point of the alpha.

---

## 6. Verdict: READY FOR PRIVATE ALPHA

**Reasoning (INFERENCE on FACTS above):** all 4 blockers are fixed with reproduced evidence (B1 SIGSEGV survival, B2 supabase before/after, B3 vendure rendering, B4 n8n 24.2s + real --help). The release gate holds: useful answers on 27 repos (204 OK, honest partial coverage on hostile ones), explicit unsupported boundaries (18 UNSUPPORTED_FEATURE surfaced, zero hallucinations on 17 non-Next.js repos), effectively zero confidently-wrong (1 adjudicated canary, unchanged). Full benchmark shows zero regressions — the sole delta is the intended supabase improvement. `tsc` clean; no STOP condition triggered at any stage; no repo-specific hacks.

**Known residual risks (not blockers):** (a) sub-20s n8n would need parser-worker throughput work; (b) example/test-app noise (67 genuine extra apps) needs a general product-vs-example distinction in v0.1; (c) fixture quality debt on some stage-2/3 fixtures (spot-checked only); (d) the distribution tarball is not yet built; (e) the two validation-era kill conditions remain unanswerable by engineering — the private alpha exists to test exactly those.

**Do not proceed beyond private alpha** (no npm publish, no public release, no explorer/AI/MCP) until tester feedback is in and reviewed.
