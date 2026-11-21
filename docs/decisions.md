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
| 12 | Landing page domain | Site URL `https://slabyrinth.aboff.com` (owner, 2026-11-18). DNS: CNAME record `slabyrinth` → `mwaboff.github.io`. Set in Settings → Pages → Custom domain, then "Enforce HTTPS" (an Actions-based Pages deploy ignores a `CNAME` file). Every asset path in `site/` is relative, so the page also works at `https://mwaboff.github.io/slabyrinth/`. | Decided |

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
| 2026-11-18 | Update notice (owner-approved; lead) | A notice with a download link, never a silent install (builds are unsigned). Main's `UpdateService` makes one anonymous GET to `api.github.com/repos/mwaboff/slabyrinth/releases/latest` (pinned https host, same-host redirects only, 8 s timeout, 256 KB cap, zod-validated; headers `Accept` and `User-Agent: Slabyrinth/<version>` only). Startup check: packaged builds, not smoke/e2e, `updates.autoCheck` on (default), at most once per 24 h; "Check for updates" ignores the throttle. Failures are a quiet "couldn't check". Drafts, prereleases and non-semver tags are never offered. The release page URL is built in main from the tag and goes through the `shell:openExternal` allow-list; release notes are untrusted text, sanitized and capped in main (`shared/releaseNotes.ts`) and shown only as an allow-listed Markdown subset (headings, lists, bold, italic, code) built from React text nodes: never rendered as HTML, links are not clickable (their text only), images are never loaded. Contract: `AppSettings.updates { autoCheck, skippedVersion?, lastCheckedAt? }` (both copies of `project.ts`; old settings files get the default), channels `updates:status`, `updates:check { manual }`, `updates:skip { version }`, event `updates:available`, types `UpdateInfo`/`UpdateStatus` (both copies of `ipc.ts`). A map whose `formatVersion` is newer than the app is refused unchanged: "This map was made with a newer version of Slabyrinth. Update to open it." |

