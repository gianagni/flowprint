/**
 * Flowprint M0 — discovery layer.
 *
 * Filesystem + workspace discovery. No parsing, no framework logic.
 * Output: package.json locations, workspace name→dir map, Next.js app candidates.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { dirErrorCode, safeRelPath, type DirReadFailure } from '../model/types.js';

/** Directories never descended into during discovery. */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.vercel',
  'out',
]);

export interface PackageJsonInfo {
  /** Repo-relative directory containing the package.json. '' for repo root. */
  dir: string;
  absDir: string;
  name: string | null;
  raw: Record<string, unknown>;
}

export interface WorkspaceInfo {
  /** Repo-relative dirs that matched a workspace pattern but have no package.json. */
  ghostDirs: string[];
  /** Workspace glob patterns as declared. */
  patterns: string[];
}

export interface AppCandidate {
  /** Repo-relative app directory. */
  dir: string;
  absDir: string;
  pkg: PackageJsonInfo | null;
  /** `next` found in dependencies/devDependencies/peerDependencies (raw range). */
  nextRange: string | null;
  /** app/ or src/app dir exists with layout/page convention files. */
  hasAppConventions: boolean;
  /** Repo-relative app-router root (app/ or src/app), or null. */
  appDir: string | null;
  /** pages/ or src/pages dir exists. */
  hasPagesDir: boolean;
}

export interface DiscoveryResult {
  repoRoot: string;
  packages: PackageJsonInfo[];
  /** workspace package name → repo-relative dir */
  nameToDir: Map<string, string>;
  workspaces: WorkspaceInfo;
  appCandidates: AppCandidate[];
  /** Packages that look like runnable apps on unsupported frameworks (DOGFOOD-03). */
  unsupportedAppCandidates: UnsupportedAppCandidate[];
  /** Directories that could not be read during discovery (TR-006). */
  dirReadFailures: DirReadFailure[];
}

/**
 * A workspace package that is NOT a supported (Next.js) app candidate but
 * shows strong structural evidence of being a runnable application on a
 * framework Flowprint does not analyze routes for. Evidence bar is
 * deliberately high (runtime framework dependency + start script) — a
 * library with dev/build scripts must never land here.
 */
export interface UnsupportedAppCandidate {
  /** Repo-relative package dir. */
  dir: string;
  /** Package name, if declared. */
  name: string | null;
  /** Display names of the unsupported frameworks detected, e.g. ['Hono']. */
  frameworks: string[];
  /** Short deterministic evidence string. */
  evidence: string;
}

/**
 * Runtime dependency name → framework display name, for frameworks whose
 * HTTP routes Flowprint does not analyze. Kept next to discovery (not in
 * boundaries/) because this answers "is this package an app?", not
 * "which framework areas are unsupported?".
 */
const UNSUPPORTED_APP_FRAMEWORKS: Array<{ dep: string; name: string }> = [
  { dep: 'hono', name: 'Hono' },
  { dep: 'express', name: 'Express' },
  { dep: 'fastify', name: 'Fastify' },
  { dep: 'elysia', name: 'Elysia' },
  { dep: '@nestjs/core', name: 'NestJS' },
  { dep: '@apollo/server', name: 'Apollo Server' },
  { dep: 'graphql', name: 'GraphQL' },
  { dep: 'vue', name: 'Vue' },
  { dep: 'react-router', name: 'React Router' },
  { dep: '@react-router/node', name: 'React Router' },
  { dep: '@react-router/serve', name: 'React Router' },
];

/**
 * Framework display names checked for unsupported-app candidates
 * (runtime dependency + start script evidence). Exported (AC-048) so the
 * detection scope can be stated truthfully in output.
 */
export const CHECKED_UNSUPPORTED_APP_FRAMEWORKS: readonly string[] = [
  ...new Set(UNSUPPORTED_APP_FRAMEWORKS.map((f) => f.name)),
];

/** Runtime (non-dev) dependency names of a package. */
function runtimeDepNames(pkg: PackageJsonInfo): Set<string> {
  const raw = pkg.raw['dependencies'];
  if (raw == null || typeof raw !== 'object') return new Set();
  return new Set(Object.keys(raw as Record<string, unknown>));
}

