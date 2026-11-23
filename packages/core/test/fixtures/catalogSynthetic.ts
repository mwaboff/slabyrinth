/**
 * A synthetic asset catalog and palette for the auto-palette classifier (palette/autoRoles.ts): invented names and
 * uuids, never game data (the real catalog is never committed). One case per rule: a sure sibling, an opt-in sibling, a
 * light and a floor routed to the developer's batch, a marker never added, a kit with one piece that does not fit, a
 * deprecated piece, a foreign pack, a new kit, a keyword-only piece, a seen piece and an excluded one.
 */
import type { CatalogAsset, Palette, PaletteVariant } from "../../src/contracts/compiler";

export const SYNTHETIC_PACK = "Kitpack";

let n = 0;
/** A catalog record; props stand on their centre, tiles at their min corner. */
export function syntheticAsset(
  name: string,
  size: [number, number, number],
  more: Partial<CatalogAsset> = {},
): CatalogAsset {
  n++;
  const tile = more.kind === "tile";
  return {
    uuid: `5e000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name,
    kind: "prop",
    pack: SYNTHETIC_PACK,
    packId: "kitpack-id",
    folder: "Grove",
    groupTag: "",
    tags: [],
    deprecated: false,
    interactable: false,
    size: { x: size[0], y: size[1], z: size[2] },
    footprintCells: { x: Math.max(1, Math.ceil(size[0] - 0.01)), z: Math.max(1, Math.ceil(size[2] - 0.01)) },
    boundsCenter: tile ? { x: size[0] / 2, y: size[1] / 2, z: size[2] / 2 } : { x: 0, y: size[1] / 2, z: 0 },
    boundsMin: tile ? { x: 0, y: 0, z: 0 } : { x: -size[0] / 2, y: 0, z: -size[2] / 2 },
    originAt: tile ? "minCorner" : "center",
    ...more,
  };
}

const TILE = { kind: "tile" } as const;

/** The pieces the synthetic palette names. */
export const CURATED = {
  rock: syntheticAsset("Mossy Rock 01", [0.8, 0.5, 0.8]),
  bone: syntheticAsset("Old Bone 01", [0.6, 0.2, 0.6]),
  lantern: syntheticAsset("Iron Lantern 01", [0.4, 1.2, 0.4]),
  floor: syntheticAsset("Grove Floor 01", [1, 0.5, 1], TILE),
  marker: syntheticAsset("Pillar Marker 01", [1, 2, 1]),
  stump: syntheticAsset("Oak Stump 01", [0.8, 0.6, 0.8]),
} as const;

/** Pieces "a game update added", by the case each stands for. */
export const ADDED = {
  sure: syntheticAsset("Mossy Rock 02", [0.85, 0.55, 0.8]),
  optIn: syntheticAsset("Old Bone 02", [0.6, 0.22, 0.6]),
  light: syntheticAsset("Iron Lantern 02", [0.4, 1.3, 0.4]),
  floor: syntheticAsset("Grove Floor 02", [1, 0.5, 1], TILE),
  marker: syntheticAsset("Pillar Marker 02", [1, 2, 1]),
  kitTooTall: syntheticAsset("Oak Stump 02", [0.8, 1.5, 0.8]),
  kitFits: syntheticAsset("Oak Stump 03", [0.8, 0.62, 0.8]),
  deprecated: syntheticAsset("Mossy Rock 03", [0.8, 0.5, 0.8], { deprecated: true }),
  foreign: syntheticAsset("Mossy Rock 04", [0.8, 0.5, 0.8], { pack: "Otherpack", packId: "other-id" }),
  newKit: syntheticAsset("Strange Idol 01", [0.6, 1.1, 0.6], { folder: "Newkit" }),
  keyword: syntheticAsset("Fern Clump 01", [0.7, 0.3, 0.7]),
  seen: syntheticAsset("Mossy Rock 05", [0.8, 0.5, 0.8]),
  excluded: syntheticAsset("Mossy Rock 06", [0.8, 0.5, 0.8]),
} as const;

export const SYNTHETIC_CATALOG: readonly CatalogAsset[] = [
  ...Object.values(CURATED),
  ...Object.values(ADDED),
];

const variant = (a: CatalogAsset, more: Partial<PaletteVariant> = {}): PaletteVariant => ({
  asset: a.uuid,
  name: a.name,
  geom: { size: a.size, originAt: a.originAt, boundsCenter: a.boundsCenter },
  ...more,
});

/** A one-theme palette over the curated pieces. */
export const SYNTHETIC_PALETTES: Record<string, Palette> = {
  grove: {
    schema: "slabyrinth/palette@1",
    id: "grove",
    name: "Grove",
    defaults: { floor: "grass", wallStyle: "fence" },
    roles: {
      "feature.rock": { variants: [variant(CURATED.rock, { variant: "mossy", rot: 15 })] },
      "feature.bones": { variants: [variant(CURATED.bone, { weight: 0 })] },
      "feature.lantern": { variants: [variant(CURATED.lantern)] },
      "floor.grass": { variants: [variant(CURATED.floor)] },
      "marker.alignment": { variants: [variant(CURATED.marker)] },
      "feature.stump": { variants: [variant(CURATED.stump)] },
    },
  },
};
