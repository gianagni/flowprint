/**
 * Flowprint v0.1-alpha — framework layer: tRPC procedure enumeration (GAP 7).
 *
 * STRICTLY limited to the validated patterns (validation research:
 * openstatusHQ-openstatus.md, calcom-cal.diy.md, langfuse-langfuse.md,
 * karakeep-app-karakeep.md, validation-matrix.md):
 *
 * (a) Router object definitions: `router({ ... })` / `createTRPCRouter({ ... })`
 *     with literal keys. Procedure values are builder chains containing
 *     `.query(` / `.mutation(` (e.g. `publicProcedure.input(...).query(...)`).
 * (b) Procedure paths by traversing merged/nested router objects with literal
 *     keys: nested router identifiers resolved to their definitions (same file
 *     or via imports), `mergeRouters(a, b)` unions.
 * (c) Adapter call sites anchor mount paths: `fetchRequestHandler`,
 *     `createExpressMiddleware`, and the hono-style `trpcServer` adapter —
 *     each called with `{ endpoint: "<literal>", router: <binding> }`.
 *     The callee must be imported from a `/trpc/i` specifier.
 *
 * Anything else (computed/spread keys, non-literal endpoints, unresolvable
 * router bindings, tRPC usage without a validated adapter such as cal.diy's
 * `createNextApiHandler`) → Unknown with reason, never generalized.
 *
 * Confidence: R when router keys are literals and the merge chain is fully
 * traced; I when one hop is heuristic (barrel re-export, I-confidence
 * resolution); U → emitted as Unknown, not as a procedure.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve as resolvePath, relative, sep } from 'node:path';
import { parseSync } from 'oxc-parser';
import { walkAst, type ModuleRecord } from '../parsing/index.js';
import { resolveImport, type ResolutionContext } from '../resolution/index.js';
import type { TrpcProcedure, UnknownItem } from '../model/types.js';

type N = Record<string, unknown>;

const ADAPTER_CALLS = new Set(['fetchRequestHandler', 'createExpressMiddleware', 'trpcServer']);
const ROUTER_CALLS = new Set(['router', 'createTRPCRouter']);
const PROCEDURE_METHODS = new Set(['query', 'mutation', 'subscription']);

function isId(n: unknown, name?: string): n is N {
  const r = n as N | null;
  return !!r && r['type'] === 'Identifier' && (name === undefined || r['name'] === name);
}

function literalStringOf(n: unknown): string | null {
  const r = n as N | null;
  if (r && (r['type'] === 'Literal' || r['type'] === 'StringLiteral') && typeof r['value'] === 'string') {
    return r['value'] as string;
  }
  return null;
}

/** `CallExpression` with an Identifier callee of the given name (and optional single ObjectExpression arg). */
function callExpr(n: unknown): { callee: string; args: unknown[] } | null {
  const r = n as N | null;
  if (!r || r['type'] !== 'CallExpression') return null;
  const callee = r['callee'] as N | undefined;
  if (!callee || callee['type'] !== 'Identifier' || typeof callee['name'] !== 'string') return null;
  return { callee: callee['name'] as string, args: (r['arguments'] as unknown[]) ?? [] };
}

function objectArg(call: { args: unknown[] }): N | null {
  const a0 = call.args[0] as N | undefined;
  return a0 && a0['type'] === 'ObjectExpression' ? a0 : null;
}

/** Does a CallExpression chain contain a `.query(`/`.mutation(`/`.subscription(` member call? */
function chainHasProcedureCall(expr: unknown): boolean {
  let cur = expr as N | null;
  let guard = 0;
  while (cur && cur['type'] === 'CallExpression' && guard++ < 50) {
    const callee = cur['callee'] as N | undefined;
    if (callee?.['type'] === 'MemberExpression') {
      const prop = callee['property'] as N | undefined;
      if (prop?.['type'] === 'Identifier' && PROCEDURE_METHODS.has(prop['name'] as string)) return true;
      cur = callee['object'] as N | null;
    } else {
      break;
    }
  }
  return false;
}

