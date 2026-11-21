/**
 * Generator 3 terrain: caves with one ground, rifts and rivers that wander, stepped rivers
 * with falls and pools. Fixtures are original; each review note fires on the old output and is quiet on the new.
 */
import { describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import type { Feature, GeneratorVersion, Level, MapPlan, TerrainOp } from "../../../src/contracts/plan";
import { CELL, CELL_FLAG, type ResolvedPlan } from "../../../src/contracts/resolved";
import { loadPalettes } from "../../../src/palette";
import { createRoleResolver } from "../../../src/palette/resolve";
import { resolvePlan } from "../../../src/resolve";
import { courseShape } from "../../../src/resolve/chasm";
import { dominantAndCaused, familiesOfVariants, tonesClose } from "../../../src/resolve/floorFamilies";
import { reviewDesign, type DesignNoteCode } from "../../../src/review";
import { components, boxFill } from "../../../src/review/metrics";

function plan(
  generator: GeneratorVersion,
  kind: MapPlan["kind"],
  theme: string,
  level: Partial<Level>,
  w = 46,
  h = 34,
): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator,
    id: "t4",
    title: "T4",
    kind,
    theme,
    seed: 20261120,
    links: [],
    levels: [
      {
        id: "l1",
        name: "L1",
        elevation: 0,
        bounds: { x: 0, y: 0, w, h },
        base: { type: "ground", material: kind === "cave" ? "rock" : "grass" },
        areas: [],
        openings: [],
        walls: [],
        features: [],
        terrain: [],
        labels: [],
        ...level,
      },
    ],
  };
}

const cave = (generator: GeneratorVersion, level: Partial<Level>): MapPlan =>
  plan(generator, "cave", "cave", level);

const noteCodes = (p: MapPlan, r: ResolvedPlan = resolvePlan(p)): DesignNoteCode[] =>
  reviewDesign(p, r, { limit: 99 }).map((n) => n.code);

const statue: Feature = { id: "focus", type: "statue", at: [22, 16] };

