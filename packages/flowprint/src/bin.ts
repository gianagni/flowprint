#!/usr/bin/env node
/**
 * Flowprint CLI entry (DR-005).
 *
 * Pre-flight check for the oxc-parser native binding BEFORE loading the
 * analyzer. A missing binding produces a raw stack trace from deep inside
 * oxc's loader; we intercept it here for a clean, actionable exit(1).
 *
 * This wrapper must stay tiny and dependency-free — it runs before
 * anything else.
 */
async function main() {
  try {
    await import('oxc-parser');
  } catch (err) {
    if (isMissingBinding(err)) {
      console.error(
        'flowprint: parser native binding not found for this platform.\n' +
        'The oxc-parser optional native dependency did not install.\n' +
        'Try reinstalling: rm -rf node_modules package-lock.json && npm install\n' +
        'If the problem persists, your platform may not have a prebuilt binding.',
      );
      process.exit(1);
    }
    // Don't mask other bugs — rethrow with the original stack.
    throw err;
  }
  // Binding OK — load the real CLI.
  await import('./cli.js');
}

/**
 * Recognized missing-binding error shapes from oxc-parser's loader.
 * Deliberately narrow: only the "cannot find native binding" case is
 * treated as a dependency problem. Anything else rethrows.
 */
function isMissingBinding(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : '';
  return (
    msg.includes('Cannot find native binding') ||
    (msg.includes('Cannot find module') && msg.includes('@oxc-parser/binding'))
  );
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
