/**
 * Flowprint v0.1 (Blocker B2) — framework layer: Pages Router route detection.
 *
 * General Pages route detection: scan each app's pages/ dir for route files
 * and map them to URLs via Pages Router conventions. Runs INDEPENDENTLY of
 * App Router detection (B2 general rule) — both route sets are reported in
 * the model, and same-URL App-vs-Pages conflicts are reported explicitly
 * with the pages-wins rule (Next.js serves the Pages Router version).
 */
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { SKIP } from './routes.js';

export interface PagesRouteFile {
  /** Repo-relative file path. */
  file: string;
  /** Mapped URL, e.g. "/about", "/api/trpc/[trpc]". */
  url: string;
  /** True for pages/api/* (API routes, not page routes). */
  isApi: boolean;
}

/** Files/dirs excluded from Pages route mapping (Next.js conventions). */
const EXCLUDE_LEAF = new Set(['_app', '_document', '_error', '404', '500']);

async function walk(absDir: string, visit: (absFile: string) => Promise<void>): Promise<void> {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const abs = join(absDir, e.name);
    if (e.isDirectory()) await walk(abs, visit);
    else if (e.isFile()) await visit(abs);
  }
}

/**
 * Collect Pages Router route files under an app's pages/ (or src/pages/) dir.
 * Returns null when the app has no pages/ dir.
 */
export async function collectPagesRoutes(
  repoRoot: string,
  appAbsDir: string,
): Promise<PagesRouteFile[] | null> {
  let pagesAbs: string | null = null;
  for (const cand of [join(appAbsDir, 'pages'), join(appAbsDir, 'src', 'pages')]) {
    try {
      if ((await stat(cand)).isDirectory()) {
        pagesAbs = cand;
        break;
      }
    } catch {
      // not present — try the next candidate
    }
  }
  if (!pagesAbs) return null;
  const pagesRoot = pagesAbs;
  const out: PagesRouteFile[] = [];
  await walk(pagesRoot, async (absFile) => {
    if (!/\.(tsx|ts|jsx|js)$/.test(absFile)) return;
    const rel = relative(pagesRoot, absFile).split(sep).join('/');
    const segs = rel.split('/');
    const leaf = segs[segs.length - 1].replace(/\.(tsx|ts|jsx|js)$/, '');
    const dirSegs = segs.slice(0, -1);
    // Exclusions: special files, 404/500, and anything under a _-prefixed
    // dir or a _-prefixed file (not routable).
    if (EXCLUDE_LEAF.has(leaf)) return;
    if (leaf.startsWith('_')) return;
    if (dirSegs.some((s) => s.startsWith('_'))) return;
    const urlSegs = [...dirSegs];
    if (leaf !== 'index') urlSegs.push(leaf);
    const url = '/' + urlSegs.join('/');
    out.push({
      file: relative(repoRoot, absFile).split(sep).join('/'),
      url: url === '/' ? '/' : url,
      isApi: urlSegs[0] === 'api',
    });
  });
  out.sort((a, b) => (a.file < b.file ? -1 : 1));
  return out;
}
