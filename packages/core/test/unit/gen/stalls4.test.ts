/**
 * Covered market stalls (generator 4): a stall is built from parts (base, counters, posts, canopy, seat, light), stalls
 * differ in size, goods, open side and canopy form, stand loosely, and a theme without the parts keeps the table.
 * Everything here is gated on generator 4: a generator-3 plan resolves to the old table stalls (the generator-3 golden
 * pins that).
 */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import type { ResolvedLevel } from "../../../src/contracts/resolved";
import { layoutStalls4, layoutStalls, stallCell } from "../../../src/gen/market";
import { realize, placementBoxes, placementMeta } from "../../../src/compile/realize";
import { verifyBuild } from "../../../src/compile/verify";
import { loadPalettes } from "../../../src/palette/load";
import { createPaletteView, paletteOptionsFor } from "../../../src/palette/view";
import { coveredStallForms } from "../../../src/palette/stallParts";
import { STALL_KINDS } from "../../../src/contracts/plan";
import { STALL_KIND_INFO, stallKindInfo, stallPieceOf } from "../../../src/gen/market";
import { GOODS_FAMILIES, SMALL_THINGS_ROLES, SURFACE_LOAD, featureRoles } from "../../../src/gen/surfaces";
import { buildPlanDisplayList } from "../../../src/render";
import { resolvePlan } from "../../../src/resolve";
import { reviewDesign } from "../../../src/review";

function marketPlan(
  generator: 3 | 4,
  theme = "wood_town",
  seed = 5121,
  extra: Partial<MapPlan["levels"][number]> = {},
): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator,
    id: "stalls-test",
    title: "Stall test",
    kind: "town",
    theme,
    seed,
    links: [],
    levels: [
      {
        id: "g",
        name: "Pad",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 34, h: 14 },
        outline: "rect",
        base: { type: "ground", material: "grass" },
        areas: [
          {
            id: "pad",
            kind: "courtyard",
            name: "Pad",
            key: "1",
            shape: { type: "rect", x: 1, y: 1, w: 32, h: 12 },
            floor: "cobble",
            walls: "none",
          },
        ],
        openings: [],
        walls: [],
        features: [],
        labels: [],
        terrain: [],
        stalls: [
          {
            id: "row",
            area: { x: 2, y: 2, w: 30, h: 10 },
            goods: ["fruit", "vegetables", "bread", "empty", "magic", "potions", "spices", "weapons"],
            aisle: 2,
          },
        ],
        ...extra,
      },
    ],
  };
}

const free = (): boolean => true;
const ROW = {
  id: "r",
  area: { x: 0, y: 0, w: 30, h: 10 },
  goods: ["fruit", "bread", "empty", "magic"] as const,
};

