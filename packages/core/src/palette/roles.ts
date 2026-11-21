/**
 * The registry of palette role names the code asks for (the compiler, verify, the review, the palette's own views). A
 * role is a palette key `<family>.<name>` (contracts/compiler.ts lists the families); a name written here once cannot
 * drift between the module that places a piece and the one that checks or reviews it. Roles built from a vocabulary
 * (`feature.<type>`, `opening.<kind>`, `floor.<material>`, ...) have a builder here; fixed roles a constant. A
 * source-scan test (test/unit/palette/roleRegistry.test.ts) keeps role literals out of compile/ and review/.
 */
import type { RoleName } from "../contracts/compiler";
import type { FeatureType } from "../contracts/plan";
import { NATURAL_WALL_STYLE, THEME_WALL_STYLE } from "../gen/wallStyles";

/** The family of a role name: the part before the first dot (`opening` of `opening.door`). */
export const roleFamily = (role: RoleName): string => {
  const dot = role.indexOf(".");
  return dot < 0 ? role : role.slice(0, dot);
};

/** The family of the floor roles. */
export const FLOOR_FAMILY = "floor";
/** The floor role of a material: `floor.<material>`. */
export const floorRole = (material: string): RoleName => `${FLOOR_FAMILY}.${material}`;
/** What stands under a raised floor of a material: `fill.<material>`. */
export const fillRole = (material: string): RoleName => `fill.${material}`;
/** The bed of a water channel of a material: `bed.<material>`. */
export const bedRole = (material: string): RoleName => `bed.${material}`;
/** A water bed's role when the material has none of its own. */
export const BED_DEFAULT_ROLE: RoleName = bedRole("default");
/** The face of a drop in ground of a material: `cliff.<material>`. */
export const cliffRole = (material: string): RoleName => `cliff.${material}`;
/** A drop's face when the material has no cliff role. */
export const CLIFF_DEFAULT_ROLE: RoleName = cliffRole("default");
/** Whole-cell rock blocks a natural drop is built of before the default face. */
export const CLIFF_ROCK_BLOCK_ROLE: RoleName = cliffRole("rock_block");
/** The natural drop's face (generator 2 rock bands). */
export const CLIFF_NATURAL_ROLE: RoleName = cliffRole("natural");
/** The Cavern kit's rock mass and the flat sheets over a deep band (generator 3 cave walls). */
export const CAVE_MASS_ROLE: RoleName = cliffRole("cave_mass");
export const CAVE_CAP_ROLE: RoleName = cliffRole("cave_cap");
/** A column under a bridge deck of a material: `pier.<material>`, else the default pier. */
export const pierRole = (material: string): RoleName => `pier.${material}`;
export const PIER_DEFAULT_ROLE: RoleName = pierRole("default");
/** A road marking piece: `marking.<kind>` (a zebra crossing). */
export const markingRole = (kind: string): RoleName => `marking.${kind}`;
/** A kerb of a material: `kerb.<material>`, else the default kerb. */
export const kerbRole = (material: string): RoleName => `kerb.${material}`;
export const KERB_DEFAULT_ROLE: RoleName = kerbRole("default");
/** The glow over a glowing liquid: `glow.<material>`, or the older feature role `feature.<material>_glow`. */
export const glowRole = (material: string): RoleName => `glow.${material}`;
export const glowFeatureRole = (material: string): RoleName => `feature.${material}_glow`;
/** The pieces of a feature type: `feature.<type>`. */
export const featureRole = (type: FeatureType): RoleName => `feature.${type}`;
/** The piece of an opening kind: `opening.<kind>`. */
export const openingRole = (kind: string): RoleName => `opening.${kind}`;
/** The pieces of a link kind: `link.<kind>`. */
export const linkRole = (kind: string): RoleName => `link.${kind}`;
/** A built flight of stairs (a stairs link, and a one-tile step between floors). */
export const STAIRS_ROLE: RoleName = linkRole("stairs");
/** Stairs of a natural ground material (earth or rock steps): `link.stairs.<material>`. */
export const stairsRole = (material: string): RoleName => `${STAIRS_ROLE}.${material}`;
/** Natural rock stairs, asked before the built stairs. */
export const NATURAL_STAIRS_ROLE: RoleName = stairsRole("natural");
/** Is the role a stairs piece (built or of a material)? */
export const isStairsRole = (role: RoleName): boolean =>
  role === STAIRS_ROLE || role.startsWith(`${STAIRS_ROLE}.`);
/** A low step piece between floors of a material: `step.<material>`, else the default step. */
export const stepRole = (material: string): RoleName => `step.${material}`;
export const STEP_DEFAULT_ROLE: RoleName = stepRole("default");
/** The lintel over a door in a wall style: `lintel.<style>`. */
export const lintelRole = (style: string): RoleName => `lintel.${style}`;
/** The corner post of a wall style: `wall_post.<style>`. */
export const postRole = (style: string): RoleName => `wall_post.${style}`;
/** The alignment marker a build is pasted by. */
export const MARKER_ROLE: RoleName = "marker.alignment";

