---
name: flarum2-design-ops
description: Use when working on a Flarum 2 forum (Flarum 2.0.x, configured in flarum2-ops' forum.json) in any way that touches its look or its admin API - colors, dark mode, high contrast, color scheme, colored header, logo, dark-mode logo, favicon, custom CSS/LESS, custom header/footer HTML, welcome banner, tag colors/icons, fonts, "make the forum look like…", creating, previewing, comparing, switching or rolling back design-sets/themes, reading or changing Flarum settings, extension enable/disable, permissions, cache clear, health checks, or Flarum REST/JSON:API calls - even when the user does not say "design-set" or "API".
---

# Flarum 2 design & admin ops

Operate this Flarum 2 forum through its official admin API and manage **design-sets**: versioned folders
(LESS, settings, HTML, images, fonts, tag styling) that are snapshotted, previewed, applied and rolled back by
the bundled `flarum2-ops` engine. The engine encodes the Flarum 2.0.2 behaviour that silently breaks naive
API writes (see "Why the engine, not raw API calls").

The forum project's own rules (its AGENTS.md / CLAUDE.md, if it has one) always win over this skill. Read them
before the first write.

## Tools: MCP first, CLI equivalent

Use the `flarum2-ops` MCP tools when connected (read-only by default), otherwise the CLI (`bash scripts/ops.sh …`
from this skill's directory). Both run the same engine. Every mutating command is a **dry run** unless
`confirm: true` / `--confirm`; CLI exit 3 = dry run, nothing changed.

| Task | MCP tool | CLI |
|---|---|---|
| Status (always first) | `flarum_doctor` | `ops.sh doctor` |
| Read settings (DB; API has no settings GET) | `flarum_settings_get` | `ops.sh settings get <key>… [--prefix p.]` |
| List sets / snapshots | `designset_list` | `ops.sh designset list` · `designset snapshots` |
| New set / export live look | `designset_new` / `designset_snapshot exportAs` | `designset new <n>` / `designset export <n>` |
| Check a set | `designset_validate` | `designset validate <n>` |
| What would change | `designset_diff` | `designset diff <n>` |
| Try on (apply → screenshots → rollback) | `designset_preview` | `designset preview <n> --confirm` |
| Make it live | `designset_apply` | `designset apply <n> --confirm` |
| Undo | `designset_rollback` | `designset rollback [snapshot] --confirm` |
| Screenshots of the live forum | `designset_screenshot` | `designset screenshot [n]` |
| Compare sets visually | `designset_gallery` | `designset gallery` → `design-sets/gallery.html` |
| Logo / dark logo / email logo / favicon | `flarum_upload_image` / `flarum_delete_image` | `image upload <kind> <file>` |
| Single setting change | `flarum_settings_set` / `flarum_settings_reset` | `settings set k=v` / `settings reset k` |
| Cache clear | `flarum_cache_clear` | `cache clear` |
| Extension on/off | `flarum_extension_set` | `extension <id> on\|off` |
| Permission | `flarum_permission_set` | `permission <name> <ids>` |
| Anything else in the API | `flarum_list` / `flarum_get` / `flarum_request` | `api GET <path>` |

No token yet → ask the user to run `bash <skill-dir>/scripts/ops.sh login` **in a normal terminal window**
(it needs keyboard input; Claude Code `!` commands have none). It prompts for the password hidden and stores
the token 0600 in `~/.config/flarum2/token`. Never ask for, print or store the password or token.

## Approval matrix

| Action | Rule |
|---|---|
| Reads, doctor, validate, diff, dry runs, screenshots, gallery, new/export set (local files) | Do it |
| `preview`, `apply`, `rollback` | Show the dry-run plan, get a yes **for that set/snapshot**, then confirm |
| Extension enable/disable (runs DB migrations), permissions, content writes, tag create/delete/reorder, settings reset outside rollback | Separate, explicit approval each time; never bundle with a design change |
| Protected keys (mail_*, maintenance_mode, drivers, secrets) | Only with `allowProtected` + explicit approval |
| Extension uninstall, DB writes, composer, web server, file permissions | Not this skill: follow the project's rules (ask first) |

## Recipes

**1. Inspect** – `flarum_doctor` → answer from its output (actor/admin, health, applied set, drift,
`custom_less_error`). Add `flarum_settings_get` / `designset_screenshot` only if the question needs it.

**2. New look → choose → go live**
1. `flarum_doctor`; stop on problems you cannot explain.
2. Base the work on a set: `designset_new <name>` (template) or `designset_snapshot exportAs=<name>` (current look).
3. Edit the set files. Read `references/less-theming.md` before writing LESS, `references/design-sets.md`
   for set.json semantics. Fonts/images go in `static/` and are referenced as `@@ASSET:path@@`.
4. `designset_validate` until `ok: true` with no errors; fix warnings or explain why they stay.
5. `designset_diff` → show the user the plan → on approval `designset_preview confirm:true`
   → `designset_gallery` → let the user pick (show screenshot paths).
6. On "go live": `designset_apply confirm:true` (the engine snapshots first and rolls back by itself on any failure).
7. Append the returned `logEntry` to the project's operations log if it keeps one (e.g. `docs/operations.md`).

**3. Something looks wrong / undo**
`flarum_doctor` → if `custom_less_error` is set or drift is reported, read `references/troubleshooting.md`.
To undo: `designset_rollback` (dry run shows what differs) → approval → `confirm:true` (default: latest snapshot).

For a design hand-off to Claude Design or a human designer, use `references/design-handoff.md`.
When the API + LESS cannot express a change (new components, JS behaviour), use `references/theme-extension.md`.

## Report format

After any write, report in this order: what changed (set/keys/images/tags), snapshot id + exact rollback
command, verification result (read-back, `custom_less_error`, health, screenshot problems), the operations.md
entry you appended. After a dry run: the plan and the single question you need answered.
Claims about how something looks need a screenshot behind them (`designset_screenshot`/preview); otherwise
say it is untested. State the breakpoint scope of every CSS effect (e.g. "desktop only"). Give times in the
user's local time (tool output is UTC).

## Why the engine, not raw API calls

Verified against flarum/core 2.0.2 – each one silently damaged naive scripts:
- A bad token is **not rejected**; requests run as a guest (admin calls 403, reads look fine). Doctor checks it.
- A rejected `custom_less` (422) leaves `custom_less_error` behind and Flarum then **drops custom_less on every
  compile** until a valid save. The engine sends `custom_less` alone and re-saves to clear the flag.
- `DELETE /api/settings` (reset) does **not** rebuild CSS → the engine clears the cache when CSS keys are reset.
- `null` stores a NULL row that hides Flarum's default; "absent" needs DELETE. Snapshots keep absent/null/value apart.
- Image uploads get random file names and delete the previous file; the engine keeps its own copies.
- `custom_less` compiles **before** extension LESS, so equal-specificity overrides of extension styles lose.

## Stop conditions

Stop and ask when: doctor shows the token is not an admin or the forum is unhealthy before you start; validation
errors you cannot fix within the user's intent; a set needs an extension that is not enabled; rollback
verification reports differences; drift shows someone changed the design in the admin UI (export it before
overwriting); the request needs a protected key, an extension toggle, a permission or anything outside the API.

## References (load only what the task needs)

| File | Read when |
|---|---|
| `references/design-sets.md` | creating/editing a set; set.json fields; apply/rollback semantics |
| `references/less-theming.md` | writing custom.less: palette variables, CSS vars, selectors, specificity, fonts, LESS traps |
| `references/settings-keys.md` | which keys exist, defaults, value formats, protected/forbidden keys |
| `references/api-endpoints.md` | raw API work: every admin endpoint, body, status, side effects |
| `references/design-handoff.md` | briefing a designer / Claude Design and turning the hand-off into a set |
| `references/theme-extension.md` | the change needs a real extension (components, JS) |
| `references/mcp-and-cli.md` | setup, modes, token, MCP wiring, CLI exit codes |
| `references/troubleshooting.md` | symptom → cause → fix |
