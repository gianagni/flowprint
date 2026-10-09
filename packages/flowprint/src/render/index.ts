/**
 * Flowprint S4 — orientation renderer: six-section default report + --full.
 *
 * Renders the S3 finding model faithfully:
 * - kind=fact       → printed as observed facts, NEVER labeled [U].
 * - kind=uncertainty → printed as [U] with traceable reason.
 * - kind=coverage   → printed as statistics / limitations / scope notes.
 *
 * The renderer never invents confidence and never drops a category:
 * every finding category present in the model appears in the default
 * report (grouped, with accurate counts); --full exposes every modeled
 * occurrence with no renderer truncation.
 *
 * Text only, no ANSI, deterministic ordering, pipe-safe.
 */
import type {
  AnalysisResult,
  AppInfo,
  Finding,
  FindingCategory,
  RouteInfo,
} from '../model/types.js';
import { renderBoundaries } from './boundaries.js';
import { CHECKED_UNSUPPORTED_APP_FRAMEWORKS } from '../discovery/index.js';
import { CHECKED_FRAMEWORKS } from '../boundaries/detect.js';
import { FLOWPRINT_VERSION } from '../version.js';

const BAR = '='.repeat(60);

/** Max Start-here items in the default report (spec: at most ~7). */
const START_HERE_BUDGET = 7;
/** Max example occurrences per blind-spot category in the default report. */
const BLIND_SPOT_EXAMPLES = 3;
/** Max dir-read-failure paths shown in default Coverage (TR-006/AC-047). */
const DIR_FAILURE_PATHS = 5;

function sortFindings(fs: Finding[]): Finding[] {
  return [...fs].sort((a, b) =>
    a.category < b.category ? -1
    : a.category > b.category ? 1
    : a.subject < b.subject ? -1
    : a.subject > b.subject ? 1
    : 0,
  );
}

function byKind(r: AnalysisResult, kind: 'fact' | 'uncertainty' | 'coverage'): Finding[] {
  return sortFindings(r.unknowns.filter((f) => f.kind === kind));
}

