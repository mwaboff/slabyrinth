/**
 * Structures (Level.structures, generator 2): resolution into a building area + openings, hosts outside, reserved
 * cells, validation issues, seeded variety, and the build (wall courses, roof layer, verify) — including the faults
 * found in the in-game shack test (2026-11-20): a broken piece in the ridge, the no-roof build keeping the porch
 * roof, dressing standing in the wall ring.
 */
import { describe, expect, it } from "vitest";
import type { Building, Level, MapPlan, Structure } from "../../../src/contracts/plan";
import { CELL_FLAG, EDGE, type ResolvedLevel } from "../../../src/contracts/resolved";
import { compileResolved, realize, verifyBuild } from "../../../src/compile";
import { placementMeta } from "../../../src/compile/realize";
import { loadPalettes } from "../../../src/palette";
import { validatePlan } from "../../../src/plan";
import { resolvePlan } from "../../../src/resolve/index";
import "../../../src/resolve/autoregister";
import { canonicalJson } from "../../../src/util/canonical";

const palettes = loadPalettes();

function plan(structures: Structure[], extra: Partial<Level> = {}, generator: 1 | 2 = 2): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator,
    id: "structures",
    title: "structures",
    kind: "outdoor",
    seed: 11,
    theme: "forest",
    links: [],
    levels: [
      {
        id: "g",
        name: "g",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 24, h: 20 },
        base: { type: "ground", material: "grass" },
        areas: [{ id: "woods", kind: "zone", shape: { type: "rect", x: 0, y: 0, w: 24, h: 20 } }],
        openings: [],
        walls: [],
        features: [],
        terrain: [],
        labels: [],
        structures,
        ...extra,
      },
    ],
  };
}

const shack = (more: Partial<Building> = {}): Building => ({
  id: "shack",
  name: "Shack",
  wings: [{ x: 8, y: 6, w: 6, h: 4 }],
  roof: { type: "gable" }, // pinned: a phase-1 cottage, not a drawn design
  openings: [{ kind: "door", side: "S", position: 0.5 }],
  chimneys: [{ side: "W" }],
  attachments: [{ type: "porch", side: "S", width: 4, depth: 2 }],
  ...more,
});

const level0 = (p: MapPlan): ResolvedLevel => resolvePlan(p).levels[0] as ResolvedLevel;
const idx = (L: ResolvedLevel, x: number, y: number): number =>
  (y - L.bounds.y) * L.bounds.w + (x - L.bounds.x);

