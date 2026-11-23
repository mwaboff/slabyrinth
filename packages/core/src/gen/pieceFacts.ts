/**
 * What pieces are, measured in game (generator 5): ONE table keyed by the piece's name as the palettes give it, for the
 * facts a palette's bounds cannot say. Two pieces of one role may have identical bounds and still differ in kind (a
 * level rail and a raking stair rail), and a piece may glow without lighting anything. The palettes are generated data
 * and stay as they are; every fact here comes from the owner's calibration screenshots, with the slab that showed it.
 *
 *   light    how far it throws light and what kind of light it is (gen/lightReach.ts reads it): the light-calibration
 *            slab's night view (2026-11-22: a crate 1, 2 and 3 tiles in front of each piece; relative, ± half a tile);
 *   setting  indoor, outdoor or either, and what it stands on (floor, table, wall, hanging): an outdoor piece never
 *            stands in a furnished room (switch sensibleLights);
 *   glows    it shows a visible glow but lights nothing (a green-glowing jug): read as a light, so it is kept out of an
 *            ordinary room's clutter, where it looks like a broken lamp (the room kinds whose row says `glow` take it);
 *   sloped   a raking piece (a stair's handrail): it stands only on a stair, never along a level run;
 *   endPost  a level piece with a taller post at one end (a newel): only at a run's end, turned so the post is the end;
 *   ragged   a floor tile with broken, gapped ends (ruined boards): a floor's whole pieces cover the cells instead;
 *   grown    grown over with moss or plants: it reads as a land plant (kept off ground under water);
 *   shell    a hollow shell (a hull's curved planking): its box encloses the decks and rooms inside it, so it neither
 *            rises "through" a floor it surrounds nor counts as solid to what stands within.
 * Facts about a whole roof kit (its tone, family, spiked corner) are keyed by kit, not piece: resolve/roofKits.ts.
 * A piece the table does not name has no such fact: it is level, post-free and does not glow.
 */
import type { LightPiece } from "./lightReach";

/**
 * Where a piece makes sense (owner, 2026-11-22: "Id rather there be a little less light than being goofy with certain
 * props that don't make much sense"): indoors, outdoors or either, and what it stands on. An outdoor piece (a street
 * lantern, a beach torch, a campfire) never stands in a furnished room, whatever light the room's level asks for.
 */
export interface PieceSetting {
  readonly place: "indoor" | "outdoor" | "either";
  readonly on: "floor" | "table" | "wall" | "hanging";
}

export interface PieceFacts {
  readonly light?: LightPiece;
  readonly setting?: PieceSetting;
  readonly glows?: true;
  readonly sloped?: true;
  /** Which end of the piece's length carries the taller post, as it stands unturned: the low end (-x) or the high (+x). */
  readonly endPost?: "low" | "high";
  /** A floor tile with broken, gapped ends (ruined boards): laid as a floor it reads as holes along its row. */
  readonly ragged?: true;
  /** A hollow shell (a hull's planking): its box encloses what stands inside it, a floor or a room, without meeting it. */
  readonly shell?: true;
  /** A piece grown over with moss or plants: it reads as a land plant, so it stays off ground under water. */
  readonly grown?: true;
}

const light = (
  reach: number,
  kind: LightPiece["kind"],
  setting: PieceSetting,
  tone: LightPiece["tone"] = "warm",
): PieceFacts => ({ light: { reach, kind, tone }, setting });

const OUT_FLOOR: PieceSetting = { place: "outdoor", on: "floor" };
const ANY_FLOOR: PieceSetting = { place: "either", on: "floor" };
const IN_FLOOR: PieceSetting = { place: "indoor", on: "floor" };
const IN_TABLE: PieceSetting = { place: "indoor", on: "table" };
const ANY_WALL: PieceSetting = { place: "either", on: "wall" };

