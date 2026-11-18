# TaleSpire asset catalog and generator palette

Status: research, 2026-11-18. The tags mean the same as in `talespire-slab-format.md`: [VERIFIED], [COMMUNITY], [INFERRED].

## 1. Where the asset index lives

Each official content pack has two index files in the install: a **binary `index`, which is the one game updates keep current**, and a plain `index.json`, which updates do **not** maintain. The app must read the binary file; §8 documents its format. [VERIFIED on this machine, 2026-11-18 build]

```
<TaleSpire install>/Taleweaver/
  d71427a1-5535-4fa7-82d7-4ca1e75edbfd/   "Medieval Fantasy"      (medieval_fantasy.packName)
      index           2.9 MB  binary index (magic CE D1 CE D1, v5)   <- SOURCE OF TRUTH (rewritten by game updates)
      index.json      6.8 MB  human-readable index (stale: dated 2026-09-10 here; Sci-fi pack 2026-06-11)
      assetIndex      binary (magic CE D1 CE D1, v2), asset->bundle lookup
      aQBuADA= ...    Unity asset bundles (names are base64 of UTF-16 "in0", "in1", ...)
      Assets/         per-model bundle folders (char_*, tileset_* ...)
  fc3a4efc-e8d9-4d82-8620-f26c5b66023c/   "Cyberpunk and Sci-fi"
      (same layout)
  Tutorials/
```

- **Is `index.json` current?** Only by coincidence. Today's update (2026-11-18 13:50 local) rewrote both binary `index` files but left `index.json` untouched (dated 2026-09-10 and 2026-06-11). Parsing the updated binary files gives exactly the same assets and fields as `index.json` for both packs: 0 added, 0 removed, 0 changed across names, kinds, folders, group tags, tags, deprecated and interactable flags, bounds and mesh-part counts. The binary sizes (2,902,012 and 993,026 bytes) also equal the pre-update sizes. **Conclusion: today's update changed no assets.** `index.json` cannot be trusted to follow future updates. [VERIFIED]
- **Bouncyrock-endorsed source:** the official URL-scheme page points at `index.json` for asset UUIDs. That page predates the stale-file behaviour; treat `index.json` as a fallback baseline only. [VERIFIED quote; INFERRED that it is outdated advice]
- **Community and mod.io content packs** are not in `Taleweaver`. They live in `<user data>/primary/CommunityContent/Packs/<guid>#<…>/root.tsMod`, in an undocumented binary format. This user has 154 of them. They are out of scope for v1; slabs that reference them still decode, but their UUIDs will be "unknown". [VERIFIED that they exist; format INFERRED opaque]
- **Runtime alternative:** a Symbiote can call `TS.contentPacks.getMoreInfo(...)` to get the same metadata, including community packs. [VERIFIED from the Symbiote API doc]

### index.json schema [VERIFIED]

```jsonc
{
  "Name": "Medieval Fantasy",
  "Tiles":     [ BoardObject ],   // 1,396 (387 deprecated)  | Sci-fi: 364 (4 deprecated)
  "Props":     [ BoardObject ],   // 1,035 (19 deprecated)   | Sci-fi: 494 (4 deprecated)
  "Creatures": [ { Id, Name, IsDeprecated, GroupTag, Tags, Folder, MiniAsset, BaseAsset, DefaultScale, Icon } ],  // 293 | 32
  "Music":     [ ... ],                                                                                          // 79  | 0
  "IconsAtlases": [ ... ]
}
BoardObject = {
  "Id": "uuid",                 // the AssetKindId used in slabs
  "Name": "Dungeon Wall 01",    // NOT unique (e.g. "Desert Ground 01" exists as 1x1 and 2x2; "Barrel" x3 across packs)
  "IsDeprecated": false,        // deprecated assets still render in old slabs; don't emit them
  "GroupTag": "wall",           // coarse form ("floor","wall","roof","corner","stairs",...), sometimes "" or junk ("GroupTagName")
  "Tags": ["1x1","stone",...],  // free tags; size tags like "2x1" are unreliable, use bounds
  "Folder": "Dungeon Cellar",   // the KIT; best key for "pieces that belong together"
  "Assets": [ { "LoaderData": {"BundleId","AssetName"}, "Position":{x,y,z}, "Rotation":{x,y,z,w}, "Scale":{x,y,z} } ],
                                // sub-meshes composing the object (352 tiles / 139 props have >1)
  "IsInteractable": false,      // doors, hatches, chests that open
  "ColliderBoundsBound": { "m_Center": {x,y,z}, "m_Extent": {x,y,z} },  // AABB in asset-local tile units, unrotated
  "Icon": { "AtlasIndex": 5, "Region": {x,y,width,height} }
}
```

