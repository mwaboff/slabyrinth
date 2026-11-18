# Build-Palette.ps1 - resolve a curated starter palette (by exact asset name) against
# data/talespire-assets.json and write data/palette-draft.json with derived placement data.
# Usage: powershell -ExecutionPolicy Bypass -File tools\research\Build-Palette.ps1
param([string]$Catalog = '', [string]$OutFile = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Catalog) { $Catalog = Join-Path $here '..\..\data\talespire-assets.json' }
if (-not $OutFile) { $OutFile = Join-Path $here '..\..\data\palette-draft.json' }
$cat = (Get-Content $Catalog -Raw | ConvertFrom-Json).assets | Where-Object { -not $_.deprecated }

# role kinds: floor | wall | wallBlock | corner | door | doorway | stairs | pillar | water | roof | prop
# Each entry: theme, role, roleKind, name, optional size "XxZ" to disambiguate duplicate names.
$spec = @(
  # ---------- generic ----------
  @('generic','registration_marker','floor','gravel_1x1_01'),
  @('generic','water_1x1','water','tempWater1x1'),
  @('generic','water_2x2','water','tempWater2x2'),
  @('generic','torch_wall','prop','Torch wall wood stone on'),
  @('generic','torch_floor','prop','Floor Torch'),
  @('generic','brazier','prop','Brazier'),
  @('generic','candle','prop','Candle'),
  @('generic','barrel','prop','Barrel'),
  @('generic','crate','prop','Crate - Large'),
  @('generic','crate_small','prop','Dark Crate Small 01'),
  @('generic','sack','prop','sack_01'),
  @('generic','chest','prop','Leather Chest'),
  @('generic','chest_treasure','prop','Gold Chest'),
  @('generic','ladder','prop','Ladder wood 01'),
  # ---------- stone dungeon ----------
  @('stone_dungeon','floor_1x1','floor','Dungeon Floor - Small'),
  @('stone_dungeon','floor_2x2','floor','Dungeon Floor 02'),
  @('stone_dungeon','floor_2x2_alt','floor','Dungeon Floor - Cracked'),
  @('stone_dungeon','floor_1x1_alt','floor','md_floor_1x1_01'),
  @('stone_dungeon','floor_2x2_alt2','floor','md_floor_2x2_01'),
  @('stone_dungeon','wall_1','wall','Dungeon Wall 01'),
  @('stone_dungeon','wall_2','wall','Dungeon Wall 02'),
  @('stone_dungeon','wall_1_alt','wall','md_wall_1x1_01'),
  @('stone_dungeon','wall_2_alt','wall','md_wall_2x1_01'),
  @('stone_dungeon','wall_2_ruined','wall','Dungeon Wall - Ruined'),
  @('stone_dungeon','corner_filler','corner','Dungeon Wall Corner Filler'),
  @('stone_dungeon','corner_filler_alt','corner','md_corner_filler_01'),
  @('stone_dungeon','doorway_arch_2','doorway','md_wall_archway_2x1_01'),
  @('stone_dungeon','door_1','door','Door - Dungeon'),
  @('stone_dungeon','door_2','door','Doors - Dungeon Double'),
  @('stone_dungeon','door_prison','door','Door - Prison'),
  @('stone_dungeon','door_portcullis_2','door','Door - Portcullis'),
  @('stone_dungeon','stairs','stairs','Dungeon Stairs'),
  @('stone_dungeon','stair_block','stairs','Dungeon Stair Block'),
  @('stone_dungeon','pillar','pillar','Dungeon Pillar'),
  @('stone_dungeon','pillar_ruined','pillar','Dungeon Pillar - Ruined'),
  @('stone_dungeon','prison_bars','wall','Prison bars v2 1x1'),
  @('stone_dungeon','altar','prop','Altar (Evil)'),
  @('stone_dungeon','bones','prop','Bone Pile 01'),
  @('stone_dungeon','skeleton','prop','Skeleton 01'),
  @('stone_dungeon','cobweb','prop','Spiderweb03'),
  @('stone_dungeon','statue','prop','Knight Statue'),
  @('stone_dungeon','castle_pillar_prop','prop','castle pillar'),
  # ---------- cave ----------
  @('cave','floor_1x1','floor','Cave Floor - Rock 2'),
  @('cave','floor_2x2','floor','Cave Floor - Rock 01'),
  @('cave','wall_block_1','wallBlock','Cave Wall 01'),
  @('cave','wall_block_2','wallBlock','Cave Wall 03'),
  @('cave','wall_corner_2x2','wallBlock','Cave Wall Corner 01'),
  @('cave','stalagmite','prop','Stalagmite column 03'),
  @('cave','stalagmite_small','prop','Stalagmite column stub 02'),
  @('cave','boulder','prop','Boulder - Large'),
  @('cave','rock_small','prop','Rock - Small'),
  @('cave','moss_rock','prop','Moss Rock 01'),
  @('cave','mushrooms','prop','Mushroom Patch (Forest) 01'),
  @('cave','rubble','prop','Rubble Rocks pile'),
  # ---------- wooden building / town ----------
  @('wood_town','floor_1x1','floor','Tavern Floor 01'),
  @('wood_town','floor_2x2','floor','Tavern Floor 03'),
  @('wood_town','floor_rural_1x1','floor','Rural Floor 01'),
  @('wood_town','floor_rural_2x2','floor','Rural Floor 04'),
  @('wood_town','wall_1','wall','Tavern Wall - Small 01'),
  @('wood_town','wall_2','wall','Tavern Wall 01'),
  @('wood_town','wall_rural_1','wall','Rural Wall 01'),
  @('wood_town','wall_rural_2','wall','Rural Wall 02'),
  @('wood_town','wall_window_2','wall','Rural Wall Window'),
  @('wood_town','wall_window_2_alt','wall','Wall Only With Window'),
  @('wood_town','corner_filler','corner','Tavern Inner Corner 2'),
  @('wood_town','corner_filler_rural','corner','Rural Inner Corner'),
  @('wood_town','door_1','door','Door -Peasant'),
  @('wood_town','door_2','door','Door -Peasant double'),
  @('wood_town','door_town_1','door','Door_town_v1'),
  @('wood_town','stairs','stairs','Tavern Stair'),
  @('wood_town','stair_block','stairs','Tavern Stairs Block'),
  @('wood_town','stairs_rural','stairs','Rural Stairs'),
  @('wood_town','roof_flat_1x1','roof','Thatched roof flat 01'),
  @('wood_town','roof_slope_1x1','roof','Thatched Roof 01'),
  @('wood_town','roof_corner_1x1','roof','Thatched Roof Corner 01'),
  @('wood_town','roof_inner_corner_1x1','roof','Thatched Roof Inner Corner 01'),
  @('wood_town','street_1x1','floor','CobbleStone Floor Small'),
  @('wood_town','street_2x2','floor','CobbleStone Floor 01'),
  @('wood_town','bar_counter','floor','Bar Counter'),
  @('wood_town','pillar_wood','prop','Wooden Pillar ornate'),
  @('wood_town','table','prop','table wood 01'),
  @('wood_town','table_round','prop','table wood round 01'),
  @('wood_town','chair','prop','chair wood 01'),
  @('wood_town','stool','prop','stool wood 01'),
  @('wood_town','bench','prop','Bench -Shabby'),
  @('wood_town','bed','prop','Red Bed'),
  @('wood_town','bed_poor','prop','Bed straw 01'),
  @('wood_town','bookshelf','prop','Bookshelf 01'),
  @('wood_town','rug_2x2','prop','rug_01'),
  @('wood_town','rug_2x1','prop','rug_06'),
  @('wood_town','lantern','prop','Lantern -Small'),
  @('wood_town','street_lantern','prop','Street Lantern'),
  @('wood_town','well','prop','Well 01'),
  @('wood_town','fence_wood','prop','Wooden Fence '),
  @('wood_town','fence_stone','prop','Stone Wall 01'),
  @('wood_town','workbench','prop','Workbench'),
  @('wood_town','anvil','prop','Anvil'),
  # ---------- forest / outdoor ----------
  @('outdoor','grass_1x1','floor','Grass 1x1'),
  @('outdoor','grass_2x2','floor','Grass - Lush'),
  @('outdoor','grass_2x2_sparse','floor','Grass - Sparse'),
  @('outdoor','road_2x2','floor','Grassy Road '),
  @('outdoor','road_2x2_corner','floor','Grassy Road  Corner'),
  @('outdoor','road_2x2_t','floor','Grassy Road T'),
  @('outdoor','road_2x2_cross','floor','Grassy Road Crossroad'),
  @('outdoor','dirt_1x1','floor','gravel_1x1_01'),
  @('outdoor','swamp_1x1','floor','Swamp floor 1x1'),
  @('outdoor','swamp_2x2','floor','Swamp floor 2x2'),
  @('outdoor','snow_1x1','floor','Snow Ground 01'),
  @('outdoor','desert_1x1','floor','Desert Ground 01','1x1'),
  @('outdoor','desert_2x2','floor','Desert Ground 01','2x2'),
  @('outdoor','tree','prop','Tree 01'),
  @('outdoor','tree_dead','prop','Dead Tree 01'),
  @('outdoor','tree_cypress','prop','cypress_tree_01'),
  @('outdoor','tree_stump','prop','Stackable Pine Stump'),
  @('outdoor','log','prop','log with moss'),
  @('outdoor','bush','prop','bush_reg_01'),
  @('outdoor','bush_small','prop','bush_berry_01'),
  @('outdoor','bush_dead','prop','Dead Bush 01'),
  @('outdoor','fern','prop','Fern 01'),
  @('outdoor','reeds','prop','swamp reed 02'),
  @('outdoor','boulder','prop','Boulder - Large'),
  @('outdoor','rock_small','prop','Rock - Small'),
  @('outdoor','rock_large','prop','rock_large001'),
  @('outdoor','cliff','prop','Cliff Face'),
  @('outdoor','gravestone','prop','Gravestone 01')
)

