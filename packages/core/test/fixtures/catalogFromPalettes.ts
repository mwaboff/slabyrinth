/**
 * A test catalog made from the bundled palettes themselves (every piece they name, as a catalog record), plus invented
 * "update" pieces: a sibling of each palette piece in the chosen roles, named after it with a new number and a
 * slightly different height. Nothing here is game data beyond what the committed palettes already hold; uuids of the
 * invented pieces are made up.
 */
import type { CatalogAsset, Palette, PaletteVariant } from "../../src/contracts/compiler";

export const FIXTURE_PACK = "Fixture Pack";

function record(uuid: string, name: string, geom: PaletteVariant["geom"]): CatalogAsset {
  const tile = geom.originAt === "minCorner";
  const { size } = geom;
  return {
    uuid: uuid.toLowerCase(),
    name,
    kind: tile ? "tile" : "prop",
    pack: FIXTURE_PACK,
    packId: "fixture-pack",
    folder: "Fixture",
    groupTag: "",
    tags: [],
    deprecated: false,
    interactable: false,
    size: { ...size },
    footprintCells: { x: Math.max(1, Math.ceil(size.x - 0.01)), z: Math.max(1, Math.ceil(size.z - 0.01)) },
    boundsCenter: { ...geom.boundsCenter },
    boundsMin: tile
      ? { x: 0, y: 0, z: 0 }
      : {
          x: geom.boundsCenter.x - size.x / 2,
          y: geom.boundsCenter.y - size.y / 2,
          z: geom.boundsCenter.z - size.z / 2,
        },
    originAt: geom.originAt,
  };
}

/** Every piece the palettes name (preferred, alternates with their geometry, parts), once each. */
export function catalogOfPalettes(palettes: Readonly<Record<string, Palette>>): CatalogAsset[] {
  const out = new Map<string, CatalogAsset>();
  const add = (uuid: string, name: string, geom: PaletteVariant["geom"]): void => {
    if (!out.has(uuid.toLowerCase())) out.set(uuid.toLowerCase(), record(uuid, name, geom));
  };
  for (const p of Object.values(palettes))
    for (const def of Object.values(p.roles))
      for (const v of def.variants) {
        add(v.asset, v.name ?? v.asset, v.geom);
        for (const alt of v.alternates ?? []) add(alt, v.name ?? alt, v.alternateGeom?.[alt] ?? v.geom);
        for (const part of v.parts ?? []) add(part.asset, part.name ?? part.asset, part.geom);
      }
  return [...out.values()];
}

/**
 * One invented sibling ("<name> 97", 4 % taller) of every palette piece in a role `wants` accepts, with a made-up uuid
 * (counting from `first`).
 */
export function inventedSiblings(
  palettes: Readonly<Record<string, Palette>>,
  wants: (role: string) => boolean,
  first = 1,
): CatalogAsset[] {
  const out = new Map<string, CatalogAsset>();
  let n = first;
  for (const id of Object.keys(palettes).sort()) {
    const p = palettes[id];
    if (!p) continue;
    for (const role of Object.keys(p.roles).sort()) {
      if (!wants(role)) continue;
      for (const v of p.roles[role]?.variants ?? []) {
        if (out.has(v.asset.toLowerCase()) || (v.parts?.length ?? 0) > 0 || v.name === undefined) continue;
        const uuid = `ad000000-0000-4000-8000-${String(n++).padStart(12, "0")}`;
        const geom = { ...v.geom, size: { ...v.geom.size, y: v.geom.size.y * 1.04 } };
        out.set(v.asset.toLowerCase(), record(uuid, `${v.name} 97`, geom));
      }
    }
  }
  return [...out.values()];
}