describe("floor families (generator 3)", () => {
  it("never pairs a dark family with a light one; the second family is the caused one", () => {
    expect(tonesClose("dark", "light")).toBe(false);
    expect(tonesClose("dark", "mid")).toBe(true);
    expect(tonesClose("dark", undefined)).toBe(true);
    const fams = familiesOfVariants([
      { variant: "", weight: 1, uuid: "a" },
      { variant: "dark", weight: 0.7, uuid: "b", tone: "dark" },
      { variant: "pale", weight: 0.6, uuid: "c", tone: "light" },
      { variant: "lush", weight: 0.5, uuid: "d" },
    ]);
    const pick = dominantAndCaused(fams);
    expect(pick.dominant).toBe("");
    expect(pick.caused).toBe("lush");
    // a dark dominant family never takes a light second family
    const dark = dominantAndCaused(
      familiesOfVariants([
        { variant: "dark", weight: 1, uuid: "b", tone: "dark" },
        { variant: "pale", weight: 0.6, uuid: "c", tone: "light" },
      ]),
    );
    expect(dark).toEqual({ dominant: "dark", caused: null });
  });

  /** Share of the laid floor area (tiles) by family, from the built floor pieces. */
  const laidShares = (p: MapPlan): Map<string, number> => {
    const palettes = loadPalettes();
    const set = realize(resolvePlan(p), palettes, {});
    const variants = createRoleResolver(palettes)("cave", "floor.rock").resolution?.variants ?? [];
    const family = new Map(variants.map((v) => [v.uuid, v.variant ?? ""]));
    const area = new Map(variants.map((v) => [v.uuid, v.footprint[0] * v.footprint[1]]));
    const shares = new Map<string, number>();
    let total = 0;
    for (const pl of set.levels[0]?.placements ?? []) {
      if (pl.role !== "floor" || !family.has(pl.asset)) continue;
      const a = area.get(pl.asset) ?? 1;
      shares.set(family.get(pl.asset) as string, (shares.get(family.get(pl.asset) as string) ?? 0) + a);
      total += a;
    }
    for (const [k, v] of shares) shares.set(k, v / total);
    return shares;
  };

  it("a cave floor is one dominant family (70% or more) at generator 3, a quilt at generator 2", () => {
    const g3 = laidShares(cave(3, { features: [statue] }));
    const g2 = laidShares(cave(2, { features: [statue] }));
    expect(Math.max(...g3.values())).toBeGreaterThanOrEqual(0.7);
    expect(g3.size).toBeLessThanOrEqual(2);
    expect(Math.max(...g2.values())).toBeLessThan(0.7);
    expect(g2.size).toBeGreaterThanOrEqual(3);
  });

  it("floor_patchwork stays quiet on the new cave floor and fires on the old one", () => {
    expect(noteCodes(cave(3, { features: [statue] }))).not.toContain("floor_patchwork");
    expect(noteCodes(cave(2, { features: [statue] }))).toContain("floor_patchwork");
  });

  it("trees on a lattice cannot turn the generator 3 floor into a quilt (patches stay a few percent)", () => {
    const trees: Feature[] = [];
    for (let y = 1; y < 33; y += 2)
      for (let x = 1; x < 45; x += 2) trees.push({ id: `t${x}_${y}`, type: "tree", at: [x, y] });
    const shares = laidShares(cave(3, { features: [statue, ...trees] }));
    expect(Math.max(...shares.values())).toBeGreaterThanOrEqual(0.7);
  });

  it("a crowded review keeps floor_patchwork (the cap never drops it)", () => {
    const p = cave(2, { features: [statue] });
    const r = resolvePlan(p);
    const all = reviewDesign(p, r, { limit: 99 });
    expect(all.map((n) => n.code)).toContain("floor_patchwork");
    expect(reviewDesign(p, r, { limit: 1 }).map((n) => n.code)).toContain("floor_patchwork");
  });

  it("a platform in a cave is rock with a ragged outline unless the plan asks for worked stone", () => {
    const dais = (extra: Partial<Extract<TerrainOp, { op: "platform" }>>): TerrainOp => ({
      id: "dais",
      op: "platform",
      shape: { type: "circle", cx: 23, cy: 17, r: 7 },
      tiers: 2,
      rise: 0.5,
      ...extra,
    });
    const raised = (p: MapPlan): Array<[number, number]> => {
      const l = resolvePlan(p).levels[0];
      const out: Array<[number, number]> = [];
      for (let i = 0; i < 46 * 34; i++)
        if ((l?.cells.height[i] ?? 0) > 0) out.push([i % 46, Math.floor(i / 46)]);
      return out;
    };
    const mat = (p: MapPlan, x: number, y: number): string | undefined => {
      const l = resolvePlan(p).levels[0];
      return l?.materials[(l.cells.material[y * 46 + x] ?? 1) - 1];
    };
    const wild3 = cave(3, { terrain: [dais({})] });
    const wild2 = cave(2, { terrain: [dais({})] });
    const worked = cave(3, {
      terrain: [dais({ material: "stone_tile", topMaterial: "marble", edge: "clean" })],
    });
    const biggest = (p: MapPlan): number => {
      const parts = components(raised(p)).sort((a, b) => b.length - a.length);
      return parts[0] ? boxFill(parts[0]) : 0;
    };
    expect(mat(wild3, 23, 17)).toBe("rock");
    // the outline is ragged (it fills less of its box) where a clean dais is a regular disc
    expect(biggest(wild3)).toBeLessThan(biggest(worked));
    expect(mat(worked, 23, 17)).toBe("marble");
    // generator 2 keeps its clean dais
    expect(Math.abs(biggest(wild2) - biggest(worked))).toBeLessThan(0.05);
  });
});

describe("a gentle knoll is one mound (generator 3)", () => {
  const knoll = (generator: GeneratorVersion): MapPlan =>
    plan(
      generator,
      "outdoor",
      "outdoor",
      {
        terrain: [
          {
            id: "knoll",
            op: "platform",
            shape: { type: "rect", x: 6, y: 6, w: 28, h: 20 },
            tiers: 2,
            rise: 0.5,
            inset: 2,
            material: "grass",
            edge: "ragged",
          },
        ],
      },
      40,
      32,
    );
  it("two half-tile plates become one tile-high step at generator 3; square_terraces fires on the plates only", () => {
    const heights = (p: MapPlan): Set<number> => {
      const l = resolvePlan(p).levels[0];
      return new Set(Array.from(l?.cells.height ?? []).filter((h) => h > 0));
    };
    expect([...heights(knoll(2))].sort()).toEqual([2, 4]);
    expect([...heights(knoll(3))]).toEqual([4]);
    expect(noteCodes(knoll(2))).toContain("square_terraces");
    expect(noteCodes(knoll(3))).not.toContain("square_terraces");
  });
});

