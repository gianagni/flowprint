/**
 * Flowprint M0 — analyzer entry point.
 *
 * Pipeline layers (must stay separate):
 *   discovery/  → filesystem + workspace discovery
 *   parsing/    → source parsing (oxc)
 *   resolution/ → module resolution (NO framework logic here)
 *   framework/  → Next.js App Router detection
 *   boundaries/ → detected-but-unsupported framework boundaries
 *   model/      → analysis model with R/I/U confidence
 *   render/     → terminal renderer
 *
 * ---------------------------------------------------------------------------
 * PER-APP SCOPING RULE (B4) — general, no repo-specific logic.
 *
 * Discovery is always GLOBAL and fast (a package.json walk; no parsing).
 * Everything expensive — the recursive source-file walk, oxc parsing, and
 * framework analysis — is scoped to exactly ONE app directory (repo-relative;
 * '' means the repo root, which reproduces the legacy full-repo behavior).
 *
 * What "scoped" means, precisely:
 *   1. Only files under the app dir are walked and parsed. Nothing outside
 *      the app dir ever enters the records map.
 *   2. Cross-package imports still resolve through the GLOBAL name→dir map
 *      (discovery output). The resolver probes the filesystem, so an import
 *      into an unparsed package still resolves to a file on disk at R or I
 *      — the claim describes the file target, not its contents.
 *   3. Anything that needs a target file's PARSED record (none in the M0
 *      pipeline — barrel-following is exported but unused) would stop at the
 *      resolved file: resolution degrades to file-level, never invents.
 *   4. Framework analysis (routers, server actions, edge entries) runs only
 *      for app candidates whose dir lies inside the scope. Server-action
 *      files outside every in-scope candidate are reported as Unknown,
 *      honestly, per the existing residual rule.
 *   5. Boundaries (B3) are detected from the global discovery records, so a
 *      per-app report still names every detected-but-unsupported framework
 *      in the repo.
 * ---------------------------------------------------------------------------
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep, basename, dirname, resolve as resolvePath } from 'node:path';
import { discoverRepo, SKIP_DIRS, type DiscoveryResult } from './discovery/index.js';
import { detectBoundaries } from './boundaries/detect.js';
import { SOURCE_EXTENSIONS, type ModuleRecord } from './parsing/index.js';
import { parseFilesIsolated } from './parsing/isolated.js';
import { createResolutionContext } from './resolution/index.js';
import { analyzeFrameworkApp, type FrameworkAppResult } from './framework/index.js';
import { stripTsComments, stripCommentsExact } from './framework/edge.js';
import { inventoryServerActions } from './framework/serverActions.js';
import { analyzeTrpcSurface } from './framework/trpc.js';
import { assembleResult } from './model/assemble.js';
import {
  dirErrorCode,
  safeRelPath,
  type AnalysisResult,
  type DirFailureSink,
  type DirReadFailure,
  type ServerActionInfo,
  type TrpcProcedure,
  type UnknownItem,
} from './model/types.js';

export interface AnalyzeOptions {
  /** Import probes supplied by the benchmark harness (from the fixture). */
  probeImports?: Array<{ fromFile: string; specifier: string }>;
  /**
   * B4 per-app scoping: restrict the expensive walk + parse + framework
   * pipeline to these repo-relative app dirs. Discovery stays global.
   * Omit (or pass ['']) for the legacy full-repo analysis.
   */
  appDirs?: string[];
}

/**
 * Find the repo root for an absolute path: the highest ancestor that looks
 * like a monorepo root (pnpm-workspace.yaml or package.json `workspaces`
 * field), else the nearest ancestor (or self) with a package.json, else the
 * path itself. General rule — no repo-specific names.
 */