function groupByCategory(fs: Finding[]): Map<FindingCategory, Finding[]> {
  const m = new Map<FindingCategory, Finding[]>();
  for (const f of fs) {
    const arr = m.get(f.category) ?? [];
    arr.push(f);
    m.set(f.category, arr);
  }
  return new Map([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function appLabel(app: AppInfo): string {
  return app.path || '(root)';
}

// ---------------------------------------------------------------- header

function renderHeader(r: AnalysisResult): string[] {
  const lines: string[] = [];
  lines.push(BAR);
  const apps = r.apps.map(appLabel).join(', ') || '(no app analyzed)';
  lines.push(`Flowprint ${FLOWPRINT_VERSION} — ${r.repo} / ${apps}`);
  lines.push(`analyzed in ${(r.durationMs / 1000).toFixed(1)}s`);
  lines.push(BAR);
  lines.push('');
  for (const app of r.apps) {
    const ver = app.nextVersion ? `  (next ${app.nextVersion})` : '';
    lines.push(`Framework  [${app.framework.confidence}] ${app.framework.value}${ver}  — ${appLabel(app)}`);
    lines.push(`  reason: ${app.framework.reason}`);
  }
  if (r.apps.length === 0) {
    lines.push('(no supported application analyzed)');
  }
  lines.push('');
  return lines;
}

// ---------------------------------------------------------------- start here

function renderStartHere(r: AnalysisResult, full: boolean): string[] {
  const lines: string[] = [];
  lines.push('Start here');
  const items = r.apps.flatMap((a) =>
    a.startHere.map((s) => ({ app: appLabel(a), ...s })),
  );
  if (items.length === 0) {
    lines.push('  (no structural starting points detected)');
  }
  const shown = full ? items : items.slice(0, START_HERE_BUDGET);
  for (const s of shown) {
    const appPrefix = r.apps.length > 1 ? `${s.app}: ` : '';
    lines.push(`  [${s.confidence}] ${appPrefix}${s.file} — ${s.reason}`);
  }
  if (!full && items.length > shown.length) {
    lines.push(`  +${items.length - shown.length} more — re-run with --full`);
  }
  lines.push('');
  return lines;
}

// ---------------------------------------------------------------- routes at a glance

function topSegment(skeleton: string | null): string {
  if (!skeleton) return '(unknown)';
  const segs = skeleton.split('/').filter(Boolean);
  if (segs.length === 0) return '/';
  return `/${segs[0]}`;
}

function renderRoutesGlance(r: AnalysisResult, full: boolean): string[] {
  const lines: string[] = [];
  lines.push('Routes at a glance');
  const routes = r.routes;
  if (routes.length === 0) {
    lines.push('  (no routes detected)');
    lines.push('');
    return lines;
  }
  const count = (p: (x: RouteInfo) => boolean) => routes.filter(p).length;
  const pages = count((x) => x.kind === 'page');
  const apis = count((x) => x.kind === 'api');
  const metas = count((x) => x.kind === 'metadata');
  const specials = count((x) => x.kind === 'special');
  const appR = count((x) => x.router.value === 'app-router');
  const pagesR = count((x) => x.router.value === 'pages-router');
  const dyn = routes.filter((x) => x.skeleton.value != null && /\[[^\]]+\]/.test(x.skeleton.value));
  lines.push(
    `  ${routes.length} route files: ${pages} page, ${apis} api, ${metas} metadata` +
      (specials > 0 ? `, ${specials} special` : ''),
  );
  lines.push(`  by router: App Router ${appR}, Pages Router ${pagesR}`);
  if (dyn.length > 0) {
    // Extract example segment expressions, tolerating optional catch-all
    // brackets ([[slug]], [...rest]).
    const names = [...new Set(
      dyn.flatMap((x) => [...(x.skeleton.value ?? '').matchAll(/\[\[?[^\]/]*\]?\]|\[[^\]/]+\]/g)].map((m) => m[0])),
    )].sort().slice(0, 5);
    lines.push(
      `  dynamic segments: ${dyn.length} file(s)` +
        (names.length > 0 ? ` (e.g. ${names.join(', ')})` : ''),
    );
  }
  // Compact top-level organization.
  const prefixCount = new Map<string, number>();
  for (const x of routes) {
    const t = topSegment(x.skeleton.value);
    prefixCount.set(t, (prefixCount.get(t) ?? 0) + 1);
  }
  const prefixes = [...prefixCount.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8);
  lines.push(`  top-level: ${prefixes.map(([p, n]) => `${p} (${n})`).join(', ')}`);
  const saFiles = r.apps.reduce((n, a) => n + a.serverActions.length, 0);
  if (saFiles > 0) lines.push(`  Server Actions: ${saFiles} file(s) inventoried`);
  const conflicts = r.apps.reduce((n, a) => n + a.routerConflicts.length, 0);
  if (conflicts > 0) {
    lines.push(
      `  router collisions: ${conflicts} URL(s) mapped by both routers (structural fact; no serving winner claimed — see Coverage)`,
    );
  }

  if (full) {
    lines.push('');
    lines.push('  All routes:');
    const sorted = [...routes].sort((a, b) => (a.file < b.file ? -1 : 1));
    for (const x of sorted) {
      const sk = x.skeleton.value ?? '(unknown)';
      const methods = x.methods.value.length > 0 ? ` [${x.methods.value.join(',')}]` : '';
      lines.push(`    [${x.skeleton.confidence}] ${sk}${methods}  <- ${x.file}  (${x.kind}, ${x.router.value})`);
      if (x.skeleton.confidence !== 'R') lines.push(`      reason: ${x.skeleton.reason}`);
      const cv = x.concreteValues.value;
      if (cv != null) {
        lines.push(cv.length === 0 ? '      concrete: (none enumerable)' : `      concrete: ${cv.join(', ')}`);
      }
    }
  }
  lines.push('');
  return lines;
}

// ---------------------------------------------------------------- runtime blind spots

function renderBlindSpots(r: AnalysisResult, full: boolean): string[] {
  const lines: string[] = [];
  lines.push('Runtime blind spots');
  const un = byKind(r, 'uncertainty');
  if (un.length === 0) {
    lines.push('  (none — no unresolved runtime behavior detected)');
    lines.push('');
    return lines;
  }
  const groups = groupByCategory(un);
  for (const [cat, items] of groups) {
    lines.push(`  ${cat} — ${items.length} occurrence(s)`);
    const shown = full ? items : items.slice(0, BLIND_SPOT_EXAMPLES);
    for (const f of shown) {
      lines.push(`    [U] ${f.detail}`);
      lines.push(`      reason: ${f.reason}`);
    }
    if (!full && items.length > shown.length) {
      lines.push(`    +${items.length - shown.length} more — re-run with --full`);
    }
  }
  lines.push('');
  return lines;
}

