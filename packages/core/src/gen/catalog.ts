/**
 * Built-in feature facts the resolver needs: default footprint, blocking, organic (random rotation), wall-mounted,
 * category (for the "Furniture" layer toggle) and GM-only defaults. Palettes may use other asset sizes; the
 * resolver's footprint is what validation and the 2D view use.
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
}

const F = (
  label: string,
  category: FeatureCategory,
  opts: Partial<Omit<FeatureInfo, "label" | "category">> = {},
): FeatureInfo => ({
  size: opts.size ?? [1, 1],
  blocking: opts.blocking ?? true,
  organic: opts.organic ?? false,
  wallMounted: opts.wallMounted ?? false,
  gmOnly: opts.gmOnly ?? false,
  category,
  label,
});

export const FEATURE_INFO: Record<FeatureType, FeatureInfo> = {
  table: F("Table", "furniture", { size: [2, 1] }),
  round_table: F("Round table", "furniture"),
  chair: F("Chair", "furniture"),
  bench: F("Bench", "furniture", { size: [2, 1] }),
  stool: F("Stool", "furniture"),
  bed: F("Bed", "furniture", { size: [1, 2] }),
  bunk_bed: F("Bunk bed", "furniture", { size: [1, 2] }),
  wardrobe: F("Wardrobe", "furniture"),
  bookshelf: F("Bookshelf", "furniture", { size: [2, 1] }),
  desk: F("Desk", "furniture", { size: [2, 1] }),
  chest: F("Chest", "furniture"),
  barrel: F("Barrel", "furniture"),
  crate: F("Crate", "furniture"),
  sack: F("Sack", "furniture"),
  shelf: F("Shelf", "furniture", { size: [2, 1] }),
  counter: F("Counter", "furniture", { size: [2, 1] }),
  bar_counter: F("Bar counter", "furniture", { size: [3, 1] }),
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
  altar: F("Altar", "architecture", { size: [2, 1] }),
  fountain: F("Fountain", "architecture", { size: [2, 2] }),
  well: F("Well", "architecture"),
  brazier: F("Brazier", "architecture"),
  torch_wall: F("Wall torch", "architecture", { blocking: false, wallMounted: true }),
  candelabra: F("Candelabra", "furniture"),
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
  chandelier: F("Chandelier", "furniture", { blocking: false }),
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
  campfire: F("Campfire", "outdoor"),
  tent: F("Tent", "outdoor", { size: [2, 2] }),
  cart: F("Cart", "outdoor", { size: [2, 1] }),
  wagon: F("Wagon", "outdoor", { size: [3, 2] }),
  fence_post: F("Fence post", "outdoor"),
  signpost: F("Signpost", "outdoor"),
  standing_stone: F("Standing stone", "outdoor", { organic: true }),
  grave: F("Grave", "outdoor", { size: [1, 2] }),
  custom: F("Custom", "other"),
};

export function featureInfo(type: FeatureType): FeatureInfo {
  return FEATURE_INFO[type];
}

/** Footprint after rotation: 90/270 swap w and h. */
export function rotatedSize(size: readonly [number, number], rot: number): [number, number] {
  const r = ((rot % 360) + 360) % 360;
  return r === 90 || r === 270 ? [size[1], size[0]] : [size[0], size[1]];
}