describe("layoutStalls4", () => {
  it("is seeded and deterministic", () => {
    const a = layoutStalls4({ ...ROW, goods: [...ROW.goods] }, free, 11, ["gable", "flat"]);
    const b = layoutStalls4({ ...ROW, goods: [...ROW.goods] }, free, 11, ["gable", "flat"]);
    expect(b).toEqual(a);
    expect(layoutStalls4({ ...ROW, goods: [...ROW.goods] }, free, 12, ["gable", "flat"])).not.toEqual(a);
  });

  it("draws several footprints, kinds and canopy forms, and some stalls are open to a different side", () => {
    const seen = {
      sizes: new Set<string>(),
      kinds: new Set<string>(),
      forms: new Set<string>(),
      fronts: new Set<string>(),
    };
    for (let seed = 1; seed <= 12; seed++)
      for (const p of layoutStalls4({ ...ROW, goods: [...ROW.goods] }, free, seed, ["gable", "flat"])) {
        seen.sizes.add(p.build ? p.build.size : "table");
        seen.kinds.add(p.kind);
        if (p.build) {
          seen.forms.add(p.build.form);
          seen.fronts.add(p.build.front);
        }
      }
    expect([...seen.sizes]).toEqual(expect.arrayContaining(["small", "medium", "large", "table"]));
    expect(seen.sizes.size).toBeGreaterThanOrEqual(5);
    expect([...seen.kinds]).toEqual(expect.arrayContaining(["fruit", "empty", "magic"]));
    expect([...seen.forms].sort()).toEqual(["flat", "gable"]);
    expect(seen.fronts.size).toBeGreaterThanOrEqual(3);
  });

  it("keeps every stall inside the rectangle, apart from the others, with its front on the lane side", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const out = layoutStalls4({ ...ROW, goods: [...ROW.goods] }, free, seed, ["gable", "flat"]);
      expect(out.length).toBeGreaterThan(5);
      const taken = new Set<string>();
      for (const p of out) {
        for (let y = p.at[1]; y < p.at[1] + p.size[1]; y++)
          for (let x = p.at[0]; x < p.at[0] + p.size[0]; x++) {
            expect(x >= 0 && y >= 0 && x < 30 && y < 10).toBe(true);
            expect(taken.has(`${x},${y}`)).toBe(false);
            taken.add(`${x},${y}`);
          }
        if (p.build) {
          // the build's own footprint matches the placement, and its front row lies on the placed side
          const [w, d] = p.build.front === "S" || p.build.front === "N" ? p.size : [p.size[1], p.size[0]];
          expect([p.build.w, p.build.d]).toEqual([w, d]);
          const front = stallCell(p.build.front, p.at, p.size, 0, 0);
          const back = stallCell(p.build.front, p.at, p.size, 0, p.build.d - 1);
          const dir: Record<"S" | "N" | "E" | "W", [number, number]> = {
            S: [0, -1],
            N: [0, 1],
            E: [-1, 0],
            W: [1, 0],
          };
          const step = dir[p.build.front];
          expect([back[0] - front[0], back[1] - front[1]]).toEqual([
            step[0] * (p.build.d - 1),
            step[1] * (p.build.d - 1),
          ]);
        }
      }
    }
  });

  it("does not stand in a regular grid: the gaps and the setbacks differ along a row", () => {
    const out = layoutStalls4({ ...ROW, goods: [...ROW.goods] }, free, 5, ["gable", "flat"]);
    const north = out.filter((p) => p.build?.front === "S" || p.rot === 0).sort((a, b) => a.at[0] - b.at[0]);
    const gaps = north
      .slice(1)
      .map(
        (p, i) =>
          p.at[0] -
          ((north[i] as (typeof north)[number]).at[0] + (north[i] as (typeof north)[number]).size[0]),
      );
    expect(new Set(gaps).size).toBeGreaterThan(1);
    expect(new Set(north.map((p) => p.at[1] + p.size[1])).size).toBeGreaterThan(1);
  });

  it("only uses free cells, and leaves the generator-3 layout alone", () => {
    const blocked = (x: number): boolean => x >= 10 && x < 14;
    for (const p of layoutStalls4({ ...ROW, goods: [...ROW.goods] }, (x) => !blocked(x), 3, ["flat"]))
      for (let x = p.at[0]; x < p.at[0] + p.size[0]; x++) expect(blocked(x)).toBe(false);
    // generator 3 still lays 2x1 tables with no build
    for (const p of layoutStalls({ ...ROW, goods: [...ROW.goods] }, free, 3)) {
      expect(p.build).toBeUndefined();
      expect(p.size[0] * p.size[1]).toBe(2);
    }
  });
});

describe("generator 4 stalls in a resolved plan", () => {
  it("a generator-4 plan carries builds; the same plan at generator 3 has plain tables", () => {
    const g4 = resolvePlan(marketPlan(4));
    const stalls4 = g4.levels[0]?.features.filter((f) => f.type === "stall") ?? [];
    expect(stalls4.length).toBeGreaterThan(5);
    expect(stalls4.some((f) => f.stall !== undefined)).toBe(true);
    const g3 = resolvePlan(marketPlan(3));
    const stalls3 = g3.levels[0]?.features.filter((f) => f.type === "stall") ?? [];
    expect(stalls3.length).toBeGreaterThan(3);
    expect(stalls3.every((f) => f.stall === undefined && f.size[0] * f.size[1] === 2)).toBe(true);
  });
});

describe("stock beside the stalls", () => {
  it("some stalls have a crate, barrel or sack on a free cell behind or beside them, never inside another stall", () => {
    const L = resolvePlan(marketPlan(4)).levels[0] as ResolvedLevel;
    const stock = L.features.filter((f) => f.id.endsWith("#stock"));
    expect(stock.length).toBeGreaterThan(0);
    const cells = new Map<string, string>();
    for (const f of L.features)
      for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
        for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) {
          if (f.type !== "stall" && !f.id.endsWith("#stock")) continue;
          expect(cells.has(`${x},${y}`), `${f.id} overlaps ${cells.get(`${x},${y}`)}`).toBe(false);
          cells.set(`${x},${y}`, f.id);
        }
  });
});

