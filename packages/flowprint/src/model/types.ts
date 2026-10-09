import type { RouterEvidence, RouterId } from '../framework/types.js';
import { relative, sep } from 'node:path';

/**
 * Flowprint M0 — analysis model.
 *
 * Design rule: confidence (Resolved / Inferred / Unknown) lives IN THE MODEL,
 * not added later by the renderer. Every claim the analyzer emits carries its
 * epistemic status at the point of creation.
 *
 * Honesty ordering: Resolved-correct > Inferred-correct > Unknown >> Incorrectly-Resolved.
 * A confidently-wrong answer is the worst possible outcome.
 */

import type { UnsupportedBoundary } from '../boundaries/types.js';

export type Confidence = 'R' | 'I' | 'U';

export interface Claim<T> {
  value: T;
  /** R = proven from syntax/resolution/convention. I = strong heuristic. U = cannot be determined honestly. */
  confidence: Confidence;
  /** Why this confidence level — required, forces the analyzer to justify itself. */
  reason: string;
}

export function resolved<T>(value: T, reason: string): Claim<T> {
  return { value, confidence: 'R', reason };
}
export function inferred<T>(value: T, reason: string): Claim<T> {
  return { value, confidence: 'I', reason };
}
export function unknown<T>(value: T, reason: string): Claim<T> {
  return { value, confidence: 'U', reason };
}

/**
 * A directory that could not be read during discovery or analysis.
 * Recorded structurally (TR-006) so the Coverage section (S4) can report
 * unreadable paths with counts instead of silently skipping them.
 */
export interface DirReadFailure {
  /** Repo-relative path of the unreadable directory. */
  path: string;
  /** Short error identity, e.g. "EACCES", "EPERM". */
  error: string;
  /** Which phase hit it, e.g. "discovery" or "analysis". */
  phase: string;
}

/** Sink for directory-read failures; threading it keeps signatures honest. */
export type DirFailureSink = (f: DirReadFailure) => void;

/**
 * Classify a directory-read error: returns the recordable error code, or
 * null when the failure is routine absence (ENOENT/ENOTDIR) that probe-style
 * walks (e.g. "does app/ exist?") legitimately tolerate.
 */
export function dirErrorCode(err: unknown): string | null {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return null;
  return code ?? 'unknown';
}

/**
 * Best-effort repo-relative path for failure recording. Never throws —
 * TR-006 recording itself must not crash the scan on unusual paths.
 */
export function safeRelPath(repoRoot: string, abs: string): string {
  try {
    return relative(repoRoot, abs).split(sep).join('/');
  } catch {
    return abs;
  }
}

export interface AliasInfo {
  /** e.g. "@/*". */
  pattern: string;
  /** Raw targets as written in the tsconfig, e.g. ["./src/*"]. */
  targets: string[];
  /** Repo-relative path of the tsconfig that owns this alias. */
  ownerTsconfig: string;
  confidence: Confidence;
  reason: string;
}

export interface AppInfo {
  /** Repo-relative path, e.g. "apps/web". */
  path: string;
  /** Framework identifier, e.g. "nextjs-app-router". */
  framework: Claim<string>;
  /** Raw `next` dependency range from package.json, e.g. "^14.2.0" (S4 header). */
  nextVersion: string | null;
  /** Repo-relative tsconfig paths applying to this app. */
  tsconfigs: string[];
  /** Aliases detected from the applicable tsconfigs. */
  aliases: AliasInfo[];
  /** Free-form notes, e.g. "hybrid: pages/ detected but out of M0 scope". */
  notes: string[];
  /** Per-app server-action inventory (GAP 6). */
  serverActions: ServerActionInfo[];
  /**
   * "Start here" orientation: 0–7 files recommended as reading entry points,
   * selected ONLY from structural evidence (root layout, root route,
   * request boundary, startup hook). Deterministic; each item carries a
   * structural reason. This answers "where should I start reading", which
   * `entryPoints` (raw edge boundaries) does not.
   */
  startHere: StartHereItem[];
  /**
   * App-vs-Pages same-URL conflicts (GAP 5). Structural facts only —
   * no serving winner is claimed (see RouterConflict).
   */
  routerConflicts: RouterConflict[];
  /** Per-router evidence from independent per-directory hybrid detection (B2). */
  routers: RouterEvidence[];
}

/** One inventoried server-action file (per app). */
export interface ServerActionInfo {
  /** Repo-relative file path. */
  file: string;
  /** 'module' = top-of-file directive (whole file); 'inline' = function-body directives. */
  scope: Claim<'module' | 'inline'>;
  /** Action (exported async function) names with confidence. */
  actions: Claim<string[]>;
  /**
   * Wrapped/builder-pattern action candidates: exported bindings initialized
   * by (possibly chained) call expressions containing an async callback.
   * Structural evidence only — never R unless the runtime semantics are
   * genuinely provable. Empty when the module has no such exports.
   */
  actionCandidates: ActionCandidate[];
}

