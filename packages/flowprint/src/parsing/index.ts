/**
 * Flowprint M0 — parsing layer.
 *
 * One oxc-parser `parseSync` per source file. Extracts the module record
 * (static imports/exports with per-specifier `isType`), dynamic `import()`
 * (literal → value, non-literal → marker), and `require()` calls via AST walk.
 * Parse errors → partial record, never throws.
 */
import { readFile, stat } from 'node:fs/promises';
import { parseSync, type ParserOptions } from 'oxc-parser';

/**
 * General rule: files larger than this are skipped, not parsed.
 * Rationale: legitimate hand-written source files are far smaller; multi-MB
 * files are generated artifacts (e.g. a 29MB committed GraphQL schema).
 * Skipping is honest (surfaced as Unknown); letting one file kill a
 * whole-repo scan is a defect. No single file may terminate a scan.
 */
export const MAX_PARSE_BYTES = 2 * 1024 * 1024;

export const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
]);

export interface StaticImportInfo {
  specifier: string;
  /** Local names imported. */
  names: string[];
  /** True when every imported binding is type-only (`import type ...`). */
  typeOnly: boolean;
  /** True when only some bindings are type-only (`import { type A, b }`). */
  partialType: boolean;
  /** `import * as ns` */
  isNamespace: boolean;
  /** `import def` */
  isDefault: boolean;
}

export interface StaticExportInfo {
  /** Target module for re-exports (`export ... from 'x'`), null for local exports. */
  from: string | null;
  /** Exported names (for `export *`, this is ['*']). */
  names: string[];
  /** (importedName, exportedName) pairs for `export { a as b }` forms. */
  pairs: Array<{ imported: string | null; exported: string | null }>;
  typeOnly: boolean;
  /** `export * from 'x'` (AllButDefault) or `export type *` */
  isStar: boolean;
  /** `export * as ns from 'x'` */
  isStarAs: boolean;
  /** `export default ...` present */
  isDefault: boolean;
}

export interface DynamicImportInfo {
  /** Literal specifier value, or null when the argument is not a string literal. */
  specifier: string | null;
}

export interface RequireInfo {
  /** Literal specifier value, or null when the argument is not a string literal. */
  specifier: string | null;
}

/**
 * An exported binding initialized by a call expression (plain or chained),
 * e.g. `export const x = foo(async () => {...})` or
 * `export const y = client.schema(...).action(async () => {...})`.
 * Structural evidence only — the analyzer does NOT know what the callee does.
 */
export interface BuilderCallInfo {
  /** Exported binding name. */
  name: string;
  /** Base identifier of the call chain (e.g. `client`), or null when the chain
   *  does not bottom out at a plain identifier. Derived from source, never
   *  matched against a dependency allowlist. */
  rootName: string | null;
  /** True when any argument at any level of the call chain is an async function. */
  hasAsyncCallback: boolean;
  /** True when the outermost callee is a member expression (chained `.x(...)` calls). */
  chained: boolean;
}

export interface ExportShapeInfo {
  hasDefaultExport: boolean;
  /** Default export is a call expression, e.g. `export default auth(...)`. */
  defaultCallCallee: string | null;
  /** Named function/const export names. */
  namedExports: string[];
  /** Named exports initialized with a call: name → callee name. */
  namedCallExports: Map<string, string>;
  /** Named exports initialized by a (possibly chained) call expression, with
   *  structural chain evidence. JSON-safe (plain data) for IPC serialization. */
  namedBuilderCalls: BuilderCallInfo[];
  /** Top-level async function/const names (declared, not necessarily exported).
   *  Intersect with namedExports to find exported async functions. */
  asyncFunctionNames: string[];
}

/** Where a 'use server' / 'use client' directive literal was found. */
export type DirectiveScope = 'module' | 'function' | 'other';

export interface DirectiveOccurrence {
  value: 'use server' | 'use client';
  /**
   * 'module' — inside the leading directive prologue of the Program
   * (consecutive string-literal statements at the top of the file);
   * 'function' — first statement of a function body (inline directive);
   * 'other' — a string-literal ExpressionStatement anywhere else (inert).
   */
  scope: DirectiveScope;
  /** Enclosing function name for scope='function'; null otherwise. */
  functionName: string | null;
}

