/**
 * Flowprint v0.1 (Blocker B2) — framework layer: hybrid router detection types.
 *
 * General rule: for each app candidate, App Router and Pages Router evidence
 * are detected INDEPENDENTLY, per directory — never one label per app, never
 * gating one detector on the other's dominance. A repo with both an `app/`
 * dir containing route files (page/route/layout/...) and a `pages/` dir
 * containing page files gets BOTH detectors run and BOTH route sets reported.
 * Same-URL conflicts are reported explicitly in `routerConflicts` as
 * structural facts; no serving winner is claimed (not statically decidable).
 *
 * Every new claim carries its R/I/U confidence at creation (architecture.md:
 * confidence lives in the model, never invented by the renderer).
 */
import type { Claim } from '../model/types.js';
import type { RouteFileInfo } from './routes.js';

/** Which Next.js router a route file belongs to. */
export type RouterId = 'app-router' | 'pages-router';

/**
 * Per-router evidence for one app candidate.
 *
 * `detected` is R(true) when the router's root dir exists AND contains at
 * least one route-convention file found by a filesystem walk (a filesystem
 * fact, not a heuristic). R(false) when no router root with route files
 * exists under the app dir — still R because the (documented) candidate
 * locations were exhaustively walked.
 */
export interface RouterEvidence {
  router: RouterId;
  detected: Claim<boolean>;
  /** Repo-relative router root dirs that exist on disk, e.g. ["apps/web/app"]. */
  dirs: string[];
  /** Route-convention files found under those dirs. */
  routeFileCount: number;
}

/** One inventoried Pages Router route file, with claims (mirrors the App Router claim maps). */
export interface PagesRouteInfo {
  /** Repo-relative file path. */
  file: string;
  /** Mapped URL, e.g. "/about", "/api/trpc/[trpc]". */
  url: string;
  /** True for pages/api/* (API routes, not page routes). */
  isApi: boolean;
  /** File-convention URL mapping. R: deterministic per documented Next.js Pages Router rules. */
  skeleton: Claim<string>;
  /** Enumerable concrete URLs (downgraded by next.config basePath/rewrites/redirects as usual). */
  concreteValues: Claim<string[] | null>;
  /** HTTP methods. U in M0: per-handler method inventory is not done for Pages routes. */
  methods: Claim<string[]>;
}

/**
 * The full independent-detection result for one app candidate:
 * both routers' evidence, both route sets, and the same-URL conflicts.
 */
export interface HybridDetection {
  app: RouterEvidence;
  pages: RouterEvidence;
  /** True when both routers have positive evidence. */
  isHybrid: boolean;
  /** App Router route files (page/route/layout/metadata conventions). */
  appRoutes: RouteFileInfo[];
  /** Pages Router route files (full inventory — no longer comparison-only). */
  pagesRoutes: PagesRouteInfo[];
}
