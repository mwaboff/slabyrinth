# Slabyrinth: Technical Architecture

Status: design, 2026-11-18. Owner: architect. Audience: the engineers building the work packages in §8.

The normative types are in `docs/contracts/*.ts`. Copy them verbatim, as the WP table in §8 says. This document explains them and gives the rules they cannot express. If prose and a contract disagree, the contract wins; report the disagreement to the architect.

| Contract | Contents |
|---|---|
| `plan.ts` | Map plan IR `slabyrinth/plan@1`, catalogs (materials, features…), limits, build constants, design brief, reserved stamps |
| `ops.ts` | Edit operations (one language for model, UI, CLI), apply result, version history, diff |
| `resolved.ts` | Resolved geometry (single source of truth for 2D and compile), display list, drawing routine, PNG export, hit-testing, selection |
| `compiler.ts` | Asset catalog (optional), palettes, orientation calibration, placements, slab codec seam, chunks, export bundle, diagnostics, reserved stamps |
| `tools.ts` | Agent tools: provider-neutral definitions with JSON Schemas, input and outcome types, executor context |
| `provider.ts` | `ChatProvider` abstraction, model descriptor (capabilities, effort), neutral transcript, usage/cost, error taxonomy |
| `ipc.ts` | Electron IPC channels, events, preload API |
| `project.ts` | `.slabyrinth` project file, conversation persistence, build records, app settings |

The contracts pass a syntax check (Node type stripping). Nobody has run `tsc` on them yet, so the first task of WP1 is to run `tsc --noEmit` on them and report any fixes to the architect.

---

## 0. Decisions at a glance

| Topic | Decision |
|---|---|
| IR shape | **Hybrid.** The author writes high-level primitives: areas with shapes (rect, polygon, blob, cave, route…), openings on edges, terrain ops (paint, path, noise, scatter, dress), and semantic features. A deterministic resolver expands them into a per-level cell and edge grid. The model never writes raw grids, except an optional ≤64×64 `cells` mask. |
| Walls | Live on **edges** between cells. They are generated automatically from area boundaries using the wall-mode rule. A resolver-chosen **host cell** carries the 0.5-deep TaleSpire wall strip, so the 2D view shows the real usable floor. Explicit wall runs handle partitions and ruins. |
| Model edits | `create_plan` once; after that, a transactional batch of id-addressed ops via `edit_plan`. Every rejection returns structured, hinted errors and leaves the plan unchanged. |
| Model's view of the plan | Append-only. Tool results carry a change report plus an ASCII view of the changed region. `view_plan` returns an outline, ASCII, or JSON on demand. `view_map_image` returns a PNG on demand (not by default). When the plan or brief changed out of band, an app context message carries the diff and a fresh outline. |
| Agent loop | Manual streaming loop in the main process (`ConversationEngine`). It is provider-neutral and talks to a `ChatProvider`. v1 has one provider, Anthropic, using `@anthropic-ai/sdk`. |
| Anthropic specifics (adapter only) | Adaptive thinking (`display: "summarized"`); `output_config.effort`; `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`); `eager_input_streaming` on all client tools; frozen tools and system; 1 h breakpoint on the system prompt plus automatic 5 m tail caching; server-side compaction (beta); `drop_block` thinking binding (beta); refusal handling. |
| Model / effort | `{providerId, modelId, effort}` per conversation, chosen per message, persisted per project. A capability descriptor comes from the Models API merged with a bundled table. Changes take effect at turn boundaries only and are appended to the transcript as markers. There are no per-phase model presets. Smart effort works only through per-message effort. |
| Compiler | validate → resolve → realize(palettes, orientation) → chunk (k-d split, measured by real gzip) → encode (v2, BigInt u64) → export bundle. Two global corner markers give every chunk the same bounding box. |
| Assets | The compiler depends **only on palettes**. Palettes are committed, about 125 assets, and carry geometry. The full catalog comes from the user's install at runtime and is optional enrichment; it is never committed or bundled. |
| 2D rendering | One Canvas 2D routine `drawDisplayList` serves both the interactive view and PNG export (OffscreenCanvas). Colours come from map-theme tokens. Hit-testing is pure. |
| App | Electron with sandboxed renderer; strict CSP; zod-validated IPC; key in `safeStorage`; projects are autosaved `.slabyrinth` JSON files written via temp file and rename. |
| Repo | npm workspaces: `packages/core` (pure TS plus CLI), `packages/render-canvas`, `apps/desktop` (electron-vite). Vitest. GitHub Actions matrix (windows-latest, ubuntu-latest); a `v*` tag produces a Release with NSIS, portable, and AppImage builds. |

---

## 1. System overview

```
┌──────────────────────────── Electron main (Node) ─────────────────────────────┐
│ ConversationEngine ──► ProviderRegistry ──► AnthropicProvider (@anthropic-ai/sdk)
│        │  (turn loop, tools, versions, persistence, cost)    [LM Studio: future]
│        ▼                                                                       │
│ @slabyrinth/core: plan/ops/history ─ resolve ─ text views ─ agent tools/prompt │
│                   compile (worker_thread) ─ slab codec ─ palettes ─ catalog    │
│ ProjectService (autosave, migrate) · SettingsStore · SecretStore(safeStorage)  │
│ CatalogService (locate TaleSpire, fingerprint, scan) · TaleSpireService        │
│ ClipboardService · ExportService (dialogs) · ImageBridge · Logger              │
└───────────────▲──────────────────────────────────────────────┬───────────────┘
   invoke (zod-validated)                                events (webContents.send)
┌───────────────┴─────────────── preload (contextBridge: window.slabyrinth) ─────┐
└───────────────▲──────────────────────────────────────────────┬───────────────┘
┌───────────────┴─────────────── renderer (React, sandboxed) ───▼───────────────┐
│ Zustand stores ─ Chat / Map / Room key / History / Build / Settings / Setup    │
│ resolve.worker (core resolve + buildDisplayList) ─ render-canvas drawDisplayList│
│ PNG export (OffscreenCanvas) ─ pure hit-testing                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

Core is pure TypeScript. It has no Electron, DOM, or `node:*` imports outside `src/cli/`. The CLI (`slabyrinth validate|ascii|compile|decode|encode|catalog|agent-eval`) is the seam for a future Claude Code plugin.

---

## 2. Map plan IR (`docs/contracts/plan.ts`)

### 2.1 Trade-offs and choice

| Option | For | Against |
|---|---|---|
| Raw cell grid (per-cell material, wall flags) | Trivially renders and compiles; unambiguous | LLMs are poor at emitting large grids: a 40×30 grid is about 1,200 values per level, and token cost and errors explode. Edits like "make room 4 bigger" become grid surgery. No semantics (rooms, notes). |
| Pure primitives (rooms, polygons) | Compact, semantic, LLM-friendly | Organic outdoor and cave terrain is awkward; must still define precise rasterization |
| **Hybrid (chosen)** | Semantic primitives the model edits by id. Generators (cave CA, blob, noise, scatter, dress, route) express organic content in a few tokens. Everything is resolved deterministically to a grid that both consumers share. | Needs exact rasterization and generator specs (§2.4–2.7) and versioned generators |

### 2.2 Coordinates and units

- One cell is one tile (5 ft). There is one **global** integer grid for all levels: x runs east, y runs south. Each level has `bounds` (≤320×320, and all levels together ≤ 204,800 cells: `PLAN_LIMITS`) inside it, so stairs line up by construction.
- A cell `(x,y)` covers `[x,x+1)×[y,y+1)`. A vertex `(x,y)` is the top-left corner of that cell. Polygons and wall runs use vertices; everything else uses cells.
- Heights are in tiles, in multiples of 0.25. `level.elevation` is the **bottom** of that level's floor tiles. The walkable top is `elevation + 0.5` (`BUILD_CONSTANTS`). Stack storeys at 2.5.
- Mapping to TaleSpire is **confirmed in game**: +x = East and +z = North, so world `x = col`, `z = (Hglobal − 1 − row)`, with no mirroring. Increasing `rot` turns clockwise seen from above. Both facts stay as data in the orientation table (§4.4).

### 2.3 Elements

- **Level.** It has: `bounds`; `base` (`solid` rock for dungeons, `void` for upper tower floors, `ground{material}` for outdoors); `theme`; `wallHeight`; ordered `areas`; `openings`; `walls` (runs); `features`; `terrain`; `labels`; and the reserved `stamps`.
- **Area.** It has: `kind` (room, corridor, cave, building, courtyard, zone, bridge); `shape`; and optional `floor`, `floorHeight`, `walls` mode, `wallStyle`, `wallHeight`, `theme`, `key`, `labelAt`, `notes`, `readAloud`, `encounter`, `tags`, and for bridges `railing`, `broken`, `crumble` (§2.4a).
  - `key` is unique across the plan. For room, cave, building and courtyard areas added without a key, `applyOps` assigns the next free integer. Numbering therefore continues across levels and stays stable (UX §6.2). The explicit op `renumber` compacts it.
- **Opening.** It has `kind` and either `between [a,b|"@outside"]` (preferred) or `at {x,y,side}`, plus `width` 1–3 and `gmOnly`.
- **WallRun.** Its `op` is add or remove, with vertex `points` (axis-aligned) and an optional style.
- **Feature.** It has: `type` from the closed `FEATURE_TYPES`; `at`; `rot` (0 means the front faces south); `size`; `wall` side for wall-mounted dressing; `lift`; `variant`; `hint` (required for `custom`); `gmOnly`.
- **TerrainOp.** One of: `paint`, `height`, `noise`, `path` (each with `layer` under or over), `scatter` (shape, exclude, density, minSpacing, avoid), `dress` (area, preset), or `chasm` (points, width, depth, meander, floor, bridges; always applied with the over layer, §2.4a).
- **LevelLink.** It has: `kind`; `from {level, at}` (the lower end); `to {level, at?}`; `dir` (the direction of ascent); `width`. One object spans both levels; the UX's `pairedLinkId` is unnecessary.
- **Label.** 2D-only text.
- **MapPlan.** It has `title`, `kind`, `seed`, `theme`, `levels` (1–8), `links`, `entryLevel`, and `notes`. The UX's `elevationIndex` is derived by sorting on elevation, with `entryLevel` as index 0.

### 2.4 Resolution: walls, edges, host cells

**Resolution order per level** (core `resolveLevel`). This order is normative; golden tests pin it.

1. **Base.** `solid` gives SOLID cells. `void` gives VOID. `ground` gives OPEN cells with that material at height 0.
2. **Terrain ops with `layer: "under"`, in array order.** `paint`, `noise` and `path` affect OPEN cells only (they never open rock). `path` sets `CELL_FLAG.PATH`; water materials set `WATER`. `height`: generator 1 changes OPEN cells only (on a solid base: none); **generator 2 sets the height field of every cell in its shape**, rock included, and areas that later open those cells keep it unless they set `floorHeight` (claiming never resets height).
3. **Areas in array order** (painter's algorithm, later wins). Each area:
   - rasterizes its shape (rule below);
   - claims those cells (makes them OPEN and sets area, theme, and material — `floor`, or the theme default for its kind; a `zone` keeps the underlying material);
   - sets height if `floorHeight` is present;
   - `floor:"none"` sets `NO_FLOOR`.

   A `route` area claims only cells no other area owns, and it is processed **after** all non-route areas regardless of its position in the list.
4. **Terrain ops with `layer: "over"`, in array order**, including `chasm` ops; then the **bridge pass** (§2.4a).
5. **Edges** (`hEdges`, `vEdges`). For each edge between cells A and B:
   - **Region.** A cell's region is its area, or `@ground` for OPEN cells without an area (outdoor base). Non-open cells have no region.
   - **Wall test.**
     - A WALL exists if exactly one side is OPEN and that side's mode is `auto` or `perimeter`. The `@ground` mode is `none`.
     - A WALL also exists if both sides are OPEN, the regions differ, and at least one side's mode is `auto`.
   - **Defaults.** Mode defaults are room, corridor, cave, and building = `auto`; courtyard = `perimeter`; zone = `none`.
   - **Zones.** A zone is transparent: an edge involving a zone cell uses the region beneath the zone. The resolver tracks the "structural owner" (the last non-zone area) separately from the "display owner".
   - **Height and style.** Wall height is `area.wallHeight ?? level.wallHeight ?? 2`. The wall style comes from the demanding side's `wallStyle`, or the theme default; `cave` defaults to `cave_rock`.
   - **Full-cell rock walls.** Natural-rock wall styles (`cave_rock`) are built as whole-cell blocks; no thin piece exists. When both sides demand a wall, a thin wall style beats a full-cell (natural rock) style regardless of area size; between two thin or two full-cell styles the host side's style wins. A wall whose demanding sides all use full-cell styles is not generated between two OPEN cells (the spaces merge): the edge stays open, so natural cave spaces that touch simply merge. Each cell still records its own area, so hit-testing, room numbers, the room key and area outlines are unchanged. An explicit wall run with a full-cell style between two open cells is kept, but validation reports `shape_invalid` (error) with the hint "leave a solid (unclaimed) cell between the two areas, or use another wall style such as stone".
   - **Bridge decks** never get area walls toward open cells; after the edges, every intact deck edge facing an open cell more than 0.5 lower (or floorless) becomes a WALL in the bridge's railing style, height 1, hosted on the deck.
   - **Ledge.** If no wall exists and both sides are OPEN with heights differing by at least 0.25, the edge is a LEDGE whose `height` is the difference.
   - **Wall runs** are applied in order: add creates WALL (style and height from the run), remove clears WALL to NONE.
6. **Openings.**
   - *`between [a,b]`*:
     1. Collect the edges where structural owners are a and b (`@outside` = any cell without an area, OPEN or not).
     2. Group the collected edges into maximal straight runs.
     3. Pick the longest run; ties go to the smallest start y, then x, then horizontal before vertical.
     4. Place the opening centred at `position` (default 0.5) along that run.

     Two areas with no shared edge cause `opening_no_boundary`, and the hint lists the nearest edges.
   - *`at`*: the `side` edge of the cell.
   - *Effect*: the opening sets `width` consecutive edges to OPENING. If there was no wall, the opening still exists (no info message). `open` removes the wall and leaves NONE plus an opening record, so it can be drawn as a gap.
   - *Route auto-openings*: a route adds an opening of its `openings` kind (default `open`) at the first edge where it meets each endpoint area.
7. **Links.** See §2.6.
8. **Explicit features.**
   - Each footprint must lie on OPEN cells with floor, must not cross a WALL edge inside the footprint, and must not overlap another blocking feature or a link. Otherwise the result is `feature_blocked`.
   - Non-blocking types (rug, web, bones, flowers, tall_grass, debris) may overlap.
   - A wall-mounted feature needs a WALL or OPENING edge on its `wall` side.
9. **Generated features.**
   - `dress` ops run first, then `scatter` ops, in array order. Ids are `<opId>#<n>`.
   - They are placed only on eligible cells (OPEN with floor, not occupied, honouring `avoid`). Rejected candidates are dropped silently.
   - The level cap is 6,000.
10. **Derived data.**
    - **Area anchor**: the area's OPEN cell nearest the bbox centre, by squared distance; ties go to smallest y, then x.
    - **Outlines**: marching squares on the area mask in vertex coordinates.
    - **Host cell for each WALL or OPENING edge** (`EdgeGrid.host`). The first rule that matches wins:
      1. Exactly one side is non-OPEN: that side hosts. Exterior walls take rock, not floor.
      2. Exactly one side has no area: that side hosts. Outdoor buildings keep full interiors.
      3. Otherwise the side whose area has more cells hosts. A 1-wide corridor never loses half its width.
      4. On a tie, the second cell (south or east) hosts.

      Explicit wall runs host on the second cell. The renderer draws the wall in the host half; the compiler places the strip there.

**No silent no-ops (2026-11-19).** Every element that changes nothing is reported as warning `no_effect` with the cause and the fix: paint/noise/path/height ops that touch no open cell (or, for the under layer, whose every cell is later re-floored by an area, or re-heighted by an area with floorHeight), a chasm that cuts nothing, zone `floor`/`floorHeight`/`walls`/`wallStyle`/`wallHeight`, `wallStyle`/`wallHeight` with walls "none", bridge fields on other kinds, broken cells outside the bridge, wall-run removals that remove nothing, scatter/dress that place nothing. A door or arch placed by `between` on an edge with no wall is `opening_no_boundary` (warning).

### 2.4a Chasms and bridges

- **Chasm op** (`resolve/chasm.ts`, arithmetic and value noise only): the polyline of cell centres is resampled every 0.5 cells; the course wanders sideways by (n(s/9) − ½)·2·meander·max(2.5, 1.2·width); each bank wanders on its own (half-width·(1 + 0.8·meander·(n(s/3) − ½)·2), at least 0.5); cells within ½ along and inside both banks of a sample are cut, plus one closing pass. Only OPEN cells are cut: height −= depth (clamped at −4), `floor` paints the bottom (`none` = NO_FLOOR).
- **Chasm bridges**: at fraction `at` of the course, square across it (N–S where the course runs mostly E–W, else E–W), `width` rows, each row extended both ways over that op's cut cells. Id `<chasmId>~b<n>`; default floor flagstone, railing low_wall.
- **Bridge pass** (after the over layer, before the edges): areas of kind `bridge` (area order; their claim keeps what lies under them), then chasm bridges. Deck height = floorHeight, or the highest floor 4-adjacent to the deck. `ResolvedLevel.bridges` records per cell the height and material beneath (null material = bottomless). Deck cells get the deck height, the deck material and `CELL_FLAG.BRIDGE`. `broken` cells and `crumble` (seeded; outer cells first; a removal is undone if the deck cells next to walkable floor would stop connecting) become NO_FLOOR deck cells. A deck touching walkable floor at fewer than two separate places is `bridge_unanchored` (warning).
- **Lava** is never walkable (not even for the "swimmable" reachability flood). Generator 2 keeps scatter/dress off lava and off decks.

