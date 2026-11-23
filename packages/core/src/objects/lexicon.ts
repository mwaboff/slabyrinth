/**
 * The stand-in lexicon (technique M13): one table of the parts objects are built from ("a plank", "a pole", "cloth"),
 * each a list of palette roles that name the thing and a shape every candidate must have. Every object recipe asks the
 * lexicon, never its own query, so all objects in one theme share their stand-ins.
 *
 * How a stand-in is found, in order (the first that yields a piece wins):
 *   1. its roles, each resolved in the theme through the palette's own fallback chain (the theme's pieces first, then
 *      what it extends, then generic), keeping the variants of the shape's kind and measure ranges;
 *   2. its shape as a trait pool of the theme (palette/traitPools.ts: the theme's own palettes first, generic last);
 *   3. simplify: the stand-in it falls back to (`simplify`, a plainer part: rope → plank);
 *   4. skip: null, and the recipe leaves the part out (a wrong object is worse than none).
 * A kit stand-in (`kit`, the ship kit) takes step 1 only: its role names the thing, so no pool piece of its shape and
 * no plainer form stands in for it; the recipe asks for it first and falls back to today's stand-in (`kitOr`).
 * Candidates are ranked by how near their measures are to the wanted ones (`target`), so the most fitting piece comes
 * first; the candidates within `NEAR` of the best are the mix a recipe may vary over. A piece from another palette than
 * the theme's is "borrowed". Pure function of the palettes: memoized per kit (objects/kit.ts).
 */
import type { RoleName } from "../contracts/compiler";
import type { ThemeId } from "../contracts/plan";
import { fromPool, fromVariant, type ArrangePiece } from "../arrange/piece";
import type { PlanRoles } from "../palette/planRoles";
import { drawsFreely } from "../palette/traitPools";
import { measurePiece, type MeasureId, type MeasureRange, type TraitShape } from "../palette/traits";
import { own } from "../util/own";

/** One stand-in: what it is, the roles that name it, the shape it must have, the measures wanted, its plainer form. */
export interface StandInDef {
  readonly doc: string;
  /** Palette roles that name the thing, asked first, in order. */
  readonly roles: readonly RoleName[];
  /** The shape every candidate must have (role pieces are filtered by it; the trait pool asks for it). */
  readonly shape: TraitShape;
  /** Role families that may lend pieces to the trait-pool step (structure borrows from structure). */
  readonly families?: readonly string[];
  /** The measures wanted: candidates are ranked by their distance from these (ratio, both ways). */
  readonly target: Partial<Record<MeasureId, number>>;
  /** The stand-in to use when no piece has this one's shape. */
  readonly simplify?: string;
  /**
   * A kit piece (the ship kit, scripts/palette-ship-assets.json): found through its roles only, never a trait pool or
   * a plainer form, and every piece the role lists stands in (the role names the thing). Absent from the palettes, it
   * is null and the recipe uses today's stand-in (objects/kit.ts `kitOr`).
   */
  readonly kit?: true;
}

/** Wood and timber come from structure and fittings, never from furniture or nature of the right shape. */
const TIMBER_FAMILIES = ["stall", "pier", "porch_post", "ruin_prop", "roof", "wall_post", "facade_post"];

