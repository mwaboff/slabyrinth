# Build-TestVectors.ps1 - decode known-good slab strings, verify round-trip re-encoding,
# and write data/slab-test-vectors.json.
# Usage (Windows PowerShell 5.1):
#   powershell -ExecutionPolicy Bypass -File tools\research\Build-TestVectors.ps1 -InputJson <vectors-input.json> [-IndexRoot <Taleweaver dir>]
# Input JSON: [ { "id": "...", "source": "...", "note": "...", "slab": "<string>" }, ... ]
param(
    [Parameter(Mandatory = $true)][string]$InputJson,
    [string]$IndexRoot = "C:\Program Files (x86)\Steam\steamapps\common\TaleSpire\Taleweaver",
    [string]$OutFile = '',
    [int]$FullDetailMaxAssets = 300
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutFile) { $OutFile = Join-Path $here '..\..\data\slab-test-vectors.json' }
. (Join-Path $here 'SlabCodec.ps1')
Add-Type -AssemblyName System.Web.Extensions
$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue

# Optional name lookup from the local asset index (read-only).
$names = @{}
if (Test-Path $IndexRoot) {
    foreach ($pack in Get-ChildItem $IndexRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'index.json') }) {
        $j = $ser.DeserializeObject([IO.File]::ReadAllText((Join-Path $pack.FullName 'index.json')))
        foreach ($k in 'Tiles', 'Props') { foreach ($t in $j[$k]) { $names[$t['Id']] = @{ name = $t['Name']; kind = $k.TrimEnd('s').ToLower() } } }
    }
}

$inputs = $ser.DeserializeObject([IO.File]::ReadAllText($InputJson))
$sha = [Security.Cryptography.SHA256]::Create()
$out = New-Object System.Collections.ArrayList
foreach ($v in $inputs) {
    $d = Decode-Slab $v['slab']
    $e = Expand-SlabBytes $v['slab']
    $rawSha = ([BitConverter]::ToString($sha.ComputeHash($e.Raw))).Replace('-', '').ToLower()
    $full = $d.TotalAssets -le $FullDetailMaxAssets
    $roundTrip = $null
    if ($d.Version -eq 2) {
        $layoutsIn = @($d.Layouts | ForEach-Object { @{ Uuid = $_.Uuid; Assets = @($_.Assets | ForEach-Object { @{ sx = $_.sx; sy = $_.sy; sz = $_.sz; rot = $_.rot } }) } })
        $re = Get-SlabV2RawBytes $layoutsIn
        $roundTrip = ([BitConverter]::ToString($sha.ComputeHash($re))).Replace('-', '').ToLower() -eq $rawSha
    }
    $layouts = @()
    foreach ($l in $d.Layouts) {
        $info = $names[$l.Uuid]
        $lo = [ordered]@{ uuid = $l.Uuid; assetCount = [int]$l.AssetCount; name = $(if ($info) { $info.name } else { $null }); kind = $(if ($info) { $info.kind } else { $null }) }
        $list = if ($full) { $l.Assets } else { $l.Assets | Select-Object -First 3 }
        if ($d.Version -eq 2) {
            $lo['assets'] = @($list | ForEach-Object { [ordered]@{ x = $_.sx; y = $_.sy; z = $_.sz; rot = $_.rot; u64 = $_.raw } })
        } else {
            $lo['assets'] = @($list | ForEach-Object { [ordered]@{ cx = $_.cx; cy = $_.cy; cz = $_.cz; hx = $_.hx; hy = $_.hy; hz = $_.hz; rot = $_.rot } })
        }
        if (-not $full) { $lo['assetsTruncatedTo'] = @($list).Count }
        $layouts += $lo
    }
    $rec = [ordered]@{
        id = $v['id']; source = $v['source']; note = $v['note']
        slab = $v['slab']
        expected = [ordered]@{
            version = [int]$d.Version; layoutCount = [int]$d.LayoutCount; totalAssets = [int]$d.TotalAssets
            base64Length = $d.Base64Length; compressedBytes = $d.CompressedLength; decompressedBytes = $d.DecompressedLength
            gzipHeaderHex = $d.GzipHeaderHex
            decompressedSha256 = $rawSha
            trailingBytesHex = $d.TrailingBytesHex
            decompressedHex = $(if ($d.DecompressedLength -le 400) { $d.RawHex } else { $null })
            reencodeRawMatches = $roundTrip
            layouts = $layouts
        }
    }
    [void]$out.Add($rec)
    Write-Host ("{0}: v{1} layouts={2} assets={3} raw={4} roundTrip={5}" -f $v['id'], $d.Version, $d.LayoutCount, $d.TotalAssets, $d.DecompressedLength, $roundTrip)
}
$doc = [ordered]@{
    description = 'Known-good TaleSpire slab strings with decoded contents. Coordinates are the raw scaled integers (100 = 1 tile; y is vertical). rot is 0..23 (15 degree steps). For large slabs only the first 3 assets per layout are listed; decompressedSha256 covers the whole payload. reencodeRawMatches = re-encoding the decoded v2 data with tools/research/SlabCodec.ps1 reproduced the decompressed bytes exactly (gzip bytes differ by compressor and are not compared).'
    generatedBy = 'tools/research/Build-TestVectors.ps1'
    vectors = $out
}
$json = $doc | ConvertTo-Json -Depth 12 -Compress
# pretty-print lightly (JavaScriptSerializer emits compact JSON); keep compact for exactness.
[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutFile), $json, (New-Object Text.UTF8Encoding($false)))
Write-Host "Wrote $OutFile"
