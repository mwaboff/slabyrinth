/**
 * Generator 5's street-reading round, each switch against its own absence: `ownWallsFirst` (a kept building in a
 * setting-kit style its theme only borrows is built in the theme's own wall), `readableTrims` (contrast drawn more where
 * the theme makes it; own-family posts and bands stand further proud, a band in the wall's own material is doubled, a
 * plinth shows taller), `groundClusters` (anchored clusters, a share of the whole place for every variant, deeper
 * sinking that verify takes as resting in the ground, companions leaning over a path's edge).
 */
import { afterEach, describe, expect, it } from "vitest";
import { placedBox, planPointOf } from "../../../src/arrange";
import { compileResolved, realize } from "../../../src/compile";
import { CELL_FLAG, type ResolvedArrangement, type ResolvedLevel } from "../../../src/contracts/resolved";
import { isSettingKitRole } from "../../../src/gen/wallStyles";
import { bundledPalettes } from "../../../src/palette";
import { partRole, postRole } from "../../../src/palette/roles";
import { resolveView } from "../../../src/palette/view";
import { GENERATOR_PROFILES, generatorProfile, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { LevelAnchors } from "../../../src/resolve/anchors";
import { ArrangementRecords } from "../../../src/resolve/level/arrangements";
import { runRecipes } from "../../../src/resolve/recipes/engine";
import { layeredGround } from "../../../src/resolve/recipes/ground";
import { drawTreatments } from "../../../src/resolve/recipes/treatments";
import { slabCodec } from "../../../src/slab";
import { loadPlan } from "../../fixtures";
import { coplanarShare, duplicateCount, piecesOf, restContact } from "../../fixtures/quality";
import { ALL_WALLS, forced } from "../../fixtures/treatments";
import { sweepPlan } from "../../sweep/seeds";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));
/** Generator 5 with one switch off, for the rest of the test (restored after it). */
const without = (name: "ownWallsFirst" | "readableTrims" | "groundClusters"): void => {
  P5[name] = false;
};

describe("ownWallsFirst: a kept building in a setting kit its theme only borrows is built in the theme's own wall", () => {
  const plan = { ...loadPlan("ground-and-walls-v1"), generator: 5 as const };
  /** Asset ids the generic palette lists under a setting-kit role of wall structure. */
  const kit = new Set(
    Object.entries(pal.palettes.generic?.roles ?? {})
      .filter(([role]) => isSettingKitRole(role) && !/^(window|opening|door)\b/.test(role))
      .flatMap(([, r]) => r.variants.map((v) => v.asset)),
  );
  const borrowed = (): number => {
    const r = resolvePlan(plan, pal);
    const set = realize(r, pal, {});
    const houses = (r.levels[0]?.structures ?? []).filter(
      (s) => s.kind === "building" && s.theme !== "generic",
    );
    expect(houses.some((s) => s.storeys.some((q) => isSettingKitRole(`wall.${q.walls ?? ""}`)))).toBe(true);
    return (set.levels[0]?.placements ?? []).filter(
      (p) =>
        p.role === "wall" &&
        houses.some((s) => (p.source.elementId ?? "").startsWith(`${s.id}~`)) &&
        kit.has(p.asset),
    ).length;
  };

  it("builds no wall of the street's kept houses from the borrowed kit; without the switch it does", () => {
    expect(borrowed()).toBe(0);
    without("ownWallsFirst");
    expect(borrowed()).toBeGreaterThan(0);
  });
});

