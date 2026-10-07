/**
 * Flowprint M0 — render layer: text-only terminal report.
 *
 * Renders claims created by the model layer. NEVER invents confidence.
 */
import type { AnalysisResult } from '../model/types.js';
import { renderBoundaries } from './boundaries.js';
import { FLOWPRINT_VERSION } from '../version.js';

function pct(n: number, total: number): string {
  if (total === 0) return 'n/a';
  return `${((n / total) * 100).toFixed(1)}%`;
}

export function renderReport(r: AnalysisResult): string {
  const lines: string[] = [];
  const bar = '='.repeat(60);

  lines.push(bar);
  lines.push(`Flowprint ${FLOWPRINT_VERSION} — ${r.repo}`);
  lines.push(`analyzed in ${(r.durationMs / 1000).toFixed(1)}s`);
  lines.push(bar);
  lines.push('');

  // Repository
  lines.push('## Repository');
  lines.push(`  path: ${r.repo}`);
  lines.push(`  apps: ${r.apps.length}`);
  lines.push('');

  // Applications
  lines.push('## Applications');
  if (r.apps.length === 0) {
    lines.push('  (none detected)');
  }
  for (const app of r.apps) {
    lines.push(`  ${app.path || '(root)'}`);
    lines.push(`    framework: [${app.framework.confidence}] ${app.framework.value}`);
    lines.push(`      reason: ${app.framework.reason}`);
    lines.push(`    tsconfigs: ${app.tsconfigs.join(', ') || '(none)'}`);
    if (app.aliases.length > 0) {
      lines.push('    aliases:');
      for (const a of app.aliases) {
        lines.push(`      [${a.confidence}] ${a.pattern} -> ${a.targets.join(', ')}  (${a.ownerTsconfig})`);
      }
    }
    if (app.routerConflicts.length > 0) {
      lines.push('    router conflicts (pages-wins):');
      for (const c of app.routerConflicts) {
        lines.push(`      [R] ${c.url}  app=${c.appRouterFile}  pages=${c.pagesRouterFile}`);
      }
    }
    for (const n of app.notes) lines.push(`    note: ${n}`);
  }
  lines.push('');

  // Unsupported boundaries (B3): detected-but-unsupported frameworks.
  // "No routes shown" must never read as "no routes exist".
  const bsec = renderBoundaries(r.boundaries);
  if (bsec) lines.push(bsec);

  // Entry points (raw edge boundaries — kept separate from "Start here").
  lines.push('## Entry points');
  if (r.entryPoints.length === 0) {
    lines.push('  (none detected)');
  }
  for (const e of r.entryPoints) {
    lines.push(`  [${e.kind.confidence}] ${e.file}  kind=${e.kind.value}`);
    lines.push(`      reason: ${e.kind.reason}`);
  }
  lines.push('');

  // Start here — orientation: where to start reading. Deterministic,
  // structural evidence only; each item carries its reason.
  lines.push('## Start here');
  const appsWithStart = r.apps.filter((a) => a.startHere.length > 0);
  if (appsWithStart.length === 0) {
    lines.push('  (no structural starting points detected)');
  }
  for (const app of appsWithStart) {
    lines.push(`  ${app.path || '(root)'}:`);
    for (const s of app.startHere) {
      lines.push(`    [${s.confidence}] ${s.file}`);
      lines.push(`        reason: ${s.reason}`);
    }
  }
  lines.push('');

  // Routes — B2: both routers reported independently, each route carrying
  // its own R/I/U claims (the renderer never invents confidence).
  const renderRoute = (route: (typeof r.routes)[number]): void => {
    const sk = route.skeleton.value == null ? '(unknown)' : route.skeleton.value;
    const methods = route.methods.value.length > 0 ? ` [${route.methods.value.join(',')}]` : '';
    lines.push(`  [${route.skeleton.confidence}] ${sk}${methods}  <- ${route.file}`);
    if (route.skeleton.confidence !== 'R') lines.push(`      reason: ${route.skeleton.reason}`);
    const cv = route.concreteValues;
    const cvVal = cv.value == null ? '(null)' : `[${cv.value.map((u) => `"${u}"`).join(', ')}]`;
    lines.push(`      concrete: [${cv.confidence}] ${cvVal}`);
    if (cv.confidence !== 'R') lines.push(`        reason: ${cv.reason}`);
  };
  const appRoutes = r.routes.filter((x) => x.router.value === 'app-router');
  const pagesRoutes = r.routes.filter((x) => x.router.value === 'pages-router');
  lines.push('## Routes — App Router');
  if (appRoutes.length === 0) {
    lines.push('  (none detected)');
  }
  for (const route of appRoutes) renderRoute(route);
  lines.push(`  total: ${appRoutes.length} App Router route files`);
  lines.push('');
  lines.push('## Routes — Pages Router');
  if (pagesRoutes.length === 0) {
    lines.push('  (none detected)');
  }
  for (const route of pagesRoutes) renderRoute(route);
  lines.push(`  total: ${pagesRoutes.length} Pages Router route files`);
  lines.push('');

  // Server actions (per app): direct async exports plus wrapped/builder
  // candidates. A module with candidates is never reported as empty.
  lines.push('## Server actions');
  const appsWithActions = r.apps.filter((a) => a.serverActions.length > 0);
  if (appsWithActions.length === 0) {
    lines.push('  (none inventoried)');
  }
  for (const app of appsWithActions) {
    lines.push(`  ${app.path || '(root)'}:`);
    for (const sa of app.serverActions) {
      lines.push(`    [${sa.scope.confidence}] ${sa.scope.value}  ${sa.file}`);
      const direct = sa.actions.value;
      if (direct.length > 0) {
        lines.push(`        direct actions [${sa.actions.confidence}]: ${direct.join(', ')}`);
        if (sa.actions.confidence !== 'R') lines.push(`        reason: ${sa.actions.reason}`);
      } else if (sa.actionCandidates.length === 0) {
        lines.push(`        (no server-action exports detected)`);
      } else {
        lines.push(`        direct actions: (none detected)`);
      }
      if (sa.actionCandidates.length > 0) {
        lines.push(`        action candidates:`);
        for (const c of sa.actionCandidates) {
          lines.push(`          [${c.confidence}] ${c.name}`);
          lines.push(`            reason: ${c.reason}`);
        }
      }
    }
  }
  lines.push('');

  // tRPC procedures (validated patterns only)
  lines.push('## tRPC procedures');
  if (r.trpcProcedures.length === 0) {
    lines.push('  (none enumerated — see Unknown for tRPC surface notes)');
  }
  for (const p of r.trpcProcedures.slice(0, 80)) {
    lines.push(`  [${p.confidence}] ${p.path}  <- ${p.handlerFile}`);
    if (p.confidence !== 'R') lines.push(`      reason: ${p.reason}`);
  }
  if (r.trpcProcedures.length > 80) lines.push(`  ... and ${r.trpcProcedures.length - 80} more`);
  lines.push(`  total: ${r.trpcProcedures.length} procedures`);
  lines.push('');

  // Module resolution
  const s = r.resolutionStats;
  lines.push('## Module resolution');
  lines.push(`  edges: ${s.total}  R=${s.resolvedR} (${pct(s.resolvedR, s.total)})  I=${s.resolvedI}  U=${s.unresolvedU}  type-only=${s.typeOnly}`);
  if (r.importProbes.length > 0) {
    lines.push('  probes:');
    for (const p of r.importProbes) {
      const v = p.resolved.value == null ? '(unresolved)' : p.resolved.value;
      const t = p.typeOnly ? ' [type-only]' : '';
      lines.push(`    [${p.resolved.confidence}] ${p.fromFile} :: ${p.specifier}${t}`);
      lines.push(`        -> ${v}`);
    }
  }
  lines.push('');

  // Unknowns
  lines.push('## Unknown');
  if (r.unknowns.length === 0) {
    lines.push('  (none)');
  }
  for (const u of r.unknowns.slice(0, 60)) {
    lines.push(`  [U] ${u.area}: ${u.detail}`);
    lines.push(`      reason: ${u.reason}`);
  }
  if (r.unknowns.length > 60) lines.push(`  ... and ${r.unknowns.length - 60} more`);
  lines.push('');
  lines.push(bar);

  return lines.join('\n');
}
