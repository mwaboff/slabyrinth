/**
 * Floor lights stand against something (generator 5, switch lightsAgainstSomething; owner's screenshots 2026-11-23,
 * images 193, 195, 179: a brazier free in the middle of a ward's aisle, two in a stable's, one mid-room in a workshop).
 * Over stored plans with furnished rooms and cell rows, under a few seeds, for every light core puts on a room's floor
 * (the furnisher's, a cell's, an aisle's, a dead end's: not one on a table or hung on a wall):
 * - it stands against a wall or a window, or beside a piece that is no light (furniture, a pier), unless it is itself
 *   the room's focal piece;
 * - an open fire (a brazier, a floor torch) only in a room whose kind takes fire (gen/roomTraits.ts roomTakesFire).
 * Without the switch the cell rows' aisles get braziers by their own path (gen/rooms4/lights.ts floorLight).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FeatureType } from "../../../src/contracts/plan";
import { EDGE, type ResolvedLevel } from "../../../src/contracts/resolved";
import { featureInfo } from "../../../src/gen/catalog";
import { roomTakesFire } from "../../../src/gen/roomTraits";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { LevelGrid } from "../../../src/resolve/levelGrid";
import type { StoredPlan } from "../../fixtures";
import { sweepPlan, sweepSeeds } from "../../sweep/seeds";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

/** A feature the room passes placed: a room's own, a cell's of a cell row, its aisle's, a dead end's set. */
const ROOM_PIECE = /~(room|cell\d+|aisle|deadend)#\d+$/;
const SIDES = ["N", "E", "S", "W"] as const;
const STEP = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] } as const;

/** The room-placed floor lights of a level that stand free, and the open fires in rooms that take none. */
function faults(label: string, L: ResolvedLevel): { free: string[]; fire: string[] } {
  const g = new LevelGrid(L);
  const blocker = new Set<number>();
  for (const f of L.features) {
    const info = featureInfo(f.type);
    if (!f.blocking || info.light === true || f.type === "rug") continue;
    for (let dy = 0; dy < f.size[1]; dy++)
      for (let dx = 0; dx < f.size[0]; dx++) blocker.add(g.index(f.at[0] + dx, f.at[1] + dy));
  }
  const free: string[] = [];
  const fire: string[] = [];
  for (const f of L.features) {
    const info = featureInfo(f.type);
    if (!ROOM_PIECE.test(f.id) || info.light !== true || info.wallMounted || info.ceilingMounted) continue;
    const [x, y] = f.at;
    // (on a table or a shelf: its base above the floor)
    if (f.baseHeight - g.top(x, y) > 0.1) continue;
    const area = L.areas.find((a) => a.id === f.area);
    const kind = area?.roomKind ?? area?.purpose;
    if (info.openFire === true && kind !== undefined && !roomTakesFire(kind))
      fire.push(`${label} ${f.area}(${kind}) ${f.type} ${f.id}`);
    if (info.focusPiece === true) continue;
    const against = SIDES.some((s) => {
      const k = g.edgeKind(x, y, s);
      if (k === EDGE.WALL || k === EDGE.OPENING) return true;
      return blocker.has(g.index(x + STEP[s][0], y + STEP[s][1]));
    });
    if (!against) free.push(`${label} ${f.area}(${kind}) ${f.type} @${x},${y} ${f.id}`);
  }
  return { free, fire };
}

function measure(plans: readonly StoredPlan[], seeds: readonly number[]): { free: string[]; fire: string[] } {
  const out = { free: [] as string[], fire: [] as string[] };
  for (const name of plans)
    for (const seed of seeds)
      for (const L of resolvePlan(sweepPlan(name, seed), pal).levels) {
        const got = faults(`${name}@${seed}`, L);
        out.free.push(...got.free);
        out.fire.push(...got.fire);
      }
  return out;
}

const PLANS: readonly StoredPlan[] = [
  "cell-rows-town-v1",
  "building-rooms-street-v1",
  "dungeon-complex-v1",
  "purpose-lineup-v1",
  "inn-interior-v1",
  "interiors-lineup-v1",
];

describe("floor lights stand against something (lightsAgainstSomething)", () => {
  it("no room light stands free mid-floor, no open fire where the kind takes none (stored plans)", () => {
    const got = measure(PLANS, sweepSeeds(3));
    expect(got.free).toEqual([]);
    expect(got.fire).toEqual([]);
  }, 30_000);

  it("without the switch the cell rows' aisles stand braziers free in a stable and a ward", () => {
    const seeds = sweepSeeds(2);
    P5.lightsAgainstSomething = false;
    const off = measure(["cell-rows-town-v1"], seeds);
    expect(off.free.length).toBeGreaterThan(2);
    expect(off.fire.some((s) => /\((stable|ward)\) brazier/.test(s))).toBe(true);
  }, 30_000);

  it("the catalog's floor lights: an open fire is one that is a light", () => {
    for (const t of ["brazier", "torch_floor"] as FeatureType[]) {
      expect(featureInfo(t).light).toBe(true);
      expect(featureInfo(t).openFire).toBe(true);
    }
  });
});