describe("the realized stall", () => {
  const catalog = loadPalettes();
  const plan = marketPlan(4);
  const resolved = resolvePlan(plan);
  const set = realize(resolved, catalog, {});
  const L = resolved.levels[0] as ResolvedLevel;
  const built = L.features.filter((f) => f.type === "stall" && f.stall !== undefined);
  const parts = (
    id: string,
  ): Array<{ name: string; box: NonNullable<ReturnType<typeof placementBoxes.get>> }> =>
    (set.levels[0]?.placements ?? [])
      .filter((p) => p.source.elementId === id)
      .map((p) => ({
        name: placementMeta.get(p)?.name ?? "",
        box: placementBoxes.get(p) as NonNullable<ReturnType<typeof placementBoxes.get>>,
      }));

  it("is made of a base, counters, four posts and a canopy, stacked from the floor up", () => {
    expect(built.length).toBeGreaterThan(4);
    for (const f of built) {
      const ps = parts(f.id);
      const base = ps.filter((p) => p.name === "Stall Corner Empty");
      expect(base.length).toBe((f.stall?.w ?? 0) * (f.stall?.d ?? 0));
      const posts = ps.filter((p) => /Harbor Beam 0[12]/.test(p.name));
      expect(posts.length).toBeGreaterThanOrEqual(4);
      const canopy = ps.filter((p) => /Tent (Roof|Overhang)/.test(p.name));
      expect(canopy.length).toBeGreaterThan(0);
      const floor = f.baseHeight;
      expect(Math.min(...ps.map((p) => p.box.min.y))).toBeCloseTo(floor, 3);
      // posts stand on the base, the canopy rests on the post tops
      for (const p of posts) expect(p.box.min.y).toBeCloseTo(floor + 0.5, 3);
      const postTop = Math.max(...posts.map((p) => p.box.max.y));
      for (const c of canopy) expect(c.box.min.y).toBeCloseTo(postTop, 3);
      // every canopy piece lies over the footprint
      const x0 = f.at[0];
      const x1 = f.at[0] + f.size[0];
      for (const c of canopy) {
        expect(c.box.min.x).toBeGreaterThanOrEqual(x0 - 0.01);
        expect(c.box.max.x).toBeLessThanOrEqual(x1 + 0.02);
      }
    }
  });

  it("an empty stall has no goods; a vegetable stall has its tray tiles; stalls differ in footprint", () => {
    const empty = built.find((f) => f.variant === "empty");
    if (empty)
      expect(parts(empty.id).some((p) => /basket|bread|jug|sack|Pumpkin|Cheese/i.test(p.name))).toBe(false);
    const veg = built.find((f) => f.variant === "vegetables" && f.stall?.gap !== 0);
    if (veg) expect(parts(veg.id).some((p) => /Stall Vegetables/.test(p.name))).toBe(true);
    expect(new Set(built.map((f) => `${f.size[0]}x${f.size[1]}`)).size).toBeGreaterThanOrEqual(3);
  });

  it("verifies clean: no overlaps, floating or unsupported pieces", () => {
    const v = verifyBuild(resolved, set, catalog);
    const bad = v.diagnostics.filter(
      (d) =>
        d.severity !== "info" &&
        /^verify_(props_overlap|prop_floating|prop_sunk|prop_no_floor|prop_outside)/.test(d.code),
    );
    expect(bad.map((d) => d.message)).toEqual([]);
  });

  it("a theme without the canopy parts keeps the generator-3 table stall", () => {
    const stripped = { ...catalog, palettes: structuredClone(catalog.palettes) };
    for (const p of Object.values(stripped.palettes))
      delete (p.roles as Record<string, unknown>)["stall.canopy"];
    // the resolver asks the same palettes the compiler gets (a view of them): no canopy, no covered stall
    const none = resolvePlan(plan, { palette: createPaletteView(stripped) });
    expect(
      none.levels[0]?.features.filter((f) => f.type === "stall").every((f) => f.stall === undefined),
    ).toBe(true);
    // the realizer given a palette without the parts falls back too (no throw, the table is there)
    const out = realize(resolved, stripped, {});
    const first = built[0] as (typeof built)[number];
    const names = (out.levels[0]?.placements ?? [])
      .filter((p) => p.source.elementId === first.id)
      .map((p) => placementMeta.get(p)?.name ?? "");
    expect(names.some((n) => /^Harbor Beam 0[12]$/.test(n))).toBe(false);
  });

  it("the sci-fi city theme builds flat-roofed stalls from its own pieces", () => {
    const city = resolvePlan(marketPlan(4, "city"));
    const stalls = city.levels[0]?.features.filter((f) => f.type === "stall" && f.stall !== undefined) ?? [];
    expect(stalls.length).toBeGreaterThan(3);
    expect(stalls.every((f) => f.stall?.form === "flat")).toBe(true);
    const out = realize(city, catalog, {});
    const names = new Set((out.levels[0]?.placements ?? []).map((p) => placementMeta.get(p)?.name ?? ""));
    expect(names.has("scifi Caged tunnel ceiling 02") || names.has("scifi Caged tunnel ceiling 01")).toBe(
      true,
    );
    expect(names.has("concrete wall filler")).toBe(true);
  });
});

