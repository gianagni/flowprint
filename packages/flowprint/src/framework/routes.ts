/**
 * Flowprint M0 — framework layer: Next.js App Router route detection.
 *
 * File-convention routes only (page/route/layout/loading/error/not-found),
 * URL mapping per Next.js segment rules, metadata routes. No resolution
 * logic here beyond what the framework layer owns (adapter delegation
 * detection uses the parsing layer's module records).
 */
import { readdir, stat, readFile } from 'node:fs/promises';
import { join, relative, sep, dirname, basename } from 'node:path';
import type { ModuleRecord } from '../parsing/index.js';
import type { Claim } from '../model/types.js';

function toRel(repoRoot: string, abs: string): string {
  return relative(repoRoot, abs).split(sep).join('/');
}

export interface RouteFileInfo {
  /** Repo-relative file path. */
  file: string;
  kind: 'page' | 'route' | 'special' | 'metadata';
  /** Route filename without extension, e.g. 'page', 'route', 'layout'. */
  leaf: string;
  /** Path segments from the app dir to the file's directory. */
  segments: string[];
}

export interface UrlMapping {
  /** URL path, or null when honestly undeterminable. */
  url: string | null;
  confidence: 'R' | 'I' | 'U';
  reason: string;
  notes: string[];
}

const PAGE_RE = /^page\.(tsx|ts|jsx|js)$/;
const ROUTE_RE = /^route\.(ts|js)$/;
const SPECIAL_RE = /^(layout|loading|error|not-found|default|template)\.(tsx|ts|jsx|js)$/;
/** Next.js metadata file conventions → conventional URLs. */
const METADATA_URLS: Record<string, string> = {
  'manifest': '/manifest.webmanifest',
  'robots': '/robots.txt',
  'sitemap': '/sitemap.xml',
  'favicon': '/favicon.ico',
  'icon': '/icon',
  'apple-icon': '/apple-icon',
  'opengraph-image': '/opengraph-image',
  'twitter-image': '/twitter-image',
};

const SKIP = new Set(['node_modules', '.next', 'dist', 'build']);
/** Dirs skipped by framework filesystem walks. */
export { SKIP };

async function walk(
  absDir: string,
  visit: (absFile: string) => Promise<void>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const abs = join(absDir, e.name);
    if (e.isDirectory()) await walk(abs, visit);
    else if (e.isFile()) await visit(abs);
  }
}

/** Collect route-convention files under an app-router root. */
export async function collectRouteFiles(
  repoRoot: string,
  appDirAbs: string,
): Promise<RouteFileInfo[]> {
  const out: RouteFileInfo[] = [];
  await walk(appDirAbs, async (absFile) => {
    const base = basename(absFile);
    let kind: RouteFileInfo['kind'] | null = null;
    let leaf = '';
    if (PAGE_RE.test(base)) { kind = 'page'; leaf = 'page'; }
    else if (ROUTE_RE.test(base)) { kind = 'route'; leaf = 'route'; }
    else if (SPECIAL_RE.test(base)) { kind = 'special'; leaf = base.replace(/\.(tsx|ts|jsx|js)$/, ''); }
    else {
      const stem = base.replace(/\.(ts|js|tsx|jsx|png|jpg|jpeg|svg|ico)$/, '');
      if (/^(manifest|robots|sitemap)\.(ts|js)$/.test(base)) { kind = 'metadata'; leaf = stem; }
      else if (base === 'favicon.ico' || /^(icon|apple-icon|opengraph-image|twitter-image)\./.test(base)) {
        kind = 'metadata';
        leaf = base === 'favicon.ico' ? 'favicon' : stem;
      }
    }
    if (!kind) return;
    const dirRel = toRel(repoRoot, dirname(absFile));
    const appRel = toRel(repoRoot, appDirAbs);
    const segs = dirRel === appRel ? [] : dirRel.slice(appRel.length + 1).split('/');
    out.push({ file: toRel(repoRoot, absFile), kind, leaf, segments: segs });
  });
  out.sort((a, b) => (a.file < b.file ? -1 : 1));
  return out;
}

const INTERCEPTING_RE = /^\(\.{1,3}\)/;
const DOUBLE_INTERCEPTING_RE = /^\(\.\.\)\(\.\.\)/;

export function isInterceptingSegment(seg: string): boolean {
  return INTERCEPTING_RE.test(seg) || DOUBLE_INTERCEPTING_RE.test(seg);
}

export function isRouteGroup(seg: string): boolean {
  return seg.startsWith('(') && seg.endsWith(')') && !isInterceptingSegment(seg);
}

export function isParallelSlot(seg: string): boolean {
  return seg.startsWith('@');
}

