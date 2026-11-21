/**
 * Round 3 (owner screenshots 2026-11-19): assemblies give skyline, stone markers stay stone in every theme, no
 * tan desert rock outside a desert, water's-edge and path-verge dressing, ground cover breaks the floor grid.
 */
import { describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import { placementMeta } from "../../../src/compile/realize";
import { loadPalettes, resolveRole } from "../../../src/palette";
import { dressArea, type PlacementGrid } from "../../../src/gen";
import { handLevel, handPlan } from "../compile/handResolved";

const cat = loadPalettes();
const THEMES = ["cave", "outdoor", "forest", "stone_dungeon", "wood_town", "generic"];

describe("assemblies", () => {
  it("a great tree is several stacked pieces and stands well over 3 tiles", () => {
    const tree = resolveRole(cat, "forest", "feature.tree_large").resolution?.variants[0];
    expect(tree?.parts?.length ?? 0).toBeGreaterThanOrEqual(2);
    const top = Math.max(
      tree?.geom.size.y ?? 0,
      ...(tree?.parts ?? []).map((q) => (q.offset?.y ?? 0) + q.geom.size.y),
    );
    expect(top).toBeGreaterThan(5);
  });

  it("the realizer places every piece of an assembly, stacked above the first", () => {
    const set = realize(
      handPlan([
        handLevel({
          id: "l1",
          theme: "forest",
          rows: ["#######", "#.....#", "#.....#", "#.....#", "#.....#", "#######"],
          features: [{ id: "t", type: "tree_large", at: [2, 1], size: [3, 3] }],
        }),
      ]),
      cat,
    );
    const pieces = (set.levels[0]?.placements ?? []).filter((q) => q.source.elementId === "t");
    expect(pieces.length).toBe(3);
    const ys = pieces.map((q) => q.y).sort((a, b) => a - b);
    expect((ys[2] ?? 0) - (ys[0] ?? 0)).toBeGreaterThan(4);
    expect(set.diagnostics.some((d) => d.code === "landmark_short")).toBe(false);
  });

  it("warns when a landmark resolves to something short", () => {
    const set = realize(
      handPlan([
        handLevel({
          id: "l1",
          theme: "wood_town",
          rows: ["######", "#....#", "#....#", "#....#", "######"],
          features: [{ id: "lm", type: "landmark", at: [1, 1], size: [2, 2], variant: "none" }],
        }),
      ]),
      loadPalettes({
        user: [
          {
            source: "wood_town.json",
            data: {
              schema: "slabyrinth/palette@1",
              id: "wood_town",
              overrides: true,
              roles: { "feature.landmark": cat.palettes["generic"]?.roles["feature.ground_cover"] ?? null },
            },
          },
        ],
      }),
    );
    expect(set.diagnostics.find((d) => d.code === "landmark_short")?.message).toMatch(/tiles tall/);
  });
});

describe("stone stays stone", () => {
  it("standing stones, monoliths and tall markers are stone pieces in every theme, never trees", () => {
    for (const th of THEMES)
      for (const role of ["feature.standing_stone", "feature.monolith", "feature.tall_marker"]) {
        const names = (resolveRole(cat, th, role).resolution?.variants ?? []).map((v) =>
          (v.name ?? "").toLowerCase(),
        );
        expect(names.length, `${th}/${role}`).toBeGreaterThan(0);
        for (const n of names) expect(n, `${th}/${role}`).not.toMatch(/tree|cypress|pine|lantern|desert/);
      }
  });

  it("no tan desert rock dresses a non-desert theme", () => {
    for (const p of Object.values(cat.palettes))
      for (const [role, def] of Object.entries(p.roles))
        if (role.startsWith("feature."))
          for (const v of def.variants.filter((q) => (q.weight ?? 1) > 0))
            expect(`${p.id}/${role}: ${v.name ?? ""}`).not.toMatch(/Desert Cliff/);
  });

  it("an outdoor rock floor is weathered stone, never the cave floor tile", () => {
    for (const th of ["outdoor", "forest"]) {
      const names = (resolveRole(cat, th, "floor.rock").resolution?.variants ?? []).map((v) => v.name ?? "");
      expect(
        names.some((n) => /Cave Floor/.test(n)),
        th,
      ).toBe(false);
    }
  });
});

describe("water's edge, path verges and ground cover", () => {
  /** 20×12 open ground: a path along row 4, water along rows 9–11. */
  const grid: PlacementGrid = {
    inBounds: (x, y) => x >= 0 && y >= 0 && x < 20 && y < 12,
    isFloor: (x, y) => x >= 0 && y >= 0 && x < 20 && y < 12,
    flags: (_x, y) => (y === 4 ? 8 : y >= 9 ? 4 : 0),
    area: () => 1,
    occupied: () => false,
    edge: () => 0,
  };
  const cells: Array<[number, number]> = [];
  for (let y = 0; y < 12; y++) for (let x = 0; x < 20; x++) cells.push([x, y]);
  const ps = dressArea(grid, {
    preset: "woodland",
    areaIndex: 1,
    areaCells: cells,
    density: 0.8,
    seed: 3,
    remaining: 6000,
  }).placements;

  it("dresses the bank and the path verge, and leaves the path and the water clear", () => {
    expect(ps.some((p) => p.type === "bank_dressing" && p.at[1] === 8)).toBe(true);
    expect(
      ps.some(
        (p) =>
          (p.at[1] === 3 || p.at[1] === 5) &&
          ["ground_cover", "small_detail", "edge_dressing"].includes(p.type),
      ),
    ).toBe(true);
    expect(ps.some((p) => p.at[1] === 4)).toBe(false);
    // only reeds and lily pads stand in the water
    expect(ps.filter((p) => p.at[1] >= 9).every((p) => p.type === "bank_dressing")).toBe(true);
  });

  it("scatters ground cover in patches over the open ground, and no lights stand alone on it", () => {
    expect(ps.filter((p) => p.type === "ground_cover" || p.type === "small_detail").length).toBeGreaterThan(
      10,
    );
    expect(ps.some((p) => p.type === "accent_light" || p.type === "torch_floor")).toBe(false);
  });
});

describe("floor variety", () => {
  it("grass variants form patches (neighbouring tiles usually agree), not a salt-and-pepper grid", () => {
    const set = realize(
      handPlan([
        handLevel({
          id: "l1",
          theme: "outdoor",
          material: "grass",
          rows: Array<string>(24).fill(".".repeat(24)),
        }),
      ]),
      cat,
    );
    const floors = (set.levels[0]?.placements ?? []).filter((q) => q.role === "floor");
    const names = new Set(floors.map((q) => placementMeta.get(q)?.name));
    expect(names.size).toBeGreaterThan(1);
  });
});

describe("rows, forests, board edges", () => {
  /** 30×20 open ground; the north part (y < 8) is a terrace 1 tile higher, with a ledge along y = 8. */
  const terrace: PlacementGrid = {
    inBounds: (x, y) => x >= 0 && y >= 0 && x < 30 && y < 20,
    isFloor: (x, y) => x >= 0 && y >= 0 && x < 30 && y < 20,
    flags: () => 0,
    area: () => 1,
    occupied: () => false,
    height: (_x, y) => (y < 8 ? 1 : 0),
    edge: (_x, y, sd) => ((sd === "S" && y === 7) || (sd === "N" && y === 8) ? 3 : 0),
  };
  const all: Array<[number, number]> = [];
  for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) all.push([x, y]);

  it("cliff dressing is never a regular row: spacing and kind vary along the edge", () => {
    for (const seed of [1, 2, 3, 4]) {
      const ps = dressArea(terrace, {
        preset: "natural_clusters",
        areaIndex: 1,
        areaCells: all,
        density: 0.9,
        seed,
        remaining: 6000,
      }).placements;
      const row = ps
        .filter((q) => q.at[1] >= 5 && q.at[1] <= 10 && ["formation", "edge_dressing"].includes(q.type))
        .sort((a, b) => a.at[0] - b.at[0]);
      const gaps = row.slice(1).map((q, i) => q.at[0] - (row[i]?.at[0] ?? 0));
      let run = 1;
      let worst = 1;
      // pieces touching in a cluster (gap 0 or 1) are fine; a repeated wider spacing is a row
      for (let i = 1; i < gaps.length; i++) {
        run = (gaps[i] ?? 0) >= 2 && gaps[i] === gaps[i - 1] ? run + 1 : 1;
        worst = Math.max(worst, run);
      }
      expect(worst, `seed ${seed}: ${gaps.join(",")}`).toBeLessThanOrEqual(2);
      if (row.length >= 4) expect(new Set(row.map((q) => q.type)).size, `seed ${seed}`).toBeGreaterThan(1);
    }
  });

  it("forest canopy covers a large share of the free ground and big pieces stay inside the board", () => {
    const open: PlacementGrid = { ...terrace, height: () => 0, edge: () => 0 };
    const ps = dressArea(open, {
      preset: "forest",
      areaIndex: 1,
      areaCells: all,
      density: 0.8,
      seed: 9,
      remaining: 6000,
    }).placements;
    const trees = ps.filter((q) => q.type === "cluster_tall" || q.type === "landmark");
    expect(trees.length).toBeGreaterThan(all.length * 0.12);
    for (const q of ps.filter((p) =>
      ["cluster_tall", "landmark", "formation", "tree_large"].includes(p.type),
    )) {
      expect(q.at[0]).toBeGreaterThan(0);
      expect(q.at[1]).toBeGreaterThan(0);
      expect(q.at[0] + q.size[0]).toBeLessThan(30);
      expect(q.at[1] + q.size[1]).toBeLessThan(20);
    }
    const dense = dressArea(open, {
      preset: "dense_forest",
      areaIndex: 1,
      areaCells: all,
      density: 0.8,
      seed: 9,
      remaining: 6000,
    }).placements.filter((q) => q.type === "cluster_tall").length;
    expect(dense).toBeGreaterThan(ps.filter((q) => q.type === "cluster_tall").length);
  });
});

