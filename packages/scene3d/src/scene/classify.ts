/**
 * What a placed piece is: the one classifier of the scene, read by its colour (scene/colour.ts) and by the checks
 * (checks/pieces.ts: what carries, what is ground, what is organic). The class comes from what the build and the game
 * already say, never from words in a piece's name:
 *
 * 1. the placement's role and paste layer, and the material of the cell it came from;
 * 2. the palette roles that list the asset (core palette/roles.ts families; a feature role through the feature table,
 *    gen/catalog.ts: a light, organic dressing), and the catalog's own classification of it (catalog/classify.ts);
 * 3. the catalog's coarse form of the piece (its group tag, an exact value, not a word search);
 * 4. what core measured of the piece (gen/pieceFacts.ts: it throws light, it is grown over);
 * 5. its shape (core palette/traits.ts): a tile lying flat (a slab) is a floor, any other tile built structure (a
 *    wall); a prop tall by core's size classes
 *    (catalog/classify.ts `sizeClass`) is a tall prop, else a prop.
 */
import {
  FEATURE_INFO,
  materialInfo,
  pieceFacts,
  roleFamily,
  sizeClass,
  traitsOf,
  type Material,
  type PlacementRole,
} from "@slabyrinth/core";
import type { ColourClass, PieceGeom } from "../types/index";

/** What the catalog (or a palette) says about a piece: the facts the classifier reads. */
export interface PieceFacts {
  kind: "tile" | "prop" | null;
  /** The catalog's coarse form of the piece (floor, wall, roof, corner, stairs, …; may be ""). */
  groupTag: string;
  tags: readonly string[];
  /** The asset's display name (core's measured facts are keyed by it). */
  name: string;
  /** Height in tiles. */
  height: number;
  /**
   * The roles the asset is listed under: the palettes' (`wall.stone`, `feature.tree`, `ship.deck`) and the catalog's
   * own classification of it (`feature.bush`). Absent: none known.
   */
  roles?: readonly string[];
}

export interface ClassInput {
  /** The placement's role; null for a piece read from a slab. */
  role: PlacementRole | null;
  /** Paste layer ("site", "storey:<n>", "roof"). */
  layer: string;
  /** Material of the plan cell the piece came from. */
  material: Material | null;
  facts: PieceFacts | null;
  /** The collider the piece is placed by (its size for the shape rules). */
  geom?: PieceGeom | null;
}

/** The class of a palette role's family (core palette/roles.ts): what that family's pieces are. */
const FAMILY_CLASS: Readonly<Record<string, ColourClass>> = {
  // (no marker: the alignment marker borrows a real piece; only a placement's marker role makes a marker)
  // ways through
  opening: "opening",
  gate: "opening",
  window: "opening",
  over_door: "opening",
  // ways up
  link: "stairs",
  stairs: "stairs",
  stairs_block: "stairs",
  step: "stairs",
  ramp: "stairs",
  fire_escape: "stairs",
  // roofs and what tops them
  roof: "roof",
  roof_terrace: "roof",
  gable: "roof",
  gable_short: "roof",
  chimney: "roof",
  chimney_top: "roof",
  canopy: "roof",
  // walls and what stands in them
  wall: "wall",
  wall_post: "wall",
  wall_short: "wall",
  facade: "wall",
  facade_post: "wall",
  footing: "wall",
  corner_pier: "wall",
  porch_post: "wall",
  parapet: "wall",
  crenel: "wall",
  cap: "wall",
  pier: "wall",
  ruin_block: "wall",
  balcony: "wall",
  // ground
  floor: "floor",
  fill: "floor",
  ledge: "floor",
  seam_ledge: "floor",
  bridge: "floor",
  kerb: "floor",
  marking: "floor",
  bed: "terrain",
  cliff: "terrain",
  water: "water",
  // light
  light: "light",
  wall_light: "light",
  glow: "light",
  magic_beacon: "light",
  // growth
  ruin_growth: "plant",
  ruin_climber: "plant",
  ruin_root: "plant",
  ruin_tree: "plant",
};

