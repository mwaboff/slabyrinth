/**
 * What each roof kit IS, as data the palette does not hold: facts about the kits (palette roles roof.<kit>.*) that a
 * choice needs and the pieces' sizes cannot tell, read off the owner's in-game screenshots. One row per kit; a kit with
 * no row has no facts (every choice that reads one treats it as unknown and keeps to the kit's own pieces).
 *
 *   tone       the colour a viewer reads from the street: a patch, a borrowed cap or a near kit must keep it
 *   family     what the surface is made of; kits of one family and tone are near neighbours
 *   pitched    the kit has slopes (else it is a flat surface only)
 *   cornerTip  its corner piece rises to a spiked tip: along a hip's ridges it stands as a row of spikes, so a hip roof
 *              is built in a kit whose corner reads as a hip ("haunted roof corner out tip": the manor's black spikes)
 *   ownCap     it has a ridge cap or flat piece of its own (an odd span's ridge row)
 *   weathered  it has worn pieces of its own (variant "broken"): a patch re-laid in them is a repair of the same roof
 *
 * Read by resolve/building/volumes.ts (a hip in a tipped kit), resolve/building/wear.ts (whether a roof can be
 * patched), resolve/structure.ts (the style draw: readable roof colours) and compile/realize/structures/roofPiece.ts
 * (the patch kit, the borrowed cap). A test holds `ownCap` and `weathered` to the bundled palettes.
 * Facts about single pieces by their name (a rail's slope, a light's reach and setting, a glowing jug) are in the one
 * piece table, gen/pieceFacts.ts; this table is about whole kits (a role family), keyed by kit.
 */
import { own } from "../util/own";

export type RoofTone = "grey" | "orange" | "brown";

export interface RoofKitInfo {
  readonly tone: RoofTone;
  readonly family: "shingle" | "tile" | "slab";
  readonly pitched: boolean;
  readonly cornerTip: boolean;
  readonly ownCap: boolean;
  readonly weathered: boolean;
}

const pitched = (
  tone: RoofTone,
  family: RoofKitInfo["family"],
  f: Partial<RoofKitInfo> = {},
): RoofKitInfo => ({
  tone,
  family,
  pitched: true,
  cornerTip: false,
  ownCap: false,
  weathered: false,
  ...f,
});
const flat = (tone: RoofTone): RoofKitInfo => ({
  tone,
  family: "slab",
  pitched: false,
  cornerTip: false,
  ownCap: true,
  weathered: false,
});

export const ROOF_KITS: Readonly<Record<string, RoofKitInfo>> = {
  // grey slate shingles (the generic "haunted roof" pieces): a spiked corner tip, a flat cap, a broken 2x2
  slate: pitched("grey", "shingle", { cornerTip: true, ownCap: true, weathered: true }),
  // orange clay tiles ("Village Roof Side/Corner"): a plain corner, no cap or flat piece
  village: pitched("orange", "tile"),
  // flat surfaces (the city and modern kits)
  city: flat("grey"),
  concrete: flat("grey"),
  durable: flat("grey"),
  industrial: flat("grey"),
};

export const roofKitInfo = (kit: string): RoofKitInfo | undefined => own(ROOF_KITS, kit);

/** Whether two kits read alike from the street (the same tone and family): a patch or a borrowed piece may mix them. */
export function nearKits(a: string, b: string): boolean {
  const p = roofKitInfo(a);
  const q = roofKitInfo(b);
  return p !== undefined && q !== undefined && p.tone === q.tone && p.family === q.family;
}

/** The roof colour a kit reads as (its tone; the kit's name when the table does not know it). */
export const roofTone = (kit: string): string => roofKitInfo(kit)?.tone ?? kit;
