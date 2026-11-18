import { describe, expect, it } from "vitest";
import type { AssetCatalog, Palette } from "../../../src/contracts/compiler";
import {
  NULL_AVAILABILITY,
  buildCatalogFromInstall,
  changedFiles,
  createAvailability,
  diffCatalogs,
  joinPath,
  locateTaleSpire,
  parseAppManifest,
  parseLibraryFolders,
  parseVdf,
  planFingerprint,
  steamRootCandidates,
  type ReadonlyFs,
} from "../../../src/catalog";
import { FIXTURE_ASSETS, buildIndexFixture } from "./indexFixture";

/** In-memory read-only fs keyed by normalised path. */
function memFs(
  files: Record<string, string | Uint8Array>,
  mtimes: Record<string, number> = {},
): ReadonlyFs & { reads: string[] } {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const dirs = new Set<string>();
  for (const k of map.keys()) {
    const parts = k.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const reads: string[] = [];
  const toBytes = (v: string | Uint8Array): Uint8Array =>
    typeof v === "string" ? new TextEncoder().encode(v) : v;
  return {
    reads,
    stat: (p) => {
      const k = norm(p);
      const v = map.get(k);
      if (v !== undefined)
        return Promise.resolve({ size: toBytes(v).length, mtimeMs: mtimes[k] ?? 1000, isDirectory: false });
      return Promise.resolve(dirs.has(k) ? { size: 0, mtimeMs: 0, isDirectory: true } : null);
    },
    readFile: (p) => {
      const v = map.get(norm(p));
      if (v === undefined) return Promise.reject(new Error(`ENOENT ${p}`));
      reads.push(norm(p));
      return Promise.resolve(toBytes(v));
    },
    readText: (p) => {
      const v = map.get(norm(p));
      if (v === undefined) return Promise.reject(new Error(`ENOENT ${p}`));
      return Promise.resolve(typeof v === "string" ? v : new TextDecoder().decode(v));
    },
    listDir: (p) => {
      const k = norm(p) + "/";
      const names = new Set<string>();
      for (const f of [...map.keys(), ...dirs])
        if (f.startsWith(k)) names.add(f.slice(k.length).split("/")[0] ?? "");
      return Promise.resolve([...names].filter(Boolean));
    },
  };
}

const LIBRARYFOLDERS = `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"
\t\t"label"\t\t""
\t\t"apps"
\t\t{
\t\t\t"228980"\t\t"0"
\t\t}
\t}
\t"1"
\t{
\t\t"path"\t\t"D:\\\\SteamLibrary"
\t\t"apps"
\t\t{
\t\t\t"720620"\t\t"5123456789"
\t\t}
\t}
}`;

const MANIFEST = `"AppState"
{
\t"appid"\t\t"720620"
\t"name"\t\t"TaleSpire"
\t"installdir"\t\t"TaleSpire"
\t"buildid"\t\t"20871234" // comment
}`;

describe("VDF / KeyValues", () => {
  it("parses nested libraryfolders.vdf with escaped backslashes", () => {
    expect(parseLibraryFolders(LIBRARYFOLDERS)).toEqual([
      { path: "C:\\Program Files (x86)\\Steam", apps: ["228980"] },
      { path: "D:\\SteamLibrary", apps: ["720620"] },
    ]);
  });
  it("parses the legacy flat format", () => {
    const legacy = `"LibraryFolders"\n{\n\t"TimeNextStatsReport"\t"1"\n\t"ContentStatsID"\t"-1"\n\t"1"\t"/home/me/games/steam"\n}`;
    expect(parseLibraryFolders(legacy)).toEqual([{ path: "/home/me/games/steam", apps: [] }]);
  });
  it("parses app manifests and ignores comments", () => {
    expect(parseAppManifest(MANIFEST)).toEqual({
      appid: "720620",
      name: "TaleSpire",
      installdir: "TaleSpire",
      buildid: "20871234",
    });
  });
  it("handles unquoted tokens and rejects broken input", () => {
    expect(parseVdf("a { b c }")).toEqual({ a: { b: "c" } });
    expect(() => parseVdf('"a" { "b" "c"')).toThrow();
    expect(() => parseVdf('"a" "unterminated')).toThrow();
  });
});

describe("install discovery", () => {
  it("lists Windows and Linux/Proton Steam roots", () => {
    expect(
      steamRootCandidates({ platform: "win32", registrySteamPath: "c:/program files (x86)/steam" })[0],
    ).toBe("c:\\program files (x86)\\steam");
    expect(steamRootCandidates({ platform: "linux", home: "/home/me" })).toEqual([
      "/home/me/.steam/steam",
      "/home/me/.steam/root",
      "/home/me/.local/share/Steam",
      "/home/me/.var/app/com.valvesoftware.Steam/.local/share/Steam",
      "/home/me/snap/steam/common/.local/share/Steam",
    ]);
  });
  it("joinPath keeps the base's separator style", () => {
    expect(joinPath("C:\\Steam", "steamapps/common", "TaleSpire")).toBe(
      "C:\\Steam\\steamapps\\common\\TaleSpire",
    );
    expect(joinPath("/home/me/", "a\\b")).toBe("/home/me/a/b");
  });
  it("finds TaleSpire in a secondary Windows library via libraryfolders.vdf + appmanifest", async () => {
    const fs = memFs({
      "C:/Program Files (x86)/Steam/steamapps/libraryfolders.vdf": LIBRARYFOLDERS,
      "D:/SteamLibrary/steamapps/appmanifest_720620.acf": MANIFEST,
      "D:/SteamLibrary/steamapps/common/TaleSpire/Taleweaver/d71427a1-5535-4fa7-82d7-4ca1e75edbfd/index": "x",
    });
    const r = await locateTaleSpire(fs, { platform: "win32" });
    expect(r.install).toMatchObject({
      installPath: "D:\\SteamLibrary\\steamapps\\common\\TaleSpire",
      taleweaverPath: "D:\\SteamLibrary\\steamapps\\common\\TaleSpire\\Taleweaver",
      buildId: "20871234",
      how: "steam-library",
      protonUserData: null,
    });
  });
  it("finds a Flatpak Steam install on Linux and derives the Proton user-data folder", async () => {
    const root = "/home/me/.var/app/com.valvesoftware.Steam/.local/share/Steam";
    const fs = memFs({
      [`${root}/steamapps/libraryfolders.vdf`]: `"libraryfolders" { "0" { "path" "${root}" "apps" { "720620" "1" } } }`,
      [`${root}/steamapps/common/TaleSpire/Taleweaver/x/index.json`]: "{}",
    });
    const r = await locateTaleSpire(fs, { platform: "linux", home: "/home/me" });
    expect(r.install?.installPath).toBe(`${root}/steamapps/common/TaleSpire`);
    expect(r.install?.protonUserData).toBe(
      `${root}/steamapps/compatdata/720620/pfx/drive_c/users/steamuser/AppData/LocalLow/BouncyRock Entertainment/TaleSpire`,
    );
  });
  it("accepts a manual path (install or its Taleweaver folder) and reports what it tried", async () => {
    const fs = memFs({ "E:/Games/TaleSpire/Taleweaver/p/index": "x" });
    expect(
      (await locateTaleSpire(fs, { platform: "win32", manualPath: "E:\\Games\\TaleSpire\\Taleweaver\\" }))
        .install?.how,
    ).toBe("manual");
    const none = await locateTaleSpire(memFs({}), { platform: "linux", home: "/h" });
    expect(none.install).toBeNull();
    expect(none.tried.length).toBeGreaterThan(3);
  });
});

describe("catalog build, fingerprint and diff", () => {
  const install = "C:/TS";
  const packA = "d71427a1-5535-4fa7-82d7-4ca1e75edbfd";
  const packB = "fc3a4efc-e8d9-4d82-8620-f26c5b66023c";
  const binA = buildIndexFixture(FIXTURE_ASSETS, { packName: "Medieval Fantasy" });
  const jsonB = JSON.stringify({
    Name: "Sci-fi",
    Tiles: [
      {
        Id: "11111111-2222-3333-4444-555555555555",
        Name: "Grate",
        Tags: [],
        Folder: "F",
        GroupTag: "floor",
        Assets: [],
        ColliderBoundsBound: { m_Center: { x: 0.5, y: 0.25, z: 0.5 }, m_Extent: { x: 0.5, y: 0.25, z: 0.5 } },
      },
    ],
    Props: [],
  });
  const files = {
    [`${install}/Taleweaver/${packA}/index`]: binA,
    [`${install}/Taleweaver/${packA}/index.json`]: "{}",
    [`${install}/Taleweaver/${packB}/index`]: new Uint8Array(64), // unreadable binary → index.json fallback
    [`${install}/Taleweaver/${packB}/index.json`]: jsonB,
    [`${install}/Taleweaver/Tutorials/readme.txt`]: "ignored",
  };

  it("builds from binary indexes with a per-pack index.json fallback", async () => {
    const r = await buildCatalogFromInstall(memFs(files), install, { now: "2026-11-18T00:00:00Z" });
    expect(r.changed).toBe(true);
    expect(r.catalog.packs).toEqual([
      { packId: packA, name: "Medieval Fantasy", source: "binary-index", tiles: 2, props: 1 },
      { packId: packB, name: "Sci-fi", source: "index-json", tiles: 1, props: 0 },
    ]);
    expect(r.packs.find((p) => p.packId === packB)?.stale).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/binary index unreadable/);
    expect(r.catalog.fingerprint.files.map((f) => f.relPath)).toHaveLength(4);
    expect(r.catalog.fingerprint.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
  });

  it("reuses hashes when size+mtime match, skips re-parse when hashes match (mtime-only update)", async () => {
    const first = await buildCatalogFromInstall(memFs(files), install, { now: "t1" });
    const plan = planFingerprint(first.catalog.fingerprint, first.catalog.fingerprint.files, install);
    expect(plan.hash).toHaveLength(0);
    // the update touched mtimes only
    const fs2 = memFs(files, { [`c:/ts/taleweaver/${packA}/index`]: 99999 });
    const second = await buildCatalogFromInstall(fs2, install, { cached: first.catalog, now: "t2" });
    expect(second.changed).toBe(false);
    expect(fs2.reads).toEqual([`c:/ts/taleweaver/${packA}/index`]); // hashed once, not re-parsed further
    expect(second.catalog.generatedAt).toBe("t1");
    expect(second.report.added).toBe(0);
  });

  it("re-parses only changed packs and reports the diff", async () => {
    const first = await buildCatalogFromInstall(memFs(files), install, { now: "t1" });
    const changedAssets = FIXTURE_ASSETS.map((a) =>
      a.name === "Dungeon Wall 01"
        ? { ...a, flags: 2 }
        : a.name === "Leather Chest"
          ? { ...a, extent: [0.5, 0.209, 0.2575] as [number, number, number] }
          : a,
    ).filter((a) => a.name !== "Tavern Floor 03");
    changedAssets.push({ id: "99999999-0000-0000-0000-000000000000", name: "New Thing", kind: 2 });
    const palettes: Record<string, Palette> = {
      t: {
        schema: "slabyrinth/palette@1",
        id: "t",
        name: "t",
        defaults: { floor: "flagstone", wallStyle: "wall" },
        roles: {
          "wall.wall": {
            variants: [
              {
                asset: "63270c8a-9484-4ae8-926e-22e3de9048a1",
                geom: {
                  size: { x: 1, y: 2, z: 0.5 },
                  originAt: "minCorner",
                  boundsCenter: { x: 0.5, y: 1, z: 0.25 },
                },
              },
            ],
            fallback: "wall.stone",
          },
        },
      },
    };
    const fs2 = memFs({
      ...files,
      [`${install}/Taleweaver/${packA}/index`]: buildIndexFixture(changedAssets, {
        packName: "Medieval Fantasy",
      }),
    });
    const r = await buildCatalogFromInstall(fs2, install, { cached: first.catalog, palettes, now: "t2" });
    expect(r.changed).toBe(true);
    expect(r.packs.find((p) => p.packId === packB)?.reparsed).toBe(false);
    expect(r.report.added).toBe(1);
    expect(r.report.removed).toEqual([
      { uuid: "e62c6746-cecf-46bf-8b20-f81738f1d220", name: "Tavern Floor 03" },
    ]);
    expect(r.report.newlyDeprecated.map((x) => x.name)).toEqual(["Dungeon Wall 01"]);
    expect(r.report.geometryChanged.map((x) => x.name)).toEqual(["Leather Chest"]);
    expect(r.report.affectedPaletteRoles).toEqual([
      {
        paletteId: "t",
        role: "wall.wall",
        uuid: "63270c8a-9484-4ae8-926e-22e3de9048a1",
        resolution: "fallback_role",
      },
    ]);
    expect(changedFiles(first.catalog.fingerprint, r.catalog.fingerprint)).toEqual([
      `Taleweaver/${packA}/index`,
    ]);
  });

  it("falls back to the last good cached pack when the binary format changes", async () => {
    const first = await buildCatalogFromInstall(memFs(files), install, { now: "t1" });
    const broken = buildIndexFixture(FIXTURE_ASSETS, {
      corrupt: (_b, dv) => {
        dv.setUint32(0, 0, true);
      },
    });
    const r = await buildCatalogFromInstall(
      memFs({ ...files, [`${install}/Taleweaver/${packA}/index`]: broken }),
      install,
      { cached: first.catalog },
    );
    const a = r.packs.find((p) => p.packId === packA);
    expect(a).toMatchObject({ source: "cache", stale: true });
    expect(r.catalog.assets.filter((x) => x.packId === packA)).toHaveLength(3);
  });

  it("diff of a first build reports nothing as added", () => {
    const empty: AssetCatalog = {
      schema: "slabyrinth/asset-catalog@1",
      extractorVersion: 1,
      generatedAt: "",
      fingerprint: { installPath: "", files: [] },
      packs: [],
      assets: [],
    };
    expect(diffCatalogs(null, empty).added).toBe(0);
  });
});

describe("AssetAvailability", () => {
  it("reports status, names and keyword search; null object without catalog", async () => {
    const r = await buildCatalogFromInstall(
      memFs({
        "C:/TS/Taleweaver/d71427a1-5535-4fa7-82d7-4ca1e75edbfd/index": buildIndexFixture(FIXTURE_ASSETS),
      }),
      "C:/TS",
    );
    const av = createAvailability(r.catalog);
    expect(av.status("63270C8A-9484-4AE8-926E-22E3DE9048A1")).toBe("present");
    expect(av.status("e62c6746-cecf-46bf-8b20-f81738f1d220")).toBe("deprecated");
    expect(av.status("00000000-0000-0000-0000-000000000000")).toBe("missing");
    expect(av.name("3da5dbe8-132e-4cab-b539-cedc04b22099")).toBe("Leather Chest");
    expect(av.search("leather chest", "prop")[0]?.name).toBe("Leather Chest");
    expect(av.search("tavern floor")).toEqual([]); // deprecated assets are never offered
    expect(NULL_AVAILABILITY.status("x")).toBeNull();
  });
});
