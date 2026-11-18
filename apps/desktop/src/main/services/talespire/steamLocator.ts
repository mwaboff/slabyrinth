import * as fsp from "node:fs/promises";
import { locateTaleSpire, TALESPIRE_APP_ID, type ReadonlyFs } from "@slabyrinth/core";

/**
 * Locates the TaleSpire install through core's discovery (`locateTaleSpire`, VDF/ACF parsing in
 * core/catalog). This file only supplies what core leaves to the host: a read-only file system and,
 * on Windows, the Steam paths from the registry (reg.exe query; core has no OS access). Read-only.
 */
export { TALESPIRE_APP_ID };

export interface LocatorEnv {
  platform: NodeJS.Platform;
  homedir: string;
  /** Runs a program without a shell; used for `reg.exe query` only. */
  execFile(file: string, args: string[]): Promise<{ stdout: string }>;
  fs: ReadonlyFs;
}

export const nodeReadonlyFs: ReadonlyFs = {
  stat: async (p) => {
    try {
      const st = await fsp.stat(p);
      return { size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() };
    } catch {
      return null;
    }
  },
  readFile: async (p) => new Uint8Array(await fsp.readFile(p)),
  readText: (p) => fsp.readFile(p, "utf8"),
  listDir: async (p) => {
    try {
      return await fsp.readdir(p);
    } catch {
      return [];
    }
  },
};

async function regQuery(env: LocatorEnv, key: string, value: string): Promise<string | null> {
  try {
    const { stdout } = await env.execFile("reg.exe", ["query", key, "/v", value]);
    const m = new RegExp(`${value}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`, "i").exec(stdout);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Install folders found through Steam (core's search returns the first match; [] when none). */
export async function locateTaleSpireViaSteam(env: LocatorEnv): Promise<string[]> {
  const win = env.platform === "win32";
  const result = await locateTaleSpire(env.fs, {
    platform: env.platform,
    home: env.homedir,
    registrySteamPath: win ? await regQuery(env, "HKCU\\Software\\Valve\\Steam", "SteamPath") : null,
    registryInstallPath: win
      ? await regQuery(env, "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath")
      : null,
  });
  return result.install ? [result.install.installPath] : [];
}

/**
 * Validates a folder the user picked (or the saved override): core's manual-path rule — the install
 * folder (or its Taleweaver folder) must contain Taleweaver. Only the manual path is probed.
 */
export async function validateInstall(
  env: Pick<LocatorEnv, "fs">,
  dir: string,
): Promise<{ valid: boolean; path: string; code?: "not_found" | "not_talespire"; reason?: string }> {
  const trimmed = dir.replace(/[\\/]+$/, "") || dir;
  const st = await env.fs.stat(trimmed);
  if (!st?.isDirectory)
    return { valid: false, path: trimmed, code: "not_found", reason: "That folder doesn't exist." };
  // A platform with no Steam probing: core only checks the manual path.
  const r = await locateTaleSpire(env.fs, { platform: "manual-only", manualPath: trimmed });
  if (r.install?.how === "manual") return { valid: true, path: r.install.installPath };
  return {
    valid: false,
    path: trimmed,
    code: "not_talespire",
    reason:
      "That folder doesn't look like a TaleSpire install — pick the folder that contains TaleSpire.exe and Taleweaver.",
  };
}