export const STAND_INS = {
  plank: {
    doc: "a thin long board lying down (a strake, a rail, a spar): about 2 long, under 0.3 thick and tall",
    roles: ["stall.ridge"],
    shape: {
      trait: "beam",
      kind: "prop",
      where: { length: [1.4, 2.6], height: [0.06, 0.3], width: [0.06, 0.3] },
    },
    families: TIMBER_FAMILIES,
    target: { length: 2, height: 0.15, width: 0.13 },
  },
  timber: {
    doc: "a heavy squared timber lying down (a keel, a bowsprit, a wale): about 2 long, 0.3 to 0.7 thick",
    roles: ["ruin_prop.default", "feature.log"],
    shape: {
      trait: "beam",
      kind: "prop",
      where: { length: [1.4, 2.6], height: [0.3, 0.75], width: [0.3, 0.75] },
    },
    families: TIMBER_FAMILIES,
    target: { length: 2, height: 0.5, width: 0.5 },
    simplify: "plank",
  },
  pole: {
    doc: "a tall thin upright (a mast section, a stem post): 3 or more tall, under 0.4 across",
    roles: ["feature.line_post"],
    shape: { trait: "post", kind: "prop", where: { height: [2.8, 5], length: [0.12, 0.45] } },
    families: ["feature"],
    target: { height: 3.6, length: 0.28 },
    simplify: "post",
  },
  post: {
    doc: "a timber post about 2 tall and under 0.35 across (a stanchion, a short mast section)",
    roles: ["porch_post.default", "feature.mine_support"],
    shape: { trait: "post", kind: "prop", where: { height: [1.5, 2.4], length: [0.12, 0.36] } },
    families: TIMBER_FAMILIES,
    target: { height: 2, length: 0.26 },
  },
  rope: {
    doc: "a rope or line lying straight, about 2 long and under 0.2 thick (rigging, furled-sail lashing)",
    roles: ["feature.overhead"],
    shape: {
      trait: "beam",
      kind: "prop",
      where: { length: [1.4, 2.6], height: [0.03, 0.2], width: [0.03, 0.2] },
    },
    families: ["feature"],
    target: { length: 2, height: 0.12, width: 0.12 },
    simplify: "plank",
  },
  cloth: {
    doc: "a hanging cloth on edge, about 1 wide and 1.3 tall (a sail panel, a pennant, an awning skirt)",
    roles: ["feature.wall_dressing", "feature.banner_wall", "feature.signage"],
    shape: { trait: "panel", kind: "prop", where: { length: [0.7, 1.6], height: [0.9, 1.8] } },
    target: { length: 1, height: 1.3 },
  },
  deck: {
    doc: "a 2 x 2 wooden floor tile (a deck, a counter top)",
    roles: ["floor.wood_plank", "floor.bridge_wood"],
    shape: { trait: "slab", kind: "tile", where: { length: [1.9, 2.1], width: [1.9, 2.1] } },
    families: ["floor"],
    target: { length: 2, width: 2 },
    simplify: "deckSmall",
  },
  deckSmall: {
    doc: "a 1 x 1 wooden floor tile (the deck's margins and steps)",
    roles: ["floor.wood_plank", "step.wood_plank", "floor.bridge_wood"],
    shape: { trait: "slab", kind: "tile", where: { length: [0.9, 1.1], width: [0.9, 1.1] } },
    families: ["floor", "step"],
    target: { length: 1, width: 1 },
  },
  hatch: {
    doc: "a flat square wooden piece about 1 across (a hatch cover, a fighting top, a grating)",
    roles: ["roof_clutter.storage"],
    shape: { trait: "slab", kind: "prop", where: { length: [0.8, 1.3], height: [0.1, 0.4] } },
    target: { length: 1, width: 1, height: 0.25 },
  },
  crate: {
    doc: "a crate about 1 across",
    roles: ["feature.crate"],
    shape: { trait: "block", kind: "prop", where: { height: [0.75, 1.1] } },
    target: { height: 0.95 },
  },
  smallCrate: {
    doc: "a small crate about 0.5 across",
    roles: ["feature.crate"],
    shape: { trait: "clutter", kind: "prop", where: { extent: [0.35, 0.6] } },
    target: { extent: 0.52 },
  },
  barrel: {
    doc: "a barrel or cask standing up",
    roles: ["feature.barrel"],
    shape: { trait: "post", kind: "prop", where: { height: [0.5, 1] } },
    target: { height: 0.76 },
    simplify: "smallCrate",
  },
  sack: {
    doc: "a sack standing up",
    roles: ["feature.sack", "feature.goods"],
    shape: { trait: "clutter", kind: "prop", where: { height: [0.4, 0.65] } },
    target: { height: 0.6, length: 0.33 },
  },
  goods: {
    doc: "small wares on show (a basket, a loaf, a jug)",
    roles: ["feature.goods"],
    shape: { trait: "clutter", kind: "prop", where: { extent: [0.15, 0.6] } },
    target: { extent: 0.35 },
  },
  bench: {
    doc: "a plain bench about 1.3 long (a thwart, a vendor's seat)",
    roles: ["feature.bench", "feature.seating"],
    shape: { trait: "beam", kind: "prop", where: { length: [0.9, 1.8], height: [0.15, 0.6] } },
    target: { length: 1.3, height: 0.3 },
    simplify: "plank",
  },
  rail: {
    doc: "a level railing section about 1 long (a bulwark rail): level pieces only (gen/pieceFacts.ts, rail calibration: railing 01 A level, B a stair rail, C with a newel post)",
    roles: ["wall.railing"],
    shape: { trait: "panel", kind: "prop", where: { length: [0.9, 1.2], height: [0.5, 0.9] } },
    target: { length: 1.03, height: 0.73 },
  },
  fitting: {
    doc: "a small deck fitting about 0.4 across (a bucket, a coil, a belaying block)",
    roles: ["feature.clutter"],
    shape: { trait: "clutter", kind: "prop", where: { extent: [0.35, 0.5], height: [0.3, 0.5] } },
    target: { extent: 0.42, height: 0.39 },
  },
  lantern: {
    doc: "a small hanging or hand lantern under 0.8 tall",
    roles: ["feature.overhead", "feature.lantern"],
    shape: { trait: "clutter", kind: "prop", where: { height: [0.4, 0.8], length: [0.1, 0.45] } },
    target: { height: 0.68, length: 0.39 },
  },
  stool: {
    doc: "a stool or small seat",
    roles: ["stall.seat", "feature.stool"],
    shape: { trait: "clutter", kind: "prop", where: { height: [0.25, 0.6] } },
    target: { height: 0.5 },
  },
  shelter: {
    doc: "a small hide or canvas shelter (a deck awning, a lean-to)",
    roles: ["feature.tent"],
    shape: { trait: "block", kind: "prop", where: { height: [1, 1.8] } },
    target: { height: 1.4, length: 1.3 },
  },
  counter: {
    doc: "a 1 x 1 counter or table-top tile (a stall front)",
    roles: ["stall.counter", "feature.counter", "feature.bar_counter"],
    shape: { trait: "slab", kind: "tile", where: { length: [0.9, 1.1], width: [0.9, 1.1] } },
    target: { length: 1, height: 0.5 },
    simplify: "crate",
  },
  corner: {
    doc: "a square post about 2 tall and 0.5 across, on the tile grid (a stall's corner post)",
    roles: ["stall.post", "pier.wood_plank", "pier.bridge_wood"],
    shape: { trait: "post", kind: "tile", where: { height: [1.8, 2.2], length: [0.4, 0.6] } },
    target: { height: 2, length: 0.5 },
    simplify: "post",
  },
  canopy: {
    doc: "a 1 x 1 cloth roof tile (an awning, a stall canopy)",
    roles: ["canopy.awning", "stall.canopy"],
    shape: { trait: "slab", kind: "tile", where: { length: [0.9, 1.1], width: [0.9, 1.1] } },
    target: { length: 1, height: 0.5 },
  },
  sign: {
    doc: "a small flat sign board (a shop sign)",
    roles: ["sign_band.default"],
    shape: { trait: "panel", kind: "prop", where: { length: [0.6, 1.4] } },
    target: { length: 1, height: 0.45 },
    simplify: "cloth",
  },
  // ── the ship kit (generator 5): the game's own ship pieces, asked first by the vessel recipe ──
  shipDeck: {
    doc: "a 2 x 2 ship deck tile",
    roles: ["ship.deck"],
    shape: { trait: "slab", kind: "tile", where: { length: [1.9, 2.1], width: [1.9, 2.1] } },
    target: { length: 2, width: 2 },
    kit: true,
  },
  shipDeckSmall: {
    doc: "a 1 x 1 ship deck tile",
    roles: ["ship.deck"],
    shape: { trait: "slab", kind: "tile", where: { length: [0.9, 1.1], width: [0.9, 1.1] } },
    target: { length: 1, width: 1 },
    kit: true,
  },
  shipMast: {
    doc: "a mast section about 2 tall (the kit's base, mid and top pieces, by their variant)",
    roles: ["ship.mast"],
    shape: { trait: "post", kind: "prop", where: { height: [1.8, 2.6], length: [0.5, 1.4] } },
    target: { height: 2, length: 0.72 },
    kit: true,
  },
  shipSpar: {
    doc: "an upright ship beam about 2 tall and 0.25 across (a stanchion, a frame post)",
    roles: ["ship.spar"],
    shape: { trait: "post", kind: "prop", where: { height: [1.5, 2.4], length: [0.15, 0.4] } },
    target: { height: 2, length: 0.25 },
    kit: true,
  },
  shipSail: {
    doc: "a set sail panel about 1 to 2 wide and 2 or 4 tall (the large ones by their variant)",
    roles: ["ship.sail_set"],
    shape: { trait: "panel", kind: "prop", where: { length: [0.9, 2.2], height: [1.8, 4.2] } },
    target: { length: 1.03, height: 2 },
    kit: true,
  },
  shipFurled: {
    doc: "a furled sail hanging under a yard, about 1 to 2 long",
    roles: ["ship.sail_furled"],
    shape: { trait: "beam", kind: "prop", where: { length: [0.9, 2.2], height: [0.3, 1] } },
    target: { length: 2.03, height: 0.9 },
    kit: true,
  },
  shipRope: {
    doc: "a ship's line lying straight, about 2 long",
    roles: ["ship.rope"],
    shape: { trait: "beam", kind: "prop", where: { length: [1.4, 2.6], height: [0.03, 0.2] } },
    target: { length: 2, height: 0.13 },
    kit: true,
  },
  shipLantern: {
    doc: "a ship's hanging lantern",
    roles: ["ship.lantern"],
    shape: { trait: "clutter", kind: "prop", where: { height: [0.4, 0.9] } },
    target: { height: 0.68 },
    kit: true,
  },
  shipGrating: {
    doc: "a 2 x 2 hatch grating tile",
    roles: ["ship.grating"],
    shape: { trait: "slab", kind: "tile", where: { length: [1.9, 2.1], width: [1.9, 2.1] } },
    target: { length: 2, width: 2 },
    kit: true,
  },
  shipCargo: {
    doc: "ship's cargo: a dark crate or a barrel",
    roles: ["ship.cargo"],
    shape: { trait: "block", kind: "prop", where: { height: [0.45, 1.1] } },
    target: { height: 0.76 },
    kit: true,
  },
  shipCoil: {
    doc: "a coil of rope lying on the deck",
    roles: ["ship.fitting"],
    shape: { trait: "clutter", kind: "prop", where: { length: [0.5, 0.9], height: [0.05, 0.3] } },
    target: { length: 0.69 },
    kit: true,
  },
  shipHelm: {
    doc: "the helm: a steering wheel on its 2 x 1 deck tile",
    roles: ["ship.helm"],
    shape: { trait: "slab", kind: "tile", where: { length: [1.9, 2.1], width: [0.9, 1.1] } },
    target: { length: 2, width: 1 },
    kit: true,
  },
  shipAnchor: {
    doc: "an anchor hung on its end",
    roles: ["ship.anchor"],
    shape: { trait: "panel", kind: "prop", where: { height: [0.9, 1.8] } },
    target: { height: 1.35 },
    kit: true,
  },
  shipCapstan: {
    doc: "a capstan or anchor wheel",
    roles: ["ship.capstan"],
    shape: { trait: "block", kind: "prop", where: { height: [0.6, 1.2] } },
    target: { height: 0.92 },
    kit: true,
  },
  shipBoat: {
    doc: "the kit boat's sections (bow, mid, stern, by their variant), about 2.4 wide",
    roles: ["ship.boat"],
    shape: { trait: "block", kind: "prop", where: { height: [1, 2], length: [1.8, 2.8] } },
    target: { height: 1.44, length: 2.37 },
    kit: true,
  },
  // the grid hull: tiles laid on whole cells at their real sizes (objects/vessel.ts `kitHullOf`)
  shipHullSide: {
    doc: "a hull side section: a tile 4 along the ship, 2 across, the full depth of the hull",
    roles: ["ship.hull_side"],
    shape: { trait: "block", kind: "tile", where: { length: [3.5, 4.5], width: [1.5, 2.5] } },
    target: { length: 4, width: 2 },
    kit: true,
  },
  shipHullBow: {
    doc: "the bow's hull tiles (left and right halves, a filler between, by their variant)",
    roles: ["ship.hull_bow"],
    shape: { trait: "block", kind: "tile", where: { length: [3.5, 4.5] } },
    target: { length: 4, width: 4 },
    kit: true,
  },
  shipHullStern: {
    doc: "the stern's hull tiles (left and right halves, the rudder between, by their variant)",
    roles: ["ship.hull_stern"],
    shape: { trait: "block", kind: "tile", where: { length: [3.5, 4.5] } },
    target: { length: 4, width: 4 },
    kit: true,
  },
  shipRail: {
    doc: "a bulwark rail tile along the deck's edge, 1 or 2 long and half a cell thick",
    roles: ["ship.rail"],
    shape: { trait: "panel", kind: "tile", where: { length: [0.9, 2.1], height: [1, 1.5] } },
    target: { length: 2, height: 1.25 },
    kit: true,
  },
  shipRailBow: {
    doc: "the curved bulwark of one half of the bow, a 4 x 4 tile",
    roles: ["ship.rail_bow"],
    shape: { trait: "block", kind: "tile", where: { length: [3.5, 4.5] } },
    target: { length: 4, width: 4 },
    kit: true,
  },
  shipRailStern: {
    doc: "the rail across the stern, 2 long",
    roles: ["ship.rail_stern"],
    shape: { trait: "panel", kind: "tile", where: { length: [1.9, 2.1], height: [1, 1.5] } },
    target: { length: 2, height: 1.25, width: 0.5 },
    kit: true,
  },
  shipWall: {
    doc: "a ship's wall tile 2 tall and half a cell thick (a raised deck's side, a cabin front)",
    roles: ["ship.wall"],
    shape: { trait: "panel", kind: "tile", where: { length: [1.9, 2.1], height: [1.9, 2.1] } },
    target: { length: 2, height: 2 },
    kit: true,
  },
  shipPorthole: {
    doc: "a ship's wall tile with a porthole, 1 long",
    roles: ["ship.wall_porthole"],
    shape: {
      trait: "panel",
      kind: "tile",
      where: { length: [0.9, 1.1], height: [1.9, 2.1], width: [0.3, 0.6] },
    },
    target: { length: 1, height: 2 },
    kit: true,
  },
  shipWindow: {
    doc: "a ship's wall tile with a window, 1 long (a cabin's side)",
    roles: ["ship.wall_window"],
    shape: { trait: "panel", kind: "tile", where: { length: [0.9, 1.1], height: [1.9, 2.1] } },
    target: { length: 1, height: 2 },
    kit: true,
  },
  shipGallery: {
    doc: "the stern gallery's tiles: corners (left, right) and windows, 2 x 2 and a storey tall, by their variant",
    roles: ["ship.wall_stern"],
    shape: { trait: "block", kind: "tile", where: { height: [2.3, 2.7] } },
    target: { length: 2, width: 2, height: 2.5 },
    kit: true,
  },
  shipShrouds: {
    doc: "a shroud with its ratlines: a sloped rope ladder about 2 tall climbing 1 across",
    roles: ["ship.shrouds"],
    shape: { trait: "block", kind: "prop", where: { height: [1.8, 2.3] } },
    target: { height: 2, length: 1.1 },
    kit: true,
  },
  shipBowsprit: {
    doc: "the bowsprit's sections (base, mid, top, by their variant): spars about 3.5-4 long, rising",
    roles: ["ship.bowsprit"],
    shape: { trait: "beam", kind: "prop", where: { length: [3, 4.5] } },
    target: { length: 3.6 },
    kit: true,
  },
  shipCannon: {
    doc: "a ship's cannon on its carriage, its barrel about 1.8 long",
    roles: ["ship.cannon"],
    shape: { trait: "beam", kind: "prop", where: { length: [1.5, 2.1], height: [0.6, 1] } },
    target: { length: 1.8, height: 0.76 },
    kit: true,
  },
} as const satisfies Record<string, StandInDef>;

