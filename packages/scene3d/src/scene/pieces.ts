/**
 * What the scene knows about an asset id without its mesh: its name, its collider geometry (to place it and to size
 * its box) and the facts the classifier reads (scene/classify.ts): the roles the palettes list it under and the
 * catalog's own classification of it, its kind, form and height. The scanned catalog answers first (it is the game's
 * own word); the palettes answer for any piece they place (bundled palettes carry geometry), so a run without an
 * install still sizes and classes every piece the generator can place.
 */
import {
  classifyAsset,
  geomOf,
  type AssetCatalog,
  type Palette,
  type PaletteVariant,
} from "@slabyrinth/core";
import type { PieceGeom } from "../types/index";
import type { PieceFacts } from "./classify";

export interface PieceInfo {
  name: string;
  geom: PieceGeom | null;
  facts: PieceFacts | null;
}

export interface PieceLookup {
  info(uuid: string): PieceInfo;
}

const key = (uuid: string): string => uuid.toLowerCase();

/** The piece lookup of a catalog (optional) and the palettes. */
export function pieceLookup(
  palettes: Readonly<Record<string, Palette>>,
  catalog: AssetCatalog | null,
): PieceLookup {
  const fromPalette = new Map<string, { name: string; geom: PieceGeom }>();
  const roles = new Map<string, Set<string>>();
  const add = (
    role: string,
    uuid: string,
    name: string | undefined,
    geom: PaletteVariant["geom"] | undefined,
  ): void => {
    let r = roles.get(key(uuid));
    if (!r) roles.set(key(uuid), (r = new Set()));
    r.add(role);
    if (!geom || fromPalette.has(key(uuid))) return;
    fromPalette.set(key(uuid), { name: name ?? uuid, geom });
  };
  for (const id of Object.keys(palettes).sort()) {
    const p = palettes[id];
    if (!p) continue;
    for (const role of Object.keys(p.roles).sort())
      for (const v of p.roles[role]?.variants ?? []) {
        add(role, v.asset, v.name, v.geom);
        for (const alt of v.alternates ?? []) add(role, alt, undefined, v.alternateGeom?.[alt]);
        for (const part of v.parts ?? []) add(role, part.asset, part.name, part.geom);
      }
  }
  const fromCatalog = new Map((catalog?.assets ?? []).map((a) => [key(a.uuid), a]));
  const rolesOf = (uuid: string, extra: readonly string[] = []): string[] =>
    [...new Set([...(roles.get(key(uuid)) ?? []), ...extra])].sort();
  return {
    info(uuid) {
      const c = fromCatalog.get(key(uuid));
      const p = fromPalette.get(key(uuid));
      if (c) {
        const g = geomOf(c);
        return {
          name: c.name,
          geom: { size: g.size, originAt: g.originAt, boundsCenter: g.boundsCenter },
          facts: {
            kind: c.kind,
            groupTag: c.groupTag,
            tags: c.tags,
            name: c.name,
            height: c.size.y,
            roles: rolesOf(
              uuid,
              classifyAsset(c).map((x) => x.role),
            ),
          },
        };
      }
      if (p)
        return {
          name: p.name,
          geom: p.geom,
          // a palette knows no kind: a piece stored by its min corner is a tile, as the catalog derives it
          facts: {
            kind: p.geom.originAt === "minCorner" ? "tile" : "prop",
            groupTag: "",
            tags: [],
            name: p.name,
            height: p.geom.size.y,
            roles: rolesOf(uuid),
          },
        };
      return { name: uuid, geom: null, facts: null };
    },
  };
}
