/**
 * The detail recipe engine (resolve/recipes/): the budget rule, slot filling with its fallbacks, conditions, keeping
 * doors and lanes clear, determinism and independence of recipes, and the behaviour of the wall recipes (posts at jambs
 * and corners, pilasters, the band course at floor lines, the plinth) on wall-recipes-v1 with every recipe forced on
 * (treatments are tested in treatments.test.ts), held to the quality meter's hard rules; generator 4 builds none.
 */
import { describe, expect, it } from "vitest";
import { single, transform } from "../../../src/arrange";
import type { ResolvedLevel } from "../../../src/contracts/resolved";
import { bundledPalettes } from "../../../src/palette";
import { resolveView } from "../../../src/palette/view";
import { generatorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { LevelAnchors } from "../../../src/resolve/anchors";
import { ArrangementRecords } from "../../../src/resolve/level/arrangements";
import { detailBudgets, spend, type Proposal } from "../../../src/resolve/recipes/budget";
import { runRecipes } from "../../../src/resolve/recipes/engine";
import { fillSlot } from "../../../src/resolve/recipes/slots";
import type { Recipe } from "../../../src/resolve/recipes/types";
import { bandCourses, jambPosts, slabConcealed } from "../../../src/resolve/recipes/walls";
import { realize } from "../../../src/compile";
import type { TreatmentFamily } from "../../../src/resolve/recipes/treatments";
import { loadPlan } from "../../fixtures";
import {
  bandCoverage,
  coplanarShare,
  duplicateCount,
  piecesOf,
  restContact,
  structureOnAxis,
} from "../../fixtures/quality";
import { ALL_WALLS, withArrangements } from "../../fixtures/treatments";

const pal = bundledPalettes();
const plan5 = { ...loadPlan("wall-recipes-v1"), generator: 5 as const };
const view = resolveView(plan5, pal);
const profile = generatorProfile(5);
const resolved = resolvePlan(plan5, pal);
const level = (): ResolvedLevel => {
  const L = resolved.levels[0];
  if (!L) throw new Error("no level");
  // the level as the recipes found it, before their own instances
  const bare = { ...L };
  delete bare.arrangements;
  return bare;
};
/** The recipes run over the bare level, every wall recipe forced on unless `families` says otherwise. */
const run = (
  L: ResolvedLevel,
  recipes?: Parameters<typeof runRecipes>[2]["recipes"],
  budget = 1e6,
  families: readonly TreatmentFamily[] = ALL_WALLS,
) =>
  runRecipes(L, new ArrangementRecords(), {
    planSeed: plan5.seed,
    profile,
    palette: view,
    budget,
    families,
    ...(recipes ? { recipes } : {}),
  });

const prop = (key: string, tier: 0 | 1 | 2 | 3, focus: number, count: number, thin = false): Proposal => ({
  key,
  tier,
  focus,
  count,
  thinned: thin ? () => prop(`${key}~thin`, tier, focus, Math.floor(count / 2)) : null,
});

describe("the detail budget", () => {
  it("spreads thinnable repeats first, then drops tier 3 and tier 2 calm first, never tiers 0 and 1", () => {
    const ps = [
      prop("a", 0, 0, 10),
      prop("b", 1, 0, 10),
      prop("c", 2, 0.9, 10),
      prop("d", 2, 0.1, 10),
      prop("e", 3, 1, 10),
      prop("f", 2, 0.5, 10, true),
    ];
    const s = spend(ps, 40);
    expect(s.projected).toBe(60);
    // f spread (60 → 55), e dropped (45), the calmest tier-2 d dropped (35)
    expect(s.kept.map((p) => p.key)).toEqual(["a", "b", "c", "f~thin"]);
    expect(s.dropped.map((p) => p.key)).toEqual(["e", "d"]);
    expect(spend(ps, 5).kept.map((p) => p.key)).toEqual(["a", "b"]);
    expect(spend(ps, 100).kept).toHaveLength(6);
  });

  it("gives each level d x tiles, scaled down on a map that asks for more than its ceiling, capped per level", () => {
    const L = level();
    const one =
      detailBudgets([L], { interior: 3, builtExterior: 2, natural: 1.5, perMap: 1e9 }).get("g") ?? 0;
    expect(one).toBeGreaterThan(1000);
    const two = detailBudgets([L, { ...L, id: "h" }], {
      interior: 3,
      builtExterior: 2,
      natural: 1.5,
      perMap: one,
    });
    expect(two.get("g")).toBe(Math.floor(one / 2));
    expect(
      detailBudgets([L], { interior: 300, builtExterior: 300, natural: 300, perMap: 1e9 }).get("g"),
    ).toBe(6000);
  });
});

describe("slot filling", () => {
  const line = new LevelAnchors(level()).of("storeyLine").find((l) => l.line === "floor");
  if (!line) throw new Error("no floor line");
  it("takes a band from the theme's own structure, else simplifies to the floor slab's edge (never furniture)", () => {
    const spec = bandCourses.slots.band;
    if (!spec) throw new Error("no band slot");
    expect(fillSlot(view.roles, "wood_town", spec, line, line.style)?.source).toBe("simplified");
    const generic = fillSlot(view.roles, "generic", spec, line, line.style);
    expect(generic?.source).toBe("theme");
    expect(generic?.pieces.every((p) => !p.role.startsWith("feature."))).toBe(true);
    expect(fillSlot(view.roles, "wood_town", bandCourses.slots.slab ?? spec, line, line.style)?.source).toBe(
      "role",
    );
  });
  it("takes a post from the theme's own pillar, else the wall style's post; none: the recipe is skipped", () => {
    const op = new LevelAnchors(level()).of("opening").find((o) => o.structure === "lhouse" && o.outside);
    const spec = jambPosts.slots.post;
    if (!op || !spec) throw new Error("no opening");
    expect(fillSlot(view.roles, "wood_town", spec, op, op.style)?.pieces[0]?.variant.name).toBe(
      "Wooden Pillar ornate",
    );
    expect(fillSlot(view.roles, "city", spec, op, op.style)?.pieces[0]?.role).toBe("facade_post.wood");
    // a post must stand under its storey: none is 0.5 tall
    expect(fillSlot(view.roles, "wood_town", spec, { ...op, head: 0.5 }, op.style)).toBeNull();
  });
});

/** A test recipe: a crate standing `out` tiles in front of each door's centre. */
const crateAt = (out: number): Recipe<"opening"> => ({
  id: `crate${out}`,
  family: "test",
  doc: "test",
  switch: "jambPosts",
  anchor: "opening",
  tier: () => 3,
  mount: "floor",
  blocking: true,
  thinnable: false,
  when: (a) => a.openingKind === "door",
  slots: { box: { shape: () => ({ trait: "block", where: { height: [0.5, 1.2] } }), fallback: "borrow" } },
  compose: (a, s) => {
    const p = s.box?.pieces[0];
    return p ? transform(single(p), { dx: 0, dz: out }) : null;
  },
});

describe("the engine", () => {
  it("keeps doors clear: a crate in front of a door is refused (the recipe cannot place into a way)", () => {
    const blocked = run(level(), [crateAt(0.5)]);
    expect(blocked.attached).toEqual([]);
    expect(blocked.skipped.some((s) => /in a way/.test(s.why))).toBe(true);
  });

  it("applies a recipe only where its conditions hold", () => {
    const never: Recipe<"opening"> = { ...jambPosts, id: "never", when: () => false };
    expect(run(level(), [never]).attached).toEqual([]);
  });

  it("is deterministic, and one recipe's pieces do not move when another is added or removed", () => {
    const a = run(level()).attached;
    const b = run(level()).attached;
    expect(b).toEqual(a);
    const jambsOnly = run(level(), [jambPosts]).attached;
    expect(jambsOnly).toEqual(a.filter((x) => x.recipe === "jambPosts"));
  });

  it("drops what the budget cannot hold by tier: window and corner posts (tier 2) go, the bands (tier 1) stay", () => {
    const all = run(level());
    const tight = run(level(), undefined, all.spent - 1);
    expect(tight.dropped.length).toBeGreaterThan(0);
    expect(tight.attached.filter((x) => x.recipe === "bandCourses")).toHaveLength(
      all.attached.filter((x) => x.recipe === "bandCourses").length,
    );
  });
});

describe("wall recipes on wall-recipes-v1 (generator 5), every recipe forced on", () => {
  const all = run(level(), undefined, 1e6, ALL_WALLS);
  const inst = all.attached;
  const r5 = withArrangements(resolved, "g", inst);
  const set = realize(r5, pal, {});
  const everything = piecesOf(set, () => true);
  const of = (recipe: string) => piecesOf(set, (e) => e.startsWith(`${recipe}@`));

  it("generator 4 builds none of it", () => {
    const g4 = resolvePlan({ ...plan5, generator: 4 }, pal);
    expect(g4.levels[0]?.arrangements).toBeUndefined();
  });

  it("frames the openings of both houses' outsides and the stone room's door with a post at each jamb", () => {
    const anchors = new LevelAnchors(level());
    const openings = anchors.of("opening").filter((o) => o.seen && (o.structure === null || o.outside));
    let framed = 0;
    for (const o of openings) {
      const i = inst.find((x) => x.id === `jambPosts@${o.key}`);
      if (!i) continue;
      framed++;
      // every post stands beside the opening, its near side flush with the opening's edge, never across it
      for (const p of i.pieces) expect(Math.abs(p.x)).toBeGreaterThanOrEqual(o.width / 2);
    }
    // the openings left out are the ones a building's fixtures (a door light, the porch) stand beside
    expect(framed / openings.length).toBeGreaterThanOrEqual(0.8);
    expect(inst.some((x) => x.id.startsWith("jambPosts@face:L:") && x.id.endsWith("stonedoor"))).toBe(true);
    for (const x of inst) expect(x.mount).toBe("wall");
  });

  it("never reaches a trim piece past its wall's inner face (true turned footprints), so no room sees one", () => {
    const anchors = new LevelAnchors(level());
    const byKey = new Map<string, { depth: number; kind: string }>(
      [
        ...anchors.of("face"),
        ...anchors.of("opening"),
        ...anchors.of("corner"),
        ...anchors.of("storeyLine"),
      ].map((a) => [a.key, { depth: a.depth, kind: a.kind }]),
    );
    let measured = 0;
    for (const x of inst) {
      const a = byKey.get(x.id.slice(x.id.indexOf("@") + 1));
      if (!a) throw new Error(x.id);
      for (const p of x.pieces) {
        const v = view.roles
          .resolve(p.palette, p.role)
          .resolution?.variants.find((q) => q.wanted === p.asset || q.uuid === p.asset);
        // (a floor slab's band is the one exception: its inner part lies under the upper floor, tested below)
        if (!v || p.role.startsWith("floor.")) continue;
        const t = (p.yaw * Math.PI) / 180;
        const across = Math.abs(Math.cos(t)) * v.geom.size.z + Math.abs(Math.sin(t)) * v.geom.size.x;
        const along = Math.abs(Math.cos(t)) * v.geom.size.x + Math.abs(Math.sin(t)) * v.geom.size.z;
        measured++;
        expect(p.z - across / 2, x.id).toBeGreaterThanOrEqual(-a.depth + 1e-6);
        // a corner's post stands off both faces: the first face's wall lies along local +x
        if (a.kind === "corner") expect(p.x + along / 2, x.id).toBeLessThanOrEqual(a.depth - 1e-6);
      }
    }
    expect(measured).toBeGreaterThan(0);
  });

  it("runs a band along every upper floor line, under the floor line, in a beam the wall beds (wood_town: a borrowed wood beam)", () => {
    const lines = new LevelAnchors(level()).of("storeyLine").filter((l) => l.line === "floor");
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const band = inst.find((x) => x.id === `bandCourses@${l.key}`);
      expect(band, l.key).toBeDefined();
      for (const p of band?.pieces ?? []) {
        expect(p.y).toBeLessThan(0);
        // no own beam in wood_town: borrowed through the pool, not a floor slab
        expect(p.role.startsWith("floor."), p.role).toBe(false);
        expect(p.z).toBeLessThanOrEqual(0.3 + 1e-6);
      }
      expect(band?.layer).toBe("storey:1");
      expect(band?.host).toBe(l.structure);
    }
  });

  it("lays a floor slab's band only on a floor line under a standing upper floor", () => {
    // the slab is the last resort (no beam of the theme's own, none to borrow in the trim's material): its inner part
    // must lie under an upper floor, so only a floor line of a building whose floors stand takes it
    const lines = new LevelAnchors(level()).of("storeyLine");
    const ctx = { level: level() } as unknown as Parameters<typeof slabConcealed>[1];
    const floorLine = lines.find((l) => l.line === "floor");
    const baseLine = lines.find((l) => l.line === "base");
    if (!floorLine || !baseLine) throw new Error("no lines");
    expect(slabConcealed(floorLine, ctx)).toBe(true);
    expect(slabConcealed(baseLine, ctx)).toBe(false);
    const ruined = {
      level: {
        ...level(),
        structures: level().structures?.map((s) => ({ ...s, condition: "ruined" as const })),
      },
    } as unknown as Parameters<typeof slabConcealed>[1];
    expect(slabConcealed(floorLine, ruined)).toBe(false);
    // and every slab band built stands on such a line
    for (const x of inst.filter((q) => q.pieces.some((p) => p.role.startsWith("floor.")))) {
      const l = lines.find((q) => x.id === `bandCourses@${q.key}`);
      expect(l !== undefined && slabConcealed(l, ctx), x.id).toBe(true);
    }
  });

  it("meets the meter's hard rules: structure on axis, no coplanar flat tops, no duplicates, bands cover the lines", () => {
    for (const recipe of ["bandCourses", "jambPosts", "cornerPosts", "plinths", "pilasters"]) {
      const ps = of(recipe);
      expect(ps.length, recipe).toBeGreaterThan(0);
      expect(structureOnAxis(ps), recipe).toEqual([]);
      expect(coplanarShare(ps), recipe).toBe(0);
      expect(duplicateCount(ps), recipe).toBe(0);
      expect(restContact(ps, everything), recipe).toEqual([]);
    }
    expect(bandCoverage(r5, set)).toBeGreaterThanOrEqual(0.8);
  });

  it("meets the bands at outer corners: one runs on past the corner, the other starts where it ends", () => {
    const lines = new LevelAnchors(level()).of("storeyLine").filter((l) => l.line === "floor");
    const convexStart = lines.find((l) => l.ends[0] === "convex");
    const convexEnd = lines.find((l) => l.ends[1] === "convex");
    if (!convexStart || !convexEnd) throw new Error("no outer corner");
    expect(convexEnd.beyond[1]).toBeCloseTo(0.5, 6);
    // each piece's far end along the line (its real length, turned)
    const last = (inst.find((x) => x.id === `bandCourses@${convexEnd.key}`)?.pieces ?? []).map((p) => {
      const g = view.roles
        .resolve(p.palette, p.role)
        .resolution?.variants.find((q) => q.wanted === p.asset || q.uuid === p.asset)?.geom.size;
      const along = g ? (p.yaw % 180 === 0 ? g.x : g.z) : 1;
      return p.x + along / 2;
    });
    // past the meeting surface (0.5 beyond the end) by its projection
    expect(Math.max(...last)).toBeGreaterThan(convexEnd.length + 0.5);
  });

  it("puts pilasters only at bay joints of blank runs longer than 4, never in an opening", () => {
    const faces = new LevelAnchors(level()).of("face");
    let n = 0;
    for (const x of inst.filter((q) => q.recipe === "pilasters")) {
      const f = faces.find((q) => x.id === `pilasters@${q.key}`);
      if (!f) throw new Error(x.id);
      for (const p of x.pieces) {
        n++;
        expect(f.gaps.some((g) => p.x > g.from - 0.1 && p.x < g.to + 0.1)).toBe(false);
      }
    }
    expect(n).toBeGreaterThan(0);
  });

  it("lays a plinth only where a wall has no footing, broken by doors and running under windows", () => {
    const faces = new LevelAnchors(level()).of("face");
    const plinth = inst.filter((q) => q.recipe === "plinths");
    expect(plinth.length).toBeGreaterThan(0);
    for (const x of plinth) {
      const f = faces.find((q) => x.id === `plinths@${q.key}`);
      expect(f?.footed).toBe(false);
      expect(f?.storey).toBe(0);
      for (const p of x.pieces)
        for (const g of f?.gaps.filter((q) => q.kind === "door") ?? [])
          expect(p.x > g.from + 0.05 && p.x < g.to - 0.05).toBe(false);
    }
  });
});