export type StandInId = keyof typeof STAND_INS;
export const STAND_IN_IDS = Object.keys(STAND_INS) as StandInId[];

/** Where a stand-in's pieces came from. */
export type StandInSource = "role" | "pool";

/** A found stand-in: its candidates, best first, and how they were found. */
export interface StandIn {
  readonly id: StandInId;
  /** Best first; the first `near` of them are within `NEAR` of the best. */
  readonly pieces: readonly ArrangePiece[];
  readonly near: number;
  readonly source: StandInSource;
  /** The palette's role that supplied them (a role source), or the pool's first role. */
  readonly role: RoleName;
  /** The pieces come from another palette than the theme's own. */
  readonly borrowed: boolean;
  /** The stand-in asked for, when this one is its plainer form. */
  readonly simplifiedFrom?: StandInId;
}

/** Candidates whose distance from the target is within this of the best one's are its mix. */
const NEAR = 0.15;

/** How far a piece's measures are from the wanted ones: the sum of |ln(measure / wanted)|. */
function distance(p: ArrangePiece, target: StandInDef["target"]): number {
  let d = 0;
  for (const [id, want] of Object.entries(target) as [MeasureId, number | undefined][]) {
    if (want === undefined || want <= 0) continue;
    d += Math.abs(Math.log(Math.max(1e-6, p.measures[id]) / want));
  }
  return d;
}

