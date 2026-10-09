/**
 * Flowprint M0 — parse child entry (blocker B1).
 *
 * Forked by src/parsing/isolated.ts. This is the ONLY place oxc runs: it
 * receives { repoRoot, files } over IPC, runs the existing parseFile logic
 * per file, and posts serialized ModuleRecords back. Any native crash
 * (e.g. the oxc SIGSEGV on deeply nested input, oxc#24375) kills only this
 * process; the parent survives and retries with a binary split.
 *
 * parseFile never throws by contract (parse errors → partial records), so a
 * non-zero exit here means something truly unexpected — the parent treats
 * the batch as crashed either way.
 */
import { parseFile } from './index.js';
import { serializeRecord, type SerializedModuleRecord } from './isolated.js';

interface ChildRequest {
  repoRoot: string;
  files: string[];
}

// Signal readiness immediately — the parent uses this to distinguish
// spawn/startup failure (died before 'ready') from content crash (died
// after 'ready' while processing). EC-01.
if (process.send) {
  process.send({ type: 'ready' });
}

process.on('message', (msg: unknown) => {
  void (async () => {
    const { repoRoot, files } = msg as ChildRequest;
    const records: SerializedModuleRecord[] = [];
    for (const rel of files) {
      records.push(serializeRecord(await parseFile(repoRoot, rel)));
    }
    const done = { type: 'done', records };
    // Flush the IPC message before exiting so the parent never sees a
    // clean exit with no 'done'.
    process.send!(done, () => process.exit(0));
  })().catch((err) => {
    console.error(
      `[flowprint] parse child fatal: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
});
