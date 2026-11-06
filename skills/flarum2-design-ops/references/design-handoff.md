# Design hand-off (Claude Design or a human designer) → design-set

A flow proven on a real forum restyle, generalised: screenshot the current forum → brief with hard Flarum constraints →
round 1 (concepts) → round 2 (one concept in detail + token sheet) → implement as a design-set → preview →
side-by-side compare. The constraints matter most: they stop designers from drawing things Flarum cannot
render without a theme extension.

## 0. Prepare the material
1. `designset_screenshot` (live look) → pick `home__light__1440.png`, `all__light__1440.png`, `home__light__390.png`
   (and dark variants if the forum uses `auto`).
2. Collect logos (light + dark), favicon (≥512 px source), optional reference screenshots of sites the user likes.
3. List the forum's real blocks in order (header items, hero, sidebar nav, list, tag tiles, footer); read them off
   the screenshots, do not invent blocks.

## 1. Round-1 brief (concepts)

```
You are designing a visual restyle for <FORUM NAME>, a <purpose> forum running Flarum 2.0.
Its structure is fixed; make the existing blocks look excellent, do not invent new page types.

Attached: current-home-desktop.png, current-all-desktop.png, current-home-mobile.png, <references>, logos.

Hard constraints (Flarum can only be restyled within these):
1. Keep every block and its order: <header items> → <hero/welcome> → <sidebar nav + tag list> → <discussion list> → <footer>.
2. No new components (no stat strips, testimonial rows, custom sidebars). Put ideas under "optional additions".
3. Both colour schemes: light and dark (and they must still read in high contrast).
4. Typography: at most 2 font families with an open licence (they will be self-hosted). Body ≥ 14 px.
5. Tag colours are data (each tag keeps its own colour); style shape/typography, not individual colours.
6. WCAG AA contrast for text, buttons and tags in both schemes; visible focus rings.
7. Deliver <N> concepts, one 1440-wide light artboard of the home page each, a three-word name per concept.
```

## 2. Round-2 brief (the chosen concept)

```
Develop concept "<name>". Deliver:
1. PNG artboards: home 1440 light + dark, home 390 light, /all 1440 light, one discussion page 1440 light.
2. A token sheet, exactly in this plain-text shape:
   primary: #......      primary-hover: #......
   secondary: #......    surface: #......     surface-alt: #......
   text: #......         text-muted: #......  border: #......
   dark.primary … dark.border (same keys for dark)
   font-heading: "Name"  font-body: "Name"  base-size: 15px  line-height: 1.55
   radius-card: 10px  radius-button: 999px  radius-tile: 14px
   shadow-card: 0 8px 24px rgba(...)  shadow-hover: ...
   header-height: 56px  hero-height: 240px  container-max: 1200px
3. A change list per block (1-3 sentences each, in block order).
4. Deviations from the constraints, one line each with the reason.
5. "Optional additions": anything that needs new components/JS, with a one-line rationale.
Keep the design calm and readable; this is a community forum, not a marketing page.
```

## 3. Token sheet → design-set

| Token | Goes to |
|---|---|
| `primary` | `settings.theme_primary_color` |
| `secondary` | `settings.theme_secondary_color` (also tints dark backgrounds, see less-theming.md §4) |
| `surface` / `dark.surface` | `@body-bg-light` / `@body-bg-dark` |
| `surface-alt` / `dark.surface-alt` | `@control-bg-light` / `@control-bg-dark` (or `--hero-bg`, `--pill-bg` if only those differ) |
| `text` / `dark.text` | `@text-color-light` / `@text-color-dark` |
| `text-muted` / `dark.text-muted` | `@muted-color-light` / `@muted-color-dark` |
| `border` | a set token, e.g. `--xx-border`, used in component rules |
| `primary-hover` | component rule on `.Button--primary:hover` (core derives hover itself; override only if specified) |
| fonts | `static/fonts/*.woff2` + `@font-face` with `@@ASSET:` + `html body { font-family }` |
| `radius-*` | `@border-radius` (global) + per-component `border-radius` |
| `header-height` | `@header-height` / `@header-height-phone` |
| `container-max` | `--container-hd` / `--container-xl` (or `.container` rules) |
| colored header in the artboards | `settings.theme_colored_header: true` |
| scheme behaviour | `settings.color_scheme` (`auto` when both schemes are designed) |

Then: `designset_validate` → `designset_preview` → compare screenshots against the artboards
(same viewport) → fix → `designset_gallery`. Record deliberate deviations from the artboards in the set's
`description` or a `NOTES.md` inside the set.