/** One wrapped/builder-pattern server-action candidate. */
export interface ActionCandidate {
  /** Exported binding name. */
  name: string;
  /** I (strong structural evidence) or U — never R without proven semantics. */
  confidence: Confidence;
  /** Evidence explanation, e.g. which chain shape was observed. */
  reason: string;
}

/**
 * One "start here" orientation suggestion: a file the analyzer recommends
 * reading first, chosen ONLY from structural evidence (framework root layout,
 * root route, request boundary, startup hook). Deterministic, local/static,
 * no semantic guessing — the reason must justify the suggestion structurally.
 */
export interface StartHereItem {
  /** Repo-relative file path. */
  file: string;
  confidence: Confidence;
  /** Short deterministic reason, e.g. "root App Router layout". */
  reason: string;
}

/**
 * Same effective URL mapped by both App Router and Pages Router files.
 *
 * Structural fact only: both files exist and both map to this URL.
 * The serving outcome is NOT claimed here — per the Next.js v13/v14
 * routing documentation, the App Router takes priority and same-URL
 * routes across directories cause a build-time error, but which (if
 * either) route actually serves in a given repo/version cannot be
 * established from files alone. See the accompanying `Finding` (category
 * `router-collision-outcome`).
 */
export interface RouterConflict {
  url: string;
  appRouterFile: string;
  pagesRouterFile: string;
}

/** One enumerated tRPC procedure (validated patterns only). */
export interface TrpcProcedure {
  /** Dotted procedure path, e.g. "bookmarks.createBookmark". */
  procedure: string;
  /** Effective path: mount + '/' + procedure when the adapter mount is anchored, else the dotted procedure path. */
  path: string;
  /** Mount path from the adapter endpoint literal, or null when not anchored. */
  mountPath: string | null;
  /** Repo-relative file where the router/procedure is defined. */
  handlerFile: string;
  confidence: Confidence;
  reason: string;
}

export interface EntryPoint {
  /** Repo-relative file path. */
  file: string;
  /** e.g. "proxy" | "middleware" | "app-layout" | "package-main" | "package-bin". */
  kind: Claim<string>;
}

export interface RouteInfo {
  /** Repo-relative file path of the route file. */
  file: string;
  /** Route file kind for grouping (S4): page | api (route handler) | metadata | special. */
  kind: 'page' | 'api' | 'metadata' | 'special';
  /** Which Next.js router this route file belongs to (B2: both routers reported). */
  router: Claim<RouterId>;
  /**
   * URL skeleton: dynamic segments as written (e.g. `/[domain]/[locale]/login`),
   * route groups stripped; null when honestly undeterminable (intercepting
   * routes, adapter-delegated catch-alls).
   */
  skeleton: Claim<string | null>;
  /**
   * Enumerable concrete URLs. R `[skeleton]` only for fully static skeletons
   * with no basePath/rewrites/redirects affecting them; U (empty) when dynamic
   * segments need runtime data; null for intercepting routes and
   * adapter-delegated catch-alls.
   */
  concreteValues: Claim<string[] | null>;
  /** HTTP methods, empty when unknown. */
  methods: Claim<string[]>;
}

export interface ImportProbeResult {
  fromFile: string;
  specifier: string;
  /** Repo-relative resolved path, or null when unresolvable. */
  resolved: Claim<string | null>;
  typeOnly: boolean;
}

/**
 * S3 (F-4 contract): the *kind* of information a finding carries, independent
 * of claim confidence (R/I/U).
 *
 * - `fact`: a structural fact observed in source/config (exists on disk,
 *   observed absent on disk, matches a verified convention). Never labeled
 *   `[U]` merely because a related runtime value is unknown.
 * - `uncertainty`: behavior that cannot be determined from the static
 *   evidence available. This is the only kind rendered as `[U]`.
 * - `coverage`: an analytical coverage statistic or limitation (counts,
 *   fallbacks, skipped/crashed files, unreadable directories, framework
 *   detection scope). Never labeled `[U]`.
 *
 * Classification happens at the push site — each site knows its own
 * semantics. Never re-derive kind from `area`/`detail` strings.
 */
export type FindingKind = 'fact' | 'uncertainty' | 'coverage';

/**
 * Controlled finding categories (S3). Closed union so the compiler enforces
 * deterministic classification; a finding that cannot honestly be placed in
 * `fact` or `coverage` defaults to `uncertainty` and must be flagged for
 * review — never silently reclassified.
 */