describe("rifts and rivers wander (generator 3)", () => {
  const rift = (
    generator: GeneratorVersion,
    extra: Partial<Extract<TerrainOp, { op: "chasm" }>> = {},
  ): MapPlan =>
    cave(generator, {
      terrain: [
        {
          id: "rift",
          op: "chasm",
          points: [
            [20, 0],
            [21, 34],
          ],
          width: 4,
          depth: 3,
          floor: "lava",
          bridges: [{ at: 0.45, width: 2, floor: "flagstone", span: "arch" }],
          ...extra,
        },
      ],
      features: [statue],
    });

  it("a long rift strays about a fifth of its length from the line between its ends, with two or more bends", () => {
    const l = resolvePlan(rift(3)).levels[0];
    const ch = l?.channels?.[0];
    expect(ch?.kind).toBe("rift");
    const s = courseShape(ch?.centre as Array<[number, number]>);
    expect(s.chord).toBeGreaterThan(30);
    expect(s.deviation / s.chord).toBeGreaterThanOrEqual(0.16);
    expect(s.bends).toBeGreaterThanOrEqual(2);
    // it still meets its ends (the board edges the plan named) and its width varies by a cell or more
    const first = ch?.centre[0] as [number, number];
    const last = ch?.centre[ch.centre.length - 1] as [number, number];
    expect(first[1]).toBeLessThan(1.5);
    expect(last[1]).toBeGreaterThan(32.5);
    const wide = ch?.widths ?? [];
    expect(Math.max(...wide) - Math.min(...wide)).toBeGreaterThanOrEqual(1);
  });

  it("its bridge still lands on both banks and the plan has no errors", () => {
    const r = resolvePlan(rift(3));
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.issues.some((i) => i.code === "no_effect")).toBe(false);
    expect(r.levels[0]?.bridges?.length).toBe(1);
  });

  it("straight_natural fires on a rift drawn straight (meander 0) and is quiet on the wandering one", () => {
    const straight = rift(3, { meander: 0 });
    const rs = resolvePlan(straight);
    const sh = courseShape(rs.levels[0]?.channels?.[0]?.centre ?? []);
    expect(sh.deviation / sh.chord).toBeLessThan(0.16);
    const fired = reviewDesign(straight, rs, { limit: 99 }).filter(
      (n) => n.code === "straight_natural" && n.elementIds?.includes("rift"),
    );
    expect(fired.length).toBe(1);
    expect(
      reviewDesign(rift(3), resolvePlan(rift(3)), { limit: 99 }).some(
        (n) => n.code === "straight_natural" && n.elementIds?.includes("rift"),
      ),
    ).toBe(false);
  });

  it("generator 2 keeps its channel as it was (no record, no wander)", () => {
    const l = resolvePlan(rift(2)).levels[0];
    expect(l?.channels).toBeUndefined();
    expect(l?.falls).toBeUndefined();
  });

  it("courseShape counts an arc as one bend and an S as two", () => {
    const arc: Array<[number, number]> = [];
    const ess: Array<[number, number]> = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      arc.push([i, 4 * Math.sin(Math.PI * t)]);
      ess.push([i, 4 * Math.sin(2 * Math.PI * t)]);
    }
    expect(courseShape(arc).bends).toBe(1);
    expect(courseShape(ess).bends).toBe(2);
    expect(courseShape(arc).deviation).toBeCloseTo(4, 0);
  });
});

