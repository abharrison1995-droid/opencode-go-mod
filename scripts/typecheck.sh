#!/usr/bin/env bash
# Type-checks hooks/ and types/ against the engine's declarations.
#
# The declarations are not in the repo. This uses, in order:
#   1. CLAUDE_CODE_TYPES=/path/to/claude-code.d.ts
#   2. .claude-plugin/types/, which the engine writes when it hot-reloads the mod from this folder
#   3. the newest copy the plugin-authoring skill unpacked under /tmp/claude-*/bundled-skills
# tsc comes from TSC, else tsc on PATH, else npx (TypeScript 6.0.3).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

if [ -n "${TSC:-}" ]; then tsc=("$TSC")
elif command -v tsc >/dev/null; then tsc=(tsc)
else tsc=(npx --yes -p typescript@6.0.3 tsc)
fi

if [ -z "${CLAUDE_CODE_TYPES:-}" ] && [ -f "$root/.claude-plugin/types/tsconfig.json" ]; then
  exec "${tsc[@]}" -p "$root/tsconfig.json"
fi

types="${CLAUDE_CODE_TYPES:-}"
if [ -z "$types" ]; then
  types="$(ls -d /tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | sort -V -t/ -k5 | tail -n 1 || true)"
fi
if [ -z "$types" ] || [ ! -f "$types" ]; then
  echo "No engine types found. Open the mod in Claude Code (it writes .claude-plugin/types/), or set CLAUDE_CODE_TYPES." >&2
  exit 2
fi
echo "Types: $types" >&2

dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
# The same options as .claude-plugin/types/tsconfig.json.
cat >"$dir/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [], "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": ["$types", "$root/hooks", "$root/types"]
}
EOF
"${tsc[@]}" -p "$dir/tsconfig.json"
