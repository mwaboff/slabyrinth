# TaleSpire slab format: generation spec for Slabyrinth

Status: research spec, 2026-11-18. Written for the people building the encoder.

Each claim has a tag:

- **[VERIFIED]** means it was checked against a primary source (Bouncyrock's docs, or strings and data in the installed game) or by decoding real slabs with `tools/research/SlabCodec.ps1`.
- **[COMMUNITY]** means a reputable third party measured it in game, but we could not reproduce it offline.
- **[INFERRED]** means it is reasoning or a strong hint. It has not been confirmed.

The sources are listed at the end.

---

## 0. TL;DR for the encoder author

1. **Emit format version 2.** It is the only format the official docs and the Symbiote API describe, and it is what the current game copies to the clipboard. [VERIFIED] Version 1 is a legacy float-based format. The game appears able to upgrade it on paste, but do not emit it. [INFERRED: the game DLL contains the string `Incorrect slab version {0} after upgrade`]
2. Payload: `D1CEFACE` magic, `u16 version=2`, `u16 layoutCount`, `u16 creatureCount=0`. Then `layoutCount` × 20-byte layouts (16-byte UUID in **.NET `Guid.ToByteArray()` order**, `u16 count`, `u16 0`). Then each layout's instances as little-endian `u64`s, in layout order. Then a **`u16 0x0000` trailer**. Everything is little-endian. [VERIFIED]
3. Instance `u64`, from bit 0 up: `x` (18 bits), `y` (18 bits), `z` (18 bits), `rot` (5 bits), then 5 unused bits that must be 0. Coordinates are in hundredths of a tile (`100` = 1 grid square = 5 ft). **`y` is up.** `rot` is 0..23 in 15° steps. All coordinates are ≥ 0. [VERIFIED]
4. Where things land:
   - A **tile's** stored position is the **minimum corner of the cells it covers after rotation**. Rotating a square tile does not move its stored position. [VERIFIED for square tiles from data; COMMUNITY for non-square]
   - A **prop's** stored position is its **origin**, which is roughly the centre of its collider on the ground. [COMMUNITY + consistent with our vectors]
   - Floors are 0.5 thick. Walls are 2.0 tall, 0.5 deep edge pieces that stand on the floor top. Vertical placement snaps in 0.25 steps. [VERIFIED from index + vectors]
5. Wrap: gzip (RFC 1952, any compression level), then **standard base64** (`+/`, `=` padded, no line breaks). The fences are optional: the game accepts the bare string, and a string fenced with triple backticks also decodes. **Limit: 30,720 bytes of gzip output** (the base64-decoded length), not the base64 length. [VERIFIED]
6. A paste lands **at the cursor**, snapped to the grid and anchored on the slab's bounding box. You cannot choose where it lands from outside the game. Big maps must be chunked so that every chunk has the same bounding box. See §4. [COMMUNITY]

---

## 1. Wrapping: string ⇄ bytes

| Step | Rule | Status |
|---|---|---|
| Trim | Trim surrounding whitespace. | VERIFIED (official format.md) |
| Fences | Optionally remove triple backticks at the start and end. The game's own Symbiote JS does `slabString.replace("```","").replace("```","")`. Strings copied by the game come out **without** fences today. Community archives often keep them. Our encoder should output the bare string and offer fenced output as a copy option. | VERIFIED (official docs; game DLL JS) |
| Base64 | Standard RFC 4648 alphabet with `+` `/` and `=` padding, on a single line. It is not URL-safe. The game uses `atob`, so a URL-safe string would fail. | VERIFIED (all vectors; game JS uses `atob`) |
| Compression | gzip (RFC 1952) wrapping raw deflate. The game decompresses with `DecompressionStream("gzip")` or `GZipStream`, so any valid gzip works. The header bytes seen in the wild vary: MTIME is always 0 and XFL/OS vary (`00 0A`, `00 0B`, `02 03`, `04 00`). Decoders must not depend on them. | VERIFIED (vectors; game JS) |
| Size limit | **gzip output ≤ 30,720 bytes** (30 × 1024). This is the length after base64 decoding. The Symbiote doc says: "before base64 encoding it, but after compressing it with gzip". At runtime the value is `TS.slabs.getMaxSlabSizeInBytes()`. A 30,720-byte payload is about 40,960 base64 characters. The v1 test vector is 32,272 base64 characters but only 24,203 bytes, and it is valid. | VERIFIED (format.md, Symbiote API doc, DumbSlabStats `COMPRESSED_SIZE_LIMIT = 1024*30`) |
| Uncompressed size | No separate limit is documented. A real 4,449-asset slab is 35,864 bytes uncompressed. | VERIFIED (vector `sb-river-4449`) |

Size planning: real slabs compress at about 2.3× (lots of variety) to about 3× (repetitive terrain). Each instance is 8 raw bytes, so a slab tops out at about **9,000–12,000 instances**. That depends on how regular the coordinates are, so **always measure by actually compressing**. [VERIFIED from vectors; the range is an estimate]

---

## 2. Binary layout, version 2 (the format to emit)

All integers are **little-endian**. There is no padding between sections. [VERIFIED]

```
offset  size  field
0       4     u32 magic            = 0xD1CEFACE   (bytes CE FA CE D1)
4       2     u16 version          = 2
6       2     u16 layoutCount      = number of distinct asset kinds
8       2     u16 creatureCount    = 0 (always, in v2)
10      20*L  Layout[layoutCount]
              +0  16  uuid  AssetKindId   (.NET Guid.ToByteArray() byte order, see below)
              +16  2  u16   AssetCount    (instances of this kind)
              +18  2  u16   reserved = 0
...     8*N   Instances: layout[0].AssetCount u64s, then layout[1]..., in layout order
...     2     u16 trailer = 0x0000
```

Total length is `10 + 20·L + 8·N + 2`. This was checked on every v2 vector; for example, one layout with one asset gives 40 bytes. [VERIFIED]

- **Trailer:** the official `format.md` does not mention it. However, every game-produced v2 slab we decoded (14 of 14) ends with `00 00`. `svenboulanger/TaleSpire.Slab` writes it too, with the comment "This is undocumented". **Emit it.** Decoders should tolerate trailing bytes. [VERIFIED by data]
- **UUID byte order:** `Guid.ToByteArray()` order. The first group is 4 bytes little-endian, the next two groups are 2 bytes each little-endian, and the last 8 bytes are as written. For example, `e62c6746-cecf-46bf-8b20-f81738f1d220` becomes `46 67 2C E6 CF CE BF 46 8B 20 F8 17 38 F1 D2 20`. In JavaScript or Node, reverse bytes 0–3, 4–5 and 6–7 of the hex. [VERIFIED: Bouncyrock `NGuid.cs`, decoded vectors resolve to real index UUIDs]
- **Instance u64:**

```
bit 63..59  58..54   53..36     35..18     17..0
    unused  rot(5)   z (18)     y (18)     x (18)
x = (v      ) & 0x3FFFF
y = (v >> 18) & 0x3FFFF
z = (v >> 36) & 0x3FFFF
rot = (v >> 54) & 0x1F        // 0..23
extra = (v >> 59) & 0x1F      // write 0
```

Use 64-bit integer math. In JavaScript use `BigInt` or two 32-bit halves, because the bits straddle bit 32. [VERIFIED: official format.md, Bouncyrock `AssetData.cs`, re-encode is byte-exact on all vectors]

- **Ordering:**
  - The game emits layouts **sorted by UUID**. String sort matches NGuid `uint4` compare on our data. Sort them too.
  - **Instance order within a layout is not sorted.** For example, `sf-tavern-line` has x = 600, 200, 0. Instance order is irrelevant to the game; keep your own order.
  - **Do not repeat a UUID in two layouts.** We have never seen it in game output, and it is untested.

  [VERIFIED for what the game emits; INFERRED that sorting is not required]
- **Unused and reserved fields:** layout `reserved` and instance `extra` bits were 0 in every vector. [VERIFIED]

### 2.1 Units, axes, scale

| Item | Value | Status |
|---|---|---|
| 1 grid square (1 tile, 5 ft) | 1.0 world unit = **100** stored units | VERIFIED (format.md `x = scaledX/100`; 2×2 floors step by 200) |
| Axes | `x` and `z` are horizontal and **`y` is up** (Unity: left-handed, Y-up) | VERIFIED: stacked floors differ only in `y`, by 50 (0.5 thick); props resting on floors have `y=50` |
| Precision | 0.01 tile. The encoder must `round(v*100)`. | VERIFIED |
| Range per axis | 0 … 262,143 stored = 0 … 2,621.43 tiles. Negative values cannot be represented. | VERIFIED |
| Vertical snap for tiles | 0.25 (all tile `y` values in the real slabs are multiples of 25) | VERIFIED (data) |
| Horizontal snap for tiles | Whole tiles in all real slabs. Thin pieces sit on half tiles **inside** a cell; see palette notes. | VERIFIED (data); half-tile positions COMMUNITY |
| Floor and storey | Floor tiles are 0.5 thick. Walls are 2.0 tall. "Wall/Floor" combo tiles are 2.5 tall, which is the natural **storey height of 2.5**. | VERIFIED (index bounds) |
| Normalisation | Every slab the game copied has min x = y = z = 0, but by which measure is unclear. In `sf-prop-offset` a prop defines the minimum and the floor tile gets the fractional position (0.24, 0.5, 0.21). | VERIFIED (data) |
| Map orientation | **+x = East, +z = North** on the in-game compass. With a north-up 2D plan whose rows grow downward, map `col → x` and `row → z = (H-1-row)`; the result is not mirrored. | **VERIFIED IN GAME** (calibration slab, 2026-11-18: pads run left→right with 1–4 corner pillars and the origin pillar at bottom-left, camera facing north) |

### 2.2 Rotation and pivot

- `rot` is 0..23 and degrees = `rot × 15`. Tiles and props both accept any step, but grid pieces should use 0, 6, 12 and 18. [VERIFIED (format.md, vectors). The 1,774-asset community slab `sb-cave-1774` uses all 24 steps.]
- **Direction:** increasing `rot` turns a piece **clockwise seen from above** on a north-up map. **[VERIFIED IN GAME]** Evidence: `Dungeon Stairs` ascend toward −x (West) at rot 0, +z (North) at rot 6, +x (East) at rot 12 and −z (South) at rot 18. Views from the south and from the north agree.
- **Tiles:** the stored position is the **minimum corner of the axis-aligned footprint after rotation**. The footprint swaps x and z on odd quarter turns. There is no corner pivot, so a 2×1 piece rotated 90° occupies `[x, x+1] × [z, z+2]`.
  - **[VERIFIED IN GAME for 0.5-deep edge pieces]** `Dungeon Wall 01` and `Door - Dungeon`, stored at the min corner of cell (1,3) / (3,3):
    - At rot 0 and rot 12 they run east-west in the **south (low-z) half** of the cell.
    - At rot 6 and rot 18 they run north-south in the **west (low-x) half**.
    - This rules out rotation about the cell centre.
  - **Rotation never moves an edge piece to the other half of a cell.** To put a wall on a cell's north edge, store it at `z + 0.5`; for the east edge, store it at `x + 0.5`.
  - Evidence: `sf-rot` stores four 2×2 floors at rot 0, 6, 12 and 18 all at x = z = 0, stacked. Under a corner-pivot rule three of them would have gone negative.
  - Citysmith reports in-game ground truth for the 0.5×2 `Wall Only With Window`: rot 0 → (0.50, 0.00) and rot 270° → (0.00, 3.50).
  - Almost every tile in the index is authored with its collider's min corner on the origin (1,756 of 1,760), so "origin = min corner" holds for tiles at rot 0.
  - [VERIFIED for square tiles and for 1×0.5 edge pieces (in game); COMMUNITY for larger non-square tiles]
- **Edge-piece facing [VERIFIED IN GAME]:**
  - `Dungeon Wall 01` looks the same (plain stone) on both faces.
  - `Door - Dungeon` has no frame and its two faces look alike. Its only orientation cue is the ring handle: at **rot 0 the handle is at the west (low-x) end**, and at rot 12 it is at the east end. At rot 6 and 18 it runs north-south; by the clockwise rule the handle is at the north end at rot 6 and the south end at rot 18 (not individually confirmed).
  - The door slab sits roughly in the middle of its 0.5 depth.
  - Other kits (windowed or decorated walls) may have a front face; check each kit before relying on it.
- **Props:** the stored position is the **asset origin**, which is the collider centre in x/z (1,301 of 1,529 props are authored centred) and the base in y. **[VERIFIED IN GAME]** `Leather Chest`, stored at the exact centre of cell (2,2), sat centred in that cell at all four rotations, with its long axis east-west at rot 0/12 and north-south at rot 6/18. **Which way a prop's front faces (for example the chest latch) is still UNVERIFIED.**
  - To centre a prop on point `(cx, cz)`: `pos = (cx − offX, y, cz − offZ)`, where `(offX, offZ)` is `boundsCenter.xz` rotated by `rot`. This is near 0 for most props.
  - Evidence: in `sf-castle-tavern-wprop`, `Bed wrapped 01` at (3.49, 0.5, 1.36) only fits inside its 1×1 floor cell (3..4, 1..2) under this rule.
  - [COMMUNITY + consistent with data; confirmed in game for the chest]
- **Multi-cell tiles**: they rotate as a whole. For quarter turns, swap the footprint dimensions and keep the stored min corner at the min corner of the covered cells. [COMMUNITY]

### 2.3 Version 1 (legacy, decode only)

Version 1 has the same magic. Then: `u16 version=1`, `u16 layoutCount` (no creature count), the same 20-byte layouts, then **28 bytes per instance**: `float3 centre`, `float3 half-extents`, `u8 rot`, 3 padding bytes. Then a footer of `float3` centre plus `float3` size for the whole slab. This is where the "bounds" in older notes came from.

This was verified by decoding the 4,052-asset `Mountain Board` vector: `8 + 177·20 + 4052·28 + 24 = 117,028` bytes. [VERIFIED] Do not emit v1.

---

## 3. Worked example (byte level)

One `Tavern Floor 03` (2×2×0.5 tile, `e62c6746-cecf-46bf-8b20-f81738f1d220`) at tile (3, 0.5, 2), rot 6 (90°).

```
scaled: x=300 (0x12C) y=50 (0x32) z=200 (0xC8) rot=6
u64 = 0x12C | 0x32<<18 | 0xC8<<36 | 6<<54 = 0x01800C8000C8012C
```

Uncompressed payload (40 bytes):

```
CE FA CE D1                    magic 0xD1CEFACE
02 00                          version 2
01 00                          layoutCount 1
00 00                          creatureCount 0
46 67 2C E6 CF CE BF 46        uuid e62c6746-cecf-46bf-...
8B 20 F8 17 38 F1 D2 20             ...8b20-f81738f1d220
01 00                          AssetCount 1
00 00                          reserved
2C 01 C8 00 80 0C 80 01        instance u64 (LE) 0x01800C8000C8012C
00 00                          trailer
```

The gzip and base64 output from .NET `GZipStream` is `H4sIAAAAAAAEADv369xFJgZGBgYGt3SdZ+fP7XfrVvghbvHxkgJITIfxBEMDTwOQCQAbEZZYKAAAAA==`. Other compressors produce different bytes for the same payload. The game's own copy of a single Tavern Floor 03 at the origin, rot 0, is test vector `sf-tavern-floor-2x2`. Its 40-byte payload differs only in the instance (`00…00`). [VERIFIED: produced and re-decoded by `SlabCodec.ps1`]

## 4. Encoder pseudocode

```text
encodeSlab(placements):              # placement = {uuid, x, y, z (tiles, float), rot (0..23)}
  # 1. normalise: shift so min stored x,y,z == 0. Shift by WHOLE tiles (and y by multiples of 0.25)
  #    so grid pieces stay on the grid (a prop overhang must not drag the board off-grid).
  minX = floor(min(p.x)); minY = floor4(min(p.y)); minZ = floor(min(p.z))   # floor4 = floor to 0.25
  for p: p.x -= minX; p.y -= minY; p.z -= minZ
  # 2. quantise + validate
  for p: sx,sy,sz = round(p.x*100), round(p.y*100), round(p.z*100)
         assert 0 <= s* <= 262143 and 0 <= rot <= 23
  # 3. group by uuid, sort groups by uuid string (lowercase)
  groups = sortByKey(groupBy(placements, uuid))
  assert len(groups) <= 65535 and every group size <= 65535
  # 4. write
  buf = u32le(0xD1CEFACE) + u16le(2) + u16le(len(groups)) + u16le(0)
  for g in groups: buf += guidToBytesLE(g.uuid) + u16le(len(g)) + u16le(0)
  for g in groups: for p in g: buf += u64le(sx | sy<<18 | sz<<36 | rot<<54)
  buf += u16le(0)
  gz = gzip(buf)                                  # any level; level 9 / Optimal saves bytes
  if len(gz) > 30720: raise TooLarge              # caller must split (section 5)
  return base64std(gz)                            # optionally wrap in ``` ... ```

guidToBytesLE(s): h = hex(s without '-')          # 32 hex chars
  return rev(h[0:8]) + rev(h[8:12]) + rev(h[12:16]) + h[16:32]   # rev = reverse byte order
```

A reference implementation in PowerShell is `tools/research/SlabCodec.ps1`, with `Decode-Slab`, `Encode-SlabV2` and `Get-SlabV2RawBytes`. It reproduced all 14 v2 research vectors byte for byte. The redistributable vectors are in `data/slab-test-vectors.json`.

---

## 5. Limits, violations, chunking, anchoring

| Limit | Value | What happens on violation | Status |
|---|---|---|---|
| Slab size | 30,720 bytes of gzip output | Paste is rejected: the Symbiote API reports `dataOversized`, and copying a too-large selection yields status `oversized` with no string. We have not seen the exact in-game paste message. | VERIFIED (limit, API states); in-game UI unverified |
| Instances per layout | 65,535 (u16) | Not reachable within the byte limit | VERIFIED (format) |
| Layouts per slab | 65,535 (u16) | Not reachable | VERIFIED (format) |
| Coordinate range | 0…2,621.43 tiles per axis | Negative values can't be encoded; wrap-around corrupts the slab | VERIFIED (format) |
| Creatures | Always 0 in v2. Minis cannot be delivered by slab. | — | VERIFIED |
| Assets per board | about 1,000,000 | Community reports a hard cap or crashes near it | COMMUNITY |
| Camera view distance | about 300 tiles | Big maps can't be seen at once | COMMUNITY |
| Overlapping props | Props whose colliders overlap can be silently dropped on paste ("missing parts") | Space props apart; prefer single-piece trees | COMMUNITY (citysmith) |

### Where a paste lands

There is **no** way to give a slab a world position from outside the game.

- `Ctrl+V` puts the slab "in hand". It follows the cursor, snapped to the grid, anchored on the slab's own bounding-box corner. A left press held for about 0.2 s commits it. It stays in hand as a stamp until you right-click.
- The height comes from the cursor's ray hit, or from a raised build plane (`G`).
- Copying a placed slab back out returns it normalised to its own min corner.

[COMMUNITY: citysmith `docs/pasting-into-talespire.md`. VERIFIED that copies are normalised to min 0.]

Unknowns: exactly which bounding-box point sits under the cursor (min corner or centre), and whether the bounding box uses tile footprints or colliders. [INFERRED, check in game]

### Chunking a big map

This is the recommended approach.

1. Split the plan into **rectangular regions of whole cells**, in the plan's own grid. Keep each region's compressed size at or below about **24 KB** (about 80% of the cap) to leave headroom. Grow or split regions by actually encoding them; a greedy split or a k-d split on asset count, then measuring, works well. One region holds all of its layers (floor, walls, props). Do not layer, because a later layer would rest on an earlier one.
2. **Give every chunk an identical bounding box.**
   - Add the same two **registration markers** to every chunk: a 1×1 thin tile at the global min corner, `(minX−1, 0, minZ−1)`, and one at the global max corner, `(maxX+1, 0, maxZ+1)`. Both sit just outside the map footprint at the lowest level.
   - Then normalise every chunk with the **same global offset**, not per chunk.
   - Every chunk then has the same min (0,0,0) and the same max. It assembles correctly whether the game anchors on the min corner or the centre.
   - The markers stack in two cells, and the GM deletes them afterwards. [COMMUNITY technique; the two-marker variant is INFERRED]
3. Tell the user to:
   - use an empty board, or a build plane (`G`) at a known height;
   - **not move the camera**;
   - paste each chunk and commit it **over the same cell**;
   - right-click between chunks.

   Pasting on top of already-placed tiles can raise the ray-hit height. Aim the cursor at the marker cell or empty ground outside the map. [COMMUNITY]
4. Optionally emit a multi-slab JSON for LordAshes' BepInEx `MultiPasteSlabsPlugin` / `SlabPlugin_CCM`, which place chunks by stored offset. These plugins are third-party, need BepInEx and break on game updates, so treat them as an extra, not the main path. [COMMUNITY]

---

## 6. Boards, URLs, and the "Open in TaleSpire" button

### URL scheme

`talespire://` URL scheme. [VERIFIED from talespire.com/url-scheme and strings in `Bouncyrock.TaleSpire.Runtime.dll`]

| URL | Effect |
|---|---|
| `talespire://dice/<groups>` | Puts dice in the tray |
| `talespire://asset/<uuid>` | Puts **one** tile, prop or mini in the hand |
| `talespire://published-board/<b64 name, '/'→'_'>/<32-hex id>` | Makes a shallow copy of a board **already published on Bouncyrock's servers**. Seen in this user's log. |
| `talespire://goto/bookmark/<id>` | Moves the camera |
| `talespire://stat-names/<b64>` | Sets the campaign's stat names |
| `talespire://creature-blueprint/<b64>` | Creature clipboard format |
| `talespire://roll/...` | Dice roll |
| `talespire://symbiote/<prefix>/<user data>` | Delivers a string message to an installed Symbiote |

- There is **no slab or board import URL**. You cannot deliver a slab or create a board by URL. [VERIFIED: complete list of `talespire://` literals in the DLL plus the official page]
- On Windows, URLs reach the game through `TaleSpireUrlRelay.exe`. On Linux under Proton they go through `TaleSpireUrlRelayLinux.sh`, which runs the relay inside the game's Wine prefix. [VERIFIED: install files]

### Board files

Boards live on Bouncyrock's servers. The local `…/LocalLow/BouncyRock Entertainment/TaleSpire/primary/BoardFetch/<guid>` files are an undocumented zlib-compressed fetch cache. **Authoring board files is not viable or sane:** they are server-authoritative and undocumented, and the cache would be overwritten or rejected. [VERIFIED that the files exist and are zlib (`78 01`); INFERRED not viable]

### Official modding API: Symbiotes

Symbiotes are HTML/JS panels inside TaleSpire.

- Their API includes `TS.slabs.sendSlabToHand(slabStr)`, which "sends the provided slab string to the hand ready to be placed by the user". Its failure states are `notInBoard`, `clientIsNotInGmMode`, `invalidSlabString`, `dataOversized` and `spawnFailed`.
- It also has `getMaxSlabSizeInBytes()`, `pack`/`unpack`, `getSlabInActiveSelection()`, `contentPacks.getMoreInfo` (the asset index at runtime), and `urls.onUrlMessage` for receiving `talespire://symbiote/…` messages from outside the game.
- Even through a Symbiote the slab still lands **in hand**, so the user still places it.

[VERIFIED: symbiote-docs.talespire.com API v0.1, plus the same functions embedded in the game DLL]

The BepInEx plugins on Thunderstore (LordAshes, among others) can place slabs at coordinates. They are unofficial and break with updates. [COMMUNITY]

### Recommendation for "Open in TaleSpire"

**v1 (ship this):** "Copy slab" buttons.

- One button per chunk, copying bare base64 to the clipboard.
- Number the chunks, show the paste checklist (build mode, camera still, same cell, right-click between), and show a size gauge against 30,720.
- Also offer "Download .txt", plus a `talespire://asset/<uuid>` link for "pick this single asset".
- Do **not** promise "open as board".
- Add an **"Open TaleSpire"** button that only launches or focuses the game:
  - not running: open `steam://rungameid/720620`;
  - running: focus its window, or show an Alt+Tab hint;
  - never a `talespire://` URL, because an `asset/` link would replace the slab in hand.

  Details are in `talespire-assets.md` §10.

**v2 (optional, real):** a small **Slabyrinth Symbiote**, with `interopId` and `runInBackground`.

- The desktop app opens `talespire://symbiote/<prefix>/<jobId>`.
- The Symbiote fetches the chunk from the app's localhost HTTP server and calls `TS.slabs.sendSlabToHand`.
- A "next chunk" button in the Symbiote steps through the chunks.
- This removes the clipboard step but not the place-in-hand step.

Open questions for v2 [INFERRED]:

- Can a Symbiote web view `fetch` `http://127.0.0.1`? The server would need CORS headers.
- What URL length does the relay allow? Avoid putting whole slabs (up to about 41 KB) in a URL; send an id.
- The user has to enable Symbiotes and install ours into `…\LocalLow\BouncyRock Entertainment\TaleSpire\Symbiotes\` (or through mod.io).

---

## 7. Test vectors and reference implementations

`data/slab-test-vectors.json` has 2 v2 vectors (4 and 156 assets) from the MIT-licensed `TaleSpire.Slab` test suite; attribution is in `data/THIRD-PARTY.md`. Research used 15 vectors (14 v2, 1 v1, up to 4,449 assets, including SlabelFish test slabs and TalesTavern/TalesBazaar builds); those are not redistributed here because their sources carry no licence or are other people's creations. The core tests add self-generated v2 slabs and a hand-built v1 payload instead. Each vector has:

- the string, version and counts;
- the gzip and decompressed sizes;
- the SHA-256 of the decompressed payload, and the full hex when it is 400 bytes or less;
- every instance for slabs of 300 assets or fewer (the first 3 per layout otherwise);
- asset names resolved from the local index;
- `reencodeRawMatches`, which was **true for all 14 v2 research vectors**.

Regenerate it with `tools/research/Build-TestVectors.ps1 -InputJson tools/research/vectors-input.json`.

`data/calibration-slab.txt` is our own 130-asset probe, built with `tools/research/Make-CalibrationSlab.ps1`. It has four 5×5 dungeon pads, one per rot 0/6/12/18, each carrying a wall, door, stairs and a chest stored at known positions. Pad *i* has *i*+1 pillars in its far corner, and a single pillar marks each pad's low-x/low-z cell.

**Pasted in game on 2026-11-18 (results recorded in §2.1–2.2):**

| Question | Answer |
|---|---|
| Mirroring | None. col → x (East), row → z = H−1−row (North). |
| Rotation sense | Clockwise from above. |
| Stairs at rot 0 / 6 / 12 / 18 | Ascend W / N / E / S. Rule: ascending direction = West rotated clockwise by rot×15°. |
| Edge piece at rot 0 / 12 | Runs east-west in the south half of the cell. |
| Edge piece at rot 6 / 18 | Runs north-south in the west half of the cell. |
| Door handle | West end at rot 0, east end at rot 12. |
| Wall faces | Identical. |
| Chest | Centred in its cell at every rotation. |

Still open (none of these block v1):

- which way prop fronts face, for example chest latches, chairs and beds (needs one close-up per asset family, or a per-asset "front" field set by hand);
- whether the paste anchor is the min corner or the centre of the bounding box;
- the pivot rule for larger non-square tiles such as 2×1 floors (one screenshot of a 2×1 floor at rot 6 would settle it).

Survey of open-source codecs:

| Project | Lang | Licence | Verdict |
|---|---|---|---|
| Bouncyrock/DumbSlabStats | C# | none stated (official sample) | **Normative** for v2 layout; decode-only |
| svenboulanger/TaleSpire.Slab | C# (.NET Std 2.0) | **MIT** | **Best reference**: v1+v2 read/write, writes the trailer, byte-exact round-trip tests with real slabs |
| LuPro/SlabelFish | Python | none stated | Early reverse-engineering; good small in-game test slabs; its doc predates the official spec |
| jchallenger/citysmith | Python | Apache-2.0 | Most extensive **empirical** notes (paste behaviour, pivot, chunking, roof rotations); codec tested against real fixtures |
| weterynarzfred/TaleSpire-slabTool | JS (React) | none stated | Slab transform tool (offset/rotate/replace); useful JS reference |
| brcoding/TaleSpireHtmlSlabGeneration | JS/HTML | MIT | Old, small JS generator |
| mathieu-cozanet/talespire-slab-codec | JS | MIT | **Do not trust its README.** It says 16-bit fields, a 10-bit rotation and z as height, which contradicts the official spec and our decoding. |
| LordAshes TalespireDungeonMaker / Slab plugins | C# | MIT / Thunderstore | 2D→slab converter; BepInEx multi-paste |

For a JS/TS (Electron) port: implement from §2 and test against `data/slab-test-vectors.json`. Use Node's `zlib.gzipSync` and `Buffer` (`readBigUInt64LE`). Use svenboulanger's C# as the cross-check.

## Sources

- Official format: https://github.com/Bouncyrock/DumbSlabStats/blob/master/format.md and `DumbSlabStats/Slab/*.cs`, `Utils/NGuid.cs` (same repo)
- Symbiote API: https://symbiote-docs.talespire.com/api_doc_v0_1.md.html and https://symbiote-docs.talespire.com/
- URL scheme: https://talespire.com/url-scheme
- svenboulanger/TaleSpire.Slab: https://github.com/svenboulanger/TaleSpire.Slab (tests: `TaleSpire.Slab.Tests/SlabTests.cs`)
- SlabelFish: https://github.com/LuPro/SlabelFish (`test_slabs/`, `slab format documentation.md`)
- citysmith: https://github.com/jchallenger/citysmith (`docs/pasting-into-talespire.md`, `docs/asset-conventions.md`, `citysmith/build.py`)
- MultiPasteSlabsPlugin: https://thunderstore.io/c/talespire/p/LordAshes/MultiPasteSlabsPlugin/
- Asset-limit and view-distance anecdotes: https://talestavern.com/?p=74511
- Local, read-only: `TaleSpire_Data/Managed/Bouncyrock.TaleSpire.Runtime.dll` (embedded Symbiote JS, URL literals), `Bouncyrock.TaleSpire.DataModel.Runtime.dll`, `TaleSpireUrlRelayLinux.sh`, `Player.log` (`Pasting 764 assets`, published-board URL)
