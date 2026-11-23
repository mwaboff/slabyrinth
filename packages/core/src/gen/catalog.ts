/**
 * Built-in feature facts: default footprint, blocking, organic (random rotation), wall-mounted, category (for the
 * "Furniture" layer toggle), GM-only defaults, and the traits the generators read (light source, landmark, the light
 * its top takes). One row per type: a trait is a field here, never a list of types in the code that reads it.
 * Palettes may use other asset sizes; the resolver's footprint is what validation and the 2D view use.
 */
import type { FeatureType } from "../contracts/plan";

export type FeatureCategory = "furniture" | "architecture" | "outdoor" | "hazard" | "other";

export interface FeatureInfo {
  size: readonly [w: number, h: number];
  blocking: boolean;
  organic: boolean;
  wallMounted: boolean;
  category: FeatureCategory;
  gmOnly: boolean;
  /** Human label (legend, tooltips, ASCII legend). */
  label: string;
  /**
   * Existing feature type whose 2D glyph stands in for this one until it has its own painter, so the preview
   * never falls back to the "?" custom glyph for a real feature type. Unset: the type has its own glyph.
   */
  glyph?: FeatureType;
  /** Light source: it lights the cells round it (LIGHT_FEATURES; the lighting passes and the review count it). */
  light?: boolean;
  /**
   * Generator 5 (sensibleLights): an open fire standing on a floor (a brazier, a floor torch, a camp fire): it belongs
   * only in a room whose kind takes fire (gen/roomTraits.ts `fire`: a hearth, a forge, a guard room, a hall, an altar).
   */
  openFire?: boolean;
  /**
   * A statement piece that gives the map its skyline: one per dress op with a clear ring round it (gen/setpieces.ts),
   * its cells marked so other dressing keeps an apron off it (resolve/level/features.ts), and a note when its asset
   * stands under 3 tiles (compile/realize/features.ts).
   */
  landmark?: boolean;
  /**
   * A support whose top takes a light (gen/rooms4.ts room lights): a candle where a flame at hand height belongs (a
   * table, a desk, an altar), a small lantern on a counter or chest. Unset: nothing is lit on it.
   */
  topLight?: "candle" | "lantern";
  /** Hung from the ceiling: raised on purpose, so verify never calls it floating (compile/verify/props.ts). */
  ceilingMounted?: boolean;
  /**
   * A column that carries a hall (a pillar, a rock column, a timber support): a hall with columns reads full with few
   * props, so the review by room kind does not call it bare (review/interiors.ts).
   */
  carriesHall?: boolean;
  /**
   * A piece of a cliff's rock band (generator 2): placed along a rise by gen/cliffband.ts, built and rested by the
   * band passes, measured by verify's and the review's cliff checks.
   */
  bandRock?: boolean;
  /**
   * Litters or wears the ground round it, so a caused floor family (leaf litter, worn earth) grows there: "litter" for
   * trees and camps (every generator with caused families), "wear" for the places people gather round (generator 3's
   * floor families, resolve/floorFamilies.ts).
   */
  groundCause?: "litter" | "wear";
  /** Strewn on the floor (debris, bones, webs): mess, not what furnishes a room (review/interiors.ts). */
  strewn?: boolean;
  /** Its crown or mass overhangs its cell: a composed set piece keeps it one cell inside the board (gen/setpieces.ts). */
  overhangs?: boolean;
  /** Upright: a run of them in single file reads as a fence, so the set-piece composer breaks such a run up. */
  upright?: boolean;
  /**
   * A focal point: a natural trail's spur leads to the first "primary" piece on the level, else to a "lesser" one
   * (resolve/level/paths.ts), and a lit place lights it (gen/setpieces.ts).
   */
  focal?: "primary" | "lesser";
  /** Something to sit on: the playability check wants it beside a table it is near (`seatsAt`). */
  seat?: boolean;
  /** A top people sit at (a table, a counter, a stall): a seat near it should touch it. */
  seatsAt?: boolean;
  /** Stands against a wall (a shelf, a wardrobe): the playability check warns when one stands in the open. */
  wallHugger?: boolean;
  /**
   * A top a small thing rests on, lifted to the height of the lowest of its variants (PaletteView.pieceSize real;
   * gen/place.ts toppers, gen/setpieces.ts `Part.on`).
   */
  support?: boolean;
  /** Scatters in clumps, a seed placement and one or two neighbours (gen/place.ts scatter). */
  clusters?: boolean;
  /** A small thing on a surface (clutter, goods): built from the small-things roles (gen/surfaces.ts featureRoles). */
  smallThing?: boolean;
  /** Natural growth or rock: it should cluster, never stand in rows (the review's natural checks). */
  natural?: boolean;
  /** A growing thing: what relieves a built place (the review). */
  growth?: boolean;
  /** Makes natural ground read as covered from above: trees, tall growth, rock formations (the review). */
  cover?: boolean;
  /** A small ground piece: on a dense lattice it lines up by chance, so its rows must be longer to count (the review). */
  groundSmall?: boolean;
  /** Parked in the carriageway, never on the pavement or a crossing (the review's street check). */
  road?: boolean;
  /** Its repetition shows (vehicles, statues, landmark-class pieces, signs): the review counts identical ones. */
  repeatShows?: boolean;
  /** Can be the focal point of a place (the review's focus checks; `focal` is what a trail leads to). */
  focusPiece?: boolean;
  /** A focal piece that should have a light near it (the review's focal_unlit). */
  wantsLight?: boolean;
  /** Upright pieces whose assets are mixed along a run (compile/realize/features.ts). */
  runMix?: boolean;
  /** Loose rock that takes the tone of a cliff beside it (generator 3, compile/realize/features.ts). */
  cliffDressing?: boolean;
  /** A natural standing piece never built from wall blocks (generator 3, compile/realize/features.ts). */
  naturalStanding?: boolean;
}

