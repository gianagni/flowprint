/**
 * Flowprint M0 — benchmark fixture schema.
 * Mirrors bench/fixtures/SCHEMA.md (the fixture agent's schema is authoritative).
 * Fixtures contain ONLY manually-verified facts from the validation study.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Confidence } from '../../packages/flowprint/src/model/types.js';

export interface FixtureAlias {
  pattern: string;
  targets: string[];
  ownerTsconfig: string;
  expectedConfidence: Confidence;
}

export interface FixtureEdgeEntry {
  file: string | null;
  exportShape?: string;
  expectedConfidence: Confidence;
  noMiddlewareTs?: boolean;
  noProxyTs?: boolean;
  note?: string;
}

export interface FixtureApp {
  name: string | null;
  dir: string;
  framework: string;
  tsconfig?: { path: string; extends?: string | string[] | null; baseUrl?: string };
  aliases?: FixtureAlias[];
  edgeEntry?: FixtureEdgeEntry;
}

export interface FixtureRoute {
  file: string;
  expectedUrl: string | null;
  expectedConfidence: Confidence;
  method?: string[];
  reason?: string;
}

export interface FixtureImportCase {
  fromFile: string;
  specifier: string;
  /**
   * Repo-relative resolved path, or null when expected unresolvable/external.
   * LEAF-FILE CAVEAT (per SCHEMA.md): may be a verified directory PREFIX rather
   * than the exact leaf file — the harness accepts actual paths under the prefix.
   */
  expectedResolved: string | null;
  expectedConfidence: Confidence;
  note?: string;
}

export interface FixtureCount {
  value: number;
  expectedConfidence: Confidence;
}

export interface FixtureAmbiguity {
  area: string;
  detail: string;
  expectedConfidence: Confidence;
  /**
   * OPTIONAL additive hint for the v2 benchmark taxonomy
   * (bench/harness/compare.ts `ambiguityIsOutOfScope`). Never changes
   * pass/fail semantics: it only selects between non-OK verdicts
   * (UNSUPPORTED_FEATURE vs HONEST_UNKNOWN) for ambiguity entries the
   * analyzer did not surface as unknown.
   *
   * - 'out-of-scope': the entry demands the analyzer name/claim a
   *   framework-specific concept outside its documented supported scope
   *   (e.g. NestJS DI bindings, Express route tables, Hono endpoint
   *   enumeration, Ember component resolution). Use for the v0.1-alpha
   *   triage's "109 over-specificity" class.
   * - 'in-scope': explicitly NOT out of scope; overrides the harness's
   *   derived framework-name heuristic (escape hatch for entries that
   *   merely mention an unsupported framework in passing).
   * - absent: the harness derives out-of-scope-ness by matching the
   *   entry's area/detail against the analyzer's own explicit
   *   unsupported-boundary output for that repo (AnalysisResult.boundaries,
   *   from the analyzer's documented scope table). See compare.ts for the
   *   precise rule and its documented limitation.
   */
  scope?: 'in-scope' | 'out-of-scope';
}

export interface Fixture {
  repo: string;
  url: string;
  slug: string;
  apps: FixtureApp[];
  routes: FixtureRoute[];
  counts: Record<string, FixtureCount>;
  importCases: FixtureImportCase[];
  ambiguities: FixtureAmbiguity[];
}

export async function loadFixtures(fixturesDir: string): Promise<Fixture[]> {
  const files = (await readdir(fixturesDir)).filter((f) => f.endsWith('.json')).sort();
  const out: Fixture[] = [];
  for (const f of files) {
    const raw = await readFile(join(fixturesDir, f), 'utf8');
    out.push(JSON.parse(raw) as Fixture);
  }
  return out;
}
