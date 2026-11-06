# Theming Flarum 2 with custom_less: the knowledge pack

Verified against flarum/core 2.0.2 (`less/common/variables.less`, `less/common/root.less`,
`src/Forum/ForumServiceProvider.php`, `src/Frontend/Compiler/LessCompiler.php`, `src/Forum/ValidateCustomLess.php`).

## 1. Where custom_less sits (this decides how you write it)

Forum stylesheet compile order: `variables.less` → `mixins.less` → generated `@config-primary-color` /
`@config-secondary-color` → core `forum.less` → **custom_less** → **extension LESS** (added later by extenders).

Consequences:
- **LESS variables you redefine in custom_less win everywhere.** LESS evaluates variables lazily and the last
  definition in scope wins, so `@body-bg-dark: #0F172A;` re-derives every shade, button colour and
  high-contrast variant that core computes from it. (An extension that redefines the same variable later wins.)
- **Plain CSS rules lose ties against extension CSS**, because extension CSS comes after. Win by specificity
  (nest under `html { … }`), not by `!important`; keep `!important` for inline styles or extension rules that
  use it themselves, and add a comment saying which rule it beats.
- custom_less applies to the **forum only**: not the admin panel, not the per-locale CSS.
- Saving custom_less (or a theme colour) rebuilds the forum CSS by itself; a reset (DELETE) does not.

## 2. The three layers, in order of robustness

### Layer 1: palette variables (preferred for colour work)
Redefine source variables; derived values follow. Defaults from `variables.less`:

| Variable | Default | Drives |
|---|---|---|
| `@body-bg-light` / `@body-bg-dark` | `#fff` / `hsl(secondary-hue, ≤20%, 10%)` | `--body-bg*`, code bg, header bg, `--text-on-dark/light` |
| `@text-color-light` / `-dark` | `#111` / `#ddd` | `--text-color`, `--heading-color` |
| `@heading-color-light` / `-dark` | = text colour | `--heading-color`, discussion title mix |
| `@muted-color-light` / `-dark` | secondary hue, 50% lightness | `--muted-color*`, control text |
| `@muted-more-color-light` / `-dark` | `#aaa` / secondary hue 40% | `--muted-more-color` |
| `@control-bg-light` / `-dark` | secondary hue 93% / 13% | buttons, inputs, hero, pills, avatar bg |
| `@control-color-light` / `-dark` | = muted colour | button/control text |
| `@control-danger-bg-*` / `-color-*` | `#fdd`/`#411`, `#d66`/`#a88` | danger buttons |
| `@header-bg-light` / `-dark` | = body bg | header (not coloured) |
| `@header-bg-colored-light` / `-dark` | `@primary-color` | header when `theme_colored_header` = 1 |
| `@link-color` | `saturate(@primary-color, 10%)` | `--link-color` |
| `@shadow-color-light` / `-dark`, `@overlay-bg-*`, `@code-bg-*`, `@code-color-*` | see file | shadows, modal overlay, code |
| `@border-radius` | `4px` | `--border-radius` |
| `@header-height` / `@header-height-phone` | `52px` / `46px` | `--header-height*` |
| `@drawer-width`, `@pane-width` | `270px`, `400px` | mobile drawer, discussion pane |

Primary/secondary come from the **settings** `theme_primary_color` / `theme_secondary_color` (via
`@config-*`); set them in `set.json`, not in LESS. `@primary-hue/-sat`, `@secondary-hue/-sat` are available for
derived palettes.

