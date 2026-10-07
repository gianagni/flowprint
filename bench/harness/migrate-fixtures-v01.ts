#!/usr/bin/env tsx
/**
 * Flowprint v0.1-alpha — one-shot fixture migration (GAP 1).
 *
 * Rewrites each fixture's routes[] entries from
 *   {file, expectedUrl, expectedConfidence, reason?, method?}
 * to
 *   {file, expectedSkeleton, skeletonConfidence,
 *    expectedConcreteValues, concreteValuesConfidence, reason?, method?}
 *
 * Default mapping (per brief):
 * - skeleton keeps old expectedUrl + expectedConfidence.
 * - concreteValues = R [url] if old confidence was R AND url is fully static,
 *   else U [] with reason "concrete values require runtime data".
 * - expectedUrl === null → concreteValues null at the same confidence
 *   (intercepting routes: skeleton null I → concreteValues null I).
 *
 * Exceptions (per brief):
 * - openstatus apps/status-page/.../login/page.tsx → skeleton R
 *   `/[domain]/[locale]/login`, concreteValues U [] ("concrete values come
 *   from customer DB" per the fixture's own reason).
 * - karakeep apps/web/app/api/[[...route]]/route.ts → skeleton null U,
 *   concreteValues null U (adapter-delegated catch-all).
 *
 * Idempotent: entries that already have expectedSkeleton are skipped.
 * Preserves the fixtures' compact single-line JSON formatting.
 *
 * Usage: npx tsx bench/harness/migrate-fixtures-v01.ts
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const FIXTURES_DIR = new URL('../fixtures/', import.meta.url).pathname;

interface OldRoute {
  file: string;
  expectedUrl: string | null;
  expectedConfidence: 'R' | 'I' | 'U';
  reason?: string;
  method?: string[];
  [k: string]: unknown;
}

const CV_RUNTIME_REASON = 'concrete values require runtime data';

function migrateRoute(slug: string, r: OldRoute): Record<string, unknown> {
  const out: Record<string, unknown> = { file: r.file };

  // ---- exceptions ----
  if (
    slug === 'openstatus' &&
    r.file === 'apps/status-page/src/app/(status-page)/[domain]/[locale]/(auth)/login/page.tsx'
  ) {
    out['expectedSkeleton'] = '/[domain]/[locale]/login';
    out['skeletonConfidence'] = 'R';
    out['expectedConcreteValues'] = [];
    out['concreteValuesConfidence'] = 'U';
    out['reason'] =
      'skeleton is R (groups stripped per Next.js convention); concrete values come from customer DB — URL space unbounded';
    if (r.method !== undefined) out['method'] = r.method;
    return out;
  }
  if (slug === 'karakeep' && r.file === 'apps/web/app/api/[[...route]]/route.ts') {
    out['expectedSkeleton'] = null;
    out['skeletonConfidence'] = 'U';
    out['expectedConcreteValues'] = null;
    out['concreteValuesConfidence'] = 'U';
    out['reason'] = r.reason;
    if (r.method !== undefined) out['method'] = r.method;
    return out;
  }

  // ---- default mapping ----
  out['expectedSkeleton'] = r.expectedUrl;
  out['skeletonConfidence'] = r.expectedConfidence;
  if (r.expectedUrl === null) {
    out['expectedConcreteValues'] = null;
    out['concreteValuesConfidence'] = r.expectedConfidence;
  } else if (r.expectedConfidence === 'R' && !r.expectedUrl.includes('[')) {
    out['expectedConcreteValues'] = [r.expectedUrl];
    out['concreteValuesConfidence'] = 'R';
  } else {
    out['expectedConcreteValues'] = [];
    out['concreteValuesConfidence'] = 'U';
  }
  if (r.reason !== undefined) out['reason'] = r.reason;
  if (r.method !== undefined) out['method'] = r.method;
  return out;
}

async function main(): Promise<void> {
  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json')).sort();
  for (const f of files) {
    const slug = f.replace(/\.json$/, '');
    const path = join(FIXTURES_DIR, f);
    const raw = await readFile(path, 'utf8');
    const fixture = JSON.parse(raw) as { routes?: OldRoute[] };
    if (!fixture.routes) {
      console.log(`${slug}: no routes[] — skipped`);
      continue;
    }
    let migrated = 0;
    let skipped = 0;
    const before = fixture.routes.map((r) => ({ ...r }));
    const next = fixture.routes.map((r) => {
      if ((r as Record<string, unknown>)['expectedSkeleton'] !== undefined) {
        skipped++;
        return r;
      }
      migrated++;
      return migrateRoute(slug, r);
    });
    if (migrated === 0) {
      console.log(`${slug}: already migrated (${skipped} entries) — skipped`);
      continue;
    }
    fixture.routes = next as OldRoute[];
    await writeFile(path, JSON.stringify(fixture));
    console.log(`${slug}: migrated ${migrated} routes[] entries (${skipped} already migrated)`);
    // Print the before/after for hand verification.
    for (let i = 0; i < next.length; i++) {
      const a = before[i] as unknown as Record<string, unknown>;
      const b = next[i] as unknown as Record<string, unknown>;
      console.log(`  ${b['file']}`);
      console.log(`    before: ${a['expectedConfidence']}:${JSON.stringify(a['expectedUrl'])}`);
      console.log(`    after:  skeleton ${b['skeletonConfidence']}:${JSON.stringify(b['expectedSkeleton'])} | concrete ${b['concreteValuesConfidence']}:${JSON.stringify(b['expectedConcreteValues'])}`);
    }
  }
}

main().catch((err) => {
  console.error('migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
