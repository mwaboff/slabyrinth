/** AssetAvailability over a scanned catalog, and the null object used when no install was found. */
import type { AssetAvailability, AssetCatalog, CatalogAsset } from "../contracts/compiler";
import { geomOf } from "./derive";

/** No catalog loaded: everything counts as present; no names; no search. */
export const NULL_AVAILABILITY: AssetAvailability = {
  status: () => null,
  name: () => null,
  search: () => [],
};

export function isNullAvailability(a: AssetAvailability): boolean {
  return a === NULL_AVAILABILITY || a.status("00000000-0000-0000-0000-000000000000") === null;
}

const STOP = new Set(["a", "an", "the", "of", "with", "and", "on", "in"]);
const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));

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
      const q = tokens(hint);
      if (q.length === 0) return [];
      const scored: Array<{ a: CatalogAsset; s: number }> = [];
      for (const a of list) {
        if (a.deprecated || (kind && a.kind !== kind)) continue;
        const name = tokens(a.name);
        const tags = a.tags.flatMap(tokens);
        const folder = tokens(a.folder);
        let s = 0;
        for (const t of q) {
          if (name.includes(t)) s += 3;
          else if (name.some((n) => n.startsWith(t) || t.startsWith(n))) s += 2;
          if (tags.includes(t)) s += 1;
          if (folder.includes(t)) s += 1;
        }
        if (s > 0) scored.push({ a, s });
      }
      scored.sort((x, y) => y.s - x.s || (x.a.name < y.a.name ? -1 : x.a.name > y.a.name ? 1 : 0));
      return scored.slice(0, 20).map(({ a }) => ({ uuid: a.uuid, name: a.name, geom: geomOf(a) }));
    },
  };
}