/** The candidates ranked nearest first (stable: equal distances keep their palette order). */
function ranked(pieces: readonly ArrangePiece[], def: StandInDef): { pieces: ArrangePiece[]; near: number } {
  const scored = pieces.map((p, i) => ({ p, i, d: distance(p, def.target) }));
  scored.sort((a, b) => a.d - b.d || a.i - b.i);
  const best = scored[0]?.d ?? 0;
  return { pieces: scored.map((s) => s.p), near: scored.filter((s) => s.d <= best + NEAR).length };
}

/**
 * Whether a role's piece fits the stand-in: its kind and measure ranges. The trait itself is not asked of a role's
 * pieces: the role already says what the thing is (a barrel is no trait's shape), the ranges keep its size.
 */
function fitsRole(geom: Parameters<typeof measurePiece>[0], shape: TraitShape): boolean {
  const m = measurePiece(geom);
  if (shape.kind !== undefined && m.kind !== shape.kind) return false;
  for (const [id, range] of Object.entries(shape.where ?? {}) as [MeasureId, MeasureRange | undefined][])
    if (range !== undefined && (m[id] < range[0] || m[id] > range[1])) return false;
  return true;
}

/** The pieces of the stand-in's roles in the theme that fit it (first role with any wins). */
function fromRoles(
  roles: PlanRoles,
  theme: ThemeId,
  def: StandInDef,
): { pieces: ArrangePiece[]; role: RoleName } {
  // generator 5 (pieceFacts): a part stands in runs and anywhere, so no stair rail, end-post piece or glowing decor
  // (the rule every pool keeps); a kit role names the thing itself (a ship's lantern is meant to glow)
  const plain = (name: string | undefined): boolean => def.kit === true || drawsFreely(roles.generator, name);
  for (const role of def.roles) {
    const res = roles.resolve(theme, role).resolution;
    if (!res) continue;
    const pieces = res.variants
      .filter((v) => v.parts === undefined && fitsRole(v.geom, def.shape) && plain(v.name))
      .map((v) => fromVariant(res.paletteId, res.role, v));
    if (pieces.length > 0) return { pieces, role: res.role };
  }
  return { pieces: [], role: "" };
}

