/**
 * Flowprint M0 — tsconfig loading for the resolution layer.
 *
 * JSONC-tolerant loader (comments, trailing commas), `extends` chains
 * (relative, bare workspace specifiers, arrays), child-wins merging.
 * No framework logic here.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, dirname, resolve as resolvePath, relative, sep } from 'node:path';

/** Strip // and block comments, respecting string literals. */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inStr: string | null = null;
  let escaped = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Remove trailing commas before } or ]. */
function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

export interface TsconfigEffective {
  /** Repo-relative path of this tsconfig. */
  path: string;
  absPath: string;
  /** Absolute dir containing the tsconfig. */
  dir: string;
  /** Absolute baseUrl dir (resolved against the declaring config's dir). */
  baseUrlAbs: string | undefined;
  /** baseUrl as written (for reporting). */
  baseUrlRaw: string | undefined;
  /**
   * This tsconfig's OWN `paths` exactly as written (for AliasInfo ownership).
   */
  ownPaths: Record<string, string[]>;
  /**
   * Effective `paths` (own + inherited, child wins): pattern → targets where
   * relative targets are ABSOLUTE paths (rebased through the extends chain)
   * and bare-specifier targets are kept as-is for chained resolution.
   */
  pathsAbs: Record<string, string[]>;
  moduleResolution: string | undefined;
  /** Repo-relative paths of presets in the extends chain (nearest first). */
  extendsChain: string[];
  /** Raw include/exclude for staleness notes. */
  include: string[] | undefined;
}

/**
 * Rebase relative path targets to absolute; keep bare-specifier targets
 * (those naming a known workspace package, e.g. cal.diy's
 * `"@prisma/client/*": ["@calcom/prisma/client/*"]`) as-is for chained
 * resolution. Per TS semantics, non-relative targets are baseUrl-relative
 * unless they name a package.
 */
function rebaseTargets(
  targets: string[],
  baseDir: string,
  nameToDir: Map<string, string>,
): string[] {
  return targets.map((t) => {
    if (t.startsWith('.')) return resolvePath(baseDir, t);
    const { name } = splitBare(t.replace(/\/\*$/, '').replace(/\/$/, ''));
    if (nameToDir.has(name)) return t; // chained bare-specifier target
    return resolvePath(baseDir, t);
  });
}

/**
 * Classify a single tsconfig `paths` target with EXACTLY the resolver's
 * semantics (mirrors rebaseTargets above), for honesty checks that must
 * not disagree with the resolver (TR-001).
 *
 * Returns the absolute on-disk location whose static prefix should exist,
 * or `{ chained: true }` when the target is a bare specifier naming a known
 * workspace package (resolved through the package map, not the filesystem).
 *
 * Per TS semantics, a non-relative target that does NOT name a workspace
 * package is baseUrl-relative (e.g. `"@/*": ["src/*"]` with
 * `baseUrl: "."`) — it must NOT be misreported as an unresolvable
 * "chained bare target".
 */
export function classifyPathTarget(
  target: string,
  baseDir: string,
  nameToDir: Map<string, string>,
): { abs: string } | { chained: true } {
  if (!target.startsWith('.')) {
    const { name } = splitBare(target.replace(/\/\*$/, '').replace(/\/$/, ''));
    if (nameToDir.has(name)) return { chained: true };
  }
  return { abs: resolvePath(baseDir, target) };
}

interface LoadCtx {
  repoRoot: string;
  nameToDir: Map<string, string>;
  cache: Map<string, TsconfigEffective | null>;
}

function toRel(repoRoot: string, abs: string): string {
  return relative(repoRoot, abs).split(sep).join('/');
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve an `extends` entry to an absolute tsconfig path.
 * Handles: relative paths, bare workspace package specifiers (via name→dir),
 * implicit `.json` extension.
 */
async function resolveExtendsTarget(
  entry: string,
  fromDir: string,
  ctx: LoadCtx,
): Promise<string | null> {
  const candidates: string[] = [];
  if (entry.startsWith('.')) {
    const base = resolvePath(fromDir, entry);
    candidates.push(base, base + '.json', join(base, 'tsconfig.json'));
  } else {
    // Bare specifier: split package name + subpath.
    const { name, subpath } = splitBare(entry);
    const pkgDir = ctx.nameToDir.get(name);
    if (pkgDir) {
      const base = resolvePath(ctx.repoRoot, pkgDir, subpath);
      candidates.push(base, base + '.json', join(base, 'tsconfig.json'));
    }
    // Fallback: node_modules (preset packages installed externally).
    const nmBase = resolvePath(fromDir, 'node_modules', entry);
    candidates.push(nmBase, nmBase + '.json', join(nmBase, 'tsconfig.json'));
  }
  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }
  return null;
}

export function splitBare(specifier: string): { name: string; subpath: string } {
  if (specifier.startsWith('@')) {
    const idx = specifier.indexOf('/', 1);
    if (idx === -1) return { name: specifier, subpath: '' };
    const second = specifier.indexOf('/', idx + 1);
    if (second === -1) return { name: specifier, subpath: '' };
    return { name: specifier.slice(0, second), subpath: specifier.slice(second + 1) };
  }
  const idx = specifier.indexOf('/');
  if (idx === -1) return { name: specifier, subpath: '' };
  return { name: specifier.slice(0, idx), subpath: specifier.slice(idx + 1) };
}