How to read the bounds [VERIFIED by statistics over the whole index]:

- **Tiles** are authored with the collider's **min corner at the origin** (`m_Center == m_Extent`) in 1,756 of 1,760 tiles. Footprints are whole or half tiles. Every non-deprecated tile has its base at y = 0.
- **Props** are authored **centred on the origin** in x/z (|centre| < 0.1 in 1,301 of 1,529), with the base at about y = 0. The rest ("other") are off-centre meshes such as wall torches, wall lanterns and asymmetric trees. For those, `boundsCenter` gives the offset.
- `size = 2 × m_Extent` is the unrotated size. There is no "default facing" field in the index. Facing is whatever the art was modelled with, so it has to be calibrated in game (§5).

## 2. Re-extracting the catalog

```powershell
powershell -ExecutionPolicy Bypass -File tools\research\Extract-AssetCatalog.ps1 [-TaleweaverDir "<install>\Taleweaver"] [-Source auto|binary|json] [-CrossCheck]
```

This parses each pack's **binary `index`** with `tools/research/TsIndexReader.cs`, which the script loads through `Add-Type`. If the binary file is missing or fails validation, it falls back to that pack's `index.json` and records a note in `packs[].notes`.

- `-CrossCheck` diffs binary against `index.json` field by field. On 2026-11-18 the result was 0/0/0 for both packs.
- The output is `data/talespire-assets.json`: **3,289 Tiles and Props, of which 2,859 are not deprecated**, across 2 packs. It matches the earlier `index.json`-based catalog record for record.
- `packs[]` now carries the source type, the binary file's size, mtime and SHA-256, the format version and the schema id. These are the change-detection keys described in §9.

Each record has:

- `uuid`, `name`, `kind` (tile or prop), `pack`, `packId`, `folder`, `groupTag`, `tags`
- `deprecated`, `interactable`
- `size {x,y,z}` and `footprintCells {x,z}` (size rounded up to whole cells)
- `boundsCenter`, `boundsMin` (relative to the origin)
- `originAt`: `minCorner`, `center` or `other`
- `sizeTag` and `meshParts`

The script only reads the install. Creatures and music are skipped.

## 3. Locating the index at runtime (Electron, Windows and Linux)

Instead of shipping a catalog, the app should read the user's install at startup and cache a derived catalog in its own app-data folder. This is the approach citysmith takes. [INFERRED recommendation]

Steam app id **720620** (`steam_appid.txt`). [VERIFIED]

**Windows**

