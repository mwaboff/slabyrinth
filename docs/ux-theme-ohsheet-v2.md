# Slabyrinth skin B v2: refined "Oh Sheet" style (token sheet)

Mockup: `docs/mockups/app-mockup-ohsheet-v2.html`. It uses the same markup, states, content and switcher as skin B v1 (`app-mockup-ohsheet.html`) and skin A (`app-mockup.html`). Only the `:root` tokens and the override block at the end of the stylesheet are different. The strip at the top links to v1 and skin A so you can compare them.

The user's brief was "less cluttered, easier to read, classier", and in particular "if there is a lot of text, it can be hard to read". Later the scope widened: v2 may move away from Oh Sheet, as long as it still feels like a more polished member of the same family. So v2 keeps the warm near-black, the gold, Cinzel for names and titles, and Lora for prose. It drops the Oh Sheet habits that were causing the problems.

---

## (a) Critique of v1, ranked by how much each problem contributes to "sloppy / cluttered / hard to read"

All observations are from v1 rendered at 1600×960 in every state, dark and light.

1. **Cinzel small caps on nearly every label, with tracked uppercase on top.** One render of the Plan state used 34 distinct text styles. Twenty-five of them were Cinzel, mostly at 9.5–13px with 0.04–0.18em tracking, and many were also `text-transform:uppercase`. That covers tabs (`MAP`, `BUILD`), the stepper, every button (`SHOW ON MAP`, `COMPARE WITH V6`, `COPY & OPEN TALESPIRE`), section labels, chips (`RECOMMENDED`, `PLAN V7 · NOT APPROVED`), checkbox labels (`PASTED`), chunk names, model names, settings nav, status text, and even inline bold in a chat sentence ("Let's build a map."). Cinzel is a titling face. At 11px its small caps are about 7.5px tall, and tracking makes words fall apart. Because everything is set in the "important" voice, there is no hierarchy, and that is the main reason it reads as noisy.
2. **Italic used as the default "secondary" voice.** Lora italic at 11–13px was used for room-key previews, room dimensions, read-aloud text, meta lines (`Sonnet · Thorough · 41 s`), estimates, chunk metadata, settings descriptions, starter cards, the paste-guide "Keep it steady" tip, placeholders, the Home recap and the settings footer. Small serif italics have the lowest legibility of any style on the page, and this was most of the secondary text. This is the main cause of "lots of text is hard to read".
3. **Gold on everything, so it signals nothing.** Gold was used for headings (`ROOM KEY`, `BUILT FROM V7`, `SETTINGS`, `EXPORT PNG`, `NO MAP YET`, Home greeting), all section labels, the borders and icons of every secondary button, field and chip borders, dividers (`TODAY`, `PASTE ORDER`), list markers, `$$` tiers, active tabs, the stepper, the brief summary, room names when selected, version chips, three segmented controls, checkboxes and the paste-progress squares. With so much gold, the one action that matters (Approve plan v7, Next: copy chunk 3) did not stand out.
4. **Boxes inside boxes.** The update card had a border plus a 3px rail. The recap card had a border, a rail and a gradient. The brief card had a border plus a header rule. The getin box was bordered, level cards were bordered, every chunk row inside them was bordered, and every room-key section label had its own underline. The parchment search field was a bright block in dark mode, and the theme and settings buttons sat in gold circles. Together that is roughly 40 visible rules on the Build screen. The structure was being drawn with lines instead of with space.
5. **Glow, grain, gradients.** Gold titles had a 20px `text-shadow` glow, which makes text look soft or out of focus. A fractal-noise grain was laid over the whole app at `z-index:60`, so it sat on top of the text. Primary buttons used a 135° gradient with a lift on hover, and the current paste step was a glowing rotated diamond. Each of these is small, but together they read as "decorated" rather than "classy".
6. **Measure and size of long text.** Chat body was 14/22. Room notes were 13/19 in a column about 230px wide (about 33 characters), indented under the room badge. Read-aloud was italic 13px. These are short, cramped lines for the content a GM actually reads at the table.
7. **Inconsistent shapes.** Radii of 2, 3, 4 and 6px plus 999px pills were mixed with no rule: square stepper dots, square paste squares, 2px chips next to pill tags, and circular icon buttons beside square ones.
8. **Specific defects:**
   - The API key field clips by 3px (`scrollWidth 230 > clientWidth 227`).
   - The settings footer text runs into the Done button with no gap.
   - Map room labels (tracked uppercase Cinzel 8px) overlap walls: `COLLAPSED STAIR` crosses R1's east wall and `FLOODED CRYPT` sits on the water line.
   - Light theme: `/` and `›` crumbs are 2.4:1, gold `·` separators are 2.4:1, room-key section labels and the selected room name are exactly 4.5:1, and the `LATER` tag and "Coming in a later update" are 2.7:1 because of `opacity:.62`.
   - The chat thread cuts a line in half under the brief card with no fade.
