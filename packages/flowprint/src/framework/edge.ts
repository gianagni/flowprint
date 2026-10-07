/**
 * Flowprint M0 — framework layer: proxy.ts / middleware.ts edge entry detection.
 *
 * Classification is by LOCATION (app root or src/) + EXPORT SHAPE, never by
 * filename alone:
 *   - `export default ...` (any form, incl. `export default auth(...)`)
 *   - `export function proxy|middleware ...` / `export const proxy|middleware = ...`
 * A proxy.ts/middleware.ts without a qualifying export is NOT an edge entry.
 */
import { join } from 'node:path';
import type { ModuleRecord } from '../parsing/index.js';
import { fileExists } from './routes.js';

export interface EdgeEntryInfo {
  /** Repo-relative file path. */
  file: string;
  kind: 'proxy' | 'middleware';
  /** Which export shape qualified it. */
  shape: string;
  /** Default export is wrapped: `export default auth(...)` → "auth". */
  wrapper: string | null;
  /** Next major version read from deps (null when unreadable). */
  nextMajor: number | null;
}

function classifyShape(
  rec: ModuleRecord,
): { shape: string; wrapper: string | null } | null {
  const shape = rec.exportShape;
  if (shape.hasDefaultExport) {
    return {
      shape: 'export default',
      wrapper: shape.defaultCallCallee,
    };
  }
  const named = shape.namedExports.filter((n) => n === 'proxy' || n === 'middleware');
  if (named.length > 0) {
    return { shape: `export named ${named[0]}`, wrapper: null };
  }
  return null;
}

/**
 * Find proxy.ts / middleware.ts at the app root or src/, classify each.
 * Returns entries in a stable order (proxy.ts first).
 */
export async function detectEdgeEntries(
  repoRoot: string,
  appDirRel: string,
  getRecord: (relPath: string) => Promise<ModuleRecord | null>,
  nextMajor: number | null,
): Promise<EdgeEntryInfo[]> {
  const out: EdgeEntryInfo[] = [];
  const roots = appDirRel === '' ? [''] : [appDirRel, `${appDirRel}/src`];
  const files: Array<{ rel: string; baseName: 'proxy' | 'middleware' }> = [];
  for (const root of roots) {
    for (const baseName of ['proxy', 'middleware'] as const) {
      for (const ext of ['ts', 'js']) {
        const rel = root === '' ? `${baseName}.${ext}` : `${root}/${baseName}.${ext}`;
        const abs = join(repoRoot, rel);
        if (await fileExists(abs)) files.push({ rel, baseName });
      }
    }
  }
  // proxy.ts before middleware.ts; app root before src/.
  files.sort((a, b) => {
    const ao = (a.baseName === 'proxy' ? 0 : 2) + (a.rel.includes('/src/') ? 1 : 0);
    const bo = (b.baseName === 'proxy' ? 0 : 2) + (b.rel.includes('/src/') ? 1 : 0);
    return ao - bo || (a.rel < b.rel ? -1 : 1);
  });

  for (const { rel, baseName } of files) {
    const rec = await getRecord(rel);
    if (!rec) continue;
    const shape = classifyShape(rec);
    if (!shape) continue; // filename alone is not enough
    // Kind: export name wins over filename when they disagree.
    let kind: 'proxy' | 'middleware' = baseName;
    const namedKind = rec.exportShape.namedExports.find((n) => n === 'proxy' || n === 'middleware');
    if (namedKind === 'proxy' || namedKind === 'middleware') kind = namedKind;
    out.push({ file: rel, kind, shape: shape.shape, wrapper: shape.wrapper, nextMajor });
  }
  return out;
}

/** Parse a `next` dependency range to a major version (null when unreadable). */
export function nextMajorOf(range: string | null): number | null {
  if (!range) return null;
  const m = /(\d+)\.\d+\.\d+/.exec(range) ?? /^v?(\d+)/.exec(range);
  if (!m) return null; // e.g. "catalog:" — version unreadable
  return parseInt(m[1], 10);
}

/** Human note about which edge file Next.js expects for the detected version. */
export function edgeExpectationNote(nextMajor: number | null): string | null {
  if (nextMajor == null) return 'Next.js version unreadable from deps; proxy.ts vs middleware.ts expectation unknown';
  if (nextMajor >= 16) return `Next.js ${nextMajor} ≥ 16: expects proxy.ts (middleware.ts renamed)`;
  return `Next.js ${nextMajor} ≤ 15: expects middleware.ts`;
}
