/** Node implementations of core's injected ports (read-only file system, Steam registry lookup). CLI only. */
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import type { ReadonlyFs, SteamRootHints } from "../catalog/index";

export const nodeReadonlyFs: ReadonlyFs = {
  async stat(path) {
    try {
      const s = await fsp.stat(path);
      return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
    } catch {
      return null;
    }
  },
  async readFile(path) {
    return new Uint8Array(await fsp.readFile(path));
  },
  async readText(path) {
    return fsp.readFile(path, "utf8");
  },
  async listDir(path) {
    try {
      return await fsp.readdir(path);
    } catch {
      return [];
    }
  },
};

function regValue(key: string, name: string): string | null {
  try {
    const out = execFileSync("reg", ["query", key, "/v", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const m = new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`).exec(out);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Platform hints for locateTaleSpire (reads the Steam registry values on Windows; read-only). */
export function hostSteamHints(): SteamRootHints {
  const platform = process.platform;
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  if (platform !== "win32") return { platform, home };
  return {
    platform,
    home,
    registrySteamPath: regValue("HKCU\\Software\\Valve\\Steam", "SteamPath"),
    registryInstallPath: regValue("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"),
  };
}