### 2.4b Structure ops (generator 2, theme-neutral)

All run with the over layer in array order and change open floor only.
- **platform**: tier t of a cell = min(tiers, ⌊(d − 1)/inset⌋ + 1), d = 4-distance from the shape's edge (the level bounds do not count as an edge, so a plateau against the map edge stays high); height += t·rise; `material`, `topMaterial` on the top tier. `stairs` sides get a 2-wide flight through the middle of that side to the top tier (stair edges). Rise over 1 per tier with stairs is `stairs_invalid`.
- **stairs**: from/to on one row or column; the cells between take evenly stepped heights between the ends' heights (opened if they were not); each edge on the way with a height change becomes `EDGE.STAIR` (walkable at any height; `CELL_FLAG.STEPS` on the lower cell). Over 1 tile per cell is `stairs_invalid`.
- **uneven**: seeded value noise (scale) × amount, tapered to 0 over 3 cells at the region's edge, then relaxed so region neighbours differ by at most 0.5; skips water, decks and floorless cells.
- **outcrop**: height += height (default 2), material (default rock): a rock mass with cliff sides in any setting.
- **Bridges**: span defaults by deck material (wood → plank, natural ground → natural, else arch). Equal ends: arch profile archQ·(1 − (2t − 1)²) (arch 0.75, natural 0.25, plank −0.25 sag, flat 0), limited to 0.5 steps; arch/flat spans of 5+ cells get piers at ⅓ and ⅔. Ends at different heights (no floorHeight): an inclined span climbing evenly between them, with stair edges where a step exceeds 0.5. Railing default by span (railing_stone, railing, none); crumble also breaks the parapet and puts rubble beyond the ends. Anchored = walkable floor beyond both ends along the span.

**Round 3 (2026-11-19).** Water is TaleSpire's board-wide water plane: the resolver records one `waterLevel` per level and warns (`water_level`) when dry walkable floor lies below it; the compiler floors water cells with `bed.*` and reports the level to set above the slab's base (`ExportBundle.waterLevels`, `verify_water_level`, paste instructions, a 2D label). Outcrops: rim cells drop out where noise < 0.35, height = rise·min(1, (d + ½)/2½) ± ½ in half tiles; recorded in `ResolvedLevel.outcrops` and built as rock columns. Paths: `connect` resolves area anchors (or the area's shape before areas claim cells), feature cells and cells, joined with L legs; `kerb` records `ResolvedLevel.kerbs` (path edges meeting other floor within ¼). A bridge area with an explicit floorHeight at least 1 above the ground beneath gets corner posts (raised platform on supports).

**Rasterization rule.** A cell is inside a shape if its centre `(x+0.5, y+0.5)` is inside.
- polygon: even-odd test.
- circle: `dx²+dy² ≤ r²`.
- ellipse: `(dx/rx)²+(dy/ry)² ≤ 1`.
- path: the union of axis-aligned rectangles of `width` cells centred on the segment, with the extra cell going east or south for even widths.
- route: an L path from anchor to anchor in `bend` order.
- Result cells are clipped to level bounds; clipping is a warning. The mask is optionally 4-connected, as noted per shape.

### 2.4c Structures (buildings and yards, generator 2)

`Level.structures` holds buildings and enclosures. Resolution (`resolve/structure.ts`, hooks in `level.ts` only):
- **Expansion** (`ResolveGrid` constructor, resolve/level/grid.ts): an enclosure becomes a yard area (courtyard with its floor, or a zone) plus fence wall runs on its outline (skipping edges a building's own wall takes) and "open" gate openings; a building becomes an area of kind building (id = building id, wall style and height from its ground storey), its door/window openings (`at` edges chosen by face and position on the face's longest run) and porch areas. Synthetic elements come after the plan's own, so plan indices never move; issue paths and ids pointing at them are remapped to `/levels/i/structures/k`.
- **Style profiles** (`structureStyles.ts`, data): walls, upper walls, footing course, wall height, floor, roof (type, kit, deck, parapet, broken), window width, door light, and variety ranges (window densities, porch and chimney chances, door position) drawn with `elementSeed(plan.seed, id, seed)`.
- **Pad**: after the areas and again after the over-layer terrain, the footprint, its wall ring and porches are flattened to the median ground height under the footprint.
- **After the openings**: shell and fence edges host outside the footprint/yard; chimney and door-light cells get `CELL_FLAG.FEATURE`; `ResolvedLevel.reserved` (wall ring, door approaches, chimney, porch and its ring) is kept free by scatter and dress (`placeable`).
- **Output**: `ResolvedLevel.structures` (`ResolvedStructure`: cells, wings with ridge, storeys with floor top and courses, roof, opening ids, upper openings, chimneys, porches, lights, fence).

Build (`compile/structure.ts`, called by realize; realize leaves shell edges and structure openings to it): wall courses per edge (footing from the ground outside up to its height, then the main course; length-2 pieces along runs), doors and windows by role chain with filler above shorter doors, corner posts, upper floors, attic deck, roof (`resolve/roof.ts`: 45°, run-2 pieces at every course, opposed one-cell ridge pair, flat cap on odd spans, single-width pieces in the gable columns, chimney holes), gable fill up to each course's underside, chimney breast past the ridge, porch roof below the eave on posts, wall lights. Placements carry `layer` ("storey:<n>", "roof"); `RealizeOptions.omitLayers` drops layers. The 2D display list adds a roof plan (outline dashed, ridge solid, chimney, porch roof) in the `area_outline` layer.

Phase 2 (massing and silhouette, 2026-11-20):
- **Volumes**: `Building.volumes` (boxes with own storeys, `storeyHeight`, roof, `on` another volume); `wings`/`footprint` stay sugar for one volume "main". The ground volumes' union is the building area. Heights: wall top = floor top + footing + wall height; the next floor top = wall top + 0.5; a volume `on` X starts at X's roof top. Phase-2 draws (set-ins, seams, wall heights, plinth, furniture, lights) use a second seeded stream so phase-1 buildings resolve identically.
- **Silhouette**: per-storey `inset` (0..2) with a `seam` (skirt roof ring, plain ledge, crenellated ledge; style weights), `corners: "chamfer"` (corner cells of each storey rect cut), `plinth` (base dilated by its margin, raised by terrain paint/height, face material, optional rim wall runs, `stairs` ops from each door out to the base edge).
- **Roof layers** (`resolve/roof.ts`, pure, one function each): `gableRoof`, `hipRoof`, `shedRoof`, `ringLayer` (skirt or stepped rings round a flat inner top), `spireShell` (courses tapering 0.5 per 2 tiles, flared bands, finial point). `roof.layers` stack bottom first on the inner top the previous layer leaves; unbuilt types (dome, vault) warn and build flat; cone is an alias of spire.
- **Build**: per volume and storey: walls only on faces no other volume covers over more than half a tile of the storey's height; upper storeys stack wall pieces from the floor up (short pieces or a top-aligned piece for a remainder, never into the storey below); seams; then each volume's layers (deck, gable/hip/shed with fill, skirt/stepped with a flat top, spire shell of wall strips on the wall line with bands, lid and finial, flat with a run-based parapet). Furniture: dormers (kits with `roof.<kit>.dormer`), clutter field on flat tops (edge/equipment/storage roles, one cell apart), a mast (palette `parts` assembly) on the highest flat top. Lights: lit windows (`light.window.<walls>` / `light.glow.<colour>`, seeded share), door lights, entrance strips (`light.strip`).
- **Design spaces** (`resolve/structureVariety.ts`, data in `structureStyles.ts`): a building left to its style draws a design (`drawDesign`: archetype, storeys, materials or a wall `treatment` — a belonging set of base/trim, walls and crown — roof and `roofKit`, windows, details, character) and `expandDesign` turns it into volumes; the neighbour rule keeps adjacent buildings apart. The `shaft` archetype (wizard tower) stacks one volume per storey: a wider base tier, a lantern room at shaft width, bartizans or a stair turret, a steep spire (a shell of `roof.<kit>.shell` thin walls with flared bands, else a doubled steep hip capped by `roof.<kit>.tip`). `character` bends the shaft (twisted = covered storey offsets; leaning, crooked, top_heavy, squat, slender); overhangs get a corbel course and set-backs a skirt (`buildLips`).
- **Condition** (`resolve/ruin.ts`): weathered and ruined buildings get a `ResolvedStructure.ruin` profile — every wall column's surviving top, upper-floor holes, the standing corner, the share lost, a weathered roof patch — that the compiler builds to (walls, posts and lintels clipped per column, crenel remnants, a ruin's roofs gone except a standing gable wall). `structureRuinMeasures` / `weatherMeasures` (with `WEATHER_MINIMUMS`) are what the review and tests read.

### 2.4d Generator 5: character, anchors, detail recipes, arrangements, objects

Generator 5 adds a stage after the level is finished (step 11) and a reading of every place before it. Each piece is behind its own switch in `plan/generator.ts`; the stage lists are `resolve/level.ts` (`runPhase1`, `runPhase2`, `runDetail`) and `resolve/recipes/table.ts` (`RECIPES`).