function propKey(prop: N): string | null {
  if (prop['type'] === 'SpreadElement' || prop['computed'] === true) return null;
  const key = prop['key'] as N | undefined;
  if (!key) return null;
  if (key['type'] === 'Identifier' && typeof key['name'] === 'string') return key['name'] as string;
  return literalStringOf(key);
}

function toRel(repoRoot: string, abs: string): string {
  return relative(repoRoot, abs).split(sep).join('/');
}

function parseAst(text: string, filename: string): N | null {
  try {
    const result = parseSync(filename, text, {
      lang: filename.endsWith('.tsx') ? 'tsx' : filename.endsWith('.jsx') ? 'jsx' : 'ts',
      sourceType: 'unambiguous',
    });
    return result.program as unknown as N;
  } catch {
    return null;
  }
}

/** local imported name → specifier, from the module record. */
function importMap(rec: ModuleRecord | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const imp of rec?.imports ?? []) {
    for (const n of imp.names) if (!m.has(n)) m.set(n, imp.specifier);
  }
  return m;
}

interface RouterDef {
  kind: 'object';
  obj: N;
  file: string;
  heuristic: boolean;
}
interface MergeDef {
  kind: 'merge';
  args: unknown[];
  file: string;
  heuristic: boolean;
}
type BindingTarget = RouterDef | MergeDef | { kind: 'procedureChain'; heuristic: boolean } | null;

/**
 * Find a top-level binding's initializer in a file's AST:
 * `const X = <init>`, `export const X = <init>`, or an import of X.
 */
function findBinding(
  prog: N,
  name: string,
): { kind: 'init'; init: unknown } | { kind: 'import'; specifier: string; imported: string } | null {
  const body = (prog['body'] as unknown[]) ?? [];
  for (const stmt of body) {
    const s = stmt as N;
    const t = s['type'] as string;
    const decl = (t === 'ExportNamedDeclaration' ? (s['declaration'] as N | undefined) : s) as N | undefined;
    if (decl && decl['type'] === 'VariableDeclaration') {
      for (const d of (decl['declarations'] as N[]) ?? []) {
        const id = d['id'] as N | undefined;
        if (id?.['type'] === 'Identifier' && id['name'] === name) {
          return { kind: 'init', init: d['init'] };
        }
      }
    }
    if (t === 'ImportDeclaration') {
      const spec = literalStringOf(s['source']);
      if (!spec) continue;
      for (const sp of (s['specifiers'] as N[]) ?? []) {
        const local = (sp['local'] as N | undefined)?.['name'];
        if (local === name) {
          const imported =
            sp['type'] === 'ImportSpecifier'
              ? ((sp['imported'] as N)?.['name'] as string | undefined ?? name)
              : name;
          return { kind: 'import', specifier: spec, imported };
        }
      }
    }
    if (t === 'ExportNamedDeclaration' && s['source']) {
      // `export { appRouter } from "./src/root"` — re-export hop.
      const spec = literalStringOf(s['source']);
      if (!spec) continue;
      for (const sp of (s['specifiers'] as N[]) ?? []) {
        const exported = (sp['exported'] as N | undefined)?.['name'];
        if (exported === name) {
          const imported = ((sp['imported'] as N)?.['name'] as string | undefined) ?? name;
          return { kind: 'import', specifier: spec, imported };
        }
      }
    }
  }
  return null;
}

export interface TrpcAnalysis {
  procedures: TrpcProcedure[];
  unknowns: UnknownItem[];
}

