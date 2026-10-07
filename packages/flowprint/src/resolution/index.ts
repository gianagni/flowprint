/**
 * Flowprint M0 — resolution layer.
 *
 * Pure function of (fromFile, specifier, context). NO framework logic.
 * Covers: relative specifiers (mode-aware), tsconfig paths (nearest wins),
 * package.json `imports` (`#`-aliases), workspace name→dir, basic exports-map
 * (string + import/require/default conditions), dist→src fallback (I),
 * barrel chains (transitive, cycle-protected), `import type` tagging.
 */
import { stat, readFile } from 'node:fs/promises';
import { join, dirname, resolve as resolvePath, relative, sep, extname } from 'node:path';
import {
  createTsconfigLoader,
  splitBare,
  type TsconfigEffective,
} from './tsconfig.js';
import { resolved, inferred, unknown, type Claim } from '../model/types.js';
import type { ModuleRecord } from '../parsing/index.js';

function toRel(repoRoot: string, abs: string): string {
  return relative(repoRoot, abs).split(sep).join('/');
}

export interface ResolutionContext {
  repoRoot: string;
  nameToDir: Map<string, string>;
  ts: ReturnType<typeof createTsconfigLoader>;
  /** abs path → parsed package.json (or null when unreadable) */
  pkgCache: Map<string, Record<string, unknown> | null>;
  /** repo-relative path → module record (parsing layer cache) */
  records: Map<string, ModuleRecord>;
}

export function createResolutionContext(
  repoRoot: string,
  nameToDir: Map<string, string>,
  records: Map<string, ModuleRecord>,
): ResolutionContext {
  return {
    repoRoot,
    nameToDir,
    ts: createTsconfigLoader(repoRoot, nameToDir),
    pkgCache: new Map(),
    records,
  };
}

async function readPackageJson(
  ctx: ResolutionContext,
  absDir: string,
): Promise<Record<string, unknown> | null> {
  const key = join(absDir, 'package.json');
  const hit = ctx.pkgCache.get(key);
  if (hit !== undefined) return hit;
  let raw: Record<string, unknown> | null = null;
  try {
    raw = JSON.parse(await readFile(key, 'utf8')) as Record<string, unknown>;
  } catch {
    raw = null;
  }
  ctx.pkgCache.set(key, raw);
  return raw;
}

async function isFile(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}

