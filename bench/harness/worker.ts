/**
 * Flowprint M0 — benchmark worker entry (GAP 4 / D2 worker isolation).
 *
 * Runs analyzeRepository inside a worker thread so that a parser crash,
 * uncaught JS exception, or hang in one repo is contained: run.ts spawns
 * one Worker per repo and records worker-level failures as RUNNER_FAILED
 * instead of letting them kill the whole benchmark.
 *
 * Protocol: workerData = { repoPath, probeImports }. Posts exactly one
 * message: { ok: true, result } or { ok: false, error }.
 *
 * The AnalysisResult is passed through OPAQUELY (structured clone) — this
 * file must not read or depend on any of its fields.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { analyzeRepository } from '../../packages/flowprint/src/index.js';

interface WorkerInput {
  repoPath: string;
  probeImports?: Array<{ fromFile: string; specifier: string }>;
}

async function main(): Promise<void> {
  const input = workerData as WorkerInput;
  try {
    const result = await analyzeRepository(input.repoPath, { probeImports: input.probeImports });
    parentPort?.postMessage({ ok: true, result });
  } catch (err) {
    parentPort?.postMessage({
      ok: false,
      error:
        err instanceof Error
          ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`
          : String(err),
    });
  }
}

main().catch((err) => {
  // Last resort: the try/catch path above itself failed. Post the failure so
  // the driver records RUNNER_FAILED instead of hanging until its timeout.
  try {
    parentPort?.postMessage({ ok: false, error: `worker bootstrap failure: ${String(err)}` });
  } catch {
    process.exit(1);
  }
});
