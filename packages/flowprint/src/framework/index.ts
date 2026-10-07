/**
 * Flowprint v0.1 (Blocker B2) — framework layer: Next.js hybrid router analysis.
 *
 * General rule (B2): for each app candidate, App Router evidence (an `app/`
 * or `src/app/` dir containing route files: page/route/layout/...) and Pages
 * Router evidence (a `pages/` or `src/pages/` dir containing page files) are
 * detected INDEPENDENTLY, per directory. Neither detector is gated on the
 * other's presence or dominance — a pages-dominant hybrid app whose `app/`
 * holds only `route.ts` files still gets its App Router routes detected.
 * Both route sets are reported in the model; same-URL conflicts keep the
 * pages-wins rule (Next.js serves the Pages Router version) and are reported
 * explicitly in `routerConflicts`.
 */
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import type { AppCandidate } from '../discovery/index.js';
import type { ModuleRecord } from '../parsing/index.js';
import {
  collectRouteFiles,
  mapUrl,
  detectAdapterDelegation,
  hasDynamicSegments,
  summarizeNextConfig,
  concreteValuesClaim,
  type RouteFileInfo,
  type NextConfigSummary,
} from './routes.js';
import { collectPagesRoutes } from './pages.js';
import {
  detectEdgeEntries,
  nextMajorOf,
  edgeExpectationNote,
  type EdgeEntryInfo,
} from './edge.js';
import type { Claim, UnknownItem, RouterConflict } from '../model/types.js';
import { resolved, inferred } from '../model/types.js';
import type { HybridDetection, PagesRouteInfo, RouterEvidence } from './types.js';

export interface FrameworkAppResult {
  candidate: AppCandidate;
  /** Framework id, e.g. "nextjs-app-router" / "nextjs-hybrid" / "nextjs-pages-router". */
  frameworkId: string;
  frameworkClaim: Claim<string>;
  nextMajor: number | null;
  /** App Router route files (page/route/layout/metadata conventions). */
  routes: RouteFileInfo[];
  /** skeleton claim per App Router route file (repo-relative file → claim). */
  skeletonClaims: Map<string, Claim<string | null>>;
  /** concreteValues claim per App Router route file (repo-relative file → claim). */
  concreteValuesClaims: Map<string, Claim<string[] | null>>;
  methodsClaims: Map<string, Claim<string[]>>;
  /** file → adapter delegation (embedded framework). */
  adapters: Map<string, { frameworkName: string; viaSpecifier: string; delegatedExports: string[] }>;
  edgeEntries: EdgeEntryInfo[];
  specialFileCounts: Record<string, number>;
  /** Pages Router route files — full inventory with claims (B2; no longer comparison-only). */
  pagesRoutes: PagesRouteInfo[];
  /** App-vs-Pages same-URL conflicts (pages wins). */
  routerConflicts: RouterConflict[];
  /** Per-router evidence from independent per-directory detection (B2). */
  routerEvidence: RouterEvidence[];
  /** App-level next.config summary (drives concreteValues confidence). */
  nextConfig: NextConfigSummary;
  /**
   * Root App Router layouts (special `layout` files directly under the
   * app-router root, i.e. zero segments). Structural evidence for the
   * "Start here" orientation section.
   */
  rootLayouts: string[];
  /**
   * instrumentation.ts/js startup hooks detected at the app root/src.
   * Populated by the top-level pipeline (same pass that records the note);
   * structural evidence for "Start here".
   */
  instrumentationFiles: string[];
  notes: string[];
  unknowns: UnknownItem[];
}

