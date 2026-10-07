# Flowprint private alpha — tester setup

Flowprint is a **local-first** codebase orientation CLI: it analyzes a
TypeScript/JavaScript repository on your machine and prints a text report
(entry points, routes, module resolution, confidence on every claim).
Nothing is uploaded anywhere; no accounts, no cloud, no AI calls.

**Version:** v0.1-alpha (private alpha), 2026-10-06.
**Status:** unreleased prototype — no npm package, no public repo.

## Prerequisites

- **Node.js 20+** (verified with Node 24.20.0; run `node --version`)
- **pnpm** (verified with pnpm 12.9.1; install: `npm install -g pnpm`)
- **git** — to clone the target repository you will analyze
- Network access for `pnpm install` and for cloning the target repo

## Setup (from a clean state)

These steps were verified verbatim on 2026-10-06 from a fresh copy of the
source tree with no `node_modules` present.

1. Unpack the source tree and enter it:

   ```sh
   tar -xzf flowprint-alpha.tar.gz
   cd flowprint-m0        # the directory containing package.json with the "flowprint" script
   ```

   (The tarball omits `node_modules` and `bench/repos`, a 5.7 GB cache of
   cloned benchmark repos that isn't needed to run the CLI. If you copy
   the working directory by hand instead, delete its `.npmrc` first — it
   contains a machine-specific pnpm store path.)

2. Install dependencies (run once):

   ```sh
   pnpm install
   ```

   On pnpm 12 this step can exit with a policy error even though it
   linked everything — see Troubleshooting for the two known cases and
   their one-line fixes, then re-run `pnpm install`.

3. Confirm the CLI runs:

   ```sh
   pnpm flowprint --help
   ```

   You should see the `flowprint — local-first codebase orientation (M0)`
   help text with Usage and Examples.

## Point it at a target repo

Pick a repository (see INSTRUCTIONS.md for how to choose) and clone it
somewhere, then run discovery:

```sh
git clone --depth 1 https://github.com/<owner>/<repo>.git ~/target-repo
pnpm flowprint ~/target-repo
```

Discovery lists detected apps and any unsupported boundaries, repo-wide and
fast. Then analyze the main app in detail (see INSTRUCTIONS.md):

```sh
pnpm flowprint ~/target-repo --app <sel>
```

where `<sel>` is a package name, a repo-relative path (e.g. `apps/web`),
or `.` for the root app — copied from the discovery output. You can also
point the CLI at an app directory directly:

```sh
pnpm flowprint ~/target-repo/apps/web
```

## Troubleshooting

- **`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`** (pnpm 12, can appear on
  `pnpm install` or on any `pnpm flowprint` run): pnpm's supply-chain
  policy can reject a lockfile entry published within its new-package
  quarantine window. Relax it once — this persists in your pnpm user
  config and only disables the new-package age check, nothing else —
  then re-run:

  ```sh
  pnpm config set minimumReleaseAge 0
  pnpm install
  ```

  (Older pnpm versions don't have this check at all, and the quarantine
  expires on its own ~24 h after the dependency was published.)

- **`ERR_PNPM_IGNORED_BUILDS`** mentioning `esbuild` (pnpm 12):
  pnpm 12 wants explicit approval for dependency build scripts. Approve
  it once (non-interactive; writes `pnpm-workspace.yaml` in this
  directory), then re-run install:

  ```sh
  pnpm approve-builds esbuild
  pnpm install
  ```

  This one is benign either way — esbuild's platform binary arrives via
  optional dependencies, and the CLI runs fine even if you skip this
  and `pnpm install` exits non-zero.

- **`tsx: not found` / script fails before printing anything**: the
  `pnpm install` in step 2 didn't complete. Re-run it and check for errors
  above the failure line.
- **Very large monorepos**: discovery only walks `package.json` files, so it
  stays fast. Detailed analysis parses one app dir; cross-package imports
  are resolved but targets outside the app dir are never parsed (claims
  degrade to `[I]`/`[U]` honestly instead of being invented).

## Layout of this package

- `README.md` — this file: install and run
- `INSTRUCTIONS.md` — what to do with the tool (~30 minutes, time-boxed)
- `feedback-template.md` — the feedback form to fill in and return
