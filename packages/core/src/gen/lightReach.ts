/**
 * How far a light piece throws its light, and what kind of light it is (generator 5, switch `lightRegimes`): the
 * measured pieces' `light` in the one table of facts measured in game (gen/pieceFacts.ts, keyed by piece name), with a
 * default per light feature type for a piece the table does not name. The numbers come from the owner's night view of
 * the light-calibration slab (2026-11-22: a crate 1, 2 and 3 tiles in front of each piece; a relative ranking, ± half a
 * tile; the board's own day/night setting sets the absolute level).
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
import { pieceFacts } from "./pieceFacts";

export type LightKind = "pool" | "surface" | "wall" | "wash" | "point" | "none";
export type LightTone = "warm" | "red" | "blue" | "green" | "purple" | "cold";

export interface LightPiece {
  readonly reach: number;
  readonly kind: LightKind;
  readonly tone: LightTone;
}

const L = (reach: number, kind: LightKind, tone: LightTone = "warm"): LightPiece => ({ reach, kind, tone });

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

/** What a piece is as a light: by its name (gen/pieceFacts.ts), else by its feature type's default. */
export function lightPiece(name: string | undefined, type: FeatureType): LightPiece {
  return pieceFacts(name).light ?? BY_TYPE[type] ?? UNKNOWN;
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
