#!/usr/bin/env bash
# Start the flarum2-ops MCP server (stdio) for the forum described by <repo>/forum.json.
# Read-only unless FLARUM_MODE=write is set by the caller (e.g. in .mcp.json "env").
# The credential comes from the 0600 token file named in forum.json; nothing secret is passed here.
set -euo pipefail
self="$(readlink -f "${BASH_SOURCE[0]}")"
pkg="$(dirname "$self")"
repo="$(cd "$pkg/../.." && pwd)"
export FLARUM2_OPS_CONFIG="${FLARUM2_OPS_CONFIG:-$repo/forum.json}"
export FLARUM_MODE="${FLARUM_MODE:-read}"
export FLARUM_EXTENSIONS="${FLARUM_EXTENSIONS:-0}"
# Screenshots need a Python with Playwright: use the first python3 in PATH that can import it.
if [[ -z "${FLARUM2_OPS_PYTHON:-}" ]]; then
    while read -r py; do
        if "$py" -c "import playwright" >/dev/null 2>&1; then export FLARUM2_OPS_PYTHON="$py"; break; fi
    done < <(type -ap python3)
fi
exec node "$pkg/dist/index.js"