// ---------------------------------------------------------------- coverage

function renderCoverage(r: AnalysisResult, full: boolean): string[] {
  const lines: string[] = [];
  lines.push('Coverage');

  // Structural facts (never labeled [U]).
  const facts = byKind(r, 'fact');
  if (facts.length > 0) {
    lines.push('  Observed facts:');
    const groups = groupByCategory(facts);
    for (const [cat, items] of groups) {
      const shown = full ? items : items.slice(0, 5);
      lines.push(`    ${cat} — ${items.length}`);
      for (const f of shown) lines.push(`      ${f.detail}`);
      if (!full && items.length > shown.length) {
        lines.push(`      +${items.length - shown.length} more — re-run with --full`);
      }
    }
  }

  // Router collisions as structural facts (no winner claimed).
  const conflicts = r.apps.flatMap((a) =>
    a.routerConflicts.map((c) => ({ app: appLabel(a), ...c })),
  );
  if (conflicts.length > 0) {
    lines.push('  Router collisions (structural fact — serving outcome not claimed):');
    const shown = full ? conflicts : conflicts.slice(0, 5);
    for (const c of shown) {
      const appPrefix = r.apps.length > 1 ? `${c.app}: ` : '';
      lines.push(`    ${appPrefix}${c.url}  app=${c.appRouterFile}  pages=${c.pagesRouterFile}`);
    }
    if (!full && conflicts.length > shown.length) {
      lines.push(`    +${conflicts.length - shown.length} more — re-run with --full`);
    }
  }

  // Coverage statistics.
  const cov = byKind(r, 'coverage');
  const covCount = (cat: string) => cov.filter((f) => f.category === cat).length;
  const s = r.resolutionStats;
  lines.push('  Analysis statistics:');
  lines.push(`    import edges: ${s.total}  R=${s.resolvedR}  I=${s.resolvedI}  U=${s.unresolvedU}`);
  // Every coverage finding category present in the model gets a counted
  // line in default; --full prints each finding's detail. No category is
  // hidden behind an aggregate and no finding is dropped.
  const covGroups = groupByCategory(cov);
  for (const [cat, items] of covGroups) {
    if (!full) {
      lines.push(`    ${cat}: ${items.length}`);
    } else {
      lines.push(`    ${cat} — ${items.length}`);
      for (const f of items) lines.push(`      ${f.detail}`);
    }
  }
  if (s.typeOnly > 0 && covCount('type-only-import-census') === 0) {
    // Defensive: the stat exists even if no census finding was recorded.
    lines.push(`    type-only imports: ${s.typeOnly} edge(s) — excluded from the runtime graph (structural count, not [U])`);
  }

  // Directory-read failures (TR-006): unique directories, never double-counted.
  // A path tried in multiple phases (discovery + analysis) is one unreadable
  // directory, not two. S6-7B.
  const df = r.dirReadFailures;
  if (df.length > 0) {
    const byPath = new Map<string, { error: string; phases: string[] }>();
    for (const d of df) {
      const key = d.path || '(root)';
      const e = byPath.get(key);
      if (e) {
        if (!e.phases.includes(d.phase)) e.phases.push(d.phase);
      } else {
        byPath.set(key, { error: d.error, phases: [d.phase] });
      }
    }
    const uniq = [...byPath.entries()];
    lines.push(`    unreadable directories: ${uniq.length}`);
    const shown = full ? uniq : uniq.slice(0, DIR_FAILURE_PATHS);
    for (const [path, { error, phases }] of shown) {
      lines.push(`      ${path} — ${error} (${phases.join(', ')})`);
    }
    if (!full && uniq.length > shown.length) {
      lines.push(`      +${uniq.length - shown.length} more — re-run with --full`);
    }
  } else {
    lines.push('    unreadable directories: 0');
  }

  // Framework detection scope (r3 truthfulness rule).
  lines.push('  Framework detection scope:');
  if (full) {
    lines.push(`    dependency scan checked: ${CHECKED_FRAMEWORKS.join(', ')}`);
    lines.push(`    unsupported-app candidates checked: ${CHECKED_UNSUPPORTED_APP_FRAMEWORKS.join(', ')}`);
  }
  lines.push('    Frameworks outside this list are not detected — "none detected"');
  lines.push('    means "none detected by these checks", not "no application exists".');

  // Unsupported boundaries (detected but out of analysis scope).
  const bsec = renderBoundaries(r.boundaries);
  if (bsec) {
    for (const bl of bsec.split('\n')) {
      const norm = bl.startsWith('## ') ? bl.slice(3) : bl;
      lines.push(norm === '' ? '' : `  ${norm}`);
    }
  }

  // --full extras: aliases, server actions, tRPC, import probes.
  if (full) {
    lines.push('  Aliases:');
    const appsWithAliases = r.apps.filter((a) => a.aliases.length > 0);
    if (appsWithAliases.length === 0) lines.push('    (none)');
    for (const a of appsWithAliases) {
      lines.push(`    ${appLabel(a)}:`);
      for (const al of a.aliases) {
        lines.push(`      [${al.confidence}] ${al.pattern} -> ${al.targets.join(', ')}  (${al.ownerTsconfig})`);
      }
    }
    lines.push('  Server actions:');
    const appsWithSA = r.apps.filter((a) => a.serverActions.length > 0);
    if (appsWithSA.length === 0) lines.push('    (none inventoried)');
    for (const a of appsWithSA) {
      lines.push(`    ${appLabel(a)}:`);
      for (const sa of a.serverActions) {
        lines.push(`      [${sa.scope.confidence}] ${sa.scope.value}  ${sa.file}`);
        const direct = sa.actions.value;
        if (direct.length > 0) {
          lines.push(`        direct [${sa.actions.confidence}]: ${direct.join(', ')}`);
          if (sa.actions.confidence !== 'R') lines.push(`        reason: ${sa.actions.reason}`);
        }
        for (const c of sa.actionCandidates) {
          lines.push(`        candidate [${c.confidence}] ${c.name} — ${c.reason}`);
        }
      }
    }
    lines.push('  tRPC procedures:');
    if (r.trpcProcedures.length === 0) {
      lines.push('    (none enumerated)');
    }
    for (const p of r.trpcProcedures) {
      lines.push(`    [${p.confidence}] ${p.path}  <- ${p.handlerFile}`);
      if (p.confidence !== 'R') lines.push(`      reason: ${p.reason}`);
    }
    lines.push(`  Import probes (${r.importProbes.length}):`);
    if (r.importProbes.length === 0) lines.push('    (none)');
    for (const p of r.importProbes) {
      const v = p.resolved.value == null ? '(unresolved)' : p.resolved.value;
      lines.push(`    [${p.resolved.confidence}] ${p.fromFile} :: ${p.specifier}${p.typeOnly ? ' [type-only]' : ''} -> ${v}`);
    }
  }
  lines.push('');
  return lines;
}

// ---------------------------------------------------------------- next

function renderNext(full: boolean): string[] {
  const lines: string[] = [];
  lines.push('Next');
  if (!full) {
    lines.push('  Re-run with --full for the complete analysis report.');
  } else {
    lines.push('  (full report — every modeled item shown above)');
  }
  lines.push(BAR);
  return lines;
}

// ---------------------------------------------------------------- entry points

/** Default orientation report: six sections. */
export function renderReport(r: AnalysisResult): string {
  return [
    ...renderHeader(r),
    ...renderStartHere(r, false),
    ...renderRoutesGlance(r, false),
    ...renderBlindSpots(r, false),
    ...renderCoverage(r, false),
    ...renderNext(false),
  ].join('\n');
}

/** Complete analysis report: every modeled item, no renderer truncation. */
export function renderFullReport(r: AnalysisResult): string {
  return [
    ...renderHeader(r),
    ...renderStartHere(r, true),
    ...renderRoutesGlance(r, true),
    ...renderBlindSpots(r, true),
    ...renderCoverage(r, true),
    ...renderNext(true),
  ].join('\n');
}
