/**
 * Where the pictures' meshes come from: the TaleSpire install (read-only, at run time) through scene3d's install
 * source with a disk cache under the repository's git-ignored `.cache/meshes/`, or boxes when asked or when no
 * install is found. Nothing read from the game is ever written anywhere else.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildCatalogFromInstall,
  loadPalettes,
  locateTaleSpire,
  parseAssetCatalog,
  parseJsonText,
  type AssetCatalog,
} from "@slabyrinth/core";
import { hostSteamHints, nodeReadonlyFs } from "@slabyrinth/core/cli";
import {
  boxMeshSource,
  installMeshSource,
  type InstallMeshSource,
  type MeshCache,
  type MeshSource,
} from "@slabyrinth/scene3d";
import { REPO_ROOT } from "./inputs";

export const MESH_CACHE_DIR = join(REPO_ROOT, ".cache", "meshes");

/** The mesh cache as files under `dir` (written atomically enough for one writer: whole files). */
export function diskMeshCache(dir: string): MeshCache {
  return {
    read(path) {
      try {
        return Promise.resolve(new Uint8Array(readFileSync(join(dir, path))));
      } catch {
        return Promise.resolve(null);
      }
    },
    write(path, bytes) {
      const f = join(dir, path);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, bytes);
      return Promise.resolve();
    },
  };
}

export interface Meshes {
  source: MeshSource;
  install: InstallMeshSource | null;
  installPath: string | null;
  /** The install's catalog (names, sizes, catalog facts for colours), when an install was found. */
  catalog: AssetCatalog | null;
  /** Plain words for the run's report. */
  note: string;
}

/** The app's cached catalog (read-only; the only file of the app's user data the tool opens). */
function appCatalog(appData: string | null): AssetCatalog | null {
  if (!appData) return null;
  try {
    const raw: unknown = parseJsonText(
      readFileSync(join(appData, "Slabyrinth", "catalog", "catalog.json"), "utf8"),
    );
    const doc = typeof raw === "object" && raw !== null && "catalog" in raw ? raw.catalog : raw;
    const r = parseAssetCatalog(doc);
    return r.ok ? r.catalog : null;
  } catch {
    return null;
  }
}

/** The TaleSpire install on this machine, found as the catalog finds it (Steam's library folders). */
export async function locateInstall(): Promise<string | null> {
  const loc = await locateTaleSpire(nodeReadonlyFs, hostSteamHints());
  return loc.install?.installPath ?? null;
}

export async function openMeshes(o: {
  boxes: boolean;
  installFlag: string | undefined;
  /** The OS application-data folder (the app's catalog is read from it), or null to read nothing there. */
  appData: string | null;
  /** Finds the install when no --install is given (default: as the catalog finds it; tests pass one that finds none). */
  locate?: () => Promise<string | null>;
  /** false: answer from the mesh cache only, never reading a bundle (a --jobs worker, whose parent warmed the cache). */
  coldRead?: boolean;
  log: (s: string) => void;
}): Promise<Meshes> {
  if (o.boxes)
    return {
      source: boxMeshSource("boxes-requested", "boxes only (--boxes)"),
      install: null,
      installPath: null,
      catalog: appCatalog(o.appData),
      note: "Every piece is drawn as a box of its real size (--boxes).",
    };
  let installPath = o.installFlag ?? null;
  if (!installPath) installPath = await (o.locate ?? locateInstall)();
  else if (!(await nodeReadonlyFs.stat(join(installPath, "Taleweaver")))?.isDirectory) installPath = null;
  if (!installPath)
    return {
      source: boxMeshSource("no-install", "boxes only: TaleSpire was not found"),
      install: null,
      installPath: null,
      catalog: appCatalog(o.appData),
      note: `TaleSpire isn't installed on this PC (or was not found${o.installFlag ? ` at ${o.installFlag}` : ""}), so every piece is drawn as a box of its real size. Use --install <folder> to point at it.`,
    };
  let done = 0;
  const install = installMeshSource({
    fs: nodeReadonlyFs,
    installPath,
    cache: diskMeshCache(MESH_CACHE_DIR),
    ...(o.coldRead === false ? { coldRead: false } : {}),
    onProgress: (n, total, bundle) => {
      if (done === 0) o.log(`reading TaleSpire's pieces (once per game update; seconds per bundle)…`);
      done = n;
      o.log(`  bundle ${n}/${total} ${bundle}`);
    },
  });
  const built = await buildCatalogFromInstall(nodeReadonlyFs, installPath, {
    palettes: loadPalettes().palettes,
  });
  return {
    source: install,
    install,
    installPath,
    catalog: built.catalog,
    note: `Game meshes from TaleSpire at ${installPath}; pieces it cannot read are boxes (listed in fallbacks).`,
  };
}