describe("the 2D preview", () => {
  it("draws a covered stall as its canopy with the front on the lane side, a table as before", () => {
    const opts = { grid: false, roomNumbers: false, roomNames: false, furniture: true };
    const g4 = buildPlanDisplayList(resolvePlan(marketPlan(4)), "g", opts);
    const g3 = buildPlanDisplayList(resolvePlan(marketPlan(3)), "g", opts);
    if (!g4 || !g3) throw new Error("no display list");
    const ids = g4.items.filter((i) => i.symbol?.id.startsWith("feat-stall")).map((i) => i.symbol?.id);
    expect(ids.some((id) => /^feat-stall_cover_[NESW]$/.test(id ?? ""))).toBe(true);
    expect(
      g3.items
        .filter((i) => i.symbol?.id.startsWith("feat-stall"))
        .every((i) => i.symbol?.id === "feat-stall"),
    ).toBe(true);
  });
});

describe("overhead lines and covered stalls", () => {
  it("a line through a covered stall is dropped; one along the aisle holds", () => {
    const plan = marketPlan(4, "wood_town", 5121, {
      lines: [
        { id: "through", from: [2, 5], to: [12, 5], kind: "flags" },
        { id: "aisle", from: [1, 7], to: [32, 7], kind: "lights" },
      ],
    });
    const r = resolvePlan(plan);
    const L = r.levels[0] as ResolvedLevel;
    const ids = (L.lines ?? []).map((l) => l.id);
    expect(ids).not.toContain("through");
    expect(r.issues.some((i) => i.code === "line_unanchored" && i.elementId === "through")).toBe(true);
  });
});

