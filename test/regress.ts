/**
 * Flowprint — focused regression tests for the dogfood hardening pass.
 *
 * Issue 1: "Start here" orientation section.
 * Issue 2: nested Next.js metadata route modeling (parent hierarchy preserved).
 * Issue 3: wrapped/builder server-action candidates.
 *
 * Run: `pnpm test` (tsx test/regress.ts). Exit non-zero on any failure.
 * Plain node:assert — no test framework dependency.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mapUrl, type RouteFileInfo } from '../packages/flowprint/src/framework/routes.js';
import { parseSource } from '../packages/flowprint/src/parsing/index.js';
import { inventoryServerActions } from '../packages/flowprint/src/framework/serverActions.js';
import { analyzeRepository } from '../packages/flowprint/src/index.js';
import { discoverRepo } from '../packages/flowprint/src/discovery/index.js';

let passed = 0;
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function check(name: string, fn: () => void | Promise<void>): void {
  queue.push({ name, fn });
}

async function main(): Promise<void> {
  for (const { name, fn } of queue) {
    await fn();
    passed++;
    console.log(`  ok: ${name}`);
  }
  console.log(`\n${passed} regression checks passed.`);
}

// ---------------------------------------------------------------- Issue 2
console.log('Issue 2 — nested metadata routes keep parent hierarchy');

function rf(file: string, leaf: string, segments: string[]): RouteFileInfo {
  return { file, kind: 'metadata', leaf, segments };
}

check('nested opengraph-image preserves parent segments, groups stripped, dynamics kept', () => {
  const m = mapUrl(rf('apps/dashboard/src/app/[locale]/(public)/i/[token]/opengraph-image.tsx', 'opengraph-image', ['[locale]', '(public)', 'i', '[token]']));
  assert.equal(m.url, '/[locale]/i/[token]/opengraph-image');
  assert.equal(m.confidence, 'I');
});

check('nested twitter-image under dynamic segment', () => {
  const m = mapUrl(rf('app/blog/[slug]/twitter-image.tsx', 'twitter-image', ['blog', '[slug]']));
  assert.equal(m.url, '/blog/[slug]/twitter-image');
  assert.equal(m.confidence, 'I');
});

check('root-level metadata unchanged (no parent to preserve)', () => {
  const m = mapUrl(rf('app/opengraph-image.tsx', 'opengraph-image', []));
  assert.equal(m.url, '/opengraph-image');
  assert.equal(m.confidence, 'I');
});

check('root icon.tsx unchanged', () => {
  const m = mapUrl(rf('app/icon.tsx', 'icon', []));
  assert.equal(m.url, '/icon');
  assert.equal(m.confidence, 'I');
});

check('parallel slot in parent is stripped and noted', () => {
  const m = mapUrl(rf('app/@modal/dashboard/opengraph-image.tsx', 'opengraph-image', ['@modal', 'dashboard']));
  assert.equal(m.url, '/dashboard/opengraph-image');
  assert.ok(m.notes.some((n) => n.includes('@modal')));
});

check('intercepting parent segment -> null URL at I (consistent with pages)', () => {
  const m = mapUrl(rf('app/(.)preview/opengraph-image.tsx', 'opengraph-image', ['(.)preview']));
  assert.equal(m.url, null);
  assert.equal(m.confidence, 'I');
});

check('regular page mapping unchanged by refactor', () => {
  const m = mapUrl({ file: 'app/[locale]/(public)/page.tsx', kind: 'page', leaf: 'page', segments: ['[locale]', '(public)'] });
  assert.equal(m.url, '/[locale]');
  assert.equal(m.confidence, 'R');
});

check('unrecognized metadata leaf still U', () => {
  const m = mapUrl(rf('app/weird-meta.tsx', 'weird-meta', ['blog']));
  assert.equal(m.url, null);
  assert.equal(m.confidence, 'U');
});

// ---------------------------------------------------------------- Issue 3
console.log('Issue 3 — wrapped/builder server-action candidates');

const BUILDER_SRC = `'use server';
export const getTaxRateAction = authActionClient
  .schema({})
  .metadata({})
  .action(async (input) => {
    return input;
  });
`;

check('builder-pattern export is a candidate at I (not R), with evidence reason', () => {
  const rec = parseSource('src/actions/tax.ts', BUILDER_SRC);
  assert.equal(rec.directives.includes('use server'), true);
  const inv = inventoryServerActions('', new Map([[rec.file, rec]]));
  assert.equal(inv.files.length, 1);
  const f = inv.files[0];
  assert.deepEqual(f.actions.value, []);
  assert.equal(f.actionCandidates.length, 1);
  const c = f.actionCandidates[0];
  assert.equal(c.name, 'getTaxRateAction');
  assert.equal(c.confidence, 'I');
  assert.ok(c.reason.includes('async callback'), `reason was: ${c.reason}`);
  assert.ok(c.reason.includes('authActionClient'), `reason was: ${c.reason}`);
});

check('direct exported async function still detected (no regression)', () => {
  const rec = parseSource('src/actions/direct.ts', `'use server';\nexport async function doThing() { return 1; }\n`);
  const inv = inventoryServerActions('', new Map([[rec.file, rec]]));
  assert.equal(inv.files.length, 1);
  assert.deepEqual(inv.files[0].actions.value, ['doThing']);
  assert.equal(inv.files[0].actionCandidates.length, 0);
});

check('builder export WITHOUT use server -> no candidates (FP avoidance)', () => {
  const rec = parseSource('src/lib/wrap.ts', BUILDER_SRC.replace(`'use server';\n`, ''));
  const inv = inventoryServerActions('', new Map([[rec.file, rec]]));
  assert.equal(inv.files.length, 0);
});

check('chained call WITHOUT async callback -> no candidate (FP avoidance)', () => {
  const rec = parseSource('src/actions/plain.ts', `'use server';\nexport const cfg = client.schema({});\n`);
  const inv = inventoryServerActions('', new Map([[rec.file, rec]]));
  assert.equal(inv.files.length, 1);
  assert.equal(inv.files[0].actionCandidates.length, 0);
});

check('plain (non-call) export -> no candidate', () => {
  const rec = parseSource('src/actions/const.ts', `'use server';\nexport const x = 42;\n`);
  const inv = inventoryServerActions('', new Map([[rec.file, rec]]));
  assert.equal(inv.files[0].actionCandidates.length, 0);
});

check('non-chained call with async callback is also a candidate', () => {
  const rec = parseSource('src/actions/simple.ts', `'use server';\nexport const runJob = createAction(async () => {});\n`);
  const inv = inventoryServerActions('', new Map([[rec.file, rec]]));
  const cands = inv.files[0].actionCandidates;
  assert.equal(cands.length, 1);
  assert.equal(cands[0].name, 'runJob');
  assert.equal(cands[0].confidence, 'I');
});

// ---------------------------------------------------------------- Issue 1
check('app with only a nested page: I representative entry, honestly marked', async () => {
  const dir = writeRepo({
    'package.json': NEXT_PKG,
    'app/layout.tsx': 'export default function Layout({children}: any) { return children; }\n',
    'app/docs/getting-started/page.tsx': 'export default function Page() { return null; }\n',
  });
  try {
    const r = await analyzeRepository(dir);
    const sh = r.apps[0].startHere;
    const rep = sh.find((s) => s.file === 'app/docs/getting-started/page.tsx');
    assert.ok(rep, `startHere was: ${JSON.stringify(sh)}`);
    assert.equal(rep!.confidence, 'I');
    assert.ok(rep!.reason.includes('representative entry'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log('Issue 1 — Start here orientation');

function writeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fp-start-here-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const NEXT_PKG = JSON.stringify({ name: 'seikarsa-smoke', version: '0.0.0', dependencies: { next: '16.0.0' } });

check('trivial app: Start here answers orientation even with zero edge entries', async () => {
  const dir = writeRepo({
    'package.json': NEXT_PKG,
    'app/layout.tsx': 'export default function Layout({children}: any) { return children; }\n',
    'app/(marketing)/page.tsx': 'export default function Page() { return null; }\n',
  });
  try {
    const r = await analyzeRepository(dir);
    assert.equal(r.apps.length, 1);
    const sh = r.apps[0].startHere;
    const byFile = new Map(sh.map((s) => [s.file, s]));
    assert.ok(byFile.has('app/layout.tsx'), `startHere was: ${JSON.stringify(sh)}`);
    assert.equal(byFile.get('app/layout.tsx')!.confidence, 'R');
    assert.ok(byFile.get('app/layout.tsx')!.reason.includes('root App Router layout'));
    // No page file at the router root, but the group-wrapped page serves '/'
    // at R per the URL mapping — so it IS the root page (R, not a guess).
    const rep = byFile.get('app/(marketing)/page.tsx');
    assert.ok(rep, `startHere was: ${JSON.stringify(sh)}`);
    assert.equal(rep!.confidence, 'R');
    assert.ok(rep!.reason.includes("serves the app's base URL"));
    // Entry points stays as it was (raw boundaries); Start here is separate.
    assert.equal(r.entryPoints.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('app with proxy + instrumentation: full structural set, deterministic order', async () => {
  const dir = writeRepo({
    'package.json': NEXT_PKG,
    'app/layout.tsx': 'export default function Layout({children}: any) { return children; }\n',
    'app/page.tsx': 'export default function Page() { return null; }\n',
    'proxy.ts': 'export default function proxy() { return null; }\n',
    'instrumentation.ts': 'export function register() {}\n',
  });
  try {
    const r = await analyzeRepository(dir);
    const sh = r.apps[0].startHere;
    const files = sh.map((s) => s.file);
    assert.deepEqual(files, ['app/layout.tsx', 'app/page.tsx', 'proxy.ts', 'instrumentation.ts']);
    assert.ok(sh.every((s) => s.confidence === 'R'));
    assert.ok(sh.every((s) => s.reason.length > 0));
    // Entry points section unchanged and separate.
    assert.ok(r.entryPoints.some((e) => e.file === 'proxy.ts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- DOGFOOD-04 + 03
console.log('DOGFOOD-04 — route-handler-only Next.js apps are detected');
console.log('DOGFOOD-03 — unsupported application candidates stay honest');

const ROUTE_ONLY_PKG = JSON.stringify({
  name: 'api-only',
  version: '0.0.0',
  dependencies: { next: '16.0.0' },
  scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
});

check('route-handler-only Next.js package: app conventions detected (no page/layout)', async () => {
  const dir = writeRepo({
    'package.json': ROUTE_ONLY_PKG,
    'next.config.ts': 'export default {};\n',
    'app/route.ts': 'export function GET() { return Response.json({}); }\n',
    'app/health/route.ts': 'export function GET() { return new Response("ok"); }\n',
  });
  try {
    const d = await discoverRepo(dir);
    const c = d.appCandidates.find((x) => x.dir === '');
    assert.ok(c, 'candidate missing');
    assert.equal(c.hasAppConventions, true);
    assert.equal(c.appDir, 'app');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('route-handler-only app: full analysis yields R nextjs-app-router + inventoried routes', async () => {
  const dir = writeRepo({
    'package.json': ROUTE_ONLY_PKG,
    'next.config.ts': 'export default {};\n',
    'app/route.ts':
      'export function GET() { return Response.json({}); }\nexport function POST() { return Response.json({}); }\n',
  });
  try {
    const r = await analyzeRepository(dir);
    assert.equal(r.apps.length, 1);
    assert.equal(r.apps[0].framework.value, 'nextjs-app-router');
    assert.equal(r.apps[0].framework.confidence, 'R');
    const urls = r.routes.map((x) => x.skeleton.value);
    assert.ok(urls.includes('/'), `routes were: ${JSON.stringify(urls)}`);
    // Start Here must not fabricate a page/layout that does not exist.
    const shFiles = r.apps[0].startHere.map((s) => s.file);
    assert.ok(!shFiles.some((f) => f.endsWith('page.tsx') || f.endsWith('layout.tsx')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('non-Next package with app/**/route.js (Ember-like): NOT Next.js app evidence', async () => {
  const dir = writeRepo({
    'package.json': JSON.stringify({
      name: 'ember-like',
      version: '0.0.0',
      dependencies: { 'ember-source': '1.0.0' },
    }),
    'app/utils/route.js': 'export default {};\n',
  });
  try {
    const d = await discoverRepo(dir);
    const c = d.appCandidates.find((x) => x.dir === '');
    assert.ok(!c || c.hasAppConventions === false, 'ember-like route.js must not count as Next.js conventions');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('unsupported app candidate: hono + start script, no Next conventions', async () => {
  const dir = writeRepo({
    'package.json': JSON.stringify({
      name: 'api-svc',
      version: '0.0.0',
      dependencies: { hono: '4.0.0' },
      scripts: { dev: 'tsx watch src/index.ts', start: 'node dist/index.js' },
    }),
    'src/index.ts': 'export default {};\n',
  });
  try {
    const d = await discoverRepo(dir);
    assert.equal(d.appCandidates.filter((c) => c.hasAppConventions || c.hasPagesDir).length, 0);
    assert.equal(d.unsupportedAppCandidates.length, 1);
    const u = d.unsupportedAppCandidates[0];
    assert.deepEqual(u.frameworks, ['Hono']);
    assert.ok(u.evidence.includes('start script') && u.evidence.includes('hono'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('library with framework in devDependencies only: NOT an unsupported candidate', async () => {
  const dir = writeRepo({
    'package.json': JSON.stringify({
      name: 'my-lib',
      version: '0.0.0',
      devDependencies: { express: '4.0.0' },
      scripts: { dev: 'tsx watch src/index.ts', build: 'tsc', start: 'node dist/index.js' },
    }),
    'src/index.ts': 'export default {};\n',
  });
  try {
    const d = await discoverRepo(dir);
    assert.equal(d.unsupportedAppCandidates.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('framework dep but no start script: NOT an unsupported candidate', async () => {
  const dir = writeRepo({
    'package.json': JSON.stringify({
      name: 'ui-kit',
      version: '0.0.0',
      dependencies: { vue: '3.0.0' },
      scripts: { dev: 'vite', build: 'vite build' },
    }),
    'src/index.ts': 'export default {};\n',
  });
  try {
    const d = await discoverRepo(dir);
    assert.equal(d.unsupportedAppCandidates.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

main().catch((e) => {
  console.error("REGRESSION FAIL:", e);
  process.exit(1);
});