1. Steam root: read `HKCU\Software\Valve\Steam\SteamPath` (or `HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath`). The default is `C:\Program Files (x86)\Steam`.
2. Libraries: parse `<SteamRoot>\steamapps\libraryfolders.vdf` (KeyValues text). Each `"path"` is a library. Pick the one whose `apps` block contains `"720620"`, or check for `steamapps\appmanifest_720620.acf`.
3. Install: `<library>\steamapps\common\TaleSpire\Taleweaver\<packGuid>\index.json`. Read `installdir` from the appmanifest rather than hard-coding `TaleSpire`.
4. User data, if ever needed: `%USERPROFILE%\AppData\LocalLow\BouncyRock Entertainment\TaleSpire\`.

**Linux** (TaleSpire runs under **Proton**; there is no native build. The install ships `TaleSpireUrlRelayLinux.sh` for Proton.) [VERIFIED that the script exists; INFERRED for the paths below]

1. Steam roots to probe:
   - `~/.steam/steam`, `~/.steam/root`, `~/.local/share/Steam`
   - Flatpak: `~/.var/app/com.valvesoftware.Steam/.local/share/Steam`
   - Snap: `~/snap/steam/common/.local/share/Steam`
2. Same `steamapps/libraryfolders.vdf` and `appmanifest_720620.acf` logic as Windows. The install is `<library>/steamapps/common/TaleSpire/Taleweaver/<packGuid>/index.json`. The game files are the Windows build.
3. User data lives inside the Proton prefix: `<library>/steamapps/compatdata/720620/pfx/drive_c/users/steamuser/AppData/LocalLow/BouncyRock Entertainment/TaleSpire/`.

Always offer a "Browse for TaleSpire folder…" fallback. Match pack folders by the GUID-shaped directory name containing `index.json`. Do not hard-code the two pack ids, because new official packs may be added. Treat everything as read-only. Re-extract when the `index.json` mtime changes.

## 4. Licensing of a bundled catalog (not legal advice)

- We found no published Bouncyrock policy on redistributing index data. The EULA was not retrievable during research. [INFERRED]
- The **UUIDs, names, tags and bounds** are factual metadata, and slab strings shared publicly already contain UUIDs. Bouncyrock itself points modders at `index.json` and exposes the same data through the Symbiote API. Shipping a **small curated palette** (about 125 UUIDs, names and sizes, like `palette-draft.json`) is low risk and matches common community practice.
- Shipping a **verbatim copy or full dump of `index.json`**, or anything heavier (icons and atlases, `Assets[].LoaderData` bundle names, meshes or bundles), is redistribution of Bouncyrock's content files. **Don't put that in a public repo.** Citysmith explicitly ships "no TaleSpire assets and no asset data" and builds its catalog locally at run time.
- Recommendation:
  - Commit only the curated palettes (`packages/core/data/palettes/`: uuid, name and geometry of the pieces used).
  - Generate `talespire-assets.json` at run time from the user's install.
  - Keep `data/talespire-assets.json` and the research draft `data/palette-draft.json` local (both are git-ignored).
  - Never commit icons or bundles.

## 5. How TaleSpire builds are put together (what a generator must know)

From the index plus decoded slabs. [VERIFIED unless marked]

- **Grid:** 1 tile = 1 world unit = 5 ft. Vertical placement is in 0.25 steps.
- **Floors:** tiles 0.5 thick (cobblestone 0.25), 1×1, 1×2 or 2×2, and some 4×4 or 8×8. A floor at `y` has its walkable top at `y + 0.5`. To line up surfaces of different thickness, **align tops, not bottoms**. [COMMUNITY: citysmith found a 15-inch kerb otherwise]
- **Walls come in three constructions:**
  1. **Thin edge pieces:** 0.5 deep, 2.0 tall, 1 or 2 long. Examples: `Dungeon Wall 01` 1×2×0.5, `Tavern Wall 01` 2×2×0.5, `Rural Wall 01` 0.5×2×1.
     - They occupy **the half of a cell next to an edge**. They are not centred on the grid line, so a room's walls take half a cell of its floor.
     - **Authoring axis varies by kit.** Dungeon and Castle walls run along x. Rural, Tavern-small and Castle Ruins walls run along z. Read `lengthAxis` and rotate by 6 if it disagrees with the edge.
     - Outer corners need a 0.5×0.5 **corner filler post** (`Dungeon Wall Corner Filler`, `Tavern Inner Corner 2`), or a 2×2 corner piece.
  2. **Full-cell blocks:** the cave kit (`Cave Wall 01` 1×2×1, `Cave Wall 03` 2×2×1, `Cave Wall Corner 01` 2×2×2). Lay these on the grid like floors. Good for organic caves: fill every solid cell that borders an open cell.
  3. **Wall+floor combos:** 2.5 tall, with the floor and wall in one piece (`Dungeon Wall/Floor 01`, `Tavern Wall/Floor 01`, `md_pref_wall_*`). They are convenient but tie the wall to a floor style. The palette uses separate pieces instead.
- **Doors** have the same footprint as a wall segment: 1×2×0.5 single, 2×2×0.5 double. A door replaces that wall segment. Most are interactable. **Doorways** (open arches) use the same rule (`md_wall_archway_2x1_01`).
- **Stairs** are 1×1×1 blocks that rise 1.0 over one cell, which is two floor courses. A full storey is 2.5, so plan stair runs as 2–3 cells plus a 0.5 step. `Stair Block` is the solid version.
- **Pillars:** either a full-cell tile (`Dungeon Pillar` 1×2×1) or a prop (`castle pillar` about 0.6×2×0.6).
- **Roofs:** the Thatched/Village kit uses a rotation convention a quarter turn off the walls. [COMMUNITY: citysmith]
- **Props** (furniture, dressing, trees, rocks) are free-placed at their centre, at 0.01 precision with any rot step. Keep their colliders apart: overlapping props can vanish on paste. [COMMUNITY] Use single-piece trees (`Tree 01`, `Dead Tree 01`, `cypress_tree_01`). The "Stackable Pine" and "Tree w mushrooms" kits are stump + middle + top stacks that overlap by design.
- **Water:** `tempWater1x1` and `tempWater2x2` are the only water *tiles* (0.5-thick surface tiles). Rivers and lakes are laid like floor, with banks one course higher. "Ocean" assets are props such as reefs and seaweed. [VERIFIED for the list; visual result unverified]

## 6. Draft palette (`data/palette-draft.json`)

Built by `tools/research/Build-Palette.ps1`. It resolves exact names against the catalog and prefers the Medieval Fantasy pack when a name is shared. It has **125 entries in 5 themes**, all resolved, none deprecated. Each entry has:

- `theme`, `role`, `roleKind`
- `uuid`, `name`, `kind`, `folder`
- `size`, `footprintCells`, `height`, `originAt`, `boundsCenter`
- `lengthAxis` (which axis a wall runs along at rot 0)
- `interactable`
- `placement`, a rule text per roleKind

Themes and why each was chosen:

- **generic**: registration marker (`gravel_1x1_01`), water 1×1 and 2×2, torches (wall and floor), brazier, candle, barrel, crates, sack, chests, ladder.
- **stone_dungeon**: uses the *Dungeon Cellar* kit with *MegaDungeon* (`md_*`) alternates.
  - floors 1×1 and 2×2 (`Dungeon Floor - Small`, `Dungeon Floor 02`, `- Cracked`)
  - edge walls 1 and 2 long (`Dungeon Wall 01/02`, `md_wall_1x1_01`, `md_wall_2x1_01`, ruined)
  - corner fillers, an archway, doors (`Door - Dungeon`, `Doors - Dungeon Double`, prison, portcullis)
  - `Dungeon Stairs`/`Stair Block`, `Dungeon Pillar`, prison bars
  - dressing: altar, bones, skeleton, cobweb, statue
- **cave**: *Cavern* kit. Rock floors 1×1 and 2×2, full-cell wall blocks, plus stalagmites, boulders, rocks, moss rock, mushrooms and rubble.
- **wood_town**: *Tavern* and *Rural* kits.
  - floors, thin walls (two authoring axes, both included), window walls, corner posts
  - peasant and town doors, stairs, thatched roof set (flat, slope, corner, inner corner)
  - cobblestone street tiles, bar counter
  - furniture: table, round table, chair, stool, bench, beds, bookshelf, rugs, lanterns, well, fences, workbench, anvil
- **outdoor**: *Nature* kit. Grass (lush and sparse), grassy-road set (straight, corner, T, cross), gravel, swamp, snow, desert, single-piece trees, stump, log, bushes, fern, reeds, boulders, rocks, cliff, gravestone.

Placement in one paragraph:

- **Floor-like tiles** go at the min corner of the cells they cover.
- **Edge walls and doors** go at the min corner of their rotated 0.5-deep footprint on the floor top (`y = floorY + 0.5`):
  - south (low-z) edge: `(tx, y, tz)`
  - north (high-z) edge: `(tx, y, tz+0.5)`
  - west (low-x) edge: `(tx, y, tz)`
  - east (high-x) edge: `(tx+0.5, y, tz)`
  - These offsets were verified in game: rotation alone never moves a piece to the other half of the cell.
  - Use rot ∈ {0, 6, 12, 18} so the length runs along the edge.
- **Props** go at their centre.

## 7. Verification status

**Verified in game on 2026-11-18** with `data/calibration-slab.txt`; details are in the format doc §2.1–2.2.

- +x is East and +z is North. Map plan rows to `z = H−1−row`; the result is not mirrored.
- `rot` turns clockwise seen from above.
- Edge walls and doors stay in the south half of the cell (rot 0/12) or the west half (rot 6/18). Use +0.5 for north and east edges.
- `Dungeon Stairs` ascend W, N, E, S at rot 0, 6, 12, 18.
- The `Door - Dungeon` handle is at the west end at rot 0 and the east end at rot 12.
- The chest prop is centred in its cell at every rotation.

Still unverified, ranked by impact:

1. **Paste anchor and multi-chunk alignment:** which bounding-box point follows the cursor, and how the ray-hit height reacts to already-placed chunks.
2. **Prop fronts:** which way the front of a chair, bed, chest or bookshelf faces at rot 0. Plan on a per-asset or per-family "front" override in the palette.
3. **Other kits' conventions:** decorated faces of windowed or ornamented walls, other stair and door kits, and the pivot of larger non-square tiles such as 2×1 floors.
4. **Visual fit:** whether thin walls sit flush with the floor at `y = 0.5`, whether water looks right at floor level or 0.25 lower, and whether prop heights on 0.25-thick cobblestone are right.
5. **Prop drop on overlap:** a community report, not reproduced. How much clearance is needed is unknown.
6. **Community pack assets:** not catalogued. Their `.tsMod` format is undocumented.

## 8. Binary index format (`Taleweaver/<packGuid>/index`, format version 5)

Reverse-engineered on 2026-11-18 from both official packs. `tools/research/TsIndexReader.cs` is a working reader, and it reproduces `index.json` field for field: 3,614 of 3,614 assets, 0 mismatches.

- **[VERIFIED]** means it was checked against `index.json` for every asset in both packs.
- **[INFERRED]** means only the structure or meaning is guessed.

### 8.1 Encoding primitives [VERIFIED]

- Everything is little-endian. There is no compression.
- **Relative pointer (`rel`):** an `int32` offset measured from **the address of the pointer field itself**, so `target = fieldOffset + rel`. A value of 0 means null.
- **String:** `{ rel, u32 len }`. The target is `len` UTF-16LE code units with no terminator. All strings live in one string blob that starts at file offset 0x30.
- **Array:** `{ rel, u32 count }`. Elements are fixed-size structs laid out contiguously at the target.
- **GUID:** 16 bytes in .NET `Guid.ToByteArray()` order, the same byte order as slabs.

### 8.2 Header (0x30 bytes)

| Offset | Type | Value (v5) | Meaning | Status |
|---|---|---|---|---|
| 0x00 | u32 | `0xD1CED1CE` (bytes `CE D1 CE D1`) | magic | VERIFIED |
| 0x04 | u32 | 5 | format version | VERIFIED value; meaning INFERRED |
| 0x08 | u64 | e.g. 0xCD194 | absolute file offset of the **root** struct | VERIFIED |
| 0x10 | 16 B | GUID `2061c3a8-4467-113e-1ab5-705888f6959f` in both packs | schema or type id | INFERRED meaning; the value is constant across packs |
| 0x20 | 16 B | zeros | reserved | — |
| 0x30… | | | UTF-16 string blob: pack name, asset names, folders, tags, UI strings | VERIFIED |

(`assetIndex` uses the same magic with version 2. It is an asset-to-bundle map that we do not need.)

### 8.3 Root struct (64 bytes at `header.root`)

| +off | Field | Status |
|---|---|---|
| +0 | string `PackName` ("Medieval Fantasy") | VERIFIED |
| +8 | `rel` to the **search table**. The u32 at +12 (1,349,396 here) is probably the table's byte size. | VERIFIED (pointer); INFERRED (+12) |
| +16 | array **BoardObjects**: tiles and props, 176-byte records | VERIFIED |
| +24 | array Creatures (293 here; about 284-byte records) | VERIFIED count; layout not decoded |
| +32 | array Music (79 here; about 112-byte records) | VERIFIED count; layout not decoded |
| +40 | array (empty) | unknown |
| +48 | array IconAtlases (13 here) | INFERRED |
| +56 | array (empty) | unknown |

### 8.4 BoardObject record (176 bytes; tiles first, then props)

| +off | Type | Field | Status |
|---|---|---|---|
| +0 | string | Name | VERIFIED |
| +8 | guid | **Id** (the slab AssetKindId) | VERIFIED |
| +24 | u32 | kind: 1 = tile, 2 = prop | VERIFIED |
| +28 | rel | 64-byte content reference (pack GUID, `i64 0x7FFF…`, …, a GUID) | INFERRED meaning |
| +32 | u32 | 0, 90, 180 or 270 (sometimes 179 or 269) on some tiles, always 0 on props. Probably an authoring yaw in degrees. **Not needed for placement.** | INFERRED |
| +36 | array | sub-mesh `Assets` (104-byte elements: content ref, then position float3, rotation quaternion float4, scale float3). The count equals `Assets.Count` in json. | VERIFIED (count); INFERRED (element layout) |
| +44 | array | collider boxes (24-byte elements: float3 centre and float3 extent). The count is 1–35 for tiles and 0 for props. | INFERRED |
| +52 | rel | present on some props only | unknown |
| +60 | float3 | **ColliderBoundsBound.m_Center** | VERIFIED |
| +72 | float3 | **ColliderBoundsBound.m_Extent** | VERIFIED |
| +108 | rel | always set | unknown |
| +112 | rel | **non-null ⇔ IsInteractable** (points to the interaction data) | VERIFIED (2,431 of 2,431) |
| other | | zero in v5 | — |

### 8.5 Search table (all tiles, props and creatures)

The table is 10 column descriptors of `{ rel, u32 count }`. Every column has the same count, which is tiles + props + creatures (2,724 here). Rows are ordered tiles, then props, then creatures, and line up across columns. Join to BoardObjects **by Id**, not by row.

| Col | Element | Field | Status |
|---|---|---|---|
| 0 | guid (16 B) | Id | VERIFIED |
| 1 | string (8 B) | Name | VERIFIED |
| 2 | string (8 B) | category label: `TILE`, `PROP`, `CREATURE <type>` | VERIFIED values |
| 3 | string (8 B) | **Folder** (the kit) | VERIFIED |
| 4 | string + u32 (12 B) | **GroupTag**, plus a u32 of unknown meaning | VERIFIED string; INFERRED u32 |
| 5 | u32, u32 (8 B) | footprint-like pair for tiles; it equals the rounded collider size for 76% of tiles. (0,0) for props. **Use bounds instead.** | INFERRED |
| 6 | array of string (8 B) | **Tags** | VERIFIED |
| 7 | u32 flags | **bit 1 (value 2) = IsDeprecated**. No other bits are set in v5. | VERIFIED |
| 8 | 64 B | content reference (pack GUID, …) | INFERRED |
| 9 | u32 | kind: 1 tile, 2 prop, 4 creature | VERIFIED |

### 8.6 Building a catalog record

| Catalog field | Source in the binary index |
|---|---|
| uuid, name, folder, groupTag, tags | search table, columns 0, 1, 3, 4 and 6 |
| deprecated | search table column 7, `& 2` |
| kind | search table column 9 |
| size and bounds | BoardObject +60 and +72 |
| interactable | BoardObject +112 ≠ 0 |
| meshParts | BoardObject +40 |

Derived fields (`footprintCells`, `originAt` and so on) follow §2.

### 8.7 Defensive parsing (for the TypeScript port)

**Hard checks.** If any of these fails, the pack is **unreadable**:

- file length ≥ 0x40 and the magic matches;
- the root offset is inside the file;
- every `rel` target and every `len`/`count` span is inside the file;
- all 10 search columns have the same count;
- string lengths are below 100,000;
- each BoardObject's Id is found in the search table and its name matches column 1;
- the number of BoardObjects equals the number of rows with kind 1 or 2;
- bounds extents are finite and between 0 and 1,000.

**Soft checks.** These produce warnings, then parsing continues:

- `version != 5`;
- `schemaId != 2061c3a8-…`;
- unknown flag bits in column 7;
- an unknown kind code;
- the u32 at root+12 is not plausible.

Most format bumps will show up first as a changed version or schema id. A changed record size shows up as name or Id mismatches at record 1.

**Do not hard-code offsets beyond what you validate.** Read via the relative pointers, verify that string targets fall in the string blob (offset ≥ 0x30 and below the root), and cap every loop by the file size.

**Fail soft.** On an unreadable pack:

1. Keep using the **last good cached catalog** for that pack, keyed by packId and marked stale, and show "TaleSpire updated its asset index format; new assets may be missing" in the UI.
2. If there is no cache, fall back to that pack's `index.json` and mark the pack stale.
3. If neither exists, use **UUID-only discovery**: scan the file for the pack's known UUIDs to confirm they still exist. New ones can only be found by looking for 16-byte GUIDs at a 16-byte stride, so treat this as "unknown asset, id only".
4. Long-term fallback: a small Symbiote that calls `TS.contentPacks.getMoreInfo()` (official API, which also covers community packs) and writes JSON to its storage or posts it to the app. This is immune to file-format changes but needs TaleSpire running with Symbiotes enabled.

Never block slab generation on a parse failure. The palette only needs UUIDs and sizes that are already cached.

## 9. Keeping up with game updates

- **What changes on an update:** Steam rewrites `Taleweaver/<pack>/index`, which can add, remove or deprecate assets, and may add new pack folders. `index.json` is not refreshed.
- **When to check:**
  - at app start;
  - when the user opens the asset picker;
  - when the user presses "Rescan TaleSpire";
  - optionally through an `fs.watch` on the `Taleweaver` folder, debounced.

  Do not poll aggressively.
- **Change detection:**
  1. List GUID-named pack directories that contain `index`.
  2. For each, compare `(size, mtimeMs)` with the cached `packs[]` entry.
  3. If either differs, **or** a pack directory is new or gone, compute SHA-256 (a 3 MB file takes milliseconds).
  4. Re-parse only when the hash differs. Today's update is the case this handles: the mtime changed, the size and content did not, and the hash avoids a pointless refresh.
  5. Optionally also key on `steamapps/appmanifest_720620.acf` `buildid` to show "TaleSpire build N".
- **What a refresh does:**
  1. Parse the changed packs into a new catalog.
  2. **Diff it** against the cached one (added, removed, changed by uuid) and store the diff with a timestamp.
  3. Swap the catalog in atomically: write to a temp file, then rename.
  4. Re-resolve the palette, which pins names and UUIDs:
     - a pinned asset that disappeared or became deprecated is flagged, and the next candidate is used;
     - new assets are shown as "New in this TaleSpire update" in the picker.
  5. Never mutate already-compiled slabs.

  Everything stays read-only on the install.
- **New assets without an app release:** the generator should resolve roles by `folder`/`groupTag`/`kind` and size filters, with pinned names as preferences, so assets added by an update are usable as soon as the catalog refreshes. Only placement conventions for brand-new kits need human confirmation (calibration).
- **Packaging:** ship the reader as TypeScript in the app (port of `TsIndexReader.cs`), plus a golden test that parses a fixture header and a few hand-built records. The real `index` files must not be committed (see §4).

## 10. "Open TaleSpire" button (launch or focus only)

This is research only; nothing was launched.

- **Steam URL `steam://rungameid/720620`:** use `shell.openExternal` on Windows (handler: `steam.exe -- "%1"`, VERIFIED in the registry) and on Linux (`xdg-open`; Steam registers `steam://`).
  - It launches through Steam, which on Linux applies Proton.
  - If the game is already running, Steam normally does not start a second copy; behaviour ranges from nothing visible to bringing Steam forward. [INFERRED]
  - This is the **safest way to launch**.
