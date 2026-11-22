import { describe, expect, it } from "vitest";
import type { ReadonlyFs } from "@slabyrinth/core";
import {
  findSymbiotesFolder,
  linuxSteamRoots,
  symbiotesCandidates,
  windowsSymbiotesFolder,
} from "./symbiotesFolder";

/** A read-only file system of the given folders and files. */
function fakeFs(dirs: string[], files: Record<string, string> = {}): ReadonlyFs {
  return {
    stat: (p) =>
      Promise.resolve(
        dirs.includes(p)
          ? { size: 0, mtimeMs: 0, isDirectory: true }
          : p in files
            ? { size: 1, mtimeMs: 0, isDirectory: false }
            : null,
      ),
    readFile: () => Promise.reject(new Error("unused")),
    readText: (p) => (p in files ? Promise.resolve(files[p] ?? "") : Promise.reject(new Error("missing"))),
    listDir: () => Promise.resolve([]),
  };
}

const PFX =
  "steamapps/compatdata/720620/pfx/drive_c/users/steamuser/AppData/LocalLow/BouncyRock Entertainment/TaleSpire";

describe("Symbiotes folder", () => {
  it("Windows: the LocalLow folder the official docs name", async () => {
    const home = "C:\\Users\\gm";
    const want = "C:\\Users\\gm\\AppData\\LocalLow\\BouncyRock Entertainment\\TaleSpire\\Symbiotes";
    expect(windowsSymbiotesFolder(home)).toBe(want);
    const fs = fakeFs(["C:\\Users\\gm\\AppData\\LocalLow\\BouncyRock Entertainment\\TaleSpire"]);
    expect(await findSymbiotesFolder({ platform: "win32", homedir: home, fs }, null)).toEqual({
      found: { path: want, source: "default" },
      tried: [want],
    });
    expect(
      (await findSymbiotesFolder({ platform: "win32", homedir: home, fs: fakeFs([]) }, null)).found,
    ).toBeNull();
  });

  it("Linux: inside the Proton prefix of the library that holds TaleSpire, that library first", async () => {
    const home = "/home/gm";
    const vdf = `"libraryfolders"
{
  "0" { "path" "/home/gm/.local/share/Steam" "apps" { "228980" "1" } }
  "1" { "path" "/mnt/games/SteamLibrary" "apps" { "720620" "123" } }
}`;
    const fs = fakeFs([`/mnt/games/SteamLibrary/${PFX}`], {
      "/home/gm/.steam/steam/steamapps/libraryfolders.vdf": vdf,
    });
    const list = await symbiotesCandidates({ platform: "linux", homedir: home, fs });
    expect(list[0]).toEqual({ path: `/mnt/games/SteamLibrary/${PFX}/Symbiotes`, source: "proton" });
    const r = await findSymbiotesFolder({ platform: "linux", homedir: home, fs }, null);
    expect(r.found).toEqual({ path: `/mnt/games/SteamLibrary/${PFX}/Symbiotes`, source: "proton" });
  });

  it("Linux: every known Steam root is tried, Flatpak's data folder too", async () => {
    const roots = linuxSteamRoots("/home/gm");
    expect(roots).toEqual(
      expect.arrayContaining([
        "/home/gm/.steam/steam",
        "/home/gm/.local/share/Steam",
        "/home/gm/.var/app/com.valvesoftware.Steam/.local/share/Steam",
        "/home/gm/.var/app/com.valvesoftware.Steam/data/Steam",
      ]),
    );
    const r = await findSymbiotesFolder({ platform: "linux", homedir: "/home/gm", fs: fakeFs([]) }, null);
    expect(r.found).toBeNull();
    expect(r.tried).toContain(`/home/gm/.local/share/Steam/${PFX}/Symbiotes`);
  });

  it("a folder chosen by hand is the only one looked at, and must exist", async () => {
    const env = { platform: "win32" as const, homedir: "C:\\Users\\gm", fs: fakeFs(["D:\\Symbiotes"]) };
    expect(await findSymbiotesFolder(env, "D:\\Symbiotes")).toEqual({
      found: { path: "D:\\Symbiotes", source: "manual" },
      tried: ["D:\\Symbiotes"],
    });
    expect((await findSymbiotesFolder(env, "E:\\Gone")).found).toBeNull();
  });
});
