/**
 * Palette role names that the code asks for by name in more than one module (the compiler, verify, the review, the
 * palette's own views). A role is a palette key (contracts/compiler.ts lists the families); a name written here once
 * cannot drift between the module that places a piece and the one that checks or reviews it. Roles built from a
 * vocabulary (`feature.<type>`, `opening.<kind>`, `floor.<material>`) are spelled where they are built.
 */
import type { RoleName } from "../contracts/compiler";
import { NATURAL_WALL_STYLE, THEME_WALL_STYLE } from "../gen/wallStyles";

/** The long low face rocks of a natural cliff's rock band (generator 2); a theme that has them builds rock bands. */
export const CLIFF_FACE_ROLE: RoleName = "cliff.formation_face";
/** The boulders along the top of a rock band. */
export const CLIFF_CREST_ROLE: RoleName = "cliff.formation_crest";
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