9. **Weak hierarchy in the stage chrome.** The tab row and the toolbar both used gold tracked caps, so the level tabs, view tabs and tools all carried the same weight.

**What was already good in v1 and is kept:**
- the warm near-black palette and the parchment light theme
- Lora 14–15px for chat prose, which reads well; the problem was everything around it
- the map drawing (cream ink on warm black, the hatching, waves, and the ember braziers that are distinct from UI gold)
- the gold room-number badges as the thread linking chat, map and key
- the overall layout
- the dashed selection outline (a non-colour cue)
- the always-dark toast
- the print palette for PNG export

---

## (b) Change log

| # | Problem | Change | Before → after |
|---|---|---|---|
| 1 | Cinzel/caps everywhere (1, 9) | Three type roles. **Cinzel** only for names and titles at ≥15px, never tracked caps. **Lora** for reading text. **Source Sans 3** (humanist sans) for all tool UI: buttons, tabs, labels, metadata, numbers, instructions. | Distinct text styles in a Plan render: 34 (25 Cinzel, 9 of them forced uppercase) → 27 (3 Cinzel: wordmark, panel title, room names). Forced uppercase: section eyebrows only (11px/600/.07em, muted). |
| 2 | Italic secondary text (2) | No italics anywhere. Secondary text is roman sans in `--muted`, and read-aloud is roman Lora with a 2px rule. | e.g. room preview Lora italic 12.5 → Sans 13/19; meta Lora italic 11.5 → Sans 12/16; read-aloud Lora italic 13 → Lora 14/22 + rule. |
| 3 | Long-text reading setting (6) | Chat and user messages set in Lora 15/24, composer in Lora 15/23. Room notes set in Lora 14/22 and outdented under the badge (`margin-left:-32px`), so the column grows from ~230px to ~265px (about 38 characters). Paragraph spacing is 10px, and body ink is ≥9.6:1. | Chat 14/22 → 15/24; notes 13/19 → 14/22; read-aloud italic → roman. |
| 4 | Gold dilution (3) | A strict gold rule (see (d)). Headings, labels, borders, icons, dividers, tiers, list markers, version chips and phase chips are no longer gold. The selection bar's "Reference in chat" and the build "Paste guide" launcher become secondary, so each view has one gold primary. | Gold roles: ~20 → 4. |
| 5 | Boxes inside boxes (4) | Separation by surface tone (canvas < pane < raised < hover). Borders kept only on real controls (at 3:1), pane edges, level cards and list dividers. Removed borders from cards, the brief, starters, the getin box, chunk rows, room rows, popover headers and settings headings. Removed rails except the gold "current" rail (selected room, current chunk, active settings tab). | Visible rules on Build: ~40 → ~18. |
| 6 | Glow, grain, gradients (5) | Removed text glow, the grain overlay, the candle wash and gradient buttons. The primary button is flat gold, and its hover is the brighter gold with no lift. The paste-progress diamond became an 8-segment bar. The canvas keeps a faint vignette. | `--glow` 20px gold → none; grain .045 → off. |
| 7 | Bright parchment search in dark | Dark input well with a 3:1 border, the same as every other field. | `#F5E6D3` block → `--field-bg #130F0D` with `--line-strong` border. |
| 8 | Inconsistent shapes (7) | Radii: 3 (small chips, checkboxes, kbd), 4 (controls), 6 (cards, rows), 8 (popovers, panels), 10 (modal, Home hero card), 999 (pills only). Stepper dots and step numbers are circles. Theme and settings buttons are plain icon buttons. | — |
| 9 | Surfaces too close (pane vs canvas) | Re-tiered dark surfaces with even ~6% steps. | dark bg/surface/s2/s3 `#151110/#1A1412/#231B15/#2D2219` → `#110D0B/#1A1512/#221C18/#2D2520`. |
| 10 | Map labels overlapping walls (8) | Room names set in Sans 600 9.5px, sentence case, `letter-spacing:.01em`. Level-link tags use the ink colour instead of gold. Positions are unchanged. | Cinzel 8px caps .12em → Sans 9.5px. |
| 11 | API key clip (8) | `.input` padding 10 → 8, icon gap 8 → 6, `min-width:0`. | 230 > 227 → fits. |
| 12 | Settings footer collision (8) | `.sfoot{gap:16px}`. | 0 → 16px. |
| 13 | Low-contrast bits (8) | Crumbs and separators use `--muted`. `LATER` and the later provider use colour tokens instead of opacity. The kbd chip in the gold Continue button is opaque. Light `--success` darkened. | Every text node now passes 4.5:1 in all 14 state × theme renders (automated check). |
| 14 | Hard cut at the top of the chat thread (8) | 16px fade mask at the top of `.thread`. | — |
| 15 | Status chips loud (3, 1) | Phase, OK, Recommended and Later chips are sentence-case Sans. Phase chips are a neutral pill with a coloured 6px dot (gold = plan, green = built, muted = brief). The markup's uppercase text is lowercased with `::first-letter` capitalised. | Solid gold/green caps blocks → dot pills. |
| 16 | Circled room numbers (④) | Neither Lora nor Source Sans has circled digits, so the browser's fallback picked a heavy CJK glyph. `.n` and `.ordn` are pinned to Segoe UI Symbol (Apple Symbols on Mac) at weight 400. | Blobby fallback → clean thin circled digits. |
| 17 | Selected options (segmented, chips, model row, provider) | One recipe: `--accent-tint` fill + 1px gold ring + ink text 600 (instead of a solid gold gradient). | — |

