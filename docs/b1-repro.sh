#!/usr/bin/env bash
# Blocker B1 repro — child_process parser isolation.
#
# Proves:
#   (a) the known-crashing input (10k-deep nested parens, oxc#24375) kills a
#       parse child with SIGSEGV (exit 139 class), and
#   (b) the PARENT process survives, completes a full report, and marks the
#       crashing file Unknown ("crashed during parse — file skipped").
#
# Usage: ./docs/b1-repro.sh        (run from the m0 working tree root)
# Exit 0 = both properties held. Cleans up its temp repo afterwards.
set -u
cd "$(dirname "$0")/.."            # m0 root
export PATH="$HOME/workspace/bin:$PATH"

REPRO_DIR="$(pwd)/.b1-repro-repo"
rm -rf "$REPRO_DIR"
mkdir -p "$REPRO_DIR/src"

# (1) the known-crashing input: '(' * 10000 + ')' * 10000.
#     Reproduces the uncatchable native oxc SIGSEGV (exit 139) when parsed
#     in-process — see docs/v01-alpha.md §6 blocker #3.
python3 -c "open('$REPRO_DIR/src/crash.ts','w').write('(' * 10000 + ')' * 10000)"
# (2) innocent bystanders that must still be analyzed normally.
printf 'import { helper } from "./helper";\nexport const main = (): string => helper();\n' > "$REPRO_DIR/src/index.ts"
printf 'export function helper(): string {\n  return "ok";\n}\n' > "$REPRO_DIR/src/helper.ts"
printf '{ "name": "b1-repro", "version": "0.0.0", "type": "module" }\n' > "$REPRO_DIR/package.json"

echo '--- (a) sanity: the input really does SIGSEGV oxc in-process ---'
printf "import { parseSync } from 'oxc-parser';\nimport { readFileSync } from 'node:fs';\nparseSync('crash.ts', readFileSync('$REPRO_DIR/src/crash.ts','utf8'), { lang:'ts', sourceType:'unambiguous' });\nconsole.log('parsed ok');\n" > "$REPRO_DIR/direct.ts"
( pnpm exec tsx "$REPRO_DIR/direct.ts" >/dev/null 2>&1 ); code=$?
echo "in-process parse exit code: $code (139 = SIGSEGV, expected)"
rm -f "$REPRO_DIR/direct.ts"

echo '--- (b) full flowprint scan: child must crash, parent must survive ---'
# NOTE (B4 per-app CLI): bare `flowprint <repo>` is discovery-only. The crash
# file must reach the parser, so analyze the repro repo explicitly via --app.
pnpm flowprint "$REPRO_DIR" --app . > /tmp/b1-repro-out.txt 2> /tmp/b1-repro-err.txt
parent=$?
echo "parent exit code: $parent (0 = survived, expected)"

echo '--- crash evidence (stderr) ---'
grep -E "PARSE CHILD|marked Unknown" /tmp/b1-repro-err.txt || echo '(no crash logs — UNEXPECTED)'

echo '--- report tail (stdout) ---'
tail -12 /tmp/b1-repro-out.txt

ok=0
grep -q "signal=SIGSEGV" /tmp/b1-repro-err.txt || { echo 'FAIL: no SIGSEGV crash log'; ok=1; }
grep -q "parse crashes" /tmp/b1-repro-out.txt   || { echo 'FAIL: report has no "parse crashes" unknown'; ok=1; }
grep -q "src/crash.ts" /tmp/b1-repro-out.txt    || { echo 'FAIL: crash.ts not surfaced in report'; ok=1; }
[ "$parent" -eq 0 ] || { echo 'FAIL: parent did not survive'; ok=1; }

rm -rf "$REPRO_DIR"
if [ "$ok" -eq 0 ]; then echo 'B1 REPRO: PASS — child crashed (SIGSEGV), parent survived, report complete, file Unknown.'; else echo 'B1 REPRO: FAIL'; fi
exit "$ok"
