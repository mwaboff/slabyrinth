# Extract-AssetCatalog.ps1 - read TaleSpire's per-pack asset indexes (READ-ONLY) and write a normalized
# catalog of placeable Tiles and Props to data/talespire-assets.json.
#
# Source of truth: the BINARY index  Taleweaver/<packGuid>/index  (kept current by game updates), parsed by
# TsIndexReader.cs. The plain index.json is NOT maintained by updates (stale since Jun/Sep 2026 on this
# machine); it is only used as a per-pack fallback when the binary file is missing or fails to parse.
#
# Usage (Windows PowerShell 5.1):
#   powershell -ExecutionPolicy Bypass -File tools\research\Extract-AssetCatalog.ps1 [-TaleweaverDir <dir>] [-OutFile <path>] [-Source auto|binary|json] [-CrossCheck]
#   -CrossCheck compares binary vs index.json field by field and reports differences (= what updates changed).
param(
    [string]$TaleweaverDir = "C:\Program Files (x86)\Steam\steamapps\common\TaleSpire\Taleweaver",
    [string]$OutFile = '',
    [ValidateSet('auto', 'binary', 'json')][string]$Source = 'auto',
    [switch]$CrossCheck
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutFile) { $OutFile = Join-Path $here '..\..\data\talespire-assets.json' }
Add-Type -AssemblyName System.Web.Extensions
if (-not ('TsIndexReader' -as [type])) { Add-Type -Path (Join-Path $here 'TsIndexReader.cs') }
$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue

function Round4([double]$v) { [Math]::Round($v, 4) }
function Sha256([string]$path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower() }

# Normalised intermediate record: id,name,kind,folder,groupTag,tags,deprecated,interactable,cx..ez,meshParts
function New-Rec($id, $name, $kind, $folder, $group, $tags, $dep, $inter, $c, $e, $parts) {
    [pscustomobject]@{ id = $id; name = $name; kind = $kind; folder = $folder; groupTag = $group; tags = @($tags); deprecated = [bool]$dep; interactable = [bool]$inter
        cx = [double]$c[0]; cy = [double]$c[1]; cz = [double]$c[2]; ex = [double]$e[0]; ey = [double]$e[1]; ez = [double]$e[2]; meshParts = [int]$parts }
}
function Read-Binary($path) {
    $r = [TsIndexReader]::Read([IO.File]::ReadAllBytes($path))
    $recs = @()
    if ($r.Ok) {
        foreach ($a in $r.Assets) {
            if ($a.Kind -ne 'tile' -and $a.Kind -ne 'prop') { continue }
            if (-not $a.HasBounds) { $r.Warnings.Add("no board-object record for $($a.Id)"); continue }
            $recs += New-Rec $a.Id $a.Name $a.Kind $a.Folder $a.GroupTag $a.Tags $a.Deprecated $a.Interactable @($a.Cx, $a.Cy, $a.Cz) @($a.Ex, $a.Ey, $a.Ez) $a.MeshParts
        }
    }
    [pscustomobject]@{ ok = $r.Ok; error = $r.Error; version = $r.Version; schema = $r.SchemaGuid; name = $r.PackName; warnings = @($r.Warnings); recs = $recs
        creatures = @($r.Assets | Where-Object { $_.Kind -eq 'creature' }).Count }
}
function Read-Json($path) {
    $j = $ser.DeserializeObject([IO.File]::ReadAllText($path))
    $recs = @()
    foreach ($kindKey in 'Tiles', 'Props') {
        foreach ($t in $j[$kindKey]) {
            $bb = $t['ColliderBoundsBound']; $c = $bb['m_Center']; $e = $bb['m_Extent']
            $recs += New-Rec $t['Id'] $t['Name'] $(if ($kindKey -eq 'Tiles') { 'tile' } else { 'prop' }) $t['Folder'] ([string]$t['GroupTag']) $t['Tags'] $t['IsDeprecated'] $t['IsInteractable'] @($c['x'], $c['y'], $c['z']) @($e['x'], $e['y'], $e['z']) @($t['Assets']).Count
        }
    }
    [pscustomobject]@{ ok = $true; name = $j['Name']; recs = $recs; creatures = @($j['Creatures']).Count }
}
function Compare-Recs($bin, $js) {
    $B = @{}; foreach ($x in $bin) { $B[$x.id] = $x }
    $Jm = @{}; foreach ($x in $js) { $Jm[$x.id] = $x }
    $out = [ordered]@{ added = @(); removed = @(); changed = @() }
    foreach ($x in $bin) {
        $y = $Jm[$x.id]
        if (-not $y) { $out.added += "$($x.kind) $($x.id) '$($x.name)' [$($x.folder)]"; continue }
        $d = @()
        foreach ($f in 'name', 'kind', 'folder', 'groupTag', 'deprecated', 'interactable', 'meshParts') { if ("$($x.$f)" -ne "$($y.$f)") { $d += "$f '$($y.$f)'->'$($x.$f)'" } }
        if (($x.tags -join '|') -ne ($y.tags -join '|')) { $d += 'tags' }
        $bd = [Math]::Abs($x.cx - $y.cx) + [Math]::Abs($x.cy - $y.cy) + [Math]::Abs($x.cz - $y.cz) + [Math]::Abs($x.ex - $y.ex) + [Math]::Abs($x.ey - $y.ey) + [Math]::Abs($x.ez - $y.ez)
        if ($bd -gt 0.001) { $d += 'bounds' }
        if ($d.Count) { $out.changed += "$($x.id) '$($x.name)': $($d -join ', ')" }
    }
    foreach ($y in $js) { if (-not $B[$y.id]) { $out.removed += "$($y.kind) $($y.id) '$($y.name)'" } }
    $out
}