**Typeface decision for long text.** I kept Lora for conversational prose and room content, because at 14–15px roman with 1.55–1.6 line height it reads comfortably. The evidence from v1 is that the legibility problems came from italic, 11–13px sizes, tracked caps and Cinzel interrupting the text, not from Lora itself. I moved *instructional and UI* text to a humanist sans, Source Sans 3. That covers the paste-guide steps, settings descriptions, metadata, change lists, starter cards and clarifying questions. At 12–14px a sans scans faster than any serif, its tabular figures fit costs and sizes, and it gives the screen a clear split: **serif = the story and the conversation, sans = the tool.** I tried keeping the room notes in Lora in a 265px column and it reads well, so I did not move them to sans.

**Reverted or not adopted after seeing them rendered:**
- Making chunk rows fully borderless with only spacing. It lost row grouping, so hairline dividers between rows were kept.
- A solid cream fill for selected segments. It was too loud with three segmented controls in the Export popover, so the tint and ring recipe was used instead.

---

## (c) Left unchanged on purpose

- **Layout, states, content and markup.** These are settled. The only markup change is the strip label and its links.
- **The palette's character:** warm near-black, parchment light, Oh Sheet gold `#D4A056`, and `#8B5E34`-family brown for gold text in light (now `#86592F` for a little more contrast).
- **Map drawing:** cream ink, hatch, grid, waves, deep-water shape, ember braziers, scarlet trap, red corner markers, the dashed selected-room outline (now 2px, 8/4) and gold room badges. These were already the strongest part of v1.
- **The wordmark and mark** (slab, cream maze, gold route).
- **Gold room-number badges and inline ④ references.** They link chat, map and key, so they keep the gold.
- **The always-dark toast.** On the Build screen it still covers the footnote paragraph, as it does in v1 and skin A. It is a transient overlay, so I left its position alone.
- **The duplicate "Draw the first plan" button** (empty card and status bar). This comes from the spec.
- **The ⚡ glyphs in model tiers** render as colour emoji. They are content, and the user can judge them.
- **The print palette** for PNG export.

---

## (d) Token sheet

### Colour: dark (default)

