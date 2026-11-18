/**
 * Derived catalog fields, identical to tools/research/Extract-AssetCatalog.ps1 so a runtime catalog matches the
 * research artefact record for record (talespire-assets.md §2, §8.6).
 */
import type { CatalogAsset } from "../contracts/compiler";

/** Raw record common to both sources (binary index, index.json). Bounds are the collider AABB centre/extent. */
export interface RawCatalogRecord {
  id: string;
  name: string;
  kind: "tile" | "prop";
  folder: string;
  groupTag: string;
  tags: string[];
  deprecated: boolean;
  interactable: boolean;
  center: { x: number; y: number; z: number };
  extent: { x: number; y: number; z: number };
  meshParts: number;
}

/** Math.Round(v, 4) with .NET's default midpoint-to-even rule. */
export function round4(v: number): number {
  const s = v * 10000;
  const f = Math.floor(s);
  const diff = s - f;
  let r: number;
  if (Math.abs(diff - 0.5) < 1e-9) r = f % 2 === 0 ? f : f + 1;
  else r = Math.round(s);
  const out = r / 10000;
  return Object.is(out, -0) ? 0 : out;
}

const SIZE_TAG = /^\d+x\d+(x\d+)?$/;

export function deriveCatalogAsset(
  r: RawCatalogRecord,
  pack: { packId: string; packName: string },
): CatalogAsset {
  const size = { x: 2 * r.extent.x, y: 2 * r.extent.y, z: 2 * r.extent.z };
  const min = { x: r.center.x - r.extent.x, y: r.center.y - r.extent.y, z: r.center.z - r.extent.z };
  const originAt: CatalogAsset["originAt"] =
    Math.abs(min.x) < 0.02 && Math.abs(min.z) < 0.02
      ? "minCorner"
      : Math.abs(r.center.x) < 0.1 && Math.abs(r.center.z) < 0.1
        ? "center"
        : "other";
  const sizeTag = r.tags.find((t) => SIZE_TAG.test(t));
  const asset: CatalogAsset = {
    uuid: r.id.toLowerCase(),
    name: r.name,
    kind: r.kind,
    pack: pack.packName,
    packId: pack.packId,
    folder: r.folder,
    groupTag: r.groupTag,
    tags: [...r.tags],
    deprecated: r.deprecated,
    interactable: r.interactable,
    size: { x: round4(size.x), y: round4(size.y), z: round4(size.z) },
    footprintCells: {
      x: Math.max(1, Math.ceil(size.x - 0.01)),
      z: Math.max(1, Math.ceil(size.z - 0.01)),
    },
    boundsCenter: { x: round4(r.center.x), y: round4(r.center.y), z: round4(r.center.z) },
    boundsMin: { x: round4(min.x), y: round4(min.y), z: round4(min.z) },
    originAt,
    meshParts: r.meshParts,
  };
  if (sizeTag !== undefined) asset.sizeTag = sizeTag;
  return asset;
}

/** Which unrotated axis a piece runs along (same rule as tools/research/Build-Palette.ps1). */
export function lengthAxisOf(size: { x: number; z: number }): "x" | "z" | "square" {
  if (size.x > size.z + 0.01) return "x";
  if (size.z > size.x + 0.01) return "z";
  return "square";
}

/** Palette geometry from a catalog record. */
export function geomOf(a: CatalogAsset): {
  size: { x: number; y: number; z: number };
  originAt: CatalogAsset["originAt"];
  boundsCenter: { x: number; y: number; z: number };
  lengthAxis: "x" | "z" | "square";
} {
  return {
    size: { ...a.size },
    originAt: a.originAt,
    boundsCenter: { ...a.boundsCenter },
    lengthAxis: lengthAxisOf(a.size),
  };
}