describe("stepped rivers (generator 3)", () => {
  /** A hillside of three terraces falling to the south with a brook coming down it. */
  const glen = (
    generator: GeneratorVersion,
    riseTiles = 2,
    brook: Partial<Extract<TerrainOp, { op: "chasm" }>> = {},
  ): MapPlan => {
    const slope = (id: string, h: number): TerrainOp => ({
      id,
      op: "platform",
      shape: { type: "rect", x: 0, y: 0, w: 36, h },
      tiers: 1,
      rise: riseTiles,
      material: "grass",
      edge: "ragged",
    });
    return plan(
      generator,
      "outdoor",
      "forest",
      {
        terrain: [
          slope("a", 24),
          slope("b", 16),
          slope("c", 8),
          {
            id: "brook",
            op: "chasm",
            points: [
              [18, 0],
              [20, 9],
              [17, 19],
              [19, 31],
            ],
            width: 3,
            depth: 1,
            floor: "water_shallow",
            meander: 0.5,
            ...brook,
          },
        ],
      },
      36,
      32,
    );
  };

  const wet = (r: ResolvedPlan): number[] => {
    const l = r.levels[0];
    const out: number[] = [];
    for (let i = 0; i < 36 * 32; i++)
      if (l && l.cells.state[i] === CELL.OPEN && ((l.cells.flags[i] ?? 0) & CELL_FLAG.WATER) !== 0)
        out.push(i);
    return out;
  };

  it("a river that drops 6 tiles is split into reaches with falls of 1 to 3 tiles between them", () => {
    const r = resolvePlan(glen(3));
    const falls = r.levels[0]?.falls ?? [];
    expect(falls.length).toBeGreaterThanOrEqual(3);
    for (const f of falls) {
      expect(f.drop).toBeGreaterThanOrEqual(1);
      expect(f.drop).toBeLessThanOrEqual(3);
      expect(f.top).toBeGreaterThan(f.bottom);
      expect(f.bedTop - f.bedBottom).toBeCloseTo(f.drop, 5);
      expect(f.lip.length).toBeGreaterThanOrEqual(1);
      expect(["N", "E", "S", "W"]).toContain(f.side);
      expect(f.river).toBe("brook");
      // a pool wider than the channel at its foot: more cells than the lip, two cells wider across
      expect(f.pool.length).toBeGreaterThanOrEqual(f.width * 4);
    }
    // downstream falls start lower
    for (let i = 1; i < falls.length; i++)
      expect((falls[i] as { top: number }).top).toBeLessThan((falls[i - 1] as { top: number }).top);
    // reaches are level: the bed of every water cell is one of a few heights, not a slope
    const l = r.levels[0];
    const beds = new Set(wet(r).map((i) => l?.cells.height[i]));
    expect(beds.size).toBeLessThanOrEqual(falls.length + 2);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("the board water plane follows the lowest reach, and the level records its range", () => {
    const l = resolvePlan(glen(3)).levels[0];
    const falls = l?.falls ?? [];
    expect(l?.waterLevel).toBeDefined();
    expect(l?.waterRange).toBeDefined();
    const lowest = Math.min(...falls.map((f) => f.bottom));
    expect(Math.abs((l?.waterLevel ?? 99) - lowest)).toBeLessThan(0.6);
  });

  it("a river that drops under 2 tiles stays one level (no fall)", () => {
    const l = resolvePlan(glen(3, 0.25)).levels[0];
    expect(l?.falls).toBeUndefined();
  });

  it("generator 2 is untouched: no falls, no records", () => {
    const l = resolvePlan(glen(2)).levels[0];
    expect(l?.falls).toBeUndefined();
    expect(l?.channels).toBeUndefined();
    expect(l?.waterRange).toBeUndefined();
  });

  it("river_trench: quiet on the stepped river, fires when the same river is cut to one level", () => {
    const p = glen(3);
    const r = resolvePlan(p);
    expect(noteCodes(p, r)).not.toContain("river_trench");
    // the old output: every water cell at the lowest bed, no falls
    const l = r.levels[0];
    if (!l) throw new Error("no level");
    const cells = wet(r);
    const lowest = Math.min(...cells.map((i) => l.cells.height[i] as number));
    for (const i of cells) l.cells.height[i] = lowest;
    delete l.falls;
    const old = reviewDesign(p, r, { limit: 99 }).filter((n) => n.code === "river_trench");
    expect(old.length).toBe(1);
    expect(old[0]?.message).toMatch(/no fall/);
  });

  it("a crossing bridge still spans the lowest reach", () => {
    const r = resolvePlan(
      glen(3, 2, { bridges: [{ at: 0.9, width: 2, floor: "bridge_wood", span: "plank" }] }),
    );
    expect(r.levels[0]?.bridges?.length).toBe(1);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});
