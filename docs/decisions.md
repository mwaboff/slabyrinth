# Slabyrinth — design decisions (lead's rulings)

This file settles the open questions and cross-document conflicts raised in
`architecture.md` §10–§11 and `ux-design.md` §15. Where it disagrees with another
document, this file wins. Implementers: read this first, then `architecture.md`,
then the section of `ux-design.md` for the screen you are building.

Date: 2026-11-18. Status of each item: **Decided** (build to it) or **Open** (do not
block on it; build so either answer is cheap).

## Document precedence

1. `docs/decisions.md` (this file)
2. `docs/contracts/*.ts` — the type contracts; changes go through the lead
3. `docs/architecture.md` — structure, pipeline, agent design, work packages
4. `docs/ux-design.md` — screens, behaviour, copy, tokens
5. `docs/talespire-slab-format.md`, `docs/talespire-assets.md` — format facts

## Conflicts between documents (architecture §10)

All fourteen resolutions in architecture §10 are **accepted**. The ones that change
what the UX spec says:

| Topic | Decided |
|---|---|
| Map rendering | Canvas 2D, one `drawDisplayList` routine for the live view and PNG export. The UX cartographic vocabulary (§6.2, §11) is unchanged. |
| Asset substitution | Curated fallback chain only: palette `alternates` → role `fallback` → `generic` theme → drop with a warning. No automatic catalog search at build time. The build always succeeds. |
| Chunk alignment markers | Two global corner markers shared by every chunk of a build (so stacked levels align vertically too). Omitted when the whole build is one chunk. The paste-guide copy follows this, not UX §9.4's per-seam wording. The raised second marker still needs an in-game check. |
| Project file | Plain JSON `.slabyrinth` in v1; the reader also accepts gzip. |
| Stopped turns | Streamed text is kept for display only and never sent back to the model. |
| Stamps (future) | Stamp asset in `ProjectFile.stamps`; each placement is a `StampRef` in the plan level, so it is versioned like everything else. |
| "Open in TaleSpire" | "Copy & open TaleSpire": copy the slab, then launch or focus the game. Never implies import. |

## Open questions (architecture §11, UX §15)

| # | Question | Ruling | Status |
|---|---|---|---|
| 1 | Levels stacked or side by side in TaleSpire | Stacked at real heights by default (one storey = 2.5 tiles). A per-export option lays levels side by side. | Decided |
| 2 | Default model | `claude-opus-5-5` at `medium` effort, marked Recommended. `claude-sonnet-5-5` offered as the cheaper option, `claude-fable-5-2` as the most capable, `claude-haiku-5-5` as the fastest. The user changes model and effort per conversation. | Decided |
| 3 | Beta API features on by default | On, each behind its own flag, with automatic disable-and-retry when the API rejects one. The core loop must work with every beta off. | Decided |
| 4 | Spend warnings | $1 for a single action, $10 for a project, both editable in settings. | Decided |
| 5 | Depth of GM notes | Short description plus GM notes per room by default. Read-aloud text and system-specific encounters only when the user asks. | Decided |
| 6 | Public or private repo; code signing | Public GitHub repository (2026-11-18), so GitHub-hosted Actions runners are free. No code signing in v1; document the SmartScreen and AppImage caveats in the README. | Decided |
| 7 | Roofs on town buildings | None in v1. Reserve as a later per-building option. | Decided |
| 8 | Remaining in-game checks | Prop front side, the raised max marker, paste anchor point, water surface height. Covered by the WP3 in-game round trip; all live in data (`orientation.json`, palette facing), never in code. | Open (needs game) |
| 9 | PNG export defaults; launch screen | Print (light) style by default with a dark option, 70 px per square. The app opens on Home with recent maps. | Decided |
| 10 | Repository and landing page | Repository: https://github.com/mwaboff/slabyrinth (public). The landing page is static HTML/CSS in `site/`, deployed to GitHub Pages by `.github/workflows/pages.yml` on pushes to `main` that touch `site/**`; screenshots via `npm run capture:site`. | Decided |
| 11 | macOS | macOS: not supported for now (owner decision 2026-11-18); no Mac build in CI. If revisited: needs signing/notarisation (paid Apple Developer account), Mac TaleSpire install paths, and testing. | Decided |

