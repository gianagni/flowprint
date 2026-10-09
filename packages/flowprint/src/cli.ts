#!/usr/bin/env tsx
/**
 * Flowprint S4 — CLI: orientation-first experience.
 *
 *   flowprint [path]                 Analyze <path> (default: cwd).
 *                                    - exactly one supported app → analyzed directly
 *                                    - several supported apps → discovery listing (no guessing)
 *                                    - none → honest notice, exit 0
 *   flowprint [path] --app <sel>      Analyze one app in detail (<sel> is a
 *                                    package name, repo-relative path, or '.').
 *   flowprint [path] --full           Complete analysis report (no truncation).
 *   flowprint --version               Print version.
 *   flowprint --help                  Show help.
 *
 * Exit codes: 0 success (including explicit no-supported-app finding),
 * 1 analysis/runtime failure, 2 invalid invocation.
 */
import { resolve, basename } from 'node:path';
import { stat } from 'node:fs/promises';
import { analyzeRepository, analyzeApp, findRepoRoot } from './index.js';
import {
  discoverRepo,
  CHECKED_UNSUPPORTED_APP_FRAMEWORKS,
  type DiscoveryResult,
} from './discovery/index.js';
import { detectBoundaries, frameworkScopeLines } from './boundaries/detect.js';
import { renderReport, renderFullReport } from './render/index.js';
import { renderBoundaries } from './render/boundaries.js';
import { FLOWPRINT_VERSION } from './version.js';

const HELP = `flowprint ${FLOWPRINT_VERSION} — local-first codebase orientation

Usage:
  flowprint [path]                 Analyze <path> (default: current directory).
                                   Exactly one supported app → analyzed directly.
                                   Several supported apps → discovery listing;
                                   pick one with --app (no app is guessed).
                                   No supported app → honest notice, exit 0.
  flowprint [path] --app <sel>     Analyze one app in detail. <sel> is a
                                   package name, a repo-relative path
                                   (e.g. apps/web), or "." for the root app.
  flowprint [path] --full          Complete analysis report: every modeled
                                   item, no truncation.
  flowprint --version              Print version.
  flowprint --help                 Show this help.

Examples:
  flowprint
  flowprint ~/code/myrepo --app apps/web
  flowprint ~/code/myrepo --full

Notes:
  - Detailed analysis scopes the expensive file walk + parse to ONE app
    dir; cross-package imports resolve through the repo-wide package map.
  - "No supported app" never means "no application exists": only a finite
    list of framework checks is performed (see the notice).
  - Hints refer to flags (e.g. "Re-run with --full"); npx does not install
    the CLI into your PATH.`;

function fail(msg: string): never {
  console.error(`flowprint: ${msg}`);
  console.error('Run `flowprint --help` for usage.');
  process.exit(2);
}

async function isDir(abs: string): Promise<boolean> {
  const st = await stat(abs).catch(() => null);
  return !!st && st.isDirectory();
}

async function hasPackageJson(abs: string): Promise<boolean> {
  const st = await stat(`${abs}/package.json`).catch(() => null);
  return !!st && st.isFile();
}

/**
 * Resolve a --app selector to a repo-relative app dir. General matching
 * order: package name → repo-relative dir (any package or app candidate) →
 * "." / "(root)" for the repo root → basename fallback. Ambiguous or empty
 * matches are errors that list the options.
 */
function resolveAppSelection(discovery: DiscoveryResult, sel: string): string {
  const norm = sel.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const cands = discovery.appCandidates.filter((c) => c.hasAppConventions || c.hasPagesDir);

  if (norm === '' || norm === '.' || norm === '(root)') {
    if (cands.some((c) => c.dir === '')) return '';
    // No root app candidate: fall back to the repo root itself as the scope.
    return '';
  }

  const byName = discovery.packages.filter((p) => p.name === norm);
  if (byName.length === 1) return byName[0].dir;
  if (byName.length > 1) {
    fail(`--app "${sel}" matches ${byName.length} packages by name; use a repo-relative path instead`);
  }

  const knownDirs = new Set<string>([
    ...discovery.packages.map((p) => p.dir),
    ...discovery.appCandidates.map((c) => c.dir),
  ]);
  if (knownDirs.has(norm)) return norm;

  const baseMatches = [...knownDirs].filter((d) => d !== '' && basename(d) === norm);
  if (baseMatches.length === 1) return baseMatches[0];
  if (baseMatches.length > 1) {
    fail(`--app "${sel}" is ambiguous; candidates:\n  ${baseMatches.join('\n  ')}`);
  }

  const options = [
    ...cands.map((c) => `  ${c.pkg?.name ?? '(unnamed)'}  @ ${c.dir || '(root)'}`),
    ...[...knownDirs]
      .filter((d) => !cands.some((c) => c.dir === d))
      .map((d) => `  (package dir)  @ ${d || '(root)'}`),
  ].join('\n');
  fail(`--app "${sel}" matched no app or package dir. Options:\n${options}`);
}