export interface ModuleRecord {
  /** Repo-relative path. */
  file: string;
  imports: StaticImportInfo[];
  exports: StaticExportInfo[];
  dynamicImports: DynamicImportInfo[];
  requires: RequireInfo[];
  exportShape: ExportShapeInfo;
  /** True when the file parsed with errors (partial record). */
  hasErrors: boolean;
  errors: string[];
  /**
   * Set when the file was skipped without parsing (oversize guard).
   * Skipped files are excluded from the graph and surfaced as Unknown —
   * distinct from hasErrors (parsed-with-errors, partial record kept).
   */
  skipped?: string;
  /**
   * Set when the isolated parse child crashed on this file (blocker B1:
   * uncatchable native oxc SIGSEGV contained by child_process isolation).
   * Crashed files are excluded from the graph and surfaced as Unknown —
   * the no-single-file-kills-the-scan policy holds.
   */
  crashed?: boolean;
  /** `'use server'` / `'use client'` directives found (flat; any position). */
  directives: string[];
  /** `'use server'` / `'use client'` occurrences with scope info. */
  directiveScopes: DirectiveOccurrence[];
}

function langFor(file: string): ParserOptions['lang'] {
  if (file.endsWith('.tsx')) return 'tsx';
  if (file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts')) return 'ts';
  if (file.endsWith('.jsx')) return 'jsx';
  return 'js';
}

function sourceTypeFor(file: string): ParserOptions['sourceType'] {
  if (file.endsWith('.cjs') || file.endsWith('.cts')) return 'commonjs';
  if (file.endsWith('.mjs') || file.endsWith('.mts')) return 'module';
  return 'unambiguous';
}

/**
 * Describe a call-expression initializer structurally: unwrap a (possibly
 * chained) callee to its base identifier and note whether any argument at
 * any level of the chain is an async function. Purely syntactic — no
 * knowledge of what the callee does. Used for wrapper/builder-pattern
 * detection (e.g. server-action builders); the caller decides what the
 * evidence means and at which confidence.
 */
export function describeCallChain(
  init: Record<string, unknown>,
): Omit<BuilderCallInfo, 'name'> {
  let hasAsyncCallback = false;
  let chained = false;
  let rootName: string | null = null;
  let node: unknown = init;
  for (;;) {
    const n = node as Record<string, unknown> | null;
    if (!n) break;
    if (n['type'] === 'Identifier' && typeof n['name'] === 'string') {
      rootName = n['name'] as string;
      break;
    }
    if (n['type'] !== 'CallExpression') break;
    const callee = n['callee'] as Record<string, unknown> | undefined;
    const args = (n['arguments'] as unknown[] | undefined) ?? [];
    for (const a of args) {
      const ao = a as Record<string, unknown> | null;
      const t = ao?.['type'];
      if ((t === 'ArrowFunctionExpression' || t === 'FunctionExpression') && ao?.['async'] === true) {
        hasAsyncCallback = true;
      }
    }
    if (callee?.['type'] === 'MemberExpression') {
      chained = true;
      node = callee['object'];
    } else if (callee?.['type'] === 'Identifier' && typeof callee['name'] === 'string') {
      rootName = callee['name'] as string;
      break;
    } else {
      break; // callee is a call result, function expression, etc. — stop unwrapping
    }
  }
  return { rootName, hasAsyncCallback, chained };
}

/** Generic ESTree walk (oxc AST has no parent pointers; no cycles). */
export function walkAst(node: unknown, visit: (n: Record<string, unknown>) => void): void {  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkAst(item, visit);
    return;
  }
  const rec = node as Record<string, unknown>;
  if (typeof rec['type'] === 'string') visit(rec);
  for (const key of Object.keys(rec)) {
    if (key === 'parent') continue;
    walkAst(rec[key], visit);
  }
}

function literalString(node: unknown): string | null {
  const rec = node as Record<string, unknown> | null;
  if (rec && (rec['type'] === 'Literal' || rec['type'] === 'StringLiteral') && typeof rec['value'] === 'string') {
    return rec['value'] as string;
  }
  // Template literal without expressions: `import(`./x`)`.
  if (rec && rec['type'] === 'TemplateLiteral') {
    const exprs = rec['expressions'] as unknown[];
    const quasis = rec['quasis'] as Array<{ value: { cooked: string } }>;
    if (exprs.length === 0 && quasis.length === 1) return quasis[0].value.cooked;
  }
  return null;
}

