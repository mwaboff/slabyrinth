/**
 * What a building's parts are built of where the building itself does not say: the door family of its use, and the
 * style, floor material and roof kit a part falls back to. The compiler's structure passes (compile/realize/structures/*)
 * ask these and nothing else, so one question ("what is this chimney made of when the storey has no walls?") has one
 * answer in one place.
 */
import type { Material, WallStyle } from "../../contracts/plan";
import type { ResolvedStructure } from "../../contracts/resolved";
import { THEME_WALL_STYLE } from "../../gen/wallStyles";
import { structureStyle } from "../structureStyles";

/** The door family of a works building (a roof hut's door is one too). */
export const WORKS_DOOR_FAMILY = "works";

/**
 * Door family per building use (palette roles opening.door.<family>, opening.double_door.<family>), tried before the wall
 * style's doors on a designed building's ground storey: a shop's glazed door, an office's, a home's, a works' roller.
 */
export const USE_DOOR_FAMILY: Readonly<Record<string, string>> = {
  shop: "shop",
  diner: "shop",
  office: "office",
  civic: "office",
  apartments: "home",
  townhouse: "home",
  warehouse: WORKS_DOOR_FAMILY,
  garage: WORKS_DOOR_FAMILY,
  workshop: WORKS_DOOR_FAMILY,
};

/** The door family of an era style's building whose use the table does not list. */
const ERA_DOOR_FAMILY = "home";

/**
 * The door family a designed building's ground doors try first (USE_DOOR_FAMILY), the era default for an unlisted use
 * of an era style; undefined for a building with no design or no family.
 */
export function designDoorFamily(st: ResolvedStructure): string | undefined {
  if (!st.design) return undefined;
  const family = USE_DOOR_FAMILY[st.design.use] ?? (structureStyle(st.style)?.era ? ERA_DOOR_FAMILY : "");
  return family === "" ? undefined : family;
}

/**
 * What a building's walls are made of: its design's material, else its ground storey's walls; null for a building
 * whose ground storey has none.
 */
export const buildingWalls = (st: ResolvedStructure): WallStyle | null =>
  st.design?.material ?? st.storeys[0]?.walls ?? null;

/**
 * The wall style a part takes when the storey it belongs to has no walls (a plan's `walls: "none"`), by part.
 *
 * FROZEN: the rows disagree (a stone chimney, but a wooden porch and door light, a brick terrace lamp and the theme's
 * own wall for a sign band) because each part once spelled its own default. Released builds asked these roles, so the
 * rows stay as they are for every generator; the one consistent answer would be THEME_WALL_STYLE (the theme's own
 * wall), but taking it would change generator-4 builds of such a storey too, so it waits for the owner.
 */
export const OPEN_STOREY_WALLS = {
  /** The ledge and battlements a set-in storey leaves on the one below. */
  seam: "stone",
  /** The corbel course under an overhanging volume. */
  lip: "stone",
  /** The chimney breast and pot (after the ground storey's footing). */
  chimney: "stone",
  /** The blocks and rubble a ruin's broken walls shed. */
  ruin: "stone",
  porch: "wood",
  doorLight: "wood",
  /** The lamp on a roof terrace (the top storey's walls). */
  terraceLamp: "brick",
  signBand: THEME_WALL_STYLE,
  /** Facade details: corner piers and the canopy over the street front. */
  details: THEME_WALL_STYLE,
} as const satisfies Record<string, WallStyle>;

export type OpenStoreyPart = keyof typeof OPEN_STOREY_WALLS;

/** The walls a part is built of: the storey's, else the part's row of OPEN_STOREY_WALLS. */
export const partWalls = (walls: WallStyle | null | undefined, part: OpenStoreyPart): WallStyle =>
  walls ?? OPEN_STOREY_WALLS[part];

/**
 * The floor material at the end of some parts' role chains, after the part's own roles and the building's roof kit.
 * FROZEN like OPEN_STOREY_WALLS (released builds asked these roles).
 */
export const PART_FALLBACK_FLOORS = {
  /** A spire's ceiling and lid, a tower's balcony ring. */
  stone: "flagstone",
  /** A roof hut's roof, a street canopy, a balcony. */
  tile: "stone_tile",
} as const satisfies Record<string, Material>;

/** The roof kits some parts take or borrow from. FROZEN like OPEN_STOREY_WALLS. */
export const PART_FALLBACK_KITS = {
  /** A seam's skirt and a volume's lip when the building's roof names no kit. */
  pitched: "slate",
  /** The flat piece a street canopy and a balcony borrow. */
  flat: "city",
  /** The flat piece a roof terrace's deck borrows. */
  terrace: "durable",
} as const;
