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
}

const F = (
  label: string,
  category: FeatureCategory,
  opts: Partial<Omit<FeatureInfo, "label" | "category">> = {},
): FeatureInfo => ({
  ...(opts.glyph ? { glyph: opts.glyph } : {}),
  ...(opts.light ? { light: true } : {}),
  ...(opts.landmark ? { landmark: true } : {}),
  ...(opts.topLight ? { topLight: opts.topLight } : {}),
  size: opts.size ?? [1, 1],
  blocking: opts.blocking ?? true,
  organic: opts.organic ?? false,
  wallMounted: opts.wallMounted ?? false,
  gmOnly: opts.gmOnly ?? false,
  category,
  label,
});

export const FEATURE_INFO: Record<FeatureType, FeatureInfo> = {
  table: F("Table", "furniture", { size: [2, 1], topLight: "candle" }),
  round_table: F("Round table", "furniture", { topLight: "candle" }),
  chair: F("Chair", "furniture"),
  bench: F("Bench", "furniture", { size: [2, 1] }),
  stool: F("Stool", "furniture"),
  bed: F("Bed", "furniture", { size: [1, 2] }),
  bunk_bed: F("Bunk bed", "furniture", { size: [1, 2] }),
  wardrobe: F("Wardrobe", "furniture"),
  bookshelf: F("Bookshelf", "furniture", { size: [2, 1] }),
  desk: F("Desk", "furniture", { size: [2, 1], topLight: "candle" }),
  chest: F("Chest", "furniture", { topLight: "lantern" }),
  barrel: F("Barrel", "furniture"),
  crate: F("Crate", "furniture"),
  sack: F("Sack", "furniture"),
  shelf: F("Shelf", "furniture", { size: [2, 1] }),
  counter: F("Counter", "furniture", { size: [2, 1], topLight: "lantern" }),
  bar_counter: F("Bar counter", "furniture", { size: [3, 1], topLight: "candle" }),
  throne: F("Throne", "furniture"),
  rug: F("Rug", "furniture", { size: [2, 2], blocking: false }),
  cauldron: F("Cauldron", "furniture"),
  anvil: F("Anvil", "furniture"),
  forge: F("Forge", "furniture", { size: [2, 1] }),
  weapon_rack: F("Weapon rack", "furniture"),
  armor_stand: F("Armour stand", "furniture"),
  cage: F("Cage", "furniture"),
  stocks: F("Stocks", "furniture"),
  pillar: F("Pillar", "architecture"),
  statue: F("Statue", "architecture"),
  altar: F("Altar", "architecture", { size: [2, 1], topLight: "candle" }),
  fountain: F("Fountain", "architecture", { size: [2, 2] }),
  well: F("Well", "architecture"),
  brazier: F("Brazier", "architecture", { light: true }),
  torch_wall: F("Wall torch", "architecture", { blocking: false, wallMounted: true, light: true }),
  candelabra: F("Candelabra", "furniture", { light: true }),
  banner_wall: F("Banner", "architecture", { blocking: false, wallMounted: true }),
  painting_wall: F("Painting", "architecture", { blocking: false, wallMounted: true }),
  sarcophagus: F("Sarcophagus", "architecture", { size: [1, 2] }),
  coffin: F("Coffin", "furniture", { size: [1, 2] }),
  tomb: F("Tomb", "architecture", { size: [1, 2] }),
  bones: F("Bones", "other", { blocking: false, organic: true }),
  rubble: F("Rubble", "other", { organic: true }),
  web: F("Web", "other", { blocking: false, organic: true }),
  debris: F("Debris", "other", { blocking: false, organic: true }),
  pool: F("Pool", "architecture", { size: [2, 2] }),
  lever: F("Lever", "hazard", { blocking: false }),
  trap: F("Trap", "hazard", { blocking: false, gmOnly: true }),
  trap_plate: F("Pressure plate", "hazard", { blocking: false, gmOnly: true }),
  chandelier: F("Chandelier", "furniture", { blocking: false, light: true }),
  tree: F("Tree", "outdoor", { organic: true }),
  dead_tree: F("Dead tree", "outdoor", { organic: true }),
  pine_tree: F("Pine", "outdoor", { organic: true }),
  bush: F("Bush", "outdoor", { organic: true }),
  rock: F("Rock", "outdoor", { organic: true }),
  boulder: F("Boulder", "outdoor", { organic: true }),
  stump: F("Stump", "outdoor", { organic: true }),
  log: F("Log", "outdoor", { size: [2, 1], organic: true }),
  mushroom: F("Mushrooms", "outdoor", { organic: true, blocking: false }),
  flowers: F("Flowers", "outdoor", { blocking: false, organic: true }),
  tall_grass: F("Tall grass", "outdoor", { blocking: false, organic: true }),
  reeds: F("Reeds", "outdoor", { blocking: false, organic: true }),
  campfire: F("Campfire", "outdoor", { light: true }),
  tent: F("Tent", "outdoor", { size: [2, 2] }),
  cart: F("Cart", "outdoor", { size: [2, 1] }),
  wagon: F("Wagon", "outdoor", { size: [3, 2] }),
  fence_post: F("Fence post", "outdoor"),
  signpost: F("Signpost", "outdoor"),
  standing_stone: F("Standing stone", "outdoor", { organic: true }),
  grave: F("Grave", "outdoor", { size: [1, 2] }),
  // caves and set dressing
  stalagmite: F("Stalagmite", "outdoor", { organic: true, glyph: "rock" }),
  stalactite: F("Stalactite", "outdoor", { organic: true, blocking: false, glyph: "debris" }),
  rock_formation: F("Rock formation", "outdoor", { size: [2, 2], organic: true, glyph: "boulder" }),
  cave_in: F("Cave-in", "hazard", { size: [2, 2], organic: true, glyph: "rubble" }),
  crystal: F("Crystals", "outdoor", { organic: true, light: true, glyph: "rock" }),
  giant_mushroom: F("Giant mushroom", "outdoor", { organic: true, glyph: "mushroom" }),
  root: F("Roots", "outdoor", { organic: true, blocking: false, glyph: "dead_tree" }),
  root_large: F("Great root", "outdoor", { size: [2, 1], organic: true, glyph: "log" }),
  roots_wall: F("Wall roots", "outdoor", { blocking: false, wallMounted: true, glyph: "dead_tree" }),
  vines: F("Vines", "outdoor", { blocking: false, wallMounted: true, glyph: "tall_grass" }),
  tree_large: F("Great tree", "outdoor", { size: [3, 3], organic: true, landmark: true, glyph: "dead_tree" }),
  // ritual, encounter and lights
  candles: F("Candles", "furniture", { blocking: false, light: true, glyph: "candelabra" }),
  skull_pile: F("Skulls", "other", { blocking: false, organic: true, glyph: "bones" }),
  spawn_point: F("Spawn point", "hazard", { blocking: false, gmOnly: true, glyph: "trap_plate" }),
  torch_floor: F("Floor torch", "architecture", { light: true, glyph: "brazier" }),
  lantern: F("Lantern", "architecture", { light: true, glyph: "brazier" }),
  magic_fire: F("Magic fire", "architecture", { light: true, glyph: "campfire" }),
  lava_glow: F("Lava glow", "hazard", { blocking: false, light: true, glyph: "brazier" }),
  fire_pit: F("Fire pit", "outdoor", { light: true, glyph: "campfire" }),
  // tall pieces, mining and hanging dressing
  monolith: F("Monolith", "architecture", { glyph: "standing_stone" }),
  cave_column: F("Rock column", "outdoor", { organic: true, glyph: "pillar" }),
  statue_large: F("Great statue", "architecture", { size: [2, 2], landmark: true, glyph: "statue" }),
  mine_cart: F("Mine cart", "furniture", { glyph: "crate" }),
  rails: F("Rails", "architecture", { blocking: false, glyph: "debris" }),
  mine_support: F("Timber support", "architecture", { glyph: "pillar" }),
  chains: F("Hanging chains", "other", { blocking: false, wallMounted: true, glyph: "banner_wall" }),
  // theme-neutral slots: each theme's palette (feature.<slot>) decides the assets, e.g. cluster_tall is
  // stalagmite columns in a cave, pines in a forest and stone columns in a dungeon
  landmark: F("Landmark", "architecture", { size: [2, 2], landmark: true, glyph: "statue" }),
  tall_marker: F("Tall marker", "architecture", { glyph: "standing_stone" }),
  formation: F("Formation", "outdoor", { size: [2, 2], organic: true, glyph: "boulder" }),
  cluster_tall: F("Tall growth", "outdoor", { organic: true, glyph: "pine_tree" }),
  undergrowth: F("Undergrowth", "outdoor", { organic: true, blocking: false, glyph: "bush" }),
  ground_cover: F("Ground cover", "outdoor", { organic: true, blocking: false, glyph: "tall_grass" }),
  accent_light: F("Accent light", "architecture", { light: true, glyph: "brazier" }),
  edge_dressing: F("Edge dressing", "outdoor", { organic: true, glyph: "rock" }),
  small_detail: F("Small detail", "other", { organic: true, blocking: false, glyph: "debris" }),
  wall_dressing: F("Wall dressing", "other", { blocking: false, wallMounted: true, glyph: "banner_wall" }),
  // water's edge: reeds, lily pads, river stones, driftwood along banks; a small jetty
  bank_dressing: F("Bank dressing", "outdoor", { organic: true, blocking: false, glyph: "reeds" }),
  jetty: F("Jetty", "architecture", { size: [2, 1], blocking: false, glyph: "bench" }),
  // built places: parked along a road edge (cart, wagon, car), seating, a sign on a frontage
  vehicle: F("Vehicle", "outdoor", { size: [3, 2], glyph: "wagon" }),
  seating: F("Seating", "furniture", { size: [2, 1], glyph: "bench" }),
  signage: F("Signage", "architecture", { blocking: false, wallMounted: true, glyph: "banner_wall" }),
  // cliffs as rock bands: pieces of the band along a rise (sizes here are the cell footprint; the palette's asset
  // sets the real size)
  cliff_face: F("Cliff rock", "outdoor", { size: [4, 2], organic: true, glyph: "boulder" }),
  cliff_crest: F("Crest boulder", "outdoor", { size: [2, 2], organic: true, glyph: "boulder" }),
  // markets (generator 3): a stall (2 wide by default), goods standing on it, the pieces of an overhead line
  stall: F("Market stall", "furniture", { size: [2, 1], glyph: "counter" }),
  goods: F("Goods", "other", { blocking: false, glyph: "sack" }),
  overhead: F("Overhead line", "other", { blocking: false, glyph: "banner_wall" }),
  line_post: F("Line post", "architecture", { glyph: "fence_post" }),
  // interiors (generator 4): small things on furniture and the shelf plank they stand on
  clutter: F("Clutter", "other", { blocking: false, glyph: "debris" }),
  shelf_line: F("Shelf", "other", { blocking: false, wallMounted: true, glyph: "banner_wall" }),
  custom: F("Custom", "other"),
};

/** Light-source feature types (`light` in the table). */
export const LIGHT_FEATURES: ReadonlySet<FeatureType> = new Set<FeatureType>(
  (Object.keys(FEATURE_INFO) as FeatureType[]).filter((t) => FEATURE_INFO[t].light === true),
);

/** Is the type a landmark (`landmark` in the table)? */
export function isLandmark(type: FeatureType): boolean {
  return FEATURE_INFO[type].landmark === true;
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
