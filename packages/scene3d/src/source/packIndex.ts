/**
 * Where every asset's meshes are, from the install's own pack indexes (design D6: no hand-kept list): for each pack
 * folder, the binary `index` (its loader table names each part's bundle and prefab: core readBinaryIndexParts), and
 * `index.json` only when the binary index cannot be read (the game stopped updating index.json, so new assets are
 * missing from it). Also each asset's collider, which places its mesh as the game does.
 */
import {
  IndexFormatError,
  binaryIndexToCatalog,
  geomOf,
  joinPath,
  listPackDirs,
  parseJsonText,
  readBinaryIndex,
  readBinaryIndexParts,
  type IndexPart,
  type ReadonlyFs,
} from "@slabyrinth/core";
import type { PieceGeom } from "../types/index";

export interface PackAsset {
  packId: string;
  /** The pack folder (holds `Assets/<bundleId>`). */
  packPath: string;
  parts: IndexPart[];
  geom: PieceGeom;
}

export interface PackIndex {
  assets: Map<string, PackAsset>;
  /** Per pack: which index answered, and anything that went wrong reading it. */
  packs: Array<{ packId: string; source: "binary-index" | "index-json" | "none"; warning?: string }>;
}

type Json = unknown;
const rec = (v: Json): Record<string, Json> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, Json>) : null;
const n = (v: Json): number => (typeof v === "number" ? v : 0);
const vec = (v: Json): { x: number; y: number; z: number } => {
  const o = rec(v);
  return { x: n(o?.["x"]), y: n(o?.["y"]), z: n(o?.["z"]) };
};

/** The parts and colliders of index.json's tiles and props (the fallback reader). */
export function indexJsonAssets(text: string): Map<string, { parts: IndexPart[]; geom: PieceGeom }> {
  const out = new Map<string, { parts: IndexPart[]; geom: PieceGeom }>();
  // the game writes index.json with a byte-order mark
  const doc = rec(parseJsonText(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  if (!doc) throw new Error("index.json is not an object");
  for (const [list, kind] of [
    ["Tiles", "tile"],
    ["Props", "prop"],
  ] as const) {
    const items = doc[list];
    if (!Array.isArray(items)) continue;
    for (const item of items as Json[]) {
      const a = rec(item);
      const id = a?.["Id"];
      if (!a || typeof id !== "string") continue;
      const bounds = rec(a["ColliderBoundsBound"]);
      const center = vec(bounds?.["m_Center"]);
      const extent = vec(bounds?.["m_Extent"]);
      const parts: IndexPart[] = [];
      for (const p of Array.isArray(a["Assets"]) ? (a["Assets"] as Json[]) : []) {
        const po = rec(p);
        const ld = rec(po?.["LoaderData"]);
        const bundleId = ld?.["BundleId"];
        const assetName = ld?.["AssetName"];
        if (!po || typeof bundleId !== "string" || typeof assetName !== "string") continue;
        const r = rec(po["Rotation"]);
        parts.push({
          bundleId,
          assetName,
          position: vec(po["Position"]),
          rotation: { x: n(r?.["x"]), y: n(r?.["y"]), z: n(r?.["z"]), w: n(r?.["w"]) },
          scale: vec(po["Scale"]),
        });
      }
      out.set(id.toLowerCase(), {
        parts,
        geom: {
          size: { x: 2 * extent.x, y: 2 * extent.y, z: 2 * extent.z },
          originAt: kind === "tile" ? "minCorner" : "center",
          boundsCenter: center,
        },
      });
    }
  }
  return out;
}

/** Reads every pack's index under the install (read-only). */
export async function readPackIndex(fs: ReadonlyFs, installPath: string): Promise<PackIndex> {
  const assets = new Map<string, PackAsset>();
  const packs: PackIndex["packs"] = [];
  for (const pack of await listPackDirs(fs, installPath)) {
    let warning: string | undefined;
    if (pack.binaryIndex) {
      try {
        const bytes = await fs.readFile(joinPath(pack.path, "index"));
        const { parts } = readBinaryIndexParts(bytes);
        const catalog = binaryIndexToCatalog(readBinaryIndex(bytes), { packId: pack.packId });
        for (const a of catalog) {
          const g = geomOf(a);
          assets.set(a.uuid, {
            packId: pack.packId,
            packPath: pack.path,
            parts: parts.get(a.uuid) ?? [],
            geom: { size: g.size, originAt: g.originAt, boundsCenter: g.boundsCenter },
          });
        }
        packs.push({ packId: pack.packId, source: "binary-index" });
        continue;
      } catch (e) {
        if (!(e instanceof IndexFormatError)) throw e;
        warning = `binary index unreadable (${e.message})`;
      }
    }
    if (pack.indexJson) {
      for (const [uuid, a] of indexJsonAssets(await fs.readText(joinPath(pack.path, "index.json"))))
        assets.set(uuid, { packId: pack.packId, packPath: pack.path, ...a });
      packs.push({ packId: pack.packId, source: "index-json", ...(warning ? { warning } : {}) });
    } else packs.push({ packId: pack.packId, source: "none", ...(warning ? { warning } : {}) });
  }
  return { assets, packs };
}
