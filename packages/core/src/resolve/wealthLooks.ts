/**
 * What a place's wealth shows from the street (generator 5, `wealthLooks`), as weights per wealth step (poor, modest,
 * wealthy, lavish), never a branch per theme: wealth reweights a draw, so a poor quarter may still hold one decent
 * house and a rich one a plain one. Read through `characterAt` / `elementCharacter` (resolve/character.ts), never words.
 *
 *   walls   a building's wall materials by their finish (gen/wallStyles.ts WallStyleInfo.finish): rough planks and
 *           rubble at the poor end, dressed stone and brick at the rich end; a rough wall built in the theme's own
 *           wall takes the theme wall's rough variant family (WALL_VARIANT_FINISH) where the palette has one.
 *   roofs   how alike the roofs of one quarter are: a wealthy or lavish building leans to the roof kit the first
 *           well-off building of its quarter (its character's parent) drew, so the rich end reads as one kept street;
 *           poor buildings draw every kit alike (mixed, and patched where worn: resolve/building/wear.ts).
 *   trims   the treatments' plain, contrast and richest options (resolve/recipes/treatments.ts WEALTH_WEIGHT_FIRM),
 *           and a lavish building's door dressed as a formal one's (a light pair at its approach, guardians).
 *   ground  (switch `variedGroundCover`) the place's cover by its wealth (resolve/recipes/ground.ts).
 * Measured per step by test/fixtures/wealthSteps.ts.
 */
import type { WallFinish } from "../gen/wallStyles";
import { wallStyleInfo } from "../gen/wallStyles";

/** A wealth step's index: 0 poor .. 3 lavish (resolve/character.ts wealthIndex). */
export type WealthStep = 0 | 1 | 2 | 3;

/** A wall material's weight multiplier by its finish, per wealth step. */
export const WEALTH_FINISH: Readonly<Record<WallFinish, readonly [number, number, number, number]>> = {
  // (modest is the style's own draw: its weights as they were)
  rough: [4, 1, 0.3, 0.1],
  plain: [1, 1, 0.9, 0.6],
  fine: [0.3, 1, 2.2, 3.5],
};

/** A wealthy or lavish building's weight multiplier on its quarter's roof kit (the first a well-off neighbour drew). */
export const QUARTER_KIT = 6;

/**
 * How a building's door is dressed by its wealth when its words give it no sacred or formal role (the threshold family,
 * resolve/recipes/treatments.ts): weights per wealth step (poor, modest, wealthy, lavish) of nothing, a light pair at
 * its approach, a guardian pair, both. A guardian pair only for a kind whose door suits one (gen/buildingProgramme.ts
 * `guardedDoor`: a mansion, a temple, a keep; never an inn's or a shop's): elsewhere those weights are 0. Always a
 * plain option of real weight, so lights at a rich door are a choice among several, never every door.
 */
export const DOOR_DRESSING: Readonly<
  Record<"plain" | "lights" | "guardians" | "both", readonly [number, number, number, number]>
> = {
  plain: [1, 1, 1, 1],
  lights: [0, 0, 0.6, 1],
  guardians: [0, 0, 0.15, 0.6],
  both: [0, 0, 0, 0.4],
};

/** Whether a wealth step keeps its quarter's roofs alike. */
export const keepsRoofsAlike = (w: WealthStep): boolean => w >= 2;

/**
 * The walls of a drawn design (ground and upper material) at the wrong end of its wealth: a fine one on a poor building,
 * a rough one on a wealthy or lavish one, a plain one half on a lavish one. The street draw counts it as a failure, one
 * less than a look-alike neighbour, so the readable-street rule still wins.
 */
export function finishMisses(
  d: { readonly material: string; readonly baseMaterial: string },
  w: WealthStep,
): number {
  const miss = (m: string): number => {
    const f = wallStyleInfo(m)?.finish ?? "plain";
    if (w === 0) return f === "fine" ? 1 : 0;
    if (w === 1) return 0;
    return f === "rough" ? 1 : w === 3 && f === "plain" ? 0.5 : 0;
  };
  return miss(d.material) + (d.baseMaterial !== d.material ? miss(d.baseMaterial) : 0);
}

/** A weights table (material → weight) reweighted by a building's wealth, by each material's finish. */
export function byFinish(
  w: Readonly<Record<string, number>> | undefined,
  wealth: WealthStep,
): Record<string, number> | undefined {
  if (!w) return undefined;
  return Object.fromEntries(
    Object.entries(w).map(([m, v]) => [m, v * WEALTH_FINISH[wallStyleInfo(m)?.finish ?? "plain"][wealth]]),
  );
}
