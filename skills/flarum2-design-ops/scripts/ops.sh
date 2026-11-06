#!/usr/bin/env bash
# Run the flarum2-ops CLI that belongs to this skill.
# Works when the skill is reached through a symlink (e.g. <forum>/.claude/skills/flarum2-design-ops):
# the real location is resolved first, then ../../../tools/flarum2-ops/dist/cli.js is used.
#
# Usage: bash scripts/ops.sh <command> [args]     e.g.  bash scripts/ops.sh doctor
# Output: JSON on stdout. Exit 0 ok · 1 error · 2 usage · 3 dry run (re-run with --confirm after approval).
set -euo pipefail

self="$(readlink -f "${BASH_SOURCE[0]}")"
repo="$(cd "$(dirname "$self")/../../.." && pwd)"
cli="$repo/tools/flarum2-ops/dist/cli.js"

if [[ ! -f "$cli" ]]; then
    printf 'flarum2-ops CLI not found at %s\nBuild it: cd %s/tools/flarum2-ops && npm run build\n' "$cli" "$repo" >&2
    exit 1
fi
if ! command -v node >/dev/null 2>&1; then
    printf 'node is required (>= 18) but was not found in PATH\n' >&2
    exit 1
fi

export FLARUM2_OPS_CONFIG="${FLARUM2_OPS_CONFIG:-$repo/forum.json}"
exec node "$cli" "$@"
