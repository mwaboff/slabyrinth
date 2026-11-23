/**
 * A piece sunk into the floor piece under it (a rock bedded in the ground) stands in that floor while its base is inside
 * the floor piece's body, above its underside; a base at the underside or below it has gone through the floor and stands
 * on nothing. One question, asked by the ground recipe before it sinks a piece (resolve/recipes/ground.ts: how deep the
 * floor under the piece takes it, from the floor's own pieces) and by verify after the build (compile/verify/props.ts:
 * whether a sunk piece is in the floor under its centre), so the two cannot disagree about a piece sunk too deep.
 */

/**
 * Floor kept under a sunk piece's base: twice the slab's storage step (0.01 tile), which may round the piece's base down
 * and the floor piece's underside up by half a step each.
 */
export const SUNK_FLOOR_KEPT = 0.02;

/** The deepest a piece may sink into a floor piece `thickness` tiles thick and still stand in it once stored. */
export const deepestSink = (thickness: number): number => Math.max(0, thickness - SUNK_FLOOR_KEPT);

/** Whether a piece's base at height `base` is inside a floor piece whose underside is at `underside`. */
export const baseInFloor = (base: number, underside: number): boolean => underside < base;