describe("one palette view, one stall capability", () => {
  const catalog = loadPalettes();
  const strip = (role: string): typeof catalog => {
    const c = { ...catalog, palettes: structuredClone(catalog.palettes) };
    for (const p of Object.values(c.palettes)) Reflect.deleteProperty(p.roles, role);
    return c;
  };
  const probeOf = (c: typeof catalog, theme: string) => createPaletteView(c).probe(theme);

  it("the resolver's view and the compiler's check give one answer, whichever part is missing", () => {
    expect(coveredStallForms(probeOf(catalog, "wood_town"))).toEqual(["gable", "flat"]);
    for (const part of ["stall.base", "stall.counter", "stall.post", "stall.canopy"]) {
      const c = strip(part);
      // `stall.base` falls back to floor.wood_plank, so only the other three remove the capability
      const expected = part === "stall.base" ? ["gable", "flat"] : [];
      expect(createPaletteView(c).stallForms("wood_town"), part).toEqual(expected);
      expect(coveredStallForms(probeOf(c, "wood_town")), part).toEqual(expected);
    }
  });

  it("a base the resolver cannot see is no longer a covered stall the compiler cannot build", () => {
    // before: the resolver needed post, counter and canopy only, the compiler also a base: a 3x3 footprint with no goods
    const noBase = strip("stall.base");
    for (const p of Object.values(noBase.palettes)) Reflect.deleteProperty(p.roles, "floor.wood_plank");
    const view = createPaletteView(noBase);
    expect(view.stallForms("wood_town")).toEqual([]);
    const plan = marketPlan(4);
    const r = resolvePlan(plan, { palette: view });
    const stalls = r.levels[0]?.features.filter((f) => f.type === "stall") ?? [];
    expect(stalls.length).toBeGreaterThan(4);
    expect(stalls.every((f) => f.stall === undefined && f.size[0] * f.size[1] === 2)).toBe(true);
    // the table stalls carry their goods
    expect((r.levels[0]?.features ?? []).some((f) => f.type === "goods")).toBe(true);
    // a plan resolved for the palettes it compiles with has no covered stall the build lacks parts for
    const set = realize(r, noBase, {});
    expect(verifyBuild(r, set, noBase).diagnostics.some((d) => d.code === "verify_stall_uncovered")).toBe(
      false,
    );
  });

  it("when a caller resolved against other palettes, the footprint still gets its table and goods, and verify says so", () => {
    const resolved = resolvePlan(marketPlan(4));
    const c = strip("stall.post");
    const set = realize(resolved, c, {});
    const covered = (resolved.levels[0]?.features ?? []).filter((f) => f.stall !== undefined);
    expect(covered.length).toBeGreaterThan(4);
    const bare = covered.find((f) => f.variant === "bread" || f.variant === "potions");
    expect(bare).toBeDefined();
    const names = (id: string): string[] =>
      (set.levels[0]?.placements ?? [])
        .filter((p) => p.source.elementId === id)
        .map((p) => placementMeta.get(p)?.name ?? "");
    // a table on the footprint and the goods of a kind that sells something; no beam, no canopy
    const b = bare as NonNullable<typeof bare>;
    expect(names(b.id).some((n) => /Stall/.test(n))).toBe(true);
    expect(names(b.id).some((n) => /bread|loaf|Pie|alchemy|jug|Pitcher/i.test(n))).toBe(true);
    expect(names(b.id).some((n) => /Harbor Beam|Tent (Roof|Overhang)/.test(n))).toBe(false);
    const diags = verifyBuild(resolved, set, c).diagnostics.filter(
      (d) => d.code === "verify_stall_uncovered",
    );
    expect(diags.length).toBe(covered.length);
  });

  it("paletteOptionsFor: a view of the compiler's palettes from generator 4, the bundled default before", () => {
    expect(paletteOptionsFor({ generator: 3 }, catalog)).toEqual({});
    expect(paletteOptionsFor({ generator: 4 }, catalog).palette?.stallForms("wood_town")).toEqual([
      "gable",
      "flat",
    ]);
  });

  it("the stall-kind table covers every kind and every goods family it names exists in the palette", () => {
    const view = createPaletteView(catalog);
    for (const k of STALL_KINDS) {
      const info = STALL_KIND_INFO[k];
      expect(stallKindInfo(k)).toBe(info);
      expect(stallPieceOf(k)).toBe(info.piece);
      for (const fam of [info.goods, info.tableGoods]) if (fam) expect(GOODS_FAMILIES).toContain(fam);
    }
    expect(stallKindInfo("nonsense")).toBe(STALL_KIND_INFO.empty);
    expect(stallPieceOf("nonsense")).toBe("nonsense");
    for (const fam of GOODS_FAMILIES) expect(view.roomPiece("generic", "goods", fam), fam).toBeDefined();
  });

  it("small things are one table: goods and clutter share a role chain, and room and stall counts come from SURFACE_LOAD", () => {
    expect(featureRoles("clutter")).toEqual(SMALL_THINGS_ROLES);
    expect(featureRoles("goods")).toEqual([...SMALL_THINGS_ROLES].reverse());
    expect(featureRoles("table")).toEqual(["feature.table"]);
    expect(SURFACE_LOAD.stall_counter?.n).toEqual([1, 2]);
    const view = createPaletteView(catalog);
    // a family listed only under goods is found through the clutter chain, and the other way round
    expect(view.roomPiece("generic", "clutter", "bread")).toBeDefined();
    expect(view.roomPiece("generic", "goods", "study")).toBeDefined();
    expect(view.roomPiece("generic", "clutter", "nothing-like-this")).toBeUndefined();
  });
});

describe("design review of stalls", () => {
  const tables = (n: number, gap: number): MapPlan["levels"][number]["features"] =>
    Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      type: "stall",
      at: [3 + i * (2 + gap), 6],
      size: [2, 1],
      rot: 0,
      variant: "fruit",
    }));

  it("stalls_uncovered: plan-placed tables where the theme has canopy pieces; silent for a built row", () => {
    const bare = reviewDesign(
      marketPlan(4, "wood_town", 1, { stalls: [], features: tables(4, 1) }),
      resolvePlan(marketPlan(4, "wood_town", 1, { stalls: [], features: tables(4, 1) })),
    );
    expect(bare.map((n) => n.code)).toContain("stalls_uncovered");
    const row = marketPlan(4);
    expect(reviewDesign(row, resolvePlan(row)).map((n) => n.code)).not.toContain("stalls_uncovered");
  });

  it("stalls_grid: four tables of one size at an even gap; silent for generated stalls", () => {
    const p = marketPlan(4, "wood_town", 1, { stalls: [], features: tables(5, 1) });
    expect(reviewDesign(p, resolvePlan(p)).map((n) => n.code)).toContain("stalls_grid");
    const row = marketPlan(4);
    expect(reviewDesign(row, resolvePlan(row)).map((n) => n.code)).not.toContain("stalls_grid");
  });

  it("is silent on generator 3", () => {
    const p = marketPlan(3, "wood_town", 1, { stalls: [], features: tables(5, 1) });
    const codes = reviewDesign(p, resolvePlan(p)).map((n) => n.code);
    expect(codes).not.toContain("stalls_grid");
    expect(codes).not.toContain("stalls_uncovered");
  });
});