| Token | Value | Role | Contrast notes |
|---|---|---|---|
| `--bg` | `#110D0B` | canvas, Home, build list ground | |
| `--surface` | `#1A1512` | panes, bars, modal, level cards | |
| `--surface-2` | `#221C18` | raised: cards, brief, popovers, selected room | |
| `--surface-3` | `#2D2520` | hover, chips, user bubble, segment track | |
| `--field-bg` | `#130F0D` | inputs, composer, search | |
| `--line` | `#2F2721` | hairlines between panes, list dividers (decorative) | |
| `--line-strong` | `#807060` | control borders, radios, checkboxes, kbd | 3.5:1 on surface, 3.3:1 on surface-2 |
| `--ink` | `#EFE4D4` | body text, long text | 14.4:1 on surface |
| `--ink-2` | `#CFC2B0` | secondary text, read-aloud | 10.3:1 on surface, 9.6:1 on surface-2 |
| `--muted` | `#A89A87` | meta, labels, placeholders | 6.6:1 on surface, 5.5:1 on surface-3 |
| `--accent` / `--accent-fill` | `#D4A056` | gold (see rule) | 7.7:1 on surface |
| `--accent-bright` | `#E2B46E` | primary hover | |
| `--accent-tint` | `rgba(212,160,86,.14)` | selected-option fill | |
| `--on-accent` | `#1A1412` | text on gold | 7.8:1 |
| `--focus` | `#D4A056` | 2px outline, 2px offset | 7.7:1 |
| `--success` / `--success-tint` | `#7DCB94` / `rgba(125,203,148,.12)` | built, OK, recommended, pasted progress | |
| `--warning` | `#E09A6E` | near limit | |
| `--danger` / `--danger-fill` | `#E59A8F` / `#E5533A` | errors / corner markers | |
| `--info` | `#8DB6DA` | unused | |
| `--toast-bg` / `--toast-ink` / `--toast-line` | `#2D2520` / `#EFE4D4` / `#4A3F35` | toast | |
| `--grid-faint` | `rgba(239,228,212,.035)` | empty-stage grid | |
| `--shadow-pop` | `0 12px 32px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.3)` | popovers, selection bar, empty card | |

### Colour: light

| Token | Value | Contrast notes |
|---|---|---|
| `--bg` | `#EAE1D0` | |
| `--surface` | `#F8F4EC` | |
| `--surface-2` | `#F1EADF` | |
| `--surface-3` | `#E7DECF` | |
| `--field-bg` | `#FFFDF9` | |
| `--line` | `#DDD2C0` | |
| `--line-strong` | `#8C7860` | 3.9:1 on surface, 3.5:1 on surface-2 |
| `--ink` | `#1F1A16` | 15.7:1 |
| `--ink-2` | `#463D35` | 9.7:1, 8.9:1 on surface-2 |
| `--muted` | `#675C50` | 5.9:1, 4.9:1 on surface-3 |
| `--accent` (gold text, strokes, rings) | `#86592F` | 5.5:1 |
| `--accent-fill` / `--accent-bright` | `#D4A056` / `#DDB06A` | fills only, never text |
| `--on-accent` | `#2A211B` | 6.7:1 on gold |
| `--accent-tint` | `rgba(212,160,86,.22)` | |
| `--success` / `--warning` / `--danger` / `--info` | `#285E35` / `#87561A` / `#7C2F2F` / `#2F5F86` | |
| `--toast-bg` / `--toast-ink` | `#2D241F` / `#F3E8D8` | |
| `--grid-faint` | `rgba(70,50,30,.055)` | |
| `--shadow-pop` | `0 12px 32px rgba(60,40,20,.16), 0 2px 6px rgba(60,40,20,.10)` | |

### The gold rule

Gold may appear only as:
1. **Solid gold:**
   - the one primary action per view (Approve plan, Next: copy chunk, Draw the first plan, Continue, New map, Done, Export…)
   - the send button
   - the current stepper dot
   - the selected room's badge, on the map and in the key
2. **Gold tint + 1px gold ring:** the selected option in segmented controls, answer chips, the model list and the provider cards.
3. **Gold 2px line:**
   - the active tab underline
   - the "current" rail on the selected room, the current chunk and the active settings section
   - the composer focus ring
   - focus outlines
4. **Gold ink:**
   - room-number references (map badges, inline ④ in chat and notes)
   - the current paste-progress segment
   - the current chunk on mini maps
   - the mark's route line
   - the model diamond in the composer pill

Gold is never used for headings, section labels, secondary-button borders or icons, dividers, list markers, metadata, version or phase chips, or decorative rules. Ember orange (`--map-light`) and scarlet (`--map-trap`) stay distinct from UI gold on the map.

### Type

| Family | Weights loaded | Role |
|---|---|---|
| Cinzel | 600 | Names and titles only, ≥15px, tracking 0.01–0.04em, never `uppercase` |
| Lora | 400, 500, 600 (roman only) | Reading text: chat, user messages, composer, room notes, read-aloud, Home subtitle and recap, empty-state paragraph |
| Source Sans 3 | 400, 500, 600 | All UI: controls, labels, metadata, numbers (tabular), instructions, map labels |
| Consolas / Cascadia Mono | system | API key only |