## Contract rulings during the build

| Date | Request | Ruling |
|---|---|---|
| 2026-11-18 | `PaletteVariant.name` declared twice (scaffold) | Two fields: `name` is the asset display name (diagnostics); `variant` is the key matched against `Feature.variant`. |
| 2026-11-18 | Allow `to.at` to be omitted for `pit_drop` links (WP1) | Accepted. A link's `from` is its LOWER end and `to` its upper end. A pit drop (like a trapdoor) is walked downwards only: from the hole at `to.at` on the upper level you land at `from.at` on the lower level. When `to.at` is omitted, the hole is the cell directly above `from.at` (same x, y). |
| 2026-11-18 | `renumber` order (WP1) | Entry level first (`plan.entryLevel`, else the level nearest elevation 0), then levels above ascending, then levels below descending, so room 1 is where the party starts. Automatic key assignment on creation (max + 1) is unchanged. |
| 2026-11-18 | Bounds the plan contract left unspecified (WP1) | Accepted as chosen in `packages/core/src/plan/schema.ts` (`UNSPECIFIED_LIMITS`: coordinates ±4096, elevation ±64, labels ≤ 60 chars, element notes ≤ 2000 chars, …). |
| 2026-11-18 | Removing an area that a route corridor ends at (WP1) | Rejected with a hint, not cascaded. Accepted. |

| 2026-11-18 | `PaletteRole.variants` may be empty (WP3) | Accepted: "≥ 1, or empty for an alias role that only sets `fallback`". |
| 2026-11-18 | `Realize` options take `orientation?: OrientationCalibration` (WP3) | Accepted. |
| 2026-11-18 | `ChunkOptions.fill` default (WP3) | 0.8 (about 24.5 KB of the 30,720-byte limit), not the 0.9 in the contract comment. |
| 2026-11-18 | `ResolvedFeature.baseHeight` meaning (WP3) | Absolute height: elevation + 0.5 + floor height + lift. `EdgeGrid.height` is wall height above the floor top. |
| 2026-11-18 | Corner posts (WP3) | Only where an outer corner leaves a gap; none at free wall ends. Paste order is lowest level first. |

| 2026-11-18 | `ResolvedFeature.gmOnly?` and `ResolvedOpening.gmOnly?` (WP2) | Accepted, for the player-safe view and PNG export. |
| 2026-11-18 | `ResolvedArea.labelAt?: Vec2` (WP2) | Accepted. |
| 2026-11-18 | `BuildDisplayList` / `HitTest` take an optional third argument `{links?, levelLabels?}` (WP2) | Accepted. |
| 2026-11-18 | Five IPC additions (WP5): `secrets:status.hint`, `secrets:setApiKey.storage`, `project:setUiState`, `compile:run` → `buildId`, `{buildId, chunkId}` on copy calls | Accepted; WP5 applies them to both copies of `ipc.ts`. |

| 2026-11-18 | `SlabChunk.levelIds: LevelId[]` (`levelId` stays the lowest level) and `BuildRecord` chunk `levelIds?` (WP3, WP5) | Accepted. |
| 2026-11-18 | `ChunkOptions.grouping?: "fewest" \| "per-level"`, default `"fewest"` (WP3) | Accepted. |
| 2026-11-18 | `OrientationCalibration.wallFacingFeatures` and `doorHandlePreference` (WP3) | Accepted; add both to the contract. |

| 2026-11-18 | `ToolContext.estimate` may be async and return null (WP4); `EngineHost.moveHead(version)` so Retry is an undo, not a restore version (WP4/WP5) | Accepted. |