export async function findRepoRoot(startAbs: string): Promise<string> {
  let dir = resolvePath(startAbs);
  const st = await stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) dir = dirname(dir);
  let nearestPkg: string | null = null;
  let workspaceRoot: string | null = null;
  let cur = dir;
  for (;;) {
    const pj = join(cur, 'package.json');
    const hasPkg = await stat(pj)
      .then((s) => s.isFile())
      .catch(() => false);
    if (hasPkg) {
      if (nearestPkg == null) nearestPkg = cur;
      const hasPnpmWs = await stat(join(cur, 'pnpm-workspace.yaml'))
        .then((s) => s.isFile())
        .catch(() => false);
      let hasWsField = false;
      if (!hasPnpmWs) {
        try {
          const raw = JSON.parse(await readFile(pj, 'utf8')) as { workspaces?: unknown };
          hasWsField = raw.workspaces != null;
        } catch {
          /* unreadable package.json — not a workspace marker */
        }
      }
      // Keep climbing: the HIGHEST workspace marker wins.
      if (hasPnpmWs || hasWsField) workspaceRoot = cur;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return workspaceRoot ?? nearestPkg ?? dir;
}

/**
 * Analyze a single app directory (absolute path). The repo root is derived
 * via findRepoRoot; discovery stays global, the expensive pipeline is scoped
 * to the app dir per the rule documented at the top of this file.
 */
export async function analyzeApp(appDirAbs: string, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const repoRoot = await findRepoRoot(appDirAbs);
  const rel = relative(repoRoot, resolvePath(appDirAbs)).split(sep).join('/');
  if (rel.startsWith('..')) {
    throw new Error(`app dir ${appDirAbs} is not inside repo root ${repoRoot}`);
  }
  return analyzeRepository(repoRoot, { ...opts, appDirs: [rel] });
}

/**
 * Full-repo analysis: global discovery, then the expensive pipeline scoped
 * to opts.appDirs (default: whole repo). Kept for the benchmark harness.
 */
export async function analyzeRepository(
  repoRoot: string,
  opts: AnalyzeOptions = {},
): Promise<AnalysisResult> {
  const discovery = await discoverRepo(repoRoot);
  const scopes = normalizeScopes(opts.appDirs);
  for (const s of scopes) {
    const st = await stat(join(repoRoot, s)).catch(() => null);
    if (!st || !st.isDirectory()) {
      throw new Error(`app dir "${s || '(root)'}" not found under ${repoRoot}`);
    }
  }
  return analyzeScoped(repoRoot, discovery, scopes, opts);
}

/** Normalize scope dirs: '' = repo root; de-duplicated; repo-relative. */
function normalizeScopes(appDirs: string[] | undefined): string[] {
  if (!appDirs || appDirs.length === 0) return [''];
  const out = new Set<string>();
  for (const raw of appDirs) {
    let s = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (s === '' || s === '.' || s === './') s = '';
    if (s.startsWith('..')) {
      throw new Error(`app dir "${raw}" escapes the repo root`);
    }
    out.add(s);
  }
  return [...out];
}

/** Repo-relative dir is inside (or equal to) one of the scopes. */
function inScopes(scopes: string[], dir: string): boolean {
  return scopes.some((s) => s === '' || dir === s || dir.startsWith(s + '/'));
}

async function analyzeScoped(
  repoRoot: string,
  discovery: DiscoveryResult,
  scopes: string[],
  opts: AnalyzeOptions,
): Promise<AnalysisResult> {
  const t0 = Date.now();
  const toRel = (abs: string) => relative(repoRoot, abs).split(sep).join('/');

  // ---- collect source files (walk scoped to the app dirs; noise skipped) ----
  const sourceFiles: string[] = [];
  const nextConfigFiles: string[] = [];
  // TR-006: unreadable directories are recorded structurally (surfaced in
  // Coverage by S4) instead of silently skipped.
  const dirReadFailures: DirReadFailure[] = [];
  const onDirFailure: DirFailureSink = (f) => dirReadFailures.push(f);
  async function walk(absDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      const code = dirErrorCode(err);
      if (code) {
        dirReadFailures.push({
          path: safeRelPath(repoRoot, absDir),
          error: code,
          phase: 'analysis',
        });
      }
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.well-known') continue;
      const abs = join(absDir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const rel = toRel(abs);
        const dot = e.name.lastIndexOf('.');
        const ext = dot === -1 ? '' : e.name.slice(dot).toLowerCase();
        if (SOURCE_EXTENSIONS.has(ext)) sourceFiles.push(rel);
        if (/^next\.config\.(ts|js|mjs|cjs)$/.test(e.name)) nextConfigFiles.push(rel);
      }
    }
  }
  for (const s of scopes) await walk(join(repoRoot, s));
  // De-dupe (overlapping scopes must not double-count files).
  const uniq = (arr: string[]) => [...new Set(arr)];
  const scopedSourceFiles = uniq(sourceFiles).sort();
  const scopedNextConfigs = uniq(nextConfigFiles).sort();

  // ---- parsing (isolated: ALL oxc parsing runs in child processes; see parsing/isolated.ts) ----
  const records = await parseFilesIsolated(repoRoot, scopedSourceFiles);
  const sourceCache = new Map<string, string | null>();
  async function getSource(rel: string): Promise<string | null> {
    const hit = sourceCache.get(rel);
    if (hit !== undefined) return hit;
    let text: string | null = null;
    try {
      text = await readFile(join(repoRoot, rel), 'utf8');
    } catch {
      text = null;
    }
    sourceCache.set(rel, text);
    return text;
  }
  async function getRecord(rel: string): Promise<ModuleRecord | null> {
    const hit = records.get(rel);
    if (hit) return hit;
    if (!scopedSourceFiles.includes(rel)) {
      // On-demand parse (e.g. probe files outside the walked set) — routed
      // through the same child_process isolation, so no caller can feed a
      // crashing file to the in-process parser.
      const recs = await parseFilesIsolated(repoRoot, [rel]);
      const rec = recs.get(rel) ?? null;
      if (rec) records.set(rel, rec);
      return rec;
    }
    return null;
  }

  // ---- resolution context (global name→dir map; scoped records) ----
  const ctx = createResolutionContext(repoRoot, discovery.nameToDir, records);

  const extraUnknowns: UnknownItem[] = [];

  // ---- cross-cutting scans (config, directives, workspace hygiene) ----
  for (const ghost of discovery.workspaces.ghostDirs) {
    extraUnknowns.push({
      kind: 'fact',
      category: 'ghost-workspace',
      subject: ghost,
      area: 'ghost workspace',
      detail: `workspace pattern matches "${ghost}" but it has no package.json (zero tracked files)`,
      reason: 'ghost workspace entry — tolerated, not resolved',
    });
  }

  let typeOnlyEdges = 0;
  let parseErrorFiles = 0;
  let skippedFiles = 0;
  let crashedFiles = 0;
  const skippedDetails: string[] = [];
  const crashedDetails: string[] = [];
  for (const rec of records.values()) {
    if (rec.hasErrors) parseErrorFiles++;
    if (rec.skipped) {
      skippedFiles++;
      if (skippedDetails.length < 5) skippedDetails.push(`${rec.file}: ${rec.skipped}`);
    }
    if (rec.crashed) {
      crashedFiles++;
      if (crashedDetails.length < 5) crashedDetails.push(rec.file);
    }
    for (const imp of rec.imports) {
      if (imp.typeOnly) typeOnlyEdges++;
    }
  }
  if (typeOnlyEdges > 0) {
    extraUnknowns.push({
      kind: 'coverage',
      category: 'type-only-import-census',
      subject: '(repository)',
      area: 'import type usage',
      detail: `${typeOnlyEdges} type-only import edges found; type-only edges are excluded from the runtime graph`,
      reason: 'type-only census is approximate',
    });
  }
  if (parseErrorFiles > 0) {
    extraUnknowns.push({
      kind: 'coverage',
      category: 'parse-error-partial',
      subject: '(repository)',
      area: 'parse errors',
      detail: `${parseErrorFiles} files parsed with syntax errors; partial records kept`,
      reason: 'error-tolerant parsing — records may be incomplete',
    });
  }
  if (skippedFiles > 0) {
    extraUnknowns.push({
      kind: 'coverage',
      category: 'skipped-file',
      subject: '(repository)',
      area: 'skipped files',
      detail: `${skippedFiles} files skipped without parsing and excluded from the graph${skippedDetails.length > 0 ? ` (e.g. ${skippedDetails.join('; ')}${skippedFiles > skippedDetails.length ? '; …' : ''})` : ''}`,
      reason: 'oversize/unparseable files are Unknown by policy — no single file may terminate a scan',
    });
  }
  if (crashedFiles > 0) {
    extraUnknowns.push({
      kind: 'coverage',
      category: 'parse-crash-skipped',
      subject: '(repository)',
      area: 'parse crashes',
      detail: `${crashedFiles} file(s) crashed the isolated parser worker and were skipped without records${crashedDetails.length > 0 ? ` (e.g. ${crashedDetails.join(', ')}${crashedFiles > crashedDetails.length ? '; …' : ''})` : ''}`,
      reason: 'native parser crashes are contained by child_process isolation — no single file may terminate a scan',
    });
  }
  // (tRPC surface unknowns are emitted by analyzeTrpcSurface below — GAP 7.)
  for (const rel of scopedNextConfigs) {
    const text = await getSource(rel);
    if (!text) continue;
    if (/process\.env/.test(text)) {
      extraUnknowns.push({
        kind: 'uncertainty',
        category: 'env-conditional-config',
        subject: rel,
        area: 'env-conditional config',
        detail: `${rel} sets config conditional on process.env (env-conditional module alias/rewrites); which variant is active without env is Unknown`,
        reason: 'env-dependent config cannot be resolved statically',
      });
    }
    if (/\brewrites\s*\(/.test(text) || /\basync rewrites/.test(text)) {
      extraUnknowns.push({
        kind: 'uncertainty',
        category: 'computed-rewrites',
        subject: rel,
        area: 'computed rewrites',
        detail: `${rel} defines async rewrites() mixing literal and computed sources; only literal pairs are claimed`,
        reason: 'computed rewrite sources need evaluation',
      });
    }
  }

  // ---- framework analysis per in-scope app candidate ----
  // Only candidates with actual router evidence (app/ page/layout/route
  // conventions or pages/ dirs); a bare `next` dependency without router
  // conventions is not an app.
  const appCands = discovery.appCandidates
    .filter((c) => c.hasAppConventions || c.hasPagesDir)
    .filter((c) => inScopes(scopes, c.dir));
  const fwApps: FrameworkAppResult[] = [];
  for (const cand of appCands) {
    fwApps.push(await analyzeFrameworkApp(repoRoot, cand, getRecord, onDirFailure));
  }

  // ---- server-action inventory per app (GAP 6) ----
  const serverActionsByApp = new Map<string, ServerActionInfo[]>();
  const serverActionFiles = new Set<string>();
  for (const cand of appCands) {
    const inv = inventoryServerActions(cand.dir, records);
    serverActionsByApp.set(cand.dir, inv.files);
    for (const f of inv.files) serverActionFiles.add(f.file);
    extraUnknowns.push(...inv.unknowns);
  }
  // Residual: 'use server' files outside any in-scope app dir are not inventoried.
  let uncoveredServerFiles = 0;
  for (const rec of records.values()) {
    if (!rec.directiveScopes.some((d) => d.value === 'use server')) continue;
    if (serverActionFiles.has(rec.file)) continue;
    const covered = appCands.some(
      (c) => !c.dir || rec.file === c.dir || rec.file.startsWith(c.dir + '/'),
    );
    if (!covered) uncoveredServerFiles++;
  }
  if (uncoveredServerFiles > 0) {
    extraUnknowns.push({
      kind: 'coverage',
      category: 'server-action-inventory-scope',
      subject: '(repository)',
      area: 'server actions',
      detail: `${uncoveredServerFiles} file(s) with 'use server' lie outside in-scope app dirs — not inventoried (per-app inventory only)`,
      reason: 'server-action inventory is per-app; orphan files not attributed',
    });
  }

  // ---- tRPC procedure enumeration (GAP 7; validated patterns only) ----
  const trpc = await analyzeTrpcSurface(repoRoot, scopedSourceFiles, records, ctx);
  extraUnknowns.push(...trpc.unknowns);
  const trpcProcedures: TrpcProcedure[] = trpc.procedures;

  // Edge-file content scans — evidence-triggered unknowns (TR-004).
  //
  // Signals are matched against comment-stripped source so commented-out
  // code cannot drive findings, and they report OBSERVED references only:
  // a text reference is not evidence of runtime behavior ("references
  // hostname" ≠ "dispatches by hostname"). Repo-specific heuristics
  // (PUBLIC_URL/WEBAPP_URL, isAuthProtectedRoute) are removed entirely —
  // no hardcoded project vocabulary.
  for (const fw of fwApps) {
    for (const e of fw.edgeEntries) {
      const text = await getSource(e.file);
      if (!text) continue;
      // Prefer parser-exact comment ranges (S5-C); fall back to the
      // heuristic stripper when the file was skipped/crashed or ranges
      // are unavailable. Exact ranges eliminate the heuristic's residual
      // (e.g. `//` inside a regex character class).
      const code = stripCommentsExact(text, records.get(e.file)?.commentRanges);
      if (/NextResponse\.rewrite/.test(code)) {
        extraUnknowns.push({
          kind: 'uncertainty',
          category: 'middleware-rewrite-behavior',
          subject: e.file,
          area: 'middleware rewrites',
          detail: `${e.file} references NextResponse.rewrite — whether rewrites remap URLs at runtime was not determined`,
          reason: 'rewrite behavior is runtime logic',
        });
      }
      if (/hostname/i.test(code)) {
        extraUnknowns.push({
          kind: 'uncertainty',
          category: 'hostname-dispatch',
          subject: e.file,
          area: 'hostname dispatch rules',
          detail: `${e.file} references "hostname" — whether requests are dispatched by hostname was not established from this reference`,
          reason: 'a text reference is not evidence of hostname-based dispatch',
        });
      }
    }
    // instrumentation.ts startup hooks
    for (const root of [fw.candidate.dir, fw.candidate.dir ? `${fw.candidate.dir}/src` : 'src']) {
      for (const f of [`${root}/instrumentation.ts`, `${root}/instrumentation.js`]) {
        const key = f.replace(/^\//, '');
        if (records.has(key)) {
          fw.notes.push(`instrumentation hook detected: ${key} (startup)`);
          fw.instrumentationFiles.push(key);
          extraUnknowns.push({
            kind: 'uncertainty',
            category: 'instrumentation-startup-behavior',
            subject: key,
            area: 'instrumentation hooks',
            detail: `${key} runs at server startup; scheduling/side effects are runtime`,
            reason: 'startup behavior not verified statically',
          });
        }
      }
    }
  }

  // ---- unsupported boundaries (B3): global dependency scan, always on ----
  const boundaries = detectBoundaries({ repoRoot, discovery });

  // ---- model ----
  const result = await assembleResult({
    repoRoot,
    repoName: scopes.length === 1 && scopes[0] !== '' ? `${basename(repoRoot)}/${scopes[0]}` : basename(repoRoot),
    durationMs: 0,
    records,
    sourceFiles: scopedSourceFiles,
    fwApps,
    probes: opts.probeImports ?? [],
    ctx,
    extraUnknowns,
    serverActionsByApp,
    trpcProcedures,
    boundaries,
    // TR-006: discovery + analysis directory-read failures, merged.
    dirReadFailures: [...discovery.dirReadFailures, ...dirReadFailures],
  });
  result.durationMs = Date.now() - t0;
  return result;
}

export * from './model/types.js';
export { renderReport } from './render/index.js';
