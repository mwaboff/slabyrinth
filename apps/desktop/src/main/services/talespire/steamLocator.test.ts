import { describe, expect, it } from "vitest";
import { memoryFs } from "../testing/memoryFs";
import { locateTaleSpireViaSteam, validateInstall, type LocatorEnv } from "./steamLocator";

const LIBRARY_VDF = `
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"apps"
		{
			"228980"		"12345"
		}
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
		"apps"
		{
			"720620"		"9876543"
		}
	}
}`;

const MANIFEST = `"AppState"
{
	"appid"		"720620"
	"installdir"		"TaleSpire"
	"buildid"		"20661234"
}`;

function env(
  platform: NodeJS.Platform,
  files: Record<string, string>,
  dirs: string[],
  reg: Record<string, string> = {},
): LocatorEnv & { regCalls: string[] } {
  const regCalls: string[] = [];
  return {
    platform,
    homedir: platform === "win32" ? "C:\\Users\\gm" : "/home/gm",
    regCalls,
    execFile: (_f, args) => {
      const key = `${args[1] ?? ""}|${args[3] ?? ""}`;
      regCalls.push(key);
      const v = reg[key];
      return v === undefined
        ? Promise.reject(new Error("not found"))
        : Promise.resolve({ stdout: `\r\n${args[1] ?? ""}\r\n    ${args[3] ?? ""}    REG_SZ    ${v}\r\n` });
    },
    fs: memoryFs(files, dirs),
  };
}

describe("locating TaleSpire (core discovery + registry hints)", () => {
  it("Windows: registry → libraryfolders.vdf → appmanifest installdir", async () => {
    const e = env(
      "win32",
      {
        "C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf": LIBRARY_VDF,
        "D:\\SteamLibrary\\steamapps\\appmanifest_720620.acf": MANIFEST,
      },
      ["D:\\SteamLibrary\\steamapps\\common\\TaleSpire\\Taleweaver"],
      { "HKCU\\Software\\Valve\\Steam|SteamPath": "c:/program files (x86)/steam" },
    );
    expect(await locateTaleSpireViaSteam(e)).toEqual(["D:\\SteamLibrary\\steamapps\\common\\TaleSpire"]);
    expect(e.regCalls).toContain("HKCU\\Software\\Valve\\Steam|SteamPath");
  });

  it("Linux/Proton: Flatpak Steam root, no registry", async () => {
    const flatpak = "/home/gm/.var/app/com.valvesoftware.Steam/.local/share/Steam";
    const e = env(
      "linux",
      {
        [`${flatpak}/steamapps/libraryfolders.vdf`]: `"libraryfolders" { "0" { "path" "${flatpak}" "apps" { "720620" "1" } } }`,
        [`${flatpak}/steamapps/appmanifest_720620.acf`]: MANIFEST,
      },
      [`${flatpak}/steamapps/common/TaleSpire/Taleweaver`],
    );
    expect(await locateTaleSpireViaSteam(e)).toEqual([`${flatpak}/steamapps/common/TaleSpire`]);
    expect(e.regCalls).toEqual([]);
  });

  it("finds nothing without Steam", async () => {
    expect(await locateTaleSpireViaSteam(env("win32", {}, []))).toEqual([]);
  });

  it("validates a manual folder (accepts the Taleweaver folder itself), probing only that path", async () => {
    const e = env("win32", {}, ["E:\\Games\\TaleSpire\\Taleweaver", "E:\\Other"]);
    expect(await validateInstall(e, "E:\\Games\\TaleSpire\\")).toEqual({
      valid: true,
      path: "E:\\Games\\TaleSpire",
    });
    expect(await validateInstall(e, "E:\\Games\\TaleSpire\\Taleweaver")).toEqual({
      valid: true,
      path: "E:\\Games\\TaleSpire",
    });
    expect((await validateInstall(e, "E:\\Other")).reason).toMatch(/TaleSpire\.exe/);
    expect(await validateInstall(e, "Z:\\nope")).toMatchObject({
      valid: false,
      reason: "That folder doesn't exist.",
    });
  });
});