async function isDir(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

type ModuleMode = 'bundler' | 'node' | 'nodenext';

function modeOf(ts: TsconfigEffective | null): ModuleMode {
  const m = (ts?.moduleResolution ?? 'bundler').toLowerCase();
  if (m === 'nodenext' || m === 'node16') return 'nodenext';
  if (m === 'node' || m === 'node10') return 'node';
  return 'bundler';
}

const TS_INDEX = ['index.ts', 'index.tsx', 'index.mts', 'index.cts', 'index.d.ts'];
const JS_INDEX = ['index.js', 'index.jsx', 'index.mjs', 'index.cjs'];
const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts'];
const JS_EXTS = ['.js', '.jsx', '.mjs', '.cjs'];
/** Extensions the resolver recognizes. A dot in the final path segment that is
 *  NOT one of these (e.g. `subdomain.management`, `i18n.config`) is part of the
 *  file stem — the specifier is extensionless and needs extension probing. */
const KNOWN_EXTS = new Set([...TS_EXTS, ...JS_EXTS]);

/** Map an explicit JS extension to its TS source counterpart (NodeNext rule). */
function jsToTs(abs: string): string[] {
  if (abs.endsWith('.js')) return [abs.slice(0, -3) + '.ts', abs.slice(0, -3) + '.tsx', abs.slice(0, -3) + '.d.ts'];
  if (abs.endsWith('.jsx')) return [abs.slice(0, -4) + '.tsx'];
  if (abs.endsWith('.mjs')) return [abs.slice(0, -4) + '.mts', abs.slice(0, -4) + '.d.mts'];
  if (abs.endsWith('.cjs')) return [abs.slice(0, -4) + '.cts', abs.slice(0, -4) + '.d.cts'];
  return [];
}

export interface ProbeHit {
  abs: string;
  /** 'file' = exact/probed file hit; 'dir' = directory exists but no index file. */
  kind: 'file' | 'dir';
  /** Set when a heuristic was used (drives I confidence). */
  via?: string;
}

/**
 * Mode-aware filesystem probing for a base path (no extension yet, or explicit).
 * Returns the first hit; prefers exact file, then extensions, then directory index.
 */
export async function probeFile(absBase: string, mode: ModuleMode): Promise<ProbeHit | null> {
  const ext = extname(absBase).toLowerCase();
  // General rule: only a RECOGNIZED extension counts as "has extension".
  // extname() reports `.management` for `subdomain.management` — that dot is
  // part of the stem, not an extension. Treating it as an extension skips
  // extension probing and misresolves the specifier (observed: postiz
  // `@gitroom/helpers/subdomain/subdomain.management` fell through to
  // "external"). Unknown extensions fall through to extensionless probing.
  const hasExt = ext !== '' && KNOWN_EXTS.has(ext);

  if (mode === 'nodenext') {
    if (hasExt) {
      const cands = [absBase, ...jsToTs(absBase)];
      for (const c of cands) {
        if (await isFile(c)) return { abs: c, kind: 'file', via: c === absBase ? undefined : 'nodenext .js→.ts mapping' };
      }
      return null;
    }
    // NodeNext requires explicit extensions for relative imports.
    return null;
  }

  // bundler / node: extensionless probing.
  if (hasExt) {
    if (await isFile(absBase)) return { abs: absBase, kind: 'file' };
    for (const mapped of jsToTs(absBase)) {
      if (await isFile(mapped)) {
        return { abs: mapped, kind: 'file', via: 'explicit .js→.ts source mapping' };
      }
    }
    return null;
  }
  // No recognized extension: truly extensionless, a dotted stem mistaken for
  // an extension (e.g. `subdomain.management`), or an unrecognized extension
  // (e.g. `.json`). The exact path may exist as-is; otherwise probe known
  // source extensions.
  if (await isFile(absBase)) return { abs: absBase, kind: 'file' };
  for (const e of [...TS_EXTS, ...JS_EXTS]) {
    if (await isFile(absBase + e)) return { abs: absBase + e, kind: 'file' };
  }
  if (await isDir(absBase)) {
    for (const idx of [...TS_INDEX, ...JS_INDEX]) {
      const cand = join(absBase, idx);
      if (await isFile(cand)) return { abs: cand, kind: 'file', via: 'directory index' };
    }
    return { abs: absBase, kind: 'dir', via: 'directory exists; no index file' };
  }
  return null;
}

/** dist→src fallback: build output absent → try the source tree. */
async function distToSrcFallback(absTarget: string, mode: ModuleMode): Promise<ProbeHit | null> {
  const idx = absTarget.indexOf(`${sep}dist${sep}`);
  if (idx === -1) return null;
  const srcBase = absTarget.slice(0, idx) + `${sep}src${sep}` + absTarget.slice(idx + 6);
  // Probe extensionless too: dist targets often carry build extensions
  // (./dist/index.mjs) while the source is ./src/index.tsx.
  const noExt = srcBase.replace(/\.(mjs|cjs|js|jsx|ts|tsx|mts|cts|d\.ts)$/, '');
  for (const base of [srcBase, noExt]) {
    const hit = await probeFile(base, mode);
    if (hit) return { ...hit, via: 'dist→src fallback (build output absent)' };
  }
  return null;
}

type ExportsField = string | Record<string, unknown> | string[] | null;

/** Basic exports-map target selection: string + import/require/default conditions. */
function selectExportsTarget(
  exportsField: ExportsField,
  subpath: string,
): { target: string | null; blocked: boolean; reason: string } {
  if (exportsField == null) return { target: null, blocked: false, reason: 'no exports map' };
  if (typeof exportsField === 'string') {
    return subpath === '.'
      ? { target: exportsField, blocked: false, reason: 'exports string' }
      : { target: null, blocked: false, reason: 'exports string has no subpath' };
  }
  if (Array.isArray(exportsField)) {
    // Array fallback (Node supports it): first string entry wins in M0.
    const first = exportsField.find((e): e is string => typeof e === 'string');
    return { target: first ?? null, blocked: false, reason: 'exports array (first entry)' };
  }
  const key = subpath === '.' ? '.' : `./${subpath}`;
  let node: unknown = (exportsField as Record<string, unknown>)[key];
  if (node === undefined) {
    // Best-effort single-`*` wildcard (e.g. "./src/*": "./src/*.ts").
    for (const [k, v] of Object.entries(exportsField as Record<string, unknown>)) {
      const star = k.indexOf('*');
      if (star === -1) continue;
      const prefix = k.slice(0, star);
      const suffix = k.slice(star + 1);
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        const sub = key.slice(prefix.length, key.length - suffix.length);
        node = v;
        if (typeof node === 'string') {
          return { target: node.replace('*', sub), blocked: false, reason: `exports wildcard ${k}` };
        }
        break;
      }
    }
    if (node === undefined) return { target: null, blocked: false, reason: `exports map has no "${key}"` };
  }
  if (node == null) return { target: null, blocked: true, reason: `exports map blocks "${key}" (null)` };
  if (typeof node === 'string') return { target: node, blocked: false, reason: `exports "${key}"` };
  if (typeof node === 'object') {
    const cond = node as Record<string, unknown>;
    // M0 conditions: import / require / default. Others → best-effort.
    for (const c of ['import', 'require', 'default']) {
      const v = cond[c];
      if (typeof v === 'string') return { target: v, blocked: false, reason: `exports "${key}" [${c}]` };
      if (v == null && c in cond) return { target: null, blocked: true, reason: `exports "${key}" blocks [${c}] (null)` };
    }
    const firstString = Object.values(cond).find((v): v is string => typeof v === 'string');
    if (firstString) {
      return { target: firstString, blocked: false, reason: `exports "${key}" [custom condition, best-effort]` };
    }
    return { target: null, blocked: true, reason: `exports "${key}" has no usable condition` };
  }
  return { target: null, blocked: false, reason: `exports "${key}" unrecognized shape` };
}