/**
 * 'use server' / 'use client' directive occurrences with scope info.
 * The generic AST walk above records every directive-like literal flatly;
 * this pass distinguishes the module directive prologue (leading run of
 * string-literal statements) from inline function-body directives and
 * inert literals elsewhere.
 */
function directiveValueOf(stmt: unknown): 'use server' | 'use client' | null {
  const s = stmt as Record<string, unknown> | null;
  if (!s || s['type'] !== 'ExpressionStatement') return null;
  const expr = s['expression'] as Record<string, unknown> | undefined;
  if (expr?.['type'] === 'Literal' && (expr['value'] === 'use server' || expr['value'] === 'use client')) {
    return expr['value'] as 'use server' | 'use client';
  }
  return null;
}

function collectDirectiveScopes(program: unknown): DirectiveOccurrence[] {
  const out: DirectiveOccurrence[] = [];
  const prog = program as Record<string, unknown>;
  const body = Array.isArray(prog['body']) ? (prog['body'] as unknown[]) : [];
  // Module directive prologue: leading run of string-literal statements.
  for (const stmt of body) {
    const s = stmt as Record<string, unknown>;
    if (s?.['type'] !== 'ExpressionStatement') break;
    const expr = s['expression'] as Record<string, unknown> | undefined;
    if (expr?.['type'] !== 'Literal' || typeof expr['value'] !== 'string') break;
    const v = directiveValueOf(stmt);
    if (v) out.push({ value: v, scope: 'module', functionName: null });
  }
  // Inline directives: first statement of a function body.
  const checkFnBody = (fn: Record<string, unknown>, name: string | null) => {
    const b = fn['body'] as Record<string, unknown> | undefined;
    if (b?.['type'] !== 'BlockStatement') return;
    const stmts = Array.isArray(b['body']) ? (b['body'] as unknown[]) : [];
    const v = stmts.length > 0 ? directiveValueOf(stmts[0]) : null;
    if (v) out.push({ value: v, scope: 'function', functionName: name });
  };
  walkAst(program, (node) => {
    const t = node['type'] as string;
    if (t === 'FunctionDeclaration' || t === 'FunctionExpression') {
      const id = node['id'] as { name?: string } | undefined;
      checkFnBody(node, id?.name ?? null);
    } else if (t === 'VariableDeclarator') {
      const id = node['id'] as { name?: string } | undefined;
      const init = node['init'] as Record<string, unknown> | undefined;
      if (init && (init['type'] === 'ArrowFunctionExpression' || init['type'] === 'FunctionExpression')) {
        checkFnBody(init, id?.name ?? null);
      }
    }
  });
  return out;
}

/** Top-level async function/const names (for exported-async-function detection). */
function collectAsyncFunctionNames(program: unknown): string[] {
  const out: string[] = [];
  const prog = program as Record<string, unknown>;
  const body = Array.isArray(prog['body']) ? (prog['body'] as unknown[]) : [];
  const scanDecl = (decl: Record<string, unknown> | undefined) => {
    if (!decl) return;
    const t = decl['type'] as string;
    if (t === 'FunctionDeclaration' && decl['async'] === true) {
      const id = decl['id'] as { name?: string } | undefined;
      if (id?.name) out.push(id.name);
    } else if (t === 'VariableDeclaration') {
      for (const d of (decl['declarations'] as Array<Record<string, unknown>>) ?? []) {
        const id = d['id'] as { name?: string } | undefined;
        const init = d['init'] as Record<string, unknown> | undefined;
        if (id?.name && init?.['async'] === true &&
          (init['type'] === 'ArrowFunctionExpression' || init['type'] === 'FunctionExpression')) {
          out.push(id.name);
        }
      }
    }
  };
  for (const stmt of body) {
    const s = stmt as Record<string, unknown>;
    const t = s?.['type'] as string;
    if (t === 'ExportNamedDeclaration' || t === 'ExportDefaultDeclaration') {
      scanDecl(s['declaration'] as Record<string, unknown> | undefined);
    } else {
      scanDecl(s);
    }
  }
  return out;
}