export type FindingCategory =
  // fact
  | 'alias-target-absent'
  | 'ghost-workspace'
  | 'misplaced-directive-inert'
  // uncertainty
  | 'router-collision-outcome'
  | 'dynamic-segment-values'
  | 'parallel-slot-rendering'
  | 'middleware-rewrite-behavior'
  | 'hostname-dispatch'
  | 'env-conditional-config'
  | 'computed-rewrites'
  | 'auth-wrapper-behavior'
  | 'auth-enforcement-location'
  | 'instrumentation-startup-behavior'
  | 'embedded-framework-endpoints'
  | 'trpc-mount-undetermined'
  | 'trpc-enumeration-gap'
  | 'server-action-status'
  // coverage
  | 'type-only-import-census'
  | 'dist-src-fallback'
  | 'parse-error-partial'
  | 'parse-crash-skipped'
  | 'skipped-file'
  | 'trpc-isolation-gated'
  | 'server-action-inventory-scope';

/**
 * Canonical category → kind mapping (S3). Single source of truth for
 * deterministic classification: a finding's `kind` must equal the mapped
 * kind of its `category` (enforced by regression test).
 *
 * Conservative policy for new categories: when a new finding cannot
 * honestly be placed in `fact` or `coverage`, default to `uncertainty`
 * and flag it for review — never silently claim a fact.
 */
export const FINDING_KIND_BY_CATEGORY: Record<FindingCategory, FindingKind> = {
  'alias-target-absent': 'fact',
  'ghost-workspace': 'fact',
  'misplaced-directive-inert': 'fact',
  'router-collision-outcome': 'uncertainty',
  'dynamic-segment-values': 'uncertainty',
  'parallel-slot-rendering': 'uncertainty',
  'middleware-rewrite-behavior': 'uncertainty',
  'hostname-dispatch': 'uncertainty',
  'env-conditional-config': 'uncertainty',
  'computed-rewrites': 'uncertainty',
  'auth-wrapper-behavior': 'uncertainty',
  'auth-enforcement-location': 'uncertainty',
  'instrumentation-startup-behavior': 'uncertainty',
  'embedded-framework-endpoints': 'uncertainty',
  'trpc-mount-undetermined': 'uncertainty',
  'trpc-enumeration-gap': 'uncertainty',
  'server-action-status': 'uncertainty',
  'type-only-import-census': 'coverage',
  'dist-src-fallback': 'coverage',
  'parse-error-partial': 'coverage',
  'parse-crash-skipped': 'coverage',
  'skipped-file': 'coverage',
  'trpc-isolation-gated': 'coverage',
  'server-action-inventory-scope': 'coverage',
};

/** All finding categories (derived from the canonical mapping). */
export const FINDING_CATEGORIES = Object.keys(FINDING_KIND_BY_CATEGORY) as FindingCategory[];

/**
 * A structured finding (S3). `kind`/`category`/`subject` are the new
 * evidence-first model; `area`/`detail`/`reason` are kept byte-compatible
 * for the benchmark harness and the (S3-unchanged) renderer.
 */
export interface Finding {
  kind: FindingKind;
  category: FindingCategory;
  /**
   * Primary entity the finding is about: a repo-relative file path, a URL,
   * an alias pattern, or a scope label such as `(repository)` for
   * repo-wide aggregates. Never empty.
   */
  subject: string;
  /** Legacy human-readable area (benchmark-matched; do not reword lightly). */
  area: string;
  /** Legacy detail string (benchmark-matched; do not reword lightly). */
  detail: string;
  /** Legacy reason string. */
  reason: string;
}

/**
 * Legacy name for {@link Finding}. Kept for source compatibility; new code
 * uses `Finding`.
 * @deprecated Use `Finding`.
 */
export type UnknownItem = Finding;

export interface ResolutionStats {
  total: number;
  resolvedR: number;
  resolvedI: number;
  unresolvedU: number;
  typeOnly: number;
}

export interface AnalysisResult {
  repo: string;
  durationMs: number;
  apps: AppInfo[];
  entryPoints: EntryPoint[];
  routes: RouteInfo[];
  /** tRPC procedures enumerated from validated adapter-anchored patterns (GAP 7). */
  trpcProcedures: TrpcProcedure[];
  /** Results for the harness-supplied probe imports (from the fixture). */
  importProbes: ImportProbeResult[];
  resolutionStats: ResolutionStats;
  /**
   * Structured findings (S3: kind/category/subject + legacy area/detail/reason).
   * Field name kept for benchmark-harness compatibility.
   */
  unknowns: Finding[];
  /** Detected-but-unsupported frameworks/features (Blocker B3). Names what the analyzer does not cover. */
  boundaries: UnsupportedBoundary[];
  /**
   * Directories that could not be read (TR-006), discovery + analysis
   * phases merged. Coverage (S4) reports the count and up to five paths.
   */
  dirReadFailures: DirReadFailure[];
}