/**
 * Resolve a bare workspace package's entry (no subpath).
 * Rule: exports "." → existing file ⇒ I (condition selection is
 * importer-dependent); dist-absent ⇒ src fallback ⇒ I; no exports and no
 * main ⇒ directory-index convention ⇒ R; main ⇒ R; otherwise package dir ⇒ I.
 */
async function resolvePackageEntry(
  ctx: ResolutionContext,
  pkgDirAbs: string,
  mode: ModuleMode,
): Promise<{ rel: string; conf: 'R' | 'I'; reason: string }> {
  const pkg = await readPackageJson(ctx, pkgDirAbs);
  const dirRel = toRel(ctx.repoRoot, pkgDirAbs);
  if (!pkg) return { rel: dirRel, conf: 'I', reason: 'package.json unreadable; directory-level' };

  const exportsField = (pkg['exports'] as ExportsField | undefined) ?? null;
  if (exportsField != null) {
    const sel = selectExportsTarget(exportsField, '.');
    if (typeof sel.target === 'string') {
      const absTarget = resolvePath(pkgDirAbs, sel.target);
      const hit = await probeFile(absTarget, mode);
      if (hit?.kind === 'file') {
        return {
          rel: toRel(ctx.repoRoot, hit.abs),
          conf: 'I',
          reason: `bare workspace import; entry via ${sel.reason} → file exists; condition selection is importer-dependent`,
        };
      }
      const fb = await distToSrcFallback(absTarget, mode);
      if (fb?.kind === 'file') {
        return {
          rel: toRel(ctx.repoRoot, fb.abs),
          conf: 'I',
          reason: `exports target ${sel.target} absent (build output); ${fb.via}`,
        };
      }
      return { rel: dirRel, conf: 'I', reason: `exports "." target absent and no src fallback; directory-level` };
    }
    if (sel.blocked) return { rel: dirRel, conf: 'I', reason: `exports "." blocked (${sel.reason}); directory-level` };
    return { rel: dirRel, conf: 'I', reason: `exports map has no "." entry (${sel.reason}); directory-level` };
  }

  const main = pkg['main'];
  if (typeof main === 'string') {
    const hit = await probeFile(resolvePath(pkgDirAbs, main), mode);
    if (hit?.kind === 'file') {
      return { rel: toRel(ctx.repoRoot, hit.abs), conf: 'R', reason: 'package.json main → file exists' };
    }
  }
  // Legacy Node directory-index convention.
  for (const idx of [...TS_INDEX, ...JS_INDEX]) {
    const cand = join(pkgDirAbs, idx);
    if (await isFile(cand)) {
      return {
        rel: toRel(ctx.repoRoot, cand),
        conf: 'R',
        reason: 'no exports/main; Node directory-index convention (index.*)',
      };
    }
  }
  return { rel: dirRel, conf: 'I', reason: 'no exports/main/index file; directory-level' };
}

