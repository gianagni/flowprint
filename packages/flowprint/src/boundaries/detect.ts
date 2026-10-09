/**
 * Flowprint M0 — unsupported boundary detection (Blocker B3).
 *
 * Dependency-scan only: reads the package.json records collected by
 * discovery (root + workspace/app packages) and maps known dependency
 * names to framework names via a data-driven table. No new framework
 * detectors, no repo-specific logic, no filesystem convention scanning.
 *
 * Deliberately NOT emitted: supported surface (Next.js — any router;
 * tRPC procedures — supported in v0.1-alpha). Those have real analysis,
 * so naming them as "boundaries" would be wrong.
 *
 * NOTE on Hono: the framework layer detects hono *adapters* embedded for
 * serving tRPC (framework/trpc.ts), but Hono route enumeration is not
 * supported — so a Hono boundary is still emitted when `hono` is a
 * dependency. The adapter detection lives in the tRPC analysis area,
 * not here.
 */
import type { DiscoveryResult, PackageJsonInfo } from '../discovery/index.js';
import type { UnsupportedBoundary } from './types.js';

type AreaStatus = 'Supported' | 'Unsupported';

interface FrameworkRule {
  /** Display name, e.g. "NestJS". */
  name: string;
  /** Dependency names that signal the framework (checked in dependencies, devDependencies, peerDependencies). */
  packages: string[];
  /** Per-area support status emitted when the framework is detected. */
  areas: Array<{ area: string; status: AreaStatus }>;
}

/** Shared analysis for HTTP-server frameworks: imports resolve, routes do not. */
const HTTP_SERVER_AREAS: Array<{ area: string; status: AreaStatus }> = [
  { area: 'Module resolution', status: 'Supported' },
  { area: 'HTTP routes', status: 'Unsupported' },
];

/** Shared analysis for GraphQL servers: imports resolve, schema/resolvers do not. */
const GRAPHQL_SERVER_AREAS: Array<{ area: string; status: AreaStatus }> = [
  { area: 'Module resolution', status: 'Supported' },
  { area: 'GraphQL resolvers', status: 'Unsupported' },
];

const RULES: FrameworkRule[] = [
  {
    name: 'NestJS',
    packages: ['@nestjs/core'],
    areas: [
      ...HTTP_SERVER_AREAS,
      { area: 'DI bindings / providers', status: 'Unsupported' },
    ],
  },
  { name: 'Fastify', packages: ['fastify'], areas: HTTP_SERVER_AREAS },
  { name: 'Hono', packages: ['hono'], areas: HTTP_SERVER_AREAS },
  { name: 'Elysia', packages: ['elysia'], areas: HTTP_SERVER_AREAS },
  { name: 'Express', packages: ['express'], areas: HTTP_SERVER_AREAS },
  { name: 'GraphQL', packages: ['graphql'], areas: GRAPHQL_SERVER_AREAS },
  { name: 'Apollo Server', packages: ['@apollo/server'], areas: GRAPHQL_SERVER_AREAS },
  {
    name: 'Vue',
    packages: ['vue'],
    areas: [
      { area: 'Module resolution', status: 'Supported' },
      { area: 'Vue Router / file-based routes', status: 'Unsupported' },
    ],
  },
];

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

/**
 * Frameworks Flowprint explicitly checks for via dependency-name scan.
 * Exported (AC-048) so output and tests can state the detection scope
 * truthfully — "no unsupported frameworks detected" must never imply
 * global coverage. Frameworks outside this list are not detected.
 */
export const CHECKED_FRAMEWORKS: readonly string[] = RULES.map((r) => r.name);

/**
 * Human-readable detection-scope lines for "none detected" output
 * (TR-005/AC-048). States the finite check list explicitly so quiet
 * results are never misread as "this repo has no applications".
 */
export function frameworkScopeLines(unsupportedAppFrameworks: readonly string[]): string[] {
  const scopeList = [...new Set([...CHECKED_FRAMEWORKS, ...unsupportedAppFrameworks])];
  return [
    '  Detection scope: Next.js App/Pages Router file conventions, plus',
    `  dependency scan for: ${scopeList.join(', ')}.`,
    '  Frameworks outside this list are not detected — "none detected"',
    '  means "none detected by these checks", not "no application exists".',
  ];
}

interface DepHit {
  /** Dependency name as written in package.json. */
  dep: string;
  /** Which dependency section it was found in. */
  section: string;
  /** Repo-relative package dir; '' for the repo root. */
  dir: string;
}

function depNames(pkg: PackageJsonInfo, section: string): string[] {
  const raw = pkg.raw[section];
  if (raw == null || typeof raw !== 'object') return [];
  return Object.keys(raw as Record<string, unknown>);
}

/**
 * Scan dependency records for detected-but-unsupported frameworks.
 * Emits at most one boundary per framework, in table order.
 */
export function detectBoundaries(args: {
  repoRoot: string;
  discovery: DiscoveryResult;
}): UnsupportedBoundary[] {
  const { discovery } = args;
  const out: UnsupportedBoundary[] = [];

  for (const rule of RULES) {
    const hits: DepHit[] = [];
    for (const pkg of discovery.packages) {
      for (const section of DEP_SECTIONS) {
        for (const dep of depNames(pkg, section)) {
          if (rule.packages.includes(dep)) {
            hits.push({ dep, section, dir: pkg.dir });
          }
        }
      }
    }
    if (hits.length === 0) continue;

    // De-dupe identical dep hits (e.g. same dep listed in two sections of one package).
    const seen = new Set<string>();
    const uniqueHits = hits.filter((h) => {
      const key = `${h.dep}|${h.section}|${h.dir}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const evidence = uniqueHits
      .map((h) => `${h.dep} in package.json ${h.section}${h.dir ? ` (${h.dir})` : ''}`)
      .join('; ');

    out.push({
      name: rule.name,
      evidence,
      analysis: rule.areas.map((a) => ({ area: a.area, status: a.status })),
    });
  }

  return out;
}
