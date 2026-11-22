/**
 * How far a light piece throws its light, and what kind of light it is (generator 5, switch `lightRegimes`): one table
 * keyed by piece name, with a default per light feature type for a piece the table does not name. The numbers come
 * from the owner's night view of the light-calibration slab (2026-11-22: a crate 1, 2 and 3 tiles in front of each
 * piece; a relative ranking, ± half a tile; the board's own day/night setting sets the absolute level).
 *
 * No prop lights a room: even the strongest throws about 1.5 tiles. Lights are accents that mark where to look; how
 * bright the scene is, is the GM's board setting. So the regimes (gen/rooms4/regimes.ts) place pools on the things a
 * room is used for and choose pieces by reach, and the review counts only pieces that give light (`givesLight`).
 *
 *   reach   tiles of floor lit round the piece (0: none on the floor);
 *   kind    "pool" lights floor round it; "surface" its own table top only; "wall" a spot on the wall behind it; "wash"
 *           a coloured wash on the wall, almost no floor; "point" a point of light; "none" no light at all;
 *   tone    warm, red, blue, green, purple, cold.
 */
import type { FeatureType } from "../contracts/plan";

export type LightKind = "pool" | "surface" | "wall" | "wash" | "point" | "none";
export type LightTone = "warm" | "red" | "blue" | "green" | "purple" | "cold";

export interface LightPiece {
  readonly reach: number;
  readonly kind: LightKind;
  readonly tone: LightTone;
}

const L = (reach: number, kind: LightKind, tone: LightTone = "warm"): LightPiece => ({ reach, kind, tone });

/** Measured pieces, by the name the palettes give them. */
export const LIGHT_PIECES: Readonly<Record<string, LightPiece>> = {
  // strong: a pool about 1.5 tiles
  "Street Lantern": L(1.5, "pool"),
  hell_light_flame: L(1.5, "pool", "red"),
  // medium: about 1 tile
  Brazier: L(1, "pool"),
  "Camp Pit Fire 01": L(1, "pool"),
  "Crystal v1 large": L(0.7, "pool", "purple"),
  // weak: a glow round the piece, about half a tile
  "Floor Torch": L(0.5, "pool"),
  Campfire: L(0.5, "pool"),
  Bonfire: L(0.5, "pool"),
  "Desert torch": L(0.5, "pool"),
  "Harbor beach torch 01": L(0.5, "pool"),
  "Candleabra - single": L(0.5, "pool"),
  "Candleabra Triple": L(0.5, "pool"),
  // its own table top only
  Candle: L(0.25, "surface"),
  "Lantern -Small": L(0.25, "surface"),
  "Candleabra - Small": L(0.25, "surface"),
  // the wall torch every room uses: a spot on the wall about half a tile wide, practically no floor
  "Torch wall wood stone on": L(0.25, "wall"),
  // colour accents: a wash on the wall behind, almost nothing on the floor
  "Crystal 01": L(0, "wash", "blue"),
  "Crystal 02": L(0, "wash", "blue"),
  "Crystal 03": L(0, "wash", "blue"),
  "Crystal 05": L(0, "wash", "green"),
  "Crystal 06": L(0, "wash", "green"),
  // a point of cold light
  "Bonfire blue": L(0.1, "point", "cold"),
  "lamp aberration": L(0.1, "point", "cold"),
  // no visible light: decoration, never a room's light
  stone_lantern_01: L(0, "none"),
  stoneLantern03: L(0, "none"),
};

/** A piece no measurement names: the default of its feature type (conservative). */
const BY_TYPE: Partial<Record<FeatureType, LightPiece>> = {
  torch_wall: L(0.25, "wall"),
  candles: L(0.25, "surface"),
  candelabra: L(0.25, "surface"),
  chandelier: L(0.5, "pool"),
  brazier: L(1, "pool"),
  torch_floor: L(0.5, "pool"),
  lantern: L(0.5, "pool"),
  campfire: L(0.5, "pool"),
  fire_pit: L(1, "pool"),
  magic_fire: L(0.1, "point", "cold"),
  lava_glow: L(1, "pool", "red"),
  accent_light: L(0.5, "pool"),
  crystal: L(0, "wash", "blue"),
};
const UNKNOWN = L(0.5, "pool");

/** What a piece is as a light: by its name, else by its feature type's default. */
export function lightPiece(name: string | undefined, type: FeatureType): LightPiece {
  return (name !== undefined ? LIGHT_PIECES[name] : undefined) ?? BY_TYPE[type] ?? UNKNOWN;
}

/**
 * What a light feature will be, built from a pool of pieces (PlacementGrid.lightPieces): the weakest of them, so a
 * light is never counted on for more than the dimmest piece the compiler may pick.
 */
export function lightOfPool(names: readonly string[], type: FeatureType): LightPiece {
  const all = names.length > 0 ? names.map((n) => lightPiece(n, type)) : [lightPiece(undefined, type)];
  return all.reduce((a, b) => (b.reach < a.reach ? b : a));
}

/** Does the piece give light at all (the review and the meter count only those)? */
export const givesLight = (p: LightPiece): boolean => p.kind !== "none";

/** The reach of a light feature of a type when only that is known: its type's default. */
export function lightReach(type: FeatureType): number {
  return (BY_TYPE[type] ?? UNKNOWN).reach;
}
