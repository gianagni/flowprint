# Flowprint M0 — Engineering Feasibility Spike

**NOT v0.1. NOT production.** Goal: answer one question — can a real
implementation reproduce the manually verified findings from the validation
study on actual repositories?

- `packages/flowprint/src/` — the prototype analyzer, layered:
  `discovery/` → `parsing/` → `resolution/` → `framework/` → `model/` → `render/`
- `bench/` — benchmark harness, ground-truth fixtures, cloned repos (cached)
- `docs/` — architecture.md, blockers.md, oxc-spike.md (M0 findings)

Run: `pnpm benchmark` (from this directory).
