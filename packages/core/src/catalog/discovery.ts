/**
 * TaleSpire install discovery (talespire-assets.md §3, architecture §6.6) for Windows and Linux/Proton.
 * Pure logic over an injected read-only file-system port: core has no node:* imports outside src/cli, and the
 * desktop main process supplies the real `fs` (and the registry value on Windows).
 */
import { parseAppManifest, parseLibraryFolders } from "./vdf";

export const TALESPIRE_APP_ID = "720620";
/** How the app starts TaleSpire: through Steam, never the exe directly (main opens it; the build view links it). */
export const STEAM_LAUNCH_URL = `steam://rungameid/${TALESPIRE_APP_ID}`;

/** Read-only file-system port injected by the caller (Electron main, CLI, tests). */
export interface ReadonlyFs {
  /** null when the path does not exist. */
  stat(path: string): Promise<{ size: number; mtimeMs: number; isDirectory: boolean } | null>;
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  /** Entry names in a directory ([] when missing). */
  listDir(path: string): Promise<string[]>;
}

/** `process.platform` value ("win32", "linux", "darwin", …). */
export type HostPlatform = string;

/** Joins path segments using the separator style of the base path (backslash for Windows-looking bases). */
export function joinPath(base: string, ...parts: string[]): string {
  const win = /^[a-zA-Z]:[\\/]|^\\\\/.test(base) || (base.includes("\\") && !base.includes("/"));
  const sep = win ? "\\" : "/";
  let out = base.replace(/[\\/]+$/, "");
  for (const p of parts) {
    const clean = p.replace(/^[\\/]+|[\\/]+$/g, "");
    if (clean) out += sep + (win ? clean.replace(/\//g, "\\") : clean.replace(/\\/g, "/"));
  }
  return out;
}

export interface SteamRootHints {
  platform: HostPlatform;
  /** User home directory (Linux probes). */
  home?: string;
  /** HKCU\Software\Valve\Steam\SteamPath (Windows; read by the caller with reg.exe). */
  registrySteamPath?: string | null;
  /** HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath (Windows). */
  registryInstallPath?: string | null;
}

/** Candidate Steam roots in probe order (deduplicated). */
export function steamRootCandidates(h: SteamRootHints): string[] {
  const c: string[] = [];
  if (h.platform === "win32") {
    if (h.registrySteamPath) c.push(h.registrySteamPath.replace(/\//g, "\\"));
    if (h.registryInstallPath) c.push(h.registryInstallPath);
    c.push("C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam");
  } else if (h.home) {
    const home = h.home.replace(/\/+$/, "");
    c.push(
      `${home}/.steam/steam`,
      `${home}/.steam/root`,
      `${home}/.local/share/Steam`,
      `${home}/.var/app/com.valvesoftware.Steam/.local/share/Steam`,
      `${home}/snap/steam/common/.local/share/Steam`,
    );
  }
  const seen = new Set<string>();
  return c.filter((p) => {
    const k = h.platform === "win32" ? p.toLowerCase() : p;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface TaleSpireInstall {
  installPath: string;
  taleweaverPath: string;
  libraryPath: string | null;
  steamRoot: string | null;
  buildId: string | null;
  /** Proton user-data folder on Linux (null on Windows or when unknown). */
  protonUserData: string | null;
  how: "manual" | "steam-library" | "default-path";
}

export interface LocateResult {
  install: TaleSpireInstall | null;
  /** Paths probed, for the "not found" diagnostics in Settings ▸ TaleSpire. */
  tried: string[];
}

const looksLikeInstall = async (fs: ReadonlyFs, path: string): Promise<boolean> => {
  const st = await fs.stat(joinPath(path, "Taleweaver"));
  return st?.isDirectory === true;
};

export function protonUserDataPath(libraryPath: string): string {
  return joinPath(
    libraryPath,
    "steamapps/compatdata",
    TALESPIRE_APP_ID,
    "pfx/drive_c/users/steamuser/AppData/LocalLow/BouncyRock Entertainment/TaleSpire",
  );
}

/**
 * Finds the TaleSpire install: manual path first, then every Steam root's libraries (the one listing app 720620
 * first, then any with appmanifest_720620.acf), reading `installdir` from the app manifest.
 */
export async function locateTaleSpire(
  fs: ReadonlyFs,
  hints: SteamRootHints & { manualPath?: string | null },
): Promise<LocateResult> {
  const tried: string[] = [];
  const linux = hints.platform !== "win32";
  if (hints.manualPath) {
    // Accept the install folder itself, or its Taleweaver folder.
    const p = hints.manualPath.replace(/[\\/]+$/, "");
    const base = /[\\/]Taleweaver$/i.test(p) ? p.replace(/[\\/]Taleweaver$/i, "") : p;
    tried.push(base);
    if (await looksLikeInstall(fs, base)) {
      return {
        install: {
          installPath: base,
          taleweaverPath: joinPath(base, "Taleweaver"),
          libraryPath: null,
          steamRoot: null,
          buildId: null,
          protonUserData: null,
          how: "manual",
        },
        tried,
      };
    }
  }
  for (const root of steamRootCandidates(hints)) {
    const vdfPath = joinPath(root, "steamapps", "libraryfolders.vdf");
    tried.push(vdfPath);
    const st = await fs.stat(vdfPath);
    let libs: Array<{ path: string; apps: string[] }> = [{ path: root, apps: [] }];
    if (st && !st.isDirectory) {
      try {
        const parsed = parseLibraryFolders(await fs.readText(vdfPath));
        if (parsed.length) libs = parsed;
        if (!libs.some((l) => samePath(l.path, root, hints.platform))) libs.push({ path: root, apps: [] });
      } catch {
        // unreadable vdf: probe the root itself
      }
    }
    libs.sort(
      (a, b) => Number(b.apps.includes(TALESPIRE_APP_ID)) - Number(a.apps.includes(TALESPIRE_APP_ID)),
    );
    for (const lib of libs) {
      const manifestPath = joinPath(lib.path, "steamapps", `appmanifest_${TALESPIRE_APP_ID}.acf`);
      tried.push(manifestPath);
      let installdir = "TaleSpire";
      let buildId: string | null = null;
      const ms = await fs.stat(manifestPath);
      if (ms && !ms.isDirectory) {
        try {
          const m = parseAppManifest(await fs.readText(manifestPath));
          if (m?.installdir) installdir = m.installdir;
          if (m?.buildid) buildId = m.buildid;
        } catch {
          // keep defaults
        }
      } else if (!lib.apps.includes(TALESPIRE_APP_ID)) {
        continue;
      }
      const installPath = joinPath(lib.path, "steamapps", "common", installdir);
      tried.push(installPath);
      if (await looksLikeInstall(fs, installPath)) {
        return {
          install: {
            installPath,
            taleweaverPath: joinPath(installPath, "Taleweaver"),
            libraryPath: lib.path,
            steamRoot: root,
            buildId,
            protonUserData: linux ? protonUserDataPath(lib.path) : null,
            how: "steam-library",
          },
          tried,
        };
      }
    }
  }
  if (hints.platform === "win32") {
    const def = "C:\\Program Files (x86)\\Steam\\steamapps\\common\\TaleSpire";
    if (!tried.includes(def)) {
      tried.push(def);
      if (await looksLikeInstall(fs, def)) {
        return {
          install: {
            installPath: def,
            taleweaverPath: joinPath(def, "Taleweaver"),
            libraryPath: null,
            steamRoot: null,
            buildId: null,
            protonUserData: null,
            how: "default-path",
          },
          tried,
        };
      }
    }
  }
  return { install: null, tried };
}

function samePath(a: string, b: string, platform: HostPlatform): boolean {
  const n = (p: string): string => {
    const s = p.replace(/[\\/]+/g, "/").replace(/\/$/, "");
    return platform === "win32" ? s.toLowerCase() : s;
  };
  return n(a) === n(b);
}

const GUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PackDir {
  packId: string;
  dirName: string;
  path: string;
  /** Relative paths (from the install) of the index files that exist. */
  binaryIndex: string | null;
  indexJson: string | null;
}

/** GUID-named pack folders under Taleweaver that contain `index` and/or `index.json` (pack ids are not hard-coded). */
export async function listPackDirs(fs: ReadonlyFs, installPath: string): Promise<PackDir[]> {
  const tw = joinPath(installPath, "Taleweaver");
  const out: PackDir[] = [];
  for (const name of (await fs.listDir(tw)).sort()) {
    if (!GUID_DIR.test(name)) continue;
    const path = joinPath(tw, name);
    const bin = await fs.stat(joinPath(path, "index"));
    const json = await fs.stat(joinPath(path, "index.json"));
    const hasBin = bin !== null && !bin.isDirectory;
    const hasJson = json !== null && !json.isDirectory;
    if (!hasBin && !hasJson) continue;
    out.push({
      packId: name.toLowerCase(),
      dirName: name,
      path,
      binaryIndex: hasBin ? `Taleweaver/${name}/index` : null,
      indexJson: hasJson ? `Taleweaver/${name}/index.json` : null,
    });
  }
  return out;
}