- **Running `TaleSpire.exe` directly: avoid.** It bypasses Steam, and the Steam API may relaunch it through Steam. On Linux it is a Windows binary that needs Proton. TaleSpire also supports **multiple simultaneous instances**, since the Symbiote docs warn about them, so this can open a second copy. [VERIFIED for multiple instances; INFERRED for the rest]
- **`TaleSpireUrlRelay.exe` or a `talespire://` URL** (Windows handler: `TaleSpireUrlRelay.exe %1`, VERIFIED in the registry; Linux uses an xdg handler that TaleSpire registers itself under Proton). The relay launches the game if it is not running, otherwise it forwards the URL over IPC.
  - **No URL is guaranteed to have no effect.** `dice/` puts dice in the tray, `asset/<uuid>` puts an asset in the hand (it would **replace the pasted slab in hand**), and `goto/` moves the camera.
  - It is also unknown whether the relay raises the window.
  - **Don't use it just to focus.** It is the right tool only for the v2 Symbiote hand-off.
- **Focusing an already-running game:**
  - Detect the process: `TaleSpire.exe` on Windows; on Linux, a process whose command line contains `TaleSpire.exe` under wine.
  - On Windows, bring it forward with a small helper, for example a PowerShell one-liner using `WScript.Shell.AppActivate(<pid>)`, or a native `SetForegroundWindow` addon. Windows' foreground lock usually allows this because the app was just clicked and is in the foreground. [INFERRED]
  - On Linux X11, use `wmctrl -a TaleSpire` or `xdotool` if installed. On Wayland, raising another app's window is generally not allowed; show a hint instead.
- **Recommendation:**
  - If TaleSpire is **not running**, open `steam://rungameid/720620`.
  - If it **is running**, try to focus its window; if that fails, show "Switch to TaleSpire (Alt+Tab), enter build mode and press Ctrl+V".
  - Never send `talespire://` URLs or start the exe directly for this button.
