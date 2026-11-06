# Troubleshooting: symptom → cause → fix

Start every diagnosis with `flarum_doctor` (or `ops.sh doctor`); most rows below show up there.

| Symptom | Cause | Fix |
|---|---|---|
| Custom styles vanished although `custom_less` still contains them | `custom_less_error` is set: a previous save failed the trial compile, and Flarum drops custom_less on every compile until a valid save (`LessCompiler.php:156`) | `flarum_settings_get keys:["custom_less_error"]` shows the parse error → fix the LESS in the set → `designset_apply`. Without a set: `flarum_settings_set {custom_less: <valid>}` (a successful save clears the flag) |
| 422 `validation_error` with pointer `/data/attributes/custom_less` | LESS parse error, `data-uri()`, or a local/protocol-relative `@import` | Run `designset_validate`; fix the reported line; see less-theming.md §5 |
| Admin calls return 403, reads work | Token invalid/expired/for another forum → Flarum treats you as a guest | `flarum_whoami` shows `authenticated:false` → user runs `ops.sh login` again |
| 400 `csrf_token_mismatch` | Write without `Authorization` header | Use the tools (they send the token) or add `Authorization: Token …` |
| 404 on `/api/api/...` | Path prefixed with `/api` by a tool that adds it (mcp-for-flarum 0.8.0 behaviour) | flarum2-ops strips it; with other tools use `/settings` not `/api/settings` |
| Colours changed in the admin UI disappeared after apply | The set defines all theme keys; apply returns omitted ones to defaults | Before applying, `designset export <name>` keeps hand-made changes; doctor's `drift` warns about them |
| Reset a key but the forum still shows the old look | `DELETE /api/settings` does not rebuild CSS | `flarum_cache_clear` (the engine does this automatically for CSS keys) |
| Style overrides of an extension do not apply | custom_less compiles before extension LESS; equal specificity loses | Nest under `html { }` / add a parent class; last resort `!important` with a comment |
| Font not loading / old font after update | Wrong path or 30-day nginx cache | Use `@@ASSET:fonts/x.woff2@@` (versioned URL); check `public/assets/design-sets/<set>/` exists |
| Dark-mode logo uploaded but never shown | Flarum renders the dark logo only together with a normal logo (`forum.blade.php`) | Upload a normal logo too (`image upload logo …`) |
| Logo blurry | Flarum scales logos to 60 px height (upscales small images) | Upload a source ≥120 px high |
| SVG/ICO logo rejected | Flarum 2 accepts only jpeg/png/gif/webp/bmp | Export PNG/WebP |
| Dark page background ignores `@body-bg-dark` (or flashes another colour on load) | Inline critical CSS `[data-theme^=dark] body{background:…}` derived from `theme_secondary_color` beats core's body rule | Add `html[data-theme^=dark] body { background: var(--body-bg); }`; pick a secondary colour whose derived dark tone is close to avoid the flash |
| High-contrast scheme looks off | Core re-overrides muted/control/button colours for `-hc` | Style `html[data-theme=light-hc]` / `dark-hc` explicitly; check hc screenshots |
| `php flarum cache:clear` fails with permission errors | Cache dirs created by php-fpm (`www-data`) are not group-writable for the shell user | Use `flarum_cache_clear` (runs as www-data via the API) |
| `designset apply` refuses: "another design-set write is running" | Lock file from a running or crashed process | Wait; if no flarum2-ops process runs, the stale lock is replaced automatically (dead PID) |
| Rollback verify lists image differences | Re-uploaded images always get new file names | Expected; only presence is compared. Real differences show as `action: delete` |
| Whole forum 500 after enabling an extension | Incompatible extension / failed migration | `php flarum extension:disable <id>` then `php flarum cache:clear` (as the web user if needed); see storage/logs/flarum-YYYY-MM-DD.log |
| Screenshots fail: "python playwright is not installed" | Wrong Python | Set `FLARUM2_OPS_PYTHON` to a `python3` that has Playwright and its Chromium installed |