type FeatureOpts = Partial<Omit<FeatureInfo, "label" | "category">>;

const F = (label: string, category: FeatureCategory, opts: FeatureOpts = {}): FeatureInfo => {
  const { size, blocking, organic, wallMounted, gmOnly, ...traits } = opts;
  // an optional trait is present only where it says something (no `false` or `undefined` keys on the row)
  const said = Object.fromEntries(Object.entries(traits).filter(([, v]) => Boolean(v)));
  return {
    ...said,
    size: size ?? [1, 1],
    blocking: blocking ?? true,
    organic: organic ?? false,
    wallMounted: wallMounted ?? false,
    gmOnly: gmOnly ?? false,
    category,
    label,
  };
};

export const FEATURE_INFO: Record<FeatureType, FeatureInfo> = {
  table: F("Table", "furniture", { size: [2, 1], topLight: "candle", seatsAt: true, support: true }),
  round_table: F("Round table", "furniture", { topLight: "candle", seatsAt: true, support: true }),
  chair: F("Chair", "furniture", { seat: true }),
  bench: F("Bench", "furniture", { size: [2, 1], seat: true }),
  stool: F("Stool", "furniture", { seat: true }),
  bed: F("Bed", "furniture", { size: [1, 2] }),
  bunk_bed: F("Bunk bed", "furniture", { size: [1, 2] }),
  wardrobe: F("Wardrobe", "furniture", { wallHugger: true }),
  bookshelf: F("Bookshelf", "furniture", { size: [2, 1], wallHugger: true }),
  desk: F("Desk", "furniture", { size: [2, 1], topLight: "candle", seatsAt: true, support: true }),
  chest: F("Chest", "furniture", { topLight: "lantern", support: true }),
  barrel: F("Barrel", "furniture"),
  crate: F("Crate", "furniture"),
  sack: F("Sack", "furniture"),
  shelf: F("Shelf", "furniture", { size: [2, 1], wallHugger: true }),
  counter: F("Counter", "furniture", { size: [2, 1], topLight: "lantern", seatsAt: true, support: true }),
  bar_counter: F("Bar counter", "furniture", { size: [3, 1], topLight: "candle", seatsAt: true }),
  throne: F("Throne", "furniture", { focusPiece: true, wantsLight: true }),
  rug: F("Rug", "furniture", { size: [2, 2], blocking: false }),
  cauldron: F("Cauldron", "furniture"),
  anvil: F("Anvil", "furniture"),
  forge: F("Forge", "furniture", { size: [2, 1] }),
  weapon_rack: F("Weapon rack", "furniture", { wallHugger: true }),
  armor_stand: F("Armour stand", "furniture"),
  cage: F("Cage", "furniture"),
  stocks: F("Stocks", "furniture"),
  pillar: F("Pillar", "architecture", { carriesHall: true }),
  statue: F("Statue", "architecture", {
    groundCause: "wear",
    focal: "lesser",
    repeatShows: true,
    focusPiece: true,
    wantsLight: true,
  }),
  altar: F("Altar", "architecture", {
    size: [2, 1],
    topLight: "candle",
    groundCause: "wear",
    focal: "lesser",
    focusPiece: true,
    wantsLight: true,
  }),
  fountain: F("Fountain", "architecture", {
    size: [2, 2],
    groundCause: "wear",
    focal: "lesser",
    repeatShows: true,
    focusPiece: true,
    wantsLight: true,
  }),
  well: F("Well", "architecture", {
    groundCause: "wear",
    focal: "lesser",
    repeatShows: true,
    focusPiece: true,
    wantsLight: true,
  }),
  brazier: F("Brazier", "architecture", { light: true, openFire: true }),
  torch_wall: F("Wall torch", "architecture", { blocking: false, wallMounted: true, light: true }),
  candelabra: F("Candelabra", "furniture", { light: true }),
  banner_wall: F("Banner", "architecture", { blocking: false, wallMounted: true }),
  painting_wall: F("Painting", "architecture", { blocking: false, wallMounted: true }),
  sarcophagus: F("Sarcophagus", "architecture", { size: [1, 2] }),
  coffin: F("Coffin", "furniture", { size: [1, 2] }),
  tomb: F("Tomb", "architecture", { size: [1, 2] }),
  bones: F("Bones", "other", { blocking: false, organic: true, strewn: true }),
  rubble: F("Rubble", "other", { organic: true, strewn: true }),
  web: F("Web", "other", { blocking: false, organic: true, strewn: true }),
  debris: F("Debris", "other", { blocking: false, organic: true, strewn: true }),
  pool: F("Pool", "architecture", { size: [2, 2] }),
  lever: F("Lever", "hazard", { blocking: false }),
  trap: F("Trap", "hazard", { blocking: false, gmOnly: true }),
  trap_plate: F("Pressure plate", "hazard", { blocking: false, gmOnly: true }),
  chandelier: F("Chandelier", "furniture", { blocking: false, light: true, ceilingMounted: true }),
  tree: F("Tree", "outdoor", {
    organic: true,
    groundCause: "litter",
    overhangs: true,
    upright: true,
    natural: true,
    growth: true,
    cover: true,
    runMix: true,
  }),
  dead_tree: F("Dead tree", "outdoor", {
    organic: true,
    groundCause: "litter",
    overhangs: true,
    upright: true,
    natural: true,
    growth: true,
    cover: true,
    runMix: true,
  }),
  pine_tree: F("Pine", "outdoor", {
    organic: true,
    groundCause: "litter",
    overhangs: true,
    upright: true,
    natural: true,
    growth: true,
    cover: true,
    runMix: true,
  }),
  bush: F("Bush", "outdoor", { organic: true, natural: true, growth: true, cover: true }),
  rock: F("Rock", "outdoor", { organic: true, upright: true, natural: true, cliffDressing: true }),
  boulder: F("Boulder", "outdoor", {
    organic: true,
    upright: true,
    support: true,
    natural: true,
    cover: true,
    runMix: true,
    cliffDressing: true,
  }),
  stump: F("Stump", "outdoor", { organic: true, natural: true }),
  log: F("Log", "outdoor", { size: [2, 1], organic: true, natural: true }),
  mushroom: F("Mushrooms", "outdoor", { organic: true, blocking: false, natural: true, groundSmall: true }),
  flowers: F("Flowers", "outdoor", {
    blocking: false,
    organic: true,
    natural: true,
    growth: true,
    groundSmall: true,
  }),
  tall_grass: F("Tall grass", "outdoor", {
    blocking: false,
    organic: true,
    natural: true,
    growth: true,
    groundSmall: true,
  }),
  reeds: F("Reeds", "outdoor", {
    blocking: false,
    organic: true,
    natural: true,
    growth: true,
    groundSmall: true,
  }),
  campfire: F("Campfire", "outdoor", {
    light: true,
    openFire: true,
    groundCause: "litter",
    focal: "lesser",
    focusPiece: true,
  }),
  tent: F("Tent", "outdoor", { size: [2, 2], groundCause: "litter", repeatShows: true }),
  cart: F("Cart", "outdoor", { size: [2, 1], road: true, repeatShows: true }),
  wagon: F("Wagon", "outdoor", { size: [3, 2], road: true, repeatShows: true }),
  fence_post: F("Fence post", "outdoor"),
  signpost: F("Signpost", "outdoor"),
  standing_stone: F("Standing stone", "outdoor", {
    organic: true,
    upright: true,
    focal: "lesser",
    natural: true,
    focusPiece: true,
    wantsLight: true,
    runMix: true,
  }),
  grave: F("Grave", "outdoor", { size: [1, 2] }),
  // caves and set dressing
  stalagmite: F("Stalagmite", "outdoor", {
    organic: true,
    glyph: "rock",
    upright: true,
    clusters: true,
    natural: true,
    cover: true,
    runMix: true,
  }),
  stalactite: F("Stalactite", "outdoor", {
    organic: true,
    blocking: false,
    ceilingMounted: true,
    glyph: "debris",
    clusters: true,
  }),
  rock_formation: F("Rock formation", "outdoor", {
    size: [2, 2],
    organic: true,
    glyph: "boulder",
    natural: true,
    cover: true,
    cliffDressing: true,
    naturalStanding: true,
  }),
  cave_in: F("Cave-in", "hazard", { size: [2, 2], organic: true, strewn: true, glyph: "rubble" }),
  crystal: F("Crystals", "outdoor", {
    organic: true,
    light: true,
    glyph: "rock",
    clusters: true,
    natural: true,
  }),
  giant_mushroom: F("Giant mushroom", "outdoor", {
    organic: true,
    glyph: "mushroom",
    focal: "primary",
    clusters: true,
    natural: true,
    cover: true,
    repeatShows: true,
    focusPiece: true,
  }),
  root: F("Roots", "outdoor", { organic: true, blocking: false, glyph: "dead_tree", clusters: true }),
  root_large: F("Great root", "outdoor", { size: [2, 1], organic: true, glyph: "log" }),
  roots_wall: F("Wall roots", "outdoor", { blocking: false, wallMounted: true, glyph: "dead_tree" }),
  vines: F("Vines", "outdoor", { blocking: false, wallMounted: true, glyph: "tall_grass", growth: true }),
  tree_large: F("Great tree", "outdoor", {
    size: [3, 3],
    organic: true,
    landmark: true,
    groundCause: "litter",
    glyph: "dead_tree",
    overhangs: true,
    focal: "primary",
    natural: true,
    growth: true,
    cover: true,
    repeatShows: true,
    focusPiece: true,
  }),
  // ritual, encounter and lights
  candles: F("Candles", "furniture", { blocking: false, light: true, glyph: "candelabra", clusters: true }),
  skull_pile: F("Skulls", "other", {
    blocking: false,
    organic: true,
    strewn: true,
    glyph: "bones",
    clusters: true,
  }),
  spawn_point: F("Spawn point", "hazard", { blocking: false, gmOnly: true, glyph: "trap_plate" }),
  torch_floor: F("Floor torch", "architecture", { light: true, openFire: true, glyph: "brazier" }),
  lantern: F("Lantern", "architecture", { light: true, glyph: "brazier" }),
  magic_fire: F("Magic fire", "architecture", { light: true, glyph: "campfire", focusPiece: true }),
  lava_glow: F("Lava glow", "hazard", { blocking: false, light: true, openFire: true, glyph: "brazier" }),
  fire_pit: F("Fire pit", "outdoor", {
    light: true,
    openFire: true,
    groundCause: "litter",
    glyph: "campfire",
    focal: "lesser",
    focusPiece: true,
  }),
  // tall pieces, mining and hanging dressing
  monolith: F("Monolith", "architecture", {
    groundCause: "wear",
    glyph: "standing_stone",
    upright: true,
    focal: "primary",
    repeatShows: true,
    focusPiece: true,
    wantsLight: true,
    runMix: true,
  }),
  cave_column: F("Rock column", "outdoor", {
    organic: true,
    glyph: "pillar",
    focusPiece: true,
    carriesHall: true,
  }),
  statue_large: F("Great statue", "architecture", {
    size: [2, 2],
    landmark: true,
    glyph: "statue",
    overhangs: true,
    focal: "primary",
    repeatShows: true,
    focusPiece: true,
    wantsLight: true,
  }),
  mine_cart: F("Mine cart", "furniture", { glyph: "crate" }),
  rails: F("Rails", "architecture", { blocking: false, glyph: "debris" }),
  mine_support: F("Timber support", "architecture", { glyph: "pillar", carriesHall: true }),
  chains: F("Hanging chains", "other", { blocking: false, wallMounted: true, glyph: "banner_wall" }),
  // theme-neutral slots: each theme's palette (feature.<slot>) decides the assets, e.g. cluster_tall is
  // stalagmite columns in a cave, pines in a forest and stone columns in a dungeon
  landmark: F("Landmark", "architecture", {
    size: [2, 2],
    landmark: true,
    glyph: "statue",
    overhangs: true,
    focal: "primary",
    repeatShows: true,
    focusPiece: true,
    wantsLight: true,
    naturalStanding: true,
  }),
  tall_marker: F("Tall marker", "architecture", {
    glyph: "standing_stone",
    upright: true,
    focal: "lesser",
    focusPiece: true,
    wantsLight: true,
    naturalStanding: true,
  }),
  formation: F("Formation", "outdoor", {
    size: [2, 2],
    organic: true,
    glyph: "boulder",
    overhangs: true,
    upright: true,
    natural: true,
    cover: true,
    runMix: true,
    cliffDressing: true,
    naturalStanding: true,
  }),
  cluster_tall: F("Tall growth", "outdoor", {
    organic: true,
    groundCause: "litter",
    glyph: "pine_tree",
    overhangs: true,
    upright: true,
    natural: true,
    growth: true,
    cover: true,
    runMix: true,
    naturalStanding: true,
  }),
  undergrowth: F("Undergrowth", "outdoor", {
    organic: true,
    blocking: false,
    glyph: "bush",
    natural: true,
    growth: true,
    runMix: true,
  }),
  ground_cover: F("Ground cover", "outdoor", {
    organic: true,
    blocking: false,
    glyph: "tall_grass",
    natural: true,
    groundSmall: true,
  }),
  accent_light: F("Accent light", "architecture", { light: true, glyph: "brazier" }),
  edge_dressing: F("Edge dressing", "outdoor", { organic: true, glyph: "rock", upright: true, runMix: true }),
  small_detail: F("Small detail", "other", { organic: true, blocking: false, glyph: "debris" }),
  wall_dressing: F("Wall dressing", "other", { blocking: false, wallMounted: true, glyph: "banner_wall" }),
  // water's edge: reeds, lily pads, river stones, driftwood along banks; a small jetty
  bank_dressing: F("Bank dressing", "outdoor", { organic: true, blocking: false, glyph: "reeds" }),
  jetty: F("Jetty", "architecture", { size: [2, 1], blocking: false, glyph: "bench" }),
  // built places: parked along a road edge (cart, wagon, car), seating, a sign on a frontage
  vehicle: F("Vehicle", "outdoor", {
    size: [3, 2],
    glyph: "wagon",
    road: true,
    repeatShows: true,
    runMix: true,
  }),
  seating: F("Seating", "furniture", { size: [2, 1], glyph: "bench", seat: true }),
  signage: F("Signage", "architecture", {
    blocking: false,
    wallMounted: true,
    glyph: "banner_wall",
    repeatShows: true,
  }),
  // cliffs as rock bands: pieces of the band along a rise (sizes here are the cell footprint; the palette's asset
  // sets the real size)
  cliff_face: F("Cliff rock", "outdoor", { size: [4, 2], organic: true, bandRock: true, glyph: "boulder" }),
  cliff_crest: F("Crest boulder", "outdoor", {
    size: [2, 2],
    organic: true,
    bandRock: true,
    glyph: "boulder",
  }),
  // markets (generator 3): a stall (2 wide by default), goods standing on it, the pieces of an overhead line
  stall: F("Market stall", "furniture", { size: [2, 1], glyph: "counter", seatsAt: true, support: true }),
  goods: F("Goods", "other", { blocking: false, glyph: "sack", smallThing: true }),
  overhead: F("Overhead line", "other", { blocking: false, glyph: "banner_wall" }),
  line_post: F("Line post", "architecture", { glyph: "fence_post" }),
  // interiors (generator 4): small things on furniture and the shelf plank they stand on
  clutter: F("Clutter", "other", { blocking: false, glyph: "debris", smallThing: true }),
  shelf_line: F("Shelf", "other", { blocking: false, wallMounted: true, glyph: "banner_wall" }),
  custom: F("Custom", "other"),
};

