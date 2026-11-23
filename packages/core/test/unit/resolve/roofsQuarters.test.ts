/**
 * The roofs-and-quarters round (generator 5): each fault of the owner's 2026-11-23 screenshots (findings 14-18), held by
 * the switch that fixes it, measured on the build (the switch off rebuilds the fault):
 *   closedWornRoofs   only a ruin's roof is open: worn roofs keep every piece, a ramshackle one a small ragged hole
 *                     with boards under it, and an opening follows its own cells, never a piece's rectangle.
 *   roofFormsFit      no shed over a house's depth (its high side stood as a bare wall), and a theme without a flat
 *                     roof kit of its own (wood_town) roofs its drawn buildings pitched unless the plan says otherwise.
 */
import { afterEach, describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import type { MapPlan } from "../../../src/contracts/plan";
import type { ResolvedPlan, ResolvedStructure } from "../../../src/contracts/resolved";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile, type SwitchName } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { loadPlan, type StoredPlan } from "../../fixtures";
import { sweepSeed } from "../../sweep/seeds";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));
/** Generator 5 with one switch off, for the rest of the test (restored after it). */
const without = (name: SwitchName): void => {
  (P5 as Record<string, unknown>)[name] = false;
};

/** A fixture at sweep seed `i`, the buildings' own seeds dropped (each draws anew). */
function atSeed(name: StoredPlan, i: number, theme?: string): MapPlan {
  const plan = loadPlan(name);
  return {
    ...plan,
    ...(theme ? { theme } : {}),
    seed: sweepSeed(i),
    levels: plan.levels.map((L) => ({
      ...L,
      structures: (L.structures ?? []).map((s) => {
        const rest = { ...s } as typeof s & { seed?: number };
        delete rest.seed;
        return rest;
      }),
    })),
  };
}

const building = (r: ResolvedPlan, id: string): ResolvedStructure => {
  const st = r.levels[0]?.structures?.find((s) => s.id === id);
  if (!st) throw new Error(`no ${id}`);
  return st;
};

/** The plan cells the built pieces of one element cover, read off their boxes (row = Hg - 1 - z: compile/geometry.ts). */
function coveredCells(r: ResolvedPlan, elementId: string): Set<string> {
  const L = r.levels[0];
  if (!L) throw new Error("no level");
  const set = realize(r, pal, {});
  const hg = L.bounds.y + L.bounds.h;
  const covered = new Set<string>();
  for (const p of set.levels[0]?.placements ?? []) {
    if (p.source.elementId !== elementId) continue;
    const box = set.placed.get(p)?.box;
    if (!box) continue;
    for (let x = Math.floor(box.min.x + 0.01); x < Math.ceil(box.max.x - 0.01); x++)
      for (let z = Math.floor(box.min.z + 0.01); z < Math.ceil(box.max.z - 0.01); z++)
        covered.add(`${x},${hg - 1 - z}`);
  }
  return covered;
}

/** The cells of a building's top storey (its main volume's) that no roof piece covers. */
function openRoofCells(r: ResolvedPlan, id: string): string[] {
  const st = building(r, id);
  const covered = coveredCells(r, `${id}~roof`);
  const main = st.volumes?.find((v) => v.on === null) ?? st.volumes?.[0];
  const top = main?.storeys[main.storeys.length - 1];
  return (top?.cells ?? [])
    .map(([x, y]) => `${x},${y}`)
    .filter((k) => !covered.has(k))
    .sort();
}

const holesOf = (st: ResolvedStructure): string[] =>
  (st.ruin?.roofHoles ?? []).map(([x, y]) => `${x},${y}`).sort();