describe("readableTrims", () => {
  // (the ground-and-walls line-up in city: its theme wall's posts are of the wall's own family, and it makes a
  // contrasting trim itself)
  const plan = { ...loadPlan("ground-and-walls-v1"), theme: "city", generator: 5 as const };
  const view = resolveView(plan, pal);
  const resolved = resolvePlan(plan, pal);
  const bare: ResolvedLevel = { ...(resolved.levels[0] as ResolvedLevel) };
  delete bare.arrangements;
  const run = (): readonly ResolvedArrangement[] =>
    runRecipes(bare, new ArrangementRecords(), {
      planSeed: plan.seed,
      profile: generatorProfile(5),
      palette: view,
      budget: 1e6,
      families: ALL_WALLS,
    }).attached;
  /** How far a post's front stands from the wall (its local z plus half its depth across). */
  const proud = (x: ResolvedArrangement): number[] =>
    x.pieces.map((p) => {
      const v = view.roles
        .resolve(view.roles.paletteTheme(p.palette), p.role)
        .resolution?.variants.find((q) => q.wanted === p.asset);
      return p.z + (v?.geom.size.z ?? 0) / 2;
    });
  const jambProud = (inst: readonly ResolvedArrangement[]): number =>
    Math.max(...inst.filter((x) => x.recipe === "jambPosts").flatMap(proud));
  const bandPieces = (inst: readonly ResolvedArrangement[]): number =>
    inst.filter((x) => x.recipe === "bandCourses").reduce((n, x) => n + x.pieces.length, 0);

  it("stands a post of the wall's own family further proud, and doubles a band in the wall's own material", () => {
    const on = run();
    without("readableTrims");
    const off = run();
    expect(jambProud(off)).toBeLessThanOrEqual(0.3 + 1e-6);
    expect(jambProud(on)).toBeGreaterThan(0.35);
    expect(bandPieces(on)).toBeGreaterThan(1.6 * bandPieces(off));
  });

  it("meets the hard rules with the doubled bands and prouder posts", () => {
    const r5 = {
      ...resolved,
      levels: resolved.levels.map((L, i) => (i === 0 ? { ...L, arrangements: [...run()] } : L)),
    };
    const set = realize(r5, pal, {});
    const everything = piecesOf(set, () => true);
    for (const recipe of ["bandCourses", "jambPosts", "plinths"]) {
      const ps = piecesOf(set, (e) => e.startsWith(`${recipe}@`));
      expect(ps.length, recipe).toBeGreaterThan(0);
      expect(coplanarShare(ps), recipe).toBe(0);
      expect(duplicateCount(ps), recipe).toBe(0);
      expect(restContact(ps, everything), recipe).toEqual([]);
    }
  });

  it("draws contrast trims more often where the theme makes the contrast itself", () => {
    const sv = view;
    const L = bare;
    const zones = new LevelAnchors(L).of("zone");
    const has =
      (own: boolean) =>
      (theme: string, style: string): boolean => {
        const t = sv.roles.paletteTheme(theme);
        return [partRole("facade_post", style), postRole(style)].some((role) => {
          const r = sv.roles.resolve(t, role).resolution;
          return !!r && (!own || r.paletteId !== "generic");
        });
      };
    const share = (own: boolean): number => {
      let n = 0;
      let c = 0;
      for (let s = 0; s < 120; s++)
        for (const t of drawTreatments({
          planSeed: 500 + s * 13,
          level: L,
          defaultTheme: sv.defaultTheme,
          zones,
          areaWalls: new Map(),
          hasTrim: has(false),
          ...(own ? { hasOwnTrim: has(true) } : {}),
        }).values())
          if (t.subject.kind === "building" && t.subject.contrastOwn !== false) {
            n++;
            if (t.options.get("trim") === "contrast") c++;
          }
      return c / Math.max(1, n);
    };
    expect(share(true)).toBeGreaterThan(share(false) + 0.1);
  });
});