### Layer 2: CSS custom properties (runtime tokens)
Set on `<html>` per scheme. Per-scheme (from `.scheme()` in root.less): `--body-bg`, `--body-bg-shaded`,
`--body-bg-light`, `--body-bg-faded`, `--text-color`, `--heading-color`, `--muted-color`, `--muted-color-light`,
`--muted-color-dark`, `--muted-more-color`, `--shadow-color`, `--control-bg`, `--control-bg-light`,
`--control-bg-shaded`, `--control-color`, `--control-danger-bg`, `--control-danger-color`,
`--control-body-bg-mix`, `--header-bg`, `--header-color`, `--header-control-bg`, `--header-control-color`,
`--overlay-bg`, `--code-bg`, `--code-color`, `--discussion-title-color`, `--control-muted-color`,
`--search-gambit`, `--yiq-threshold`, plus button colour sets.
Shared (`:root`): `--primary-color`, `--secondary-color`, `--link-color`, `--border-radius`, `--header-height`,
`--header-height-phone`, `--drawer-width`, `--pane-width`, `--container-hd/-xl/-xxl`,
`--discussion-content-max-width`, `--post-font-size`, `--hero-bg`, `--hero-color`, `--pill-bg`, `--pill-color`,
`--badge-bg`, `--badge-color`, `--avatar-bg`, `--usercard-bg`, `--discussion-list-item-bg-hover`,
`--tooltip-bg`, `--alert-*`, `--control-success-*`, `--control-warning-*`, `--error-color`,
`--app-bottom-padding`, `--zindex-*`.

Override per scheme with the same selectors core uses (section 3). Use layer 2 for values that are not derived
from a palette variable (e.g. `--hero-bg`, `--discussion-title-color`, `--app-bottom-padding`).

### Layer 3: component rules
Nest under `html { }` (+1 specificity). Real class names in 2.0.2:
`.App`, `.App-header`, `.App-content`, `.Header-logo`, `.Header-title`, `.Header-navigation`, `.Header-controls`,
`.Hero` (welcome banner; `.Hero-subtitle`, `.Hero-close`), `.IndexPage`, `.IndexPage-nav` / `.sideNav`,
`.IndexPage-toolbar`, `.DiscussionList`, `.DiscussionListItem` (`-content`, `-title`, `-info`, `-stats`,
`-author`, `-badges`), `.DiscussionPage`, `.App--discussion`, `.PostStream`, `.Post` (`-body`, `-footer`,
`-actions`), `.Composer`, `.Button--primary`, `.Dropdown-menu`, `.Modal` (`-content`, `-body`, `-footer`),
`.UserPage`, `.SettingsPage`. Tags extension: `.TagTiles`, `.TagTile` (`-info`, `-name`, `-description`,
`-lastPostedDiscussion`), `.TagHero`, `.TagLabel`, `.TagsLabel`.
Every entry of an ItemList (nav links, header controls, toolbars, post actions…) gets the class
`item-<key>` (`js/src/common/helpers/listItems.tsx`), e.g. `.item-allDiscussions`, `.item-tags`,
`.item-newDiscussion`, so single entries can be styled or hidden without JS.
Inspect the live DOM (`designset_screenshot` + browser devtools) before styling anything not listed.

## 3. Scheme selectors (all on `<html>`)

| Selector | When |
|---|---|
| `html[data-theme^=light]` | light and light-hc |
| `html[data-theme^=dark]` | dark and dark-hc |
| `html[data-theme=light-hc]`, `html[data-theme=dark-hc]` | high contrast (core re-overrides muted/control/button colours and the coloured header here) |
| `html[data-colored-header=true]` | setting `theme_colored_header` = 1 |

`color_scheme` = `auto` lets each visitor follow the OS or pick a scheme (theme selector when
`show_theme_selector` = 1); a fixed value forces it. Style **all four** variants when the set uses `auto`;
validation warns when dark/light are styled but `-hc` never appears.

"Dark by default but still switchable" is **not** possible with settings alone: each user's `colorScheme`
preference defaults to `auto` (`UserServiceProvider.php`: `registerPreference('colorScheme', …, 'auto')`), i.e.
the OS decides, and visitors can only switch when `color_scheme` = `auto`. Choose between `dark` (forced, no
switcher) and `auto` (OS default + switcher); a dark default with a switcher needs a theme extension (JS).

Nested form inside `html { }`: `&[data-theme^=dark] .Hero { … }` compiles to `html[data-theme^=dark] .Hero`.

## 4. Proven patterns