| Role | Spec | Used for |
|---|---|---|
| Hero | Cinzel 600 32/40 | Home greeting |
| Page title | Cinzel 600 24–26/32–34 | Continue card title, "No map yet" |
| Panel title | Cinzel 600 18–20/24–28 | Room key, Paste guide, Built from v7, Settings, AI provider |
| Name | Cinzel 600 15–16 | Wordmark (16), room names in key, project card names |
| Project name | Lora 500 15 | title-bar project name |
| Reading L | Lora 400 15/24, paragraph gap 10px | chat messages, user bubble, composer (15/23), empty-state text, Home recap |
| Reading M | Lora 400 14/22 | room notes, read-aloud (`--ink-2`, 2px `--line-strong` left rule, 10px indent) |
| Section heading | Sans 600 15/22 | level names, guide step title, Export PNG title |
| UI body | Sans 400 14/21 | paste steps, settings lead |
| UI | Sans 400–600 13–13.5/20 | card titles, change lists, descriptions, labels, chips, buttons (13), tabs (13.5) |
| UI small | Sans 400–500 12.5/18 | metadata, status bar, hints, previews, small buttons, legend |
| Meta | Sans 400 12/16 | message meta, chunk meta, scale labels |
| Eyebrow | Sans 600 11/16, uppercase, 0.07em, `--muted` (10.5px in the room key) | section labels only: Brief, Read aloud, GM notes, Encounter, Exits, Legend, Model, Effort, Paste order, Recent maps, Continue |
| Badge numerals | Sans 600 10.5–11.5 | room badges, step numbers |
| Circled references | Segoe UI Symbol / Apple Symbols 400, 1.05em, line-height 1 | ④ in text |

Minimum text size is 11px for eyebrows and 12px for everything else, except map labels (9.5px in SVG units, about 10px rendered). There are no italics.

### Spacing, radii, borders

- **Spacing scale:** 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40.
  - Card padding: 12/14.
  - Pane gutters: 12–16.
  - Thread gap: 20.
  - Room-key section gap: 14.
  - Settings row padding: 16.
  - Modal content padding: 22/28.
- **Radii:**
  - 3: kbd, small chips, checkboxes, `L1` chips
  - 4: buttons, inputs, segmented controls, tools, nav items
  - 6: cards, list rows, composer, provider cards, toast
  - 8: popovers, level cards, empty card, project cards
  - 10: modal, Home Continue card
  - 999: pills (tags, chips, phase chips, model pill)
  - circles: badges, stepper dots, step numbers
- **Borders:**
  - 1px `--line` only between panes, inside lists (row dividers), and around level cards, popovers and the modal.
  - 1px `--line-strong` (≥3:1) only on interactive controls: buttons, inputs, search, composer, segmented controls, chips, pills, radios, checkboxes and provider cards.
  - Never on content cards.
  - Rails are 2px, and only in gold, for "current".

### Component recipes

- **Primary button:** flat `--accent-fill`, `--on-accent` text, Sans 600 13 (14.5 for `.lg`), radius 4, height 32/28/40. Hover `--accent-bright`. No shadow, no lift. One per view.
- **Secondary button:** transparent, 1px `--line-strong`, `--ink` text, `--ink-2` icon, Sans 500. Hover `--surface-3` with an `--ink-2` border.
- **Ghost button:** no border, `--ink-2`. Hover `--surface-3` / `--ink`.
- **Selected option:** `--accent-tint` fill, 1px gold ring (inset for segmented controls), `--ink` text 600. Radio on = 5px gold ring.
- **Card (chat update, recap, starter, getin, offset tip, brief):** `--surface-2`, no border, radius 6 (8 for getin), padding 12/14.
- **Level card:** `--surface` on `--bg`, 1px `--line`, radius 8. Header has a bottom hairline. Chunk rows are separated by hairlines. The current chunk has `--accent-tint`, radius 6 and a 2px gold inset rail.
- **List row (room key):** transparent. Hover `--surface-2`. Selected: `--surface-2` with a 2px gold inset rail and a solid gold badge. Expanded sections are outdented to the badge edge.
- **Chips and tags:**
  - Tag: `--surface-3` pill, Sans 12.5, `--ink-2`.
  - Answer chip: 28px pill with a `--line-strong` border.
  - Status chip: sentence case. OK = `--success` text on `--success-tint`. Phase = `--surface-3` pill with a 6px dot (gold for plan, green for built, muted for brief).
