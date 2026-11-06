# flarum2-ops: MCP server + CLI

One engine, two front ends. Source: `<repo>/tools/flarum2-ops` (TypeScript, fork of mcp-for-flarum 0.8.0, MIT;
see its NOTICE). `<repo>` = the root of the flarum2-ops repository (the folder with `forum.json`).

## Configuration
`<repo>/forum.json` (no secrets): `name`, `base_url`, `forum_root`, `token_file`, `design_sets_dir`,
`public_assets_subdir`, optional `services` (default nginx, php8.4-fpm, mariadb).
Environment overrides: `FLARUM_URL`, `FLARUM_ROOT`, `FLARUM_TOKEN_FILE`, `FLARUM_API_KEY` (wins over the file),
`FLARUM_DESIGN_SETS_DIR`, `FLARUM_SERVICES`, `FLARUM2_OPS_CONFIG` (another forum.json), `FLARUM2_OPS_PYTHON`
(Python with Playwright for screenshots; default `python3`).

## Credential
`bash <skill-dir>/scripts/ops.sh login` must be run **by the user in a normal terminal window** (Claude Code
`!` commands and pipes have no keyboard input; the CLI refuses them with exit 2): asks for
username/email and a hidden password, calls `POST /api/token` with `remember=1`, writes the token to
`~/.config/flarum2/token` (directory 0700, file 0600) and checks admin rights. The token is never printed,
never put in argv, and redacted from error output. To revoke: delete the file (and log out of the forum to
invalidate the token server-side, or change the password, which deletes all tokens).

## CLI
`bash <skill-dir>/scripts/ops.sh <command>` (resolves the real repo path even through the skill symlink).
JSON on stdout, messages on stderr. Exit codes: **0** ok · **1** error/blocked by validation · **2** usage ·
**3** dry run (nothing changed; repeat with `--confirm` after approval). `--compact` for one-line JSON.
`ops.sh help` lists every command. `ops.sh api GET /tags` is the raw escape hatch (non-GET needs `--confirm`).

## MCP
Registered for the forum project in `<forum>/.mcp.json` as `flarum2-ops`, started by
`<repo>/tools/flarum2-ops/run-mcp.sh`. Defaults: **read-only** (write tools are not even listed), extension
manager tools off. Write mode: set `FLARUM_MODE=write` in `.mcp.json` env (user decision); mutating tools then
still require `confirm: true` and are annotated `destructiveHint` where appropriate.

Tools (read): `flarum_doctor`, `flarum_health`, `flarum_whoami`, `flarum_settings_get`, `flarum_list`,
`flarum_get`, `flarum_search`, `flarum_request` (GET only in read mode), `designset_list`, `designset_validate`,
`designset_diff`, `designset_screenshot`, `designset_gallery`, `designset_snapshot`, `designset_new`, plus
`flarum_docs_*` (reads docs.flarum.org), `flarum_dev`, `flarum_troubleshoot`.
Tools (write mode): `flarum_settings_set`, `flarum_settings_reset`, `flarum_upload_image`,
`flarum_delete_image`, `flarum_cache_clear`, `flarum_extension_set`, `flarum_permission_set`,
`designset_apply`, `designset_preview`, `designset_rollback`, `flarum_create`, `flarum_update`,
`flarum_delete`, `flarum_create_discussion`, `flarum_reply`.

Fixed compared with mcp-for-flarum 0.8.0: `/api/...` paths no longer turn into `/api/api/...`; responses carry
the HTTP status (204 is reported, not `""`); `DELETE /cache` NDJSON is parsed; multipart uploads exist; a
rejected token is reported instead of silently acting as guest; read-only is the default; per-call timeouts;
outdated help corrected (CSRF errors are 400; safe mode / `extension:disable` / `extension:bisect` exist;
2.0 is stable; daily log files `storage/logs/flarum-YYYY-MM-DD.log`).

## Maintenance
```bash
cd <repo>/tools/flarum2-ops
npm test          # builds (tsc) and runs the offline test suite against a mock Flarum 2 server
```
After a Flarum update: re-check `vendor/flarum/core/src/Api/routes.php`, `less/common/variables.less` and
`root.less` against references/api-endpoints.md and less-theming.md, then run `ops.sh doctor`.