async function dirExists(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

function relDir(appDir: string, sub: string): string {
  return appDir ? `${appDir}/${sub}` : sub;
}

/** App Router evidence: walk `app/` and `src/app/` independently of any pages/ state. */
async function detectAppRouter(
  repoRoot: string,
  appAbsDir: string,
  appRelDir: string,
): Promise<{ evidence: RouterEvidence; routes: RouteFileInfo[] }> {
  const dirs: string[] = [];
  const routes: RouteFileInfo[] = [];
  for (const sub of ['app', 'src/app']) {
    const abs = join(appAbsDir, sub);
    if (!(await dirExists(abs))) continue;
    dirs.push(relDir(appRelDir, sub));
    routes.push(...(await collectRouteFiles(repoRoot, abs)));
  }
  routes.sort((a, b) => (a.file < b.file ? -1 : 1));
  const found = routes.length > 0;
  const locations = [`${relDir(appRelDir, 'app')}`, `${relDir(appRelDir, 'src/app')}`].join(' / ');
  const evidence: RouterEvidence = {
    router: 'app-router',
    detected: found
      ? resolved(true, `${routes.length} route-convention file(s) under ${dirs.join(', ')}`)
      : resolved(false, `no App Router route files under ${locations}`),
    dirs,
    routeFileCount: routes.length,
  };
  return { evidence, routes };
}

/**
 * Pages Router evidence: walk `pages/` and `src/pages/` independently of any
 * app/ state. Evidence requires actual routable page files (collectPagesRoutes
 * already excludes _app/_document/404/500/_-prefixed files).
 */
async function detectPagesRouter(
  repoRoot: string,
  appAbsDir: string,
  appRelDir: string,
  nextConfig: NextConfigSummary,
): Promise<{ evidence: RouterEvidence; routes: PagesRouteInfo[] }> {
  const dirs: string[] = [];
  for (const sub of ['pages', 'src/pages']) {
    if (await dirExists(join(appAbsDir, sub))) dirs.push(relDir(appRelDir, sub));
  }
  const raw = (await collectPagesRoutes(repoRoot, appAbsDir)) ?? [];
  const locations = [`${relDir(appRelDir, 'pages')}`, `${relDir(appRelDir, 'src/pages')}`].join(' / ');
  const found = raw.length > 0;
  const evidence: RouterEvidence = {
    router: 'pages-router',
    detected: found
      ? resolved(true, `${raw.length} routable page file(s) under ${dirs.join(', ')}`)
      : resolved(false, `no Pages Router page files under ${locations}`),
    dirs,
    routeFileCount: raw.length,
  };
  const routes: PagesRouteInfo[] = raw.map((p) => {
    const skeleton = resolved(p.url, 'Pages Router file-convention mapping (pages/ path → URL per documented Next.js rules)');
    return {
      file: p.file,
      url: p.url,
      isApi: p.isApi,
      skeleton,
      concreteValues: concreteValuesClaim(skeleton, nextConfig),
      // M0 does not inventory per-handler HTTP methods from syntax alone.
      methods: { value: [], confidence: 'U' as const, reason: 'HTTP methods not inventoried for Pages Router routes in M0' },
    };
  });
  return { evidence, routes };
}

/** Independent per-directory detection of both routers (the B2 general rule). */
async function detectRouters(
  repoRoot: string,
  candidate: AppCandidate,
  nextConfig: NextConfigSummary,
): Promise<HybridDetection> {
  const appAbsDir = join(repoRoot, candidate.dir);
  const app = await detectAppRouter(repoRoot, appAbsDir, candidate.dir);
  const pages = await detectPagesRouter(repoRoot, appAbsDir, candidate.dir, nextConfig);
  const isHybrid = app.evidence.detected.value && pages.evidence.detected.value;
  return {
    app: app.evidence,
    pages: pages.evidence,
    isHybrid,
    appRoutes: app.routes,
    pagesRoutes: pages.routes,
  };
}

/** Framework id from independent per-router evidence (no app-level single-router classification). */
function frameworkIdFor(appEv: RouterEvidence, pagesEv: RouterEvidence): string {
  const a = appEv.detected.value;
  const p = pagesEv.detected.value;
  if (a && p) return 'nextjs-hybrid';
  if (a) return 'nextjs-app-router';
  if (p) return 'nextjs-pages-router';
  return 'nextjs-unknown';
}

export async function analyzeFrameworkApp(
  repoRoot: string,
  candidate: AppCandidate,
  getRecord: (relPath: string) => Promise<ModuleRecord | null>,
): Promise<FrameworkAppResult> {
  const notes: string[] = [];
  const unknowns: UnknownItem[] = [];
  const nextMajor = nextMajorOf(candidate.nextRange);

  // App-level next.config facts (drive concreteValues confidence) — computed
  // before detection so Pages routes get concreteValues claims too.
  const nextConfig = await summarizeNextConfig(repoRoot, candidate.dir);

  // B2: both routers detected independently; neither gates the other.
  const detection = await detectRouters(repoRoot, candidate, nextConfig);
  const routerEvidence: RouterEvidence[] = [detection.app, detection.pages];

  // Framework id + confidence from the independent evidence.
  const frameworkId = frameworkIdFor(detection.app, detection.pages);
  const anyRouter = detection.app.detected.value || detection.pages.detected.value;
  let frameworkClaim: Claim<string>;
  if (candidate.nextRange && anyRouter) {
    frameworkClaim = resolved(frameworkId, '`next` in package.json deps + router conventions present');
  } else if (anyRouter) {
    frameworkClaim = inferred(frameworkId, 'router conventions present but `next` not found in package.json deps');
  } else {
    frameworkClaim = inferred(frameworkId, 'weak evidence');
  }

  if (detection.isHybrid) {
    notes.push(
      `hybrid app: App Router (${detection.app.routeFileCount} route files under ${detection.app.dirs.join(', ')}) + ` +
        `Pages Router (${detection.pages.routeFileCount} route files under ${detection.pages.dirs.join(', ')}) ` +
        'detected independently per directory',
    );
  }
  const expectation = edgeExpectationNote(nextMajor);
  if (expectation) notes.push(expectation);

  // ---- App Router routes ----
  const routes: RouteFileInfo[] = [];
  const skeletonClaims = new Map<string, Claim<string | null>>();
  const concreteValuesClaims = new Map<string, Claim<string[] | null>>();
  const methodsClaims = new Map<string, Claim<string[]>>();
  const adapters = new Map<string, { frameworkName: string; viaSpecifier: string; delegatedExports: string[] }>();
  const specialFileCounts: Record<string, number> = {};
  const rootLayouts: string[] = [];
  let dynamicRouteCount = 0;
  let slotCount = 0;

  for (const f of detection.appRoutes) {
    if (f.kind === 'special') {
      specialFileCounts[f.leaf] = (specialFileCounts[f.leaf] ?? 0) + 1;
      // Root layout = app shell: structural evidence for "Start here".
      if (f.leaf === 'layout' && f.segments.length === 0) rootLayouts.push(f.file);
      continue;
    }
    routes.push(f);
    const rec = await getRecord(f.file);
    // Adapter delegation (embedded framework) — only meaningful for route.ts.
    let adapter: { frameworkName: string; viaSpecifier: string; delegatedExports: string[] } | null = null;
    if (f.kind === 'route' && rec) {
      const d = detectAdapterDelegation(rec);
      if (d) {
        adapter = d;
        adapters.set(f.file, d);
      }
    }
    const mapping = mapUrl(f);
    let skeleton: Claim<string | null>;
    if (adapter) {
      // The file IS a route file (R), but its effective URL space belongs to
      // the embedded framework — endpoints Unknown, skeleton null.
      skeleton = {
        value: null,
        confidence: 'U',
        reason: `embedded framework detected (${adapter.frameworkName} via ${adapter.viaSpecifier}) — endpoints Unknown; a Next-only detector must not claim this as one API route`,
      };
      unknowns.push({
        area: `${adapter.frameworkName} endpoint surface`,
        detail: `${f.file} delegates to embedded ${adapter.frameworkName} (via ${adapter.viaSpecifier}); the ${adapter.frameworkName} route surface needs a ${adapter.frameworkName} detector`,
        reason: 'embedded framework detected — endpoints Unknown',
      });
    } else if (mapping.confidence === 'R') {
      skeleton = resolved(mapping.url, mapping.reason);
    } else {
      skeleton = {
        value: mapping.url,
        confidence: mapping.confidence,
        reason: mapping.reason,
      };
    }
    if (mapping.notes.length > 0) {
      notes.push(`${f.file}: ${mapping.notes.join('; ')}`);
      slotCount++;
    }
    skeletonClaims.set(f.file, skeleton);
    concreteValuesClaims.set(f.file, concreteValuesClaim(skeleton, nextConfig));
    // M0 does not inventory per-handler HTTP methods from syntax alone.
    const methods = f.kind === 'route' && rec
      ? rec.exportShape.namedExports.filter((n) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(n))
      : [];
    methodsClaims.set(
      f.file,
      methods.length > 0
        ? resolved(methods, 'exported HTTP-method handlers in route.ts')
        : { value: [], confidence: 'U' as const, reason: 'HTTP methods not inventoried in M0' },
    );
    if (hasDynamicSegments(f)) dynamicRouteCount++;
  }

  if (Object.keys(specialFileCounts).length > 0) {
    notes.push(
      'special files: ' +
        Object.entries(specialFileCounts).map(([k, v]) => `${v} ${k}`).join(', '),
    );
  }
  if (dynamicRouteCount > 0) {
    unknowns.push({
      area: 'dynamic segments',
      detail: `${dynamicRouteCount} route files contain dynamic segments; concrete URLs depend on runtime data — URL space unbounded`,
      reason: 'concrete segment values unknowable statically',
    });
  }
  if (slotCount > 0) {
    unknowns.push({
      area: 'parallel slot rendering',
      detail: `${slotCount} route files under parallel slots (@...); which slot content renders is conditional on navigation state`,
      reason: 'slot rendering is runtime-conditional',
    });
  }

  // ---- Router conflict detection: same effective URL in both routers ----
  // (B2: now compares the full App Router skeleton set against the full
  // Pages Router inventory). Next.js serves the Pages Router version
  // (pages-wins).
  const routerConflicts: RouterConflict[] = [];
  const pagesRoutes = detection.pagesRoutes;
  if (pagesRoutes.length > 0 && routes.length > 0) {
    const skeletonByUrl = new Map<string, string>();
    for (const f of routes) {
      const sk = skeletonClaims.get(f.file)?.value;
      if (sk && !skeletonByUrl.has(sk)) skeletonByUrl.set(sk, f.file);
    }
    for (const p of pagesRoutes) {
      const hit = skeletonByUrl.get(p.url);
      if (hit) {
        routerConflicts.push({ url: p.url, appRouterFile: hit, pagesRouterFile: p.file, winner: 'pages' });
      }
    }
    if (routerConflicts.length > 0) {
      notes.push(
        `hybrid: ${routerConflicts.length} same-URL App-vs-Pages conflict(s); ` +
          'Next.js serves the Pages Router version (pages-wins); see routerConflicts',
      );
      unknowns.push({
        area: 'router conflict',
        detail: `${routerConflicts.length} URL(s) exist in both App Router and Pages Router (${routerConflicts.map((c) => c.url).join(', ')}); pages wins per Next.js`,
        reason: 'same effective URL in both routers — serving is Pages Router',
      });
    } else {
      notes.push(
        `hybrid: checked ${skeletonByUrl.size} App Router URL(s) against ${pagesRoutes.length} Pages Router URL(s) — 0 same-URL conflicts`,
      );
    }
  }

  // Edge entries (proxy.ts / middleware.ts).
  const edgeEntries = await detectEdgeEntries(repoRoot, candidate.dir, getRecord, nextMajor);
  const proxyFiles = edgeEntries.filter((e) => e.kind === 'proxy');
  const mwFiles = edgeEntries.filter((e) => e.kind === 'middleware');
  if (proxyFiles.length > 0 && mwFiles.length > 0) {
    notes.push(
      `both proxy.ts and middleware.ts present (${[...proxyFiles, ...mwFiles].map((e) => e.file).join(', ')}) — Next ≥16 prefers proxy.ts`,
    );
  }
  for (const e of edgeEntries) {
    if (e.wrapper) {
      unknowns.push({
        area: 'auth gating',
        detail: `${e.file} default export is wrapped in ${e.wrapper}(...); wrapper behavior (e.g. session handling, redirects) needs the wrapper's internals`,
        reason: 'wrapper internals not analyzed in M0',
      });
    }
  }
  if (edgeEntries.length === 0) {
    unknowns.push({
      area: 'auth enforcement',
      detail: `no proxy.ts/middleware.ts edge entry in ${candidate.dir || '(repo root)'}; auth (if any) lives in framework adapters or layouts`,
      reason: 'no edge front door detected',
    });
  }

  return {
    candidate,
    frameworkId,
    frameworkClaim,
    nextMajor,
    routes,
    skeletonClaims,
    concreteValuesClaims,
    methodsClaims,
    adapters,
    edgeEntries,
    specialFileCounts,
    pagesRoutes,
    routerConflicts,
    routerEvidence,
    nextConfig,
    rootLayouts,
    instrumentationFiles: [],
    notes,
    unknowns,
  };
}

export type { RouterEvidence, RouterId, HybridDetection, PagesRouteInfo } from './types.js';
