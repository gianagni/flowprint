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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mapUrl, type RouteFileInfo } from '../packages/flowprint/src/framework/routes.js';
import { collectRouteFiles } from '../packages/flowprint/src/framework/routes.js';
import { parseSource } from '../packages/flowprint/src/parsing/index.js';
import { crashedRecord } from '../packages/flowprint/src/parsing/index.js';
import { parseFilesIsolated } from '../packages/flowprint/src/parsing/isolated.js';
import { inventoryServerActions } from '../packages/flowprint/src/framework/serverActions.js';
import { analyzeTrpcSurface } from '../packages/flowprint/src/framework/trpc.js';
import { createResolutionContext } from '../packages/flowprint/src/resolution/index.js';
import { stripTsComments, stripCommentsExact } from '../packages/flowprint/src/framework/edge.js';
import { frameworkScopeLines } from '../packages/flowprint/src/boundaries/detect.js';
import { analyzeRepository, renderReport } from '../packages/flowprint/src/index.js';
import { discoverRepo, CHECKED_UNSUPPORTED_APP_FRAMEWORKS } from '../packages/flowprint/src/discovery/index.js';
import { dirErrorCode, type DirReadFailure } from '../packages/flowprint/src/model/types.js';

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

// ---------------------------------------------------------------- S2 — WP-A
console.log('S2 — WP-A reliability & trust');

const NEXT_APP_PKG = JSON.stringify({
  name: 's2-app',
  version: '0.0.0',
  dependencies: { next: '14.2.0' },
});
const PAGE_TSX = 'export default function Page() { return <h1>x</h1>; }\n';

function s2Repo(files: Record<string, string>): string {
  return writeRepo({ 'package.json': NEXT_APP_PKG, ...files });
}
function unknownsOf(r: { unknowns: Array<{ area: string; detail: string; reason: string }> }) {
  return r.unknowns;
}

