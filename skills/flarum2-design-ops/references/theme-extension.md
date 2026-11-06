# Fallback: a real Flarum 2 theme extension

Official position (https://docs.flarum.org/extend/theme/): Flarum "themes" are extensions that register LESS/JS
with the `Frontend` extender; `extra.flarum-extension.category: "theme"` only files it under "Themes" in the
admin list; Flarum has **no built-in theme switching**. Design-sets cover switching and API-level styling;
escalate to an extension only when a set cannot do the job.

## Escalate when
- new or re-ordered components, different markup, extra pages (needs Mithril/JS);
- JS behaviour (sticky elements, carousels, client-side logic);
- many overrides of extension CSS would need `!important` (extension LESS compiles after custom_less, so a
  theme extension can win ties naturally if it loads after the target extension);
- the admin panel must be styled (custom_less is forum-only);
- custom_less would exceed ~65 kB.

A design-set and a theme extension combine well: the extension carries structure/JS, the sets carry palettes,
fonts and switchable looks on top.

## Scaffold (files only; installs nothing)

```bash
bash <skill-dir>/scripts/scaffold-theme.sh <vendor> <package>     # → <forum>/packages/<vendor>/flarum-<package>/
```
Creates `composer.json` (`type: flarum-extension`, `flarum/core: ^2.0.0`, category theme), `extend.php`
(`Extend\Frontend('forum')->css(...)`, same for admin) and `less/forum.less` / `less/admin.less`.
The forum root comes from `FLARUM_ROOT` or `forum_root` in the repo's `forum.json`.

## Install / enable (each step needs the user's approval and follows the project's rules)
1. Composer path repository in the forum's `composer.json`
   (`"repositories": [{"type": "path", "url": "packages/*/*"}]`), then `composer require <vendor>/flarum-<package>:*@dev`.
   This changes `composer.json`/`composer.lock`: back them up first.
2. Enable with `flarum_extension_set`. The extension id is `<vendor>-<package>` with any `flarum-ext-` /
   `flarum-` prefix removed from the package part (`Extension::nameToId`), e.g. `acme/flarum-night-sky` →
   `acme-night-sky`. Confirm in `php flarum info`.
3. JavaScript (only if needed): follow https://docs.flarum.org/extend/frontend/ for the current `js/` tooling,
   build with the package's own scripts, never edit `public/assets` or `vendor/`.
4. Verify: `flarum_doctor`, `designset_screenshot`, browser console clean.

Rollback: disable the extension (`flarum_extension_set enabled:false`), `composer remove`, restore
`composer.json`/`composer.lock` from the backup.
