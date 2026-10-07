<p align="center">
  <img src="./assets/brand/flowprint-logo-dark.svg" alt="Flowprint" width="560">
</p>

<p align="center">
  <strong>A map for codebases you don't know yet.</strong>
</p>

<p align="center">
  Flowprint helps developers find their starting point in unfamiliar JavaScript and TypeScript codebases.
</p>

---

Ever opened someone else's project and wondered:

- Where should I start reading?
- Which app is the main one?
- Where are the routes and APIs?
- Which files matter first?
- Which findings are certain, and which are only inferred?

Flowprint is built to reduce that initial confusion.

Give Flowprint a JavaScript or TypeScript repository, and it analyzes the project structure to help surface:

- detected applications
- recognized frameworks
- useful files to start reading
- routes and route handlers
- Server Actions
- module resolution
- unsupported or uncertain areas

Flowprint is not a framework, code generator, or AI chatbot.

Think of it as a **starting map for an unfamiliar codebase**.

## Status

Flowprint is currently in **private alpha**.

Current version:

```text
0.1.0-alpha.4
```

The strongest support currently covers:

- JavaScript and TypeScript repositories
- Next.js App Router
- monorepo and workspace discovery
- App Router pages
- route handlers
- module resolution
- Server Actions (partial)
- selected tRPC patterns
- proxy and middleware boundaries
- instrumentation hooks

Unsupported or uncertain behavior is reported explicitly instead of being guessed.

## What problem does Flowprint solve?

Large or unfamiliar repositories can be difficult to approach.

You may know the programming language and framework, but still spend time figuring out:

- which application to inspect
- where the main entry points are
- which routes exist
- which files are worth reading first
- how imports resolve across a monorepo
- which parts of the repository Flowprint cannot safely understand

Flowprint is designed to shorten that first orientation phase.

It does not try to fully explain the business logic of an application.

Instead, it gives you a structural map so you can start reading the code with more context.

## Confidence Levels

Flowprint uses three confidence levels:

```text
[R] Resolved
[I] Inferred
[U] Unknown
```

### Resolved

Flowprint has strong structural evidence for the result.

Example:

```text
[R] /api/health [GET]
```

### Inferred

The result is derived from project conventions or structure, but cannot be fully proven statically.

Example:

```text
[I] /opengraph-image
```

### Unknown

Flowprint intentionally refuses to guess when static evidence is not enough.

Example:

```text
[U] env-conditional config
```

The goal is not to make every result look complete.

The goal is to avoid false confidence.

## Quick Start

### Requirements

- Node.js 20+
- pnpm
- Git

Install dependencies:

```bash
pnpm install
```

Check the CLI:

```bash
pnpm flowprint --help
```

Analyze a repository:

```bash
pnpm flowprint /path/to/repository
```

For a monorepo, analyze one detected application:

```bash
pnpm flowprint /path/to/repository --app apps/web
```

For an application located at the repository root:

```bash
pnpm flowprint /path/to/repository --app .
```

## How it works

Flowprint starts with repository discovery.

For example:

```text
flowprint my-repo

Supported applications

apps/dashboard
apps/docs
```

Then you can analyze one application in more detail:

```bash
pnpm flowprint my-repo --app apps/dashboard
```

Flowprint may then show information such as:

```text
## Start here

[R] src/app/layout.tsx
    reason: root App Router layout - wraps every route in the app

[R] src/app/page.tsx
    reason: root page - serves the app's base URL
```

The goal is not to explain the entire codebase automatically.

The goal is simpler:

> **Give developers a reliable place to start.**

## What Flowprint can analyze

Flowprint currently focuses most strongly on Next.js App Router repositories.

Current analysis includes areas such as:

- application discovery
- monorepo workspace discovery
- framework detection
- App Router pages
- route handlers
- HTTP methods on route handlers
- TypeScript path aliases
- workspace packages
- module resolution
- Server Actions
- selected tRPC patterns
- proxy and middleware boundaries
- instrumentation hooks
- unsupported framework boundaries

Coverage depends on the structure of the repository.