**Character** (`resolve/character.ts`, switch `characterCascade`). Every scope of a level (the level as the scene, each zone as a district, each building, each other area) gets one `ResolvedCharacter`: light (dark, dim, moderate, bright, flooded: how many accents mark the places in use, not the board's brightness), condition (intact, weathered, ramshackle, ruined), wealth (poor, modest, wealthy, lavish) and a light tone. Per axis: a stated value (the plan's optional `light`, `condition` and `wealth` on the level, an area or a building, switch `statedCharacter`; a building's condition may be `ramshackle`, built as weathered by every generator, `gen/buildingCondition.ts builtCondition`), else the subject's own words and mood words (`gen/lightLevels.ts lightNamedBy`, `gen/buildingCondition.ts`), else the parent scope's value drawn with a little spread, else the theme's default. It is resolved in the `ResolveGrid` constructor (`resolve/level/grid.ts`); building rooms are added later (`CharacterMap.addArea`). During resolve every consumer asks `characterAt`, after it `elementCharacter` (`ResolvedLevel.character`): room light levels and regimes, a building's decay and lit windows, the treatments' condition and richness, ground wear, prop density and order, and the review. No consumer reads the words again.

**Anchors** (`resolve/anchors/`). The places detail attaches to, derived from a finished `ResolvedLevel` on first ask and kept, each with a local frame (`frame.ts`) and a stable `key` its draws hash: wall faces seen from one side, with their openings as gaps (`faces.ts`, over the shared wall walks), openings with mirrored jamb frames, convex and concave corners, a building's storey lines, bays cut along a face at a pitch phase-locked to its openings (`bays.ts`), room and yard floor zones classed cell by cell (wall band, door aprons, lanes, middle, ends; a focal score: `zones.ts`), furniture surfaces and points (`points.ts`). What only the palette knows (a theme's wall mount, a table's top height) comes in through `AnchorOptions`.

**Detail recipes and treatments** (`resolve/recipes/`, step 11). The engine (`engine.ts`) walks the anchors and instances each enabled recipe of `RECIPES` (its own switch each: jamb and corner posts, band courses, plinths, pilasters, layered ground, wall-foot growth, breach rubble, guardian and approach-light pairs, a lean-to shelter). It owns, once for every recipe: the recipe's `when`; filling its slots (`slots.ts`: the slot's roles, then the theme's own pieces of the shape from `palette/traitPools.ts`, then `borrow`, `simplify` or `skip`); seeds named by plan seed, level, anchor key and recipe, so adding one never moves another; composing in the anchor's frame; keeping clear of doorways, stairs, lanes, features and fixtures (`keepClear.ts`); where a loose piece stands on the ground (`footing.ts`: its footprint on one floor height, off water, paths, stairs and links); and the detail budget (`budget.ts`: pieces per footprint tile by kind of place, thinnable recipes spread and tiers 3 then 2 dropped first, calm anchors before focal ones). Which recipes dress a subject, and how, is its treatment (`treatments.ts`, `TREATMENTS`): one weighted option per family per subject (a building, else an area, else the level), drawn from a small set per neighbourhood so a street repeats a few treatments, never one for all; every family keeps a plain option, and the subject's condition and wealth (its character) shift the weights. Families that change a building's structure (`STRUCTURE_TREATMENTS`: roof patches, porch wear, ruin events) are drawn the same way when the building is planned (`resolve/building/`).

**Arrangements** (`arrange/`, switch `arrangements`). Pure operators that compose palette pieces (`ArrangePiece`: a variant with its measures) in a local frame: along a path, repeated, scattered, stacked on supports, copied, transformed (`operators.ts`, a file per kind; `budget.ts` limits). A resolve stage attaches the result as an instance (`instance.ts`, `ResolvedLevel.arrangements`: frame, base, pieces), one element each (`resolve/level/arrangements.ts`); `compile/realize/arrangements.ts` builds it and verify measures it like any prop. Turn geometry is shared with compile, recipes and the meter (`util/turn.ts`).

**Objects and the site stage** (`objects/`, `resolve/objectSite.ts`). Object recipes build things that are objects, not rooms or buildings (a vessel, a stall), in their own frame from slots of arrangement parts, over a stand-in lexicon (`objects/lexicon.ts`, `kit.ts`: roles, then the theme's trait pool, then simpler stand-ins), held to a piece budget and placed whole (`place.ts`). `resolveWithObjects` turns an internal `ObjectSpec` into what the level stages understand: `expandObjectSites` adds deck areas, rooms (split with the ground-storey splitter), openings and links to a copy of the plan; `resolvePlan` resolves it; `placeObjectSites` attaches the pieces as arrangement instances, drops generated features in the footprint and re-hashes. No plan word reaches it yet (the proposed `Level.objects` is the owner's call), so only tests and proofs call it. With the ship kit in the palettes (`ship.*` roles, generator 5) a barge or ship is set on the kit's grid (`objects/vessel.ts` `onKitGrid`, `kitHullParts`): hull tiles at their real sizes, rail tiles, a quarterdeck of kit walls and stern gallery, the kit's sails, shrouds, bowsprit, cannon and capstan; every orientation the kit's pieces are assumed to have is one table, `SHIP_KIT_FRAME`, until the calibration proof settles it. A moored hull is moved off the quay it would overlap, its gangway runs to the quay's edge, and its lowest waterline is the board's water plane (`ResolveOptions.waterPlane`).

### 2.5 Generators (version 1)

All generators use **integer-lattice value noise and arithmetic only**: `+ − × ÷`, `Math.floor`, `Math.round`, `Math.sqrt`. No `sin`, `cos`, `atan2`, `exp`, or `pow` with a fractional exponent. That keeps output bit-identical across V8 versions and machines. Golden tests freeze the output of each generator.

- **blob.** A cell is inside if `d² ≤ (r·(1 + roughness·(n−0.5)))²`. `n` is value noise at scale `max(2, r/2)` sampled at the cell centre. Only the component containing the centre is kept.
- **cave.**
  - Fill the rect with `fill` probability.
  - Run `steps` iterations of B5678/S45678.
  - Keep the largest 4-connected region.
- **noise.** A cell gets `material` if `n(x/scale, y/scale) < coverage`.
- **path jitter.** Subdivide each segment every 3 cells and offset interior points perpendicular by `round((n−0.5)·2·jitter·width)` cells. The path stays 4-connected.
- **scatter.**
  - Candidate cells are visited in a seeded Fisher–Yates order.
  - Each candidate is accepted with probability `density` if it is not within `minSpacing` (Chebyshev distance) of an accepted or occupied cell.
  - Rotation: a random multiple of 15° for organic types when `randomRotation`; otherwise 0. `rotFine` holds it.
- **dress.**
  - A preset table in core lists `(featureType, weight, placement: wall|center|corner, size, blocking)` per preset.
  - The count is `round(density × openCells / 6)`.
  - Wall-hugging items prefer cells adjacent to WALL edges and are rotated to face away from the wall.
  - **Composed set pieces** (added 2026-11-19, `gen/setpieces.ts`): `ritual_circle`, `overgrown`, `cavern`, `collapse`, `crystal_grotto`, `campsite` are not weighted tables. Each places an optional focal group (at the centre, or against the wall farthest from the entrances), then `round(density × cells / cellsPerGroup)` vignettes (a focal piece plus supporting pieces) anchored to walls, corners or, in areas of 150+ cells, open ground; vignettes stay 5 cells apart and each kind appears at most 2–3 times. A lighting pass then puts a light beside each entrance and wall lights wherever no light is within the preset's spacing. Blocking pieces keep 2 cells clear of entrances and links; multi-cell pieces avoid cells beside a thin wall; a group is withdrawn if it would cut off floor that was reachable before it.
  - **Clustered scatter**: the natural types added on 2026-11-19 (stalagmite, stalactite, crystal, giant_mushroom, root, skull_pile, candles) scatter as clumps (a seed placement plus 1–2 neighbours). Older types keep the frozen v1 stream.

### 2.6 Level links

- `rise = elevation(to.level) − elevation(from.level)`. It must be greater than 0 for stairs, spiral_stairs, ladder, and ramp; otherwise the result is `link_mismatch`.
- **Run length.** `stairs`/`ramp`: `L = ceil(rise / stairRisePerCell)`. The lower cells are `from.at` plus k steps in `dir`, for k = 0..L−1, times `width` (extending east for N/S runs and south for E/W runs). The arrival cell on the upper level is `from.at + L·dir`. `spiral_stairs` uses a 2×2 footprint at `from.at`, and the arrival is the same footprint. `ladder` and `trapdoor` use one cell, and the arrival is the same cell.
- If `to.at` is given and differs from the computed arrival, the result is `link_mismatch` with the hint `to.at should be [x,y]`. The model is told to omit `to.at`.
- **Effects.**
  - The lower cells get `LINK`; they must be OPEN, with floor and without features.
  - The upper level gets `STAIRWELL|NO_FLOOR` on the cells vertically above the run, except for `trapdoor`, which keeps its floor and gets a hatch feature.
  - The arrival must be OPEN with floor on the upper level; otherwise `link_blocked`.
  - `pit_drop` makes the upper cells NO_FLOOR and requires an OPEN cell below.

### 2.7 Determinism and seeds

- **Hash.** `h32(str)` = FNV-1a 32 over UTF-8.
- **Element seed.** `elementSeed = op.seed ?? h32(plan.seed + ":" + elementId)`. Sub-streams use `h32(elementSeed + ":" + purpose)`.
- **PRNG.** sfc32 seeded through splitmix32. Noise lattice values are `h32(seed + ":" + ix + ":" + iy) / 2³²`.
- **Canonical form.** Canonical JSON (sorted keys, no whitespace) is used for hashes. `ResolvedPlan.hash` is FNV-1a 64 of the canonical resolved form.
- **Generator versioning.** `generator: 1` pins the algorithms. If they ever change, core keeps the v1 code path and new plans get `generator: 2`. The migration of old plans is a no-op, so old maps never move. **Generator 2 (2026-11-19)**: under-layer `height` ops set the height of every cell in their shape (§2.4 step 2), and scatter/dress skip lava and bridge decks. `create_plan` gives new plans 2; saved maps keep 1 and resolve to the same geometry (they may gain warnings). The chasm op and bridges are new elements and behave the same under either number. A 0.1.x app refuses a generator-2 plan (schema).

### 2.8 Validation

Validation is a pure function `validatePlan(plan, ctx {checks, themes})` that returns `PlanIssue[]` with stable codes. **Errors** block (op batches are rejected, approval is blocked). **Warnings** don't block.

Errors:
- Zod schema failures. Messages are rewritten for the model: path, expected value, and nearest valid enum value.
- Id format; duplicate ids; unknown refs (opening `between`, dress `area`, link levels, `entryLevel`).
- Heights not on 0.25 steps; out-of-range values; duplicate level elevation.
- Exceeding `PLAN_LIMITS`; degenerate shapes; non-axis-aligned path or wall-run segments.
- `opening_no_boundary`, `opening_overlap`, `link_mismatch`, `link_blocked`, `feature_blocked` (explicit features only).
- An area that rasterizes to zero cells, or is entirely overridden by later areas.
- Duplicate keys; `stamp_unsupported`.

Warnings:
- Disconnected area.
- Unreachable area: flood fill over OPEN cells, crossing NONE, OPENING, and LEDGE edges up to 0.5, plus links, starting from the entry level's lowest-key area and any `@outside` opening. This becomes **blocking at approval** (UX §7.5).
- Unknown theme (falls back to the map theme); unresolved custom feature; elements clipped to bounds; scatter hitting the cap; corridor narrower than 1 clear cell after host-halving (an inner wall on both sides).

Every issue carries a `hint` whenever one can be computed: expected cell, nearest id, valid enum values, the shared-edge suggestion.

### 2.9 Worked example A: two-level dungeon ("The Drowned Abbey")

```json
{
  "schema": "slabyrinth/plan@1", "generator": 1, "id": "6f1c2a52-6a9e-4c55-9d64-2f0b9b7c1e01",
  "title": "The Drowned Abbey", "kind": "dungeon", "seed": 41177, "theme": "stone_dungeon",
  "entryLevel": "l1",
  "summary": "Crypts under a ruined abbey; the lower cistern level is half flooded.",
  "levels": [
    {
      "id": "l1", "name": "Upper Crypts", "elevation": 0, "bounds": { "x": 0, "y": 0, "w": 30, "h": 24 },
      "base": { "type": "solid" },
      "areas": [
        { "id": "entry", "kind": "room", "name": "Collapsed Stair", "key": "1",
          "shape": { "type": "rect", "x": 12, "y": 18, "w": 6, "h": 5 },
          "readAloud": "Broken steps spill down from a hole in the vaulted ceiling. Grey daylight dies a few feet in.",
          "notes": "Way in from the abbey ruins above. Rubble is difficult terrain." },
        { "id": "hall", "kind": "room", "name": "Hall of Pillars", "key": "2",
          "shape": { "type": "rect", "x": 8, "y": 6, "w": 16, "h": 8 },
          "notes": "Eight pillars carved as hooded monks. The statue's eyes follow light sources." },
        { "id": "guard", "kind": "room", "name": "Guardroom", "key": "3",
          "shape": { "type": "rect", "x": 1, "y": 7, "w": 5, "h": 6 },
          "encounter": "Daggerheart: 3× Skeleton Warrior (Standard)." },
        { "id": "ossuary", "kind": "room", "name": "Ossuary", "key": "4",
          "shape": { "type": "rect", "x": 24, "y": 4, "w": 5, "h": 10 },
          "notes": "Secret door from the hall (Instinct 14). Stairs descend to the cistern." },
        { "id": "c1", "kind": "corridor",
          "shape": { "type": "route", "from": "entry", "to": "hall", "width": 2, "bend": "vh", "openings": "archway" } },
        { "id": "c2", "kind": "corridor",
          "shape": { "type": "route", "from": "guard", "to": "hall", "width": 1, "bend": "hv", "openings": "door" } }
      ],
      "openings": [
        { "id": "d_secret", "kind": "secret_door", "between": ["hall", "ossuary"], "position": 0.5 }
      ],
      "walls": [],
      "features": [
        { "id": "p1", "type": "pillar", "at": [10, 8] },  { "id": "p2", "type": "pillar", "at": [10, 11] },
        { "id": "p3", "type": "pillar", "at": [13, 8] },  { "id": "p4", "type": "pillar", "at": [13, 11] },
        { "id": "p5", "type": "pillar", "at": [18, 8] },  { "id": "p6", "type": "pillar", "at": [18, 11] },
        { "id": "p7", "type": "pillar", "at": [21, 8] },  { "id": "p8", "type": "pillar", "at": [21, 11] },
        { "id": "abbot", "type": "statue", "at": [15, 6], "rot": 0, "label": "The Abbot" },
        { "id": "torch1", "type": "torch_wall", "at": [9, 6], "wall": "N" },
        { "id": "torch2", "type": "torch_wall", "at": [22, 6], "wall": "N" },
        { "id": "sarc", "type": "sarcophagus", "at": [25, 5], "size": [1, 2] },
        { "id": "bones1", "type": "bones", "at": [27, 12] },
        { "id": "rubble1", "type": "rubble", "at": [13, 20] }, { "id": "rubble2", "type": "rubble", "at": [16, 21] }
      ],
      "terrain": [
        { "id": "dress_guard", "op": "dress", "area": "guard", "preset": "barracks", "density": 0.6 }
      ],
      "labels": [ { "id": "lbl_up", "text": "Up to the abbey", "at": [14, 22], "size": "s" } ]
    },
    {
      "id": "l2", "name": "Cistern Depths", "elevation": -2.5, "bounds": { "x": 0, "y": 0, "w": 30, "h": 24 },
      "base": { "type": "solid" }, "theme": "cave",
      "areas": [
        { "id": "cistern", "kind": "cave", "name": "Flooded Cistern", "key": "5", "walls": "perimeter",
          "shape": { "type": "cave", "x": 13, "y": 3, "w": 16, "h": 17, "fill": 0.42, "seed": 7 },
          "notes": "Waist-deep water in the middle; the deep pool hides the drowned abbot's ring." },
        { "id": "landing", "kind": "room", "name": "Stair Landing", "key": "6", "walls": "perimeter", "floor": "rock",
          "shape": { "type": "rect", "x": 24, "y": 7, "w": 4, "h": 5 } },
        { "id": "chapel", "kind": "room", "name": "Drowned Chapel", "key": "7", "theme": "stone_dungeon",
          "shape": { "type": "rect", "x": 2, "y": 8, "w": 8, "h": 7 },
          "readAloud": "Green water laps at a raised altar. Someone has lit a single candle." },
        { "id": "c3", "kind": "corridor",
          "shape": { "type": "route", "from": "chapel", "to": "cistern", "width": 1, "bend": "hv", "openings": "archway" } }
      ],
      "openings": [], "walls": [],
      "features": [
        { "id": "altar2", "type": "altar", "at": [3, 11], "rot": 90 },
        { "id": "candle", "type": "candelabra", "at": [4, 10] }
      ],
      "terrain": [
        { "id": "flood", "op": "paint", "layer": "over", "shape": { "type": "circle", "cx": 20, "cy": 11.5, "r": 5 }, "material": "water_shallow" },
        { "id": "pool",  "op": "paint", "layer": "over", "shape": { "type": "circle", "cx": 20, "cy": 13.5, "r": 2 }, "material": "water_deep" },
        { "id": "dais",  "op": "height", "layer": "over", "shape": { "type": "rect", "x": 3, "y": 9, "w": 3, "h": 5 }, "set": 0.5 },
        { "id": "rocks", "op": "scatter", "feature": "rock", "shape": { "type": "rect", "x": 13, "y": 3, "w": 16, "h": 17 }, "density": 0.06, "minSpacing": 2 }
      ],
      "labels": []
    }
  ],
  "links": [
    { "id": "stair_main", "kind": "stairs", "from": { "level": "l2", "at": [26, 11] }, "to": { "level": "l1" }, "dir": "N",
      "label": "Down to the cistern" }
  ]
}
```

What resolution produces:
- **Route areas.** `c1` routes vertically from the entry anchor (x 14–15) up to the hall. It is 2 wide and gets archways at both ends. `c2` routes horizontally across x 6–7 into the hall with doors.
- **Secret door.** The hall/ossuary shared run is x=24, y 6–13. The secret door lands mid-run.
- **Stairs.** The rise is 2.5, so the run is 3 cells: (26,11), (26,10), (26,9) on l2. The arrival is (26,8) on l1, inside the ossuary, and l1 cells (26,9..11) become the stairwell.
- **Cave merge.** The landing merges openly into the cave because both are `perimeter`.
- **Dais.** It is a raised 0.5 ledge inside the chapel.

### 2.10 Worked example B: outdoor forest clearing with a ruin

```json
{
  "schema": "slabyrinth/plan@1", "generator": 1, "id": "0d8f6c3e-77a4-4b9e-8a1e-5d3b2c9e4f10",
  "title": "Chapel in the Pines", "kind": "outdoor", "seed": 90210, "theme": "outdoor",
  "levels": [
    {
      "id": "g", "name": "Old Chapel Clearing", "elevation": 0, "bounds": { "x": 0, "y": 0, "w": 48, "h": 40 },
      "base": { "type": "ground", "material": "grass" },
      "areas": [
        { "id": "clearing", "kind": "zone", "name": "The Clearing", "key": "2",
          "shape": { "type": "blob", "cx": 22, "cy": 17, "r": 10, "roughness": 0.3 },
          "notes": "Bandits camp here; the fire is still warm." },
        { "id": "ruin", "kind": "building", "name": "Ruined Chapel", "key": "1", "theme": "stone_dungeon",
          "shape": { "type": "rect", "x": 18, "y": 11, "w": 8, "h": 7 }, "floor": "flagstone", "wallStyle": "ruined",
          "readAloud": "Half a chapel: the east wall has fallen outward into the bracken." },
        { "id": "bridge", "kind": "courtyard", "shape": { "type": "rect", "x": 32, "y": 28, "w": 5, "h": 3 }, "floor": "bridge_wood", "walls": "none" }
      ],
      "openings": [ { "id": "chapel_door", "kind": "archway", "at": { "x": 21, "y": 17, "side": "S" }, "width": 2 } ],
      "walls": [ { "id": "breach", "op": "remove", "points": [[26, 13], [26, 16]] } ],
      "features": [
        { "id": "altar", "type": "altar", "at": [21, 12], "rot": 0 },
        { "id": "saint", "type": "statue", "at": [24, 12], "variant": "broken" },
        { "id": "rb1", "type": "rubble", "at": [25, 14] }, { "id": "rb2", "type": "rubble", "at": [19, 16] },
        { "id": "fire", "type": "campfire", "at": [15, 21] },
        { "id": "tent1", "type": "tent", "at": [11, 18], "size": [2, 2], "rot": 90 },
        { "id": "log1", "type": "log", "at": [28, 22], "rot": 90 },
        { "id": "sign", "type": "signpost", "at": [6, 29] }
      ],
      "terrain": [
        { "id": "patches", "op": "noise", "shape": { "type": "rect", "x": 0, "y": 0, "w": 48, "h": 40 }, "material": "dirt", "coverage": 0.2, "scale": 5 },
        { "id": "road", "op": "path", "points": [[0, 31], [16, 29], [30, 30], [47, 24]], "width": 2, "material": "gravel", "jitter": 0.25 },
        { "id": "stream", "op": "path", "points": [[34, 0], [36, 14], [33, 26], [38, 39]], "width": 2, "material": "water_shallow", "jitter": 0.3 },
        { "id": "knoll", "op": "height", "shape": { "type": "blob", "cx": 9, "cy": 9, "r": 5 }, "delta": 0.5, "smooth": 2 },
        { "id": "trees", "op": "scatter", "feature": "tree", "density": 0.3, "minSpacing": 2,
          "exclude": [ { "type": "blob", "cx": 22, "cy": 17, "r": 10, "roughness": 0.3 } ],
          "avoid": ["water", "paths", "areas", "features", "links"] },
        { "id": "pines", "op": "scatter", "feature": "pine_tree", "shape": { "type": "rect", "x": 0, "y": 0, "w": 14, "h": 40 }, "density": 0.12, "minSpacing": 2,
          "avoid": ["water", "paths", "areas", "features"] },
        { "id": "bushes", "op": "scatter", "feature": "bush", "density": 0.05, "avoid": ["water", "paths", "areas", "features"] },
        { "id": "boulders", "op": "scatter", "feature": "boulder", "density": 0.015, "minSpacing": 4 },
        { "id": "reeds", "op": "scatter", "feature": "reeds", "shape": { "type": "path", "points": [[34, 0], [36, 14], [33, 26], [38, 39]], "width": 4 },
          "density": 0.25, "avoid": ["areas", "features"] }
      ],
      "labels": [ { "id": "to_town", "text": "To Millbrook", "at": [2, 30] } ]
    }
  ],
  "links": []
}
```

Notes on this example:
- `ruin` is a building with `auto` walls. Its exterior walls are hosted on the grass side (host rule 2), so the interior keeps a full 8×7.
- The wall run `breach` removes 3 edges of the east wall (vertex x=26, y 13→16).
- `clearing` is a zone. It changes nothing physical, but it gets key 2, notes, hit-testing, and a label.
- Scatter order matters: trees are excluded from the clearing blob and avoid road, stream, and areas, and later scatters avoid features already placed.
- This plan is about 230 explicit tokens of terrain. The resolved level holds roughly 1,900 ground cells (packed into about 600 2×2 tiles), about 330 trees, and about 80 bushes, roughly 1,100 placements. That fits in 1 chunk.

---

## 3. Agent design

### 3.1 Edit strategy

| Option | Token cost | Reliability | Conflicts |
|---|---|---|---|
| Replace whole plan every time | O(plan) per edit: 10–60K output tokens for a medium map | The model silently drops or changes unrelated parts | Overwrites UI edits |
| JSON Patch (RFC 6902) | Small | Array-index paths are brittle after inserts and removes; poor error messages | Index drift |
| **Domain ops by id (chosen)** | Small (typically 0.2–3K) | Validated per op with semantic hints; transactional | Ids are stable; `baseVersion` check |

The tool set is fixed per conversation, in this order (`tools.ts`):

1. `update_brief`
2. `ask_questions` (ends the turn; the answers become its `tool_result`)
3. `create_plan` (the first draft, or `replace: true`)
4. `edit_plan` (`baseVersion`, `summary`, `changes` (≤6 bullets for the Plan update card), and `ops[]`)
5. `view_plan` (outline, ascii, or json)
6. `view_map_image`
7. `compile_preview`
8. `list_catalog`

`edit_plan` ops are `add`, `add_features`, `update` (a shallow `set`), `remove` (with cascade), `move` (with contents), `duplicate`, `reorder`, `materialize`, `set_meta`, `reshape`, and `renumber`. The UI uses the **same op language** through `plan:applyOps` and `plan:editText`.

**Strict mode.** Strict tool use is not enabled: the plan schemas use `oneOf` unions and open `set` objects that exceed strict-mode subset limits. Validation is client-side with the same Zod schemas that validate plans. Because `eager_input_streaming` is on, every input is validated before execution, as the skill requires.

### 3.2 Turn loop (ConversationEngine, main process)

```
send(text, selection?, answers?, intent?):
  1. If the transcript ends with a pending ask_questions call,
     append tool_results{callId, AskQuestionsAnswer}.
     Append the user item; the selection is rendered as a <selection> block, see §3.5.
  2. If the project differs from conversation.modelSeen, append a context item
     (plan_changed / brief_changed): diff + fresh outline. See §3.6.
     On the first turn, append context "session_start": themes, built-in-only warning, brief.
  3. Choose this turn's effort (Smart effort, §3.8). If it differs from the last effective
     effort, append a marker item.
  4. Loop over steps (max 24 steps per turn):
       result = provider.runStep({systemPrompt, tools, transcript, effort, maxOutputTokens: 64000, …})
       Forward stream events to the renderer, including progress parsed from create/edit input (§3.9).
       Branch on result.stopReason:
         end_turn  → append the assistant item; done.
         tool_use  → append the assistant item; execute the tool calls in order
                     (all edit tools serialize on the plan); append ONE tool_results item with all results.
                     If a tool returned awaitUser (ask_questions): end the turn without a result.
                     Otherwise continue.
         max_tokens with a tool call in it → discard the step. Retry once with maxOutputTokens 128000
                     and a retry_hint context ("split large changes into several edit_plan calls").
                     Then fail.
         max_tokens on text → append, mark truncated, offer Continue.
         refusal   → keep the partial output display-only (excludedFromContext); end the turn with a notice.
         pause     → append and continue (cap 5).
  5. Persist after every appended item (debounced 1 s, flushed at the end of the turn).
     Update totals and modelSeen.
```

**Plan locking.** UI geometry and text edits are refused with code `busy` while a turn runs. The UX already makes the map read-only during revisions.

**Cancellation.** One `AbortController` per turn is passed as the request `signal`.
- On abort, the step in flight is discarded from the API transcript. Streamed text is kept display-only, marked "Stopped" (UX §5.6), using `excludedFromContext`.
- Tools already executed in earlier steps stay applied, as versions. Their results are already in the transcript, so the history stays consistent, and the GM can undo.

**Retries.**
- The SDK's `maxRetries: 2` handles connect-time 408/409/429/5xx.
- After that, the engine shows "busy, retrying in Ns", respecting `retry-after`, with backoff of 4 s, 12 s, and 30 s for `rate_limit`/`overloaded` (UX 10.3).
- If the stream drops mid-step, the partial step is discarded and retried automatically once. That is safe because incomplete steps never execute tools.
- `auth`, `permission`, `invalid_request`, `not_found`, and `context_overflow` are not retried; each maps to UX copy 10.2, 10.4, or 10.17.

**Retry button (UX §5.6).** Retry runs the last turn again, optionally with a different selection.
- The last turn's items are moved into `meta.alternatives`. Because they are the **tail**, truncation keeps the API prefix byte-identical; preserved thinking allows removing a trailing run.
- If the retried turn created versions, the head moves back to the version before the turn. That is an undo, recorded in `undone`.

### 3.3 How the model sees the plan

The transcript is append-only. Nothing earlier is ever rewritten.

**1. Tool results.** The first text block is the `PlanChangeReport` as compact JSON. The second is an ASCII view of each dirty level, cropped to the changed bbox ±3 cells. Budget: at most 4,000 characters per result; it degrades to the outline lines of the changed elements.

**2. `view_plan` outline.** One line per element with all parameters that matter. It is lossless for ids, kinds, shapes, keys, links, and terrain ops. Notes are truncated to 60 characters with `…`; use `json` for the full text. Example:

```
PLAN v7 "The Drowned Abbey" dungeon theme=stone_dungeon seed=41177 entry=l1
LEVEL l1 "Upper Crypts" elev=0 bounds=0,0 30x24 base=solid
  AREA entry room #1 "Collapsed Stair" rect 12,18 6x5 | notes "Way in from the abbey ruins…"
  AREA hall room #2 "Hall of Pillars" rect 8,6 16x8
  AREA c1 corridor route entry->hall w2 vh open=archway
  OPEN d_secret secret_door hall|ossuary @0.5 -> edge v 24,9..10
  FEAT p1 pillar 10,8 · p2 pillar 10,11 · … (8 pillars) · abbot statue 15,6 r0 "The Abbot"
  TERR dress_guard dress guard barracks d=0.6 -> 7 features
LEVEL l2 "Cistern Depths" elev=-2.5 …
LINK stair_main stairs l2 26,11 dir=N -> l1 26,8 (run 3)
ISSUES none
```

**3. `view_plan` ascii.** It uses a double-resolution grid of (2w+1)×(2h+1) characters: odd/odd positions are cells, even positions are edges and vertices. Levels wider than 60 cells automatically switch to 1 character per cell (no walls) and print a hint to crop with `region`.

| Char | Meaning |
|---|---|
| `+` | Vertex where walls meet |
| `-` `\|` | Wall |
| `d` `D` `L` `s` `a` `w` `p` | door, double, locked, secret, archway, window, portcullis/bars |
| `:` | Ledge (height change) |
| `.` | Floor |
| `#` | Rock |
| ` ` (space) | Void |
| `~` `W` | Shallow, deep water |
| `O` | No floor or stairwell |
| `>` `<` | Stairs up, down |
| `,` | Path |
| letters/digits | Features, from a per-view legend printed below (only the characters used) |
| `[n]` | Room key, written at the anchor if it fits |

Coordinates are printed every 5 cells on both axes.

**4. Images.** The model does **not** receive an image automatically. Images cost about 1–1.5K tokens each, and the ASCII view plus the validator catch most layout errors. `view_map_image` exists for the cases where layout quality matters: after a first draft, or after big generated changes. The prompt says to use it sparingly. The tool exists only if the selected model has `imageInput`, a decision frozen per conversation (`imageToolEnabled`). After a later switch to a non-image model, it returns "unavailable on this model".

### 3.3a Design principles and the design review

`agent/designPrinciples.ts` is the judgment the team applied to every proof, as system-prompt text (general, theme-neutral, versioned dp-x.y.z). `review/` (`reviewDesign(plan, resolved, {palettes?, diagnostics?, brief?})`) measures it on every generator-2 create/edit: flat ground, straight natural edges (shape metrics in `review/metrics.ts`), rows and even scatter (chain and Clark–Evans tests), dead space, blank lots, bare natural ground, lookalike / dark / same-roof neighbours (the building engineer's `structureSignature`, `structureSilhouette`, `structureTone`), floor patchwork (palette tile families and observed tones), focal points, single routes, paths to nowhere, repeated props, mirrored layouts, relief, street misuse, and words of the brief the map does not show (`review/brief.ts`, a word-to-measure table). The executor appends a `DESIGN REVIEW` block (deltas after the first) with a `BRIEF CHECK` line; `compile_preview` adds substituted pieces as one note. Read-only, deterministic, a few ms per level. CLI: `slabyrinth review <plan.json>`.

### 3.3b Cliffs, rivers and board outline (generator 2)

`resolve/cliffs.ts` `cliffRuns` chains natural rises of a tile or more into ordered runs (`ResolvedLevel.cliffs`); the dressing's rock band (`gen/cliffband.ts`) faces them with `cliff_face` / `cliff_crest` features, keeping off `ResolvedLevel.ramps` (stairs ops in style "ramp") through `PlacementGrid.ramp`. `compile/realize.ts` (`BAND`) lays rock floor under a band, leaves out face blocks and fill behind covered edges, and backs bare edges with one rock family; verify reports `verify_cliff_gap` if any edge is still open. `resolve/water.ts` `riverCourse` carries rivers from one board edge to another and keeps them off the border. `stepOutline` gives open-air natural levels a ragged outline (`Level.outline`). `stepPathSpurs` leads a trail to the plan's focal piece and building fronts.

### 3.3c The quality meter (generator 5)

`review/qualityMetrics.ts` defines each metric once: what it measures, its unit and tier, the range skilled builds fall in, where that range comes from and how far to trust it, and whether it is meant to become a hard rule. The slab tier (`review/qualitySlab.ts`: overlap, rest contact, off-axis and off-height-grid pieces, props on props, symmetry, distinct and repeated assets, coplanar and stamped groups, pieces per tile and column) reads placed pieces only, so it runs on any decoded slab; its ranges were measured on the community training slabs (aggregates only). The map tier (`review/qualityMap.ts`, `qualityRooms.ts`: blocked lanes, focal contrast, lights per tile and lit doors, band coverage, each room against its kind's targets, ground cover, corridor share, room sizes, dead ends) needs the resolved map; its ranges come from the technique catalogue. Nothing in the meter fails a build: the CLI's `quality` command prints a build's values beside the targets, the generator-5 golden keeps a baseline per fixture (`generator5.quality.txt`) so a change shows what it moved, and `hard` rules are checked on the output of the recipe that claims them. Only findings a plan word can act on become review notes (`review/qualityNotes.ts`, switch `qualityNotes`: `lane_blocked`, `doors_unlit`, `silhouette_flat`, `facades_alike`); a dim scene or building (its character, `review/lights.ts`) keeps its doors dark on purpose.

### 3.4 Validation-error feedback

A rejected call returns `is_error: true` with:

```
{"status":"rejected","version":7,"errors":[
 {"op":2,"code":"unknown_id","msg":"no element \"hal\"","hint":"did you mean \"hall\"? areas on l1: entry, hall, guard, ossuary, c1, c2"},
 {"code":"link_mismatch","path":"/links/0/to/at","msg":"stairs from l2 26,11 dir N rise 2.5 arrive at 26,8","hint":"omit to.at or set it to [26,8]"}]}
REJECTED: nothing was applied; the plan is still v7. Fix all errors and call edit_plan again.
```

- Errors are deduplicated and capped at 20, with the total count.
- A wrong `baseVersion` returns `stale_version` with the changes since that version as a diff summary and a fresh outline of the affected levels.
- In the Anthropic adapter, invalid JSON input becomes the skill's `INVALID_JSON` error result.

### 3.5 Selection context

When the GM sends a message with reference chips or a region, the user item carries a `MapSelection`. The adapter renders it as a prefix block in the same user message:

```
<selection level="l1" areas="hall(#2)" features="abbot" rect="18,6 4x4"/>
```

Free text such as "room 4" also works, because the outline gives keys.

### 3.6 Plan versions as the model sees them

- The engine records `modelSeen.head` and the brief hash.
- Before each turn, any difference is announced in a `context` item. Causes include UI text edits, undo, restore, approval, brief edits, and edits made while the project was closed. Examples: "The GM undid v8; current is v7", or "The GM edited notes of hall".
- The same item carries the outline of the changed levels.
- `edit_plan.baseVersion` must equal the head **number**.

### 3.7 Phases

Phases are **derived** from data, as the UX specifies: brief (no version), plan, build (approved). They change no API parameters, because the system prompt, tools, and model stay frozen for cache and preserved-thinking safety. The model infers the phase from the conversation and the app's context items.

### 3.8 Models, effort, switching

**Descriptor (`ModelDescriptor`).** Built from the Models API (`client.models.list()`): `max_input_tokens`, `max_tokens`, `capabilities.effort.{low..max}.supported`, `capabilities.thinking.types.adaptive`, `capabilities.image_input`, and `structured_outputs`. It is merged with a bundled static table (`apps/desktop/src/main/agent/provider/anthropic/models.ts`) that supplies what the API lacks: default effort, guidance text, cost and speed tiers, pricing, and the fallback eligibility the adapter needs. The table is also used offline. The merged list is cached for 24 h.

| Model | Effort levels | Default effort | Thinking | Server fallbacks | Price in / out / cache read per MTok |
|---|---|---|---|---|---|
| `claude-opus-5-5` (default) | low…max | **medium** | always (adaptive) | `"default"` | $4 / $20 / $0.20 |
| `claude-fable-5-2` | low…max | high | always | `"default"` | $8 / $40 / $0.20 |
| `claude-sonnet-5-5` | low…max | high | adaptive (cannot disable) | `"default"` | $2 / $10 / $0.10 |
| `claude-haiku-5-5` | low…max | **medium** | adaptive | none (not offered) | $0.10 / $0.50 (≤100K prompt), $0.50 / $2.50 above |

- Cache writes: 1.25× (5 m) or 2× (1 h) of input.
- Prices are an estimate as of 2026-11 (`Pricing.asOf`), and the UI says so.
- Unknown new models from the API appear under "Other models". Their effort levels come from the capabilities tree, with default `high` if supported. They have no guidance.
- Non-Anthropic models may have `effort.supported=false`. The UI then hides the effort control.

**Selection and switching.** The selection is `{providerId, modelId, effort}` per conversation and is saved in the project. It applies to the **next** message; changes are refused while a turn runs. Each change appends a `marker` item and a system line ("Now using Opus · Thorough"). The safe behaviour:

- **Effort change, same model.** The Anthropic adapter renders the marker as an effort-only `{role:"system", content:[], output_config:{effort}}` message (beta `mid-conversation-output-config-2026-07-01`) when the model supports it (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.2). This keeps the prompt cache. Otherwise it changes the top-level `output_config.effort`, which invalidates the messages cache; the popover says "next message re-reads the conversation" with an estimated cost. If the effort is not valid for the model, it snaps to the model's default, as UX §5.8 specifies.
- **Model change.**
  - Caches are per model, so the next request re-reads everything uncached. `describeSwitch` estimates that cost, and the popover shows it inline; there is no modal, per UX.
  - Thinking blocks are passed back **unchanged**: Opus 5.5 blocks are readable only by Fable 5.1/5.2 and Mythos, so the API drops what the new model can't read (unbilled; `model_binding_mismatch`).
  - The adapter never strips blocks itself.
  - Tools stay frozen, including `view_map_image`, as above.
- **Provider change** (future). The new adapter renders only neutral parts and ignores other providers' `providerState`.
- **Retry with…** applies a one-turn selection override for the retried turn only.

**Per-phase presets: no.** Switching models between brief and plan generation inside one conversation costs a full uncached re-read and drops hidden reasoning each time, and Opus 5.5 at medium already handles plans well. UX lists per-task models as v1.1; if ever built, they should run as separate requests outside the main transcript (a "plan generator" sub-call), not as in-conversation switches.

**Smart effort (UX §5.8, default on).**
- Turn intent comes from the UI: the "Draw the first plan", "Ask Slabyrinth to fix", and "Retry" calls to action send `plan`. Otherwise intent is `chat` in the brief phase and `plan` once a plan exists.
- `chat` caps effort at `medium`.
- It is implemented **only** through per-message effort markers. If the model lacks per-message effort, Smart effort is silently inactive, because flipping top-level effort would reset the cache on every flip and cost more than it saves.

### 3.9 Streaming, progress, reasoning

**Streaming.** The adapter uses `client.beta.messages.stream(...)`. The beta namespace is needed for `fallbacks`, `betas`, `context_management`, and `thinking.block_binding`. WP4 confirms the method and option names against the installed SDK's `api.md` before coding (the skill shows the beta `create` and the Python beta `stream`). The adapter reads the result with `finalMessage()`.

**Progress.** The engine runs a tolerant partial-JSON parser over `tool_call_delta` for `create_plan`/`edit_plan` and emits UX progress steps:
- "Laying out Level n" when `levels[n]` begins;
- "Placing doors and stairs" on `openings`/`links`;
- "Furnishing" on `features`/`terrain`;
- "Writing GM notes" on `notes`/`readAloud`;
- "Checking the plan" during validation.

These events are for display only; the final input is validated as a whole.

**Reasoning display.** The adapter sends `thinking: {type:"adaptive", display:"summarized"}`, fixed for all conversations. The UI shows non-empty `thinking` text collapsed when `showReasoning` is on. On Opus 5.5, notes between tool calls arrive as `thinking` blocks, so this also gives progress narration.

### 3.10 Anthropic adapter details (all provider-specific behaviour lives here)

**Request shape per step:**

```
client.beta.messages.stream({
  model, max_tokens (64000, clamped to descriptor.maxOutputTokens),
  betas: [ "server-side-fallback-2026-07-01"   (not for haiku-5-5),
           "thinking-binding-controls-2026-08-01",
           "compact-2026-01-12",
           "mid-conversation-output-config-2026-07-01" (if markers are used) ],
  fallbacks: "default"                          (Opus 5.5 / Fable 5.2 / Sonnet 5.5),
  thinking: { type: "adaptive", display: "summarized",
              block_binding: { prefix_mismatch_behavior: "drop_block" } },   // "error" in CI/dev
  output_config: { effort },                     // only when no per-message marker mechanism applies
  context_management: { edits: [ { type: "compact_20260112" } ] },  // server-side compaction (§3.13)
  tools: TOOL_DEFINITIONS.map(t => ({ name, description, input_schema, eager_input_streaming: true })),
  system: [ { type: "text", text: SYSTEM_PROMPT_V1, cache_control: { type: "ephemeral", ttl: "1h" } } ],
  cache_control: { type: "ephemeral" },          // automatic 5 m tail breakpoint
  messages: render(transcript),
}, { signal })
```

- **Beta feature flags.** Every beta feature is a flag in the adapter. A 400 that names an unknown beta or field disables that flag for the session and retries once, then logs it.
- **Fallbacks.** `fallbacks: "default"` is on by default, as the skill requires. The settings and About pages tell the user that a declined request may be answered by another Claude model, and the per-message meta line shows `servedBy`. `fallback` content blocks stay in place in `providerState.raw`; replay rules follow the skill.
- **Refusal.** The adapter checks `stop_reason` before reading content. `refusal` produces `StepResult.refusal {category, explanation}`. The partial output is discarded from context and its text shown display-only with "The plan wasn't changed" (UX 10.5). Tools from that step never run.
- **Eager input streaming.** The adapter catches only the SDK's JSON parse error, never `Anthropic.APIError`, and re-issues the step (cap 2). If it holds the `tool_use` block, the engine validates the input with Zod; a failure produces an `INVALID_JSON` or schema-error `tool_result`.
- **Errors** map from SDK classes to `ProviderErrorKind`: `AuthenticationError`→auth, `PermissionDeniedError`→permission, `NotFoundError`→not_found, `RateLimitError`→rate_limit, status 529→overloaded, `InternalServerError`→server, `APIConnectionError`→network, `APIConnectionTimeoutError`→timeout, abort→cancelled, `BadRequestError` naming prompt length→context_overflow, other `BadRequestError`→invalid_request. The error carries the `request-id`.

**Rendering the neutral transcript:**

| Neutral item | Anthropic message |
|---|---|
| user | `user` message (selection block + text + images) |
| context | `{role:"system"}` mid-conversation message. Placed **immediately after** the user or tool_results item it accompanies, because a system message must follow a user message. The engine guarantees that placement. |
| assistant (with Anthropic `providerState`) | `assistant` with `providerState.raw` content **verbatim**: thinking signatures, fallback and compaction blocks |
| assistant (from another provider, or without state) | `assistant` rebuilt from neutral text and tool_call parts |
| `excludedFromContext` | skipped |
| tool_results | `user` message of `tool_result` blocks in a **single** message, including images for `view_map_image` |
| marker | effort-only system message, or nothing |

Consecutive user-role entries (tool_results followed by user) merge into one API message deterministically.

**Caching layout.**
- Breakpoint 1 is the system prompt with `ttl: "1h"`. Tools render first, so it covers about 9K tokens of tools and system. The 1 h TTL survives typical GM pauses of 5–60 min, and the write premium is small.
- The second breakpoint is automatic top-level caching (5 m) at the tail. The ordering rule (longer TTL first) is satisfied.
- Nothing volatile appears in system or tools: no dates and no theme lists; installed themes go in the `session_start` context item.
- Tool JSON is serialized from constants, so it is deterministic.
- A Vitest integration test, opt-in with a real key, asserts that the second identical request has `cache_read_input_tokens > 0`.
- A setting `anthropic.cacheTtl` (5m or 1h) changes only the tail.

**Usage and cost.**
- Per step, the adapter reads the final message `usage` (`input_tokens`, `cache_creation_input_tokens` split by `cache_creation.ephemeral_5m/1h_input_tokens`, `cache_read_input_tokens`, `output_tokens`).
- When `usage.iterations` is present (fallback), each attempt is priced at its own model's rates, and `attempts[]` lists them.
- Cost uses the descriptor `Pricing`, including Haiku's above-100K tier.
- Totals are kept per conversation, per project, and all-time (in settings).
- The UI says these figures are estimates and that the Anthropic bill is authoritative.

**Pre-send estimate (`chat:estimate`).** The estimate is: the last prompt size, plus the new text's tokens (characters ÷ 4), priced at cache-read rates if the last request was under 5 min ago (otherwise write rates); plus the expected output by intent and effort, from the median of this user's past turns or a built-in table. It is rounded per UX.

### 3.11 Weak or no tool calling (provider-neutral degradation)

`ModelDescriptor.toolCalling` sets `StepRequest.toolMode`:

- **`native`.** Normal tool calling.
- **`json`.** Shared helper `core/src/agent/jsonProtocol.ts`. The adapter appends a fixed protocol section to the frozen system prompt at conversation start:

  > Reply with exactly one JSON object: `{"say": string, "calls": [{"tool": <name>, "input": <object>}]}`. Tools and their input schemas follow.

  It embeds the same `TOOL_DEFINITIONS` schemas. The adapter then:
  - extracts the first balanced `{…}` (tolerating code fences);
  - parses it, validates each call with the **same Zod schemas**, and emits neutral `tool_call` parts with synthetic ids;
  - renders tool results back as a user message `TOOL RESULTS` block.

  If parsing fails, the adapter asks for a corrected reply twice, including the error. A reply with no JSON is treated as plain text, so chat still works. Plan safety is unchanged, because every call goes through `applyOps` and validation.

  For small-context local models, the engine uses the outline view in place of ASCII by default, and client-side simple compaction (§3.13).
- **`none`.** Chat only. The UI shows "This model can't edit the map", and geometry changes are impossible. Text edits in the room key still work.

### 3.12 Future: LM Studio provider (not v1)

LM Studio would be its own module, `apps/desktop/src/main/agent/provider/lmstudio/`, a separate work package of about one engineer-week. The work:

- `info`: needsKey false, hasServerUrl true (default `http://localhost:1234/v1`), modelSource `fetched`, hasCost false.
- Talk to the OpenAI-compatible endpoints (`/v1/models`, `/v1/chat/completions` with SSE) using `fetch`. This adapter calls only local models; Claude keeps using the official SDK.
- `listModels`: ids from the server. Descriptors: effort unsupported, thinking `unknown`, toolCalling defaults to `json` with a per-model user override (`native` if the user knows the model handles tools), imageInput false unless overridden, pricing null.
- Errors: connection refused maps to `network` with UX 10.19 copy.
- Usage: from the `usage` field if present; otherwise characters ÷ 4 estimates, and cost is null.
- An eval run with the CLI harness over 3–5 popular local models, to set default `toolCalling` guidance.

Nothing in the engine, IPC, settings, tools, or cost code assumes Anthropic. The provider-specific settings bag is `ProviderSettings.options`.

### 3.13 Long conversations

- **Anthropic.** Server-side compaction (beta `compact-2026-01-12`, a `compact_20260112` edit). The default trigger is about 150K input tokens; WP4 confirms the parameters for the trigger and custom `instructions` against the compaction docs before tuning. Server-side compaction does not count as a history edit for preserved thinking.
  - When a response contains a `compaction` block, the engine adds a notice and appends a `resync` context item with the full outline and brief on the next turn. The plan lives in the app, so nothing important lives only in chat.
  - Message threads (beta) are not used; they conflict with compaction.
- **Other providers.** Client-side *simple* compaction at 70% of `contextWindow`:
  1. Summarize the conversation with the same model.
  2. Start a new active transcript of summary + outline + new turn. The old items are kept in `alternatives`-like archived storage for display.
  3. Record it in `compactions`.

### 3.14 Resume

The project file holds everything; see `project.ts`. On reopen:

- The engine rebuilds API messages from the neutral items and providers' `raw` payloads deterministically. Same provider and model gives a byte-identical prefix, so preserved thinking stays valid.
- The cache is cold after the TTL, which costs one cache write on the next turn. The estimate shows it.
- A different API key or organization causes `organization_binding_mismatch` drops, which are tolerated through `drop_block`.
- A different model follows §3.8; a different provider uses neutral rendering.
- A pending `ask_questions` card is restored from `pendingQuestions`.
- Anything changed while closed is announced through `modelSeen` (§3.6).
- If the project's model is no longer offered, the pill shows a warning (UX 10.17) and nothing is sent until the user picks another model.

### 3.15 System prompt (draft v1, `sp-1.0.0`, frozen per conversation)

```text
You are Slabyrinth's map designer. You help a tabletop game master (GM) design battle maps — dungeons,
caves, towers, towns, wilderness — that the app builds in TaleSpire, a 3D virtual tabletop made of tiles
and props on a 5-foot grid.

HOW THE APP WORKS
- You never draw and never write TaleSpire data. You write and edit a structured map plan with tools.
  The app validates it, draws the 2D map the GM sees, and later turns the approved plan into TaleSpire
  slabs on the GM's computer. What is in the plan is exactly what gets built.
- System messages inside the conversation come from the app, not the GM: the current plan version,
  edits the GM made by hand, undo/restore, brief changes, the installed themes. Treat them as the
  current truth.
- A GM message may start with a <selection …/> of rooms, features or a rectangle. "This room", "here"
  and "these" refer to it.

WORKFLOW
1. Brief. Learn the map type, game system, party, rough footprint, number of levels, tone, must-haves
   and things to avoid. Record agreed facts with update_brief as soon as they settle. If something that
   matters is missing, ask once with ask_questions (at most 3 questions, each stating the default you
   will use); otherwise assume sensibly and say what you assumed. Don't interrogate.
2. First draft. When the GM wants a draft, call create_plan once with the full layout: levels, areas,
   corridors, doors, stairs, key furniture and GM notes. For big maps, create the structure first and add
   dressing with edit_plan calls in the same turn.
3. Refine. Make every later change with edit_plan: small ops that address elements by id, grouped into one
   call per coherent change, with a short summary and up to 6 change bullets. Never re-create the plan to
   change part of it. If a call is rejected nothing was applied: read every error and hint, fix them, and
   call again.
4. Ready. The GM approves and builds in the app; building uses no AI. Before you say the map is ready,
   call compile_preview and mention anything that cannot be built or will need many slab chunks.

PLAN CONVENTIONS
- One cell = 5 ft = one TaleSpire tile. Integer coordinates; x grows east, y grows south; north is up.
  All levels share one grid, so things that stack must use the same coordinates.
- Areas: rooms (usually rect), corridors (prefer shape "route" between two areas — it finds the path and
  adds doorways), caves ("cave" or "blob"), buildings and courtyards outdoors, and zones for named regions
  that change nothing physical. Later areas in a level's list win where they overlap (routes never
  overwrite).
- Walls are generated on area boundaries; don't draw walls around rooms. walls "auto" closes an area off
  from everything; "perimeter" only from rock or void (use it to merge spaces, like a landing opening into
  a cave); "none" for open ground. Wall runs are only for partitions, freestanding walls and ruined gaps.
  TaleSpire walls take half a cell on one side, so keep rooms at least 3×3 and corridors at least 1 wide.
- Doors, arches and windows sit on the edges between cells. Prefer between: [areaA, areaB]; the app finds
  the shared wall. Use at {x, y, side} for exterior doors or an exact spot. Areas need a shared boundary
  for a door between them.
- Levels: elevation is in tiles; one storey is 2.5 (0, 2.5, 5 … or −2.5 below). Stairs rise 1 tile per
  cell, so stairs between levels 2.5 apart need a straight 3-cell run of clear floor on the lower level and
  clear floor where they arrive above; omit to.at and the app computes the arrival and cuts the stairwell.
- Raised or sunken floors (daises, pits, hills, ledges) use floorHeight or a height terrain op, in steps
  of 0.25 tiles.
- Outdoors: give the level base {"type":"ground"} and describe the land with terrain ops — path for roads
  and streams, noise for patchy ground, height for hills, scatter for trees, bushes and rocks with exclude
  and avoid to keep clearings, roads and water open. Never place hundreds of features one by one. Scatter
  is deterministic; materialize turns its result into individual features if the GM wants to adjust them.
- Features use the semantic types in the schema, never asset ids. Use "custom" with a hint only when
  nothing fits. rot 0 means the front faces south. Wall decorations (torch_wall, banner_wall,
  painting_wall) need wall: side.
- Themes pick the TaleSpire kit. The installed themes are listed in an app message; list_catalog tells you
  which features a theme really has. Set the map theme and override per level or area where it changes.
- Ids are short, lowercase, unique across the whole plan and permanent; refer to things by id. Rooms get
  key numbers automatically and keep them; renumber only if the GM asks.
- Size: keep levels within about 80×80 cells unless asked. A 40×30 level builds in 1–3 slab chunks;
  bigger maps mean more pasting for the GM.

SEEING THE PLAN
- Edit results show the new version, warnings and an ASCII view of what changed. view_plan gives an
  outline of every element (format "outline"), the built geometry ("ascii"), or exact JSON ("json").
  Look before you edit anything you haven't seen since it last changed. view_map_image shows the real
  rendered map; use it after a first draft or a large generated change, not after every edit.

NOTES AND CONTENT
- Every numbered room gets GM notes: what is there, what is going on, and anything the GM must remember.
  Add readAloud for places with a first impression worth reading aloud, and encounter lines in the brief's
  game system (Daggerheart adversaries and Difficulty, D&D monsters and DCs) when the GM wants encounters.
  Keep notes tight; they are read at the table.

TALKING TO THE GM
- Be brief. After a change, say in a sentence or two what you did and anything you decided for them; the
  app already shows the change list, so don't repeat the plan back. Ask before large rewrites nobody asked
  for. If something can't be expressed (curved walls, specific TaleSpire assets, more than 8 levels), say
  so and offer the closest option.
```

The `session_start` context item looks like this:

```
Installed themes: stone_dungeon "Stone dungeon" (Dungeon Cellar kit), cave "Natural cave", wood_town "Timber
town & tavern", outdoor "Nature", generic (shared props). Asset library: built-in set (TaleSpire install not
found) | scanned 2026-11-18. Current brief: {…compact JSON…}. Plan: none yet.
```

---

## 4. Compiler pipeline (`docs/contracts/compiler.ts`)

### 4.1 Stages

| Stage | Input → output | Notes |
|---|---|---|
| validate | MapPlan → issues | Refuses on errors (`plan_invalid`) |
| resolve | MapPlan → ResolvedPlan | §2.4; the same code as the 2D view |
| realize | ResolvedPlan + PaletteCatalog + OrientationCalibration → PlacementSet | §4.3; world coordinates in tiles |
| chunk | PlacementSet → regions | §4.6; k-d split, measured by real encode |
| encode | regions → SlabChunk[] | SlabCodec v2 |
| bundle | → ExportBundle + BuildRecord | Instructions, diagnostics, stats, content hashes |

**Where it runs.** Compile runs in the main process inside a `worker_thread` (`compile.worker.ts`) and reports `compile:progress`. It typically takes under 1 s for a 2-level 40×30 map and a few seconds for 160×160 forests. `compile:estimate` runs realize without gzip and uses about 3.4 bytes per instance compressed (§1 of the format research) to estimate chunks.

### 4.2 Palettes

**Format.** `Palette` is `{id, extends, defaults, roles: {role → {variants[], footprint, rotation, mount, lengthAxis, height, greedyTiling, fallback}}}`. Each variant has:
- `asset` uuid;
- ordered `alternates`;
- **required `geom`** (size, originAt, boundsCenter, lengthAxis), plus `alternateGeom`;
- `weight`, `name`, correction `rot` and `offset`, and `stack`.

**Dependency direction (normative).** The compiler uses **only** palettes for geometry and asset choice. The scanned catalog is optional enrichment through `AssetAvailability`: it can only report a uuid as missing or deprecated in the user's game, which triggers the fallback chain:

1. alternates in order;
2. the role's `fallback` role;
3. drop the placement with a warning (never a hard failure).

The catalog also supplies names for unknown uuids and the search for `custom` features.

**Role vocabulary.** Roles are semantic:
- `floor.<Material>`, `fill.<Material|default>`;
- `wall.<WallStyle>`, `wall_post.<WallStyle>`;
- `opening.<OpeningKind>`;
- `link.<LinkKind>`;
- `feature.<FeatureType>`;
- `ledge.*`, `marker.alignment`.

Resolution order: area theme palette → its `extends` chain → `generic` → role `fallback` → `role_missing` (aggregated per role and level).

**Layering.**
- Bundled defaults ship in `packages/core/data/palettes/*.json` (committed, about 125 uuids). They are generated from `data/palette-draft.json` by `packages/core/scripts/import-palette-draft.ts`, which holds a mapping table from research roles to semantic roles. Examples: `floor_1x1`/`floor_2x2` → `floor.flagstone` variants with footprints [1,1] and [2,2]; `wall_1`/`wall_2` → `wall.wall` with lengths 1 and 2; `corner_filler` → `wall_post.wall`; `door_1` → `opening.door`; `doorway_arch_2` → `opening.archway` width 2.
- Users override in `userData/palettes/<id>.json`. A `PaletteOverride` is merged per role; a new id is a new theme.
- Palettes are plain, versioned JSON (`slabyrinth/palette@1`). A palette editor comes after the MVP. Nothing about assets requires an app release.
- Theme ids follow the research: `generic` (base for all), `stone_dungeon`, `cave`, `wood_town`, `outdoor`.

**Gaps against the IR.** The draft does not cover marble, carpet, lava, ice, many furniture types, or `iron_bars`/`plaster` walls. The import script maps the nearest role (for example `carpet`→`rug` feature is not possible, so `floor.carpet` falls back to `floor.wood_plank`) and lists every unmapped role in its report. WP3 owns closing the gaps with the researcher.

### 4.3 Realize (placement rules)

World mapping: `wx = x`, `wz = Hg − 1 − y`, where `Hg` = 1 + the maximum y over all levels. Level base `wy = elevation`. All numbers are in tiles and quantized by the codec.

1. **Floors.**
   - For each OPEN cell with floor, place the role `floor.<material>` at y = elevation + height − (tile thickness − 0.5). This aligns tops, so a 0.25 cobble still has its top at +0.5.
   - Greedy tiling: scan rows, try the largest variant footprint first (8×8 … 2×2 … 1×1), and require that all covered cells share material, height, theme, and walkability and are unused.
   - Rotation is `random90` (seeded per cell) for square tiles.
   - Water tiles are surfaces (0.5 thick, same rule). A per-role `offset.y` in the palette can lower them once the visual calibration is done.
2. **Fill and cliffs.** For a cell with height h > the minimum ground height of its 4-neighbours (open cells, floorless ones included, and the ground recorded under bridge decks; non-open = 0), stack `fill.<material|default>` courses (`stack.unitHeight`, usually 0.5) from that minimum up to h. Where the drop is 1 tile or more a **cliff body** is stacked instead: `cliff.<material>` / `cliff.default`, or for natural ground (rock, dirt, gravel, mud, sand, grass, snow, ice, swamp, lava) `cliff.natural` — whole-cell 1×1 blocks from the top down (placement role `ledge`), else fill with an info note. Bridge decks get no fill (open air): the deck tile, plus a 1×1 `floor.<material beneath>` tile at the recorded height. Cells of any material on a 3×3 lattice get `glow.<material>` / `feature.<material>_glow` when the palette has one (lava glows today).
   - **Stairs**: on every `EDGE.STAIR` a `link.stairs` piece (rise 0.75–1.25) or `step.<material>`/`step.default` (smaller rises; none = the riser is fill) stands in the lower cell, climbing toward the higher one. **Piers**: `pier.<material>`/`pier.default`, else fill courses, from the ground to the deck. **Foundation** (generator 2): outside the level bounds the ground counts as the level's lowest floor, so border cells get fill or cliff sides down to it, and rock columns start there; their tops vary by 0–2 blocks (seeded value noise). Cliff blocks stop at the lower floor; the remainder is fill.
   - **Wall span** (`resolve/wallspan.ts`, shared with verify and the wall-height passes): base = the lower floor top; top = wall height above the higher of the two floor tops and the reference floor (most common height) of the open side's area, so walls beside a chasm or pit reach the area's normal wall top. Railings stand on the deck. A full-cell (rock block) wall whose host cell is open goes into the other cell when that one is rock, void or outside the level (caves touching the level bounds); one column per rock cell spans every edge it closes. Edge-centre runs shorter than the shortest piece get that piece centred over them.
3. **Walls, openings, posts.** All of this is **confirmed in game**. Edge pieces are stored at the min corner of their *rotated* footprint, so rotation never selects which half of a cell a piece occupies:
   - rot 0 and 12 run east-west in the low-z (south) half;
   - rot 6 and 18 run north-south in the low-x (west) half;
   - north and east edges are reached with +0.5 on z or x.

   For each WALL edge with host cell H, the side of H the edge lies on is mapped to a world side, and `edgePlacement[side]` gives the two possible rotations and the offset:

   | Plan side (in H) | World side | `rotSteps` | Offset (x, z) |
   |---|---|---|---|
   | S | low z | 0 or 12 | (0, 0) |
   | N | high z | 0 or 12 | (0, 0.5) |
   | W | low x | 6 or 18 | (0, 0) |
   | E | high x | 6 or 18 | (0.5, 0) |

   The rest of the step:
   - **Rotation choice.**
     - Pieces whose `lengthAxis` is z add 6.
     - Walls look the same on both faces (confirmed), so they use the first value.
     - Doors choose by the palette `facing.handleEnd`. Verified: "Door - Dungeon" at rot 0 has its handle at the west end, and rot 12 at the east. The default preference is the handle at the west or north end; a per-opening preference can come later.
   - **Height.** y is the floor top of H's open neighbour (elevation + height + 0.5). Walls taller than a piece stack.
   - **Runs.** Straight runs with the same host side, style, and height use length-2 variants greedily.
   - **Openings** replace `width` edges with `opening.<kind>` (single or double; archway 2).
   - **Full-cell walls.** `mount: "full-cell"` roles (cave blocks) fill the host cell itself and require it to be non-OPEN; otherwise `thick_wall_conflict`.
   - **Posts.** At vertices where walls of different orientation meet, and at free wall ends, place `wall_post.<style>` (0.5×0.5) in the quadrant shared by the two host strips.
4. **Links.** `link.stairs` per run cell, rising 1 per cell along `dir`.
   - Rotation turns the palette's `facing.ascendsToward` (rot 0) to `dir`, clockwise in 15° steps. Verified: "Dungeon Stairs" ascend toward the west at rot 0, north at 6, east at 12, and south at 18.
   - If `rise` is not an integer, the extra 0.5 goes in as a top course of `fill`.
   - Ladders and trapdoors are a single asset.
5. **Features.**
   - `feature.<type>`, variant matched by name or chosen by seeded weight.
   - Props (`originAt` center) are placed at the footprint centre minus `boundsCenter` rotated, at y = floor top + `lift`. Tiles are placed at the min corner after rotation.
   - Rotation turns the asset's rot-0 `facing.front` to the feature's facing (`rot`; 0 = front faces south). Wall-mounted props turn `facing.mountsOn` toward the wall. Organic props use `rotFine`.
   - A prop's front is still **unverified**: the default is `defaultFacing["feature"] = {front: "S"}`, a data edit once verified.
   - Organic props keep `minSpacing` apart, because overlapping props can vanish on paste (research §5).
6. **Diagnostics** are aggregated with `count`.

### 4.4 Orientation calibration (one data file)

`packages/core/data/orientation.json` (`OrientationCalibration`) holds every global convention:
- confirmed in game on 2026-11-18: `flipZ: true`, `rotSense: +1` (clockwise), and `edgePlacement` (min-corner rule with +0.5 for N/E);
- `defaultFacing` per role prefix;
- `pasteAnchor` (unknown; doesn't affect chunking);
- a `verified[]` log.

**Per-asset** orientation lives in the palette as `PaletteFacing` on the role or variant (`front`, `ascendsToward`, `handleEnd`, `mountsOn` at rot 0), because assets differ. Verified entries: Dungeon Stairs `ascendsToward: "W"` and Door - Dungeon `handleEnd: "W"`. A prop's front side is unverified.

A user override lives at `userData/orientation.json`. Golden tests pin the bundled file. A changed file changes `BuildRecord.settings.orientationHash`, which marks builds stale.

### 4.5 Slab codec

Implemented from research §2 and owned by WP3 in `core/src/slab/`.

**Encode:**
1. Normalize with **one shared offset**: whole tiles horizontally, 0.25 steps vertically.
2. Quantize with `round(v·100)`; check 0 ≤ s ≤ 262143 and rot 0..23.
3. Group by uuid and sort layouts by lowercase uuid.
4. Write `D1CEFACE`, v2, layoutCount, creatureCount 0, the layouts (uuid in .NET `Guid.ToByteArray` order), then u64 instances (BigInt), then the `u16 0` trailer.
5. gzip (fflate, level 9, mtime 0, so output is deterministic) and standard base64 without fences.

**Decode** is public API. It handles v2 and legacy v1, accepts fences and surrounding whitespace, and preserves unknown uuids (`DecodedSlab`).

The research suggested Node `zlib`; fflate keeps core platform-neutral. Byte equality with the vectors is required on the **raw** payload, because gzip bytes differ between compressors.

**Acceptance.** All vectors in `data/slab-test-vectors.json` (2 MIT-licensed external v2 vectors; the 15-vector research set is not redistributed), plus self-generated v2 slabs and a hand-built v1 payload in the tests:
- decode(slab) gives the expected counts and instances, and the raw sha256 matches;
- encodeRaw(decoded) is byte-exact with the decompressed payload for every v2 vector;
- decode(encode(x)) == x as a property test (fast-check).

### 4.6 Chunking and alignment

For a build, compute the **global** bounds of all placements over all levels (stacked, or side-by-side with levels offset east by width + `sideBySideGap`). Markers follow UX §8.6.2: they are used when the build has more than one chunk (`alignment: "multi-chunk"`), and a single-chunk map gets none unless the user picks "always". Then:

1. Add two `marker.alignment` tiles to **every** chunk: one at `(minX−1, minY, minZ−1)` and one at `(maxX+1, maxYtop, maxZ+1)`. Every chunk then has an **identical bounding box** in all three axes, whether the game anchors on the min corner or the centre.
   - Research §5 put both markers at y=0. Raising the second marker to the top is an extension so that vertical extents match too; this needs in-game confirmation.
   - Normalize all chunks with one shared offset.
   - Generator 4 on (`pasteBesideMap`, decisions.md 2026-11-21): TaleSpire pastes at the box centre, and a chunk landing on a piece an earlier chunk put under the cursor sits high. So a multi-chunk build moves its markers (`besideMapBox`) until the centre is the middle of a bare cell 5 cells south of the middle of the map's south edge (4 empty cells between); the min marker then stands about a map depth south of the anchor. `ExportBundle.pasteAnchor` says so to the UI.
2. Each level is split into rectangular whole-cell regions. Start from the level's occupied bbox. Each placement belongs to its **source cell**: the min cell of floors, the host cell of walls, the anchor cell of features. Encode for real; if `compressedBytes > 0.8 × 30720` (about 24.5 KB), split along the longer axis at the median source-cell coordinate and recurse.
3. If a single cell is still too large, the result is a `chunk_oversize` error. That should never happen.
4. Chunks are ordered by level (entry level first, then by elevation) and then by row-major region order. Each gets a label (West, Centre, East, or a grid position), ruler columns, `offsetFromFirst`, and a `contentHash` (sha256 of the raw payload).
5. **Paste instructions** (per research §5):
   - Use an empty board or a build plane.
   - Don't move the camera.
   - Paste every chunk with the cursor on **the same cell**, the marker cell.
   - Right-click between chunks.
   - Delete the markers at the end.

   The UX's per-seam markers (§9.4) are replaced by this scheme; the paste-guide copy should become "aim at the marker".

### 4.7 Errors, warnings, CLI

- Every stage returns diagnostics; none throws for bad content. A build is refused only on plan validation errors or `coord_overflow`.
- The CLI:
  - `slabyrinth compile plan.json --palettes dir --out dir` writes chunk `.txt` files and `report.json`.
  - `slabyrinth decode <slab>` prints layouts with names when `--catalog` is given.
  - `slabyrinth ascii plan.json --level l1` prints the ASCII view.
  - `slabyrinth catalog --install <path>` builds a catalog from an install.
  - `slabyrinth calibration` regenerates a calibration slab from the palette.

---

## 5. 2D rendering

### 5.1 Pipeline

```
ResolvedLevel ──buildDisplayList(opts)──► DisplayList ──drawDisplayList(ctx, list, MapTheme, view)──► pixels
     (core, pure; runs in resolve.worker)            (packages/render-canvas; on-screen or OffscreenCanvas)
```

The display list holds layered items: geometry rings in cell units, symbol references (`feat-<type>`, `door-<kind>`, `link-<kind>`), and text. Colours are semantic style tokens. Walls are drawn as filled half-cell strips in the host cell, plus a heavier stroke for exterior walls, matching UX §6.2 cues: hatch for rock, waves for water, dashed walls plus an S for secret doors.

**Depth (2026-11-19).** Height shading is graded: floors below the level floor darken with every quarter tile (alpha up to 0.62 at 4 tiles), raised floors stay subtle. LEDGE edges under 1 tile are dashed lines (`ledge`); drops of 1 tile or more are `cliff` segments, one per edge, directed so the low side is on the right, drawn as a heavy ink line with hachures toward the drop. Each bridge is an outline with planks across it (`bridge-h` / `bridge-v`, layer `ledge`, ref = bridge id); broken deck cells show the ground beneath (lava, chasm floor). The legend has Cliff and Bridge entries.

### 5.2 Canvas instead of SVG

This departs from UX §6.1's "SVG renderer". The user requires that the interactive view and PNG export come from **one** drawing routine at arbitrary scale with a theme independent of the app's. A Canvas 2D routine over a structural `Canvas2DLike` interface does both:
- on screen, with viewport culling;
- in an `OffscreenCanvas` for export;
- later, a Skia or node-canvas backend could give CLI PNGs.

Rasterizing SVG for export would need inlined CSS variables and fonts and a second code path. Thousands of trees are cheap on Canvas. Hit-testing does not need the DOM, because it is pure (`hitTest(level, point)`). Accessibility comes from the room key and a hidden accessible list of rooms and features (UX §13.3).

### 5.3 Themes

`MapTheme {id, colors: token→CSS colour, lineScale, fontFamily}`.
- Bundled themes: `parchment-dark` (default for the dark app theme), `parchment-light`, `print` (the light, high-contrast PNG Print style, UX §6.10), and `ink-on-white` (v1.1).
- Required tokens: `paper`, `rock`, `hatch`, `void`, `floor`, `grid`, `ink`, `wall`, `wall-exterior`, `door`, `secret`, `water-shallow`, `water-deep`, `path`, `forest`, `light`, `accent`, `select`, `label`, `label-halo`, and one `mat-<material>` per material.
- The app theme setting (`dark`|`light`|`system`, default **system**) chooses the map theme when `mapThemeId` is `auto`.
- Fonts are bundled; there are no remote fonts.

### 5.4 Interaction

- **Coordinates.** Pointer → cell is `(px − offsetX)/scale`. Zoom runs 25–400%, with 24 px per cell at 100%.
- **Hit-testing.** On click: feature, then opening (within 0.2 cell of its edge), then link, then area, then cell. Hover runs `hitTest` throttled to animation frames.
- **Selection.** Selection produces `MapSelection` for chat chips.
- **Compare.** `diffPlans(vA, vB).areas` drives the outlines.
- **Rendering performance.** The display list is cached per (planId, version, level, options), and only the visible region is redrawn. A 160×160 level with 4,000 trees must hold 60 fps pan and zoom; that is an acceptance test.

### 5.5 PNG export

1. The renderer builds the display list with `PngExportOptions`: levels, version, px per square (default 70 per UX, with each side clamped to ≤ 16384 px), grid, room numbers and names, furniture, GM layer (off gives a player-safe image), legend, an optional room-key side panel, map theme (`print` or the screen theme), and background. The last-used options are saved in `ProjectFile.pngExport`.
2. It draws into an `OffscreenCanvas` and calls `convertToBlob({type:"image/png"})`.
3. It sends the bytes through `export:savePng`. Main shows the native save dialog (one file, or a folder for all levels named `<project>-<level>.png`) and writes atomically.
4. The same routine at 1024 px max serves `view_map_image` for the model through `render:requestImage`.

---

## 6. Desktop application

### 6.1 Processes and services

- **Main** (Node, ESM). It holds the services listed in the §1 diagram.
  - `ProjectService` owns the authoritative project state.
  - The engine and the UI both mutate state only through it.
- **Workers.**
  - Main: `compile.worker` and `catalog.worker`.
  - Renderer: `resolve.worker`, which runs core resolve and `buildDisplayList` per version and posts typed arrays.
- **Preload.** It exposes `window.slabyrinth = { invoke, on, send }` as typed by `ipc.ts`, and nothing else.
- **Single instance.** `app.requestSingleInstanceLock()`; a `second-instance` event opens the `.slabyrinth` path from argv. The file association is registered by electron-builder.

### 6.2 IPC contract

The full list is in `ipc.ts`. Summary:

| Group | Channels |
|---|---|
| app / settings | `app:getInfo`, `settings:get`, `settings:update` · event `settings:changed` |
| secrets | `secrets:setApiKey` (write-only), `secrets:clearApiKey`, `secrets:status` |
| providers / models | `providers:list`, `providers:check`, `models:list` |
| project | `project:new`, `open`, `saveCopyAs`, `rename`, `duplicate`, `trash`, `revealInFolder`, `close`, `snapshot`, `list`, `importPlan`, `exportPlan` · events `project:changed`, `menu:command` |
| plan / history | `plan:applyOps`, `undo`, `redo`, `restore`, `getVersion`, `diff`, `approve`, `editText`, `brief:update` · event `plan:changed` |
| chat | `chat:send`, `estimate`, `cancel`, `retry`, `continue`, `selectAlternative`, `previewSwitch`, `setSelection`, `setEffort`, `newConversation` · event `chat:event` (turn/step lifecycle, deltas, tool calls, progress, brief updates, question cards, notices, usage, finish/fail) |
| build / export | `compile:estimate`, `compile:run`, `compile:cancel`, `build:setPasted`, `build:saveChunk`, `export:savePng`, `export:roomKeyMarkdown`, `clipboard:writeText` · event `compile:progress` |
| TaleSpire / assets | `catalog:status`, `catalog:refresh`, `talespire:locate`, `setPath`, `copyAndOpen`, `isRunning`, `openUrl` · events `catalog:changed`, `catalog:warning` |
| palettes | `palettes:list`, `reload`, `openFolder` |
| image bridge | event `render:requestImage` → send `render:imageResult` |
| shell | `shell:openExternal` (https allowlist) |
| updates | `updates:status`, `updates:check` (`manual`), `updates:skip` · event `updates:available` |

**Handler rules.**
- Every handler validates its payload with Zod.
- It checks that `event.senderFrame.url` starts with the app origin (`file://…/index.html` or the dev server).
- It returns `Result<T>` and never throws across IPC.
- Streaming events carry `turnId`; the renderer ignores events for stale turns.

### 6.3 Renderer state

React 19 with Zustand stores:

| Store | Contents |
|---|---|
| `projectStore` | Snapshot mirror; applies `plan:changed` and `project:changed` |
| `chatStore` | Items, in-flight stream buffers per turn and step, question cards, estimates |
| `mapStore` | Active level, zoom/pan, layers, selection, compare target, hover |
| `buildStore` | Last bundle and records, pasted ticks, guide step |
| `settingsStore`, `catalogStore` | Settings and catalog status |

The stores are derived from IPC only. The renderer never computes authoritative state, except display geometry, which is pure core.

### 6.4 Persistence

**Projects** are `.slabyrinth` files: UTF-8 JSON, `ProjectFile`.
- **Location.** The default folder is `Documents/Slabyrinth` on both OSes, and it can be changed. There is no Save command (UX §8.7).
- **Autosave** runs on every change, debounced to 1 s, and is flushed at the end of each turn and on quit.
- **Crash-safe write.**
  1. Write `<file>.tmp-<pid>`, `fsync`, rename over the target (Windows `fs.rename` replaces atomically on the same volume).
  2. Keep one `<file>.bak`, the previous good copy, rotated before the rename.
  3. On open, if JSON parsing fails, offer the `.bak`.
- **Read compatibility.**
  - A gzip-magic file is decompressed transparently, for future zipped saves.
  - `formatVersion` greater than supported shows UX 10.12 "newer version".
  - An older version goes through `migrateProject` step by step (pure functions in core, with golden fixtures per version).
  - Unknown `x-*` keys are preserved.
- **Recent projects and Home.** The index lives in settings (`projects.recent`, at most 10). Home (UX §8.9) combines it with a folder scan. Thumbnails are stored in the project (`thumbnail`) and regenerated when missing. `settings.ui.onLaunch` chooses between Home and reopening the last project.
- **Resume state** is in the file:
  - `ui`: tab, level, zoom/pan, room-key scroll, brief expanded, composer draft with references, last activity;
  - `pasteGuide` (build id and step);
  - `pngExport` options;
  - builds with copied/pasted state;
  - `pendingQuestions`;
  - per-turn usage in `meta`.

  On reopen, the thread shows a "Where we left off" recap computed locally from the last version summaries; no AI call.
- **Locking.** On open, the app takes a lock by writing a sidecar `<file>.lock` with pid and host. If the file is already open in this app, it focuses that window.

**Other files under `userData`:**

| Path | Contents |
|---|---|
| `settings.json` | Settings, schema `slabyrinth/settings@1` with migrations |
| `secret.bin` | Encrypted API keys |
| `catalog/catalog.json` | Asset catalog, schema `asset-catalog@1` with `extractorVersion` |
| `palettes/` | User palettes and overrides |
| `orientation.json` | Optional orientation override |
| `logs/` | Rotating, 5 × 1 MB. Never contains keys; prompts only with debug logging on. |
| `thumbs/` | Project thumbnails |
| `meshes/` | The 3D piece cache: shapes of TaleSpire's pieces, read from the user's own install (read-only), kept on this machine only, never sent anywhere and never bundled with the app. At most 512 MB, least recently used dropped first; Settings can clear it (only this folder, when it holds nothing but its own files). 3D pictures sent to Claude leave the PC like any map picture. |

### 6.5 Security posture

- **BrowserWindow:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, `webviewTag: false`, `spellcheck: false`.
- **CSP** (production, set through `session.webRequest.onHeadersReceived` and a meta tag):
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`.
  In development, `connect-src` also allows the Vite dev server's http and ws.
- **No remote content.** `will-navigate` is denied, `setWindowOpenHandler` returns deny, and `session.setPermissionRequestHandler` denies everything.
  - `shell:openExternal` allows only https to `console.anthropic.com`, `docs.claude.com`, `platform.claude.com`, `github.com/mwaboff/slabyrinth`, and `talespire.com`.
  - `talespire:openUrl` allows only `talespire://asset/<uuid>` and `steam://rungameid/720620`.
- **API keys.**
  - Keys go `safeStorage.encryptString` → `secret.bin`, held per provider. They are decrypted only in main, at request time. `secret.bin` and its temp file are created with mode `0o600` on POSIX.
  - Keys never reach the renderer, logs, or project files.
  - On Linux, `safeStorage.getSelectedStorageBackend()` returning `basic_text` triggers the UX 8.3 choice ("Store anyway" or "memory only").
  - The SDK client is built with an explicit `apiKey` and an explicit `baseURL` of `https://api.anthropic.com`, so no environment variable (`ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, …) can send the key elsewhere. `ANTHROPIC_API_KEY` from the environment is honoured only in development builds, never in smoke/e2e runs, and a stored key always wins. Proxy and CA variables (`HTTPS_PROXY` with `NODE_USE_ENV_PROXY`, `NODE_EXTRA_CA_CERTS`) are outside the app's control and accepted: whoever can set them already runs code as the user.
- **Model output** is treated as untrusted. Notes are rendered as a markdown subset with sanitization: no HTML, and links shown as text.
- **Network.** The app talks to `api.anthropic.com` (chat, with your key) and makes one anonymous request to GitHub to check for a new version, at most once a day, which can be turned off (Settings ▸ About ▸ "Check for updates automatically"). Nothing else: no telemetry, no accounts.
- **Updates.** A notice, not an installer (builds are unsigned). `UpdateService` in main sends one GET to `https://api.github.com/repos/mwaboff/slabyrinth/releases/latest` (drafts and prereleases excluded) with only `Accept` and `User-Agent: Slabyrinth/<version>` — no key, no identifiers, no map data. The host is pinned (https; a redirect is followed only to `api.github.com`), with an 8 s timeout, a 256 KB cap and a zod-validated body. The startup check runs in packaged builds only, never in smoke/e2e runs, at most once per 24 h (`settings.updates.lastCheckedAt`) and only with `updates.autoCheck`; "Check for updates" ignores the throttle. Failures are a quiet "couldn't check" state. A newer stable version shows a header chip; its popover shows the release notes as an allow-listed Markdown subset of plain text (headings, lists, bold, italic, code; never HTML, links not clickable, no images; `shared/releaseNotes.ts`) and opens `https://github.com/mwaboff/slabyrinth/releases/tag/<tag>` (built in main from the validated tag, then checked by the `shell:openExternal` allow-list). "Skip this version" is stored as `updates.skippedVersion`. Auto-install is v1.1 at the earliest (needs signed builds).

### 6.6 TaleSpire integration

**Locate** (`TaleSpireService`), following research `talespire-assets.md` §3:
- *Windows*: `reg.exe query HKCU\Software\Valve\Steam /v SteamPath` (falling back to HKLM WOW6432Node `InstallPath`, then the default path), then `steamapps/libraryfolders.vdf` (core contains a KeyValues parser), then `appmanifest_720620.acf` `installdir`.
- *Linux*: probe `~/.steam/steam`, `~/.steam/root`, `~/.local/share/Steam`, the Flatpak and Snap paths, with the same VDF logic.
- *Manual*: "Browse…".

**Asset library** (`CatalogService`, runtime data):
- **Fingerprint.** On startup, fingerprint every `Taleweaver/<pack>/index` and `index.json` (size, mtime, sha256; the sha only when size or mtime changed).
- **Rebuild.** If the fingerprint differs from the cached catalog's, rebuild in `catalog.worker`:
  - per pack, `CatalogSource` `binary-index` is primary (the research is documenting the format; magic CE D1 CE D1 v5);
  - `index-json` is the fallback, because game updates have refreshed only the binary index while `index.json` stayed stale.
- **Report.** Compute a `CatalogChangeReport` (added, removed, newly deprecated, geometry changed, affected palette roles) and show it as a toast with details in Settings ▸ TaleSpire.
- **Refresh.** A manual "Refresh asset library" calls `catalog:refresh`.
- **No install or parse failure.** A non-blocking `catalog:warning` banner says the app is "using built-in asset set; you won't have the latest asset library" and offers [Locate TaleSpire…]. Everything else works from the bundled palettes.

**Copy & open** (`talespire:copyAndOpen`):
1. Main writes the clipboard (`clipboard.writeText`).
2. It detects whether TaleSpire is running: Windows `tasklist /FI "IMAGENAME eq TaleSpire.exe" /FO CSV /NH`; Linux, scan `/proc/*/cmdline` for `TaleSpire.exe`.
3. **Running:** v1 focuses the game window with PowerShell `AppActivate(<pid>)` (run through `execFile` with no shell, a timeout, and an integer-checked pid). If that fails it returns `focus_unavailable` with "Switch to TaleSpire (Alt+Tab) and press Ctrl+V". It never sends a `steam://` or `talespire://` URL to a game that is already running.
4. **Not running:** launch through `shell.openExternal("steam://rungameid/720620")`.
5. Either way, the paste guide is shown.

The researcher's launch-options note may refine steps 3 and 4. There is no board or slab import URL, so "Open in TaleSpire" means copy plus launch.

---

## 7. Repository, build, CI

### 7.1 Layout (npm workspaces, single lockfile)

```
slabyrinth/
├─ package.json                 private; workspaces ["packages/*", "apps/*"]; scripts below
├─ package-lock.json
├─ tsconfig.base.json           strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, ES2023, moduleResolution bundler
├─ eslint.config.js             typescript-eslint strict-type-checked, react-hooks, import boundaries
├─ .prettierrc  .editorconfig  .nvmrc (26)  .gitignore (data/talespire-assets.json, release/, out/, *.tmp-*)
├─ vitest.workspace.ts
├─ docs/                        architecture.md, ux-design.md, talespire-*.md, contracts/*.ts, mockups/
├─ data/                        research artefacts: palette-draft.json, slab-test-vectors.json, calibration-slab.txt
│                               (talespire-assets.json is gitignored)
├─ tools/research/              PowerShell reference tools (SlabCodec.ps1 …)
├─ packages/
│  ├─ core/                     @slabyrinth/core — NO electron/DOM; node:* only in src/cli
│  │  ├─ src/contracts/         plan.ts ops.ts resolved.ts compiler.ts (verbatim copies)
│  │  ├─ src/plan/              zod schemas, validate, limits, migrate
│  │  ├─ src/ops/  src/history/ applyOps, diffPlans, history pointer ops, keyframes
│  │  ├─ src/util/              hash (fnv), prng (sfc32/splitmix), canonical json, partial-json
│  │  ├─ src/resolve/  src/gen/ resolver, rasterizers, generators, dress presets
│  │  ├─ src/render/            buildDisplayList, hitTest, symbols catalog (no drawing)
│  │  ├─ src/text/              outline, ascii, change report formatting
│  │  ├─ src/palette/  src/catalog/  palettes load/merge/resolve, CatalogSource (binary, json), VDF parser
│  │  ├─ src/compile/  src/slab/ realize, chunk, bundle; codec (encode/decode public)
│  │  ├─ src/agent/             tools.ts (copy), system prompt, executor, jsonProtocol, progress parser
│  │  ├─ src/cli/               bin entry (node:fs allowed)
│  │  ├─ data/                  palettes/*.json (bundled defaults), orientation.json
│  │  ├─ scripts/               import-palette-draft.ts
│  │  └─ test/                  unit/ golden/ fuzz/ fixtures/
│  └─ render-canvas/            @slabyrinth/render-canvas — drawDisplayList, MapThemes, symbol painters
└─ apps/
   └─ desktop/                  electron-vite app
      ├─ electron.vite.config.ts  electron-builder.yml  build/ (icons)
      ├─ src/shared/            ipc.ts project.ts (verbatim copies)
      ├─ src/main/              index.ts window.ts menu.ts security.ts ipc/*.ts services/*.ts workers/*.ts
      │  └─ agent/              engine.ts estimate.ts provider/{types.ts (copy of provider.ts), registry.ts,
      │                         anthropic/{provider.ts, render.ts, models.ts, pricing.ts, errors.ts}}
      ├─ src/preload/index.ts
      ├─ src/renderer/          index.html main.tsx app/ features/{setup,chat,brief,map,roomkey,history,
      │                         build,paste-guide,settings,projects}/ stores/ workers/resolve.worker.ts styles/
      └─ scripts/agent-eval.ts  headless eval harness (Node, real API key; not in CI)
```

### 7.2 Scripts and tooling

**Root scripts:**
- `dev` runs `npm run dev -w apps/desktop` (electron-vite dev).
- `build` builds core (tsc), then render-canvas, then electron-vite.
- `typecheck` runs `tsc -b`; `lint` runs ESLint; `format` runs Prettier.
- `test` runs `vitest run`; `test:golden:update`.
- `package` runs `electron-builder --dir`; `dist` runs `electron-builder --win --linux` (per OS in CI).

**Lint boundaries.** `no-restricted-imports` keeps `electron`, `node:*`, and `react` out of `packages/core/src/**`, except `cli/`. Core's tsconfig uses `lib: ["ES2023"]`, so it has no DOM types.

### 7.3 Tests

| Kind | Where | What |
|---|---|---|
| Codec vectors | core/test/unit/slab | All 15 vectors: decode, byte-exact raw re-encode, sha256; property round-trip |
| Plan schema / validation | core/test/unit/plan | Every issue code has a failing fixture and a hint assertion |
| Ops / history | core/test/unit/ops | Each op; cascade; transaction rollback; undo/redo/restore pointer semantics; key auto-assignment |
| Generators | core/test/golden/gen | Frozen outputs per seed (cave, blob, noise, scatter, dress, route) |
| Resolver | core/test/golden/resolve | Examples A and B plus 10 fixtures → canonical ResolvedPlan snapshots; host and wall rules |
| Text views | core/test/golden/text | Outline and ASCII snapshots |
| Compiler | core/test/golden/compile | Placement snapshots per fixture; chunk sizes ≤ limit; markers identical bbox; deterministic slab strings |
| Fuzz | core/test/fuzz | fast-check plans and op sequences: validate never throws; resolve is deterministic (twice equal); valid plans compile without throwing; applyOps never yields an invalid committed plan |
| Agent | core/test/unit/agent | Tool schemas are deterministic (snapshot of serialized bytes, which is the cache key); executor error formatting; JSON protocol parsing |
| Provider | apps/desktop main tests | Anthropic render: transcript → messages (fixtures with thinking, fallback, compaction blocks); error mapping; pricing; with a mocked SDK stream |
| Renderer | apps/desktop renderer | Component tests (jsdom) for chat stream reducer, pill, room key; hit-test integration |
| E2E smoke | Playwright `_electron` | App boots, new project, load fixture plan, render, compile, copy. CI on Linux under xvfb. |
| Live | `agent-eval` (manual) | 10 briefs × models → validation error rate, retries, tokens, cost |

### 7.4 electron-builder (`apps/desktop/electron-builder.yml`, outline)

```yaml
appId: app.slabyrinth.desktop
productName: Slabyrinth
directories: { output: release, buildResources: build }
files: ["out/**", "package.json"]
extraResources:
  - { from: "../../packages/core/data", to: "data" }      # bundled palettes + orientation (no catalog)
extraFiles:             # licences of the bundled fonts and npm packages (scripts/third-party-notices.ts)
  - { from: third-party/THIRD-PARTY-NOTICES.txt, to: THIRD-PARTY-NOTICES.txt }
asar: true
fileAssociations:
  - { ext: slabyrinth, name: "Slabyrinth project", mimeType: application/x-slabyrinth+json, role: Editor }
win:
  target: [ { target: nsis, arch: [x64] }, { target: portable, arch: [x64] } ]
  icon: build/icon.ico
nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
        artifactName: "${productName}-Setup-${version}.${ext}" }
portable: { artifactName: "${productName}-${version}-portable.${ext}" }
linux:
  target: [ { target: AppImage, arch: [x64] } ]
  category: Game
  icon: build/icons
  artifactName: "${productName}-${version}-${arch}.${ext}"
publish: null          # CI uploads artifacts itself
```

Pin the latest stable Electron at scaffold time, together with electron-builder and electron-vite.

### 7.5 GitHub Actions

`.github/workflows/ci.yml` runs on push to main and on pull requests:

```yaml
jobs:
  test:
    strategy: { fail-fast: false, matrix: { os: [ubuntu-latest, windows-latest] } }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 26, cache: npm }
      - run: npm ci
      - run: npm run lint && npm run typecheck
      - run: npm test
      - run: npm run build
      - if: github.event_name == 'push'          # package smoke only on main pushes (saves minutes)
        run: npx electron-builder --dir --publish never
        working-directory: apps/desktop
      - if: runner.os == 'Linux'
        run: xvfb-run -a npm run test:e2e -w apps/desktop
```

`.github/workflows/release.yml` runs on `push: tags: ['v*']`:
- **build** (matrix: windows-latest, ubuntu-latest):
  1. checkout, setup-node, `npm ci`, test, build;
  2. check that the tag equals `apps/desktop/package.json` version;
  3. `electron-builder --win` or `--linux --publish never`;
  4. `actions/upload-artifact@v4` (`release/*.exe`, `*.AppImage`, `latest*.yml`).
- **release** (needs build, ubuntu, `permissions: contents: write`): `actions/download-artifact@v4`, then `softprops/action-gh-release@v2` with `files: artifacts/**`, `generate_release_notes: true`, and prerelease when the tag contains `-`.

Separate build and release jobs avoid two matrix jobs racing to create the same Release.

**Minutes.**
- Public repositories get standard GitHub-hosted runners free and unlimited.
- Private repositories on GitHub Free get 2,000 minutes per month, with Windows billed at a 2× multiplier and Linux at 1×. Verify the current billing page, because GitHub adjusted Actions pricing in 2026.
- Expect about 12 minutes of Windows plus 8 minutes of Linux per release, and about 15 minutes per CI run.

**Unsigned binaries.**
- Windows SmartScreen shows "Windows protected your PC / Unknown publisher" for both the NSIS installer and the portable exe, until enough downloads build reputation or the user buys an OV/EV code-signing certificate (or uses Azure Trusted Signing).
- AppImage needs `chmod +x`. On Ubuntu 22.04+ it needs `libfuse2` (`libfuse2t64` on 24.04), or the user runs `--appimage-extract-and-run`.
- Document both in the README and the release notes.

**Versioning.**
- SemVer. A single app version lives in `apps/desktop/package.json`, mirrored in the root and in core with `npm version` via a script.
- Tags are `vX.Y.Z`.
- Schema versions (`plan@1`, `project@1`, `palette@1`, `orientation@1`, `asset-catalog@1`, `settings@1`) are independent and migrated by core.
- `systemPromptVersion` and `toolsVersion` are recorded per conversation.

### 7.6 Development and test modes

- **Conversation engine.** Every build runs the real engine (`apps/desktop/src/main/agent`) with the
  Anthropic provider, keyed from the API key stored in Settings (development builds also accept
  `ANTHROPIC_API_KEY` from the environment; smoke and e2e runs never do). Without a key, chat answers
  the typed `no_api_key` error and the UI asks for one. Wiring: `src/main/engineWiring.ts`.
- **No second engine.** The recorded-stream fake engine was removed: tests and e2e drive the real engine
  with a scripted provider (below), and renderer work without Electron uses the fake bridge.
- **Smoke and e2e.** `SLABYRINTH_SMOKE=1` boots hidden, runs self-checks (including "chat answers
  `no_api_key`" and "packaged build uses the real engine and compiler"), prints `SMOKE_OK` and exits.
  `SLABYRINTH_E2E=1` is the Playwright mode. Both use a throwaway `userData` folder (or
  `SLABYRINTH_USER_DATA`) and inert doubles for every outside effect: no dialogs, a memory clipboard,
  no TaleSpire lookup, launch or focus. `e2e/conversation.spec.ts` drives the real engine through the
  real IPC with a scripted provider (`SLABYRINTH_E2E_PROVIDER_SCRIPT`, test runs only): no network,
  no API cost. It only exists in test builds (`npm run build:test -w @slabyrinth/desktop`, output in
  `apps/desktop/out-test`); production bundles (`out/`, packaged) contain no test code, and the packaged
  smoke run checks that.
- **Packaged smoke run.** After `npm run package`, `npm run smoke:packaged -w @slabyrinth/desktop` runs
  the unpacked app once and passes on `SMOKE_OK`. It first checks that `THIRD-PARTY-NOTICES.txt`,
  `LICENSE.electron.txt` and `LICENSES.chromium.html` sit next to the executable.
- **Third-party notices.** `apps/desktop/third-party/THIRD-PARTY-NOTICES.txt` is generated by
  `npm run notices -w @slabyrinth/desktop` from the bundled packages (`scripts/third-party-notices.ts`)
  and the font licences in `site/assets/fonts/`; a unit test fails when it is stale or a bundled package
  is missing from it.
- **Asset catalog.** The full catalog (`data/talespire-assets.json`) is research data generated locally;
  it is gitignored and never bundled. Only the curated palettes in `packages/core/data` ship with the app.
- **Palette and orientation overrides.** A JSON file in `<userData>/palettes/` with `"overrides": true`
  and a built-in palette's id replaces those roles (`null` deletes one); any other file there adds a new
  theme. `<userData>/orientation.json` replaces the built-in orientation calibration. Invalid files are
  ignored and listed with their issues.

---

## 8. Work breakdown

### 8.1 Work packages (file ownership is exclusive)

| WP | Name | Owns | Delivers |
|---|---|---|---|
| **WP1** | Plan model | `packages/core/src/{contracts,plan,ops,history,util}/**`, `core/test/{unit/plan,unit/ops}`, root `tsconfig.base.json` | Contract copies, run through `tsc`. Zod schemas mirroring `plan.ts`. `validatePlan` (resolver-independent checks plus the geometric checks the caller passes in, built by WP2's `planRules(palettes)`). `applyOps` with key auto-assignment and cascades. History pointer operations, keyframes and replay. `diffPlans`. Plan and project migrations framework. hash, prng, canonical JSON. |
| **WP2** | Geometry & 2D | `core/src/{resolve,gen,render,text}/**`, `packages/render-canvas/**`, golden tests for those | `resolvePlan` (§2.4–2.7) and geometric validation checks. `buildDisplayList`, `hitTest`, outline and ASCII views, `drawDisplayList`, the three MapThemes, symbol painters for the UX §6.2 vocabulary, PNG export helper. |
| **WP3** | Build | `core/src/{slab,palette,catalog,compile,cli}/**`, `core/data/**`, `core/scripts/**`, related tests | Codec (byte-exact). CatalogSource json now, binary when research lands. VDF parser. Palette load, merge and resolve. Draft import script. `orientation.json`. Realize, chunk and bundle. Estimate. CLI including `calibration`. |
| **WP4** | Agent | `core/src/agent/**`, `apps/desktop/src/main/agent/**`, `apps/desktop/scripts/agent-eval.ts` | System prompt, tool definitions and executor, JSON protocol, progress parser. ConversationEngine, ProviderRegistry, AnthropicProvider (render, stream, errors, models table, pricing, cost), estimates. Eval harness. |
| **WP5** | Desktop shell | `apps/desktop/src/main/**` except `agent/`; `src/preload/**`; `src/shared/**`; `apps/desktop/{electron.vite.config.ts,electron-builder.yml,build/**,package.json}`; root `package.json`, eslint, prettier, vitest workspace; `.github/**` | Window, menu, security, IPC handlers (Zod), ProjectService (autosave, atomic writes, lock, migrate), SettingsStore, SecretStore, CatalogService, TaleSpireService, compile worker, export and dialogs, image bridge, logging. Packaging and CI from day 1. |
| **WP6** | Renderer UI | `apps/desktop/src/renderer/**` | All UX screens: setup, chat (stream, cards, pill, estimate), brief card, map view on render-canvas, room key, history and compare, build and paste guide, settings, projects dialog, PNG export dialog, dark and light themes. |

**Contract changes** go through the architect: edit `docs/contracts`, and every affected owner updates their copy. No WP edits another WP's files. Shared fixtures go in `packages/core/test/fixtures/`, owned by WP1; others add files by pull request with WP1 review.

### 8.2 Interfaces between WPs

- **WP1 → all:** contract types; `applyOps`, `validatePlan`, `diffPlans`, history functions.
- **WP2 → WP3, WP4, WP6:** `resolvePlan`, `buildDisplayList`, `hitTest`, `outline`/`ascii`, `drawDisplayList`.
- **WP3 → WP4, WP5:** `compilePlan`, `estimate`, `SlabCodec`, `loadPalettes`, `buildCatalog`, `AssetAvailability`.
- **WP4 → WP5:** `ConversationEngine` (constructed with ProjectService ports: `getProject`, `commitVersion`, `appendItems`, `emit`).
- **WP5 → WP6:** the IPC in `ipc.ts`.

Each consumer starts against stubs: a fixture `ResolvedPlan`, a fake engine that replays recorded event streams, and a fake IPC in the renderer driven by fixture snapshots.

### 8.3 Acceptance criteria (abridged; each WP's pull request checklist)

- **WP1:** all fixtures validate as specified; 10k fuzz op sequences never commit an invalid plan; undo/redo/restore match UX §7.2 semantics; tsc is clean on the contracts.
- **WP2:** examples A and B resolve to the golden snapshots; host rule test matrix passes; the same input gives identical bytes twice and across Windows and Linux CI; 160×160 with 4,000 features gives display list < 150 ms and 60 fps pan.
- **WP3:** 15 of 15 vectors pass; a compile of examples A and B is deterministic, with every chunk ≤ 24.5 KB and identical bboxes; the calibration slab from TS matches `data/calibration-slab.txt` content (layouts and instances); without a catalog, compiling from bundled palettes yields no errors.
- **WP4:**
  - recorded-fixture tests for render and replay byte stability;
  - the cache-hit assertion test (manual, with a real key);
  - the eval harness reports ≥ 90% of first drafts valid within 2 retries on Opus 5.5 at medium;
  - cancel, refusal, max_tokens, and fallback paths are covered with mocked streams.
- **WP5:**
  - signed-off security checklist (§6.5);
  - kill -9 during autosave never corrupts a project;
  - the CI and release workflows produce NSIS, portable, and AppImage builds that launch;
  - a missing TaleSpire install shows the warning, and the app still builds.
- **WP6:** every UX MVP row in §14 is implemented against the fake IPC, then against the real IPC; keyboard map per UX §13; dark default.

### 8.4 Order, dependencies, de-risking

Week 1 runs in parallel:
- WP1 publishes Zod schemas by about day 3.
- WP5 has the skeleton plus CI and packaging green on day 2.
- WP3 has the codec and vectors.
- WP2 has the rasterizers.
- WP6 has the shell UI against fixtures.
- WP4 has the prompt, tools, and the Anthropic adapter against a mocked SDK.

Then integration.

**Prove first, in this order:**
1. **Codec byte-exactness** (WP3, day 1–2). Already de-risked by the PowerShell reference.
2. **Pipeline round-trip in game.** The axis, rotation sense, edge placement, stair, and door conventions are already confirmed. WP3 generates a one-room plan (walls, corner posts, door, stairs, a few props) through the real TS pipeline, and the user pastes it. This confirms that the implementation matches the calibration, and it records the remaining unknown, prop "front", into the palette's facing data.
3. **Two-chunk, two-level alignment in game** with the corner markers, including the raised max marker.
4. **LLM authoring reliability** (WP4 harness) on 10 briefs. Tune the prompt and tool descriptions before building the UI around them.
5. **Packaging and unsigned install** on clean Windows 11 and Ubuntu 24.04 VMs (WP5, week 1).
6. **Renderer performance** on the largest map.

### 8.5 Top risks

| Risk | Impact | Mitigation |
|---|---|---|
| Per-asset facing unknown for assets other than the three verified (props' front, other door and stair kits) | Some props or doors face the wrong way | Per-asset `PaletteFacing` data, editable without a release; in-game round-trip (step 2) |
| Paste anchoring / vertical alignment across chunks | Misaligned multi-chunk maps | Identical-bbox markers; test step 3; per-level single chunk when possible |
| Binary index format changes with game updates | No fresh catalog | Catalog is optional; json fallback; palettes carry geometry; warning only |
| LLM spatial errors (overlaps, unreachable rooms, wrong stairs) | Frustrating loops | Primitives (`route`, `between`, computed `to.at`), hints, ASCII and images, validation gate |
| Palette coverage gaps (draft covers 5 themes) | Many `role_missing` | Fallback chain, `generic` base, report; prioritize coverage in WP3 |
| Beta API features (fallbacks, compaction, drop_block, per-message effort) change or are unavailable | Request 400s | Per-feature flags with automatic disable-and-retry; core loop works without any beta |
| Preserved-thinking violations from a harness bug | 400s on new accounts | Append-only design, `drop_block` in production, `error` in CI with replay tests |
| Prop overlap drops on paste | Missing trees or props | `minSpacing` defaults ≥ 1 for blocking organic props |
| Linux keyring absent | Weak key storage | UX 8.3 choice; memory-only mode |
| Unsigned builds deter users | Adoption | Document; budget for Trusted Signing later |
| Licensing of asset metadata | Repo takedown | Commit palettes (uuid, name, size) only; catalog generated locally (research §4) |

---

## 9. Future work (reserved seams)

### 9.1 LM Studio provider
See §3.12.

### 9.2 Imported slab stamps (not v1; reserved)

The feature: the user pastes a community slab (for example from TalesTavern), and it becomes an opaque **stamp** placed in the plan.

**Reserved seams:**
- `Level.stamps?: StampRef[]` (id, stampId, at, rot 0/90/180/270, lift, name, description, connections, notes). v1 accepts the field, rejects non-empty arrays with `stamp_unsupported`, and omits it on write.
- `ProjectFile.stamps: Record<stampId, StampAsset>`, holding the original string, the decoded normalized assets, and a summary. v1 writes `{}` and preserves unknown content.
- `SlabCodec.decode` is public and tested (v1 and v2, fences, unknown uuids preserved).

**Work, about 2–3 engineer-weeks:**
- Import UI: paste a string, preview, name, description, mark entrances.
- Footprint computation: decoded positions plus palette or catalog geometry; unknown uuids use 1×1 at their position.
- Resolver: stamp cells become OCCUPIED (a new flag), with edges toward stamp cells using wall mode `none` unless the user marks walls.
- Renderer: silhouette by occupancy and an outline with the name.
- Compiler: transform assets by 90° multiples around the footprint, using the min-corner rule for tiles and the centre for props, rotation index +6·k, and the same shared offset. Chunker: a stamp's assets belong to the cells they cover and count toward limits; a stamp larger than one chunk is split by cell like everything else.
- Model context: a stamp summary line in the outline (size, height, inventory by name, a coarse occupancy sketch, connection points) and an `edit_plan` op `add_stamp_ref`/`move`.
- Unknown uuids pass through untouched.

**Risks:**
- Unknown or community-pack uuids can't be named or sized.
- Rotating non-square tiles and props must exactly follow the unconfirmed rotation sense.
- Slabs authored off-grid (0.01 offsets) may not align with plan cells; snap the stamp origin to whole tiles.
- Very large stamps dominate the chunk budget.
- The legal and attribution status of community content: keep the source and author fields, and don't redistribute.

### 9.3 TaleSpire Symbiote bridge (not v1)

A small Symbiote (`interopId`, `runInBackground`) installed into the user's Symbiotes folder:
1. The app opens `talespire://symbiote/<prefix>/<jobId>`.
2. The Symbiote fetches chunks from a localhost HTTP server in main (CORS limited to the Symbiote origin; a random token in the URL).
3. It calls `TS.slabs.sendSlabToHand` for each chunk, with a "next chunk" button.

This removes the clipboard step but not hand placement. Open questions: whether the web view can reach 127.0.0.1, and the relay's URL length limit (send ids only). Effort is about 1 week plus distribution through mod.io.

---

## 10. Conflicts with teammates' documents (resolved here; flagged for review)

1. **UX §6.1 "SVG renderer" vs Canvas.** Chosen: Canvas 2D, so the interactive view and PNG export share one routine (§5.2). The visual vocabulary is unchanged.
2. **UX §8.6.1 automatic substitution** ("closest asset with the same role and footprint"). I disagree with searching the catalog automatically at build time: it makes the compiler depend on the catalog and can pick a wrong-looking piece. Chosen:
   1. curated `alternates` per palette variant;
   2. the role's `fallback` role;
   3. the `generic` theme;
   4. drop with a warning.

   The build still always succeeds, and `ExportBundle.substitutions` feeds the UX warning row ("Dungeon Wall 03 → Dungeon Wall 01, 38 places"). A catalog-based "closest asset" can appear as a **suggestion** in Settings ▸ Asset library for the later palette editor.
3. **UX "recommended mid-tier model (Sonnet)" vs the brief's default `claude-opus-5-5`.** Chosen: Opus 5.5 at medium, marked Recommended. Sonnet 5.5 is offered as the cheaper option. Needs a decision.
4. **UX §9.4 per-seam markers vs research's two global corner markers.** Chosen: corner markers, with the second raised to the top of the map (an extension; verify in game). Paste-guide copy must change.
5. **UX §8.7 "JSON, optionally zipped".** Plain JSON in v1; the reader accepts gzip.
6. **UX §5.6 "Stopping keeps streamed text".** Kept for display only and never sent back to the model.
7. **UX Smart effort.** Active only where per-message effort exists; a top-level flip would reset the cache each time.
8. **Research suggests Node `zlib`.** fflate is used so core stays platform-neutral. Acceptance compares raw payload bytes.
9. **`palette-draft.json` vocabulary.** It is kit-shaped (`wall_1`, `floor_2x2`, flat entries) rather than semantic roles. The import script maps it, and the gaps (materials, many features) are listed in WP3's report.
10. **UX data model.** Adopted: `pairedLinkId` is implicit (one link spans both levels); `elevationIndex` is derived; `number` is the plan-wide auto `key`; the `notes {readAloud, gm, encounter}` object is flattened to `readAloud`, `notes`, `encounter` for simpler ops. The UX undo semantics (head pointer plus `undone`) are adopted over my first draft's revert-as-new-version.
11. **"Open in TaleSpire".** The research shows there is no import URL. The UX §9.5 levels collapse to "Copy & open TaleSpire" plus the paste guide. Window focusing on Windows may be unavailable without native code.
12. **UX §16 shapes mapped, not copied.**
    - `messages[].references[]` is the user item's `MapSelection`.
    - `attachedVersionNumber` is `meta.versions`.
    - `questionCard.answers` are the ask_questions `tool_result`.
    - `rooms[].kind` area/yard map to zone/courtyard.
    - `walls[].type window` is an Opening `window`.
    - Link kind `shaft` is `pit_drop`.
    - Feature `other`+label is `custom`+hint+label, and `rack` is `weapon_rack`.
    - `validation[]` blocking/warning is `PlanIssue` error/warning, with "unreachable" escalated to blocking at approval.
    - `builds[]`, `pasteGuide`, `ui`, `pngExport`, `thumbnail`, and `assetSource`/`substitutions` are adopted as specified.
13. **UX §17 stamps.** UX keeps `stamps[]` with `placements[]` in the project. I split it: the stamp **asset** (slab string, inventory, silhouette, entrances) goes in `ProjectFile.stamps`, and each **placement** is a `StampRef` in the plan's level. Placements then get versions, undo, diff, and model visibility like every other element, and moving a stamp creates a version, as UX already wants. A cross-project "stamp library" would live in userData later.
14. **Corner markers** (UX §8.6.2: per level when it has more than one chunk). Mine are global, the same two markers in every chunk of the build, so stacked levels also align vertically. They are omitted only when the whole build is one chunk, or when the user turns them off.

## 11. Open questions (need a decision from you or the user)

1. Should levels be stacked at real heights or placed side by side by default in TaleSpire? (UX Q1; it affects marker placement and the paste guide.)
2. Should the default model be Opus 5.5 at medium (better plans, about 2× Sonnet's cost) or Sonnet 5.5?
3. Can the server-side beta features be enabled by default for users' own keys? These are refusal fallbacks to other Claude models, compaction, thinking binding, and per-message effort. The plan is "on, with automatic disable on 400".
4. Spending warning defaults: the UX suggests $0.25 per action and $2 per project.
5. How deep should GM notes go (UX Q2)? It affects prompt guidance and output cost.
6. Will the repo be public or private? This affects Actions minutes and the low-risk licence stance on committed palette uuids. Is code signing in budget?
7. Roofs for town buildings: v1 builds none (top-down play). Should roofs be an option later?
8. Calibration still pending in game: a prop's front side, the raised max marker (identical vertical extents), paste anchor point, and water surface height. Axes, rotation sense, edge placement, the Dungeon Stairs ascent, and the Door - Dungeon handle are confirmed.
9. PNG defaults (UX Q5): Print style vs screen style, and 70 px per square? Launch on Home or reopen the last map (UX Q6)?
