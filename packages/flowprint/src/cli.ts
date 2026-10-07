#!/usr/bin/env tsx
/**
 * Flowprint M0 — CLI (B4: per-app analysis first-class).
 *
 *   flowprint <repo>                  Discovery only: list detected apps and
 *                                     unsupported boundaries + hint to --app.
 *   flowprint <repo> --app <sel>      Detailed analysis of one app (<sel> is a
 *                                     package name, repo-relative path, or '.'
 *                                     for the root app).
 *   flowprint <appDir>                Analyze the app at <appDir> directly.
 *   flowprint --help                  Show help.
 *
 * Discovery is always repo-wide and fast (package.json walk, no parsing).
 * Detailed analysis scopes the expensive walk + parse to one app dir;
 * cross-package imports resolve via the repo-wide package map.
 */
import { resolve, basename } from 'node:path';
import { stat } from 'node:fs/promises';
import { analyzeRepository, analyzeApp, findRepoRoot } from './index.js';
import { discoverRepo, type DiscoveryResult } from './discovery/index.js';
import { detectBoundaries } from './boundaries/detect.js';
import { renderReport } from './render/index.js';
import { renderBoundaries } from './render/boundaries.js';
import { FLOWPRINT_VERSION } from './version.js';

const HELP = `flowprint ${FLOWPRINT_VERSION} — local-first codebase orientation

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
    absence of routes.`;

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
    lines.push('  (none detected — no Next.js router conventions found)');
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
  lines.push(`  flowprint ${repoRoot} --app <name|path>   analyze one app in detail`);
  lines.push(`  flowprint <appDir>                       analyze an app dir directly`);
  lines.push(bar);
  console.log(lines.join('\n'));
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw.includes('--help') || raw.includes('-h')) {
    console.log(HELP);
    process.exit(raw.length === 0 ? 2 : 0);
  }

  let appSel: string | null = null;
  let target: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--app') {
      appSel = raw[++i] ?? null;
      if (!appSel) fail('--app needs a value (package name, path, or ".")');
    } else if (a.startsWith('-')) {
      fail(`unknown flag "${a}"`);
    } else if (target == null) {
      target = a;
    } else {
      fail(`unexpected argument "${a}"`);
    }
  }
  if (!target) fail('missing <repo> or <appDir> path');

  const abs = resolve(target);
  if (!(await isDir(abs))) fail(`not a directory: ${target}`);

  const t0 = Date.now();

  if (appSel) {
    // flowprint <repo> --app <sel>
    const discovery = await discoverRepo(abs);
    const dir = resolveAppSelection(discovery, appSel);
    const result = await analyzeRepository(abs, { appDirs: [dir] });
    result.durationMs = Date.now() - t0;
    console.log(renderReport(result));
    return;
  }

  // flowprint <appDir>: path points at a package dir inside a repo
  // (repo root derived by walking up to the workspace marker).
  const root = await findRepoRoot(abs);
  if (root !== abs && (await hasPackageJson(abs))) {
    const result = await analyzeApp(abs, {});
    result.durationMs = Date.now() - t0;
    console.log(renderReport(result));
    return;
  }

  // flowprint <repo>: discovery only.
  const discovery = await discoverRepo(abs);
  printDiscovery(abs, discovery, Date.now() - t0);
}

main().catch((err) => {
  console.error('flowprint failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