function Round3([double]$v) { [Math]::Round($v, 3) }
$notes = @{
  floor     = 'Tile. Stored position = min corner of the cells it covers (asset origin is the collider min corner). Place at (cellX, yBase, cellZ). Top surface = yBase + size.y. Square floors may use any rot in {0,6,12,18} for variety without changing the position.'
  water     = 'Tile, same rule as floor. TempWater is the only water tile family in the Medieval Fantasy index; it is a 0.5-thick surface tile (place at the same yBase as adjacent floors, or 0.25 lower to read as recessed - unverified visually).'
  wall      = 'Thin edge tile (0.5 deep, 2 tall). Occupies the half of a cell next to one edge; it does NOT sit centred on the grid line. lengthAxis says which axis the unrotated piece runs along. For a wall on the low-z/high-z edge of cell (tx,tz) the piece must run along x; for low-x/high-x edges along z (rotate by 6 steps if lengthAxis disagrees). Position = min corner of the rotated footprint: low-z edge -> (tx, y, tz); high-z edge -> (tx, y, tz+0.5); low-x edge -> (tx, y, tz); high-x edge -> (tx+0.5, y, tz). Stand on a floor: y = floor yBase + floor size.y (0.5). VERIFIED IN GAME (Dungeon Wall 01): +x = East, +z = North (so low-z = south edge, high-z = north edge, low-x = west, high-x = east). Rotation never moves the piece to the other half of the cell: an x-running piece sits in the south half at rot 0/12 and the west half at rot 6/18, so north/east edges need the +0.5 offsets above. Dungeon Wall 01 looks the same on both faces; other kits may have a front face (unverified).'
  wallBlock = 'Full-cell wall block (cave kit): fills whole cells (1 deep), not an edge piece. Place like a floor tile at the min corner of the covered cells. Corner blocks are 2x2 and their open/solid side depends on rot (UNVERIFIED).'
  corner    = '0.5x0.5 filler post used where two thin edge walls meet at an outer corner. Position = min corner of its 0.5x0.5 footprint, e.g. (tx, y, tz) for the low-x/low-z corner of cell (tx,tz). Rotation irrelevant for the footprint.'
  door      = 'Edge piece with the same footprint rule as a wall of equal length (replaces the wall segment). 2-wide doors replace a 2-long wall. Doors are interactable (open/close in game). VERIFIED IN GAME (Door - Dungeon): same half-cell rule as walls. The slab has identical faces and no frame. The ring handle is at the WEST end at rot 0 and the EAST end at rot 12; by the clockwise rule it is at the north end at rot 6 and the south end at rot 18. Pick rot 0 vs 12 (or 6 vs 18) to put the handle at the end you want. Other door kits are assumed to follow the same convention (unverified).'
  doorway   = 'Open archway edge piece; same footprint rule as a wall.'
  stairs    = '1x1x1 tile, rises 1.0 over one cell (two 0.5 floor courses). VERIFIED IN GAME (Dungeon Stairs): they ascend toward West (-x) at rot 0, North (+z) at rot 6, East (+x) at rot 12 and South (-z) at rot 18, i.e. clockwise. Other stair kits are assumed to share this (unverified). Stair Block is the solid variant for stacking.'
  pillar    = 'Full-cell tile (1x2x1 or 1x1x1); place like a floor tile.'
  roof      = 'Roof tile. Community measurement (citysmith asset-conventions.md): Thatched/Village roof kit is a quarter turn off the wall convention: edge rot n=6,e=0,s=18,w=12; corners nw=12,ne=6,sw=18,se=0 (their n/e/s/w naming). UNVERIFIED here.'
  prop      = 'Prop. Stored position = asset origin, which for props is (approximately) the collider centre in x/z and the base in y. To centre on a point (cx,cz) at rot r: pos = (cx - offX, y, cz - offZ) where (offX,offZ) = boundsCenter.xz rotated by r (usually ~0). VERIFIED IN GAME for Leather Chest: centred in its cell at every rotation. Which side is a prop''s front is UNVERIFIED. Props are not grid-snapped; overlapping prop colliders can be silently dropped on paste (community report) - keep props apart.'
}
$out = New-Object System.Collections.ArrayList
$missing = @()
foreach ($s in $spec) {
  $theme, $role, $rk, $name = $s[0], $s[1], $s[2], $s[3]
  $cands = @($cat | Where-Object { $_.name -eq $name })
  if ($s.Count -gt 4) { $xz = $s[4].Split('x'); $cands = @($cands | Where-Object { [Math]::Round($_.size.x) -eq [int]$xz[0] -and [Math]::Round($_.size.z) -eq [int]$xz[1] }) }
  if ($cands.Count -eq 0) { $missing += "$theme/$role '$name'"; continue }
  # Prefer the fantasy pack when a name exists in several packs (e.g. 'Barrel' is also a Cyberpunk asset).
  $cands = @($cands | Sort-Object { if ($_.pack -eq 'Medieval Fantasy') { 0 } else { 1 } })
  $a = $cands[0]
  $lengthAxis = if ($a.size.x -gt $a.size.z + 0.01) { 'x' } elseif ($a.size.z -gt $a.size.x + 0.01) { 'z' } else { 'square' }
  [void]$out.Add([ordered]@{
    theme = $theme; role = $role; roleKind = $rk
    uuid = $a.uuid; name = $a.name; kind = $a.kind; folder = $a.folder; groupTag = $a.groupTag
    size = [ordered]@{ x = (Round3 $a.size.x); y = (Round3 $a.size.y); z = (Round3 $a.size.z) }
    footprintCells = $a.footprintCells
    height = (Round3 $a.size.y)
    originAt = $a.originAt
    boundsCenter = $a.boundsCenter
    lengthAxis = $lengthAxis
    interactable = $a.interactable
    duplicateNameCount = $cands.Count
    placement = $notes[$rk]
  })
}
$doc = [ordered]@{
  description = 'DRAFT generator palette for Slabyrinth. Resolved by exact name from data/talespire-assets.json (local Medieval Fantasy pack). Units: tiles (1 tile = 5 ft, y up). Conventions (see docs/talespire-assets.md): floors 0.5 thick, walls 2 tall and 0.5 deep sitting on the floor top; rot is in 15-degree steps, use multiples of 6 for grid pieces. Facing/hinge/stair directions are UNVERIFIED until the calibration slab is pasted in-game.'
  generatedBy = 'tools/research/Build-Palette.ps1'
  conventions = [ordered]@{
    tileUnit = '1 grid square = 1.0 world unit = 100 slab units = 5 ft'
    verticalStep = 0.25
    floorThickness = 0.5
    storeyHeight = 2.5
    wallHeight = 2.0
    rotationsForGridPieces = @(0, 6, 12, 18)
  }
  missing = $missing
  entries = $out
}
[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutFile), ($doc | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
Write-Host "Wrote $($out.Count) palette entries; missing: $($missing.Count)"
$missing | ForEach-Object { Write-Host "  MISSING $_" }
$out | Where-Object { $_.duplicateNameCount -gt 1 } | ForEach-Object { Write-Host "  DUPLICATE NAME $($_.name) x$($_.duplicateNameCount)" }
