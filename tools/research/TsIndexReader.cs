// TsIndexReader.cs - reader for TaleSpire's binary per-pack asset index (Taleweaver/<packGuid>/index),
// format version 5 as of the 2026-11-18 game build. Reverse-engineered; see docs/talespire-assets.md
// section "Binary index format". Pure .NET Framework 4.x / C# 5, no dependencies. Loaded by
// Extract-AssetCatalog.ps1 via Add-Type. Port to TypeScript 1:1 (DataView, little-endian).
//
// Encoding conventions (all VERIFIED on v5):
//   - little-endian; "ptr" = int32 offset RELATIVE TO THE ADDRESS OF THE PTR FIELD ITSELF
//   - string = { ptr, u32 lengthInUtf16CodeUnits } -> UTF-16LE, not NUL-terminated
//   - array  = { ptr, u32 count }
//   - guid   = 16 bytes in .NET Guid.ToByteArray() order (same as slabs)
using System;
using System.Collections.Generic;
using System.Text;

public sealed class TsIndexAsset
{
    public string Id, Name, Kind, Category, Folder, GroupTag;
    public string[] Tags;
    public bool Deprecated, Interactable;
    public uint Flags, KindCode, GroupTagExtra, FootprintA, FootprintB, MainUnknown32;
    public bool HasBounds;
    public float Cx, Cy, Cz, Ex, Ey, Ez;
    public int MeshParts, ColliderCount;
}

public sealed class TsIndexResult
{
    public string PackName, SchemaGuid;
    public uint Version;
    public List<TsIndexAsset> Assets = new List<TsIndexAsset>();
    public List<string> Warnings = new List<string>();
    public bool Ok;
    public string Error;
}

public static class TsIndexReader
{
    public const uint Magic = 0xD1CED1CE;
    public const uint KnownVersion = 5;
    public const string KnownSchema = "2061c3a8-4467-113e-1ab5-705888f6959f"; // bytes 0x10..0x1F of v5 files
    const int BoardObjectSize = 176;   // v5
    const int SearchColumns = 10;      // v5

    static byte[] b;
    static int I32(int o) { Check(o, 4); return BitConverter.ToInt32(b, o); }
    static uint U32(int o) { Check(o, 4); return BitConverter.ToUInt32(b, o); }
    static float F32(int o) { Check(o, 4); return BitConverter.ToSingle(b, o); }
    static void Check(int o, int n) { if (o < 0 || o + n > b.Length) throw new FormatException("read out of bounds at 0x" + o.ToString("X")); }
    static int Ptr(int fieldAt) { int rel = I32(fieldAt); return rel == 0 ? -1 : fieldAt + rel; }
    static string Str(int fieldAt)
    {
        uint n = U32(fieldAt + 4);
        if (n == 0) return "";
        int p = Ptr(fieldAt);
        if (n > 100000) throw new FormatException("implausible string length at 0x" + fieldAt.ToString("X"));
        Check(p, (int)n * 2);
        return Encoding.Unicode.GetString(b, p, (int)n * 2);
    }
    static string Guid16(int o) { Check(o, 16); var g = new byte[16]; Array.Copy(b, o, g, 0, 16); return new Guid(g).ToString(); }

    public static TsIndexResult Read(byte[] bytes)
    {
        var r = new TsIndexResult();
        b = bytes;
        try
        {
            if (b.Length < 0x40) throw new FormatException("file too short");
            if (U32(0) != Magic) throw new FormatException("bad magic 0x" + U32(0).ToString("X8"));
            r.Version = U32(4);
            r.SchemaGuid = Guid16(0x10);
            if (r.Version != KnownVersion) r.Warnings.Add("unknown index version " + r.Version + " (reader built for v" + KnownVersion + ")");
            if (r.SchemaGuid != KnownSchema) r.Warnings.Add("unknown schema id " + r.SchemaGuid);
            ulong root64 = BitConverter.ToUInt64(b, 8);
            if (root64 >= (ulong)b.Length) throw new FormatException("root offset out of range");
            int root = (int)root64;
            r.PackName = Str(root + 0);

            // ---- search table: SearchColumns x {ptr,count}; column 0 = ids (16 B), all columns share count
            int tbl = Ptr(root + 8);
            if (tbl < 0) throw new FormatException("no search table");
            int n = (int)U32(tbl + 4);
            int[] col = new int[SearchColumns];
            for (int c = 0; c < SearchColumns; c++)
            {
                col[c] = Ptr(tbl + 8 * c);
                if ((int)U32(tbl + 8 * c + 4) != n) throw new FormatException("search column " + c + " count mismatch");
            }
            var byId = new Dictionary<string, TsIndexAsset>();
            for (int i = 0; i < n; i++)
            {
                var a = new TsIndexAsset();
                a.Id = Guid16(col[0] + 16 * i);
                a.Name = Str(col[1] + 8 * i);
                a.Category = Str(col[2] + 8 * i);       // "TILE", "PROP", "CREATURE <type>"
                a.Folder = Str(col[3] + 8 * i);
                a.GroupTag = Str(col[4] + 12 * i);
                a.GroupTagExtra = U32(col[4] + 12 * i + 8);
                a.FootprintA = U32(col[5] + 8 * i);
                a.FootprintB = U32(col[5] + 8 * i + 4);
                int tagArr = col[6] + 8 * i;
                int tc = (int)U32(tagArr + 4);
                if (tc > 1000) throw new FormatException("implausible tag count");
                a.Tags = new string[tc];
                int tp = Ptr(tagArr);
                for (int k = 0; k < tc; k++) a.Tags[k] = Str(tp + 8 * k);
                a.Flags = U32(col[7] + 4 * i);
                a.Deprecated = (a.Flags & 2) != 0;
                // col[8]: 64-byte content reference (pack guid, ...), not needed
                a.KindCode = U32(col[9] + 4 * i);
                a.Kind = a.KindCode == 1 ? "tile" : a.KindCode == 2 ? "prop" : a.KindCode == 4 ? "creature" : "unknown" + a.KindCode;
                if (byId.ContainsKey(a.Id)) r.Warnings.Add("duplicate id " + a.Id); else byId[a.Id] = a;
                r.Assets.Add(a);
            }

            // ---- board objects (tiles + props): array at root+16 of 176-byte records
            int arr = Ptr(root + 16);
            int m = (int)U32(root + 20);
            for (int i = 0; i < m; i++)
            {
                int rec = arr + BoardObjectSize * i;
                string id = Guid16(rec + 8);
                TsIndexAsset a;
                if (!byId.TryGetValue(id, out a)) { r.Warnings.Add("board object " + id + " missing from search table"); continue; }
                if (Str(rec + 0) != a.Name) r.Warnings.Add("name mismatch for " + id);
                uint k = U32(rec + 24);
                if (k != a.KindCode) r.Warnings.Add("kind mismatch for " + id);
                a.MainUnknown32 = U32(rec + 32);
                a.MeshParts = (int)U32(rec + 40);
                a.ColliderCount = (int)U32(rec + 48);
                a.Cx = F32(rec + 60); a.Cy = F32(rec + 64); a.Cz = F32(rec + 68);
                a.Ex = F32(rec + 72); a.Ey = F32(rec + 76); a.Ez = F32(rec + 80);
                a.HasBounds = true;
                a.Interactable = I32(rec + 112) != 0;
                if (float.IsNaN(a.Ex) || a.Ex < 0 || a.Ex > 1000) r.Warnings.Add("implausible bounds for " + id);
            }
            r.Ok = true;
        }
        catch (Exception e) { r.Ok = false; r.Error = e.Message; }
        finally { b = null; }
        return r;
    }
}
