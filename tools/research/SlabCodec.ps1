# SlabCodec.ps1 - reference TaleSpire slab decoder/encoder in Windows PowerShell 5.1 (.NET only).
# Dot-source it:  . .\tools\research\SlabCodec.ps1
#   $s = Decode-Slab -SlabString $str          # -> object with Version, Layouts, Assets, TrailingBytes, RawHex
#   $str = Encode-SlabV2 -Layouts $layouts     # layouts: @( @{ Uuid='...'; Assets=@( @{x=0;y=0;z=0;rot=0} ) } )
# Format: see docs/talespire-slab-format.md

Set-StrictMode -Version 2

function ConvertFrom-SlabUuidBytes([byte[]]$b, [int]$off) {
    # .NET Guid byte order: first 3 groups little-endian, last 8 bytes as-is.
    $g = New-Object byte[] 16
    [Array]::Copy($b, $off, $g, 0, 16)
    return ([Guid]::new($g)).ToString()
}

function ConvertTo-SlabUuidBytes([string]$uuid) {
    return ([Guid]::Parse($uuid)).ToByteArray()
}

function Expand-SlabBytes([string]$SlabString) {
    $s = $SlabString.Trim()
    if ($s.StartsWith('```')) { $s = $s.Substring(3) }
    if ($s.EndsWith('```')) { $s = $s.Substring(0, $s.Length - 3) }
    $s = $s.Trim()
    $compressed = [Convert]::FromBase64String($s)
    $in = New-Object System.IO.MemoryStream(, $compressed)
    $gz = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
    $out = New-Object System.IO.MemoryStream
    $gz.CopyTo($out); $gz.Dispose()
    return [pscustomobject]@{ Compressed = $compressed; Raw = $out.ToArray(); Base64 = $s }
}

function Decode-Slab([string]$SlabString) {
    $e = Expand-SlabBytes $SlabString
    $b = $e.Raw
    $magic = [BitConverter]::ToUInt32($b, 0)
    if ($magic -ne [uint32]3520002766) { throw ("Bad magic 0x{0:X8}" -f $magic) }
    $version = [BitConverter]::ToUInt16($b, 4)
    $layoutCount = [BitConverter]::ToUInt16($b, 6)
    $p = 8
    $creatureCount = $null
    $layouts = @()
    if ($version -eq 2) {
        $creatureCount = [BitConverter]::ToUInt16($b, 8); $p = 10
        for ($i = 0; $i -lt $layoutCount; $i++) {
            $layouts += [pscustomobject]@{
                Uuid = ConvertFrom-SlabUuidBytes $b $p
                AssetCount = [BitConverter]::ToUInt16($b, $p + 16)
                Reserved = [BitConverter]::ToUInt16($b, $p + 18)
                Assets = New-Object System.Collections.ArrayList
            }
            $p += 20
        }
        foreach ($l in $layouts) {
            for ($j = 0; $j -lt $l.AssetCount; $j++) {
                $v = [BitConverter]::ToUInt64($b, $p); $p += 8
                $mask = [uint64]0x3FFFF
                $sx = [int]($v -band $mask)
                $sy = [int](($v -shr 18) -band $mask)
                $sz = [int](($v -shr 36) -band $mask)
                $rot = [int](($v -shr 54) -band 0x1F)
                $extra = [int](($v -shr 59) -band 0x1F)
                [void]$l.Assets.Add([pscustomobject]@{ sx = $sx; sy = $sy; sz = $sz; rot = $rot; extra = $extra; raw = ('0x{0:X16}' -f $v) })
            }
        }
    } elseif ($version -eq 1) {
        # v1 (legacy, pre-"Chimera"): no creature count; layouts as v2; assets are 28 bytes:
        # float3 center, float3 half-extents, u8 rot, 3 pad bytes; then float3 center + float3 size of whole slab.
        for ($i = 0; $i -lt $layoutCount; $i++) {
            $layouts += [pscustomobject]@{
                Uuid = ConvertFrom-SlabUuidBytes $b $p
                AssetCount = [BitConverter]::ToUInt16($b, $p + 16)
                Reserved = [BitConverter]::ToUInt16($b, $p + 18)
                Assets = New-Object System.Collections.ArrayList
            }
            $p += 20
        }
        foreach ($l in $layouts) {
            for ($j = 0; $j -lt $l.AssetCount; $j++) {
                $f = 0..5 | ForEach-Object { [BitConverter]::ToSingle($b, $p + 4 * $_) }
                [void]$l.Assets.Add([pscustomobject]@{ cx = $f[0]; cy = $f[1]; cz = $f[2]; hx = $f[3]; hy = $f[4]; hz = $f[5]; rot = [int]$b[$p + 24] })
                $p += 28
            }
        }
        $p += 24  # slab bounds: 6 x float32 (left in TrailingBytes for inspection)
        $p -= 24
    } else { throw "Unknown version $version" }
    $trailing = New-Object byte[] ($b.Length - $p)
    [Array]::Copy($b, $p, $trailing, 0, $b.Length - $p)
    $gzHeader = ($e.Compressed[0..9] | ForEach-Object { '{0:X2}' -f $_ }) -join ' '
    return [pscustomobject]@{
        Version = $version; LayoutCount = $layoutCount; CreatureCount = $creatureCount
        Layouts = $layouts
        TotalAssets = ($layouts | ForEach-Object { $_.AssetCount } | Measure-Object -Sum).Sum
        DecompressedLength = $b.Length; CompressedLength = $e.Compressed.Length; Base64Length = $e.Base64.Length
        GzipHeaderHex = $gzHeader
        TrailingBytesHex = (($trailing | ForEach-Object { '{0:X2}' -f $_ }) -join ' ')
        RawHex = (($b | ForEach-Object { '{0:X2}' -f $_ }) -join '')
    }
}