| Date | Request | Ruling |
|---|---|---|
| 2026-11-19 | Terrain with real depth (owner report: a "crevice with a deteriorating stone bridge" built as a flat brick room) | **Generator 2** (`GeneratorVersion` 1 or 2; new plans 2, saved maps keep 1 and resolve to the same geometry): an under-layer `height` op sets the height of every cell in its shape and areas inherit it unless they set floorHeight. New plan elements: area kind `bridge` (+ `railing`, `broken`, `crumble`), terrain op `chasm` (points, width, depth, meander, floor, bridges[]), `CELL_FLAG.BRIDGE`, `ResolvedLevel.bridges`, issue codes `no_effect` and `bridge_unanchored`, build code `verify_material_substituted`. Lava is impassable. Cliff bodies use `cliff.<material>`/`cliff.default`, natural ground falls back to `cliff.rock`/`wall.cave_rock`; `ledge.*` half-cell face pieces are not placed yet. Rock-block walls of a cave touching the level bounds stand outside the bounds. Prompt sp-1.2.0, tools-1.1.0. Architecture §2.4, §2.4a, §2.7, §4.3, §5.1. |
| 2026-11-19 | Vertical structure, round 2 (owner: "more depth, literally and figuratively"; must be theme-neutral) | Still **generator 2** (it was never released, so the new rules are folded into it instead of a generator 3; generator-1 maps are untouched). New terrain ops `platform` (tiers, rise, inset, material, topMaterial, stairs), `stairs` (from, to, width), `uneven` (shape, exclude, amount, scale, seed), `outcrop` (shape, height, material); bridge `span` ("arch", "flat", "plank", "natural") and `arch` on areas and chasm bridges; wall style `railing_stone`; `EDGE.STAIR`, `CELL_FLAG.STEPS`, `ResolvedBridge.span`/`piers`; issue code `stairs_invalid`. A bridge whose ends touch different heights is an inclined span. Generator 2 also: areas in a theme whose default wall style is natural rock default to it; scatter/dress skip step cells; rock columns reach down to the level's lowest floor and vary in height; border cells stand on a foundation down to the lowest floor. Everything resolves through palette roles with fallbacks: `cliff.<material>` → `cliff.default` → `cliff.natural` (natural ground) → fill (info note); `step.<material>`/`step.default` for half steps, `link.stairs` for 1-tile steps; `pier.<material>`/`pier.default` → fill; `glow.<material>` / `feature.<material>_glow` on any material. `cliffEdges(level)` exposes cliff anchors for edge dressing. Prompt sp-1.3.0, tools-1.2.0. |
| 2026-11-19 | Structural faults from the in-game v3 proofs (round 3) | Still generator 2. **Water**: TaleSpire water is a board-wide plane (game code: WaterPlane, WaterPlaneHeight, WaterLevel); the only catalog water tiles are `tempWater1x1/2x2` (folder "TempWater", not deprecated, did not render in game: the v3 slab carried 28 of them at the bed height). Water cells now get `bed.<material>` → `bed.default` → `floor.gravel` → the bank's floor (warning), plus an optional `water.<material>` piece; `floor.water_*` is no longer used. `ResolvedLevel.waterLevel` = one surface per level (¼ below the lowest dry bank, ≥ ¼ above the highest bed); warning `water_level` when other dry floor lies below it; `ExportBundle.waterLevels` (tiles above the slab's base), a `verify_water_level` info diagnostic and a line in the paste instructions; a 2D label. **Rift mouths**: walls closing a chasm or pit stand at least one block above the base wall top and are never lowered. **Outcrops**: ragged rim, tapered noisy heights, built as rock columns without a floor tile, recorded in `ResolvedLevel.outcrops`. **Uneven**: half-tile steps, scale 8. **Risers**: fill falls back to the cell's own floor tile. **Variety**: square rock pieces get seeded quarter turns; cave walls vary −1..+3 blocks (verify accepts natural rock walls at least 1.5 above the floor). **Foundation**: `Level.foundation` (default 2 on ground levels). **Raised deck on supports**: a bridge area with floorHeight ≥ 1 above the ground gets corner posts. **Paths**: `connect` (area/feature ids or cells) and `kerb` (`ResolvedLevel.kerbs`, role `kerb.<material>`). Prompt sp-1.5.0, tools-1.3.0. |
| 2026-11-20 | In-game v4 faults (round 4) | Generator 2 only. Paths: `style` "natural" (default for natural ground materials) uses the chasm geometry (meander = jitter, default 0.7) plus a widened disc at each connect point; "straight" keeps the v1 polyline. Kerbs: generator 2 keeps about 40% (value noise), none within 2 cells of a connect point, never both opposite sides of a cell, and they stand on the verge, not on the path. `edge` "ragged" (platform: default on ground levels for natural materials; height: default on ground levels) adds contour noise ±(inset + 1) to the platform's edge distance, relaxed to one tier per step, and drops rim cells of height ops by noise. Water channels default to a tile deep (min 1): half a tile between "bed covered" and "banks flooded"; the surface aims half a tile below the banks; `ExportBundle.waterLevels` gains `min`/`max`; the note describes it visually (the in-game tool is an unnumbered slider). Raised decks are laid before spans, spans climb to a deck's height, and a raised deck is anchored by stairs, level floor or a span that meets it (checked after all bridges). Generated props avoid cells beside decks and flights. Pier pieces never reach below the ground under them. Prompt sp-1.6.0, tools-1.4.0. |
| 2026-11-20 | Buildings, phases 0–1 (owner: "build something like this inn"; every building its own; other kinds of building follow other rules) | New plan element `Level.structures` (generator 2): a **building** (style profile, seed, wings or footprint, storeys with wall courses, roof, openings by face, windows, chimneys, attachments) or an **enclosure** (yard shape, fence, gates, floor). A building's ground storey is resolved as an area of kind building (id = the building's id) with its doors and windows as ordinary openings (`<id>~door0` …), so walkability, playability, 2D, hit-testing and dress work unchanged; walls host outside the footprint; generated dressing keeps out of `ResolvedLevel.reserved` (wall ring, door approaches, chimney, porches). Rules per kind of building are **style profiles** (data, `resolve/structureStyles.ts`: cottage, keep, tower, ruin, modern, desert) with variety **ranges** drawn by the building's seed. Roofs are strategies by `roof.type`: gable, flat, none built; hip, shed, cone, dome accepted and built flat with a `structure_invalid` warning. The build (`compile/structure.ts`) uses palette roles with fallback chains (facade, footing, over_door, window, roof.<kit>.*, chimney, wall_light, porch_post, gate) and tags placements with a paste layer (`Placement.layer`: storey:<n>, roof); `omitLayers` / `--omit-layer roof` builds a see-inside version. Slate roof rotation (rot 0 = eave north), stacking (footing 1 + wall 2, attic deck, roof on the deck, 45° courses one cell in and one up, opposed ridge pair) and the door lantern are verified in game (forest shack test). New issue code `structure_invalid`, `PLAN_LIMITS.structuresPerLevel` 32, DiffKind/NewElement `structure`, `ResolvedStructure`. Prompt sp-1.7.0, tools-1.5.0. Deferred: storeys bound to plan levels (interiors upstairs), stairs between storeys, valleys of multi-wing roofs (approximate), hip/shed/cone/dome strategies, lean-to/balcony/outside stairs, timber trim props, layered export. |
| 2026-11-20 | Round 5: v5 still looked regular in game | Generator 2 only, measured on resolved cells (`test/unit/resolve/shapeMetrics.ts`: longest straight outline, square corners, box fill). Trails: `resolve/trail.ts` (Chaikin-cut waypoints, a snake of alternating seeded offsets every half wavelength, amplitude wander·clamp(L·0.08, 2.2, 4) + width/2, wavelength clamp(L/3, 9, 16), width 0.7–1.3× varying slowly, junction discs one cell wider, pinhole closing; connect anchors are joined directly, no Manhattan corners; trails skip building cells). Organic tiers: `resolve/organic.ts` (opening by a disc of 2, exact distance to the edge, per-tier stretched two-octave noise, outline may wander up to 2 cells outside the shape, nesting and one-tier relaxation); height ops ragged use the same. Rifts: stretched course noise with a second octave, stretched bank noise, ends pinch out, rim cells of chasms 2+ deep become ledges at half depth where a noise field is high. Realize: a step piece taller than its rise is not placed; outcrop columns are all rock (ceil); the 2D water label = paste-note figure above the slab bottom. |
| 2026-11-20 | Round 5 follow-up: straight risers in v6 | `organic.ts` breaks any tier step straighter than 5 cells with seeded spurs (raised, lifted down the slope) or gullies (cut, relaxed up the slope) every 3–4 cells, up to six rounds, after despeckling single cells; measured on resolved heights. Natural-ground stairs look up `link.stairs.<material>` → `link.stairs.natural` → `link.stairs`. Stacked ragged ops over one shape can still line up (not fixed). |
| 2026-11-20 | The judging moved into the product | Design principles are product text (`agent/designPrinciples.ts`, dp-1.1.0, ~700 tokens in the system prompt). The design review (`review/`) measures a resolved plan after every create/edit and reports at most 6 ranked notes, each an observation plus one action in plan terms. It is advice, never an error: taste is not validity, a note may be deliberate (a formal hall is symmetrical), and a hard error would make the model chase numbers instead of the brief; the model is told to revise once and not loop. Later results show only what changed (new in full, still open short, cleared by code). Thresholds are data (`review/thresholds.ts`). Tone is a tag on palette rows (`tone`, `hue`), not computed: a catalog row cannot tell how a piece reads in game, so only tones seen in screenshots are recorded (`review/tones.ts` holds them by uuid until the palette import script carries the field); notes stay silent where tone is unknown. Building wall tone comes from the style profiles (`structureTone`). |
| 2026-11-20 | Cliffs after the reference study | Natural cliff runs are exposed on the resolved level (`ResolvedLevel.cliffs`) and the dressing builds the rock band from them. Where a theme has the band roles, realize lays rock floor under the band and drops face blocks and hidden fill behind it, but only where band rock actually covers the edge: any edge the band leaves bare gets a face block of one rock family, so a hole cannot ship (`verify_cliff_gap` stays as a guard). Natural hills default to 2 terraces 2.5 tiles apart. Open-air natural boards get a ragged outline (`Level.outline`, "rect" to opt out); the low apron that lowered raised ground near the board edge was taken out before the release because it cut routes on plans with a plateau against the edge. Uneven ground keeps half-tile steps (quarter steps read as cracks) but its band outlines are broken and chamfered so they read as banks. |
| 2026-11-20 | Streets: road vs pavement vs crossing was not expressible | A path op in road form (generator 2): `sidewalk {width, material, raise=0.25}` and `crossings` (fractions of the length) imply style straight and ignore jitter. Pavement = the band of width+2·sidewalk around the axis minus every road's carriageway and building lots (footprint and its ring), raised by `raise` (cell heights, so features stand on it), grown up to a lot within three cells. Kerbs: continuous along carriageway/pavement edges (LEDGE edges of ≤ 2 quarters allowed), none on crossings or across junction mouths; `kerb: false` drops them. Straight non-road paths with `kerb` get continuous kerbs too; broken kerbs stay for natural trails. `ResolvedLevel.roads` (axis, width, carriageway, pavement, raise, kerb lines, outer/inner corners, crossings). Realize turns carriageway tiles along the axis, puts `marking.crossing` on crossing cells and an occasional `marking.drain` beside the kerb (optional roles). Materials asphalt, concrete appended. The 0.25 default is a cell height, not tile thickness: floors are top-aligned at height + 0.5, so a 0.5 pavement tile one quarter up has the same bottom as a 0.25 road tile. |
| 2026-11-19 | Stalactites reported as floating (dressing engineer) | Ceiling-mounted features (stalactite, chandelier) are exempt from `verify_prop_floating`. |
| 2026-11-20 | Buildings, phase 2 milestone 1 (owner: other kinds of building follow other rules; real vertical depth) | Still generator 2 (unreleased). **Massing**: `Building.volumes` (id, rect, storeys, storeyHeight, corners, roof, `on` another volume); wings/footprint stay sugar for one volume; `storeyHeight` per building/volume and `height` per storey (1..8, 0.25 steps); storeys up to 12. **Silhouette**: per-storey `inset` 0..2 with `seam` skirt/plain/crenellated (style weights), `corners` chamfer, `plinth` {height, margin, face, rim, approach} with steps to each door. **Roofs**: `roof.layers` stacked bottom first; built strategies gable, hip, shed (`low`), flat (parapet, now run-based), skirt, stepped (`courses`), spire (cone alias; taper 0.5 per 2-tile course, flared bands, lid, finial); dome/vault warn and build flat. **Furniture and light** from the style (`roofFurniture`, `lighting` override): dormers only where a kit has `roof.<kit>.dormer`, clutter field and mast (palette `parts`) on flat tops, finial, lit windows (warm or glow), door lights, entrance strips. Styles `wizard_tower`, `modern_block`; tower now builds its cone as a spire; keep gets crenellated seams, cottage warm lit windows. Phase-2 draws use a separate seeded stream (`subSeed(seed,"structure2")`), so phase-1 buildings resolve identically. New palette roles (batch "structures"): facade/facade_post/over_door/window.brick, window.stone, 1-wide window.wood, roof.city.flat, roof.slate.corner (UNVERIFIED rotation), crenel.stone, finial.default, light.glow, light.window(.brick), light.strip, roof_clutter.edge/equipment/storage, mast.default; centre-origin props carry a palette y offset so they stand on their surface. Prompt sp-1.8.0, tools-1.6.0. Deferred to milestone 2: turrets, oriels, jetties, facade bay grid, exterior stairs, vault, frontage, fine rotation, layered export. |
| 2026-11-20 | Generator 3 opened after the 0.1.2 release | Generator 2, sp-1.11.0, dp-1.1.0 and tools-1.7.0 are released and frozen. `GENERATOR_VERSION` is 3 (new maps from the agent tools; saved plans keep their number); `GeneratorVersion` is 1 | 2 | 3 and the schema accepts all three. Gate new behaviour with `generatorAtLeast(plan, 3)` (`plan/generator.ts`); existing `>= 2` rules stay on for 3, and until something is gated generator 3 equals 2. Generator 2 is pinned by `test/golden/generator2` (never regenerate; put changes behind generator 3). Working versions: sp-1.12.0, dp-1.2.0 (`designPrinciples.ts`), tools-1.8.0; released texts live in `designPrinciples.frozen.ts` and `tools.frozen.ts`, and a conversation on tools-1.7.0 is served the frozen list. |
| 2026-11-20 | Generator 3 released in 0.2.0 and frozen | Generator 3 (rock-faced cliffs in clusters, cave walls as solid rock, wandering rifts and stepped rivers, building growth levels and ruin rules, trade shop fronts, market stalls, overhead lines, floor openings between levels, many new review notes), sp-1.12.0, dp-1.2.0 and tools-1.8.0 are released and frozen. It is pinned like generator 2: `test/golden/generator3` (resolved hash, canonical form, slabs and diagnostics of 19 plans, never regenerate), `test/fixtures/released-palettes-0.2.0.json` (first-choice piece per theme and role as generator 3 sees the palettes, checked in `palette/released.test.ts`), hash pins for sp-1.12.0 / dp-1.2.0 / tools-1.8.0 in `agent/tools.test.ts`, and frozen copies `DP_1_2_0` (`designPrinciples.frozen.ts`) and `TOOLS_1_8_0` (`tools.frozen.v1_8_0.ts`); `systemPromptFor("sp-1.12.0")` builds from the frozen principles text and a conversation on tools-1.8.0 is served the frozen list. Maps from earlier versions rebuild unchanged. Generator 4 is not open: the next engine change must first add generator 4 (`GENERATOR_VERSIONS`, the new-map default), open sp-1.13.0 / dp-1.3.0 / tools-1.9.0 and gate its rules with `generatorAtLeast(plan, 4)`; new palette roles then carry `minGenerator: 4`. Plans used by tests live in `test/fixtures/plans`, not in git-ignored folders. |
| 2026-11-20 | One profile per generator instead of version checks | `generatorAtLeast` and every `generator >= N` check are gone. `plan/generator.ts` holds `GENERATOR_PROFILES`: one entry per generator, built from the previous one, with a named switch (and its one-line comment) for each behaviour that generator turned on, plus tunings (`openingOutline`) and its plan vocabulary (`VOCABULARY_SINCE` is derived from it). Code reads `generatorProfile(plan).coveredStalls` (or `gridProfile(grid)` in the placers), never a number. The table is the changelog of the generators; released entries are pinned by name in `test/unit/plan/generatorProfile.test.ts`. Opening generator 5 means adding the version and one entry. Palette roles keep their numeric `minGenerator` (palette data names a version, not a switch); a test keeps the vocabulary's roles in step with the profile. |
| 2026-11-21 | Per-placement facts were module-level WeakMaps (`placementBoxes`, `placementMeta` in `compile/realize.ts`), global state that tests wrote into | Owner: make them per call. `PlacementSet.placed?: Map<Placement, PlacedAsset>` (`name`, `geom`, `box`) belongs to the set realize returns (`RealizedSet.placed` is always present). A set never crosses IPC, is never stored and never hashed (the `ExportBundle` is), so the map need not serialise; absent or missing entries read as the placement's point and uuid (`compile/placed.ts placedBox` / `placedName`). Verify moves a nudged prop's box in it. Output unchanged. |
| 2026-11-21 | `tools.ts` and `provider.ts` copies had drifted from `docs/contracts` and the contract test skipped them | Owner: the code is the truth. `provider.ts` gains `ModelInfo.createdAt` and the corrected guidance comment. `docs/contracts/tools.ts` holds only the interface (tool types, `ToolName`, inputs, outcomes, `ToolContext`/`ExecuteTool`) and is copied verbatim into `packages/core/src/agent/toolContract.ts`; the model-facing definitions (`TOOL_DEFINITIONS`, versioned and hash-pinned) stay code in `agent/tools.ts`, which re-exports the contract. The contract test has no exception list. |

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