/** Measured pieces, by the name the palettes give them. */
export const PIECE_FACTS: Readonly<Record<string, PieceFacts>> = {
  // ── lights (light-calibration slab; setting: what the piece is, the owner's rule of sense) ──
  // strong: a pool about 1.5 tiles
  "Street Lantern": light(1.5, "pool", OUT_FLOOR),
  hell_light_flame: light(1.5, "pool", ANY_FLOOR, "red"),
  // medium: about 1 tile (a brazier is a fire: a hearth, a forge, a guard room, a rough hall)
  Brazier: light(1, "pool", ANY_FLOOR),
  "Camp Pit Fire 01": light(1, "pool", OUT_FLOOR),
  "Crystal v1 large": light(0.7, "pool", ANY_FLOOR, "purple"),
  // weak: a glow round the piece, about half a tile
  "Floor Torch": light(0.5, "pool", ANY_FLOOR),
  Campfire: light(0.5, "pool", OUT_FLOOR),
  Bonfire: light(0.5, "pool", OUT_FLOOR),
  "Desert torch": light(0.5, "pool", OUT_FLOOR),
  "Harbor beach torch 01": light(0.5, "pool", OUT_FLOOR),
  "Candleabra - single": light(0.5, "pool", IN_FLOOR),
  "Candleabra Triple": light(0.5, "pool", IN_FLOOR),
  // its own table top only
  Candle: light(0.25, "surface", IN_TABLE),
  "Lantern -Small": light(0.25, "surface", IN_TABLE),
  "Candleabra - Small": light(0.25, "surface", IN_TABLE),
  // the wall torch every room uses: a spot on the wall about half a tile wide, practically no floor
  "Torch wall wood stone on": light(0.25, "wall", ANY_WALL),
  // colour accents: a wash on the wall behind, almost nothing on the floor
  "Crystal 01": light(0, "wash", ANY_WALL, "blue"),
  "Crystal 02": light(0, "wash", ANY_WALL, "blue"),
  "Crystal 03": light(0, "wash", ANY_WALL, "blue"),
  "Crystal 05": light(0, "wash", ANY_WALL, "green"),
  "Crystal 06": light(0, "wash", ANY_WALL, "green"),
  // a point of cold light
  "Bonfire blue": light(0.1, "point", OUT_FLOOR, "cold"),
  "lamp aberration": light(0.1, "point", ANY_FLOOR, "cold"),
  // no visible light: decoration, never a room's light (garden lanterns)
  stone_lantern_01: light(0, "none", OUT_FLOOR),
  stoneLantern03: light(0, "none", OUT_FLOOR),

  // ── glowing decor (floor-groups proof, night: a green glow on the ward's nightstands, no light round it) ──
  "jug green": { glows: true },

  // ── rails (rail-calibration slab, 2026-11-22: three runs of three pieces, 1, 2 and 3 crates before them) ──
  // A: a level rail; pieces join end to end into one rail
  // B: a raking stair rail with a leg; three in a row make a saw-tooth (it stuck up along the test ship's deck edge)
  "railing 01 B": { sloped: true },
  // C: level, with a newel post rising above the rail at one end (the run's west end, unturned: its low end)
  "railing 01 C": { endPost: "low" },

  // ── ragged floor boards (owner's harbour screenshots 185-188, 2026-11-23: the wharf's edge row, laid with these 2 x 1
  // pieces between 2 x 2 "Castle Ruins Wood - Large" tiles, showed a comb of notches every two cells, the 2 x 2 body
  // none) ──
  "Castle Ruins Wood 1": { ragged: true },
  "Castle Ruins Wood 2": { ragged: true },
  "Castle Ruins Wood 3": { ragged: true },

  // ── grown pieces (harbour screenshots 205-208: the only pieces left on the bed under the water plane were rocks;
  // this one read as green tufts, like the plants the rule keeps off) ──
  "Moss Rock 01": { grown: true },

  // ── hollow hull shells (owner's ship screenshots 205-210, 2026-11-23: the ship kit's "Ship bottom" tiles are curved
  // planked shells from the keel to the gunwale, open inside; a ship's decks and rooms stand within their boxes) ──
  "Ship bottom side 4x2_Port and Starboard": { shell: true },
  "Ship bottom front L_Bow": { shell: true },
  "Ship bottom front R_Bow": { shell: true },
  "Ship bottom front filler 4x2_Bow": { shell: true },
  "Ship bottom back L_Stern": { shell: true },
  "Ship bottom back R_Stern": { shell: true },
  "Ship bottom back Fin 4x2_Rudder": { shell: true },
};

/** The facts of a piece by its name (none for a piece the table does not name). */
export const pieceFacts = (name: string | undefined): PieceFacts =>
  (name !== undefined ? PIECE_FACTS[name] : undefined) ?? {};

/** Is the piece an outdoor one (a street lantern, a campfire): never in a furnished room? */
export const outdoorPiece = (name: string | undefined): boolean =>
  pieceFacts(name).setting?.place === "outdoor";

/** Does the piece only glow (it lights nothing and looks like a light)? */
export const glows = (name: string | undefined): boolean => pieceFacts(name).glows === true;

/** Is the piece grown over with moss or plants (it reads as a plant)? */
export const grown = (name: string | undefined): boolean => pieceFacts(name).grown === true;

/** Is the piece a hollow shell whose box encloses what stands inside it? */
export const shell = (name: string | undefined): boolean => pieceFacts(name).shell === true;

/** Is the piece a ragged floor tile (broken, gapped ends)? */
export const ragged = (name: string | undefined): boolean => pieceFacts(name).ragged === true;

/** May the piece stand in a level run (not a stair rail)? `atEnd`: at a run's end, where an end post belongs. */
export const levelRunPiece = (name: string | undefined, atEnd: boolean): boolean => {
  const f = pieceFacts(name);
  return f.sloped !== true && (f.endPost === undefined || atEnd);
};

/**
 * May the piece stand anywhere, as a free part drawn for its shape (a pool's piece, a recipe slot's, a stand-in): no
 * stair rail, no end-post piece (its post would end a run in the middle) and no glowing decor. The places that know
 * more (a run's end, a room whose kind takes glowing things) ask the facts themselves.
 */
export const standsAnywhere = (name: string | undefined): boolean =>
  levelRunPiece(name, false) && !glows(name);