function printDiscovery(repoRoot: string, discovery: DiscoveryResult, ms: number): void {
  const lines: string[] = [];
  const bar = '='.repeat(60);
  lines.push(bar);
  lines.push(`Flowprint ${FLOWPRINT_VERSION} — ${basename(repoRoot)}  (discovery, ${(ms / 1000).toFixed(1)}s)`);
  lines.push(bar);
  lines.push('');
  lines.push(`  packages: ${discovery.packages.length}`);
  if (discovery.workspaces.patterns.length > 0) {
    lines.push(`  workspace patterns: ${discovery.workspaces.patterns.join(', ')}`);
  }
  lines.push('');
  lines.push('## Supported applications');
  const cands = discovery.appCandidates.filter((c) => c.hasAppConventions || c.hasPagesDir);
  if (cands.length === 0) {
    // TR-005/AC-048: a quiet "none detected" must never read as "this repo
    // has no applications" — state the finite detection scope explicitly.
    lines.push('  (none detected — no Next.js router conventions found)');
    lines.push('  No app was analyzed.');
    lines.push(...frameworkScopeLines(CHECKED_UNSUPPORTED_APP_FRAMEWORKS));
  }
  for (const c of [...cands].sort((a, b) => (a.dir < b.dir ? -1 : 1))) {
    lines.push(`  ${c.dir || '(root)'}${c.pkg?.name ? `   name=${c.pkg.name}` : ''}`);
    lines.push(`    next: ${c.nextRange ?? '(no next dependency)'}`);
    lines.push(`    app-router: ${c.hasAppConventions ? `yes (${c.appDir})` : 'no'}`);
    lines.push(`    pages-router: ${c.hasPagesDir ? 'yes' : 'no'}`);
  }
  lines.push('');
  // DOGFOOD-03: unsupported application candidates are real apps Flowprint
  // cannot analyze routes for — they must not silently vanish from discovery.
  const ucands = [...discovery.unsupportedAppCandidates].sort((a, b) => (a.dir < b.dir ? -1 : 1));
  if (ucands.length > 0) {
    lines.push('## Unsupported application candidates');
    for (const c of ucands) {
      lines.push(`  ${c.dir || '(root)'}${c.name ? `   name=${c.name}` : ''}`);
      lines.push(`    frameworks: ${c.frameworks.join(' / ')}`);
      lines.push(`    evidence: ${c.evidence}`);
      lines.push('    route analysis: unsupported');
    }
    lines.push('');
  }
  const bsec = renderBoundaries(detectBoundaries({ repoRoot, discovery }));
  if (bsec) lines.push(bsec);
  lines.push('hint:');
  if (cands.length > 1) {
    lines.push('  Several supported apps were found — no app was guessed.');
    lines.push(`  flowprint ${repoRoot} --app <name|path>   analyze one app in detail`);
  } else {
    lines.push(`  flowprint ${repoRoot} --app <name|path>   analyze one app in detail`);
  }
  lines.push(`  flowprint <appDir>                       analyze an app dir directly`);
  lines.push(bar);
  console.log(lines.join('\n'));
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  if (raw.includes('--help') || raw.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  if (raw.includes('--version') || raw.includes('-v')) {
    // S6 DEPENDENCY: version.ts reads ../../../package.json, which breaks
    // under the built dist/ layout (S1 proved: shows 0.0.0). The final
    // build-time version mechanism is S6 work — do not hardcode here.
    console.log(`flowprint ${FLOWPRINT_VERSION}`);
    process.exit(0);
  }

  let appSel: string | null = null;
  let full = false;
  let target: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--app') {
      appSel = raw[++i] ?? null;
      if (!appSel) fail('--app needs a value (package name, path, or ".")');
    } else if (a === '--full') {
      full = true;
    } else if (a.startsWith('-')) {
      fail(`unknown flag "${a}"`);
    } else if (target == null) {
      target = a;
    } else {
      fail(`unexpected argument "${a}"`);
    }
  }
  // Path is optional: default to the current working directory.
  if (!target) target = process.cwd();

  const abs = resolve(target);
  if (!(await isDir(abs))) fail(`not a directory: ${target}`);

  const t0 = Date.now();

  if (appSel) {
    // flowprint [path] --app <sel>
    const discovery = await discoverRepo(abs);
    const dir = resolveAppSelection(discovery, appSel);
    const result = await analyzeRepository(abs, { appDirs: [dir] });
    result.durationMs = Date.now() - t0;
    console.log(full ? renderFullReport(result) : renderReport(result));
    return;
  }

  // flowprint [path]: path points at a package dir inside a repo
  // (repo root derived by walking up to the workspace marker).
  const root = await findRepoRoot(abs);
  if (root !== abs && (await hasPackageJson(abs))) {
    const result = await analyzeApp(abs, {});
    result.durationMs = Date.now() - t0;
    console.log(full ? renderFullReport(result) : renderReport(result));
    return;
  }

  // flowprint [path]: repo root (or cwd default). Discover first.
  const discovery = await discoverRepo(abs);
  const supported = discovery.appCandidates.filter((c) => c.hasAppConventions || c.hasPagesDir);
  if (supported.length === 1) {
    // Exactly one supported app: analyze it directly.
    const result = await analyzeRepository(abs, { appDirs: [supported[0].dir] });
    result.durationMs = Date.now() - t0;
    console.log(full ? renderFullReport(result) : renderReport(result));
    return;
  }
  // Zero or several: discovery listing, no guessing. Exit 0 — discovery
  // itself succeeded; "no app analyzed" is an explicit honest finding.
  printDiscovery(abs, discovery, Date.now() - t0);
}

main().catch((err) => {
  console.error('flowprint failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