/** The stand-in in the theme (see the file header), or null when nothing stands in for it. */
export function findStandIn(
  roles: PlanRoles,
  theme: ThemeId,
  id: StandInId,
  seen: StandInId[] = [],
): StandIn | null {
  const def: StandInDef | undefined = own(STAND_INS, id);
  if (def === undefined || seen.includes(id)) return null;
  const own_ = roles.paletteTheme(theme);
  const viaRoles = fromRoles(roles, theme, def);
  let source: StandInSource = "role";
  let found = viaRoles.pieces;
  let role = viaRoles.role;
  if (found.length === 0 && def.kit === true) return null;
  if (found.length === 0) {
    const pool = roles.pool(theme, { ...def.shape, ...(def.families ? { families: def.families } : {}) });
    found = pool.pieces.map((p) => fromPool(pool, p));
    role = pool.pieces[0]?.roles[0] ?? "";
    source = "pool";
  }
  if (found.length === 0) {
    if (def.simplify === undefined) return null;
    const plainer = findStandIn(roles, theme, def.simplify as StandInId, [...seen, id]);
    return plainer ? { ...plainer, simplifiedFrom: plainer.simplifiedFrom ?? id } : null;
  }
  const r = ranked(found, def);
  return {
    id,
    pieces: r.pieces,
    near: r.near,
    source,
    role,
    borrowed: r.pieces.some((p) => p.palette !== own_),
  };
}
