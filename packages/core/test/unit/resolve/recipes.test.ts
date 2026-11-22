/**
 * The detail recipe engine (resolve/recipes/): the budget rule, slot filling with its fallbacks, conditions, keeping
 * doors and lanes clear, determinism and independence of recipes, and the behaviour of the two wall recipes (posts at
 * jambs and corners, the band course at floor lines) on wall-recipes-v1, which generator 4 does not build.
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
import { bandCourses, jambPosts } from "../../../src/resolve/recipes/walls";
import { loadPlan } from "../../fixtures";

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
const run = (L: ResolvedLevel, recipes?: Parameters<typeof runRecipes>[2]["recipes"], budget = 1e6) =>
  runRecipes(L, new ArrangementRecords(), {
    planSeed: plan5.seed,
    profile,
    palette: view,
    budget,
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
    expect(fillSlot(view.roles, "wood_town", spec, line)?.source).toBe("simplified");
    const generic = fillSlot(view.roles, "generic", spec, line);
    expect(generic?.source).toBe("theme");
    expect(generic?.pieces.every((p) => !p.role.startsWith("feature."))).toBe(true);
    expect(fillSlot(view.roles, "wood_town", bandCourses.slots.slab ?? spec, line)?.source).toBe("role");
  });
  it("takes a post from the theme's own pillar, else the wall style's post; none: the recipe is skipped", () => {
    const op = new LevelAnchors(level()).of("opening").find((o) => o.structure === "lhouse" && o.outside);
    const spec = jambPosts.slots.post;
    if (!op || !spec) throw new Error("no opening");
    expect(fillSlot(view.roles, "wood_town", spec, op)?.pieces[0]?.variant.name).toBe("Wooden Pillar ornate");
    expect(fillSlot(view.roles, "city", spec, op)?.pieces[0]?.role).toBe("facade_post.wood");
    // a post must stand under its storey: none is 0.5 tall
    expect(fillSlot(view.roles, "wood_town", spec, { ...op, head: 0.5 })).toBeNull();
  });
});

/** A test recipe: a crate standing `out` tiles in front of each door's centre. */
const crateAt = (out: number): Recipe<"opening"> => ({
  id: `crate${out}`,
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

describe("wall recipes on wall-recipes-v1 (generator 5)", () => {
  const L = resolved.levels[0];
  if (!L) throw new Error("no level");
  const inst = L.arrangements ?? [];

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
    for (const x of inst.filter((q) => q.recipe !== "bandCourses")) expect(x.mount).toBe("wall");
  });

  it("runs a band along at least 80% of every upper floor line, under the floor line, a quarter tile proud", () => {
    const lines = new LevelAnchors(level()).of("storeyLine").filter((l) => l.line === "floor");
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const band = inst.find((x) => x.id === `bandCourses@${l.key}`);
      expect(band, l.key).toBeDefined();
      const covered = (band?.pieces ?? []).length; // 1-tile slab edges, one per tile of the line
      expect(covered / l.length).toBeGreaterThanOrEqual(0.8);
      for (const p of band?.pieces ?? []) {
        expect(p.y).toBeLessThan(0);
        expect(p.z + 0.5).toBeCloseTo(0.25, 5);
      }
      expect(band?.layer).toBe("storey:1");
    }
  });
});