describe("groundClusters", () => {
  const plan = { ...loadPlan("ground-and-walls-v1"), generator: 5 as const };
  const view = resolveView(plan, pal);
  const resolved = resolvePlan(plan, pal);
  const bare: ResolvedLevel = { ...(resolved.levels[0] as ResolvedLevel) };
  delete bare.arrangements;
  const anchors = new LevelAnchors(bare);
  const run = (variant: string): readonly ResolvedArrangement[] =>
    runRecipes(bare, new ArrangementRecords(), {
      planSeed: plan.seed,
      profile: generatorProfile(5),
      palette: view,
      budget: 1e6,
      families: forced({ ground: { layeredGround: variant } }),
      recipes: [layeredGround],
    }).attached.filter((x) => x.host === "yard");
  const boxes = (inst: readonly ResolvedArrangement[]) =>
    inst.flatMap((x) =>
      x.pieces.map((p) => {
        const v = view.roles
          .resolve(view.roles.paletteTheme(p.palette), p.role)
          .resolution?.variants.find((q) => q.wanted === p.asset);
        const b = placedBox({
          piece: { palette: p.palette, role: p.role, variant: v as never, measures: {} as never },
          x: p.x,
          y: p.y,
          z: p.z,
          yaw: p.yaw,
        });
        const a = planPointOf(x.at, x.turn, b.min.x, b.min.z);
        const c = planPointOf(x.at, x.turn, b.max.x, b.max.z);
        const [cx, cy] = planPointOf(x.at, x.turn, p.x, p.z);
        return {
          x0: Math.min(a[0], c[0]),
          x1: Math.max(a[0], c[0]),
          y0: Math.min(a[1], c[1]),
          y1: Math.max(a[1], c[1]),
          cx,
          cy,
          h: b.max.y - b.min.y,
          sink: -(x.base + p.y - x.base),
        };
      }),
    );
  /** The share of the yard's open grass (4 x 4 samples a cell) the pieces' footprints cover. */
  const share = (inst: readonly ResolvedArrangement[]): number => {
    const z = anchors.of("zone").find((q) => q.area === "yard");
    if (!z) throw new Error("yard");
    const bs = boxes(inst);
    let open = 0;
    let covered = 0;
    for (const [x, y] of z.cells) {
      const f = bare.cells.flags[anchors.grid.index(x, y)] ?? 0;
      if ((f & CELL_FLAG.PATH) !== 0 || !anchors.grid.cell(x, y).floor) continue;
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++) {
          const px = x + (i + 0.5) / 4;
          const py = y + (j + 0.5) / 4;
          open++;
          if (bs.some((b) => px > b.x0 && px < b.x1 && py > b.y0 && py < b.y1)) covered++;
        }
    }
    return covered / open;
  };
  const onPath = (x: number, y: number): boolean =>
    ((bare.cells.flags[anchors.grid.index(Math.floor(x), Math.floor(y))] ?? 0) & CELL_FLAG.PATH) !== 0;

  it("anchors clusters on taller pieces, sinks low pieces deeper, and leans companions over the path's edge", () => {
    const on = boxes(run("layered"));
    // (taller than the low cover's 0.6: only an anchor is)
    expect(on.filter((b) => b.h > 0.61).length).toBeGreaterThan(10);
    expect(on.some((b) => b.sink > 0.06)).toBe(true);
    const leaning = on.filter(
      (b) =>
        !onPath(b.cx, b.cy) &&
        [b.x0 + 0.01, b.x1 - 0.01].some((x) => [b.y0 + 0.01, b.y1 - 0.01].some((y) => onPath(x, y))),
    );
    expect(leaning.length).toBeGreaterThan(0);
    for (const b of on) expect(onPath(b.cx, b.cy)).toBe(false);
    without("groundClusters");
    const off = boxes(run("layered"));
    expect(off.every((b) => b.sink <= 0.06)).toBe(true);
    expect(off.filter((b) => b.h > 0.61)).toEqual([]);
  });

  it("gives the edges variant its share of the whole place, gathered at the edges", () => {
    const on = share(run("edges"));
    without("groundClusters");
    const off = share(run("edges"));
    expect(on).toBeGreaterThan(off * 1.4);
    expect(on).toBeGreaterThanOrEqual(0.12);
  });

  it("is taken by verify as resting in the ground, a centre on a tile seam included", () => {
    // (the seed whose anchor stood on the seam between two ground tiles: verify_prop_no_floor before the fix)
    const bundle = compileResolved(
      resolvePlan(sweepPlan("ground-and-walls-v1", 3668339987), pal),
      pal,
      slabCodec,
      {
        createdAt: "t",
      },
    );
    const bad = bundle.diagnostics.filter(
      (d) => d.severity !== "info" && /verify_prop_(no_floor|floating|sunk)/.test(d.code),
    );
    expect(bad).toEqual([]);
  });
});

describe("varied-street-v1: a street left to its styles' draw", () => {
  for (const theme of ["wood_town", "city"]) {
    const plan = { ...loadPlan("varied-street-v1"), theme, generator: 5 as const };
    const resolved = resolvePlan(plan, pal);
    const L = resolved.levels[0] as ResolvedLevel;
    const houses = (L.structures ?? []).filter((s) => s.kind === "building");

    it(`${theme}: varies storeys, roofs, archetypes and wall materials`, () => {
      const d = houses.map((s) => s.design).filter((x) => x !== undefined);
      expect(d).toHaveLength(houses.length);
      expect(new Set(d.map((x) => x.storeys)).size).toBeGreaterThanOrEqual(3);
      expect(new Set(d.map((x) => x.roof)).size).toBeGreaterThanOrEqual(3);
      expect(new Set(d.map((x) => x.archetype)).size).toBeGreaterThanOrEqual(3);
      expect(new Set(d.map((x) => x.material)).size).toBeGreaterThanOrEqual(2);
    });

    it(`${theme}: its detail recipes meet the hard rules and the build has no verify warning`, () => {
      const bundle = compileResolved(resolved, pal, slabCodec, { createdAt: "t" });
      expect(bundle.diagnostics.filter((x) => x.severity !== "info")).toEqual([]);
      const set = realize(resolved, pal, {});
      const everything = piecesOf(set, () => true);
      const ps = piecesOf(set, (e) =>
        /^(layeredGround|bandCourses|jambPosts|cornerPosts|plinths|pilasters)@/.test(e),
      );
      expect(ps.length).toBeGreaterThan(100);
      expect(coplanarShare(ps)).toBe(0);
      expect(duplicateCount(ps)).toBe(0);
      expect(restContact(ps, everything)).toEqual([]);
    }, 120_000);
  }
});