function Pack-SlabAsset([int]$sx, [int]$sy, [int]$sz, [int]$rot) {
    foreach ($c in @($sx, $sy, $sz)) { if ($c -lt 0 -or $c -gt 262143) { throw "scaled coordinate $c out of range 0..262143" } }
    if ($rot -lt 0 -or $rot -gt 23) { throw "rot $rot out of range 0..23" }
    return ([uint64]$sx) -bor ([uint64]$sy -shl 18) -bor ([uint64]$sz -shl 36) -bor ([uint64]$rot -shl 54)
}

function Get-SlabV2RawBytes($Layouts, [switch]$NoTrailer) {
    # $Layouts: array of @{ Uuid; Assets = @(@{sx;sy;sz;rot}) }  (sx/sy/sz are scaled ints, 100 = 1 tile)
    $ms = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter($ms)
    $w.Write([uint32]3520002766)  # 0xD1CEFACE (PS hex literal would be a negative Int32)
    $w.Write([uint16]2)
    $w.Write([uint16]$Layouts.Count)
    $w.Write([uint16]0)
    foreach ($l in $Layouts) {
        [byte[]]$ub = ([Guid]::Parse($l.Uuid)).ToByteArray(); $w.Write($ub, 0, 16)
        $w.Write([uint16]@($l.Assets).Count)
        $w.Write([uint16]0)
    }
    foreach ($l in $Layouts) {
        foreach ($a in @($l.Assets)) { $w.Write([uint64](Pack-SlabAsset $a.sx $a.sy $a.sz $a.rot)) }
    }
    if (-not $NoTrailer) { $w.Write([uint16]0) }
    $w.Flush()
    return ,$ms.ToArray()
}

function Compress-SlabBytes([byte[]]$Raw) {
    $out = New-Object System.IO.MemoryStream
    $gz = New-Object System.IO.Compression.GZipStream($out, [System.IO.Compression.CompressionLevel]::Optimal)
    $gz.Write($Raw, 0, $Raw.Length); $gz.Dispose()
    return ,$out.ToArray()
}

function Encode-SlabV2($Layouts, [switch]$Fenced) {
    $raw = Get-SlabV2RawBytes $Layouts
    $c = Compress-SlabBytes $raw
    if ($c.Length -gt 30720) { Write-Warning "Compressed slab is $($c.Length) bytes (> 30720 limit)" }
    $s = [Convert]::ToBase64String($c)
    if ($Fenced) { return '```' + $s + '```' }
    return $s
}