async function loadTsconfigInner(
  absPath: string,
  ctx: LoadCtx,
  seen: string[],
): Promise<TsconfigEffective | null> {
  const cached = ctx.cache.get(absPath);
  if (cached !== undefined) return cached;
  if (seen.includes(absPath)) {
    // Extends cycle — stop, keep what we have.
    return null;
  }
  let text: string;
  try {
    text = await readFile(absPath, 'utf8');
  } catch {
    ctx.cache.set(absPath, null);
    return null;
  }
  let raw: Record<string, unknown>;
  try {
    raw = parseJsonc(text) as Record<string, unknown>;
  } catch {
    ctx.cache.set(absPath, null);
    return null;
  }

  const fromDir = dirname(absPath);
  const merged: TsconfigEffective = {
    path: toRel(ctx.repoRoot, absPath),
    absPath,
    dir: fromDir,
    baseUrlAbs: undefined,
    baseUrlRaw: undefined,
    ownPaths: {},
    pathsAbs: {},
    moduleResolution: undefined,
    extendsChain: [],
    include: undefined,
  };

  // Extends first (child wins).
  const extRaw = (raw['extends'] as unknown);
  const extList = Array.isArray(extRaw) ? extRaw : extRaw != null ? [extRaw] : [];
  // Parent's paths are relative to the PARENT's baseUrl/dir — rebase to absolute.
  for (const entry of extList) {
    if (typeof entry !== 'string') continue;
    const target = await resolveExtendsTarget(entry, fromDir, ctx);
    if (target) {
      merged.extendsChain.push(toRel(ctx.repoRoot, target));
      const parent = await loadTsconfigInner(target, ctx, [...seen, absPath]);
      if (parent) {
        if (merged.baseUrlAbs === undefined && parent.baseUrlAbs !== undefined) {
          merged.baseUrlAbs = parent.baseUrlAbs;
        }
        for (const [pat, tgts] of Object.entries(parent.pathsAbs)) {
          // Parent's pathsAbs are already absolute — inherit as-is (child wins).
          if (!(pat in merged.pathsAbs)) merged.pathsAbs[pat] = [...tgts];
        }
        if (merged.moduleResolution === undefined) merged.moduleResolution = parent.moduleResolution;
      }
    } else {
      merged.extendsChain.push(`(unresolved: ${entry})`);
    }
  }

  const co = (raw['compilerOptions'] as Record<string, unknown> | undefined) ?? {};
  if (typeof co['baseUrl'] === 'string') {
    merged.baseUrlRaw = co['baseUrl'] as string;
    merged.baseUrlAbs = resolvePath(fromDir, merged.baseUrlRaw);
  }
  if (co['paths'] && typeof co['paths'] === 'object') {
    const p = co['paths'] as Record<string, unknown>;
    for (const [k, v] of Object.entries(p)) {
      if (Array.isArray(v)) {
        const tgts = (v as unknown[]).filter((x): x is string => typeof x === 'string');
        merged.ownPaths[k] = [...tgts];
      }
    }
  }
  const ownBase = merged.baseUrlAbs ?? fromDir;
  for (const [pat, tgts] of Object.entries(merged.ownPaths)) {
    merged.pathsAbs[pat] = rebaseTargets(tgts, ownBase, ctx.nameToDir);
  }
  if (typeof co['moduleResolution'] === 'string') {
    merged.moduleResolution = (co['moduleResolution'] as string).toLowerCase();
  }
  if (Array.isArray(raw['include'])) {
    merged.include = (raw['include'] as unknown[]).filter((x): x is string => typeof x === 'string');
  }

  ctx.cache.set(absPath, merged);
  return merged;
}

export function createTsconfigLoader(
  repoRoot: string,
  nameToDir: Map<string, string>,
): {
  load: (absPath: string) => Promise<TsconfigEffective | null>;
  nearestFor: (absFileOrDir: string) => Promise<TsconfigEffective | null>;
  allLoaded: () => TsconfigEffective[];
} {
  const ctx: LoadCtx = { repoRoot, nameToDir, cache: new Map() };
  const nearestCache = new Map<string, TsconfigEffective | null>();

  async function load(absPath: string): Promise<TsconfigEffective | null> {
    return loadTsconfigInner(absPath, ctx, []);
  }

  /** Nearest tsconfig.json walking up from a file/dir to the repo root. */
  async function nearestFor(absFileOrDir: string): Promise<TsconfigEffective | null> {
    let dir = absFileOrDir;
    try {
      if ((await stat(absFileOrDir)).isFile()) dir = dirname(absFileOrDir);
    } catch { /* treat as dir */ }
    const key = toRel(repoRoot, dir);
    const hit = nearestCache.get(key);
    if (hit !== undefined) return hit;
    let cur = dir;
    let found: TsconfigEffective | null = null;
    while (true) {
      const cand = join(cur, 'tsconfig.json');
      if (await fileExists(cand)) {
        found = await load(cand);
        break;
      }
      const parent = dirname(cur);
      if (parent === cur || relative(repoRoot, cur).startsWith('..')) break;
      cur = parent;
    }
    nearestCache.set(key, found);
    return found;
  }

  function allLoaded(): TsconfigEffective[] {
    return [...ctx.cache.values()].filter((v): v is TsconfigEffective => v != null);
  }

  return { load, nearestFor, allLoaded };
}
