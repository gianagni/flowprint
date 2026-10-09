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

/**
 * Strip `//` line comments and `/* … *\/` block comments from TS/JS source
 * for text-signal scans (TR-004), so commented-out code cannot drive
 * findings. Respects single/double-quoted strings and template literals
 * (including `${ … }` nesting).
 *
 * Comment detection needs no regex-vs-comment heuristic: in valid JS, a `/`
 * followed by `/` or `*` outside a string/template literal is a comment
 * start — UNLESS the `/` is escaped by an odd run of preceding backslashes,
 * which proves we are inside a regex literal (`\/` cannot occur in valid
 * code mode outside a regex: a code-mode `\` must start a `\u` identifier
 * escape, always followed by `u`). So `//` and `/*` are stripped
 * unconditionally in code mode, except after an odd `\` run.
 *
 * Note: `stripCommentsExact` (below) prefers parser-exact comment ranges
 * and only uses this heuristic as a fallback for unparsed files. The exact
 * ranges eliminate the character-class residual entirely.
 *
 * Pathological unbalanced input may desynchronize the scanner; behavior
 * there is best-effort by design.
 */
export function stripTsComments(src: string): string {
  type Frame = { mode: 'code'; inTpl: boolean; depth: number } | { mode: 'tpl' };
  let out = '';
  let i = 0;
  const n = src.length;
  const stack: Frame[] = [{ mode: 'code', inTpl: false, depth: 0 }];
  let str: "'" | '"' | null = null;

  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    const frame = stack[stack.length - 1];

    if (frame.mode === 'tpl') {
      if (c === '`') {
        out += c;
        stack.pop();
        i++;
        continue;
      }
      if (c === '\\') {
        out += c + d;
        i += 2;
        continue;
      }
      if (c === '$' && d === '{') {
        out += '${';
        stack.push({ mode: 'code', inTpl: true, depth: 0 });
        i += 2;
        continue;
      }
      out += c;
      i++;
      continue;
    }

    // code frame
    if (str) {
      out += c;
      if (c === '\\') {
        out += d;
        i += 2;
        continue;
      }
      if (c === str) {
        str = null;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      str = c;
      out += c;
      i++;
      continue;
    }
    if (c === '`') {
      stack.push({ mode: 'tpl' });
      out += c;
      i++;
      continue;
    }
    if (frame.inTpl && c === '{') {
      (frame as { depth: number }).depth++;
      out += c;
      i++;
      continue;
    }
    if (frame.inTpl && c === '}') {
      out += c;
      const f = frame as { depth: number };
      if (f.depth === 0) stack.pop();
      else f.depth--;
      i++;
      continue;
    }
    // In code mode, `//` and `/*` are comment starts — UNLESS the `/` is
    // escaped by an odd run of preceding backslashes. In valid JS, `\/`
    // in code mode can only occur inside a regex literal: a `\` in code
    // outside strings/templates/regexes must start a `\u` identifier
    // escape (always followed by `u`, never `/`). So an odd `\` run
    // proves we are inside a regex and this `/` is literal content.
    // (Even run, e.g. `/\\/` + `//`, is a closed regex + real comment.)
    if (c === '/' && (d === '/' || d === '*')) {
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && src[j] === '\\') {
        bs++;
        j--;
      }
      if (bs % 2 === 1) {
        out += c;
        i++;
        continue;
      }
      if (d === '/') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Strip comments using parser-exact ranges (S5-C), falling back to the
 * heuristic `stripTsComments` when ranges are unavailable.
 *
 * Exact ranges come from the lexer's comment tokens — the parser knows
 * `//` inside `/[//]/` is regex content, not a comment. This eliminates
 * the heuristic's documented residual without building a custom lexer.
 *
 * Ranges are blanked (not deleted) with newlines preserved, so string
 * length and line structure are unchanged. Out-of-bounds or overlapping
 * ranges are ignored defensively; if anything looks wrong, falls back
 * to the heuristic rather than producing corrupt output.
 */
export function stripCommentsExact(
  src: string,
  ranges: Array<{ start: number; end: number }> | undefined,
): string {
  // Undefined = unknown (skipped/crashed/unavailable) → heuristic fallback.
  if (ranges === undefined) return stripTsComments(src);
  // Empty array = parser confirms zero comments → nothing to strip.
  // This is exact, not heuristic: the lexer saw no comment tokens.
  if (ranges.length === 0) return src;
  // Defensive validation: sorted, in-bounds, non-overlapping.
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let prevEnd = 0;
  for (const r of sorted) {
    if (
      !Number.isInteger(r.start) ||
      !Number.isInteger(r.end) ||
      r.start < 0 ||
      r.end > src.length ||
      r.end <= r.start ||
      r.start < prevEnd
    ) {
      return stripTsComments(src);
    }
    prevEnd = r.end;
  }
  const chars = src.split('');
  for (const r of sorted) {
    for (let i = r.start; i < r.end; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}
