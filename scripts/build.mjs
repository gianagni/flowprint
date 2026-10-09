#!/usr/bin/env node
/**
 * S6 build script: compiles flowprint to executable JS for distribution.
 *
 * - tsc builds packages/flowprint/src → staging/dist
 * - version.js is generated with the version baked in (package.json is
 *   the single source of truth; the ../../../ traversal breaks under dist)
 * - cli.js shebang is rewritten from tsx to node
 * - child.js is built as a separate file (fork target)
 *
 * Usage: node scripts/build.mjs [staging-dir]
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const staging = process.argv[2] || join(root, 'dist-stage');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

console.log(`Building flowprint ${version} → ${staging}`);

// Clean staging
rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, 'dist'), { recursive: true });

// Build with tsc (only the flowprint package, not bench/harness)
execSync('npx tsc -p tsconfig.build.json', { cwd: root, stdio: 'inherit' });

// Generate version.js with baked-in version (overwrites tsc output)
const versionJs = join(staging, 'dist', 'packages', 'flowprint', 'src', 'version.js');
const versionContent = `/**
 * Generated at build time — DO NOT EDIT.
 * Version is baked in from package.json (${version}).
 */
export const FLOWPRINT_VERSION = ${JSON.stringify(version)};
`;
writeFileSync(versionJs, versionContent);
console.log('Generated version.js');

// Fix shebang in cli.js (tsx → node)
const cliJs = join(staging, 'dist', 'packages', 'flowprint', 'src', 'cli.js');
let cli = readFileSync(cliJs, 'utf8');
cli = cli.replace('#!/usr/bin/env tsx', '#!/usr/bin/env node');
writeFileSync(cliJs, cliContent(cli));
console.log('Fixed cli.js shebang');

function cliContent(s) { return s; }

// Verify child.js exists (fork target)
const childJs = join(staging, 'dist', 'packages', 'flowprint', 'src', 'parsing', 'child.js');
if (!existsSync(childJs)) throw new Error('child.js not built!');
console.log('child.js present');

// Distribution manifest (not private; root stays private)
const distPkg = {
  name: 'flowprint',
  version,
  description: 'A local-first CLI for finding your way through unfamiliar JavaScript and TypeScript codebases.',
  license: 'MIT',
  type: 'module',
  bin: { flowprint: 'dist/packages/flowprint/src/bin.js' },
  // NFR-006: Node engines contract. Must match the spec exactly —
  // never claim a wider range than ^20.19.0 || >=22.12.0.
  engines: { node: '^20.19.0 || >=22.12.0' },
  dependencies: { 'oxc-parser': '0.153.0' },
  optionalDependencies: {
    '@oxc-parser/binding-linux-x64-gnu': '0.153.0',
    '@oxc-parser/binding-linux-arm64-gnu': '0.153.0',
    '@oxc-parser/binding-darwin-x64': '0.153.0',
    '@oxc-parser/binding-darwin-arm64': '0.153.0',
    '@oxc-parser/binding-win32-x64-msvc': '0.153.0',
  },
  files: ['dist/', 'README.md', 'LICENSE'],
};
writeFileSync(join(staging, 'package.json'), JSON.stringify(distPkg, null, 2) + '\n');
console.log('Wrote distribution package.json');

// README and LICENSE
const readmeSrc = join(root, 'README.md');
writeFileSync(join(staging, 'README.md'), existsSync(readmeSrc) ? readFileSync(readmeSrc, 'utf8') : '# Flowprint\n');
const licenseSrc = join(root, 'LICENSE');
writeFileSync(join(staging, 'LICENSE'), existsSync(licenseSrc) ? readFileSync(licenseSrc, 'utf8') : 'MIT\n');
console.log('Build complete.');