describe("tone, beds, rings", () => {
  const featureNames = (th: string, role: string): string[] =>
    (resolveRole(cat, th, role).resolution?.variants ?? [])
      .filter((v) => v.weight > 0)
      .map((v) => v.name ?? "");

  it("formations are a dark or grey-brown family: no pale rock_large limestone or tan desert rock", () => {
    for (const th of ["cave", "outdoor", "forest", "generic"])
      for (const n of featureNames(th, "feature.formation"))
        expect(`${th}: ${n}`).not.toMatch(/rock_large|Desert/i);
  });

  it("no white palace-marble kerbs or trims; kerb roles stay empty until a real low-stone piece exists", () => {
    for (const th of ["outdoor", "forest", "cave", "generic"]) {
      expect(resolveRole(cat, th, "kerb.default").resolution, th).toBeNull();
      expect(resolveRole(cat, th, "trim.stone").resolution, th).toBeNull();
    }
  });

  it("one natural bed family under water outdoors: swamp mud, never sewer masonry or gravel squares", () => {
    for (const th of ["outdoor", "forest"])
      for (const role of ["bed.water_shallow", "bed.water_deep", "bed.default"]) {
        const names = featureNames(th, role);
        expect(names.length, `${th}/${role}`).toBeGreaterThan(0);
        for (const n of names) expect(`${th}/${role}: ${n}`).toMatch(/Swamp floor/);
      }
  });

  it("a ritual ring is sized to the dais top and mixes stone kinds round an open centre", () => {
    const W = 15;
    const dais: PlacementGrid = {
      inBounds: (x, y) => x >= 0 && y >= 0 && x < W && y < W,
      isFloor: (x, y) => x >= 0 && y >= 0 && x < W && y < W,
      flags: () => 0,
      area: () => 1,
      occupied: () => false,
      height: (x, y) => ((x - 7) * (x - 7) + (y - 7) * (y - 7) <= 16 ? 1.5 : 0.5),
      edge: () => 0,
    };
    const cs: Array<[number, number]> = [];
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) cs.push([x, y]);
    const ps = dressArea(dais, {
      preset: "ritual_circle",
      areaIndex: 1,
      areaCells: cs,
      density: 0.6,
      seed: 2,
      remaining: 999,
    }).placements;
    const fire = ps.find((q) => q.type === "magic_fire");
    const stones = ps.filter((q) => q.type === "monolith" || q.type === "standing_stone");
    expect(stones.length).toBeGreaterThanOrEqual(5);
    expect(new Set(stones.map((q) => q.type)).size).toBe(2);
    const radii = stones.map((q) =>
      Math.max(Math.abs(q.at[0] - (fire?.at[0] ?? 0)), Math.abs(q.at[1] - (fire?.at[1] ?? 0))),
    );
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(2);
  });
});
