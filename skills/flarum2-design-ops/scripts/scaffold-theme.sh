#!/usr/bin/env bash
# Create a Flarum 2 theme-extension package from the bundled template.
# This script writes a new package only. It does not install or enable anything.

set -euo pipefail

usage() {
    printf 'Usage: %s <vendor> <package>\n' "$0" >&2
    printf 'Example: %s acme my-theme\n' "$0" >&2
    printf 'Both arguments must contain lowercase letters, digits and single hyphens only.\n' >&2
}

if [[ $# -ne 2 ]]; then
    usage
    exit 2
fi

VENDOR="$1"
PACKAGE="$2"
NAME_PATTERN='^[a-z0-9]+(-[a-z0-9]+)*$'

if [[ ! ${VENDOR} =~ ${NAME_PATTERN} || ! ${PACKAGE} =~ ${NAME_PATTERN} ]]; then
    printf 'Invalid vendor or package name.\n' >&2
    usage
    exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
    printf 'Missing required command: python3\n' >&2
    exit 1
fi

# Resolve the real skill location (the skill may be reached through a symlink).
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
TEMPLATE_DIR="${SCRIPT_DIR}/../assets/theme-extension-template"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
# Forum root: $FLARUM_ROOT, else forum_root from the repo's forum.json.
if [[ -z "${FLARUM_ROOT:-}" && -f "${REPO_ROOT}/forum.json" ]]; then
    FLARUM_ROOT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("forum_root",""))' "${REPO_ROOT}/forum.json")"
fi
if [[ -z "${FLARUM_ROOT:-}" || ! -f "${FLARUM_ROOT}/flarum" ]]; then
    printf 'Cannot find the Flarum root (set FLARUM_ROOT or forum_root in %s/forum.json)\n' "${REPO_ROOT}" >&2
    exit 1
fi
TARGET_DIR="${FLARUM_ROOT}/packages/${VENDOR}/flarum-${PACKAGE}"

if [[ ! -d ${TEMPLATE_DIR} ]]; then
    printf 'Template directory is missing: %s\n' "${TEMPLATE_DIR}" >&2
    exit 1
fi

if [[ -e ${TARGET_DIR} ]]; then
    printf 'Target already exists; refusing to overwrite: %s\n' "${TARGET_DIR}" >&2
    exit 1
fi

mkdir -p "${TARGET_DIR}"
cp -R "${TEMPLATE_DIR}/." "${TARGET_DIR}/"

python3 - "${TARGET_DIR}" "${VENDOR}" "${PACKAGE}" <<'PY'
from pathlib import Path
import sys

target = Path(sys.argv[1])
vendor = sys.argv[2]
package = sys.argv[3]
package_title = package.replace('-', ' ').title()

replacements = {
    '__VENDOR__': vendor,
    '__PACKAGE__': package,
    '__PACKAGE_TITLE__': package_title,
}

for path in target.rglob('*'):
    if not path.is_file():
        continue
    text = path.read_text(encoding='utf-8')
    for old, new in replacements.items():
        text = text.replace(old, new)
    path.write_text(text, encoding='utf-8')
PY

printf 'Created theme extension package: %s\n' "${TARGET_DIR}"
printf 'Files created:\n'
find "${TARGET_DIR}" -type f -print | sort
printf '\nNo Composer install, activation, database or server changes were performed.\n'
printf 'Review the package and the official Flarum 2 documentation before installing it.\n'