describe("closedWornRoofs: only a ruin's roof is open", () => {
  const seeds = [0, 1, 2, 3, 4, 5];
  it("gives a worn roof no hole and a ramshackle one at most one small hole off its edge, over many seeds", () => {
    for (const i of seeds) {
      const r = resolvePlan(atSeed("condition-street-v1", i), pal);
      expect(building(r, "worn").ruin?.roofHoles).toBeUndefined();
      const shack = building(r, "shack");
      const holes = shack.ruin?.roofHoles ?? [];
      expect(holes.length).toBeLessThanOrEqual(3);
      const own = new Set(shack.cells.map(([x, y]) => `${x},${y}`));
      for (const [x, y] of holes)
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const)
          expect(own.has(`${x + dx},${y + dy}`)).toBe(true);
    }
  });

  it("opens exactly the hole's own cells in the built roof (no piece's rectangle); without the switch a bigger patch", () => {
    const r = resolvePlan(atSeed("condition-street-v1", 0), pal);
    const shack = building(r, "shack");
    expect(holesOf(shack).length).toBeGreaterThan(1);
    expect(openRoofCells(r, "shack")).toEqual(holesOf(shack));
    expect(openRoofCells(r, "worn")).toEqual([]);
    without("closedWornRoofs");
    const before = resolvePlan(atSeed("condition-street-v1", 0), pal);
    expect(holesOf(building(before, "worn")).length).toBeGreaterThan(4);
    expect(openRoofCells(before, "shack").length).toBeGreaterThan(holesOf(shack).length + 4);
  });

  it("shows boards under every cell of a ramshackle roof's hole, decked or not", () => {
    for (const deck of [true, false]) {
      const plan = atSeed("condition-street-v1", 0);
      const r = resolvePlan(plan, pal);
      const shack = building(r, "shack");
      for (const v of shack.volumes ?? []) v.roof.deck = deck;
      const boards = coveredCells(r, "shack~deck");
      expect(holesOf(shack).length).toBeGreaterThan(0);
      for (const k of holesOf(shack)) expect([deck, k, boards.has(k)]).toEqual([deck, k, true]);
    }
  });

  it("patches a worn village roof (no worn pieces, no kit of its tone) in another kit's slopes; without the switch not at all", () => {
    const plan = loadPlan("condition-street-v1");
    const village: MapPlan = {
      ...plan,
      levels: plan.levels.map((L) => ({
        ...L,
        structures: (L.structures ?? []).map((s) =>
          s.kind === "enclosure" ? s : { ...s, roof: { type: "gable" as const, style: "village" } },
        ),
      })),
    };
    const patched = (): number => {
      const sts = resolvePlan(village, pal).levels[0]?.structures ?? [];
      return sts.filter((s) => (s.roofPatch?.length ?? 0) > 0).length;
    };
    expect(patched()).toBeGreaterThan(0);
    without("closedWornRoofs");
    expect(patched()).toBe(0);
  });
});

describe("roofFormsFit: roof forms that fit the theme and the footprint", () => {
  /** Drawn buildings of the varied street over `n` sweep seeds in a theme: their roof form and depth from the street. */
  function drawnRoofs(theme: string, n: number): Array<{ roof: string; depth: number }> {
    const out: Array<{ roof: string; depth: number }> = [];
    for (let i = 0; i < n; i++) {
      const plan = atSeed("varied-street-v1", i, theme);
      const r = resolvePlan(plan, pal);
      for (const st of r.levels[0]?.structures ?? []) {
        const spec = plan.levels[0]?.structures?.find((s) => s.id === st.id) as
          { wings?: Array<{ w: number; h: number }>; front?: string } | undefined;
        const w = spec?.wings?.[0];
        if (!st.design || !w) continue;
        out.push({ roof: st.design.roof, depth: spec.front === "E" || spec.front === "W" ? w.w : w.h });
      }
    }
    return out;
  }

  it("draws no shed over a depth of more than three cells; without the switch some", () => {
    const deepSheds = (): number =>
      drawnRoofs("wood_town", 8).filter((d) => d.roof === "shed" && d.depth > 3).length;
    expect(deepSheds()).toBe(0);
    without("roofFormsFit");
    expect(deepSheds()).toBeGreaterThan(0);
  }, 30_000); // (16 street builds)

  it("roofs a timber village's drawn buildings flat far more rarely than without the switch; the city keeps its own", () => {
    const flats = (theme: string): number => drawnRoofs(theme, 6).filter((d) => d.roof === "flat").length;
    const wood = flats("wood_town");
    const city = flats("city");
    without("roofFormsFit");
    const woodBefore = flats("wood_town");
    expect(woodBefore).toBeGreaterThan(2);
    expect(wood).toBeLessThan(woodBefore / 2);
    // (the city's own flat kit keeps its share; a shed turned gable may move the draws a little)
    expect(city).toBeGreaterThan(flats("city") * 0.75);
  }, 30_000); // (24 street builds)
});