```less
// Media queries: use core's variables (same breakpoints as Flarum itself)
html {
  @media @phone      { .DiscussionListItem { border-radius: 0; } }   // ≤ 767.98px
  @media @tablet-up  { .Hero { padding: 48px 0; } }                  // ≥ 768px
  @media @desktop-up { .IndexPage-nav { width: 220px; } }           // ≥ 992px
}
// Also: @small-phone, @tablet, @desktop, @desktop-hd (≥1100), @desktop-xl (≥1600)

// Page-specific styling without JS
html .IndexPage:has(.item-allDiscussions.active) .Hero { display: none; }

// Container width per desktop band, and the post-stream line-length cap (official theme docs)
:root {
  --container-hd: 1240px;               // ≥1100px
  --container-xl: 1440px;               // ≥1600px
  --discussion-content-max-width: 900px; // or `none`
}

// A token you reuse
:root { --sa-radius-card: 12px; }
html .TagTile { border-radius: var(--sa-radius-card); }
```

- Button text colour on primary is chosen by the YIQ formula (`r*299 + g*587 + b*114 >= 128000` → dark text).
  Check primary colours against both text colours for WCAG AA (4.5:1 for body text).
- **Dark page background is pinned by core (important):** Flarum 2.0.2 inlines critical CSS
  `[data-theme^=dark] body{background:<hsl(secondary hue, ≤20% sat, 10%)>}` computed from
  `theme_secondary_color` (`FrontendServiceProvider.php`, `computeDarkBodyBg`). Its specificity (0,1,1) beats
  core's `body { background: var(--body-bg) }`, so a redefined `@body-bg-dark` changes cards, controls and
  derived shades but **not the page background**. Always add
  `html[data-theme^=dark] body { background: var(--body-bg); }` when you change the dark background
  (validation warns if you forget). Choose `theme_secondary_color` so its derived colour is close to your dark
  background to avoid a flash before the stylesheet loads. Light mode is not affected (`body{background:#fff}`
  has the same specificity as core's rule and loses to the later stylesheet).
- Keep copy (headlines, labels) out of `content:` strings; put it in HTML/settings or a LESS variable at the top.

## 5. LESS traps (validation catches the first four)

| Trap | Fix |
|---|---|
| `data-uri()` is refused (422) | put the file in `static/`, use `url('@@ASSET:…@@')` |
| local `@import 'x.less'` is refused | inline the rules |
| protocol-relative `@import url(//…)` is refused | use `https://` (or better: self-host) |
| `grid-column: 1 / 3;` becomes a division in less.php | `grid-column: ~"1 / 3";` (same for `aspect-ratio`, `font` shorthand) |
| remote `@import url(https://fonts…)` works but every visitor's browser contacts that host (GDPR) | self-host fonts (section 6) |
| a failed save leaves `custom_less_error` → Flarum drops custom_less silently | the engine restores; see troubleshooting.md |
| a `calc()` with LESS variables comes out wrong | escape: `width: ~"calc(100% - 16px)";` |
| values > 65000 characters are refused | split rarely-used styling out, or move to a theme extension |

## 6. Fonts (self-hosted, GDPR-safe)

```less
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400 700;            // one variable font file covers all weights
  font-display: swap;
  src: url('@@ASSET:fonts/Inter-latin.woff2@@') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
// + a second @font-face with the latin-ext file and the latin-ext unicode-range (umlauts are in latin; ŁŞő… in latin-ext)
html body { font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; }
```
Ship only the subsets and weights you use. Read the copyright line, licence and weight axis from the font file
itself instead of guessing (e.g. `python3 -c "from fontTools.ttLib import TTFont; t=TTFont('x.woff2');
print(t['name'].getDebugName(0), [(a.axisTag,a.minValue,a.maxValue) for a in t['fvar'].axes] if 'fvar' in t else '')"`),
declare `font-weight` to match the axis, and ship the licence text (OFL.txt) with the set.

## 7. When custom_less is not enough → theme extension
Move to `references/theme-extension.md` when the design needs: new or reordered components, different markup,
JavaScript behaviour, styling that must win over extension CSS without dozens of `!important`s, admin-panel
styling, or a stylesheet larger than ~65 kB.
