/**
 * Flowprint M0 — isolated parsing (blocker B1).
 *
 * ALL oxc parsing runs in child processes (node:child_process fork), never in
 * the main process. Rationale (proven, docs/v01-alpha.md §6 blocker #3):
 * deeply nested input can trigger an uncatchable native oxc SIGSEGV
 * (oxc#24375) that kills the whole OS process; worker_threads share the
 * process and cannot contain it.
 *
 * Design: a small parent-side pool. Files are split into batches; each batch
 * is parsed by one forked child running src/parsing/child.ts, which returns
 * serialized ModuleRecords over IPC.
 *
 * Crash semantics: a child dying (non-zero exit, signal incl. SIGSEGV, spawn
 * error, or timeout) NEVER terminates the parent. The child's batch is
 * retried with a binary split until the crashing file(s) are isolated; each
 * crashing file becomes a ModuleRecord with `crashed: true`
 * ("crashed during parse — file skipped"). Crashes are logged loudly on
 * stderr. The no-single-file-kills-the-scan policy holds by construction.
 *
 * Runs under tsx (CLI: `pnpm flowprint` → tsx): the child entry is forked
 * with `execArgv: process.execArgv` so the tsx loader hooks propagate and
 * the .ts child entry resolves in the child.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { crashedRecord, type BuilderCallInfo, type ModuleRecord } from './index.js';

export interface IsolatedParseOptions {
  /** Max concurrent parse children. Default: min(8, cpuCount). */
  concurrency?: number;
  /** Files per child. Default: 200 (amortizes ~150ms fork cost). */
  batchSize?: number;
  /** Per-batch wall-clock budget; expiry kills the child. Default: 5 min. */
  childTimeoutMs?: number;
}

const DEFAULT_CONCURRENCY = Math.max(1, Math.min(8, cpus().length));
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_CHILD_TIMEOUT_MS = 5 * 60 * 1000; // matches harness per-repo worker budget

interface ChildRequest {
  repoRoot: string;
  files: string[];
}

interface ChildDone {
  type: 'done';
  records: SerializedModuleRecord[];
}

interface ChildReady {
  type: 'ready';
}

/**
 * JSON-safe wire form of ModuleRecord. The only non-JSON-able field in
 * ModuleRecord is `exportShape.namedCallExports` (a Map); everything else
 * is plain data (strings, booleans, nulls, arrays, plain objects).
 */
export interface SerializedModuleRecord extends Omit<ModuleRecord, 'exportShape'> {
  exportShape: {
    hasDefaultExport: boolean;
    defaultCallCallee: string | null;
    namedExports: string[];
    namedCallExports: Array<[string, string]>;
    /** Plain data — passes through JSON unchanged. */
    namedBuilderCalls: BuilderCallInfo[];
    asyncFunctionNames: string[];
  };
}

export function serializeRecord(rec: ModuleRecord): SerializedModuleRecord {
  return {
    ...rec,
    exportShape: {
      hasDefaultExport: rec.exportShape.hasDefaultExport,
      defaultCallCallee: rec.exportShape.defaultCallCallee,
      namedExports: rec.exportShape.namedExports,
      namedCallExports: [...rec.exportShape.namedCallExports.entries()],
      namedBuilderCalls: rec.exportShape.namedBuilderCalls,
      asyncFunctionNames: rec.exportShape.asyncFunctionNames,
    },
  };
}

export function deserializeRecord(s: SerializedModuleRecord): ModuleRecord {
  return {
    ...s,
    exportShape: {
      hasDefaultExport: s.exportShape.hasDefaultExport,
      defaultCallCallee: s.exportShape.defaultCallCallee,
      namedExports: s.exportShape.namedExports,
      namedCallExports: new Map(s.exportShape.namedCallExports),
      namedBuilderCalls: s.exportShape.namedBuilderCalls ?? [],
      asyncFunctionNames: s.exportShape.asyncFunctionNames,
    },
  };
}

function childEntryPath(): string {
  // './child.js' resolves to child.ts under the tsx loader (propagated via execArgv).
  return fileURLToPath(new URL('./child.js', import.meta.url));
}

interface BatchResult {
  ok: boolean;
  records: ModuleRecord[];
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /**
   * True when the child never ran user code: fork() threw, the child
   * errored on spawn, or it died before receiving work. Distinct from a
   * content crash (SIGSEGV on a poisoned file) — a systemic failure.
   */
  spawnFailed: boolean;
}

function describeCrash(r: BatchResult): string {
  if (r.timedOut) return 'child timed out';
  return `child died (exit code=${r.code}, signal=${r.signal})`;
}

function logCrash(files: string[], r: BatchResult): void {
  const preview = files.length <= 5 ? ` files: ${files.join(', ')}` : '';
  console.error(
    `[flowprint] PARSE CHILD CRASHED: ${describeCrash(r)}; ` +
      `${files.length} file(s) affected — retrying with binary split.${preview}`,
  );
}

