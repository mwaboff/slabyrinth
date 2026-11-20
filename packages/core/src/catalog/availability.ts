/** AssetAvailability over a scanned catalog, and the null object used when no install was found. */
import type { AssetAvailability, AssetCatalog, CatalogAsset } from "../contracts/compiler";
import { geomOf } from "./derive";
import { searchCatalog } from "./classify";

/** No catalog loaded: everything counts as present; no names; no search. */
export const NULL_AVAILABILITY: AssetAvailability = {
  status: () => null,
  name: () => null,
  search: () => [],
};

export function isNullAvailability(a: AssetAvailability): boolean {
  return a === NULL_AVAILABILITY || a.status("00000000-0000-0000-0000-000000000000") === null;
}

export function createAvailability(catalog: AssetCatalog | readonly CatalogAsset[]): AssetAvailability {
  const list = Array.isArray(catalog)
    ? (catalog as readonly CatalogAsset[])
    : (catalog as AssetCatalog).assets;
  const byId = new Map<string, CatalogAsset>();
  for (const a of list) byId.set(a.uuid.toLowerCase(), a);
  return {
    status(uuid) {
      const a = byId.get(uuid.toLowerCase());
      if (!a) return "missing";
      return a.deprecated ? "deprecated" : "present";
    },
    name(uuid) {
      return byId.get(uuid.toLowerCase())?.name ?? null;
    },
    search(hint, kind) {
      // Trustworthy search (catalog/classify.ts): a hit must match a hint word in its name, props rank above
      // tiles, and weak matches are dropped so a custom feature is reported unresolved instead of silently
      // becoming an unrelated asset ("great root" once matched a wall/floor tile).
      // custom features are props unless the caller asks for tiles
      const opts = { keywords: hint, kind: kind ?? ("prop" as const), limit: 20, strict: true };
      return searchCatalog(list, opts).map((h) => {
        const a = byId.get(h.uuid.toLowerCase()) as CatalogAsset;
        return { uuid: a.uuid, name: a.name, geom: geomOf(a) };
      });
    },
  };
}
