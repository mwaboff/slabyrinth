# Make-CalibrationSlab.ps1 - emit a small v2 slab that answers the conventions we could not verify
# offline (rotation direction, wall/door facing, stair direction, prop origin). Paste it in TaleSpire
# (build mode, Ctrl+V), look straight down, and record the answers in docs/talespire-slab-format.md.
# Output: data/calibration-slab.txt  (plain base64, no fences)
param([string]$OutFile = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutFile) { $OutFile = Join-Path $here '..\..\data\calibration-slab.txt' }
. (Join-Path $here 'SlabCodec.ps1')

$cat = (Get-Content (Join-Path $here '..\..\data\talespire-assets.json') -Raw | ConvertFrom-Json).assets | Where-Object { -not $_.deprecated }
function U($name) { $a = @($cat | Where-Object { $_.name -eq $name })[0]; if (-not $a) { throw "missing $name" }; return $a }
$floor  = U 'Dungeon Floor - Small'   # 1x0.5x1
$pillar = U 'Dungeon Pillar'        # 1x2x1, marks the pad's low-x/low-z cell
$wall   = U 'Dungeon Wall 01'         # 1x2x0.5, runs along x
$door   = U 'Door - Dungeon'          # 1x2x0.5
$stairs = U 'Dungeon Stairs'          # 1x1x1
$chest  = U 'Leather Chest'           # prop, 0.85 x 0.52, long axis x

$L = [ordered]@{}
function Add($asset, [double]$x, [double]$y, [double]$z, [int]$rot) {
    if (-not $L.Contains($asset.uuid)) { $L[$asset.uuid] = New-Object System.Collections.ArrayList }
    [void]$L[$asset.uuid].Add(@{ sx = [int][Math]::Round($x * 100); sy = [int][Math]::Round($y * 100); sz = [int][Math]::Round($z * 100); rot = $rot })
}
# Four pads, one per quarter turn, spaced 6 tiles apart along +x. Each pad is 5x5 floor cells.
$rots = 0, 6, 12, 18
for ($i = 0; $i -lt 4; $i++) {
    $ox = $i * 6; $r = $rots[$i]
    for ($cx = 0; $cx -lt 5; $cx++) { for ($cz = 0; $cz -lt 5; $cz++) { Add $floor ($ox + $cx) 0 $cz 0 } }
    Add $pillar $ox 0.5 0 0                       # origin marker: low-x, low-z corner cell of the pad
    for ($k = 0; $k -le $i; $k++) { Add $pillar ($ox + 4) 0.5 (4 - $k) 0 }   # i+1 pillars at the far corner = pad index
    # Wall in cell (1,3), door in cell (3,3): stored at the cell's min corner with rotation r.
    # Observe where the 0.5-deep piece lands inside the cell and which face shows the decoration.
    Add $wall ($ox + 1) 0.5 3 $r
    Add $door ($ox + 3) 0.5 3 $r
    # Stairs in cell (2,1): observe which way they ascend.
    Add $stairs ($ox + 2) 0.5 1 $r
    # Chest prop with origin exactly at the centre of cell (2,2) (2.5, 2.5): if it sits centred, props store their centre.
    Add $chest ($ox + 2.5) 0.5 2.5 $r
}
$layouts = @($L.Keys | Sort-Object | ForEach-Object { @{ Uuid = $_; Assets = @($L[$_]) } })
$s = Encode-SlabV2 $layouts
[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutFile), $s, (New-Object Text.UTF8Encoding($false)))
$d = Decode-Slab $s
Write-Host ("Wrote {0}: {1} layouts, {2} assets, {3} compressed bytes, {4} base64 chars" -f $OutFile, $d.LayoutCount, $d.TotalAssets, $d.CompressedLength, $d.Base64Length)
