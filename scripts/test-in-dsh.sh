#!/usr/bin/env bash
# Run every test, including the agent-loop tests, and type-check the plugin
# inside a DeepSeek Harness source checkout (after `pnpm install` there).
#
#   scripts/test-in-dsh.sh /path/to/deepseek-harness
#
# The plugin is copied to packages/community/result-check in that checkout,
# which dsh's own vitest config and tsconfig paths already cover.
set -euo pipefail

DSH="${1:?usage: scripts/test-in-dsh.sh /path/to/deepseek-harness}"
DSH="$(cd "$DSH" && pwd)"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$DSH/packages/community/result-check"

mkdir -p "$DEST"
rsync -a --delete --exclude node_modules --exclude lib --exclude .git "$HERE/" "$DEST/"
cat > "$DEST/tsconfig.json" <<'EOF'
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "composite": false, "declaration": false, "declarationMap": false },
  "include": ["src", "tests"]
}
EOF

cd "$DSH"
npx vitest run packages/community/result-check/tests

# dsh type-checks its packages through project references; compiling the
# plugin on its own pulls dsh's vendored sources in under the plugin's
# settings, and those report errors that are not ours. Keep only our files'.
own_errors="$(npx tsc -p packages/community/result-check/tsconfig.json 2>&1 | grep '^packages/community/result-check/' || true)"
if [ -n "$own_errors" ]; then
  echo "$own_errors"
  exit 1
fi
echo "result-check: tests and type check passed in $DSH"
