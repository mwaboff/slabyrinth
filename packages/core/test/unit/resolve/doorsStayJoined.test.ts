/**
 * A room's doorways stay joined (generator 5, switch doorsStayJoined; reported on an inn's ground storey: a stool on the
 * only way into the kitchen). Over stored plans with split buildings, under a few seeds: in every room with two or more
 * doorways (passages, not windows), each doorway is reached from the others over its floor without crossing a blocking
 * piece's cells, and no doorway cell holds one. Without the switch, the way check walked from every doorway at once, so a
 * bar's stool, a chest and the bar itself closed the way from the street door to the kitchen door behind the bar
 * (varied-street-v1's taproom) and a parlour's table group its door to the back room (ground-and-walls-v1).
 */
import { afterEach, describe, expect, it } from "vitest";
import { EDGE, type ResolvedLevel } from "../../../src/contracts/resolved";
import { isPassage } from "../../../src/gen/openingKinds";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { checkPlayability, resolvePlan } from "../../../src/resolve";
import { LevelGrid } from "../../../src/resolve/levelGrid";
import { loadPlan, type StoredPlan } from "../../fixtures";
import { sweepPlan, sweepSeeds } from "../../sweep/seeds";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

const SIDES = ["N", "E", "S", "W"] as const;
const STEP = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] } as const;

/** The doorway cells of rooms that are cut off from the room's other doorways, or blocked. */
function cutDoors(label: string, L: ResolvedLevel): string[] {
  const g = new LevelGrid(L);
  const blocked = new Set<number>();
  for (const f of L.features)
    if (f.blocking && f.type !== "rug")
      for (let dy = 0; dy < f.size[1]; dy++)
        for (let dx = 0; dx < f.size[0]; dx++) blocked.add(g.index(f.at[0] + dx, f.at[1] + dy));
  const passage = new Set<number>();
  for (const o of L.openings) {
    if (!isPassage(o.kind)) continue;
    for (let k = 0; k < o.width; k++) {
      const [x, y] = o.orientation === "h" ? [o.start[0] + k, o.start[1]] : [o.start[0], o.start[1] + k];
      passage.add(g.index(x, y));
      passage.add(o.orientation === "h" ? g.index(x, y - 1) : g.index(x - 1, y));
    }
  }
  const out: string[] = [];
  for (const a of L.areas) {
    if (a.kind !== "room") continue;
    const ai = L.areaIds.indexOf(a.id) + 1;
    const mine = (x: number, y: number): boolean => {
      const i = g.index(x, y);
      return i >= 0 && L.cells.area[i] === ai && g.cell(x, y).floor;
    };
    const doors: Array<[number, number]> = [];
    for (let y = a.bbox.y; y < a.bbox.y + a.bbox.h; y++)
      for (let x = a.bbox.x; x < a.bbox.x + a.bbox.w; x++)
        if (
          mine(x, y) &&
          passage.has(g.index(x, y)) &&
          SIDES.some(
            (s) => g.edgeKind(x, y, s) === EDGE.OPENING && g.cell(x + STEP[s][0], y + STEP[s][1]).floor,
          )
        )
          doors.push([x, y]);
    if (doors.length < 2) continue;
    const start = doors.find(([x, y]) => !blocked.has(g.index(x, y)));
    if (start === undefined) continue;
    const seen = new Set([g.index(start[0], start[1])]);
    const queue = [start];
    for (let h = 0; h < queue.length; h++) {
      const [x, y] = queue[h] as [number, number];
      for (const s of SIDES) {
        if (g.edgeKind(x, y, s) === EDGE.WALL) continue;
        const [nx, ny] = [x + STEP[s][0], y + STEP[s][1]];
        const i = g.index(nx, ny);
        if (!mine(nx, ny) || seen.has(i) || blocked.has(i)) continue;
        seen.add(i);
        queue.push([nx, ny]);
      }
    }
    for (const [x, y] of doors)
      if (!seen.has(g.index(x, y))) out.push(`${label} ${a.id} "${a.name ?? ""}" doorway ${x},${y}`);
  }
  return out;
}

const measure = (plans: readonly StoredPlan[], seeds: readonly number[]): string[] =>
  plans.flatMap((name) =>
    seeds.flatMap((seed) =>
      resolvePlan(sweepPlan(name, seed, 5), pal).levels.flatMap((L) => cutDoors(`${name}@${seed}`, L)),
    ),
  );

describe("a room's doorways stay joined (doorsStayJoined)", () => {
  it("no doorway of a room is cut off from its others (split buildings, several seeds)", () => {
    const plans: StoredPlan[] = [
      "varied-street-v1",
      "ground-and-walls-v1",
      "two-quarters-v1",
      "building-rooms-street-v1",
    ];
    expect(measure(plans, sweepSeeds(3))).toEqual([]);
  }, 30_000);

  it("without the switch the taproom's kitchen door is closed off behind the bar", () => {
    P5.doorsStayJoined = false;
    const off = measure(["varied-street-v1"], sweepSeeds(2));
    expect(off.some((s) => s.includes('"Taproom"'))).toBe(true);
  }, 30_000);

  it("an archway counts as a way in: the inn's kitchen archway stays joined (stated-character-v1, hall seed 35)", () => {
    // its taproom's bar stools, a table, a chair and a bench closed the kitchen's archway off: the archway is an open
    // edge, a threshold but no door pair, and the check asked the door pairs only
    const plan = structuredClone(loadPlan("stated-character-v1"));
    for (const L of plan.levels)
      for (const st of L.structures ?? []) if (st.id === "hall") Object.assign(st, { seed: 35 });
    const r = resolvePlan(plan, pal);
    expect(checkPlayability(plan, r).filter((i) => i.code === "unreachable")).toEqual([]);
    expect(r.levels.flatMap((L) => cutDoors("stated@35", L))).toEqual([]);
  }, 30_000);
});