export interface InternalResolution {
  claim: Claim<string | null>;
  /** Absolute resolved path when known (for graph building). */
  absPath: string | null;
}

/**
 * Resolve one import specifier from a file. Pure module semantics —
 * no framework knowledge.
 */
export async function resolveImport(
  ctx: ResolutionContext,
  fromFileAbs: string,
  specifier: string,
): Promise<InternalResolution> {
  const ts = await ctx.ts.nearestFor(fromFileAbs);
  const mode = modeOf(ts);
  const tsLabel = ts ? ts.path : '(no tsconfig)';

  // 1. Relative specifiers.
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const base = resolvePath(dirname(fromFileAbs), specifier);
    const hit = await probeFile(base, mode);
    if (hit?.kind === 'file') {
      const viaNote = hit.via ? ` (${hit.via})` : '';
      return {
        claim: resolved(toRel(ctx.repoRoot, hit.abs), `relative specifier → filesystem hit${viaNote} [${mode}]`),
        absPath: hit.abs,
      };
    }
    if (hit?.kind === 'dir') {
      return {
        claim: resolved(toRel(ctx.repoRoot, hit.abs), `relative specifier → directory exists, no index file (${hit.via})`),
        absPath: hit.abs,
      };
    }
    if (mode === 'nodenext' && !/\.[a-z]+$/i.test(specifier)) {
      return {
        claim: unknown(null, `NodeNext requires explicit file extensions; "${specifier}" is extensionless`),
        absPath: null,
      };
    }
    return { claim: unknown(null, `relative specifier "${specifier}" — no file on disk`), absPath: null };
  }

  // 2. Package `imports` (`#`-aliases) from the nearest package.json.
  if (specifier.startsWith('#')) {
    const r = await resolveHashImport(ctx, fromFileAbs, specifier, mode);
    if (r) return r;
    // fall through to unknown below
  }

  // 3. tsconfig paths (nearest config wins), longest-pattern-first.
  if (ts) {
    const patterns = Object.keys(ts.pathsAbs).sort((a, b) => b.length - a.length);
    for (const pat of patterns) {
      const sub = matchPattern(pat, specifier);
      if (sub == null) continue;
      for (const target of ts.pathsAbs[pat]) {
        const resolvedTarget = substitutePattern(target, pat, specifier);
        if (resolvedTarget == null) continue;
        if (!resolvedTarget.startsWith('/')) {
          // Bare-specifier target → chained resolution.
          const chained = await resolveImport(ctx, fromFileAbs, resolvedTarget);
          if (chained.claim.value != null) {
            return {
              claim: chained.claim.confidence === 'R'
                ? resolved(chained.claim.value, `tsconfig paths "${pat}" → chained bare "${resolvedTarget}" [${tsLabel}]`)
                : inferred(chained.claim.value, `tsconfig paths "${pat}" → chained bare "${resolvedTarget}" [${tsLabel}]`),
              absPath: chained.absPath,
            };
          }
          continue;
        }
        const hit = await probeFile(resolvedTarget, mode);
        if (hit?.kind === 'file') {
          const viaNote = hit.via ? ` (${hit.via})` : '';
          return {
            claim: resolved(toRel(ctx.repoRoot, hit.abs), `tsconfig paths "${pat}" from ${tsLabel}${viaNote}`),
            absPath: hit.abs,
          };
        }
        if (hit?.kind === 'dir') {
          return {
            claim: resolved(toRel(ctx.repoRoot, hit.abs), `tsconfig paths "${pat}" from ${tsLabel}; directory, no index file`),
            absPath: hit.abs,
          };
        }
      }
      // A matching pattern whose targets all miss → keep trying other mechanisms
      // (e.g. `@/*` matching `@openstatus/db` but ./src/* missing → workspace map).
    }
  }

  // 4. Workspace name→dir.
  const { name, subpath } = splitBare(specifier);
  const pkgDirRel = ctx.nameToDir.get(name);
  if (pkgDirRel !== undefined) {
    const pkgDirAbs = resolvePath(ctx.repoRoot, pkgDirRel);
    if (!subpath) {
      const entry = await resolvePackageEntry(ctx, pkgDirAbs, mode);
      const claim = entry.conf === 'R'
        ? resolved(entry.rel, entry.reason)
        : inferred(entry.rel, entry.reason);
      return { claim, absPath: resolvePath(ctx.repoRoot, entry.rel) };
    }
    const base = resolvePath(pkgDirAbs, subpath);
    const hit = await probeFile(base, mode);
    if (hit?.kind === 'file') {
      const viaNote = hit.via ? ` (${hit.via})` : '';
      return {
        claim: resolved(toRel(ctx.repoRoot, hit.abs), `workspace package "${name}" → filesystem subpath${viaNote}`),
        absPath: hit.abs,
      };
    }
    if (hit?.kind === 'dir') {
      return {
        claim: resolved(toRel(ctx.repoRoot, hit.abs), `workspace package "${name}" → directory exists; leaf file not verified`),
        absPath: hit.abs,
      };
    }
    // Subpath missing on disk: emit the mechanism-derived literal path at I.
    // The workspace name→dir + subpath mechanism is verified; only the leaf
    // file is unverified (it may live under src/, be generated, or be stale).
    // R is forbidden here: R requires a filesystem-proven hit.
    const literalRel = toRel(ctx.repoRoot, base);
    return {
      claim: inferred(
        literalRel,
        `workspace package "${name}" → package dir + literal subpath "${subpath}"; no filesystem hit for the leaf (may live under src/, be generated, or be stale)`,
      ),
      absPath: null,
    };
  }

  // 5. External boundary: node_modules / builtins. Do not descend in M0.
  if (specifier === '#' || specifier.startsWith('#')) {
    return { claim: unknown(null, `"${specifier}" — package imports not resolvable`), absPath: null };
  }
  return {
    claim: resolved(null, `external package "${specifier}" — node_modules boundary, not descended in M0`),
    absPath: null,
  };
}

