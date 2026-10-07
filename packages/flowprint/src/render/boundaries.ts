/**
 * Flowprint M0 — render unsupported boundaries (Blocker B3).
 *
 * The one rule this section exists to enforce: "no routes shown" must
 * never be misread as "no routes exist". Every detected-but-unsupported
 * framework is named with its evidence and a per-area Supported /
 * Unsupported breakdown.
 */
import type { UnsupportedBoundary } from '../boundaries/types.js';

export function renderBoundaries(boundaries: UnsupportedBoundary[]): string {
  if (boundaries.length === 0) return '';

  const lines: string[] = [];
  lines.push('## Unsupported boundaries');
  lines.push('  The frameworks below were DETECTED in this repo but are outside');
  lines.push('  Flowprint\'s analysis scope. Routes they serve exist and are NOT');
  lines.push('  analyzed — absence from the Routes section means absence of');
  lines.push('  analysis, never absence of routes.');
  lines.push('');
  lines.push('  Detected:');
  for (const b of boundaries) {
    lines.push(`    ${b.name} (${b.evidence})`);
  }
  lines.push('');
  lines.push('  Analysis:');
  for (const b of boundaries) {
    lines.push(`    ${b.name}:`);
    const width = Math.max(...b.analysis.map((a) => a.area.length));
    for (const a of b.analysis) {
      lines.push(`      ${a.area.padEnd(width)}  ${a.status}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