All rulings above are written into the contract files and their copies (integration, 2026-11-18). Decided during
integration (marked for the lead's review):

| Date | Request | Ruling |
|---|---|---|
| 2026-11-18 | `ProjectSnapshot` carries no resume state (WP6) | Added `ui: ProjectFile["ui"]` and `pasteGuide: … \| null` to `ProjectSnapshot`, so reopening restores the view. |
| 2026-11-18 | `window:minimize` / `toggleMaximize` / `close` channels for Linux-drawn buttons (WP6) | Rejected: the window keeps the native frame on every OS, so the renderer draws no window buttons. |
| 2026-11-18 | `CompileEstimate.estimatedChunks` was the sum of per-level counts | It is the whole build under the default "fewest" grouping (1 when everything fits); `perLevel` keeps per-level counts. |
| 2026-11-18 | Integration follow-up (lead) | `BuildRecord.settings` records `grouping`, `fill`, `levels`, `tileCells`; no `extraResources` (palettes/orientation are compiled in, overrides in userData); `checkForUpdates` removed (not v1); the scripted e2e provider exists only in test builds (`out-test/`); by-name core detection and the fake engine's model table removed. |
| 2026-11-18 | UI requests (WP6) | Accepted: `dialog:pickFolder` (talespire/projects only), `project:setUiState.pngExport` (+ `ProjectSnapshot.pngExport`, `pngExport.keyPanel?`), `AppSettings.defaultSystem` written into new briefs. |
| 2026-11-18 | Wall between two touching open cave areas cannot be built (WP2/WP3) | No wall is generated on an edge whose generated style is a full-cell rock style (`cave_rock`) when both sides are open; the areas merge but keep their own ids, keys and outlines. An explicit `cave_rock` wall run between two open cells is a `shape_invalid` validation error. Architecture §2.4 updated. |
| 2026-11-18 | End-of-turn issue summary (WP4/WP6) | `turn_finished` and `turn_failed` carry `outstandingIssues?: OutstandingIssues` (`version`, `errors`, `warnings`, up to 20 `items`), set when the turn changed the plan and error-level playability issues remain (warnings are counted and listed alongside). In both copies of `ipc.ts`. |
| 2026-11-18 | Independent review, security (lead) | `baseUrl` cannot be set from the renderer for a provider that uses a stored key (Anthropic always uses the SDK default host). `project:importPlan` / `project:exportPlan` take no path and always use the native dialog. Paths from the renderer (open, duplicate, trash, reveal) are accepted only when main handed them out, and must be absolute, local (no UNC) and `.slabyrinth`. Project files and slab strings are size-capped before and during decompression. Palette and role lookups never touch `Object.prototype`. |
| 2026-11-18 | Retry after the user changed the map (lead, review 2b) | Retry undoes the turn's versions only when the head is still the turn's last version (or the turn made none). Otherwise Retry is refused with a message and nothing changes. Retrying the turn that drew the first plan moves the head back to "no plan" (version 0). |
| 2026-11-18 | One turn at a time (lead, review 2b) | `send` / `retry` / `continue` / answering questions take a lock before their first await; a second call gets `busy`. Effort and model markers are never rendered between a tool call and its result or directly after an assistant message. |
| 2026-11-18 | Playability findings and user edits (lead) | Playability findings never reject a change, whoever makes it: the agent's tools and the user's own edits both apply the change and report the findings. Only structural errors (bad ids, invalid shapes) reject. |
| 2026-11-18 | Same finding from both validation layers (lead) | The plan layer owns it: `verifyBuild` does not emit `verify_door_leads_nowhere` for an opening that already has `opening_dead_end` or `opening_blocked` in the `planIssues` it was given. |
| 2026-11-18 | Vertical links (compiler, review 2a) | A non-stairs link (ladder, spiral stairs) is built as ONE stack of the resolved asset from the lower floor top to the upper floor top. A smaller fallback asset goes into one footprint cell (the first with a wall, else the first) with an info `asset_substituted`. New build-check error `verify_link_short`: a ladder or spiral-stair stack whose top is more than 0.25 below the upper floor top; a vertical link with no pieces at all (unless the role was already reported missing); or a trapdoor with no hatch on the upper floor. `verify_stairwell_closed` now applies to every link kind except trapdoor. Anything at or below the 0.5 step height is not an obstruction in the obstruction and door checks. |
| 2026-11-18 | Estimate and compile share one extent check (compiler, review 2a) | Both use `layoutBuild` / `extentDiagnostic` in `compile/chunk.ts`; estimate reports `coord_overflow` and 0 chunks exactly as compile does. |
| 2026-11-18 | Room/cave wall rule refined (geometry, review 2a) | When both sides demand a wall, a thin wall style beats a full-cell (natural rock) style regardless of area size; between two thin or two full-cell styles the host side's style wins. A wall whose demanding sides all use full-cell styles is not generated between two OPEN cells (the spaces merge). The `cave` golden now has the tunnel's thin wall along the grotto. Architecture §2.4 updated. |
| 2026-11-18 | Stairs arriving against a wall, plan check (geometry, review 2a) | Stairs arriving against an upper-level wall, or with a wall at the foot, give `link_approach_blocked` (error), matching the build check `verify_stairs_arrival_blocked`. |
| 2026-11-18 | Trapdoor and pit drop direction (geometry, review 2a) | Both are walkable downwards only. An area reachable only by climbing up through a trapdoor is `unreachable` (warning). Every link kind needs rise > 0. |
| 2026-11-18 | Entrance and blocked doors (geometry, review 2a) | When no area has a key, the entrance is the first area in plan order (previously every open cell counted, so keyed and unkeyed plans gave different results). A blocker in front of an area's only door is reported once as `opening_blocked` (error), keyed or not. |
| 2026-11-18 | Shapes outside level bounds (geometry, review 2a) | Shapes are evaluated only inside the level bounds plus a one-cell ring. The `bounds_exceeded` warning text is "the cells outside are clipped". Cave shapes and cell masks are not clipped (the schema already limits them). |
| 2026-11-18 | `dress` generator speed (geometry, review 2a) | Builds candidate lists once per area and tries up to 24 seeded random candidates per item (deterministic). Furniture layouts changed: 15 dress goldens, example-a, wp2-dress and the hashes were regenerated. |
| 2026-11-18 | PNG room key overflow (geometry, review 2a) | The key flows into extra columns and the panel widens; no entry is dropped (`keyPanelGeometry` in render-canvas). |
| 2026-11-18 | Retry and client factory (engine, review 2b) | Retry at call time is the real check (`canRetry` stays true at turn end). `ClientFactory` takes only `{ apiKey }`. |
| 2026-11-18 | `project:setUiState` let the renderer send `ui.lastActivityAt`, which main's strict schema rejects (lead) | Main owns that timestamp. The request type is `ui?: Partial<Omit<ProjectFile["ui"], "lastActivityAt">>` in both copies of `ipc.ts`; main's schema stays strict; the renderer's `saveUi` uses the same type. |
| 2026-11-18 | E2E cannot read what Copy put on the clipboard (lead) | In safe mode only (e2e/smoke, where `main/app.ts` builds the memory clipboard) that clipboard is also `globalThis.__slabyrinthClipboard`; specs read `.last` through Playwright's `electronApp.evaluate`. Never set in a normal run. |
| 2026-11-18 | `plan:changed` when the head goes back to 0 (closing pass; approved by the lead) | Main now emits it (previously it emitted nothing, so the renderer kept showing v1 during a Retry of the first draft): `head: 0`, `plan: null`, `version` = the version the head just left. No contract change (the type already allows `plan: null`). |
| 2026-11-18 | Estimate near the slab limit (review 2a `t2`; lead) | Estimate may over-count by one slab when a level is close to the 30,720-byte limit (estimate has no real gzip); accepted as conservative — the UI must word it as an estimate ('about N'). |
| 2026-11-18 | Pinned API host (key-handling audit; lead) | The real `ClientFactory` passes `baseURL: ANTHROPIC_API_BASE_URL` (`https://api.anthropic.com`), `authToken: null`, `logLevel` and `openTelemetry: false` explicitly, and hides `ANTHROPIC_CUSTOM_HEADERS` while the SDK client is constructed, so no environment variable (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`/config, custom headers, log level) can redirect the stored key or change its auth headers. |
| 2026-11-18 | Unreadable stored key (key-handling audit; lead) | `secrets:status` rows gain `unreadable?: true` (both copies of `ipc.ts`) when a stored blob exists but cannot be decrypted (keyring changed or reset); `hasKey` is then false. Setup and Settings show "Your saved key could not be read (the system keyring changed). Enter it again."; storing a new key replaces the blob, clearing removes it. The masked hint is cached in memory only (never written), so `status()` no longer decrypts on every call. |
| 2026-11-18 | `secret.bin` file mode (key-handling audit; lead) | `secret.bin` and its atomic-write temp file are created with mode `0o600` (`SECRET_FILE_MODE`; `writeFileAtomic` gained a `mode` option). No effect on Windows, where the per-user profile ACL applies. |
| 2026-11-18 | Linux without a keyring: say where the key is (key-handling audit; lead) | The UI claims "secure storage" only for backend `os`; `basic_text` says weak protection; `memory_only` says "No system keyring was found, so the key is kept for this session only and you'll need to enter it again next time." (same wording in Setup and Settings). `secrets:setApiKey` and `secrets:status` rows carry `weakAvailable?: true` when a memory-only key could be stored weakly; the "Store anyway (less secure)" button calls the new `secrets:storeWeak { providerId }`, which persists main's in-memory key, so the renderer never re-sends the key (the lead's "re-send with `allow_weak`" would need the key back in the renderer, conflicting with ruling (c)). Both copies of `ipc.ts`. Approved by the lead. |
| 2026-11-18 | Rejected keys are not kept (key-handling audit; lead) | `secrets:setApiKey { verify: true }` stores, checks with the provider and returns `check`; a check failing with kind `auth` removes the key again (memory and `secret.bin`, `stored: false`). Any other failure keeps it and the UI says it could not be checked. The renderer clears the typed key from its state on submit, whatever the outcome. Both copies of `ipc.ts`. |

## Visual theme

**Decided (user, 2026-11-18): Skin B v2** — the refined Oh Sheet-style skin.

- Visual reference: `docs/mockups/app-mockup-ohsheet-v2.html`
- Token sheet (colours, type scale, spacing, radii, borders, gold-usage rule,
  component recipes, map-theme tokens): `docs/ux-theme-ohsheet-v2.md`

For anything visual, `ux-theme-ohsheet-v2.md` wins over `ux-design.md` §11 and over
the other mockups (`app-mockup.html` = skin A and `app-mockup-ohsheet.html` = skin B
v1 are kept for history only). Layout, states, behaviour and copy still come from
`ux-design.md`.

The renderer UI takes every colour, font, radius and shadow from theme tokens (CSS
custom properties); nothing visual is hard-coded in components. Dark is the default
theme; light and "match system" are options. Fonts (Cinzel, Lora, Source Sans 3 —
all SIL Open Font Licence) are bundled with the app through `@fontsource/*`; the app
makes no remote font requests. The default map theme is skin B v2's; the PNG export
keeps a light print palette by default.

## Requirements added by the user during design

All are MVP unless marked later:

- Distributable executables for Windows and Linux, built by GitHub Actions.
- Dark mode by default; light mode available.
- Export the 2D map as PNG.
- Projects autosave and resume mid-conversation (chat, brief, all plan versions, export state).
- Model and effort selection, per conversation.
- The asset library is read from the user's TaleSpire install at startup and refreshed when the game updates. If TaleSpire is not found: a non-blocking warning that the built-in asset set is in use and the latest library is unavailable; generation and export still work.
- Only the small default palettes are bundled and committed. The full catalog is never bundled or committed (`data/talespire-assets.json` is gitignored).
- Playability validation (2026-11-18): every plan gets a deterministic sense check —
  doors that can be walked to and through, all intended rooms reachable on foot,
  stairs with free approaches and landings, furniture that does not block doors or
  corridors or overlap, seats at their tables. The AI runs it on every draft and
  edit, fixes what it finds before presenting the map, and tells the user about
  anything it leaves; the UI lists the remaining issues on the map and at the
  approve step. Prompted by an inaccessible door beside the stairs in a test room.
- Later: LM Studio as a second chat provider (the provider interface exists in v1).
- Later: importing an existing slab as a "stamp".
- Later: an in-game Symbiote that hands slabs to the cursor.

## Export: fewest slabs possible (2026-11-18, from in-game testing)

The three-chunk test build aligned correctly in game, but the user found lining the
chunks up by hand fiddly. So:

- A build is **one slab containing every level** whenever it fits under the fill
  limit (levels stacked at real heights by default; the side-by-side option is also
  one slab). No markers, no checklist: one "Copy & open TaleSpire" button.
- Only when a build does not fit is it split, into as few chunks as possible,
  keeping each level whole before cutting inside a level. Then the alignment markers
  and the numbered paste checklist apply, and a chunk may span several levels.
- This supersedes the per-level slab wording in `ux-design.md` §9 and the "levels
  go bottom-up" paste order for the common case.

## In-game results from pipeline-generated slabs (2026-11-18)

- Single room: floor fully usable, walls outside the floor, corners closed by posts,
  north-door handle at the west end, stairs climbing north, chairs facing the table.
- Two flaws found: nothing fills the wall above a door (door 2.0 tall, wall top at
  3.0), and one stray wall piece on the east side beside the stairs. Both with WP3.
- Prop fronts at rot 0: the default front for every prop is **north (+z)**. Verified
  on the chair, `Bookshelf 01` (open shelves north) and `Red Bed` (foot north,
  headboard south). An earlier reading of "chair front = south" from a screenshot was
  wrong and has been corrected. After the fix (room v4) a
  side-on screenshot shows both chairs with their backrests on the outer sides,
  i.e. facing the table. `Leather Chest` shows no visible latch from any angle and
  is treated as symmetric.
- Doorways: no lintel. The dungeon kit has no doorway/lintel piece and a
  crenellation substitute looked wrong in game; the small notch above a door is
  accepted. A palette may define `lintel.<style>` later.
- One-slab default: the two-level test map pasted correctly as a single slab.
- East/west-edge door handle end is correct by calculation only (not seen in game).
- Three-chunk, two-level build: one SW marker and one raised NE marker visible after
  all pastes, lower-level seam closed, upper room at the right height. The
  identical-bounding-box marker scheme, including the raised marker, is confirmed.
- Still unverified: paste anchor point (corner or centre), water surface height.

## Calibration facts verified in game (2026-11-18)

- +x is compass East, +z is compass North, y is up. A north-up plan maps col → x and row → z = H−1−row with no mirroring.
- Increasing `rot` turns a piece clockwise seen from above.
- Tiles are stored at the min corner of their rotated footprint. A 0.5-deep edge piece therefore sits in the south half of its cell at rot 0/12 and the west half at rot 6/18; a north or east edge needs a +0.5 offset on z or x.
- Props are stored at their centre.
- `Dungeon Stairs` at rot 0 ascend toward −x (west); rot 6 north; rot 12 east; rot 18 south.
- `Door - Dungeon` at rot 0 has its handle at the west end; rot 12 at the east end. Both faces look the same.
- `Dungeon Wall 01` looks the same on both faces.

## Known limitations (2026-11-18)

Not yet verified in game:

- East/west-edge door handle end (correct by calculation only).
- Paste anchor point (slab corner or centre under the cursor).
- Water surface height.
- The pillar alignment markers used for multi-chunk builds (only the earlier gravel
  markers were pasted).
- `Leather Chest` front (no visible latch; treated as symmetric).

Not implemented yet:

- A free-text "other" game system name in the brief (`DesignBrief.system` has no
  free-text field).
- A switcher between retry alternatives; player-safe room-name hiding beyond core's
  GM layer; region select (v1.1).
- Client-side compaction for non-Anthropic providers (only matters for LM Studio).
- Scatter spacing for large props from palette footprint data (a
  `featureClearance(type, theme)` option for `resolvePlan`), so validate, 2D preview
  and compiler agree (v1.1).
- A plan-layer `bounds_exceeded` error when the union of level bounds spans more than
  2617 tiles in x or z; `compile_preview` validating the plan before estimating.
- Estimates near the 30,720-byte slab limit may over-count by one slab (worded
  "about N").
