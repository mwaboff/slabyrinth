/**
 * The four wealth steps measured over seeds (generator 5, `wealthLooks`): the varied street (nine buildings left to
 * their style's draw) with its level stated intact and at one wealth, built at sweep seeds, per step:
 *   trims     detail-recipe pieces on the buildings (bands, posts, plinths, pilasters) per building
 *   finish    the share of drawn walls (ground and upper material) by finish (gen/wallStyles.ts): rough, plain, fine
 *   kitShare  the share of the pitched roofs in the street's most common roof kit (how alike the roofs are)
 * Read by test/unit/resolve/roofsQuarters.test.ts and the proof script docs/internal/training/proofs/measureWealth.ts.
 */
import { PLACE_WEALTHS, type MapPlan, type PlaceWealth } from "../../src/contracts/plan";
import { wallStyleInfo } from "../../src/gen/wallStyles";
import type { PaletteCatalog } from "../../src/contracts/compiler";
import { resolvePlan } from "../../src/resolve";
import { isPitchedRoof } from "../../src/resolve/roofTypes";
import { sweepSeed } from "../sweep/seeds";
import { loadPlan } from "./index";

/** The recipes that dress a door (counted as dressed doors, not as trims). */
const DOOR_RECIPES: ReadonlySet<string> = new Set(["approachLights", "guardianPair"]);

export interface WealthRow {
  readonly wealth: PlaceWealth;
  readonly buildings: number;
  readonly trims: number;
  readonly rough: number;
  readonly plain: number;
  readonly fine: number;
  readonly kitShare: number;
  /** Share of buildings trimmed in a contrasting material, and whose door is dressed (a light pair, guardians). */
  readonly contrast: number;
  readonly dressedDoor: number;
}

/** The varied street at sweep seed `i`, its buildings' own seeds dropped, its level stated intact and `wealth`. */
export function streetAtWealth(i: number, wealth: PlaceWealth, theme: string): MapPlan {
  const plan = loadPlan("varied-street-v1");
  return {
    ...plan,
    theme,
    seed: sweepSeed(i),
    levels: plan.levels.map((L) => ({
      ...L,
      condition: "intact",
      wealth,
      structures: (L.structures ?? []).map((s) => {
        const rest = { ...s } as typeof s & { seed?: number };
        delete rest.seed;
        return rest;
      }),
    })),
  };
}

/** Each wealth step over `seeds` sweep seeds in `theme`. */
export function wealthSteps(pal: PaletteCatalog, seeds: number, theme = "wood_town"): WealthRow[] {
  return PLACE_WEALTHS.map((wealth) => {
    let buildings = 0;
    let trims = 0;
    const finish = { rough: 0, plain: 0, fine: 0 };
    let kitShare = 0;
    let contrast = 0;
    let dressed = 0;
    for (let i = 0; i < seeds; i++) {
      const L = resolvePlan(streetAtWealth(i, wealth, theme), pal).levels[0];
      if (!L) continue;
      const kits = new Map<string, number>();
      for (const st of L.structures ?? []) {
        if (st.kind !== "building" || !st.design) continue;
        buildings++;
        const mine = (L.arrangements ?? []).filter((a) => a.host === st.id && a.recipe !== "layeredGround");
        trims += mine.filter((a) => !DOOR_RECIPES.has(a.recipe)).reduce((n, a) => n + a.pieces.length, 0);
        const t = mine[0]?.treatment ?? "";
        if (t.includes("trim:contrast")) contrast++;
        if (mine.some((a) => DOOR_RECIPES.has(a.recipe))) dressed++;
        for (const m of [st.design.baseMaterial, st.design.material])
          finish[wallStyleInfo(m)?.finish ?? "plain"]++;
        if (isPitchedRoof(st.roof.type)) kits.set(st.roof.style, (kits.get(st.roof.style) ?? 0) + 1);
      }
      const all = [...kits.values()].reduce((s, n) => s + n, 0);
      kitShare += all === 0 ? 0 : Math.max(...kits.values()) / all;
    }
    const walls = finish.rough + finish.plain + finish.fine || 1;
    return {
      wealth,
      buildings,
      trims: trims / Math.max(1, buildings),
      rough: finish.rough / walls,
      plain: finish.plain / walls,
      fine: finish.fine / walls,
      kitShare: kitShare / Math.max(1, seeds),
      contrast: contrast / Math.max(1, buildings),
      dressedDoor: dressed / Math.max(1, buildings),
    };
  });
}