/** The long low face rocks of a natural cliff's rock band (generator 2); a theme that has them builds rock bands. */
export const CLIFF_FACE_ROLE: RoleName = "cliff.formation_face";
/** The boulders along the top of a rock band. */
export const CLIFF_CREST_ROLE: RoleName = "cliff.formation_crest";
/** Boulders of one tone the crest role lacks: `cliff.formation_crest_<tone>`. */
export const crestToneRole = (tone: string): RoleName => `${CLIFF_CREST_ROLE}_${tone}`;
/** The flat piece that closes the gap on top of a wall between two tidy rooms (generator 4's solid shell). */
export const SOLID_CAP_ROLE: RoleName = "cap.solid";
/** The last resort of every fill and bed chain: what stands under a raised floor when nothing better is listed. */
export const FILL_ROLE: RoleName = "fill.default";

/** The wall role of a wall style: `wall.<style>`. */
export const wallRole = (style: string): RoleName => `wall.${style}`;
/** The wall role of the theme's own wall, the last link of every wall chain. */
export const THEME_WALL_ROLE: RoleName = wallRole(THEME_WALL_STYLE);
/** The wall role of natural rock (whole-cell blocks; generator 4 builds them as a cave mass). */
export const NATURAL_WALL_ROLE: RoleName = wallRole(NATURAL_WALL_STYLE);
/** The broken wall pieces of a ruin's top course. */
export const RUINED_WALL_ROLE: RoleName = wallRole("ruined");
/** The lintel and corner post of the theme's own wall, the last link of their chains. */
export const THEME_LINTEL_ROLE: RoleName = lintelRole(THEME_WALL_STYLE);
export const THEME_POST_ROLE: RoleName = postRole(THEME_WALL_STYLE);

// ── a building's parts (compile/realize/structures/*) ──

/**
 * The families of a building's parts: each part's role is `<family>.<style>` for a wall style, a roof kit or a door
 * family (`chimney.stone`), with a palette-wide `<family>.default` after the style's own (`chimney.default`).
 */
export type BuildingPart =
  | "facade"
  | "footing"
  | "facade_post"
  | "over_door"
  | "wall_short"
  | "window"
  | "gable"
  | "gable_short"
  | "seam_ledge"
  | "crenel"
  | "corbel"
  | "chimney"
  | "chimney_top"
  | "porch_post"
  | "wall_light"
  | "sign_band"
  | "corner_pier"
  | "canopy"
  | "balcony"
  | "balcony_rail"
  | "fire_escape"
  | "wall_pipe"
  | "wall_unit"
  | "mast"
  | "finial"
  | "magic_beacon"
  | "roof_clutter"
  | "roof_terrace"
  | "gate"
  | "ruin_rubble"
  | "ruin_block"
  | "ruin_prop"
  | "ruin_growth"
  | "ruin_climber"
  | "ruin_root"
  | "ruin_cap"
  | "ruin_tree";

/** The style word of a part's palette-wide piece (`chimney.default`, `roof.default.deck`). */
export const DEFAULT_PART = "default";
/** A building part in a style: `<part>.<style>`. */
export const partRole = (part: BuildingPart, style: string): RoleName => `${part}.${style}`;
/** A building part's palette-wide piece: `<part>.default`. */
export const defaultPartRole = (part: BuildingPart): RoleName => partRole(part, DEFAULT_PART);
/** A piece of a roof kit: `roof.<kit>.<piece>` (slope, slope2, slope2x2, cap, corner, step, flat, deck, shell, tip ...). */
export const roofRole = (kit: string, piece: string): RoleName => `roof.${kit}.${piece}`;
/** An opening kind's piece of one style or door family: `opening.<kind>.<family>` (opening.door.shop). */
export const styledOpeningRole = (kind: string, family: string): RoleName => `${openingRole(kind)}.${family}`;
/** A light anchor of a building: `light.<kind>` (window, glow, strip), or of a wall style or colour. */
export const lightRole = (kind: "window" | "glow" | "strip", style?: string): RoleName =>
  style === undefined ? `light.${kind}` : `light.${kind}.${style}`;
/** The battlements of a seam with no crenel piece: a parapet course, else a low wall. */
export const CRENEL_FALLBACK_ROLES: readonly RoleName[] = [wallRole("parapet"), wallRole("low_wall")];
/** The railing round a tower's balcony ring. */
export const BALCONY_RING_RAIL_ROLES: readonly RoleName[] = [wallRole("railing_stone"), wallRole("railing")];

/**
 * The roles a building style's look depends on (walls, windows, doors, the roof kit's slopes and flats): a fallback away
 * from one of them is named (`structure_style_fallback`).
 */
const STYLE_LOOK_ROLE =
  /^(facade|window|opening\.(door|double_door))\.[a-z_]+$|^roof\.[a-z_]+\.(slope|slope2x2|flat)$/;
export const isStyleLookRole = (role: RoleName): boolean => STYLE_LOOK_ROLE.test(role);

/** Climbing growth on a weathered or ruined building's walls (resolve/growth.ts). */
export const RUIN_CLIMBER_ROLE: RoleName = defaultPartRole("ruin_climber");

/** A market stall as one piece (the generator-3 table stall and its kinds' variants). */
export const STALL_PIECE_ROLE: RoleName = featureRole("stall");

/** The parts of a market stall (generator 3 tables, generator 4 covered stalls). */
export const STALL_ROLES = {
  base: "stall.base",
  counter: "stall.counter",
  post: "stall.post",
  canopy: "stall.canopy",
  ridge: "stall.ridge",
  light: "stall.light",
  seat: "stall.seat",
} as const satisfies Record<string, RoleName>;