/** Light-source feature types (`light` in the table). */
export const LIGHT_FEATURES: ReadonlySet<FeatureType> = new Set<FeatureType>(
  (Object.keys(FEATURE_INFO) as FeatureType[]).filter((t) => FEATURE_INFO[t].light === true),
);

/** The feature types whose row passes `test`, in catalog order. */
export function typesWith(test: (info: FeatureInfo) => boolean): FeatureType[] {
  return (Object.keys(FEATURE_INFO) as FeatureType[]).filter((t) => test(FEATURE_INFO[t]));
}

/**
 * A trait plus a frozen delta: the list a released generator read before the trait existed, stated as what it adds to
 * and takes from the trait, so the list cannot drift from the table unseen (test/unit/gen/catalogTraits.test.ts pins
 * each delta and says why it stays).
 */
export function traitWithDelta(
  base: (f: FeatureInfo) => boolean,
  delta: { readonly plus: readonly FeatureType[]; readonly minus: readonly FeatureType[] },
): ReadonlySet<FeatureType> {
  return new Set([...typesWith(base).filter((t) => !delta.minus.includes(t)), ...delta.plus]);
}

/** Is the type a landmark (`landmark` in the table)? */
export function isLandmark(type: FeatureType): boolean {
  return FEATURE_INFO[type].landmark === true;
}

/** Is the type a piece of a cliff's rock band (`bandRock` in the table)? */
export function isBandRock(type: FeatureType): boolean {
  return FEATURE_INFO[type].bandRock === true;
}

/** The feature type whose 2D glyph draws `type`: itself, unless the catalog names a stand-in. */
export function glyphType(type: FeatureType): FeatureType {
  return FEATURE_INFO[type].glyph ?? type;
}

export function featureInfo(type: FeatureType): FeatureInfo {
  return FEATURE_INFO[type];
}

/** Footprint after rotation: 90/270 swap w and h. */
export function rotatedSize(size: readonly [number, number], rot: number): [number, number] {
  const r = ((rot % 360) + 360) % 360;
  return r === 90 || r === 270 ? [size[1], size[0]] : [size[0], size[1]];
}
