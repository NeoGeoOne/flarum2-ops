# Settings keys (Flarum 2.0.2)

Facts: values are stored as strings in the `settings` table (booleans as `'1'`/`'0'`, max 65000 chars).
A key can be **absent** (code default applies), **NULL** (a row with NULL, which hides the code default) or a
**value**. Read with `flarum_settings_get` (DB-backed; there is no GET endpoint and most of these keys are not
on `GET /api`). Sources: `src/Settings/SettingsServiceProvider.php` (code defaults),
`src/Install/Steps/WriteSettings.php` (install values), admin `AppearancePage.tsx` / `BasicsPage.tsx`.

## Design keys (what design-sets manage)

| Key | Type / allowed | Default | Notes |
|---|---|---|---|
| `theme_primary_color` | hex `#rgb`/`#rrggbb` | `#4D698E` | LESS `@config-primary-color` → `--primary-color`, links, buttons, coloured header. Saving rebuilds CSS. |
| `theme_secondary_color` | hex | `#4D698E` | LESS `@config-secondary-color`; tints dark backgrounds, muted/control colours; drives the pre-CSS dark background. |
| `theme_colored_header` | `'0'`/`'1'` | `'0'` (install) | `<html data-colored-header>`; read per request, no rebuild. |
| `color_scheme` | `auto` `light` `dark` `light-hc` `dark-hc` | `auto` | Not validated by the server. `auto` = OS decides (per-user preference default `auto`) and visitors may switch; a fixed value forces the scheme. "Dark default + switcher" is not possible without JS. |
| `show_theme_selector` | `'0'`/`'1'` | true | Only matters with `color_scheme=auto`. |
| `custom_less` | LESS | `''` | Forum CSS only; see less-theming.md for rules and traps. |
| `custom_header` / `custom_footer` | raw HTML | (absent) | Printed unescaped before/after `#app` on every forum page; `<script>` runs; guests can read it via `/api`. |
| `allow_user_color_scheme` | – | – | Written by the admin UI, **read nowhere** in 2.0.2. Do not use. |

## Optional presentation/content keys

| Key | Default | Notes |
|---|---|---|
| `forum_title`, `forum_description` | install values | title shown in header when no logo |
| `welcome_title`, `welcome_message` | install values | welcome banner (`.Hero`); `welcome_message` is rendered as raw HTML |
| `default_route` | `/all` | start page, e.g. `/tags` |
| `show_language_selector` | true | |
| `fontawesome_source` | `local` | `local` / `cdn` / `kit`; **needs a cache clear** (not wired to a rebuild) |
| `fontawesome_cdn_url`, `fontawesome_kit_url` | `''` | external hosts (privacy) |
| `fontawesome_forced_style` | `''` | |

## Images (managed only through upload endpoints)

`logo_path`, `logo_dark_mode_path`, `email_logo_path` (+ `email_logo_size`), `favicon_path`,
`logo_email_copy_path` / `_size` (written automatically on logo upload). Never POST these: use
`flarum_upload_image` / `flarum_delete_image`. DELETE endpoints leave a NULL row.

## Keys of the bundled extensions (Flarum 2.0.x)

| Extension | Keys (defaults) |
|---|---|
| flarum-tags | `flarum-tags.min_primary_tags` 1, `max_primary_tags` 1, `min_secondary_tags` 0, `max_secondary_tags` 3 |
| flarum-sticky | `flarum-sticky.enable_display_excerpt`, `only_sticky_unread_discussions`, `pin_sticky_on_all_discussions` (true) |
| flarum-emoji | `flarum-emoji.cdn` |
| flarum-likes | `flarum-likes.like_own_post` (true) |
| flarum-mentions | `flarum-mentions.allow_username_format` |
| flarum-flags | `flarum-flags.guidelines_url`, `flarum-flags.can_flag_own` |

Extension keys are conventionally prefixed with the extension id. Before writing one, confirm the exact key
with `flarum_settings_get prefixes:["<id>."]` or `listKeys`, and list the extension in the set's
`requires_extensions`.

## Protected (need `allowProtected` + explicit approval; never inside design-sets)

`maintenance_mode` (`none`/`high`/`low`/`safe`), `safe_mode_extensions`, all `mail_*` except
`mail_driver`/`mail_format`/`mail_from`, anything that looks like a credential (`*password*`, `*secret*`,
`*token*`, `*api_key*`, `*_key`), `slug_driver_*`, `search_driver_*`, `display_name_driver`, `avatar_driver`,
`default_locale`, `allow_sign_up`. Secret-looking values are never displayed by the tools.

## Forbidden (managed by Flarum; writing breaks things)

`extensions_enabled` (use `flarum_extension_set`), `version`, `assets_dirty.*`, `custom_less_error`, image paths.

## Reset semantics
`DELETE /api/settings {keys}` removes rows so code defaults apply again. It fires no Saving/Saved event, so
**CSS is not rebuilt**: clear the cache afterwards when `custom_less` or a theme colour was reset
(`flarum_settings_reset` does this automatically). POSTing `null` is not a reset: it stores NULL.
