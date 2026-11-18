/**
 * Fallback reader for `Taleweaver/<packGuid>/index.json` (talespire-assets.md §1). Game updates do not refresh this
 * file, so it is used only when the binary index is missing or fails its hard checks.
 */
import { strFromU8 } from "fflate";
import type { CatalogAsset, CatalogSource } from "../contracts/compiler";
import { isGuid } from "../slab/guid";
import { deriveCatalogAsset } from "./derive";

export class IndexJsonError extends Error {
  override name = "IndexJsonError";
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const num = (v: unknown): number => (typeof v === "number" ? v : Number.NaN);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const vec = (v: unknown): { x: number; y: number; z: number } => {
  const o = obj(v);
  return { x: num(o["x"]), y: num(o["y"]), z: num(o["z"]) };
};

export function readIndexJson(
  text: string,
  pack: { packId: string },
): { packName: string; assets: CatalogAsset[]; warnings: string[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new IndexJsonError(`index.json is not valid JSON: ${(e as Error).message}`);
  }
  const root = obj(doc);
  const packName = str(root["Name"]);
  const warnings: string[] = [];
  const assets: CatalogAsset[] = [];
  let seen = 0;
  for (const [key, kind] of [
    ["Tiles", "tile"],
    ["Props", "prop"],
  ] as const) {
    const list = root[key];
    if (!Array.isArray(list)) {
      warnings.push(`index.json has no ${key} array`);
      continue;
    }
    for (const item of list) {
      const t = obj(item);
      const id = str(t["Id"]).toLowerCase();
      if (!isGuid(id)) {
        warnings.push(`skipped ${key} entry with invalid Id "${str(t["Id"])}"`);
        continue;
      }
      const bb = obj(t["ColliderBoundsBound"]);
      const center = vec(bb["m_Center"]);
      const extent = vec(bb["m_Extent"]);
      if (![center.x, center.y, center.z, extent.x, extent.y, extent.z].every(Number.isFinite)) {
        warnings.push(`skipped ${id}: missing bounds`);
        continue;
      }
      const tags = Array.isArray(t["Tags"])
        ? (t["Tags"] as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      assets.push(
        deriveCatalogAsset(
          {
            id,
            name: str(t["Name"]),
            kind,
            folder: str(t["Folder"]),
            groupTag: str(t["GroupTag"]),
            tags,
            deprecated: t["IsDeprecated"] === true,
            interactable: t["IsInteractable"] === true,
            center,
            extent,
            meshParts: Array.isArray(t["Assets"]) ? (t["Assets"] as unknown[]).length : 0,
          },
          { packId: pack.packId, packName },
        ),
      );
      seen++;
    }
  }
  if (seen === 0) throw new IndexJsonError("index.json contains no tiles or props");
  return { packName, assets, warnings };
}

export const indexJsonSource: CatalogSource = {
  id: "index-json",
  canRead(fileName: string, head: Uint8Array): boolean {
    if (fileName !== "index.json") return false;
    let i = 0;
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
    while (i < head.length && (head[i] === 0x20 || head[i] === 0x0a || head[i] === 0x0d || head[i] === 0x09))
      i++;
    return head[i] === 0x7b; // "{"
  },
  read(bytes, pack) {
    return readIndexJson(strFromU8(bytes), pack);
  },
};