/**
 * Map a route file's directory segments to a URL path per Next.js App Router
 * conventions, shared by page/route files and metadata files:
 * - route groups `(name)` are URL-invisible
 * - dynamic `[p]`, catch-all `[...p]`, optional catch-all `[[...p]]` kept as-is
 * - parallel slots `@name` are URL-invisible (noted)
 * - intercepting routes `(.)name` etc. have no own navigable URL
 */
function mapParentPath(segments: string[]):
  | { path: string; notes: string[] }
  | { intercepting: string; notes: string[] } {
  const notes: string[] = [];
  const urlSegs: string[] = [];
  for (const seg of segments) {
    if (isInterceptingSegment(seg)) {
      return {
        intercepting: seg,
        notes,
      };
    }
    if (isRouteGroup(seg)) continue;
    if (isParallelSlot(seg)) {
      notes.push(`parallel slot ${seg}`);
      continue;
    }
    urlSegs.push(seg);
  }
  const path = '/' + urlSegs.join('/');
  return { path: path === '/' ? '/' : path.replace(/\/+$/, '') || '/', notes };
}

/**
 * Map route-file segments to a URL per Next.js App Router conventions.
 * - route groups `(name)` are URL-invisible
 * - dynamic `[p]`, catch-all `[...p]`, optional catch-all `[[...p]]` kept as-is
 * - parallel slots `@name` are URL-invisible (noted)
 * - intercepting routes `(.)name` etc. have no own navigable URL → null (I)
 * - metadata files are served from their route directory: the owning parent
 *   segments are preserved (groups stripped, dynamics kept), never dropped
 *   to the repo root merely because the filename is a metadata convention
 */
export function mapUrl(route: RouteFileInfo): UrlMapping {
  const notes: string[] = [];
  if (route.kind === 'metadata') {
    const leafUrl = METADATA_URLS[route.leaf];
    if (!leafUrl) {
      return { url: null, confidence: 'U', reason: `unrecognized metadata file ${route.leaf}`, notes };
    }
    const parent = mapParentPath(route.segments);
    if ('intercepting' in parent) {
      return {
        url: null, confidence: 'I', notes: parent.notes,
        reason: `intercepting route segment "${parent.intercepting}" — renders inside the intercepted route's slot; file→URL mapping over-reports here`,
      };
    }
    const url = parent.path === '/' ? leafUrl : parent.path + leafUrl;
    return {
      url, confidence: 'I', notes: parent.notes,
      reason: 'special metadata file served from its route directory; parent segments preserved per Next.js routing conventions (URL per metadata-route convention, not file-syntax-derived)',
    };
  }
  if (route.kind === 'special') {
    return { url: null, confidence: 'U', reason: `${route.leaf} is a special file, not a route`, notes };
  }
  const parent = mapParentPath(route.segments);
  if ('intercepting' in parent) {
    return {
      url: null, confidence: 'I', notes: parent.notes,
      reason: `intercepting route segment "${parent.intercepting}" — renders inside the intercepted route's slot; file→URL mapping over-reports here`,
    };
  }
  return {
    url: parent.path,
    confidence: 'R',
    reason: 'file-convention route; groups stripped per documented Next.js URL mapping',
    notes: parent.notes,
  };
}

/**
 * Known framework-adapter specifier fragments → display name.
 * A catch-all route.ts delegating to one of these is an embedded framework.
 */
const ADAPTER_FRAMEWORKS: Array<[RegExp, string]> = [
  [/hono/i, 'Hono'],
  [/express/i, 'Express'],
  [/elysia/i, 'Elysia'],
  [/fastify/i, 'Fastify'],
  [/trpc/i, 'tRPC'],
  [/next-connect/i, 'next-connect'],
];

/** Adapter call names (imported binding invoked as `export const GET = handle(app)`). */
const ADAPTER_CALLS = new Set(['handle', 'fetchRequestHandler', 'createHandler']);

export interface AdapterDelegation {
  frameworkName: string;
  /** The import specifier that named the framework, e.g. "hono/vercel". */
  viaSpecifier: string;
  /** Exported names assigned to adapter calls, e.g. ["GET","POST"]. */
  delegatedExports: string[];
}

/**
 * Detect a route.ts that delegates to an embedded framework adapter:
 * imports `handle`/`fetchRequestHandler` from a framework specifier and
 * assigns its call result to route exports (`export const GET = handle(app)`).
 */
