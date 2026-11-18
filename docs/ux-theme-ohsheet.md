# Slabyrinth skin B: "Oh Sheet" style (token sheet)

The mockup is `docs/mockups/app-mockup-ohsheet.html`. It is an alternative skin of `app-mockup.html` (skin A, "Surveyor's desk", §11 of `ux-design.md`). Markup, states, content and behaviour are identical. Only the `:root` tokens and the "SKIN B OVERRIDES" block at the end of the stylesheet differ.

Source column key:
- **src** means copied from the Oh Sheet UI source (github.com/mwaboff/dawn): `src/styles.css`, `shared/styles/buttons.css`, `forms.css`, `roster.css`, `layout/navbar/navbar.css`, `features/reference/.../codex-search-bar.css` and `features/dashboard/dashboard.css`.
- **derived** means computed from a src value, for example a src alpha flattened onto a src background.
- **inferred** means chosen to fill a gap. Oh Sheet has no full light page theme, and it has no mono, info or warning roles.

## 1. Colour tokens

### Dark (default): Oh Sheet's "warm tavern" palette

| Token | Hex | Role | Source |
|---|---|---|---|
| `--bg` | `#151110` | canvas / page | src `--color-bg-darker` |
| `--surface` | `#1A1412` | panes, title bar, modal | src `--color-bg-dark` (and the nav's `rgba(26,20,18,.95)`) |
| `--surface-2` | `#231B15` | cards, brief, user bubble base | derived: accent 5% over bg-dark |
| `--surface-3` | `#2D2219` | chips, toast, raised | derived: accent 10% over bg-dark |
| `--line` | `#30251A` | hairlines | derived: src `.panel` border `rgba(212,160,86,.12)` flattened |
| `--line-strong` | `#644C2D` | control borders | derived: src `--color-secondary-border` `rgba(212,160,86,.4)` |
| `--accent-line` | `rgba(212,160,86,.40)` | outlined button / chip border | src `--color-secondary-border` |
| `--ink` | `#F5E6D3` | body text | src `--color-parchment` |
| `--ink-2` | `#C9BCAC` | secondary text | derived: src `--color-parchment-a80` flattened |
| `--muted` | `#A89D8F` | meta (6.8:1) | derived: src `--color-parchment-a65` flattened |
| `--accent` / `--accent-fill` | `#D4A056` | gold: headings, numbers, primary | src `--color-accent` |
| `--accent-bright` | `#E6B56D` | gradient end, hover | src `--color-accent-bright` |
| `--accent-tint` | `rgba(212,160,86,.10)` | hover wash, selection | src `--color-secondary-hover-wash` |
| `--on-accent` | `#1A1412` | text on gold | src (primary buttons use `--color-bg-dark`) |
| `--success` | `#6FCE88` | text | src `--color-card-equip-ink` (dark) |
| `--success-fill` | `#89D2A5` | solid chip | src `--color-card-community` |
| `--warning` | `#DC9268` | near-limit | src `--color-card-vault-ink` (dark) |
| `--danger` | `#E0968C` | error text | src `--color-error-text-on-dark` |
| `--danger-fill` | `#ED4E26` | corner markers | src `--color-card-adversary` |
| `--info` | `#83B0D8` | (unused in mockup) | src `--color-card-reserved4` |
| `--focus` | `#D4A056` | focus ring, 2px, offset 2 | src `--color-focus-ring` |

### Light: warm parchment

Oh Sheet's only light surface is its light card face. These tokens extend it into a whole page.

| Token | Hex | Source |
|---|---|---|
| `--bg` | `#EDE3D2` | inferred: parchment `#F5E6D3`, slightly deeper |
| `--surface` | `#F7F4EE` | src `--color-card-face` |
| `--surface-2` / `-3` | `#F0E8DA` / `#E6DAC5` | inferred, parchment family |
| inputs, search, map labels | `#FFFEFB` | src `--color-card-face-lift` |
| `--line` | `#DED5C6` | src `--color-card-rule` |
| `--line-strong` | `#B39C78` | inferred |
| `--ink` / `--ink-2` | `#1D1916` / `#4A423B` | src `--color-card-ink` / `-ink-soft` |
| `--muted` | `#665C50` | src `--color-card-ink-faint` `#6F6558`, darkened to clear 4.5:1 on `--bg` |
| `--accent` (text and strokes) | `#8B5E34` | src `--color-accent-ink` (5.1:1) |
| `--accent-fill` / `--accent-bright` | `#D4A056` / `#E6B56D` | src (solid fills only, never text) |
| `--on-accent` | `#2D241F` | src `--color-text-dark` (6.5:1 on gold) |
| `--success` / `--danger` | `#32693F` / `#7C2F2F` | src `--color-card-equip-ink` / `--color-card-danger-ink` (light) |
| `--warning` / `--info` | `#8A5A12` / `#2F5F86` | inferred |

Rule: in light, gold (`--accent-fill`) is only ever a fill under dark text. Gold text and strokes switch to `--accent` (`#8B5E34`), which is what Oh Sheet does for gold on parchment.

## 2. Type

| Role | Family | Use |
|---|---|---|
| Display | `"Cinzel", "Trajan Pro", Georgia, serif` (src `--font-display`) | Wordmark, titles, section labels, buttons, tabs, room and chunk names, numerals in badges. Cinzel's lowercase *is* small caps, so mixed-case strings render as small caps without `text-transform`. |
| Body | `"Lora", Georgia, "Times New Roman", serif` (src `--font-body`) | Chat, notes, descriptions. Italic Lora is used for subtitles, meta, placeholders, read-aloud text and estimates. |
| Code | `Consolas, "Cascadia Mono", monospace` (inferred) | API key field only |

Google Fonts are loaded as Cinzel 400/600/700/900 and Lora 400/500/600 plus italic 400/500 (same weights as src). Body is 14/22 Lora with `tabular-nums lining-nums`. Lora numerals replace skin A's IBM Plex Mono for costs, sizes and coordinates.

| Element | Size |
|---|---|
| Hero (home greeting) | Cinzel 900 34/40, caps, tracking .06em, gold, glow |
| Panel titles (Room key, Built from v7, Paste guide, Settings) | Cinzel 700 16–20, caps, .08–.1em, gold, glow |
| Section label (`.caps`) | Cinzel 600 10.5/16, caps, .16em, gold |
| Buttons | Cinzel 600–700 11.5–13.5, .05–.1em |
| Tabs | Cinzel 600 11.5, caps, .14em (the src nav-link recipe) |
| Room name | Cinzel 600 14 |
| Meta | Lora italic 11.5–12.5 |

## 3. Shape, borders, depth

- **Radii:** 2px (chips, level squares, checkboxes), 3px (inputs, segmented), 4px (buttons, popovers, rows), 6px (cards, panels, modal). These are src `.btn` 4px, `.form-input` 3px and `.panel` 6px. Skin A's 10–14px radii are gone.
- **Borders:** always 1px. Use gold at 12–30% alpha for structure and 40% for controls (src). Accent rails are 3px on the left (update card, recap, selected room, "Keep it steady" note), from the src light-card rail.
- **Glow:** `0 0 20px rgba(212,160,86,.30)` on gold display titles, dark theme only (src dashboard greeting / nav logo hover).
- **Shadows:** popovers `0 8px 24px rgba(0,0,0,.55)` (src nav dropdown). Primary button `0 2px 8px rgba(0,0,0,.25), inset 0 1px 0 rgba(255,255,255,.2)`, on hover `0 4px 16px rgba(212,160,86,.42)` with a 1px lift (src `.nav-create-btn`).
- **Ground:** a radial candle wash plus bottom settle, plus a fractal-noise grain at 4.5% (src `body::before` / `body::after`, same SVG). The light theme uses multiply grain at 6%. The canvas has a soft vignette.

## 4. Component recipes

- **Primary button:** `linear-gradient(135deg, accent-fill, accent-bright)`, `--on-accent` text, Cinzel 700, radius 4px. Hover lifts 1px with a gold shadow. `.lg` adds caps and .1em tracking.
- **Secondary button (default `.btn`):** transparent, 1px `--accent-line`, ink text, gold icon. Hover adds `--accent-tint` and a full gold border (src `.btn--secondary`).
- **Ghost button:** no border, `--ink-2`. Hover adds a gold wash and gold text.
- **Section header:** gold caps label with a 1px gold-20% rule under it (`.rsec`, popover `h4`, settings `h3`, home "Recent maps"). The centred variant has the label flanked by hairlines that fade out (`.sys` dividers in chat). The left variant has a hairline that fades out to the right (`Paste order …`).
- **Solid chip (category):** Cinzel 700 9.5px caps, .12em, dark text, radius 2px. Gold = plan / version (`PLAN v7`, `v7`, selected answer chip). Green `#89D2A5` = built / OK / recommended.
- **Outline pill (metadata):** 1px `--line-strong`, radius 999px, Lora 12px (brief tags, asset chip, `LATER`).
- **Card / panel:** `--surface-2`, 1px `--line`, radius 6px. A category card adds a 3px left rail in its hue, and a header wash of `--accent-tint` fading to transparent (level headers, recap).
- **Input:** bg at 80% of `--bg`, 1px gold 30%, radius 3px. Focus gives a gold border and a 3px gold ring at 25% (src `.form-input`).
- **Search:** solid parchment `#F5E6D3` in dark (white face-lift in light), italic dark placeholder, and a keyboard chip in `#8B5E34` outline (src `codex-search-bar`).
- **List row (room key, chunk rows):** parchment 3% wash, 2px gaps between rows, radius 2–4px. Hover adds a gold 10% wash and the badge outline turns gold (src `.roster-entry`, `.roster-level`). Name is Cinzel. Dimensions and preview are italic muted. Selected rows get a gold wash, a 1px gold-40% inset, a 3px gold left rail and a solid gold badge.
- **Trackers:** paste-guide progress is a row of 12px outlined squares. Done squares are filled gold. The current step is a gold diamond with a glow (src resource boxes and hope diamond). Size bars sit on a faint green / amber / red threshold track, and the fill turns `--warning` near the limit.
- **Segmented control:** gold-40% frame. The selected segment uses the gold gradient with dark Cinzel text.
- **Toast:** always dark (`#2D2219` in dark, `#2D241F` in light), gold-45% border, bright-gold bold lead.

## 5. Map theme

| Token | Dark | Light / print | Drawn as |
|---|---|---|---|
| `--map-paper` (rock) | `#120E0B` | `#E4D5BB` | ground under hatch |
| `--map-hatch` | `#2E2316` | `#C2AB86` | 45° hatch |
| `--map-floor` | `#241C16` | `#FBF6EC` | floor |
| `--map-grid` | `#30261C` | `#EADFCB` | 1px grid |
| `--map-ink` | `#EAD9BF` cream | `#2D241F` | walls, doors, stairs, furniture, pillars |
| `--map-accent` | `#D4A056` gold | `#8B5E34` | room-number badges, level-link tags, selection outline |
| `--map-label` | `#1A1412` | `#FFFEFB` | badge and tag fill |
| `--map-sel` | gold 13% | gold 22% | selected room wash |
| `--map-water` | `#6AA6B3` | `#2F6F80` | 24% / 40% fill and waves |
| `--map-forest` | `#8DB87A` | `#4F7A3A` | trees |
| `--map-light` | `#E8893A` ember | `#B4561C` | braziers (6 rays) |
| `--map-trap` | `#F07A5E` | `#B03A22` | trap triangle with **T** |

How it differs from skin A:
- **Ink roles:** cream ink on a warm near-black ground. Gold is reserved for *things you can click or that are numbered*: room badges, level links, and the selection.
- **Selection:** the selected room has a gold wash and a **dashed** gold outline (10/4), so it doesn't depend on colour. Its badge also turns into a solid gold disc.
- **Fire and traps:** braziers move to ember orange so they don't read as gold UI, and traps move to scarlet instead of the accent colour.
- **Corner markers:** chunk corner markers stay red, because the copy says "red squares".
- **Labels:** labels use Cinzel. All non-colour cues from §6.2 (hatching, treads + chevron, waves, dots, **S**, **T**, shapes) are unchanged.
- **Print / PNG:** export keeps a light print palette.

Contrast checks: cream on floor 12.1:1, gold on floor 7.2:1, water on floor 6.2:1, trap 6.1:1. In light, `#8B5E34` on label fill is 5.6:1.

## 6. Deliberately not carried over

- **Display face for long text:** Cinzel is only for labels, names and short buttons. Chat, notes and descriptions stay in Lora, because all-small-caps paragraphs are slow to read.
- **Caps on everything:** Oh Sheet uppercases most nav and buttons. Here only tabs, steppers, section labels, chips and large buttons are caps. Small buttons rely on Cinzel's small-caps lowercase to save width in a 400px chat pane.
- **Hero sizes and glow on every title:** big titles appear only on Home and panel headers. The glow is dark-only and never applied to body text.
- **The type-colour ring:** Oh Sheet's 18 card-type hues (purple, pink, etc.) are not used. Slabyrinth needs only a few semantic roles (gold = plan / current, green = built / OK, red = danger), and extra hues would compete with the map.
- **Parchment search as a big block:** kept, but at 30px height in the room key so it doesn't dominate a dense side panel.
- **Card-type tinted header washes on every card:** only levels and the recap card get them.
- **Fixed / backdrop-blurred navbar, hover lift on every button, 0.3s transitions:** a desktop tool title bar should be static, so only primary buttons lift.
- **Wordmark:** Slabyrinth keeps its own mark (outlined slab, cream maze, gold route) and name. Nothing from the "Oh Sheet" logo is used.

## 7. Small layout fixes made in skin B only

- **Chat and room-key overflow:** the chat message and room-key grids use `minmax(0,1fr)` so the wider serif buttons wrap instead of pushing content past the pane. Room previews now ellipsize.
- **Large buttons:** `.btn.lg` forces `inline-flex`. In skin A, the legend's `.lg` class also matches `.btn.lg` and turns it into a two-column grid, a latent bug that is still in skin A.
- **Export PNG popover:** 372px wide (was 340) so its three checkbox labels stay on one line.
- **Settings label column:** 112px (was 130) so the API-key row fits.