/** Match a tsconfig pattern (`@/*`, `@lib/*`, exact `@foo`) against a specifier. */
function matchPattern(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === specifier ? '' : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (specifier.startsWith(prefix) && specifier.endsWith(suffix) &&
    specifier.length >= prefix.length + suffix.length) {
    return specifier.slice(prefix.length, specifier.length - suffix.length);
  }
  return null;
}

function substitutePattern(target: string, pattern: string, specifier: string): string | null {
  const sub = matchPattern(pattern, specifier);
  if (sub == null) return null;
  if (target.includes('*')) return target.replace('*', sub);
  // Non-wildcard target with wildcard pattern: append the matched remainder.
  return target + sub;
}

async function resolveHashImport(
  ctx: ResolutionContext,
  fromFileAbs: string,
  specifier: string,
  mode: ModuleMode,
): Promise<InternalResolution | null> {
  // Nearest package.json walking up.
  let dir = dirname(fromFileAbs);
  while (true) {
    const pkg = await readPackageJson(ctx, dir);
    if (pkg && pkg['imports'] && typeof pkg['imports'] === 'object') {
      const imports = pkg['imports'] as Record<string, unknown>;
      for (const [pat, target] of Object.entries(imports)) {
        const sub = matchPattern(pat, specifier);
        if (sub == null || typeof target !== 'string') continue;
        const absTarget = target.startsWith('.') ? resolvePath(dir, substitutePattern(target, pat, specifier) ?? target) : null;
        if (!absTarget) continue;
        const hit = await probeFile(absTarget, mode);
        if (hit?.kind === 'file') {
          return {
            claim: resolved(toRel(ctx.repoRoot, hit.abs), `package.json imports "${pat}"`),
            absPath: hit.abs,
          };
        }
      }
      return { claim: unknown(null, `"${specifier}" — package imports pattern matched but target absent`), absPath: null };
    }
    const parent = dirname(dir);
    if (parent === dir || relative(ctx.repoRoot, dir).startsWith('..')) break;
    dir = parent;
  }
  return null;
}

