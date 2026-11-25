/**
 * Generator 5 (`shelvesWithinWalls`): a shelf plank wider than its cell ("wall rack 04", 1.35 tiles) hung where its
 * wall ends (a corner, a doorway) reached about 0.17 past the wall (chimney-lineup-v1, inn-interior-v1). Every plank's
 * true width, asked of the palette it is built in, now lies along wall the whole way.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EDGE, type ResolvedPlan } from "../../../src/contracts/resolved";
import type { Side } from "../../../src/contracts/plan";
import { SIDE_STEP, SIDES } from "../../../src/gen/gridGeometry";
import { bundledPalettes } from "../../../src/palette";
import { createPlanRoles } from "../../../src/palette/planRoles";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { LevelGrid } from "../../../src/resolve/levelGrid";
import { loadPlan } from "../../fixtures";

const pal = bundledPalettes();
const roles = createPlanRoles(pal, 5);
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

/** Planks reaching more than 0.02 past the wall they hang on. */
function pastTheWall(r: ResolvedPlan): string[] {
  const out: string[] = [];
  for (const L of r.levels) {
    const V = new LevelGrid(L, roles.defaultTheme);
    for (const f of L.features) {
      if (f.type !== "shelf_line" || f.wall === undefined) continue;
      const s: Side = f.wall;
      const [x, y] = f.at;
      const theme = V.themeAt(f.theme, x, y);
      const vs = roles.resolve(theme, "feature.shelf_line").resolution?.variants ?? [];
      const w = Math.max(1, ...vs.map((v) => v.geom.size.x));
      const along: readonly [number, number] = s === "N" || s === "S" ? [1, 0] : [0, 1];
      const off = (f.offset?.[0] ?? 0) * along[0] + (f.offset?.[1] ?? 0) * along[1];
      // the cells the plank covers along its wall, from its own cell outward each way
      for (const sign of [-1, 1] as const) {
        const reach = w / 2 + sign * off - 0.5 - 0.02;
        const across = SIDES.find(
          (q) => SIDE_STEP[q][0] === along[0] * sign && SIDE_STEP[q][1] === along[1] * sign,
        );
        let [cx, cy] = [x, y];
        for (let k = 0; k < Math.ceil(reach); k++) {
          if (across === undefined || V.edgeKind(cx, cy, across) !== EDGE.NONE) {
            out.push(`${L.id} ${f.id} at ${x},${y} ${s}: past the wall end by ${(reach - k).toFixed(2)}`);
            break;
          }
          [cx, cy] = [cx + along[0] * sign, cy + along[1] * sign];
          if (!V.wallOn(cx, cy, s)) {
            out.push(`${L.id} ${f.id} at ${x},${y} ${s}: past the wall end by ${(reach - k).toFixed(2)}`);
            break;
          }
        }
      }
    }
  }
  return out;
}

const PLANS = [
  "chimney-lineup-v1",
  "inn-interior-v1",
  "building-rooms-street-v1",
  "interiors-lineup-v1",
] as const;

describe("shelf planks within their walls (generator 5, shelvesWithinWalls)", () => {
  it("no plank reaches past the end of the wall it hangs on", () => {
    let planks = 0;
    for (const id of PLANS) {
      const r = resolvePlan(loadPlan(id, { generator: 5 }), pal);
      planks += r.levels.flatMap((L) => L.features.filter((f) => f.type === "shelf_line")).length;
      expect(pastTheWall(r), id).toEqual([]);
    }
    expect(planks).toBeGreaterThan(5);
  });

  it("without the switch a plank at a wall's end reaches past it", () => {
    P5.shelvesWithinWalls = false;
    const faults = PLANS.flatMap((id) => pastTheWall(resolvePlan(loadPlan(id, { generator: 5 }), pal)));
    expect(faults.length).toBeGreaterThan(0);
  });
});
