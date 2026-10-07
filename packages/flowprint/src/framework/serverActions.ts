/**
 * Flowprint v0.1-alpha — framework layer: Server Actions inventory (GAP 6).
 *
 * Per-app inventory from 'use server' directives (already extracted with scope
 * info by the parsing layer):
 * - top-of-file (directive-prologue) 'use server' → R "file defines server
 *   actions per Next.js convention"; exported async function names → I list
 *   ("convention-based: all exports of a 'use server' module are server actions").
 * - function-body 'use server' → R for that specific function.
 * - 'use server' + 'use client' in one file → ambiguous (invalid per Next.js);
 *   surfaced as Unknown, never claimed.
 * - 'use server' outside the directive prologue → inert per Next.js; Unknown.
 *
 * Honest about completeness: only what the directive proves is claimed.
 */
import type { ModuleRecord } from '../parsing/index.js';
import type { ActionCandidate, ServerActionInfo, UnknownItem } from '../model/types.js';
import { resolved, inferred } from '../model/types.js';

export interface ServerActionInventory {
  files: ServerActionInfo[];
  unknowns: UnknownItem[];
}

/** Does this repo-relative file belong to the app dir? */
function underApp(appDir: string, file: string): boolean {
  if (!appDir) return true; // repo-root app owns everything
  return file === appDir || file.startsWith(appDir + '/');
}

export function inventoryServerActions(
  appDir: string,
  records: Map<string, ModuleRecord>,
): ServerActionInventory {
  const files: ServerActionInfo[] = [];
  const unknowns: UnknownItem[] = [];

  for (const rec of records.values()) {
    if (!underApp(appDir, rec.file)) continue;
    const serverScopes = rec.directiveScopes.filter((d) => d.value === 'use server');
    if (serverScopes.length === 0) continue;
    const hasUseClient = rec.directives.includes('use client');

    if (hasUseClient) {
      unknowns.push({
        area: 'server actions',
        detail: `${rec.file} contains both 'use client' and 'use server' — invalid per Next.js; server-action status unknown`,
        reason: "conflicting directives in one file; neither claim is safe",
      });
      continue;
    }

    const moduleScope = serverScopes.filter((d) => d.scope === 'module');
    const fnScopes = serverScopes.filter((d) => d.scope === 'function');
    const otherScopes = serverScopes.filter((d) => d.scope === 'other');

    if (moduleScope.length > 0) {
      // Whole-file server actions. Only async function exports can be actions.
      const asyncNames = new Set(rec.exportShape.asyncFunctionNames);
      const exportedAsync = rec.exportShape.namedExports.filter((n) => asyncNames.has(n));
      // Wrapped/builder-pattern candidates: exported bindings initialized by
      // a (possibly chained) call expression containing an async callback.
      // General structural rule — no dependency or callee-name allowlist.
      // Gated on module-scope 'use server' (the file is an action module);
      // false-positive avoidance matters more than coverage, so a binding
      // that is already a direct async export is never double-counted.
      const candidates: ActionCandidate[] = [];
      for (const b of rec.exportShape.namedBuilderCalls) {
        if (!b.hasAsyncCallback) continue;
        if (asyncNames.has(b.name)) continue;
        const chain = b.chained ? 'chained ' : '';
        const root = b.rootName ? ` (chain root: ${b.rootName})` : '';
        candidates.push({
          name: b.name,
          confidence: 'I',
          reason:
            `exported binding initialized by ${chain}call expression containing an async callback${root}` +
            ` — wrapper/builder pattern; runtime action semantics not proven`,
        });
      }
      candidates.sort((a, b) => (a.name < b.name ? -1 : 1));
      const actionsClaim =
        exportedAsync.length > 0
          ? inferred(
              [...new Set(exportedAsync)].sort(),
              "convention-based: all exports of a 'use server' module are server actions (async function exports listed)",
            )
          : candidates.length > 0
            ? inferred(
                [],
                "convention-based: 'use server' module with no directly-exported async functions; wrapper/builder candidates listed separately",
              )
            : inferred([], "convention-based: 'use server' module with no exported async functions inventoried");
      files.push({
        file: rec.file,
        scope: resolved('module', "top-of-file 'use server' — file defines server actions per Next.js convention"),
        actions: actionsClaim,
        actionCandidates: candidates,
      });
    } else if (fnScopes.length > 0) {
      const names = [...new Set(fnScopes.map((d) => d.functionName ?? '(anonymous)'))].sort();
      files.push({
        file: rec.file,
        scope: resolved('inline', "function-body 'use server' directive — marks that specific function as a server action"),
        actions: resolved(names, "inline 'use server' directive in function body"),
        actionCandidates: [],
      });
    }

    if (otherScopes.length > 0 && moduleScope.length === 0) {
      unknowns.push({
        area: 'server actions',
        detail: `${rec.file} has 'use server' outside the directive prologue — inert per Next.js (directive must lead the file); ignored`,
        reason: 'misplaced directive is not a valid server-action marker',
      });
    }
  }

  files.sort((a, b) => (a.file < b.file ? -1 : 1));
  return { files, unknowns };
}