/** Roles of a kit whose family alone does not say what its pieces are (a ship's kit, a market stall's parts). */
const ROLE_CLASS: Readonly<Record<string, ColourClass>> = {
  "ship.deck": "floor",
  "ship.deck_base": "floor",
  "ship.deck_bow": "floor",
  "ship.deck_edge": "floor",
  "ship.deck_stern": "floor",
  "ship.deck_trim": "floor",
  "ship.grating": "floor",
  "ship.forepeak": "floor",
  "ship.hull_bow": "wall",
  "ship.hull_side": "wall",
  "ship.hull_stern": "wall",
  "ship.wall": "wall",
  "ship.wall_curved": "wall",
  "ship.wall_stern": "wall",
  "ship.wall_window": "wall",
  "ship.wall_porthole": "wall",
  "ship.rail": "wall",
  "ship.rail_bow": "wall",
  "ship.rail_end": "wall",
  "ship.rail_low": "wall",
  "ship.rail_stern": "wall",
  "ship.door": "opening",
  "ship.hatch": "opening",
  "ship.wall_hatch": "opening",
  "ship.stairs": "stairs",
  "ship.ladder": "stairs",
  "ship.gangplank": "stairs",
  "ship.lantern": "light",
  "stall.post": "wall",
  "stall.canopy": "roof",
  "stall.ridge": "roof",
  "stall.light": "light",
};

/** The catalog's coarse forms (an asset's group tag, exactly) that say what a piece is. */
const GROUP_TAG_CLASS: Readonly<Record<string, ColourClass>> = {
  floor: "floor",
  wall: "wall",
  corner: "wall",
  roof: "roof",
  stairs: "stairs",
  door: "opening",
  window: "opening",
};

const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/** The class one role says (null: the role says nothing about what its pieces are). */
export function roleClass(role: string): ColourClass | null {
  const exact = own(ROLE_CLASS, role);
  if (exact) return exact;
  const family = roleFamily(role);
  if (family === "feature") {
    const info = own(FEATURE_INFO, role.slice("feature.".length));
    if (info?.light === true) return "light";
    if (info?.organic === true) return "plant";
    return null;
  }
  return own(FAMILY_CLASS, family) ?? null;
}

/**
 * The class the roles listing an asset say, when they agree (null: none says, or they differ). Palettes reuse a piece
 * under roles of different kinds (a floor tile as a roof flat, a jug among rubble): then no one role decides, and the
 * catalog's facts and the piece's shape do.
 */
function rolesClass(roles: readonly string[]): ColourClass | null {
  const said = new Set(roles.map(roleClass));
  const [only] = said;
  return said.size === 1 ? (only ?? null) : null;
}

/** The class of a piece by what is known of the asset alone (roles, catalog form, measured facts, shape). */
function assetClass(facts: PieceFacts, geom: PieceGeom | null | undefined): ColourClass {
  const byRoles = rolesClass(facts.roles ?? []);
  if (byRoles) return byRoles;
  const byForm = own(GROUP_TAG_CLASS, facts.groupTag.toLowerCase());
  if (byForm) return byForm;
  const measured = pieceFacts(facts.name);
  if (measured.light && measured.light.kind !== "none") return "light";
  if (measured.grown === true) return "plant";
  const size = geom?.size ?? { x: 0, y: facts.height, z: 0 };
  // a tile lying flat is ground; one standing (a panel, a post, a block) is built structure
  if (facts.kind === "tile")
    return !geom || traitsOf({ size, originAt: geom.originAt }).includes("slab") ? "floor" : "wall";
  const s = sizeClass({ size });
  return s === "tall" || s === "huge" ? "tall_prop" : "prop";
}

/** The class of a piece (first rule that answers wins; see the file header). */
export function pieceClass(p: ClassInput): ColourClass {
  if (p.role === "marker") return "marker";
  if (p.layer === "roof") return "roof";
  if (p.material !== null && materialInfo(p.material).water) return "water";
  switch (p.role) {
    case "wall":
    case "wall_post":
      return "wall";
    case "opening":
      return "opening";
    case "link":
      return "stairs";
    case "floor":
    case "fill":
    case "ledge":
      return p.material !== null && materialInfo(p.material).natural ? "terrain" : "floor";
    case "feature":
    case null:
      break;
  }
  if (!p.facts) return p.role === null ? "unknown" : "prop";
  return assetClass(p.facts, p.geom);
}
