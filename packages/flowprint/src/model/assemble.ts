/**
 * Flowprint M0 — model layer: assemble the AnalysisResult.
 *
 * EVERY claim in the output gets its R/I/U confidence + reason HERE.
 * The renderer must never invent confidence.
 */
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { AppCandidate } from '../discovery/index.js';
import type { ResolutionContext } from '../resolution/index.js';
import { resolveImport } from '../resolution/index.js';
import { splitBare } from '../resolution/tsconfig.js';
import type { ModuleRecord } from '../parsing/index.js';
import type { FrameworkAppResult } from '../framework/index.js';
import type { UnsupportedBoundary } from '../boundaries/types.js';
import type {
  AnalysisResult,
  AliasInfo,
  AppInfo,
  Claim,
  Confidence,
  EntryPoint,
  ImportProbeResult,
  ResolutionStats,
  RouteInfo,
  ServerActionInfo,
  StartHereItem,
  TrpcProcedure,
  UnknownItem,
} from './types.js';
import { resolved, unknown } from './types.js';

export interface ModelInput {
  repoRoot: string;
  repoName: string;
  durationMs: number;
  records: Map<string, ModuleRecord>;
  sourceFiles: string[];
  fwApps: FrameworkAppResult[];
  probes: Array<{ fromFile: string; specifier: string }>;
  ctx: ResolutionContext;
  /** Extra unknowns gathered during analysis (config scans, etc.). */
  extraUnknowns: UnknownItem[];
  /** Per-app server-action inventories, keyed by app dir. */
  serverActionsByApp: Map<string, ServerActionInfo[]>;
  /** tRPC procedures enumerated from validated adapter-anchored patterns. */
  trpcProcedures: TrpcProcedure[];
  /** Detected-but-unsupported boundaries (B3); detected from global discovery. */
  boundaries: UnsupportedBoundary[];
}