$packs = @()
$assets = New-Object System.Collections.ArrayList
foreach ($dir in Get-ChildItem $TaleweaverDir -Directory | Where-Object { $_.Name -match '^[0-9a-fA-F-]{36}$' }) {
    $binPath = Join-Path $dir.FullName 'index'
    $jsonPath = Join-Path $dir.FullName 'index.json'
    $hasBin = Test-Path $binPath; $hasJson = Test-Path $jsonPath
    if (-not $hasBin -and -not $hasJson) { continue }
    $used = $null; $res = $null; $notes = @()
    if ($Source -ne 'json' -and $hasBin) {
        $res = Read-Binary $binPath
        if ($res.ok) { $used = 'binary' } else { $notes += "binary index failed: $($res.error)"; Write-Warning "$($dir.Name): binary index failed ($($res.error))" }
        if ($res.warnings.Count) { $notes += $res.warnings; $res.warnings | Select-Object -First 5 | ForEach-Object { Write-Warning "$($dir.Name): $_" } }
    }
    if (-not $used -and $Source -ne 'binary' -and $hasJson) {
        $res = Read-Json $jsonPath; $used = 'json'
        $notes += 'FALLBACK to index.json: may be stale (not maintained by game updates)'
    }
    if (-not $used) { Write-Warning "$($dir.Name): no usable index"; continue }
    $diff = $null
    if ($CrossCheck -and $used -eq 'binary' -and $hasJson) { $diff = Compare-Recs $res.recs (Read-Json $jsonPath).recs }
    $packs += [ordered]@{
        packId = $dir.Name; name = $res.name; source = $used
        binaryIndex = $(if ($hasBin) { [ordered]@{ bytes = (Get-Item $binPath).Length; modifiedUtc = (Get-Item $binPath).LastWriteTimeUtc.ToString('o'); sha256 = (Sha256 $binPath); formatVersion = $res.version; schemaId = $res.schema } } else { $null })
        indexJsonModifiedUtc = $(if ($hasJson) { (Get-Item $jsonPath).LastWriteTimeUtc.ToString('o') } else { $null })
        tiles = @($res.recs | Where-Object kind -eq 'tile').Count; props = @($res.recs | Where-Object kind -eq 'prop').Count; creatures = $res.creatures
        notes = $notes
        crossCheckVsIndexJson = $(if ($diff) { [ordered]@{ added = $diff.added.Count; removed = $diff.removed.Count; changed = $diff.changed.Count } } else { $null })
    }
    if ($diff) {
        Write-Host ("{0}: binary vs index.json -> added {1}, removed {2}, changed {3}" -f $res.name, $diff.added.Count, $diff.removed.Count, $diff.changed.Count)
        ($diff.added + $diff.removed + $diff.changed) | Select-Object -First 50 | ForEach-Object { Write-Host "    $_" }
    }
    foreach ($t in $res.recs) {
        $size = @{ x = 2 * $t.ex; y = 2 * $t.ey; z = 2 * $t.ez }
        $min = @{ x = $t.cx - $t.ex; y = $t.cy - $t.ey; z = $t.cz - $t.ez }
        $originAt = if ([Math]::Abs($min.x) -lt 0.02 -and [Math]::Abs($min.z) -lt 0.02) { 'minCorner' }
                    elseif ([Math]::Abs($t.cx) -lt 0.1 -and [Math]::Abs($t.cz) -lt 0.1) { 'center' }
                    else { 'other' }
        $sizeTag = @($t.tags | Where-Object { $_ -match '^\d+x\d+(x\d+)?$' }) | Select-Object -First 1
        [void]$assets.Add([ordered]@{
            uuid = $t.id; name = $t.name; kind = $t.kind; pack = $res.name; packId = $dir.Name
            folder = $t.folder; groupTag = $t.groupTag; tags = @($t.tags)
            deprecated = $t.deprecated; interactable = $t.interactable
            size = [ordered]@{ x = (Round4 $size.x); y = (Round4 $size.y); z = (Round4 $size.z) }
            footprintCells = [ordered]@{ x = [int][Math]::Max(1, [Math]::Ceiling($size.x - 0.01)); z = [int][Math]::Max(1, [Math]::Ceiling($size.z - 0.01)) }
            boundsCenter = [ordered]@{ x = (Round4 $t.cx); y = (Round4 $t.cy); z = (Round4 $t.cz) }
            boundsMin = [ordered]@{ x = (Round4 $min.x); y = (Round4 $min.y); z = (Round4 $min.z) }
            originAt = $originAt; sizeTag = $sizeTag; meshParts = $t.meshParts
        })
    }
}
$doc = [ordered]@{
    description = 'Placeable TaleSpire Tiles and Props extracted from the local install (Taleweaver/<packId>/index binary index, v5; index.json only as fallback). Units are tiles (1 tile = 1 grid square = 5 ft; y is up). size = 2 x collider extent (unrotated). boundsMin/boundsCenter are relative to the asset origin. originAt: minCorner (tiles) or center (props). footprintCells rounds size up to whole cells. Deprecated assets are kept so old slabs can be decoded; do not emit them.'
    generatedBy = 'tools/research/Extract-AssetCatalog.ps1'
    generatedUtc = (Get-Date).ToUniversalTime().ToString('o')
    packs = $packs
    count = $assets.Count
    assets = $assets
}
$json = $doc | ConvertTo-Json -Depth 8 -Compress
[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutFile), $json, (New-Object Text.UTF8Encoding($false)))
Write-Host ("Wrote {0} assets ({1} packs) to {2}" -f $assets.Count, $packs.Count, $OutFile)
foreach ($p in $packs) { Write-Host ("  {0} [{1}] source={2} tiles={3} props={4}" -f $p.name, $p.packId, $p.source, $p.tiles, $p.props) }