export async function analyzeTrpcSurface(
  repoRoot: string,
  sourceFiles: string[],
  records: Map<string, ModuleRecord>,
  rctx: ResolutionContext,
): Promise<TrpcAnalysis> {
  const unknowns: UnknownItem[] = [];
  const procedures: TrpcProcedure[] = [];
  const astCache = new Map<string, N | null>();

  const readText = async (rel: string): Promise<string | null> => {
    try {
      return await readFile(join(repoRoot, rel), 'utf8');
    } catch {
      return null;
    }
  };
  const getProg = async (rel: string): Promise<N | null> => {
    const hit = astCache.get(rel);
    if (hit !== undefined) return hit;
    const text = await readText(rel);
    const prog = text ? parseAst(text, rel) : null;
    astCache.set(rel, prog);
    return prog;
  };

  // ---- 1. adapter call sites (validated patterns only) ----
  interface AdapterSite {
    file: string;
    mount: string | null;
    mountReason: string;
    routerName: string | null;
  }
  const adapterSites: AdapterSite[] = [];
  let trpcTouched = false;
  for (const rel of sourceFiles) {
    const rec = records.get(rel);
    const touchesTrpc = (rec?.imports ?? []).some((i) => /trpc/i.test(i.specifier));
    if (touchesTrpc) trpcTouched = true;
    const text = await readText(rel);
    if (!text) continue;
    if (![...ADAPTER_CALLS].some((n) => text.includes(n))) continue;
    const prog = await getProg(rel);
    if (!prog) continue;
    const im = importMap(rec);
    walkAst(prog, (node) => {
      const n = node as unknown as N;
      const call = callExpr(n);
      if (!call || !ADAPTER_CALLS.has(call.callee)) return;
      const spec = im.get(call.callee) ?? '';
      // Validated adapters only: callee must come from a /trpc/i specifier
      // (fetchRequestHandler ← @trpc/server/adapters/fetch,
      //  createExpressMiddleware ← @trpc/server/adapters/express,
      //  trpcServer ← @hono/trpc-server).
      if (!/trpc/i.test(spec)) return;
      const obj = objectArg(call);
      let mount: string | null = null;
      let mountReason = 'no literal endpoint in adapter call';
      let routerName: string | null = null;
      if (obj) {
        for (const p of (obj['properties'] as N[]) ?? []) {
          const k = propKey(p);
          if (k === 'endpoint') {
            const lit = literalStringOf((p as N)['value']);
            if (lit !== null) {
              mount = lit;
              mountReason = `endpoint literal in ${call.callee} call`;
            }
          } else if (k === 'router' && isId((p as N)['value'])) {
            routerName = ((p as N)['value'] as N)['name'] as string;
          }
        }
      }
      adapterSites.push({ file: rel, mount, mountReason, routerName });
    });
  }

  if (trpcTouched && adapterSites.length === 0) {
    unknowns.push({
      area: 'tRPC surface',
      detail:
        'tRPC imports detected but no validated adapter call site ' +
        '(fetchRequestHandler / createExpressMiddleware / hono-style trpcServer) found — ' +
        'mount paths not determined; procedures not enumerated',
      reason: 'tRPC usage does not match the validated adapter patterns — do not generalize',
    });
    return { procedures, unknowns };
  }
  if (adapterSites.length === 0) return { procedures, unknowns };

  // ---- 2. resolve + enumerate per adapter site ----

  /** Resolve an import specifier to a repo-relative file + heuristic flag. */
  const resolveImportTarget = async (
    fromFile: string,
    specifier: string,
  ): Promise<{ file: string; heuristic: boolean } | null> => {
    const abs = resolvePath(repoRoot, fromFile);
    const r = await resolveImport(rctx, abs, specifier);
    if (!r.absPath || r.claim.confidence === 'U') return null;
    const rel = toRel(repoRoot, r.absPath);
    // Heuristic when resolution itself was heuristic, or the target is a
    // barrel (index) re-export rather than the defining file.
    const heuristic =
      r.claim.confidence !== 'R' || /(^|\/)index\.(ts|tsx|js|jsx|mts|cts)$/.test(rel);
    return { file: rel, heuristic };
  };

  /** Find an exported binding's initializer in the target file (handles `export const X`, local `const X`). */
  const findExportedInit = async (
    targetFile: string,
    exportedName: string,
  ): Promise<{ init: unknown; file: string; heuristic: boolean } | null> => {
    const prog = await getProg(targetFile);
    if (!prog) return null;
    const binding = findBinding(prog, exportedName);
    if (!binding) {
      // Maybe re-exported through a barrel: `export * from './x'`.
      const starTargets: string[] = [];
      walkAst(prog, (node) => {
        const n = node as unknown as N;
        if (n['type'] === 'ExportAllDeclaration') {
          const spec = literalStringOf(n['source']);
          if (spec) starTargets.push(spec);
        }
      });
      for (const spec of starTargets) {
        const t = await resolveImportTarget(targetFile, spec);
        if (!t) continue;
        const inner = await findExportedInit(t.file, exportedName);
        if (inner) return { ...inner, heuristic: true };
      }
      return null;
    }
    if (binding.kind === 'init') return { init: binding.init, file: targetFile, heuristic: false };
    const t = await resolveImportTarget(targetFile, binding.specifier);
    if (!t) return null;
    const inner = await findExportedInit(t.file, binding.imported);
    if (!inner) return null;
    return { ...inner, heuristic: inner.heuristic || t.heuristic };
  };

  const resolveRouterValue = async (
    fromFile: string,
    value: unknown,
    seen: Set<string>,
    heuristic: boolean,
  ): Promise<BindingTarget> => {
    // Inline router({...}) / mergeRouters(...) call.
    const call = callExpr(value);
    if (call && ROUTER_CALLS.has(call.callee)) {
      const obj = objectArg(call);
      return obj ? { kind: 'object', obj, file: fromFile, heuristic } : null;
    }
    if (call && call.callee === 'mergeRouters') {
      return { kind: 'merge', args: call.args, file: fromFile, heuristic };
    }
    if (chainHasProcedureCall(value)) return { kind: 'procedureChain', heuristic };
    if (!isId(value)) return null;
    const name = value['name'] as string;
    const seenKey = `${fromFile}::${name}`;
    if (seen.has(seenKey)) return null;
    seen.add(seenKey);
    const prog = await getProg(fromFile);
    if (!prog) return null;
    const binding = findBinding(prog, name);
    if (!binding) return null;
    if (binding.kind === 'init') {
      const sub = await resolveRouterValue(fromFile, binding.init, seen, heuristic);
      // Identifier indirection to a procedure chain is itself a heuristic hop.
      if (sub && sub.kind === 'procedureChain') return { kind: 'procedureChain', heuristic: true };
      return sub;
    }
    const t = await resolveImportTarget(fromFile, binding.specifier);
    if (!t) {
      unknowns.push({
        area: 'tRPC surface',
        detail: `router binding "${name}" in ${fromFile}: import "${binding.specifier}" did not resolve — subtree not enumerated`,
        reason: 'router merge chain not fully traceable',
      });
      return null;
    }
    const inner = await findExportedInit(t.file, binding.imported);
    if (!inner) {
      unknowns.push({
        area: 'tRPC surface',
        detail: `router binding "${name}" in ${fromFile}: "${binding.imported}" not found in ${t.file} — subtree not enumerated`,
        reason: 'router merge chain not fully traceable',
      });
      return null;
    }
    return resolveRouterValue(inner.file, inner.init, seen, heuristic || t.heuristic || inner.heuristic);
  };

  const emitProcedure = (
    dotted: string,
    mount: string | null,
    mountReason: string,
    handlerFile: string,
    heuristic: boolean,
    adapterFile: string,
  ) => {
    const path = mount ? `${mount.replace(/\/+$/, '')}/${dotted}` : dotted;
    procedures.push({
      procedure: dotted,
      path,
      mountPath: mount,
      handlerFile,
      confidence: heuristic ? 'I' : 'R',
      reason: heuristic
        ? `router keys are literals; one hop in the merge chain is heuristic (adapter: ${adapterFile})`
        : `router keys are literals and the merge chain is fully traced (adapter: ${adapterFile}; ${mountReason})`,
    });
  };

  const enumerateObject = async (
    obj: N,
    prefix: string,
    defFile: string,
    site: AdapterSite,
    seen: Set<string>,
    heuristic: boolean,
  ): Promise<void> => {
    for (const p of (obj['properties'] as N[]) ?? []) {
      const pn = p as N;
      const key = propKey(pn);
      if (key === null) {
        unknowns.push({
          area: 'tRPC surface',
          detail: `non-literal/spread router key in ${defFile} (prefix "${prefix || '(root)'}") — not enumerated`,
          reason: 'computed router keys are not a validated pattern',
        });
        continue;
      }
      const dotted = prefix ? `${prefix}.${key}` : key;
      const target = await resolveRouterValue(defFile, pn['value'], new Set(seen), heuristic);
      if (!target) {
        unknowns.push({
          area: 'tRPC surface',
          detail: `router value for "${dotted}" in ${defFile} does not match a validated pattern — not enumerated`,
          reason: 'unrecognized router value shape',
        });
        continue;
      }
      if (target.kind === 'object') {
        await enumerateObject(target.obj, dotted, target.file, site, seen, heuristic || target.heuristic);
      } else if (target.kind === 'merge') {
        for (const arg of target.args) {
          const sub = await resolveRouterValue(target.file, arg, new Set(seen), heuristic || target.heuristic);
          if (sub && sub.kind === 'object') {
            await enumerateObject(sub.obj, dotted, sub.file, site, seen, heuristic || target.heuristic || sub.heuristic);
          } else if (sub) {
            unknowns.push({
              area: 'tRPC surface',
              detail: `mergeRouters argument for "${dotted}" in ${target.file} is not a router object — skipped`,
              reason: 'merge argument shape not validated',
            });
          }
          // sub === null already produced its own unknown in resolveRouterValue
        }
      } else {
        // procedureChain
        emitProcedure(dotted, site.mount, site.mountReason, defFile, heuristic || target.heuristic, site.file);
      }
    }
  };

  for (const site of adapterSites) {
    if (!site.routerName) {
      unknowns.push({
        area: 'tRPC surface',
        detail: `${site.file}: adapter call has no resolvable "router:" identifier — procedures not enumerated for this mount`,
        reason: 'router binding not statically determinable',
      });
      continue;
    }
    const target = await resolveRouterValue(site.file, { type: 'Identifier', name: site.routerName }, new Set(), false);
    if (!target) {
      unknowns.push({
        area: 'tRPC surface',
        detail: `${site.file}: router binding "${site.routerName}" does not match a validated router shape — procedures not enumerated`,
        reason: 'router definition not traceable',
      });
      continue;
    }
    if (target.kind === 'object') {
      await enumerateObject(target.obj, '', target.file, site, new Set(), target.heuristic);
    } else if (target.kind === 'merge') {
      for (const arg of target.args) {
        const sub = await resolveRouterValue(target.file, arg, new Set(), target.heuristic);
        if (sub && sub.kind === 'object') {
          await enumerateObject(sub.obj, '', sub.file, site, new Set(), target.heuristic || sub.heuristic);
        }
      }
    } else {
      unknowns.push({
        area: 'tRPC surface',
        detail: `${site.file}: "router:" binding "${site.routerName}" resolved to a procedure chain, not a router object`,
        reason: 'adapter router is not a router object',
      });
    }
  }

  // De-duplicate identical procedures (same path + handler).
  const seenProc = new Set<string>();
  const deduped = procedures.filter((p) => {
    const k = `${p.path}::${p.handlerFile}`;
    if (seenProc.has(k)) return false;
    seenProc.add(k);
    return true;
  });
  deduped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { procedures: deduped, unknowns };
}