export async function assembleResult(input: ModelInput): Promise<AnalysisResult> {
  const { repoRoot, records, fwApps, ctx } = input;

  // ---- Apps ----
  const apps: AppInfo[] = [];
  for (const fw of fwApps) {
    const cand = fw.candidate;
    const tsconfigs = await appTsconfigs(repoRoot, cand, ctx);
    const aliases = await appAliases(repoRoot, cand, ctx, input.extraUnknowns);
    apps.push({
      path: cand.dir,
      framework: fw.frameworkClaim,
      tsconfigs,
      aliases,
      notes: [...fw.notes],
      serverActions: input.serverActionsByApp.get(cand.dir) ?? [],
      startHere: buildStartHere(fw),
      routerConflicts: fw.routerConflicts,
      routers: fw.routerEvidence,
    });
  }
  apps.sort((a, b) => (a.path < b.path ? -1 : 1));

  // ---- Entry points ----
  const entryPoints: EntryPoint[] = [];
  for (const fw of fwApps) {
    for (const e of fw.edgeEntries) {
      const kind: Claim<string> = resolved(
        e.kind,
        `${e.file} at app root/src with ${e.shape} (location + export shape)`,
      );
      entryPoints.push({ file: e.file, kind });
    }
  }
  entryPoints.sort((a, b) => (a.file < b.file ? -1 : 1));

  // ---- Routes (B2: both routers reported independently) ----
  const routes: RouteInfo[] = [];
  for (const fw of fwApps) {
    const appEv = fw.routerEvidence.find((e) => e.router === 'app-router');
    for (const r of fw.routes) {
      const skeleton = fw.skeletonClaims.get(r.file) ?? unknown(null, 'no URL mapping produced');
      const concreteValues =
        fw.concreteValuesClaims.get(r.file) ?? unknown(null, 'no concrete-values mapping produced');
      const methods = fw.methodsClaims.get(r.file) ?? unknown([], 'no method inventory');
      routes.push({
        file: r.file,
        router: resolved('app-router', appEv?.detected.reason ?? 'App Router route file'),
        skeleton,
        concreteValues,
        methods,
      });
    }
    const pagesEv = fw.routerEvidence.find((e) => e.router === 'pages-router');
    for (const p of fw.pagesRoutes) {
      routes.push({
        file: p.file,
        router: resolved('pages-router', pagesEv?.detected.reason ?? 'Pages Router route file'),
        skeleton: p.skeleton,
        concreteValues: p.concreteValues,
        methods: p.methods,
      });
    }
  }
  routes.sort((a, b) => (a.file < b.file ? -1 : 1));

  // ---- Resolution stats: resolve every import edge of every parsed file ----
  const stats: ResolutionStats = { total: 0, resolvedR: 0, resolvedI: 0, unresolvedU: 0, typeOnly: 0 };
  const seenFallback = new Set<string>();
  for (const rel of input.sourceFiles) {
    const rec = records.get(rel);
    if (!rec) continue;
    const abs = resolvePath(repoRoot, rel);
    const edges: Array<{ spec: string; typeOnly: boolean }> = [];
    for (const imp of rec.imports) edges.push({ spec: imp.specifier, typeOnly: imp.typeOnly });
    // Re-export chains (`export * from`, `export { x } from`) are import edges too.
    for (const exp of rec.exports) {
      if (exp.from) edges.push({ spec: exp.from, typeOnly: exp.typeOnly });
    }
    for (const req of rec.requires) {
      if (req.specifier) edges.push({ spec: req.specifier, typeOnly: false });
      else {
        stats.total++;
        stats.unresolvedU++;
      }
    }
    for (const dyn of rec.dynamicImports) {
      if (dyn.specifier) edges.push({ spec: dyn.specifier, typeOnly: false });
      else {
        stats.total++;
        stats.unresolvedU++;
      }
    }
    for (const e of edges) {
      stats.total++;
      if (e.typeOnly) stats.typeOnly++;
      const r = await resolveImport(ctx, abs, e.spec);
      if (r.claim.confidence === 'R') stats.resolvedR++;
      else if (r.claim.confidence === 'I') stats.resolvedI++;
      else stats.unresolvedU++;
      if (r.claim.reason.includes('dist→src fallback')) {
        const key = `${rel}::${e.spec}`;
        if (!seenFallback.has(key)) {
          seenFallback.add(key);
          input.extraUnknowns.push({
            area: 'dist-vs-src fallback',
            detail: `${e.spec} in ${rel}: exports/main point at absent build output → src/ fallback used (I)`,
            reason: 'whether dist layout mirrors src layout is an inference',
          });
        }
      }
    }
  }

  // ---- Import probes (harness-supplied) ----
  const importProbes: ImportProbeResult[] = [];
  for (const p of input.probes) {
    const abs = resolvePath(repoRoot, p.fromFile);
    const rec = records.get(p.fromFile);
    let typeOnly = false;
    if (rec) {
      const imp = rec.imports.find((i) => i.specifier === p.specifier);
      if (imp) typeOnly = imp.typeOnly;
    }
    const r = await resolveImport(ctx, abs, p.specifier);
    importProbes.push({
      fromFile: p.fromFile,
      specifier: p.specifier,
      resolved: r.claim,
      typeOnly,
    });
  }

  // ---- Unknowns (de-duplicated) ----
  const unknowns: UnknownItem[] = [...input.extraUnknowns];
  for (const fw of fwApps) unknowns.push(...fw.unknowns);
  const seen = new Set<string>();
  const deduped = unknowns.filter((u) => {
    const k = `${u.area}::${u.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    repo: input.repoName,
    durationMs: input.durationMs,
    apps,
    entryPoints,
    routes,
    trpcProcedures: input.trpcProcedures,
    importProbes,
    resolutionStats: stats,
    unknowns: deduped,
    boundaries: input.boundaries,
  };
}

/**
 * "Start here" orientation selection — deterministic, structural only.
 *
 * Answers "where should I start reading this application?" from evidence the
 * analyzer already holds. Priority order (fixed, never popularity-based):
 *   1. root App Router layout — the app shell wrapping every route
 *   2. root page — serves the app's base URL
 *   3. root Pages Router page — serves / (for pages/hybrid apps)
 *   4. proxy/middleware edge entries — the request boundary
 *   5. instrumentation.ts/js — the startup hook
 *   6. shallowest page route (I) — representative entry when no root page exists
 * Capped at 7 items. Every item carries a structural reason; nothing is
 * invented. This is intentionally NOT the same as `entryPoints` (raw edge
 * boundaries), which is kept as a separate section.
 */
export function buildStartHere(fw: FrameworkAppResult): StartHereItem[] {
  const items: StartHereItem[] = [];
  const seen = new Set<string>();
  const push = (file: string, confidence: Confidence, reason: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    items.push({ file, confidence, reason });
  };

  for (const f of fw.rootLayouts) {
    push(f, 'R', 'root App Router layout — wraps every route in the app');
  }

  const appPages = fw.routes.filter((r) => r.kind === 'page');
  // Root page: the page file serving '/'. Prefer the file at the router root;
  // otherwise a group-wrapped page whose mapped skeleton URL is '/' — still R,
  // because the URL mapping itself is resolved from file conventions.
  const rootPage =
    appPages.find((r) => r.segments.length === 0) ??
    appPages.find((r) => fw.skeletonClaims.get(r.file)?.value === '/');
  if (rootPage) {
    push(rootPage.file, 'R', "root page — serves the app's base URL");
  }

  const rootPagesRoute = fw.pagesRoutes.find((p) => p.url === '/');
  if (rootPagesRoute) {
    push(rootPagesRoute.file, 'R', 'root Pages Router page — serves /');
  }

  for (const e of fw.edgeEntries) {
    push(e.file, 'R', `request boundary — ${e.kind}.ts runs before routing`);
  }

  for (const f of fw.instrumentationFiles) {
    push(f, 'R', 'startup hook — instrumentation.ts runs once when the server starts');
  }

  if (!rootPage && !rootPagesRoute && appPages.length > 0) {
    const shallowest = [...appPages].sort(
      (a, b) => a.segments.length - b.segments.length || (a.file < b.file ? -1 : 1),
    )[0];
    push(
      shallowest.file,
      'I',
      'shallowest page route — representative entry (no root page exists)',
    );
  }

  return items.slice(0, 7);
}

/** Nearest tsconfig for the app dir (repo-relative paths). */
async function appTsconfigs(  repoRoot: string,
  cand: AppCandidate,
  ctx: ResolutionContext,
): Promise<string[]> {
  const ts = await ctx.ts.nearestFor(join(repoRoot, cand.dir));
  if (!ts) return [];
  return [ts.path];
}

/**
 * Aliases for an app: the nearest tsconfig's OWN paths plus inherited
 * preset paths, each attributed to its owning tsconfig. Dead targets
 * are surfaced as unknowns.
 */
async function appAliases(
  repoRoot: string,
  cand: AppCandidate,
  ctx: ResolutionContext,
  extraUnknowns: UnknownItem[],
): Promise<AliasInfo[]> {
  const ts = await ctx.ts.nearestFor(join(repoRoot, cand.dir));
  if (!ts) return [];
  const out: AliasInfo[] = [];
  const chain: Array<{ owner: string; paths: Record<string, string[]> }> = [
    { owner: ts.path, paths: ts.ownPaths },
  ];
  for (const extRel of ts.extendsChain) {
    if (extRel.startsWith('(unresolved:')) continue;
    const preset = await ctx.ts.load(resolvePath(repoRoot, extRel));
    if (preset && Object.keys(preset.ownPaths).length > 0) {
      chain.push({ owner: preset.path, paths: preset.ownPaths });
    }
  }
  const seenAlias = new Set<string>();
  for (const { owner, paths } of chain) {
    const ownerAbs = resolvePath(repoRoot, owner);
    const ownerTs = await ctx.ts.load(ownerAbs);
    const baseAbs = ownerTs?.baseUrlAbs ?? resolvePath(ownerAbs, '..');
    for (const [pattern, targets] of Object.entries(paths)) {
      const key = `${owner}::${pattern}`;
      if (seenAlias.has(key)) continue;
      seenAlias.add(key);
      out.push({
        pattern,
        targets,
        ownerTsconfig: owner,
        confidence: 'R',
        reason: `paths mapping declared in ${owner}`,
      });
      for (const t of targets) {
        const starIdx = t.indexOf('*');
        const base = starIdx === -1 ? t : t.slice(0, starIdx);
        if (base.startsWith('.')) {
          const absBase = resolvePath(baseAbs, base);
          if (!existsSync(absBase)) {
            extraUnknowns.push({
              area: 'stale tsconfig entries',
              detail: `alias ${pattern} → ${t} in ${owner}: target base does not exist (dead alias)`,
              reason: 'alias target absent on disk',
            });
          }
        } else {
          // Bare-specifier target (chained alias): must name a known workspace package.
          const { name } = splitBare(base.replace(/\/$/, ''));
          if (!ctx.nameToDir.has(name)) {
            extraUnknowns.push({
              area: 'stale tsconfig entries',
              detail: `alias ${pattern} → ${t} in ${owner}: chained bare target "${name}" is not a known workspace package`,
              reason: 'chained alias target unresolvable',
            });
          }
        }
      }
    }
  }
  out.sort((a, b) => (a.pattern < b.pattern ? -1 : 1));
  return out;
}