function toRel(repoRoot: string, abs: string): string {
  return relative(repoRoot, abs).split(sep).join('/');
}

async function walkPackageJsons(
  repoRoot: string,
  dir: string,
  out: string[],
  dirReadFailures: DirReadFailure[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // TR-006: record unreadable directories instead of silently skipping.
    const code = dirErrorCode(err);
    if (code) {
      dirReadFailures.push({
        path: safeRelPath(repoRoot, dir),
        error: code,
        phase: 'discovery',
      });
    }
    return;
  }
  for (const e of entries) {
    if (e.name === 'package.json' && e.isFile()) {
      out.push(join(dir, 'package.json'));
      continue;
    }
    if (!e.isDirectory() || e.name.startsWith('.') && e.name !== '.well-known') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    // Route-group-style dirs like (ai) are fine; skip nothing else by name.
    await walkPackageJsons(repoRoot, join(dir, e.name), out, dirReadFailures);
  }
}

function readJsonLoose(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readPnpmWorkspacePatterns(repoRoot: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    return [];
  }
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = /^\s*-\s*['"]?([^'"]+)['"]?\s*$/.exec(line);
      if (m) patterns.push(m[1]);
      else if (/^\S/.test(line) && line.trim() !== '') inPackages = false;
    }
  }
  return patterns;
}

function getNextRange(pkg: Record<string, unknown> | null): string | null {
  if (!pkg) return null;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (deps && typeof deps['next'] === 'string') return deps['next'];
  }
  return null;
}

// (route-convention filenames are matched by CONVENTION_RE below)