/**
 * Follow a re-export (barrel) chain transitively with cycle protection.
 * Given the file that re-exports and the imported name, find the ultimate
 * defining file. Returns null when the chain cannot be followed honestly.
 *
 * Name mapping: `export { a as b } from './y'` continues the search for `a`
 * in `./y`. `export *` continues with the same name. Namespace re-exports
 * (`export * as ns`) terminate the chain (name lives under the namespace).
 */
export async function resolveThroughBarrels(
  ctx: ResolutionContext,
  startFileRel: string,
  importedName: string,
  maxDepth = 10,
): Promise<{ file: string; depth: number; via: string[] } | null> {
  const visited = new Set<string>();
  const via: string[] = [];
  let current = startFileRel;
  let name = importedName;
  for (let depth = 0; depth < maxDepth; depth++) {
    if (visited.has(current)) return null; // cycle — stop honestly
    visited.add(current);
    const rec = ctx.records.get(current);
    if (!rec) return null;
    // Local definition shadows re-exports — stop here.
    if (rec.exports.some((e) => e.from == null && (e.names.includes(name) || (name === 'default' && e.isDefault)))) {
      return { file: current, depth, via };
    }
    // Named re-exports take precedence over `export *` (ES shadowing rule).
    const ordered = [
      ...rec.exports.filter((e) => e.from && !e.isStar && !e.isStarAs),
      ...rec.exports.filter((e) => e.from && (e.isStar || e.isStarAs)),
    ];
    let progressed = false;
    for (const exp of ordered) {
      if (!exp.from) continue;
      if (exp.isStarAs) continue; // namespace re-export — terminates
      let nextName: string | null = null;
      if (exp.isStar) {
        nextName = name; // `export * from` — same name, minus default
        if (name === 'default') continue;
      } else {
        for (const p of exp.pairs) {
          if (p.exported === name) {
            nextName = p.imported ?? name;
            break;
          }
        }
      }
      if (nextName == null) continue;
      const r = await resolveImport(ctx, resolvePath(ctx.repoRoot, current), exp.from);
      if (r.claim.value == null || r.claim.confidence === 'U') continue;
      via.push(`${current} --${name}--> ${r.claim.value}`);
      current = r.claim.value;
      name = nextName;
      progressed = true;
      break;
    }
    if (!progressed) return { file: current, depth, via };
  }
  return null; // max depth exceeded — stop honestly
}