describe("structures: resolution", () => {
  it("a building's ground storey is a building area with its doors and windows as openings", () => {
    const L = level0(plan([shack()]));
    const area = L.areas.find((a) => a.id === "shack");
    expect(area?.kind).toBe("building");
    expect(area?.cellCount).toBe(24);
    const st = L.structures?.[0];
    expect(st?.kind).toBe("building");
    const door = L.openings.find((o) => o.id === "shack~door0");
    expect(door?.kind).toBe("door");
    expect(L.openings.filter((o) => o.id.startsWith("shack~window")).length).toBeGreaterThan(0);
    expect(st?.chimneys).toEqual([{ at: [7, 8], side: "W" }]);
    expect(st?.roof).toMatchObject({ type: "gable", style: "slate", deck: true, broken: 0 });
  });

  it("walls host outside the footprint (the interior keeps whole cells)", () => {
    const L = level0(plan([shack()]));
    // north wall of cell (9,6): first cell of the h edge is the outside one (north) → host 0
    const n = L.hEdges.host[(6 - 0) * 24 + 9];
    expect(L.hEdges.kind[6 * 24 + 9]).toBe(EDGE.WALL);
    expect(n).toBe(0);
    // east wall of cell (13,7): second cell of the v edge is outside → host 1
    const e = 7 * 25 + 14;
    expect(L.vEdges.kind[e]).not.toBe(EDGE.NONE);
    expect(L.vEdges.host[e]).toBe(1);
  });

  it("reserves the wall ring, the door approach, chimney and porch for generated dressing", () => {
    const p = plan([shack()], {
      terrain: [{ id: "sc", op: "scatter", feature: "bush", density: 1, minSpacing: 0, avoid: [] }],
    });
    const L = level0(p);
    const reserved = new Set(L.reserved ?? []);
    for (let x = 7; x <= 14; x++) {
      expect(reserved.has(idx(L, x, 5))).toBe(true);
      expect(reserved.has(idx(L, x, 10))).toBe(true);
    }
    expect(reserved.has(idx(L, 11, 11))).toBe(true); // two cells out from the door (11,9)
    const bad = L.features.filter((f) => f.generatedBy === "sc" && reserved.has(idx(L, f.at[0], f.at[1])));
    expect(bad).toEqual([]);
    expect(L.features.some((f) => f.generatedBy === "sc")).toBe(true);
    // the chimney breast blocks its cell
    expect((L.cells.flags[idx(L, 7, 8)] ?? 0) & CELL_FLAG.FEATURE).toBeTruthy();
  });

  it("an enclosure keeps other areas' dressing out of its yard and fences its edge with a gate", () => {
    const yard: Structure = {
      id: "yard",
      kind: "enclosure",
      shape: { type: "rect", x: 2, y: 2, w: 20, h: 16 },
      gates: [{ side: "S", width: 2 }],
    };
    const p = plan([yard, shack()], {
      terrain: [{ id: "dw", op: "dress", area: "woods", preset: "woodland", density: 1 }],
    });
    const L = level0(p);
    const inYard = L.features.filter(
      (f) => f.generatedBy === "dw" && f.at[0] >= 2 && f.at[0] < 22 && f.at[1] >= 2 && f.at[1] < 18,
    );
    expect(inYard).toEqual([]);
    const gate = L.openings.find((o) => o.id === "yard~gate0");
    expect(gate?.kind).toBe("open");
    expect(gate?.width).toBe(2);
    expect(L.hEdges.kind[2 * 24 + 5]).toBe(EDGE.WALL); // fence on the north edge
  });

  it("dress may target a structure (its ground storey or yard) by id", () => {
    const p = plan([shack()], {
      terrain: [{ id: "furnish", op: "dress", area: "shack", preset: "storeroom", density: 0.5 }],
    });
    expect(validatePlan(p).issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("structures: validation", () => {
  const errors = (p: MapPlan) =>
    validatePlan(p).issues.filter((i) => i.severity === "error" && i.code === "structure_invalid");
  const warnings = (p: MapPlan) =>
    validatePlan(p).issues.filter((i) => i.severity === "warning" && i.code === "structure_invalid");

  it("rejects overlapping buildings", () => {
    const p = plan([shack(), shack({ id: "other", wings: [{ x: 10, y: 7, w: 5, h: 4 }], attachments: [] })]);
    expect(errors(p).some((i) => i.elementId === "other" && /overlaps/.test(i.message))).toBe(true);
  });

  it("rejects a door that opens onto the level edge", () => {
    const p = plan([
      shack({
        wings: [{ x: 8, y: 0, w: 6, h: 4 }],
        openings: [{ kind: "door", side: "N" }],
        attachments: [],
      }),
    ]);
    expect(errors(p).some((i) => /opens onto the level edge/.test(i.message))).toBe(true);
  });

  it("needs generator 2", () => {
    const p = plan([shack()], {}, 1);
    expect(errors(p).some((i) => /generator 2/.test(i.message))).toBe(true);
  });

  it("reports roof strategies that are not built yet and builds them flat", () => {
    const p = plan([shack({ roof: { type: "dome" } })]);
    expect(warnings(p).some((i) => /"dome" roofs are not built yet/.test(i.message))).toBe(true);
    expect(level0(p).structures?.[0]?.roof.type).toBe("flat");
  });

  it("warns about a storey without walls under a walled storey", () => {
    const p = plan([shack({ storeys: [{ walls: "none" }, { walls: "wood" }] })]);
    expect(warnings(p).some((i) => /without walls carries/.test(i.message))).toBe(true);
  });

  it("points issues about the synthetic openings at the structure", () => {
    const p = plan([
      shack({
        wings: [{ x: 8, y: 0, w: 6, h: 4 }],
        openings: [{ kind: "door", side: "N" }],
        attachments: [],
      }),
    ]);
    const issues = validatePlan(p).issues.filter((i) => i.elementId?.startsWith("shack"));
    for (const i of issues) {
      expect(i.elementId).toBe("shack");
      if (i.path?.startsWith("/levels/0/")) expect(i.path).not.toMatch(/\/(areas|openings|walls)\/[1-9]/);
    }
  });
});

describe("structures: build", () => {
  const p = plan([shack()]);
  const resolved = resolvePlan(p);
  const set = realize(resolved, palettes);
  const pl = set.levels[0]?.placements ?? [];
  const named = (s: string) => pl.filter((x) => placementMeta.get(x)?.name === s);

  it("stacks the courses as in the in-game shack: footing, timber storey, attic deck, roof on the deck", () => {
    const footing = pl.filter((x) => x.source.elementId === "shack~footing");
    const walls = pl.filter((x) => x.source.elementId === "shack~wall");
    const deck = pl.filter((x) => x.source.elementId === "shack~deck");
    const roof = pl.filter((x) => x.source.elementId === "shack~roof");
    expect(new Set(footing.map((x) => x.y))).toEqual(new Set([0.5]));
    expect(new Set(walls.map((x) => x.y))).toEqual(new Set([1.5]));
    expect(new Set(deck.map((x) => x.y))).toEqual(new Set([3.5]));
    expect(Math.min(...roof.map((x) => x.y))).toBe(4);
    expect(Math.max(...roof.map((x) => x.y))).toBe(6); // ridge pair: half-span 3 → course 2
    expect(walls.every((x) => x.layer === "storey:0")).toBe(true);
    expect([...roof, ...deck].every((x) => x.layer === "roof")).toBe(true);
  });

  it("keeps the ridge continuous and the roof intact by default (no broken pieces)", () => {
    expect(named("haunted roof 2x2 broken")).toEqual([]);
    const ridge = pl.filter((x) => x.source.elementId === "shack~roof" && x.y === 6);
    // two opposed pieces per column along the 8-cell outline, minus the chimney cell
    expect(ridge.length).toBe(8 * 2 - 1);
  });

  it("a no-roof build drops roof, attic deck, gable fill and the porch roof but keeps both wall courses", () => {
    const bare = realize(resolved, palettes, { omitLayers: ["roof"] }).levels[0]?.placements ?? [];
    const ids = new Set(bare.map((x) => x.source.elementId ?? ""));
    for (const gone of ["shack~roof", "shack~deck", "shack~gable", "shack~porchroof0"])
      expect(ids.has(gone)).toBe(false);
    expect(pl.some((x) => x.source.elementId === "shack~porchroof0")).toBe(true);
    expect(bare.filter((x) => x.source.elementId === "shack~wall").length).toBe(
      pl.filter((x) => x.source.elementId === "shack~wall").length,
    );
    expect(bare.some((x) => x.source.elementId === "shack~footing")).toBe(true);
    expect(bare.some((x) => x.source.elementId === "shack~chimney")).toBe(true);
  });

  it("passes the build checks", () => {
    const v = verifyBuild(resolved, set, palettes, { plan: p });
    expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const bundle = compileResolved(resolved, palettes, undefined, { plan: p });
    expect(bundle.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(bundle.chunks.length).toBe(1);
  });
});

describe("structures: variety", () => {
  const spec = (seed: number): MapPlan =>
    plan([{ id: "hut", wings: [{ x: 8, y: 6, w: 6, h: 4 }], roof: { type: "gable" }, seed }]);

  it("the same spec with another seed builds a different building; the same seed is byte-stable", () => {
    const a = resolvePlan(spec(1));
    const a2 = resolvePlan(spec(1));
    expect(canonicalJson(a)).toBe(canonicalJson(a2));
    const pa = realize(a, palettes).levels[0]?.placements ?? [];
    const pa2 = realize(a2, palettes).levels[0]?.placements ?? [];
    expect(canonicalJson(pa)).toBe(canonicalJson(pa2));
    const variants = new Set<string>();
    for (const s of [1, 2, 3, 4, 5, 6]) {
      const r = resolvePlan(spec(s));
      const st = r.levels[0]?.structures?.[0];
      variants.add(
        canonicalJson({ o: st?.openingIds, ops: r.levels[0]?.openings, c: st?.chimneys, p: st?.porches }),
      );
    }
    expect(variants.size).toBeGreaterThan(3);
  });

  it("200 seeds of one style: every building is valid, its door opens onto reachable ground, ridge and walls are whole", () => {
    for (let seed = 0; seed < 200; seed++) {
      const p = spec(seed);
      const v = validatePlan(p);
      expect(
        v.issues.filter((i) => i.severity === "error"),
        `seed ${seed}`,
      ).toEqual([]);
      const r = resolvePlan(p);
      const L = r.levels[0] as ResolvedLevel;
      const st = L.structures?.[0];
      const door = L.openings.find((o) => o.id === "hut~door0");
      expect(door, `seed ${seed}`).toBeDefined();
      const set = realize(r, palettes);
      const ver = verifyBuild(r, set, palettes, { plan: p });
      const bad = ver.diagnostics.filter(
        (d) => d.severity === "error" || d.code === "verify_wall_gap" || d.code === "verify_area_unreachable",
      );
      expect(bad, `seed ${seed}`).toEqual([]);
      const roofPieces = (set.levels[0]?.placements ?? []).filter((x) => x.source.elementId === "hut~roof");
      const top = Math.max(...roofPieces.map((q) => q.y));
      const ridge = roofPieces.filter((x) => x.y === top);
      // 8 columns × 2 opposed pieces, minus a chimney breast standing in a ridge cell (rows 7 and 8)
      const holes = (st?.chimneys ?? []).filter((c) => c.at[1] === 7 || c.at[1] === 8).length;
      expect(ridge.length, `seed ${seed}`).toBe(16 - holes);
    }
  }, 120_000);
});