export function detectAdapterDelegation(rec: ModuleRecord): AdapterDelegation | null {
  // Imported names per specifier.
  const adapterImports: Array<{ specifier: string; localNames: string[]; framework: string }> = [];
  for (const imp of rec.imports) {
    for (const [rx, name] of ADAPTER_FRAMEWORKS) {
      if (rx.test(imp.specifier)) {
        adapterImports.push({ specifier: imp.specifier, localNames: imp.names, framework: name });
        break;
      }
    }
  }
  if (adapterImports.length === 0) return null;
  const localNames = new Set(adapterImports.flatMap((a) => a.localNames));
  const delegated = [...rec.exportShape.namedCallExports.entries()]
    .filter(([, callee]) => localNames.has(callee) || ADAPTER_CALLS.has(callee))
    .map(([name]) => name);
  if (delegated.length === 0) return null;
  // Name the specifier that actually provided a called adapter binding
  // (e.g. `handle` from "hono/vercel", not the bare "hono" import).
  const calledCallees = new Set(
    [...rec.exportShape.namedCallExports.values()].filter((c) => localNames.has(c)),
  );
  const provider =
    adapterImports.find((a) => a.localNames.some((n) => calledCallees.has(n))) ?? adapterImports[0];
  return {
    frameworkName: provider.framework,
    viaSpecifier: provider.specifier,
    delegatedExports: delegated,
  };
}

/** Count dynamic segments in a route file's path (for unknown-surfacing). */
export function hasDynamicSegments(route: RouteFileInfo): boolean {
  return route.segments.some((s) => s.includes('['));
}

/**
 * App-level next.config facts relevant to concrete URL serving.
 * Presence-level only: whether basePath/rewrites/redirects are declared.
 * Per-URL effect analysis is out of scope — presence downgrades R to I.
 */
export interface NextConfigSummary {
  /** Repo-relative config path, or null when no next.config found. */
  configFile: string | null;
  readable: boolean;
  hasBasePath: boolean;
  hasRewrites: boolean;
  hasRedirects: boolean;
}

const NEXT_CONFIG_NAMES = ['next.config.ts', 'next.config.js', 'next.config.mjs', 'next.config.cjs'];

export async function summarizeNextConfig(repoRoot: string, appDir: string): Promise<NextConfigSummary> {
  for (const name of NEXT_CONFIG_NAMES) {
    const rel = appDir ? `${appDir}/${name}` : name;
    let exists = false;
    try {
      exists = (await stat(join(repoRoot, rel))).isFile();
    } catch {
      continue;
    }
    if (!exists) continue;
    let text: string | null = null;
    try {
      text = await readFile(join(repoRoot, rel), 'utf8');
    } catch {
      return { configFile: rel, readable: false, hasBasePath: false, hasRewrites: false, hasRedirects: false };
    }
    return {
      configFile: rel,
      readable: true,
      hasBasePath: /\bbasePath\s*:/.test(text),
      hasRewrites: /\brewrites\s*[:\(]/.test(text),
      hasRedirects: /\bredirects\s*[:\(]/.test(text),
    };
  }
  return { configFile: null, readable: false, hasBasePath: false, hasRewrites: false, hasRedirects: false };
}

/**
 * Build the concreteValues claim from a skeleton claim + next.config summary.
 * - skeleton null → concreteValues null (same confidence/reason).
 * - dynamic segments → U, empty: values need runtime data.
 * - fully static + skeleton R + config readable + no basePath/rewrites/redirects → R [skeleton].
 * - fully static + skeleton R + config uncertain/affecting → I [skeleton].
 * - fully static + skeleton not R → U: concrete values inherit the uncertainty.
 */
export function concreteValuesClaim(
  skeleton: Claim<string | null>,
  cfg: NextConfigSummary,
): Claim<string[] | null> {
  const s = skeleton.value;
  if (s === null) {
    return { value: null, confidence: skeleton.confidence, reason: skeleton.reason };
  }
  if (s.includes('[')) {
    return {
      value: [],
      confidence: 'U',
      reason: 'concrete values require runtime data (DB rows, env, tenant config)',
    };
  }
  if (skeleton.confidence !== 'R') {
    return {
      value: [],
      confidence: 'U',
      reason: `skeleton is ${skeleton.confidence === 'I' ? 'Inferred' : 'Unknown'} (${skeleton.reason}); concrete values inherit the uncertainty`,
    };
  }
  const blockers: string[] = [];
  if (!cfg.configFile || !cfg.readable) {
    blockers.push(cfg.configFile ? 'next.config present but not readable' : 'no next.config found');
  } else {
    if (cfg.hasBasePath) blockers.push('basePath');
    if (cfg.hasRewrites) blockers.push('rewrites');
    if (cfg.hasRedirects) blockers.push('redirects');
  }
  if (blockers.length > 0) {
    return {
      value: [s],
      confidence: 'I',
      reason: `static skeleton; ${blockers.join(', ')} — effective serving URLs may differ`,
    };
  }
  return {
    value: [s],
    confidence: 'R',
    reason: 'fully static skeleton; next.config readable with no basePath/rewrites/redirects affecting it',
  };
}

export async function fileExists(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}