export function parseSource(file: string, source: string): ModuleRecord {
  const rec: ModuleRecord = {
    file,
    imports: [],
    exports: [],
    dynamicImports: [],
    requires: [],
    exportShape: {
      hasDefaultExport: false,
      defaultCallCallee: null,
      namedExports: [],
      namedCallExports: new Map(),
      namedBuilderCalls: [],
      asyncFunctionNames: [],
    },
    hasErrors: false,
    errors: [],
    directives: [],
    directiveScopes: [],
  };

  let result;
  try {
    result = parseSync(file, source, {
      lang: langFor(file),
      sourceType: sourceTypeFor(file),
      // astType 'ts' keeps TS-specific node shapes; default follows lang.
    });
  } catch (err) {
    // Uncatchable native failures are isolated by child_process (parsing/isolated.ts).
    // A thrown parse is recorded, never propagated.
    rec.hasErrors = true;
    rec.errors.push(`parse threw: ${err instanceof Error ? err.message : String(err)}`);
    return rec;
  }

  if (result.errors.length > 0) {
    rec.hasErrors = true;
    for (const e of result.errors.slice(0, 5)) rec.errors.push(e.message);
  }

  const mod = result.module;
  if (mod) {
    for (const imp of mod.staticImports) {
      const spec = imp.moduleRequest?.value;
      if (typeof spec !== 'string') continue;
      const entries = imp.entries ?? [];
      const typeFlags = entries.map((e) => e.isType === true);
      rec.imports.push({
        specifier: spec,
        names: entries.map((e) => e.localName?.value ?? '').filter(Boolean),
        typeOnly: entries.length > 0 && typeFlags.every(Boolean),
        partialType: typeFlags.some(Boolean) && !typeFlags.every(Boolean),
        isNamespace: entries.some((e) => e.importName?.kind === 'NamespaceObject'),
        isDefault: entries.some((e) => e.importName?.kind === 'Default'),
      });
    }
    for (const exp of mod.staticExports) {
      const entries = exp.entries ?? [];
      const firstReq = entries[0]?.moduleRequest?.value;
      const from = typeof firstReq === 'string' ? firstReq : null;
      const names: string[] = [];
      const pairs: Array<{ imported: string | null; exported: string | null }> = [];
      let isStar = false;
      let isStarAs = false;
      let isDefault = false;
      let allType = entries.length > 0;
      for (const e of entries) {
        if (e.importName?.kind === 'AllButDefault') isStar = true;
        if (e.importName?.kind === 'All') isStarAs = true;
        if (e.exportName?.kind === 'Default') isDefault = true;
        if (e.exportName?.name) names.push(e.exportName.name);
        pairs.push({ imported: e.importName?.name ?? null, exported: e.exportName?.name ?? null });
        if (e.isType !== true) allType = false;
      }
      if (isStar && names.length === 0) names.push('*');
      rec.exports.push({
        from,
        names,
        pairs,
        typeOnly: allType,
        isStar,
        isStarAs,
        isDefault,
      });
    }
  }

  // AST walk: require(), dynamic import(), export shapes, directives.
  // NOTE: result.program access can throw at the napi boundary even after
  // parseSync succeeded (observed: "Failed to convert rust String into napi
  // string" on a 29MB generated file). Contain it per-file: the module record
  // extracted above is kept, AST-derived features are skipped, and the record
  // is marked partial. General rule, not a repo-specific hack.
  let program: unknown;
  try {
    program = result.program as unknown;
  } catch (err) {
    rec.hasErrors = true;
    rec.errors.push(`ast unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return rec;
  }
  walkAst(program, (node) => {
    const t = node['type'] as string;
    if (t === 'CallExpression') {
      const callee = node['callee'] as Record<string, unknown> | undefined;
      if (callee?.['type'] === 'Identifier' && callee['name'] === 'require') {
        const args = node['arguments'] as unknown[];
        rec.requires.push({ specifier: args.length > 0 ? literalString(args[0]) : null });
      }
    } else if (t === 'ImportExpression') {
      rec.dynamicImports.push({ specifier: literalString(node['source']) });
    } else if (t === 'ExportDefaultDeclaration') {
      rec.exportShape.hasDefaultExport = true;
      const decl = node['declaration'] as Record<string, unknown> | undefined;
      if (decl?.['type'] === 'CallExpression') {
        const callee = decl['callee'] as Record<string, unknown> | undefined;
        if (callee?.['type'] === 'Identifier' && typeof callee['name'] === 'string') {
          rec.exportShape.defaultCallCallee = callee['name'] as string;
        }
      }
    } else if (t === 'ExportNamedDeclaration') {
      const decl = node['declaration'] as Record<string, unknown> | undefined;
      if (decl?.['type'] === 'FunctionDeclaration') {
        const id = decl['id'] as { name?: string } | undefined;
        if (id?.name) rec.exportShape.namedExports.push(id.name);
      } else if (decl?.['type'] === 'VariableDeclaration') {
        for (const d of (decl['declarations'] as Array<Record<string, unknown>>) ?? []) {
          const id = d['id'] as { name?: string } | undefined;
          if (id?.name) {
            rec.exportShape.namedExports.push(id.name);
            const init = d['init'] as Record<string, unknown> | undefined;
            if (init?.['type'] === 'CallExpression') {
              const callee = init['callee'] as Record<string, unknown> | undefined;
              if (callee?.['type'] === 'Identifier' && typeof callee['name'] === 'string') {
                rec.exportShape.namedCallExports.set(id.name, callee['name'] as string);
              }
              // Structural chain evidence for wrapper/builder patterns
              // (e.g. `export const x = client.schema(...).action(async () => {})`).
              rec.exportShape.namedBuilderCalls.push({
                name: id.name,
                ...describeCallChain(init),
              });
            }
          }
        }
      }
      for (const s of (node['specifiers'] as Array<Record<string, unknown>>) ?? []) {
        const exported = s['exported'] as { name?: string } | undefined;
        if (exported?.name) rec.exportShape.namedExports.push(exported.name);
      }
    } else if (t === 'ExpressionStatement') {
      const expr = node['expression'] as Record<string, unknown> | undefined;
      if (expr?.['type'] === 'Literal' && typeof expr['value'] === 'string' &&
        (expr['value'] === 'use server' || expr['value'] === 'use client')) {
        rec.directives.push(expr['value'] as string);
      }
    }
  });

  // Scoped directive occurrences + top-level async names (server-action inventory).
  rec.directiveScopes = collectDirectiveScopes(program);
  rec.exportShape.asyncFunctionNames = collectAsyncFunctionNames(program);

  return rec;
}

/**
 * Build the Unknown record for a file whose isolated parse child crashed.
 * Empty edges (excluded from the graph, like skipped files); the crash is
 * recorded in errors and flagged via `crashed`.
 */
export function crashedRecord(relPath: string, detail: string): ModuleRecord {
  return {
    file: relPath,
    imports: [],
    exports: [],
    dynamicImports: [],
    requires: [],
    exportShape: {
      hasDefaultExport: false,
      defaultCallCallee: null,
      namedExports: [],
      namedCallExports: new Map(),
      namedBuilderCalls: [],
      asyncFunctionNames: [],
    },
    // hasErrors stays false: the file was never parsed (no partial record),
    // so it must not be counted under "parse errors" — "parse crashes"
    // (index.ts) owns the accounting for crashed files.
    hasErrors: false,
    errors: [`crashed during parse — file skipped (${detail})`],
    crashed: true,
    directives: [],
    directiveScopes: [],
  };
}

export async function parseFile(repoRoot: string, relPath: string): Promise<ModuleRecord> {
  const abs = `${repoRoot}/${relPath}`;
  const emptyShape = {
    hasDefaultExport: false,
    defaultCallCallee: null as string | null,
    namedExports: [] as string[],
    namedCallExports: new Map<string, string>(),
    namedBuilderCalls: [] as BuilderCallInfo[],
    asyncFunctionNames: [] as string[],
  };
  // Oversize guard (general rule): never feed multi-MB files to the parser.
  // Observed: oxc's napi string conversion throws on a 29MB generated file,
  // killing the whole scan. Skipped files are surfaced as Unknown, not errors.
  try {
    const st = await stat(abs);
    if (st.size > MAX_PARSE_BYTES) {
      const reason = `skipped: ${(st.size / 1048576).toFixed(1)}MB exceeds ${(MAX_PARSE_BYTES / 1048576).toFixed(0)}MB parse limit (likely generated artifact)`;
      return {
        file: relPath,
        imports: [], exports: [], dynamicImports: [], requires: [],
        exportShape: emptyShape,
        hasErrors: false, errors: [reason], skipped: reason,
        directives: [], directiveScopes: [],
      };
    }
  } catch {
    // stat failed; fall through to readFile which handles unreadable files.
  }
  let source: string;
  try {
    source = await readFile(abs, 'utf8');
  } catch {
    return {
      file: relPath,
      imports: [], exports: [], dynamicImports: [], requires: [],
      exportShape: emptyShape,
      hasErrors: true, errors: ['unreadable file'], directives: [], directiveScopes: [],
    };
  }
  return parseSource(relPath, source);
}
