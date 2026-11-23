/**
 * The measures verify judges the build by (tiles unless named otherwise). Data, not code: each constant says what it
 * stands for, and the checks read them by name.
 */
import { HEADROOM } from "../../plan/levels";

/** Clear height a creature needs above a floor top (plan/levels.ts, which the resolver's cave relief also keeps). */
export const HEAD = HEADROOM;
/** Largest height difference walkable without stairs. */
export const STEP = 0.5;
/** The step of a placement's rotation (degrees): TaleSpire's, from the slab codec. */
export { ROTATION_STEP } from "../../slab/codec";

/** A cell whose unhosted part is narrower than this (either way) has no free centre to test (resolve/levelGrid.ts). */
export { MIN_FREE_SPAN } from "../../resolve/levelGrid";

/** Walls: the wall pieces are sampled this far inside the wall's span (above its base, below its top). */
export const WALL_SAMPLE_INSET = 0.1;
/** Natural (full-cell) rock walls vary in height: this much above the floor counts as closed. */
export const ROCK_WALL_CLOSED = 1.5;
/** A ruin's walls only need to stand this far above its floor (their tops are broken). */
export const RUINED_WALL_STANDS = 1;

/** Cliffs: an edge rising this many quarter tiles (2 tiles) or more needs rock in front or a face behind. */
export const CLIFF_GAP_RISE_Q = 8;
/** A cliff feature covers an edge midpoint within this margin of its footprint. */
export const CLIFF_COVER_MARGIN = 0.3;

/** Doors: the zone of the host half cell is grown by this margin before a door piece is tested against it. */
export const DOOR_ZONE_MARGIN = 0.06;
/** A door piece must overlap its zone across the wall by more than this. */
export const DOOR_MIN_OVERLAP = 0.2;
/** A piece of an opening wider than one edge may reach this far past the first edge's zone along the wall. */
export const WIDE_DOOR_SLACK = 1;
/** Hint: how many edges either way along the wall a clear spot for a blocked door is looked for. */
export const DOOR_SUGGEST_REACH = 4;

/** Stairs: the run's top may differ from the floor it meets by this much. */
export const STAIR_ARRIVAL_TOLERANCE = 0.3;
/** Generator 4: a step may stand at most this far (one tile) above the one behind it ... */
export const STAIR_STEP_MAX = 1.05;
/** ... and must stand at least this far above it. */
export const STAIR_STEP_MIN = 0.05;
/** A ladder or spiral stack may end this far short of the upper floor top. */
export const LADDER_REACH_TOLERANCE = 0.25;
/** A trapdoor's hatch may sit this far off the upper floor top. */
export const HATCH_TOLERANCE = 0.3;
/** A floor piece reaching this far above the upper level's elevation closes a link's shaft. */
export const SHAFT_FLOOR_PROBE = 0.6;

/** Props: two props overlap when they share more than this height ... */
export const PROP_OVERLAP_HEIGHT = 0.05;
/** ... and more than this share of the smaller footprint ... */
export const PROP_OVERLAP_SHARE = 0.25;
/** ... and more than this area. */
export const PROP_OVERLAP_MIN_AREA = 0.01;
/** Generator 5 (`layeredProps`): two pieces of furniture stand in one spot when they share this much of the smaller one. */
export const PROP_SAME_SPOT_SHARE = 0.6;
/** A wall-mounted prop is backed by a wall piece within this distance. */
export const MOUNT_BACKING_REACH = 0.6;
/** A prop pokes into a wall piece when they overlap by more than this, both ways across the floor. */
export const PROP_IN_WALL_MIN = 0.03;
/** ... and share more than this height. */
export const PROP_IN_WALL_HEIGHT = 0.1;
/** A prop poking into a wall is pushed out only when it pokes in this far or less ... */
export const NUDGE_MAX = 0.5;
/** ... and stays within its feature's footprint grown by this margin. */
export const NUDGE_FOOTPRINT_SLACK = 0.1;
/** A pushed prop clears the wall by this much. */
export const NUDGE_CLEARANCE = 0.01;
/** What a prop stands on may reach this far above the prop's base. */
export const SUPPORT_SLACK = 0.06;
/** A sunk arranged piece is in the ground tiles met within this of its centre (a centre on a seam between two). */
export const SEAM_REACH = 0.02;
/** A prop this far or more above what is under it floats. */
export const FLOAT_TOLERANCE = 0.3;
/** Overhead lines: an anchor reaches the line's height within this tolerance. */
export const LINE_HEIGHT_TOLERANCE = 0.05;
/** A piece rises into the level above when its top is this far past that level's elevation. */
export const POKE_TOLERANCE = 0.05;
