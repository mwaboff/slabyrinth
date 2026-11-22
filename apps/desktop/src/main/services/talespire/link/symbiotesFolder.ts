/**
 * Where TaleSpire looks for add-ons (symbiotes) on this computer. Read-only: it only stats and reads Steam's
 * library list.
 *
 * - Windows: `%USERPROFILE%\AppData\LocalLow\BouncyRock Entertainment\TaleSpire\Symbiotes` (the official docs give it
 *   as `%AppData%\..\LocalLow\BouncyRock Entertainment\TaleSpire\Symbiotes\`).
 * - Linux: TaleSpire runs through Steam Proton, so the folder is inside the game's Proton prefix, which Steam keeps in
 *   the library that holds the game: `<library>/steamapps/compatdata/720620/pfx/drive_c/users/steamuser/AppData/
 *   LocalLow/BouncyRock Entertainment/TaleSpire/Symbiotes` (core `protonUserDataPath`). Every Steam root core knows is
 *   tried, plus the Flatpak data folder, and every library in each root's libraryfolders.vdf (the one listing
 *   TaleSpire first).
 *
 * A candidate counts as found when its `TaleSpire` folder exists (the game has run there); the `Symbiotes` folder
 * itself is created on install when it is missing.
 */
import {
  TALESPIRE_APP_ID,
  joinPath,
  parseLibraryFolders,
  protonUserDataPath,
  steamRootCandidates,
  type ReadonlyFs,
} from "@slabyrinth/core";

export type FolderSource = "manual" | "default" | "proton";

export interface FolderCandidate {
  path: string;
  source: FolderSource;
}

export interface FolderEnv {
  platform: NodeJS.Platform;
  homedir: string;
  fs: ReadonlyFs;
}

const LOCAL_LOW_TALESPIRE = ["AppData", "LocalLow", "BouncyRock Entertainment", "TaleSpire"];

/** The Windows folder. */
export function windowsSymbiotesFolder(homedir: string): string {
  return joinPath(homedir, ...LOCAL_LOW_TALESPIRE, "Symbiotes");
}

/** Steam roots to read on Linux: core's list plus the Flatpak data folder some installs use. */
export function linuxSteamRoots(homedir: string): string[] {
  const roots = steamRootCandidates({ platform: "linux", home: homedir });
  const flatpakData = `${homedir.replace(/\/+$/, "")}/.var/app/com.valvesoftware.Steam/data/Steam`;
  return roots.includes(flatpakData) ? roots : [...roots, flatpakData];
}

/** Every Symbiotes folder worth looking at, best first (no manual choice; the caller puts that first). */
export async function symbiotesCandidates(env: FolderEnv): Promise<FolderCandidate[]> {
  if (env.platform === "win32") return [{ path: windowsSymbiotesFolder(env.homedir), source: "default" }];
  if (env.platform !== "linux") return [];
  const out: FolderCandidate[] = [];
  const seen = new Set<string>();
  const add = (library: string): void => {
    const p = joinPath(protonUserDataPath(library), "Symbiotes");
    if (seen.has(p)) return;
    seen.add(p);
    out.push({ path: p, source: "proton" });
  };
  for (const root of linuxSteamRoots(env.homedir)) {
    const vdf = joinPath(root, "steamapps", "libraryfolders.vdf");
    const st = await env.fs.stat(vdf);
    let libs: Array<{ path: string; apps: string[] }> = [];
    if (st && !st.isDirectory) {
      try {
        libs = parseLibraryFolders(await env.fs.readText(vdf));
      } catch {
        libs = [];
      }
    }
    libs.sort(
      (a, b) => Number(b.apps.includes(TALESPIRE_APP_ID)) - Number(a.apps.includes(TALESPIRE_APP_ID)),
    );
    for (const lib of libs) add(lib.path);
    add(root);
  }
  return out;
}

/** The parent `TaleSpire` folder of a Symbiotes folder. */
function talespireFolder(symbiotes: string): string {
  return symbiotes.replace(/[\\/]+Symbiotes[\\/]*$/i, "");
}

/** Whether a candidate is real: the Symbiotes folder exists, or its TaleSpire folder does (the game has run). */
export async function candidateExists(fs: ReadonlyFs, c: FolderCandidate): Promise<boolean> {
  const st = await fs.stat(c.path);
  if (st) return st.isDirectory;
  if (c.source === "manual") return false;
  return (await fs.stat(talespireFolder(c.path)))?.isDirectory === true;
}

/** The first real folder (a manual choice first), and every path looked at. */
export async function findSymbiotesFolder(
  env: FolderEnv,
  manual: string | null,
): Promise<{ found: FolderCandidate | null; tried: string[] }> {
  const list: FolderCandidate[] = manual
    ? [{ path: manual, source: "manual" }]
    : await symbiotesCandidates(env);
  const tried: string[] = [];
  for (const c of list) {
    tried.push(c.path);
    if (await candidateExists(env.fs, c)) return { found: c, tried };
  }
  return { found: null, tried };
}
