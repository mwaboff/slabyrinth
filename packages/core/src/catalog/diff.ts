/** Catalog diff (added / removed / newly deprecated / geometry changed) and the palette roles it affects. */
import type {
  AssetCatalog,
  CatalogAsset,
  CatalogChangeReport,
  CatalogSourceId,
  Palette,
} from "../contracts/compiler";

const EPS = 1e-4;
const vecDiff = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean =>
  Math.abs(a.x - b.x) > EPS || Math.abs(a.y - b.y) > EPS || Math.abs(a.z - b.z) > EPS;

export function geometryChanged(a: CatalogAsset, b: CatalogAsset): boolean {
  return (
    vecDiff(a.size, b.size) ||
    vecDiff(a.boundsCenter, b.boundsCenter) ||
    a.kind !== b.kind ||
    a.originAt !== b.originAt
  );
}

export function diffCatalogs(
  prev: AssetCatalog | null | undefined,
  next: AssetCatalog,
  palettes?: Record<string, Palette>,
): CatalogChangeReport {
  const before = new Map((prev?.assets ?? []).map((a) => [a.uuid, a]));
  const after = new Map(next.assets.map((a) => [a.uuid, a]));
  let added = 0;
  const removed: CatalogChangeReport["removed"] = [];
  const newlyDeprecated: CatalogChangeReport["newlyDeprecated"] = [];
  const geom: CatalogChangeReport["geometryChanged"] = [];
  for (const [uuid, a] of after) {
    const b = before.get(uuid);
    if (!b) {
      if (prev) added++;
      continue;
    }
    if (a.deprecated && !b.deprecated) newlyDeprecated.push({ uuid, name: a.name });
    if (geometryChanged(a, b)) geom.push({ uuid, name: a.name });
  }
  for (const [uuid, b] of before) if (!after.has(uuid)) removed.push({ uuid, name: b.name });

  const sourceUsed: Record<string, CatalogSourceId> = {};
  for (const p of next.packs) sourceUsed[p.packId] = p.source;

  const affected: CatalogChangeReport["affectedPaletteRoles"] = [];
  if (palettes) {
    const usable = (u: string): boolean => {
      const a = after.get(u);
      return a !== undefined && !a.deprecated;
    };
    for (const p of Object.values(palettes)) {
      for (const [role, def] of Object.entries(p.roles)) {
        for (const v of def.variants) {
          const u = v.asset.toLowerCase();
          if (usable(u)) continue;
          const wasUsable = before.size === 0 || (before.has(u) && before.get(u)?.deprecated !== true);
          if (!wasUsable && prev) continue; // already unusable before this refresh
          const alt = (v.alternates ?? []).some(
            (x) => usable(x.toLowerCase()) && v.alternateGeom?.[x] !== undefined,
          );
          affected.push({
            paletteId: p.id,
            role,
            uuid: u,
            resolution: alt ? "alternate" : def.fallback ? "fallback_role" : "dropped",
          });
        }
      }
    }
  }
  return {
    previousGeneratedAt: prev?.generatedAt ?? null,
    sourceUsed,
    added,
    removed,
    newlyDeprecated,
    geometryChanged: geom,
    affectedPaletteRoles: affected,
  };
}