## Start Here

The `Start here` section suggests a small number of structurally useful files to inspect first.

Examples may include:

- root App Router layout
- root page
- request proxy or middleware
- instrumentation hooks
- representative route files

These suggestions are based on structural evidence.

Flowprint does not claim that a suggested file is the most important file in the entire application.

It is simply a reasonable place to start reading.

## Routes

Flowprint can identify Next.js App Router routes and route handlers.

Example:

```text
[R] /account
    <- src/app/account/page.tsx

[R] /api/health [GET]
    <- src/app/api/health/route.ts
```

Dynamic routes remain dynamic when concrete values cannot be known statically:

```text
[R] /users/[id]
```

Flowprint does not invent concrete runtime values for dynamic parameters.

## Unsupported Analysis

Some frameworks may be detected without their routes being analyzed.

Examples currently outside Flowprint's route-analysis scope include:

- Hono
- React Router
- Express
- NestJS
- GraphQL / Apollo

If Flowprint does not show routes for one of these frameworks, that does **not** mean those routes do not exist.

It means they were not analyzed.

Flowprint prefers an explicit unsupported boundary over pretending to understand something it does not.

## Monorepos

Flowprint can discover workspace packages and analyze applications individually.

Example:

```text
apps/
  dashboard/
  docs/
  api/

packages/
  ui/
  database/
  shared/
```

You can first inspect the repository:

```bash
pnpm flowprint /path/to/repository
```

Then analyze one application:

```bash
pnpm flowprint /path/to/repository --app apps/dashboard
```

Detailed analysis is scoped to one application at a time.

This keeps analysis focused and avoids unnecessarily parsing an entire large monorepo.

## Security

Do not disable antivirus or endpoint-security software to run Flowprint.

Flowprint is designed as a local static-analysis tool, but it is still pre-release software and has not undergone a formal third-party security audit.

The current private-alpha distribution also includes dependencies that may use native platform components or child processes.

If a security product blocks a file or process:

1. Do not automatically allow it.
2. Record the blocked file or process name.
3. Record the detection message.
4. Record what command was being run.
5. Report the result so it can be investigated.

Read the current security notes here:

[SECURITY.md](./SECURITY.md)

## Release Verification

Private alpha releases include a SHA-256 checksum.

For Flowprint `0.1.0-alpha.4`:

```text
2C6EF18BDD2BA05E067FF0EF6FBB39B811E6FCCE83C39CDE9EA63CF154EC97D5
```

On Windows PowerShell:

```powershell
Get-FileHash ".\flowprint-alpha-0.1.0-alpha.4.tar.gz" -Algorithm SHA256
```

The downloaded artifact should match the published checksum exactly.

## Development

Install dependencies:

```bash
pnpm install
```

Run type checking:

```bash
pnpm typecheck
```

Run regression tests:

```bash
pnpm test
```

Run the benchmark harness:

```bash
pnpm benchmark
```

Benchmark tooling and fixtures live under:

```text
bench/
```

Generated benchmark results are intentionally excluded from version control.

## Project Structure

The analyzer is currently organized into several layers:

```text
packages/flowprint/src/

discovery/
parsing/
resolution/
framework/
model/
render/
```

At a high level:

```text
repository
    |
    v
discovery
    |
    v
parsing
    |
    v
resolution
    |
    v
framework analysis
    |
    v
analysis model
    |
    v
terminal output
```

## Current Priorities

Flowprint is being tested against real-world repositories before a wider public release.

The current priorities are:

- correctness
- honest uncertainty
- useful codebase orientation
- minimal false confidence
- predictable local behavior
- practical developer experience

The main question Flowprint is trying to answer is:

> **"I just opened this codebase. Where do I start?"**

## Project Status

Flowprint is experimental software.

The current alpha should not be treated as production-ready or enterprise-certified.

The project is still validating:

- installation experience
- security behavior
- runtime dependencies
- framework coverage
- false-positive rates
- usefulness to developers who did not build Flowprint

## License

Flowprint is licensed under the [MIT License](./LICENSE).