// TR-001: baseUrl-relative target without ./ must not warn when it exists.
check('TR-001: "@/*" -> "src/*" (baseUrl-relative, exists) produces no alias warning', async () => {
  const dir = s2Repo({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    }),
    'app/page.tsx': PAGE_TSX,
    'src/util.ts': 'export const x = 1;\n',
  });
  try {
    const r = await analyzeRepository(dir);
    const hits = unknownsOf(r).filter((u) => u.area === 'alias target absent on disk');
    assert.equal(hits.length, 0, `unexpected alias warnings: ${JSON.stringify(hits)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-001: a genuinely missing relative target still warns.
check('TR-001: "@/*" -> "./nope/*" (missing) still warns', async () => {
  const dir = s2Repo({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['./nope/*'] } },
    }),
    'app/page.tsx': PAGE_TSX,
  });
  try {
    const r = await analyzeRepository(dir);
    const hits = unknownsOf(r).filter((u) => u.area === 'alias target absent on disk');
    assert.equal(hits.length, 1);
    assert.match(hits[0].detail, /nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-001: valid workspace-package target is chained, no warning.
check('TR-001: "s2-app/*" -> "s2-app/*" (workspace package) produces no warning', async () => {
  const dir = s2Repo({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { 's2-app/*': ['s2-app/*'] } },
    }),
    'app/page.tsx': PAGE_TSX,
  });
  try {
    const r = await analyzeRepository(dir);
    const hits = unknownsOf(r).filter((u) => u.area === 'alias target absent on disk');
    assert.equal(hits.length, 0, `unexpected alias warnings: ${JSON.stringify(hits)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-001: unknown bare package target warns (not silently chained).
check('TR-001: "@x/*" -> "@nonexistent-pkg/*" warns', async () => {
  const dir = s2Repo({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@x/*': ['@nonexistent-pkg/*'] } },
    }),
    'app/page.tsx': PAGE_TSX,
  });
  try {
    const r = await analyzeRepository(dir);
    const hits = unknownsOf(r).filter((u) => u.area === 'alias target absent on disk');
    assert.equal(hits.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-002: absent alias targets are reported as observed absence, never "dead"/"stale".
check('TR-002: alias warning uses observed-absence language only', async () => {
  const dir = s2Repo({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['./gone/*'] } },
    }),
    'app/page.tsx': PAGE_TSX,
  });
  try {
    const r = await analyzeRepository(dir);
    assert.ok(
      unknownsOf(r).every((u) => u.area !== 'stale tsconfig entries'),
      'old "stale tsconfig entries" area must not appear',
    );
    const hits = unknownsOf(r).filter((u) => u.area === 'alias target absent on disk');
    assert.equal(hits.length, 1);
    assert.ok(!/dead alias|dead \(|stale/i.test(hits[0].detail), `misleading label: ${hits[0].detail}`);
    assert.ok(!/dead alias|dead \(|stale/i.test(hits[0].reason), `misleading reason: ${hits[0].reason}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-003: a crashed isolated record gates the in-process tRPC parse.
check('TR-003: crashed file is not parsed in-process; becomes reported Unknown', async () => {
  const dir = writeRepo({
    'package.json': JSON.stringify({ name: 'trpc-gate', version: '0.0.0' }),
    'server/router.ts':
      "import { fetchRequestHandler } from '@trpc/server/adapters/fetch';\nexport const handler = (req: Request) =>\n  fetchRequestHandler({ endpoint: '/api/trpc', req, router: null as any });\n",
  });
  try {
    // The isolated child crashed on this file — the main process must not
    // feed it to the unisolated parser even though adapter-call text matches.
    const records = new Map([['server/router.ts', crashedRecord('server/router.ts', 'simulated crash')]]);
    const rctx = createResolutionContext(dir, new Map(), records);
    const { unknowns, procedures } = await analyzeTrpcSurface(dir, ['server/router.ts'], records, rctx);
    assert.equal(procedures.length, 0);
    const hit = unknowns.find((u) => u.area === 'tRPC surface' && u.detail.includes('server/router.ts'));
    assert.ok(hit, `expected gated-file unknown, got: ${JSON.stringify(unknowns)}`);
    assert.match(hit.detail, /skipped/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-003: identical content parsed fine in isolation still enumerates procedures.
check('TR-003: healthy isolated record still allows tRPC enumeration', async () => {
  const dir = writeRepo({
    'package.json': JSON.stringify({ name: 'trpc-app', version: '0.0.0' }),
    'server/trpc.ts':
      'export const router = (o: any) => o;\nexport const publicProcedure = { query: (fn: any) => ({ _q: fn }) };\n',
    'server/router.ts':
      "import { router, publicProcedure } from './trpc';\nexport const appRouter = router({\n  hello: publicProcedure.query(() => 'hi'),\n});\n",
    'app/api/trpc/[trpc]/route.ts':
      "import { fetchRequestHandler } from '@trpc/server/adapters/fetch';\nimport { appRouter } from '../../../../server/router';\nconst handler = (req: Request) =>\n  fetchRequestHandler({ endpoint: '/api/trpc', req, router: appRouter });\nexport { handler as GET };\n",
  });
  try {
    const rels = ['server/trpc.ts', 'server/router.ts', 'app/api/trpc/[trpc]/route.ts'];
    const records = await parseFilesIsolated(dir, rels);
    for (const rel of rels) {
      const rec = records.get(rel);
      assert.ok(rec && !rec.crashed, `expected healthy record for ${rel}`);
    }
    const rctx = createResolutionContext(dir, new Map(), records);
    const { unknowns, procedures } = await analyzeTrpcSurface(dir, rels, records, rctx);
    assert.equal(procedures.length, 1, `procedures: ${JSON.stringify(procedures)}`);
    assert.equal(procedures[0].path, '/api/trpc/hello');
    assert.ok(
      !unknowns.some((u) => /skipped/i.test(u.detail)),
      `unexpected gate skip: ${JSON.stringify(unknowns)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-004: comment-only "hostname" mention must not trigger.
check('TR-004: hostname in comment only does not trigger', async () => {
  const dir = s2Repo({
    'app/page.tsx': PAGE_TSX,
    'middleware.ts':
      '// hostname-based routing is handled further down\n' +
      'export function middleware() { return Response.next(); }\n',
  });
  try {
    const r = await analyzeRepository(dir);
    const hits = unknownsOf(r).filter((u) => u.area === 'hostname dispatch rules');
    assert.equal(hits.length, 0, `comment triggered: ${JSON.stringify(hits)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-004: comment-only NextResponse.rewrite must not trigger.
check('TR-004: NextResponse.rewrite in comment only does not trigger', async () => {
  const dir = s2Repo({
    'app/page.tsx': PAGE_TSX,
    'middleware.ts':
      '// TODO: consider NextResponse.rewrite here later\n' +
      'export function middleware() { return Response.next(); }\n',
  });
  try {
    const r = await analyzeRepository(dir);
    const hits = unknownsOf(r).filter((u) => u.area === 'middleware rewrites');
    assert.equal(hits.length, 0, `comment triggered: ${JSON.stringify(hits)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-004: real hostname reference reports the reference, never "dispatches by hostname".
check('TR-004: real hostname reference is weakened to observed reference', async () => {
  const dir = s2Repo({
    'app/page.tsx': PAGE_TSX,
    'middleware.ts':
      'export function middleware(req: any) {\n  const hostname = req.headers.get("host");\n  return Response.next();\n}\n',
  });
  try {
    const r = await analyzeRepository(dir);
    const hits = unknownsOf(r).filter((u) => u.area === 'hostname dispatch rules');
    assert.equal(hits.length, 1);
    assert.ok(
      !/dispatches by hostname/i.test(hits[0].detail),
      `overly strong claim survived: ${hits[0].detail}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-004: repo-specific heuristics are gone (arbitrary env + isAuthProtectedRoute).
check('TR-004: PUBLIC_URL-style arbitrary env and isAuthProtectedRoute do not trigger', async () => {
  const dir = s2Repo({
    'app/page.tsx': PAGE_TSX,
    'middleware.ts':
      'export function middleware() {\n' +
      '  const u = process.env.FOO_BAR_URL;\n' +
      '  if (isAuthProtectedRoute("/x")) return Response.redirect("/login");\n' +
      '  return Response.next();\n}\n',
  });
  try {
    const r = await analyzeRepository(dir);
    const areas = unknownsOf(r).map((u) => u.area);
    assert.ok(!areas.includes('domain-aware proxy routing'), `repo-specific area fired: ${areas}`);
    assert.ok(!areas.includes('auth-protected route list'), `repo-specific area fired: ${areas}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-004 unit: stripTsComments keeps code, drops comments.
check('TR-004 unit: stripTsComments', () => {
  const src =
    'const url = "https://example.com"; // trailing hostname note\n' +
    '/* block NextResponse.rewrite */\n' +
    'const re = /a\\/\\/b/; // regex with slashes\n' +
    'const t = `tpl ${x} end`;\n' +
    'const hostname = getHost();\n';
  const out = stripTsComments(src);
  assert.ok(out.includes('https://example.com'), 'string URL must survive');
  assert.ok(!out.includes('trailing hostname note'), 'line comment must go');
  assert.ok(!out.includes('block NextResponse.rewrite'), 'block comment must go');
  assert.ok(out.includes('/a\\/\\/b/'), 'regex must survive');
  assert.ok(out.includes('`tpl ${x} end`'), 'template must survive');
  assert.ok(out.includes('const hostname = getHost();'), 'code must survive');
});

// TR-005: framework-free repo gets an explicit finite scope, never "no application".
check('TR-005: framework-free repo states detection scope explicitly', async () => {
  const dir = writeRepo({
    'package.json': JSON.stringify({ name: 'plain-lib', version: '0.0.0' }),
    'index.js': 'module.exports = {};\n',
  });
  try {
    const d = await discoverRepo(dir);
    assert.equal(d.appCandidates.filter((c) => c.hasAppConventions || c.hasPagesDir).length, 0);
    assert.equal(d.unsupportedAppCandidates.length, 0);
    const lines = frameworkScopeLines(CHECKED_UNSUPPORTED_APP_FRAMEWORKS);
    const text = lines.join('\n');
    assert.ok(text.includes('Frameworks outside this list are not detected'), text);
    assert.ok(text.includes('Next.js'), text);
    // The scope sentence must qualify "none detected", never assert it absolutely.
    assert.ok(text.includes('"none detected by these checks"'), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-005: unlisted framework (remix-style dep, no Next) stays quiet-but-scoped.
check('TR-005: unlisted framework dep does not imply "no app"', async () => {
  const dir = writeRepo({
    'package.json': JSON.stringify({
      name: 'remix-app',
      version: '0.0.0',
      dependencies: { '@remix-run/node': '2.0.0' },
      scripts: { start: 'remix-serve build' },
    }),
    'app/root.tsx': 'export default function Root() { return null; }\n',
  });
  try {
    const d = await discoverRepo(dir);
    assert.equal(d.appCandidates.filter((c) => c.hasAppConventions || c.hasPagesDir).length, 0);
    // Not in the checked list: honestly absent from candidates, scope sentence covers it.
    const lines = frameworkScopeLines(CHECKED_UNSUPPORTED_APP_FRAMEWORKS);
    assert.ok(lines.join('\n').includes('not detected'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-006 unit: dirErrorCode classification.
check('TR-006 unit: dirErrorCode', () => {
  const eacces = new Error('x') as NodeJS.ErrnoException;
  eacces.code = 'EACCES';
  assert.equal(dirErrorCode(eacces), 'EACCES');
  const enoent = new Error('x') as NodeJS.ErrnoException;
  enoent.code = 'ENOENT';
  assert.equal(dirErrorCode(enoent), null);
  const enotdir = new Error('x') as NodeJS.ErrnoException;
  enotdir.code = 'ENOTDIR';
  assert.equal(dirErrorCode(enotdir), null);
  assert.equal(dirErrorCode(new Error('plain')), 'unknown');
});

// TR-006: a readdir failure is recorded structurally, not swallowed.
check('TR-006: readdir failure is recorded with path and error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-dirfail-'));
  try {
    const failures: DirReadFailure[] = [];
    // Null byte: readdir rejects on every platform (no chmod/root caveats).
    await collectRouteFiles(dir, '\0bad-dir', (f) => failures.push(f));
    assert.equal(failures.length, 1, `expected 1 recorded failure, got ${failures.length}`);
    assert.equal(failures[0].phase, 'analysis');
    assert.ok(failures[0].error.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-006: permission-denied directory (platform-aware — skips honestly when ineffective).
check('TR-006: permission-denied dir is recorded when the platform enforces it', async () => {
  const dir = writeRepo({ 'package.json': JSON.stringify({ name: 'perm', version: '0.0.0' }) });
  const blocked = join(dir, 'blocked');
  mkdirSync(blocked, { recursive: true });
  writeFileSync(join(blocked, 'package.json'), JSON.stringify({ name: 'blocked-pkg' }));
  try {
    chmodSync(blocked, 0o000);
    const d = await discoverRepo(dir);
    const hit = d.dirReadFailures.find(
      (f) => f.path === 'blocked' && (f.error === 'EACCES' || f.error === 'EPERM'),
    );
    if (!hit) {
      console.log('  (skip: platform did not enforce EACCES here — e.g. running as root)');
      return;
    }
    assert.equal(hit.phase, 'discovery');
  } finally {
    chmodSync(blocked, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-006: analysis-level failures land on AnalysisResult.dirReadFailures.
check('TR-006: AnalysisResult carries dirReadFailures', async () => {
  const dir = s2Repo({ 'app/page.tsx': PAGE_TSX });
  try {
    const r = await analyzeRepository(dir);
    assert.ok(Array.isArray(r.dirReadFailures), 'dirReadFailures must be an array');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Collision: same URL in app/ and pages/ is a structural fact with no winner claimed.
check('collision: App-vs-Pages same-URL conflict has no serving winner', async () => {
  const dir = s2Repo({
    'app/page.tsx': PAGE_TSX,
    'app/about/page.tsx': PAGE_TSX,
    'pages/about.tsx': 'export default function About() { return <h1>a</h1>; }\n',
  });
  try {
    const r = await analyzeRepository(dir);
    const app = r.apps.find((a) => a.path === '');
    assert.ok(app, 'root app must be analyzed');
    assert.equal(app.routerConflicts.length, 1);
    const c = app.routerConflicts[0];
    assert.equal(c.url, '/about');
    assert.ok(!('winner' in c), `winner must not be claimed: ${JSON.stringify(c)}`);
    const out = renderReport(r);
    // S4: collisions render under Coverage as structural facts.
    assert.ok(out.includes('Router collisions (structural fact'), 'conflict section must render');
    assert.ok(out.includes('/about'), 'colliding URL must render');
    assert.ok(!out.includes('pages-wins'), 'pages-wins must not render');
    assert.ok(!/Pages Router version/i.test(out), 'serving claim must not render');
    const u = r.unknowns.find((x) => x.area === 'router conflict');
    assert.ok(u, 'router conflict unknown must exist');
    assert.ok(/not.*(determined|decidab)|no winner/i.test(u.reason + ' ' + u.detail), `weak reason: ${u.reason}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TR-007 (S4): rendered output is consistent with the model.
check('TR-007: render counts match model; unknowns are surfaced', async () => {
  const dir = s2Repo({
    'app/page.tsx': PAGE_TSX,
    'app/about/page.tsx': PAGE_TSX,
    'pages/about.tsx': 'export default function About() { return <h1>a</h1>; }\\n',
    'middleware.ts': 'export function middleware() { return Response.next(); }\\n',
  });
  try {
    const r = await analyzeRepository(dir);
    const out = renderReport(r);
    const appRoutes = r.routes.filter((x) => x.router.value === 'app-router');
    const pagesRoutes = r.routes.filter((x) => x.router.value === 'pages-router');
    assert.ok(
      out.includes(`by router: App Router ${appRoutes.length}, Pages Router ${pagesRoutes.length}`),
      'route totals must match model',
    );
    // S4: every finding CATEGORY present in the model appears in the output
    // with its accurate count (small fixture: no capping).
    const cats = new Map<string, number>();
    for (const u of r.unknowns) cats.set(u.category, (cats.get(u.category) ?? 0) + 1);
    for (const [cat, n] of cats) {
      assert.ok(
        out.includes(`${cat} \u2014 ${n} occurrence(s)`) ||
          out.includes(`${cat} \u2014 ${n}`) ||
          out.includes(`${cat}: ${n}`),
        `category missing from output: ${cat} (${n})`,
      );
    }
    // [U] appears only on uncertainty findings \u2014 never on facts.
    const uLines = out.split('\\n').filter((l) => l.includes('[U]'));
    assert.ok(uLines.length > 0, 'uncertainties must render with [U]');
    for (const l of uLines) {
      assert.ok(!/alias target absent|ghost workspace/i.test(l), `fact mislabeled [U]: ${l}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// --------------------------------------------------------------- S3: finding model
console.log('S3 — structured finding model (kind/category/subject)');

import {
  FINDING_KIND_BY_CATEGORY,
  FINDING_CATEGORIES,
  type Finding,
  type FindingCategory,
  type FindingKind,
} from '../packages/flowprint/src/model/types.js';

function s3Repo(files: Record<string, string>): string {
  return writeRepo({ 'package.json': NEXT_APP_PKG, ...files });
}

/** Fixture exercising many finding sites at once. */
function richFindingsRepo(): string {
  return s3Repo({
    'app/page.tsx': PAGE_TSX,
    'app/about/page.tsx': PAGE_TSX, // collides with pages/about.tsx on /about
    'pages/about.tsx': 'export default function About() { return null; }\n',
    'app/blog/[slug]/page.tsx': PAGE_TSX, // dynamic segment
    'app/@modal/page.tsx': PAGE_TSX, // parallel slot
    'middleware.ts':
      "import { NextResponse } from 'next/server';\n" +
      'export function middleware(req: any) {\n' +
      "  const host = req.headers.get('hostname');\n" +
      "  return NextResponse.rewrite(new URL('/x', req.url));\n" +
      '}\n',
    'instrumentation.ts': 'export async function register() {}\n',
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['./nope/*'] } },
    }),
    'next.config.js':
      'const flag = process.env.MY_FLAG ? { a: 1 } : { b: 2 };\n' +
      'async function rewrites() { return []; }\n' +
      'module.exports = { ...flag, rewrites };\n',
    'app/typeuser.ts': "import type { X } from './x';\nexport const y: X = 1;\n",
    'app/x.ts': 'export type X = number;\n',
  });
}

const VALID_KINDS: FindingKind[] = ['fact', 'uncertainty', 'coverage'];

check('S3: every finding has valid kind/category/subject; legacy fields intact', async () => {
  const dir = richFindingsRepo();
  try {
    const r = await analyzeRepository(dir);
    assert.ok(r.unknowns.length > 0, 'fixture must produce findings');
    for (const f of r.unknowns as Finding[]) {
      assert.ok(VALID_KINDS.includes(f.kind), `bad kind: ${JSON.stringify(f)}`);
      assert.ok((FINDING_CATEGORIES as string[]).includes(f.category), `bad category: ${JSON.stringify(f)}`);
      assert.ok(typeof f.subject === 'string' && f.subject.length > 0, `empty subject: ${JSON.stringify(f)}`);
      assert.ok(f.area.length > 0 && f.detail.length > 0 && f.reason.length > 0, `legacy fields must survive: ${JSON.stringify(f)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('S3: kind matches the canonical category mapping (deterministic)', async () => {
  const dir = richFindingsRepo();
  try {
    const r = await analyzeRepository(dir);
    for (const f of r.unknowns as Finding[]) {
      assert.equal(
        f.kind,
        FINDING_KIND_BY_CATEGORY[f.category as FindingCategory],
        `kind/category mismatch: ${f.category} is ${f.kind}, canonical is ${FINDING_KIND_BY_CATEGORY[f.category as FindingCategory]}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('S3: facts and coverage are not misclassified as uncertainty', async () => {
  const dir = richFindingsRepo();
  try {
    const r = await analyzeRepository(dir);
    const byCat = (c: FindingCategory) => (r.unknowns as Finding[]).filter((f) => f.category === c);
    const alias = byCat('alias-target-absent');
    assert.ok(alias.length > 0, 'alias finding expected');
    assert.ok(alias.every((f) => f.kind === 'fact'), 'alias absence is a fact, not uncertainty');
    const typeOnly = byCat('type-only-import-census');
    assert.ok(typeOnly.length > 0, 'type-only finding expected');
    assert.ok(typeOnly.every((f) => f.kind === 'coverage'), 'type-only census is coverage, not [U]');
    const rewrite = byCat('middleware-rewrite-behavior');
    assert.ok(rewrite.length > 0, 'middleware rewrite finding expected');
    assert.ok(rewrite.every((f) => f.kind === 'uncertainty'), 'rewrite behavior is uncertainty');
    // No fact/coverage finding may masquerade as uncertainty.
    for (const f of r.unknowns as Finding[]) {
      if (f.kind === 'uncertainty') {
        assert.ok(
          !['alias-target-absent', 'ghost-workspace', 'misplaced-directive-inert',
            'type-only-import-census', 'dist-src-fallback', 'parse-error-partial',
            'parse-crash-skipped', 'skipped-file', 'trpc-isolation-gated',
            'server-action-inventory-scope'].includes(f.category),
          `fact/coverage category mislabeled uncertainty: ${f.category}`,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('S3: router collision — structural fact and uncertainty are separate, no winner', async () => {
  const dir = s3Repo({
    'app/page.tsx': PAGE_TSX,
    'app/about/page.tsx': PAGE_TSX,
    'pages/about.tsx': 'export default function About() { return null; }\n',
  });
  try {
    const r = await analyzeRepository(dir);
    const app = r.apps.find((a) => a.path === '');
    assert.ok(app, 'root app must be analyzed');
    // Structural fact lives in routerConflicts (url + both files), no winner.
    assert.equal(app.routerConflicts.length, 1);
    const c = app.routerConflicts[0] as unknown as Record<string, unknown>;
    assert.equal(c['url'], '/about');
    assert.ok(c['appRouterFile'], 'app router file must be recorded');
    assert.ok(c['pagesRouterFile'], 'pages router file must be recorded');
    assert.ok(!('winner' in c), `no serving winner may be claimed: ${JSON.stringify(c)}`);
    // The undecided outcome is a separate uncertainty finding.
    const u = (r.unknowns as Finding[]).find((f) => f.category === 'router-collision-outcome');
    assert.ok(u, 'router-collision-outcome uncertainty finding must exist');
    assert.equal(u.kind, 'uncertainty');
    assert.ok(u.subject.length > 0, 'collision finding needs a subject');
    const blob = JSON.stringify([c, u]);
    // No serving winner may be *asserted*: the word may only appear inside an
    // explicit no-winner disclaimer, never as a claimed outcome.
    assert.ok(!/"winner"\s*:\s*"(pages|app)"/i.test(blob), `winner must not be asserted: ${blob}`);
    assert.ok(!/\bwins\b/i.test(blob.replace(/no winner claimed/gi, '')), `no "X wins" claim: ${blob}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('S3: accounting — classification preserves finding count; grouping deterministic', async () => {
  const dir = richFindingsRepo();
  const tally = (us: Finding[]) => {
    const m = new Map<string, number>();
    for (const f of us) {
      const k = `${f.kind}/${f.category}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort();
  };
  try {
    const r1 = await analyzeRepository(dir);
    const r2 = await analyzeRepository(dir);
    const u1 = r1.unknowns as Finding[];
    const u2 = r2.unknowns as Finding[];
    assert.equal(u1.length, u2.length, 'finding count must be stable across runs');
    assert.deepEqual(tally(u1), tally(u2), 'kind/category grouping must be deterministic');
    // Legacy projection (area/detail/reason only) loses no finding.
    const legacy = u1.map(({ area, detail, reason }) => ({ area, detail, reason }));
    assert.equal(legacy.length, u1.length, 'classification must not drop findings');
    // Kind totals reconcile with the finding count.
    const byKind = new Map<FindingKind, number>();
    for (const f of u1) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
    const total = [...byKind.values()].reduce((a, b) => a + b, 0);
    assert.equal(total, u1.length, 'kind partition must equal total findings');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('S3: dist-src fallback is coverage while resolution keeps its inference mark', async () => {
  // 'fakepkg' is a workspace-style package (in nameToDir): its exports point
  // at absent dist output while src/ exists → dist→src fallback at (I).
  // (node_modules is an external boundary in M0 and never resolves this far.)
  const dir = s3Repo({
    'app/page.tsx': "import { x } from 'fakepkg';\nexport default function Page() { return null; }\n",
    'packages/fakepkg/package.json': JSON.stringify({
      name: 'fakepkg',
      version: '0.0.0',
      main: './dist/index.js',
      exports: { '.': './dist/index.js' },
    }),
    'packages/fakepkg/src/index.ts': 'export const x = 1;\n',
  });
  try {
    const r = await analyzeRepository(dir);
    const fb = (r.unknowns as Finding[]).filter((f) => f.category === 'dist-src-fallback');
    assert.ok(fb.length > 0, 'dist-src fallback finding expected');
    assert.ok(fb.every((f) => f.kind === 'coverage'), 'fallback stat is coverage, not [U]');
    assert.ok(
      fb.every((f) => f.detail.includes('(I)')),
      'fallback finding must preserve the inference mark in its detail',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('S3: dirReadFailures remain traceable coverage data on the result', async () => {
  const dir = s3Repo({ 'app/page.tsx': PAGE_TSX });
  try {
    const r = await analyzeRepository(dir);
    assert.ok(Array.isArray(r.dirReadFailures), 'dirReadFailures must be an array');
    // Coverage-kind by construction: every recorded failure carries path+error+phase.
    for (const f of r.dirReadFailures) {
      assert.ok(f.path.length >= 0 && f.error.length > 0 && f.phase.length > 0, `malformed: ${JSON.stringify(f)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// --------------------------------------------------------------- S4: orientation renderer & CLI
console.log('S4 — six-section orientation report & CLI experience');

import { renderFullReport } from '../packages/flowprint/src/render/index.js';
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';

const TAXONOMY_DIR = new URL('./fixtures/taxonomy', import.meta.url).pathname;

function normReport(s: string): string {
  return s.replace(/analyzed in \d+\.\ds/, 'analyzed in 0.0s');
}

check('S4: default report has six sections in order', async () => {
  const r = await analyzeRepository(TAXONOMY_DIR);
  const out = renderReport(r);
  const sections = ['Start here', 'Routes at a glance', 'Runtime blind spots', 'Coverage', 'Next'];
  let lastIdx = -1;
  for (const s of sections) {
    const idx = out.indexOf(`\n${s}\n`);
    assert.ok(idx > lastIdx, `section "${s}" must appear in order`);
    lastIdx = idx;
  }
  assert.ok(out.startsWith('='.repeat(60)), 'report must start with header bar');
});

check('S4: taxonomy default <=60 lines', async () => {
  const r = await analyzeRepository(TAXONOMY_DIR);
  r.durationMs = 0;
  const lines = normReport(renderReport(r)).split('\n').length;
  assert.ok(lines <= 60, `taxonomy default is ${lines} lines, budget is 60`);
});

check('S4: dub/apps/web default <=100 lines', async () => {
  const dubWeb = new URL('../bench/repos/dub/apps/web', import.meta.url).pathname;
  if (!existsSync(dubWeb)) {
    console.log('    (skip: bench/repos not present)');
    return;
  }
  const r = await analyzeRepository(dubWeb);
  r.durationMs = 0;
  const lines = normReport(renderReport(r)).split('\n').length;
  assert.ok(lines <= 100, `dub/apps/web default is ${lines} lines, budget is 100`);
});

check('S4: [U] appears only on uncertainty findings', async () => {
  const r = await analyzeRepository(TAXONOMY_DIR);
  const out = renderReport(r);
  const uLines = out.split('\n').filter((l) => l.trimStart().startsWith('[U]'));
  assert.ok(uLines.length > 0, 'expected some [U] lines');
  const nonUncertainty = r.unknowns.filter((f) => f.kind !== 'uncertainty');
  for (const f of nonUncertainty) {
    for (const l of uLines) {
      assert.ok(!l.includes(f.detail.slice(0, 40)), `non-uncertainty finding rendered as [U]: ${f.category}`);
    }
  }
  // Facts render without [U].
  assert.ok(!/\[U\].*alias.*not found on disk/i.test(out), 'alias fact must not be [U]');
});

check('S4: --full exposes every modeled item with no truncation', async () => {
  const r = await analyzeRepository(TAXONOMY_DIR);
  r.durationMs = 0;
  const out = renderFullReport(r);
  assert.ok(!/\+\\d+ more/.test(out), '--full must not contain +N more');
  assert.ok(!/\.\.\. and \d+ more/.test(out), '--full must not contain ... and N more');
  for (const rt of r.routes) {
    assert.ok(out.includes(rt.file), `route missing from --full: ${rt.file}`);
  }
  for (const f of r.unknowns) {
    assert.ok(out.includes(f.detail.slice(0, 50)), `finding missing from --full: ${f.category}`);
  }
  for (const p of r.trpcProcedures) {
    assert.ok(out.includes(p.path), `procedure missing from --full: ${p.path}`);
  }
  // Checked-framework lists appear on --full.
  assert.ok(out.includes('dependency scan checked:'), '--full must list checked frameworks');
});

check('S4: coverage renders dirReadFailures with count and paths', async () => {
  const r = await analyzeRepository(TAXONOMY_DIR);
  const withFailures = {
    ...r,
    dirReadFailures: [
      { path: 'app/secret', error: 'EACCES', phase: 'analysis' },
      { path: 'app/other', error: 'EPERM', phase: 'discovery' },
    ],
  };
  const out = renderReport(withFailures);
  assert.ok(out.includes('unreadable directories: 2'), 'count must render');
  assert.ok(out.includes('app/secret — EACCES (analysis)'), 'path+error+phase must render');
  assert.ok(out.includes('app/other — EPERM (discovery)'), 'path+error+phase must render');
  // Not double-counted as findings.
  const covLines = out.split('\n').filter((l) => l.includes('app/secret'));
  assert.equal(covLines.length, 1, 'dir failure must appear exactly once');
});

check('S4: golden snapshots match (taxonomy default + full)', async () => {
  const r = await analyzeRepository(TAXONOMY_DIR);
  r.durationMs = 0;
  const gold = (n: string) => readFileSync(new URL(`./golden/${n}`, import.meta.url).pathname, 'utf8');
  assert.equal(normReport(renderReport(r)) + '\n', gold('taxonomy-default.txt'), 'default golden mismatch');
  assert.equal(normReport(renderFullReport(r)) + '\n', gold('taxonomy-full.txt'), 'full golden mismatch');
});

check('S4: report is deterministic apart from duration', async () => {
  const r1 = await analyzeRepository(TAXONOMY_DIR);
  const r2 = await analyzeRepository(TAXONOMY_DIR);
  assert.equal(normReport(renderReport(r1)), normReport(renderReport(r2)), 'default must be deterministic');
  assert.equal(normReport(renderFullReport(r1)), normReport(renderFullReport(r2)), 'full must be deterministic');
});

function runCli(args: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      'npx', ['tsx', 'packages/flowprint/src/cli.ts', ...args],
      { cwd: cwd ?? new URL('..', import.meta.url).pathname, timeout: 120000 },
      (error, stdout, stderr) => {
        resolve({ code: (error as unknown as { code?: number })?.code ?? 0, out: String(stdout), err: String(stderr) });
      },
    );
  });
}

check('S4: CLI --help and --version', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0, '--help must exit 0');
  assert.ok(help.out.includes('--full'), '--help must document --full');
  assert.ok(help.out.includes('--version'), '--help must document --version');
  const ver = await runCli(['--version']);
  assert.equal(ver.code, 0, '--version must exit 0');
  assert.match(ver.out.trim(), /^flowprint \d+\.\d+\.\d+/, '--version format');
});

check('S4: CLI exit codes', async () => {
  const bad = await runCli(['--bogus']);
  assert.equal(bad.code, 2, 'unknown flag must exit 2');
  const nodir = await runCli(['/nonexistent-dir-xyz']);
  assert.equal(nodir.code, 2, 'non-directory must exit 2');
});

check('S4: CLI single app auto-analyzes; no-app is honest; exit 0', async () => {
  const single = await runCli([TAXONOMY_DIR]);
  assert.equal(single.code, 0);
  assert.ok(single.out.includes('Routes at a glance'), 'single app must be analyzed directly');
  const noappDir = mkdtempSync(join(tmpdir(), 'fp-noapp-'));
  writeFileSync(join(noappDir, 'package.json'), JSON.stringify({ name: 'x' }));
  try {
    const noapp = await runCli([noappDir]);
    assert.equal(noapp.code, 0, 'no supported app must exit 0');
    assert.ok(noapp.out.includes('No app was analyzed.'), 'honest notice required');
    assert.ok(noapp.out.includes('not "no application exists"'), 'scope honesty required');
  } finally {
    rmSync(noappDir, { recursive: true, force: true });
  }
});

check('S4: CLI multi-app shows discovery without guessing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-multi-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'm', private: true, workspaces: ['apps/*'] }));
    for (const a of ['a', 'b']) {
      mkdirSync(join(dir, 'apps', a, 'app'), { recursive: true });
      writeFileSync(join(dir, 'apps', a, 'package.json'), JSON.stringify({ name: `app-${a}`, dependencies: { next: '14.0.0' } }));
      writeFileSync(join(dir, 'apps', a, 'app', 'page.tsx'), 'export default function Page() { return null; }\n');
    }
    const res = await runCli([dir]);
    assert.equal(res.code, 0);
    assert.ok(res.out.includes('no app was guessed'), 'must not guess the app');
    assert.ok(!res.out.includes('Routes at a glance'), 'must not analyze; discovery only');
    const sel = await runCli([dir, '--app', 'apps/a']);
    assert.equal(sel.code, 0);
    assert.ok(sel.out.includes('Routes at a glance'), '--app must analyze the selected app');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// TR-004 amendment (S4): stripTsComments must strip comments in every code
// position — a `//` or `/*` outside string/template is always a comment in
// valid JS, never a regex start. Leak direction = false signal (comment
// driving a finding); the known residual is pathological regexes containing
// `//`, which over-strip one line by documented design.
check('TR-004 amendment: comments strip in all common positions', () => {
  const leaks: Array<[string, string]> = [
    ['brace-line', 'export function middleware(req) { // hostname-based routing\n  return 1;\n}'],
    ['brace-block', 'const x = { /* hostname guard */ a: 1 };'],
    ['bracket', 'const routes = [ // hostname list\n  "/a"\n];'],
    ['comma-multiline', 'proxy(req,\n  // rewrites by hostname\n  res);'],
    ['equals-multiline', 'const config =\n  // hostname mapping below\n  load();'],
    ['comma-inline', 'host: "x", // hostname entry\n'],
    ['ternary', 'const v = cond ? // hostname branch\n  a : b;'],
    ['paren', 'foo(bar); // trailing\n'],
    ['semi', 'const x = 1; // trailing\n'],
  ];
  for (const [name, src] of leaks) {
    const out = stripTsComments(src);
    assert.ok(!/hostname/i.test(out), `comment leaked in case ${name}: ${JSON.stringify(out)}`);
  }
});

check('TR-004 amendment: strings/templates/regexes/division survive stripping', () => {
  // String and template literals containing // must survive.
  assert.ok(stripTsComments('const u = "http://x";').includes('http://x'), 'string // must survive');
  assert.ok(stripTsComments('const t = `a // b`;').includes('a // b'), 'template // must survive');
  // Real regex literals and division must survive (no comment sequence).
  const re = stripTsComments('const r = /ab+c/gi;');
  assert.ok(re.includes('/ab+c/gi'), `regex must survive: ${re}`);
  const div = stripTsComments('const q = a / b; // c\n');
  assert.ok(div.includes('a / b') && !div.includes('// c'), `division must survive, comment stripped: ${div}`);
});

check('TR-004 amendment: comment-only signal no longer drives hostname finding', async () => {
  const dir = writeRepo({
    'package.json': NEXT_APP_PKG,
    'app/page.tsx': PAGE_TSX,
    'middleware.ts': 'export function middleware(req: any) {\n  // hostname-based routing for tenants\n  return Response.next();\n}\n',
  });
  try {
    const r = await analyzeRepository(dir);
    const hits = (r.unknowns as Array<{ category: string }>).filter((f) => f.category === 'hostname-dispatch');
    assert.equal(hits.length, 0, `comment-only hostname must not drive a finding: ${JSON.stringify(hits)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// TR-004 residual (S4 correction): escaped slashes inside regex literals
// must not trigger comment stripping — `\/` in code mode proves we are
// inside a regex (a code-mode `\` must start a `\u` identifier escape).
check('TR-004 residual: regex with escaped slashes survives intact', () => {
  const cases: Array<[string, string]> = [
    ['url-regex', 'const r = /https?:\\/\\//;'],
    ['single-escaped', 'const r = /\\//;'],
    ['triple', 'const r = /\\/\\/\\//;'],
    ['block-in-regex', 'const r = /\\/*/;'],
  ];
  for (const [name, src] of cases) {
    const out = stripTsComments(src);
    assert.equal(out, src, `regex must survive intact (${name}): ${JSON.stringify(out)}`);
  }
});

check('TR-004 residual: even backslash run is a closed regex + real comment', () => {
  // `/\\/` matches one backslash; the `//` after it is a real comment.
  const out = stripTsComments('const r = /\\\\/; // done\n');
  assert.ok(out.includes('/\\\\/;'), `regex must survive: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('// done'), `comment must strip: ${JSON.stringify(out)}`);
});

check('TR-004 residual: division and code after regex are preserved', () => {
  const src = 'const isAbsolute = /https?:\\/\\//.test(u); const h = hostname;\n';
  const out = stripTsComments(src);
  assert.ok(out.includes('/https?:\\/\\//.test(u)'), `regex must survive: ${JSON.stringify(out)}`);
  assert.ok(out.includes('hostname'), `code after regex must survive: ${JSON.stringify(out)}`);
  const div = stripTsComments('const q = a / b; // x\n');
  assert.ok(div.includes('a / b') && !div.includes('// x'), `division safe: ${JSON.stringify(div)}`);
});


// S5-B: Strengthened completeness. The S4 completeness test ran only on a
// fixture with ZERO coverage findings, so it passed vacuously while the
// type-only-import-census finding was silently dropped from --full. This
// test uses a repo that produces REAL coverage findings and asserts every
// model finding appears in --full — it fails if any category is dropped.
check('S5: --full renders every finding including coverage categories', async () => {
  const dir = writeRepo({
    'package.json': NEXT_APP_PKG,
    'app/page.tsx': PAGE_TSX,
    'app/types.ts': 'export type Foo = { a: string };\n',
    'app/uses-type.ts': 'import type { Foo } from "./types";\nexport const x: Foo = { a: "b" };\n',
    'app/broken.ts': 'const x = ; // syntax error\n',
  });
  try {
    const r = await analyzeRepository(dir);
    // Guard against vacuity: the model MUST contain coverage findings,
    // otherwise this test proves nothing.
    const cats = new Set(r.unknowns.map((f) => f.category));
    assert.ok(cats.has('type-only-import-census'), 'model must contain type-only coverage finding');
    assert.ok(cats.has('parse-error-partial'), 'model must contain parse-error coverage finding');
    const out = renderFullReport(r);
    // Every finding — regardless of kind — must appear in --full.
    for (const f of r.unknowns) {
      assert.ok(
        out.includes(f.detail.slice(0, 50)),
        `finding missing from --full [${f.kind}/${f.category}]: ${f.detail.slice(0, 60)}`,
      );
      // The category name itself must be visible (no hidden categories).
      assert.ok(out.includes(f.category), `category not visible in --full: ${f.category}`);
    }
    // Every route and every category present must also be represented.
    for (const rt of r.routes) {
      assert.ok(out.includes(rt.file), `route missing from --full: ${rt.file}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// S5-C: Parser-exact comment ranges. The heuristic stripper cannot
// distinguish `//` inside a regex character class (`/[//]/`) from a real
// comment. OXC lexer comment ranges are exact — the parser knows.
check('S5: stripCommentsExact uses parser ranges; [//] regex not stripped', () => {
  const src = 'const slash = /[//]/; const host = "hostname";\n';
  // Exact ranges: no comments in this source (the // is regex content).
  const exact = stripCommentsExact(src, []);
  assert.ok(exact.includes('/[//]/'), `regex must survive: ${JSON.stringify(exact)}`);
  assert.ok(exact.includes('hostname'), `code must survive: ${JSON.stringify(exact)}`);
  // With real comment ranges, the comment is blanked but code survives.
  const withComment = 'const a = 1; // hello\nconst b = 2;\n';
  const blanked = stripCommentsExact(withComment, [{ start: 13, end: 21 }]);
  assert.ok(!blanked.includes('// hello'), `comment must strip: ${JSON.stringify(blanked)}`);
  assert.ok(blanked.includes('const a = 1;') && blanked.includes('const b = 2;'), 'code survives');
  assert.ok(blanked.split('\n').length === withComment.split('\n').length, 'line structure preserved');
  // Undefined ranges fall back to heuristic.
  const fallback = stripCommentsExact('const a = 1; // x\n', undefined);
  assert.ok(!fallback.includes('// x'), 'fallback must strip');
});

check('S5: [//] regex end-to-end does not erase real signals', async () => {
  const dir = writeRepo({
    'package.json': NEXT_APP_PKG,
    'app/page.tsx': PAGE_TSX,
    'middleware.ts': 'export function middleware(req: any) {\n  const slash = /[//]/; const host = req.headers.get("hostname");\n  return Response.next();\n}\n',
  });
  try {
    const r = await analyzeRepository(dir);
    const hits = (r.unknowns as Array<{ category: string }>).filter((f) => f.category === 'hostname-dispatch');
    assert.equal(hits.length, 1, `real hostname signal must survive [//] regex: ${JSON.stringify(hits)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});








// S6 EC-01/AC-043: total spawn failure must throw (mapped to exit 1 by CLI),
// not produce a misleading partial-success report. Distinguished from
// per-file content crashes (which are recorded and isolated).
check('S6: total child spawn failure throws actionable error', async () => {
  const { rename } = await import('node:fs/promises');
  // Move the child entry so fork fails to spawn (not a content crash).
  const childTs = new URL('../packages/flowprint/src/parsing/child.ts', import.meta.url).pathname;
  const bak = childTs + '.bak-ec01';
  try {
    await rename(childTs, bak);
  } catch {
    console.log('  (skip: cannot move child entry)');
    return;
  }
  try {
    const { parseFilesIsolated } = await import('../packages/flowprint/src/parsing/isolated.js');
    let threw = false;
    let msg = '';
    try {
      await parseFilesIsolated('/tmp', ['a.ts', 'b.ts']);
    } catch (e) {
      threw = true;
      msg = e instanceof Error ? e.message : String(e);
    }
    assert.ok(threw, 'total spawn failure must throw');
    assert.ok(msg.includes('could not be spawned'), `actionable message: ${msg.slice(0, 120)}`);
    assert.ok(!msg.includes('partial'), 'must not suggest partial success');
  } finally {
    await rename(bak, childTs).catch(() => {});
  }
});


// S6-7B: Coverage must count UNIQUE unreadable directories, not attempts.
// Same path failing in discovery + analysis is one directory, not two.
check('S6: unreadable directories counts unique paths, not attempts', async () => {
  const { analyzeRepository } = await import('../packages/flowprint/src/index.js');
  const { renderReport } = await import('../packages/flowprint/src/render/index.js');
  // Construct a result with duplicate-path failures directly.
  const r: any = await analyzeRepository('test/fixtures/taxonomy');
  r.dirReadFailures = [
    { path: 'secret', error: 'EACCES', phase: 'discovery' },
    { path: 'secret', error: 'EACCES', phase: 'analysis' },
    { path: 'other', error: 'EACCES', phase: 'discovery' },
  ];
  const out = renderReport(r);
  assert.ok(out.includes('unreadable directories: 2'), `must count 2 unique, not 3 attempts: ${out.slice(out.indexOf('unreadable'), out.indexOf('unreadable') + 60)}`);
  assert.ok(out.includes('secret — EACCES (discovery, analysis)'), 'must show both phases for dup path');
});


// S7-A1: NFR-006 Node engines contract. The distribution manifest must
// declare exactly ^20.19.0 || >=22.12.0 — never a wider range.
check('S7: build manifest declares NFR-006 engines', async () => {
  const { readFile } = await import('node:fs/promises');
  const buildSrc = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  assert.ok(
    buildSrc.includes("'^20.19.0 || >=22.12.0'"),
    'build.mjs must declare engines ^20.19.0 || >=22.12.0',
  );
  assert.ok(!buildSrc.includes('>=18'), 'must not claim Node >=18');
  // Bin must point at bin.js (the pre-flight wrapper), not cli.js directly.
  assert.ok(buildSrc.includes("bin.js' }"), 'bin must point to bin.js');
});

main().catch((e) => {
  console.error("REGRESSION FAIL:", e);
  process.exit(1);
});
