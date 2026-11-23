/**
 * Which light features give light, and how bright a room is meant to be (generator 5, switch `lightRegimes`), for every
 * light count of the review and the meter.
 *
 *   gives light   a light feature counts only when the pieces it is built from give light (gen/lightReach.ts
 *                 `givesLight` of the weakest piece its palette pool holds, as the regimes choose them): a stone
 *                 lantern is a light feature that emits nothing in game.
 *   meant dim     a room whose drawn light level (ResolvedArea.lightLevel) is dim or dark carries few or no accents on
 *                 purpose (the owner: brightness follows the mood of the room and the scene); outside, the scene's or
 *                 the building's character (resolve/character.ts). A dim place without a light is no fault.
 * Released generators count every light feature and hold every room to light.
 */
import type { MapPlan } from "../contracts/plan";
import type { ResolvedArea, ResolvedFeature, ResolvedLevel, ResolvedPlan } from "../contracts/resolved";
import { elementCharacter, lightIndex } from "../resolve/character";
import { LIGHT_FEATURES } from "../gen/catalog";
import { givesLight, lightOfPool } from "../gen/lightReach";
import { featureRoles } from "../gen/surfaces";
import { createPlanRoles } from "../palette/planRoles";
import type { ResolvePalettes } from "../palette/resolve";
import { generatorProfile } from "../plan/generator";
import { LevelGrid, elementTheme } from "../resolve/levelGrid";

/** Light levels at or under this are dim: a room or scene meant to have few or no lights. */
export const DIM_LEVEL = 1;

/**
 * Does this feature give light? Every light feature for a released generator or without palettes; at generator 5, only
 * those whose pieces give light.
 */
export function lightGiver(
  resolved: ResolvedPlan,
  palettes?: ResolvePalettes,
): (f: ResolvedFeature) => boolean {
  const lit = (f: ResolvedFeature): boolean => LIGHT_FEATURES.has(f.type);
  if (palettes === undefined || !generatorProfile(resolved).lightRegimes) return lit;
  const roles = createPlanRoles(palettes, resolved.generator);
  const memo = new Map<string, boolean>();
  // the theme each light is built in (an element's own, else its cell's): asked of the level it stands on
  const themeOf = new Map<ResolvedFeature, string>();
  for (const L of resolved.levels) {
    const grid = new LevelGrid(L, roles.defaultTheme);
    for (const f of L.features) if (lit(f)) themeOf.set(f, grid.themeAt(f.theme, f.at[0], f.at[1]));
  }
  return (f) => {
    if (!lit(f)) return false;
    const theme = themeOf.get(f) ?? elementTheme(f.theme, roles.defaultTheme);
    const key = `${theme}|${f.type}|${f.variant ?? ""}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let names: string[] = [];
    for (const role of featureRoles(f.type)) {
      const res = roles.resolve(theme, role).resolution;
      if (!res) continue;
      const vs =
        f.variant !== undefined
          ? res.variants.filter((q) => q.variant === f.variant)
          : res.variants.filter((q) => q.weight > 0);
      if (vs.length === 0) continue;
      names = vs.map((q) => q.name ?? q.uuid);
      break;
    }
    const gives = givesLight(lightOfPool(names, f.type));
    memo.set(key, gives);
    return gives;
  };
}

/** Is a room meant to be dim (its drawn light level dim or dark)? Never for a released generator. */
export const roomMeantDim = (a: ResolvedArea | undefined): boolean =>
  a?.lightLevel !== undefined && a.lightLevel <= DIM_LEVEL;

/**
 * Is a subject meant to be dim (generator 5, characterCascade: its own character's light is dim or dark)? Each subject
 * is judged against its own character: a dim quarter's houses keep their doors dark on purpose.
 */
export function subjectMeantDim(L: Pick<ResolvedLevel, "character">, id: string): boolean {
  const c = elementCharacter(L, id);
  return c !== null && lightIndex(c) <= DIM_LEVEL;
}

/**
 * Is a level's scene meant to be dim (generator 5: the scene's character, the level's own record, is dim or dark)? The
 * same answer the build lit it by (resolve/character.ts), never the plan's words read again.
 */
export function sceneMeantDim(plan: MapPlan, L: Pick<ResolvedLevel, "id" | "character">): boolean {
  return generatorProfile(plan).lightRegimes && subjectMeantDim(L, L.id);
}