async function dirExists(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

export async function discoverRepo(repoRoot: string): Promise<DiscoveryResult> {
  const dirReadFailures: DirReadFailure[] = [];
  const pkgPaths: string[] = [];
  await walkPackageJsons(repoRoot, repoRoot, pkgPaths, dirReadFailures);

  const packages: PackageJsonInfo[] = [];
  for (const p of pkgPaths.sort()) {
    const text = await readFile(p, 'utf8').catch(() => null);
    if (text == null) continue;
    const raw = readJsonLoose(text);
    if (!raw) continue;
    const absDir = join(p, '..');
    const dir = toRel(repoRoot, absDir);
    const name = typeof raw['name'] === 'string' ? (raw['name'] as string) : null;
    packages.push({ dir, absDir, name, raw });
  }

  const nameToDir = new Map<string, string>();
  for (const pkg of packages) {
    if (pkg.name && !nameToDir.has(pkg.name)) nameToDir.set(pkg.name, pkg.dir);
  }

  // Workspace patterns: package.json#workspaces + pnpm-workspace.yaml.
  const patterns: string[] = [];
  const rootPkg = packages.find((p) => p.dir === '');
  if (rootPkg) {
    const ws = rootPkg.raw['workspaces'] as unknown;
    if (Array.isArray(ws)) patterns.push(...ws.filter((x): x is string => typeof x === 'string'));
    else if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)) {
      patterns.push(
        ...((ws as { packages: unknown[] }).packages.filter((x): x is string => typeof x === 'string')),
      );
    }
  }
  patterns.push(...(await readPnpmWorkspacePatterns(repoRoot)));

  const ghostDirs: string[] = [];
  for (const pat of patterns) {
    // Only exact (non-glob) patterns can be "ghosts": an explicitly declared
    // workspace dir with no package.json (e.g. dub's apps/web/.react-email,
    // which has zero tracked files on a fresh clone). Glob patterns
    // (`apps/*`, `packages/**/*`) legitimately match dirs that are simply
    // not workspaces — those are skipped silently.
    if (pat.includes('*')) continue;
    const rel = pat.replace(/\/$/, '');
    const hasPkg = packages.some((p) => p.dir === rel);
    if (!hasPkg && !ghostDirs.includes(rel)) ghostDirs.push(rel);
  }

  // App candidates: app/ page/layout conventions, route-handler-only Next.js
  // apps (DOGFOOD-04), pages/ dirs, OR `next` in deps.
  const appCandidates: AppCandidate[] = [];
  for (const pkg of packages) {
    const appAbs = join(repoRoot, pkg.dir);
    const nextRange = getNextRange(pkg.raw);
    let appDirRel: string | null = null;
    let hasConventions = false;
    for (const sub of ['app', 'src/app']) {
      const candAbs = join(appAbs, sub);
      if (await hasConventionFileDeep(repoRoot, candAbs, PAGE_LAYOUT_RE, dirReadFailures)) {
        hasConventions = true;
        appDirRel = pkg.dir ? `${pkg.dir}/${sub}` : sub;
        break;
      }
    }
    // DOGFOOD-04 fallback: a route-handler-only App Router app (app/**/route.ts,
    // no page/layout) is still an app — but only when the package declares
    // `next`: a bare app/**/route.js in a non-Next package (e.g. Ember's
    // app/utils/route.js) is not Next.js evidence.
    if (!hasConventions && nextRange) {
      for (const sub of ['app', 'src/app']) {
        const candAbs = join(appAbs, sub);
        if (await hasConventionFileDeep(repoRoot, candAbs, ROUTE_HANDLER_RE, dirReadFailures)) {
          hasConventions = true;
          appDirRel = pkg.dir ? `${pkg.dir}/${sub}` : sub;
          break;
        }
      }
    }
    const hasPagesDir = (await dirExists(join(appAbs, 'pages'))) ||
      (await dirExists(join(appAbs, 'src', 'pages')));
    if (hasConventions || nextRange) {
      appCandidates.push({
        dir: pkg.dir,
        absDir: pkg.absDir,
        pkg,
        nextRange,
        hasAppConventions: hasConventions,
        appDir: appDirRel,
        hasPagesDir,
      });
    }
  }

  // DOGFOOD-03: unsupported application candidates. A package that is not a
  // supported app candidate but carries BOTH a runtime dependency on an
  // unsupported app framework AND a start script is reported as a candidate —
  // honestly labeled, never analyzed. The bar is deliberately high: dev-only
  // framework deps (test servers) and libraries with dev/build scripts stay out.
  const supportedDirs = new Set(
    appCandidates.filter((c) => c.hasAppConventions || c.hasPagesDir).map((c) => c.dir),
  );
  const unsupportedAppCandidates: UnsupportedAppCandidate[] = [];
  for (const pkg of packages) {
    if (supportedDirs.has(pkg.dir)) continue;
    const deps = runtimeDepNames(pkg);
    const matched = UNSUPPORTED_APP_FRAMEWORKS.filter((f) => deps.has(f.dep));
    if (matched.length === 0) continue;
    const scripts = pkg.raw['scripts'];
    const start =
      scripts != null && typeof scripts === 'object'
        ? (scripts as Record<string, unknown>)['start']
        : undefined;
    if (typeof start !== 'string' || start.length === 0) continue;
    const frameworks = [...new Set(matched.map((f) => f.name))];
    unsupportedAppCandidates.push({
      dir: pkg.dir,
      name: pkg.name,
      frameworks,
      evidence: `start script + ${matched.map((f) => f.dep).join(', ')} in dependencies`,
    });
  }

  return {
    repoRoot,
    packages,
    nameToDir,
    workspaces: { ghostDirs, patterns },
    appCandidates,
    unsupportedAppCandidates,
    dirReadFailures,
  };
}

const PAGE_LAYOUT_RE = /^(layout|page)\.(tsx|ts|jsx|js)$/;
/** Next.js route-handler convention — kept in sync with framework/routes.ts ROUTE_RE. */
const ROUTE_HANDLER_RE = /^route\.(ts|js)$/;

/** Bounded deep search for a convention file (max depth 4, skips noise). */
async function hasConventionFileDeep(
  repoRoot: string,
  absDir: string,
  re: RegExp,
  dirReadFailures: DirReadFailure[],
  depth = 0,
): Promise<boolean> {
  if (depth > 4) return false;
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (err) {
    // TR-006: record genuinely unreadable dirs; plain absence (ENOENT)
    // is routine for probes like "does app/ exist?" and stays silent.
    const code = dirErrorCode(err);
    if (code) {
      dirReadFailures.push({
        path: safeRelPath(repoRoot, absDir),
        error: code,
        phase: 'discovery',
      });
    }
    return false;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.isFile() && re.test(e.name)) return true;
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    if (await hasConventionFileDeep(repoRoot, join(absDir, e.name), re, dirReadFailures, depth + 1)) return true;
  }
  return false;
}
