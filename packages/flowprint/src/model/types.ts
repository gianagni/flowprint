import type { RouterEvidence, RouterId } from '../framework/types.js';

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
  /** App-vs-Pages same-URL conflicts; pages wins per Next.js (GAP 5). */
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

/** Same effective URL served by both App Router and Pages Router. */
export interface RouterConflict {
  url: string;
  appRouterFile: string;
  pagesRouterFile: string;
  /** Next.js serves the Pages Router version on conflict. */
  winner: 'pages';
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

export interface UnknownItem {
  area: string;
  detail: string;
  reason: string;
}

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
  unknowns: UnknownItem[];
  /** Detected-but-unsupported frameworks/features (Blocker B3). Names what the analyzer does not cover. */
  boundaries: UnsupportedBoundary[];
}
