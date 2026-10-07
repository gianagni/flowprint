/**
 * Release label derived from package.json — never a hardcoded milestone.
 *
 * User-facing strings ("Flowprint <version> — ...") read the version here so
 * the label always matches the frozen release without code changes.
 */
import { readFileSync } from 'node:fs';

let version = '0.0.0';
try {
  const pkg = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { version?: string };
  if (pkg.version) version = pkg.version;
} catch {
  // keep default — label degrades, analysis is unaffected
}

/** e.g. "0.1.0-alpha.2" */
export const FLOWPRINT_VERSION = version;