function runBatch(
  repoRoot: string,
  files: string[],
  timeoutMs: number,
): Promise<BatchResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: BatchResult): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }
    };

    let child: ChildProcess;
    try {
      child = fork(childEntryPath(), [], {
        execArgv: process.execArgv, // propagate tsx loader hooks to the child
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
    } catch (err) {
      // fork() itself failed — treat the batch as crashed, never throw.
      console.error(
        `[flowprint] PARSE CHILD failed to spawn for ${files.length} file(s): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      finish({ ok: false, records: [], code: null, signal: null, timedOut: false, spawnFailed: true });
      return;
    }

    const timer = setTimeout(() => {
      console.error(
        `[flowprint] PARSE CHILD timed out after ${timeoutMs}ms on ` +
          `${files.length} file(s); killing it`,
      );
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone; the 'exit' handler below finishes the batch
      }
      finish({ ok: false, records: [], code: null, signal: null, timedOut: true, spawnFailed: false });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    let receivedReady = false;
    child.on('message', (msg: unknown) => {
      const m = msg as Partial<ChildDone> | Partial<ChildReady> | null;
      if (m && (m as Partial<ChildReady>).type === 'ready') {
        receivedReady = true;
        return;
      }
      const done = m as Partial<ChildDone> | null;
      if (done && done.type === 'done' && Array.isArray(done.records)) {
        const records = done.records.map(deserializeRecord);
        // Backfill insurance: any requested file with no record becomes a
        // crash record rather than silently vanishing.
        const seen = new Set(records.map((rec) => rec.file));
        for (const f of files) {
          if (!seen.has(f)) {
            console.error(`[flowprint] child returned no record for ${f}; marking crashed`);
            records.push(crashedRecord(f, 'child returned no record'));
          }
        }
        finish({ ok: true, records, code: 0, signal: null, timedOut: false, spawnFailed: false });
      }
    });
    child.on('error', (err) => {
      console.error(`[flowprint] PARSE CHILD error: ${err.message}`);
      finish({ ok: false, records: [], code: null, signal: null, timedOut: false, spawnFailed: true });
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      // EC-01: died before 'ready' = never ran user code (missing entry,
      // broken install). Died after 'ready' = content crash (SIGSEGV on
      // input) — recorded and isolated via binary-split retry.
      const neverRan = !receivedReady;
      if (neverRan) {
        console.error(`[flowprint] PARSE CHILD died before starting work (exit code=${code}); treating as spawn failure`);
      }
      finish({ ok: false, records: [], code, signal, timedOut: false, spawnFailed: neverRan });
    });

    const req: ChildRequest = { repoRoot, files };
    try {
      child.send(req);
    } catch (err) {
      // Child died between fork and send — treat the batch as crashed.
      console.error(
        `[flowprint] PARSE CHILD died before receiving work (${files.length} file(s)): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      finish({ ok: false, records: [], code: null, signal: null, timedOut: false, spawnFailed: true });
    }
  });
}

/**
 * Parse files with full child_process isolation. Returns a record per input
 * file; crashing files yield `crashed: true` records (see crashedRecord).
 * Per-file child failures never throw — the parent always survives those.
 *
 * EC-01: when EVERY child fails to spawn (systemic — the parser cannot run
 * at all), this throws an actionable error instead of returning an
 * almost-empty map that would render as a misleading "success" report.
 */
export async function parseFilesIsolated(
  repoRoot: string,
  rels: string[],
  opts: IsolatedParseOptions = {},
): Promise<Map<string, ModuleRecord>> {
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const timeoutMs = opts.childTimeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS;

  const out = new Map<string, ModuleRecord>();
  const unique = [...new Set(rels)].sort();
  // EC-01: distinguish systemic spawn failure from per-file content crashes.
  let okBatches = 0;
  let spawnFailedBatches = 0;

  async function parseSet(files: string[]): Promise<void> {
    if (files.length === 0) return;
    if (files.length === 1) {
      // Base case: the crashing file is isolated — mark it, keep the scan.
      const r = await runBatch(repoRoot, files, timeoutMs);
      if (r.ok) {
        okBatches++;
        for (const rec of r.records) out.set(rec.file, rec);
      } else {
        if (r.spawnFailed) spawnFailedBatches++;
        logCrash(files, r);
        const detail = describeCrash(r);
        console.error(
          `[flowprint] file marked Unknown after parser crash: ${files[0]} — ${detail}`,
        );
        out.set(files[0], crashedRecord(files[0], detail));
      }
      return;
    }
    const batches: string[][] = [];
    for (let i = 0; i < files.length; i += batchSize) {
      batches.push(files.slice(i, i + batchSize));
    }
    const crashedBatches: string[][] = [];
    let next = 0;
    async function worker(): Promise<void> {
      while (next < batches.length) {
        const batch = batches[next++];
        const r = await runBatch(repoRoot, batch, timeoutMs);
        if (r.ok) {
          okBatches++;
          for (const rec of r.records) out.set(rec.file, rec);
        } else {
          if (r.spawnFailed) spawnFailedBatches++;
          logCrash(batch, r);
          crashedBatches.push(batch);
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, batches.length) }, worker),
    );
    // Binary-split retry converges on the crashing file(s); every other file
    // in the batch still gets a real record.
    for (const batch of crashedBatches) {
      const mid = Math.max(1, Math.floor(batch.length / 2));
      await parseSet(batch.slice(0, mid));
      await parseSet(batch.slice(mid));
    }
  }

  await parseSet(unique);

  // EC-01/AC-043: every child failed to SPAWN (not per-file content crashes).
  // The scan produced nothing real — fail loudly instead of printing a
  // misleading almost-empty "success" report. The CLI maps this to exit 1.
  if (unique.length > 0 && okBatches === 0 && spawnFailedBatches > 0) {
    throw new Error(
      `parser child process could not be spawned (${spawnFailedBatches} batch(es), ` +
        `${unique.length} file(s) requested) — no file was parsed. ` +
        `Check that the installed package includes the parser child entry and ` +
        `that the Node.js version can fork child processes.`,
    );
  }

  return out;
}