- **Inputs, search, composer:** `--field-bg`, 1px `--line-strong`, radius 4 (composer 6). Focus: gold border plus a 3px `--accent-tint` ring.
- **Tabs:** Sans 500 13.5, `--ink-2`. Active is `--ink` 600 with a 2px gold underline. Level chip `L1` is `--surface-3`, Sans 600 11.
- **Stepper:** Sans 500 13. 18px circular dots. Done = `--surface-3`, current = solid gold.
- **Paste progress:** 8 flexible 4px bars, radius 2. Done = `--ink-2`, current = gold, todo = `--surface-3`.
- **Popover:** `--surface-2`, 1px `--line`, radius 8, `--shadow-pop`. Eyebrow headers with no rules. The footer estimate sits on `--surface-3`.
- **Modal:** `--surface`, radius 10, nav on `--surface-2` with no divider line. Scrim is `rgba(8,6,5,.68)` in dark and `rgba(45,36,31,.40)` in light.
- **Toast:** `--toast-bg`, 1px `--toast-line`, radius 6, Sans 13.5, bold lead in `--toast-ink`.
- **Ground:** flat. The canvas has a radial vignette (dark `rgba(0,0,0,.22)`, light `rgba(110,80,40,.07)`). No grain, no glow.

### Map theme

| Token | Dark | Light / print | Drawn as |
|---|---|---|---|
| `--map-paper` | `#120E0B` | `#E4D5BB` | rock under hatch |
| `--map-hatch` | `#2E2316` | `#C2AB86` | 45° hatch |
| `--map-floor` | `#241C16` | `#FBF6EC` | floor |
| `--map-grid` | `#30261C` | `#EADFCB` | 1px grid |
| `--map-ink` | `#EAD9BF` | `#2D241F` | walls, doors, stairs, features, room names, level-link tags |
| `--map-accent` | `#D4A056` | `#86592F` | room-number badges, selection outline |
| `--map-label` | `#1A1412` | `#FFFDF9` | badge and tag fill |
| `--map-sel` | gold 13% | gold 22% | selected room wash |
| `--map-water` | `#6AA6B3` | `#2F6F80` | 24% / 40% fill and waves |
| `--map-forest` | `#8DB87A` | `#4F7A3A` | trees |
| `--map-light` | `#E8893A` | `#B4561C` | braziers |
| `--map-trap` | `#F07A5E` | `#B03A22` | trap triangle with **T** |

Map-specific recipes:
- **Room name:** Sans 600 9.5, sentence case, 0.01em tracking, `--map-ink` at 88% opacity, with a 3.5px floor-coloured halo.
- **Room number:** Sans 600 11.5 in `--map-accent` inside a 10px circle (`--map-label` fill, 1.5px `--map-accent` stroke). Selected = solid gold disc with `--on-accent` numeral.
- **Selection:** `--map-sel` fill with a 2px `--map-accent` dashed stroke (8/4).
- **Level-link tag:** `--map-label` fill, 1px `--map-ink` stroke at 60% opacity, Sans 600 9 text.

Print/PNG keeps the light palette on `svg.print`.

### Verification

Every state (Home, Brief, Plan, Model & effort, Export PNG, Build & paste, Settings) was rendered at 1600×960 in dark and light with headless Chrome, and inner panels were scrolled to their ends. An automated pass composited every visible text node over its real background:
- Every text node is ≥4.5:1, with no exceptions in 14 renders.
- Long-text roles are ≥7:1: chat ink 14.4:1, notes ink 13.4:1 on surface-2, read-aloud 9.6:1 (light: 15.7 / 14.4 / 8.9).
- No element clips its content, including the API key field.
- Control borders and focus indicators are ≥3:1, by token calculation above.

---

## (e) Further changes I would consider (optional, not applied)

Several items from the original "optional" list were applied after the wider brief: the humanist sans for UI, dropping tracked caps, and removing glow and grain. These remain:

1. **Show room-key notes in a wider reading drawer** when a room is opened. The 300px key is a layout decision, so I worked within it. A 360px key, or a "read" mode that widens the selected room to about 420px, would give notes a proper 55–60 character line.
2. **Cut the chat avatar gutter.** Dropping the 24px mark beside every AI message (using a small name line instead) would give chat about 36px more line length.
3. **Make the circled-digit references** (④ in text) real inline badge elements instead of Unicode glyphs, so they match the map badges exactly on every OS.
4. **Replace the ⚡ emoji tiers** with drawn pips so they follow the palette.
5. **Restyle the dark map** with slightly thinner walls (6.5 → 5) and a little less cream (`#EAD9BF` → `#DCCBB0`). The map is currently the brightest thing on screen. It is the main subject, so this is a matter of taste, which is why I left it.
