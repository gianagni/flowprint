# Security

Flowprint is currently in private alpha.

This document explains the current security expectations for running Flowprint and using it to inspect a repository.

> Flowprint is experimental software and has not undergone a formal third-party security audit.

## Security model

Flowprint is designed as a local codebase-orientation and static-analysis tool.

You give Flowprint a repository path, and it reads the project structure to identify things such as:

- applications and workspace packages
- framework conventions
- routes and route handlers
- TypeScript configuration and path aliases
- module imports and exports
- selected Server Action and tRPC patterns
- middleware, proxy, and instrumentation boundaries
- unsupported or uncertain areas

Flowprint is intentionally conservative when it cannot prove something from static evidence.

Its output uses three confidence levels:

```text
[R] Resolved
[I] Inferred
[U] Unknown
```

Security-sensitive behavior should follow the same principle: if something cannot be safely established, Flowprint should not pretend otherwise.

## What Flowprint reads

Flowprint may read files inside the repository you explicitly ask it to analyze.

Depending on the project, this can include:

- `.js`, `.jsx`, `.ts`, and `.tsx` source files
- `package.json`
- `tsconfig.json` and related TypeScript configuration
- workspace configuration
- framework configuration
- route files and framework conventions
- package metadata required for module resolution

Flowprint may also inspect repository-wide package metadata when analyzing one application inside a monorepo.

## Does Flowprint run the target project?

Flowprint is designed to analyze source code without starting the target application.

It should not need to run commands such as:

```text
npm run dev
pnpm dev
next dev
next build
```

inside the repository being analyzed.

It is also not intended to import and execute arbitrary application modules from the target repository just to discover their behavior.

However, Flowprint is still pre-release software and this behavior has not yet been independently audited.

If you find a case where Flowprint executes application code from the repository being analyzed, treat it as a security issue and report it.

## Parser isolation and child processes

Flowprint uses isolated parsing so that a parser crash does not necessarily terminate the parent Flowprint process.

This means Flowprint may create child processes as part of its own analysis pipeline.

A child process created by Flowprint is not, by itself, evidence that the target repository is being executed.

The purpose of this isolation is to contain parser failures and allow Flowprint to report an affected file as unknown instead of crashing the entire analysis.

## Network access

Flowprint does not require:

- a Flowprint account
- an API key
- an AI service
- a hosted Flowprint backend

to analyze a repository.

Installing dependencies with `pnpm install` can access the configured package registry.

The current alpha has not undergone a formal network-behavior audit, so users with strict security requirements should inspect the source and monitor network activity before trusting it in sensitive environments.

If Flowprint itself makes an unexpected outbound connection during analysis, please report it.

## Source code and uploads

Flowprint is designed to work locally on the repository path you provide.

There is currently no Flowprint cloud service that requires uploading the analyzed repository.

Because the project is still in alpha and has not undergone an independent security audit, avoid treating this statement as a formal security certification.

For sensitive repositories, review the source before use.

## Native dependencies

Flowprint currently depends on tooling that may include platform-native components.

The current alpha uses:

- `oxc-parser`
- `tsx` for running the TypeScript CLI during development/private-alpha distribution
- transitive tooling such as `esbuild`

Some of these packages can install or execute platform-specific binaries.

This can cause antivirus or endpoint-security software to display warnings, especially for a young project with little reputation data.

A warning should not automatically be treated as a false positive.

## Antivirus and endpoint protection

Do **not** disable antivirus, Windows Defender, endpoint protection, or other security controls just to run Flowprint.

If a security product blocks something:

1. Do not automatically allow or whitelist it.
2. Record the exact file or process name.
3. Record the full detection message.
4. Record the security product and version if available.
5. Record what Flowprint command was being run.
6. Report the result so the dependency or behavior can be investigated.

Useful details include:

```text
Blocked file:
C:\...\esbuild.exe

Security product:
...

Detection:
...

Command:
pnpm flowprint C:\Projects\example
```

This is much more useful than simply reporting that "the antivirus blocked Flowprint."

## Installing dependencies

The current private alpha is distributed as source plus its package metadata.

A typical installation currently includes:

```bash
pnpm install
```

This can run package installation scripts for approved dependencies.

For `0.1.0-alpha.4`, the project configuration explicitly allows the required `esbuild` install step.

Do not manually approve additional unexpected build scripts without first understanding which dependency requested them.

## Release verification

Private alpha artifacts are published with a SHA-256 checksum.

For Flowprint `0.1.0-alpha.4`, the verified artifact is:

```text
flowprint-alpha-0.1.0-alpha.4.tar.gz
```

Expected SHA-256:

```text
2C6EF18BDD2BA05E067FF0EF6FBB39B811E6FCCE83C39CDE9EA63CF154EC97D5
```

On Windows PowerShell:

```powershell
Get-FileHash ".\flowprint-alpha-0.1.0-alpha.4.tar.gz" -Algorithm SHA256
```

The hash must match exactly.

If it does not match, do not treat the file as the verified Flowprint alpha.4 artifact.

## Release provenance

The first Git snapshot of the public-source repository was created from the verified `0.1.0-alpha.4` source snapshot.

Generated benchmark result files are intentionally excluded from version control.

Release artifacts and source history should remain separate concerns:

- Git tracks the source and development history.
- Release artifacts are distributed with their own version and checksum.
- A checksum verifies the exact downloaded artifact.

## Sensitive repositories

Before using Flowprint on confidential or regulated source code:

- review the Flowprint source
- review its dependencies
- verify the release checksum
- monitor network behavior if required by your environment
- follow your organization's internal security policies

Private alpha status means Flowprint should not yet be treated as an enterprise-approved security product.

## Permissions

Only analyze repositories and systems that you are authorized to access.

Flowprint is intended for legitimate codebase inspection and developer orientation.

## Reporting a security issue

Flowprint does not yet have a dedicated public security-reporting channel.

During private alpha, report security-sensitive findings directly to the maintainer through the same private channel used to receive the test build.

Do not publish sensitive vulnerability details in a public issue.

Before wider public release, Flowprint should provide a dedicated private reporting path.

For non-sensitive problems such as:

- installation failures
- antivirus warnings
- unexpected processes
- unexpected network activity
- misleading security documentation

a normal issue may be appropriate once the public issue tracker is available.

## Supported security status

| Version | Status |
| --- | --- |
| `0.1.0-alpha.4` | Private alpha |
| Earlier alpha builds | Not recommended for testing |

## Known limitations

Current security limitations include:

- no formal third-party security audit
- no dedicated private vulnerability-reporting channel yet
- private-alpha distribution still runs the TypeScript CLI through development tooling
- native dependencies may trigger security-product warnings
- runtime and dependency network behavior has not yet been formally audited

These limitations should be reduced before a wider public release.

## Before wider public release

The project should verify and document at least:

- whether the release can run from prebuilt JavaScript instead of `tsx`
- which native binaries remain in the production dependency graph
- whether `esbuild` can be removed from the end-user runtime path
- whether analysis performs any outbound network requests
- that target repository application code is not intentionally executed
- a private vulnerability-reporting process
- reproducible release/checksum documentation

## Bottom line

Flowprint is designed to help developers understand unfamiliar codebases while keeping analysis local and uncertainty explicit.

But it is still alpha software.

Do not bypass security warnings blindly.

Review the source, verify the release checksum, keep security controls enabled, and report unexpected behavior.
