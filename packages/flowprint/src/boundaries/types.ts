/**
 * Flowprint M0 — unsupported boundary model (Blocker B3).
 *
 * v0.1-alpha finding: 109 fixture "ambiguity not surfaced" entries were
 * really detected-but-unsupported frameworks/features the analyzer never
 * named. The release gate requires these to be EXPLICIT: never represent
 * absence of analysis as absence of routes.
 */

export interface UnsupportedBoundary {
  /** Display name of the detected-but-unsupported framework, e.g. "NestJS". */
  name: string;
  /** How we know it is present, e.g. "@nestjs/core in package.json dependencies". */
  evidence: string;
  /** Per-analysis-area support status. "Supported" areas are still analyzed. */
  analysis: Array<{ area: string; status: 'Supported' | 'Unsupported' }>;
}
