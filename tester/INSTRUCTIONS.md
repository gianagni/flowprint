# Flowprint private alpha — tester instructions

Time-box the whole session to **~30 minutes**. There is no wrong answer;
we are testing whether the tool orients a developer in an unfamiliar
codebase, not whether you can figure the codebase out yourself.

## 1. Pick a target repository (5 min)

Pick a **TypeScript/JavaScript repository you have never worked in**.
It should be a real, runnable project — not a tutorial stub. Good choices:

- a **Next.js app** on GitHub (e.g. a starter or a small open-source app),
  or
- an **Express / Fastify / Hono API** on GitHub.

Clone it with `--depth 1`. Do not read its README or docs first — the point
is to see how far Flowprint gets you on its own.

## 2. Run discovery, then analyze the main app (10 min)

```sh
pnpm flowprint <repo>               # discovery: apps + unsupported boundaries
pnpm flowprint <repo> --app <sel>   # detailed analysis of the main app
```

(`<sel>` comes from the discovery output — a package name, a repo-relative
path like `apps/web`, or `.` for the root app.)

As you read the report, keep a clock running and note the time (minutes:seconds)
when you can honestly answer each of these:

1. **"Where does this app start?"** — entry point(s) identified.
2. **"What are the important routes?"** — the URL surface you would care
   about first.
3. **"What are the important modules/files?"** — where the real logic lives.

Note what the report gets wrong or confuses you about along the way — quote
the exact lines in the feedback form.

## 3. Fill in the feedback form (10 min)

Complete `feedback-template.md` and return it to whoever sent you this
package (do not post it anywhere public).

## What NOT to do

- **Do not publish results, screenshots, or the tool itself publicly.**
  No tweets, blog posts, public issues, or PRs — yet.
- **Do not test on private or proprietary code** you cannot share
  observations about. We need feedback we can act on and discuss.
- **Do not expect frameworks beyond what the tool names.** Anything detected
  but outside analysis scope is listed under **"Unsupported boundaries"** —
  read that section before assuming the tool missed something. Absence from
  Routes never means absence of routes.
- **Do not try to "help" the tool** by reading the target repo's docs first,
  installing its dependencies, or running it. Judge the report on its own.
