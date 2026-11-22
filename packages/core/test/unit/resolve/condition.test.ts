/**
 * Condition and style on the treatments (generator 5, plan §11.1-11.2) on condition-street-v1: the same house kept,
 * worn, ramshackle, ruined and collapsed, and a shrine. The word table (gen/buildingCondition.ts); ruins by bays
 * (resolve/building/ruinBays.ts, switch ruinBays); roof patches and porch wear (resolve/building/wear.ts, switches
 * roofPatches, porchWear); the condition recipes (wallFootGrowth, breachRubble) and the threshold pair (guardianPair,
 * approachLights), each forced on and held to the meter's hard rules; generator 4 and the switches off build none.
 */
import { describe, expect, it } from "vitest";
import { planPointOf } from "../../../src/arrange";
import { realize } from "../../../src/compile";
import type { ResolvedLevel, ResolvedPlan, ResolvedStructure } from "../../../src/contracts/resolved";
import { buildingState } from "../../../src/gen/buildingCondition";
import { isPassage } from "../../../src/gen/openingKinds";
import { bundledPalettes } from "../../../src/palette";
import { resolveView } from "../../../src/palette/view";
import { generatorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { LevelAnchors } from "../../../src/resolve/anchors";
import { ArrangementRecords } from "../../../src/resolve/level/arrangements";
import { breachRubble, wallFootGrowth } from "../../../src/resolve/recipes/condition";
import { runRecipes } from "../../../src/resolve/recipes/engine";
import { approachLights, guardianPair } from "../../../src/resolve/recipes/threshold";
import {
  STRUCTURE_TREATMENTS,
  TREATMENTS,
  buildingSubject,
  drawStructureOption,
  type TreatmentFamily,
} from "../../../src/resolve/recipes/treatments";
import { loadPlan } from "../../fixtures";
import {
  coplanarShare,
  duplicateCount,
  piecesOf,
  restContact,
  structureOnAxis,
} from "../../fixtures/quality";
import { forced, withArrangements } from "../../fixtures/treatments";

const pal = bundledPalettes();
const plan = loadPlan("condition-street-v1");
const view = resolveView(plan, pal);
const resolved = resolvePlan(plan, pal);
const L0 = resolved.levels[0] as ResolvedLevel;
const bare: ResolvedLevel = { ...L0 };
delete bare.arrangements;
const anchors = new LevelAnchors(bare);
const st = (id: string): ResolvedStructure => {
  const s = (L0.structures ?? []).find((q) => q.id === id);
  if (!s) throw new Error(id);
  return s;
};
const words = new Map(
  (plan.levels[0]?.structures ?? []).map((s) => [s.id, { name: s.name, use: (s as { use?: string }).use }]),
);
const FORCED = forced({
  growth: { wallFootGrowth: "thick" },
  rubble: { breachRubble: "graded" },
  threshold: { guardianPair: "pair", approachLights: "pair" },
});
const run = (profile = generatorProfile(5), families: readonly TreatmentFamily[] = FORCED) =>
  runRecipes(bare, new ArrangementRecords(), {
    planSeed: plan.seed,
    profile,
    palette: view,
    budget: 1e6,
    families,
    words,
    recipes: [wallFootGrowth, breachRubble, guardianPair, approachLights],
  });
const all = run();
const set = realize(withArrangements(resolved, L0.id, all.attached), pal, {});
const everything = piecesOf(set, () => true);
const ofRecipe = (r: string) => piecesOf(set, (e) => e.startsWith(`${r}@`));
const ofBuilding = (id: string) => piecesOf(set, (e) => e === id || e.startsWith(`${id}~`));
const key = (x: number, y: number): string => `${x},${y}`;

describe("the condition word table", () => {
  it("reads the plan's condition and refines it by words, never making a kept building a ruin", () => {
    expect(buildingState({ condition: "intact" }).state).toBe("kept");
    expect(buildingState({ condition: "weathered" }).state).toBe("worn");
    expect(buildingState({ condition: "intact", name: "Ramshackle shed" }).state).toBe("ramshackle");
    expect(buildingState({ name: "Collapsed hall" }).state).toBe("kept");
    expect(buildingState({ condition: "ruined" }).severity).toBe(2);
    expect(buildingState({ condition: "ruined", notes: "collapsed into rubble" }).severity).toBe(3);
    expect(buildingState({ condition: "ruined", tags: ["crumbling"] }).severity).toBe(1);
    expect(buildingState({ condition: "ruined", notes: "bandit camp" }).reoccupied).toBe(true);
    expect(buildingState({ use: "shrine" }).sacred).toBe(true);
    expect(buildingState({ name: "Town hall" }).formal).toBe(true);
  });

  it("weighs every family with a plain option of real weight at every state", () => {
    for (const state of ["kept", "worn", "ramshackle", "ruined"] as const) {
      const s = { ...buildingSubject("b", [[0, 0]], "wood_town", 1, {}), state };
      for (const f of [...TREATMENTS, ...STRUCTURE_TREATMENTS]) {
        const ws = f.options.map((o) => o.weight(s));
        const total = ws.reduce((a, b) => a + b, 0);
        const plain = f.options.findIndex((o) => ["plain", "own", "matched", "bays"].includes(o.id));
        expect(plain, f.id).toBeGreaterThanOrEqual(0);
        if (total > 0) expect((ws[plain] ?? 0) / total, `${f.id} ${state}`).toBeGreaterThan(0.08);
      }
    }
  });
});

describe("a ruin by bays (switch ruinBays)", () => {
  const ruin = st("ruin");
  const fallen = st("fallen");

  it("loses whole bays: a walkable breach, the roof and upper floors open over the bay", () => {
    for (const s of [ruin, fallen]) {
      const bays = s.ruin?.bays ?? [];
      expect(bays.length, s.id).toBeGreaterThan(0);
      const holes = new Set((s.ruin?.roofHoles ?? []).map(([x, y]) => key(x, y)));
      for (const b of bays) {
        const breach = L0.openings.find(
          (o) => s.openingIds.includes(o.id) && o.id.includes("~breach") && o.width === b.width,
        );
        expect(breach && isPassage(breach.kind), s.id).toBe(true);
        // the roof is open over the breach (every breach cell is a roof hole)
        const cells = Array.from({ length: b.width }, (_, k) =>
          b.side === "N" || b.side === "S" ? [b.at[0] + k, b.at[1]] : [b.at[0], b.at[1] + k],
        );
        const over = cells.filter(([x = 0, y = 0]) => holes.has(key(x, y))).length / cells.length;
        expect(over).toBeGreaterThanOrEqual(0.7);
        // and the upper floor is gone there
        const under = s.ruin?.holes.some((h) => h.cells.some(([x, y]) => x === b.at[0] && y === b.at[1]));
        expect(under).toBe(true);
      }
    }
  });

  it("keeps its other walls level, with a few big steps when it has collapsed", () => {
    for (const s of [ruin, fallen]) {
      const cols = s.ruin?.columns ?? [];
      const level = cols.filter((c) => c.top >= c.full - 1e-6).length / cols.length;
      expect(level, s.id).toBeGreaterThanOrEqual(0.6);
      // every top on the half-tile grid
      for (const c of cols) expect(Math.abs(c.top * 2 - Math.round(c.top * 2))).toBeLessThan(1e-6);
    }
    // a severity-2 ruin keeps its roof over the rest; the collapsed one has lost it
    expect(ruin.volumes?.some((v) => v.roof.layers.length > 0)).toBe(true);
    expect(fallen.volumes?.every((v) => v.roof.layers.length === 0)).toBe(true);
    const cols = fallen.ruin?.columns ?? [];
    const steps = cols.filter((c) => c.full - c.top >= 2 - 1e-6).length;
    expect(steps / cols.length).toBeGreaterThanOrEqual(0.05);
  });

  it("draws its events per building: two ruins of one house do not lose the same bay", () => {
    const rel = (s: ResolvedStructure) => {
      const x0 = Math.min(...s.cells.map(([x]) => x));
      const y0 = Math.min(...s.cells.map(([, y]) => y));
      return (s.ruin?.bays ?? []).map((b) => `${b.side}:${b.at[0] - x0},${b.at[1] - y0}:${b.width}`).sort();
    };
    expect(rel(ruin)).not.toEqual(rel(fallen));
  });

  it("is a generator-5 behaviour: generator 4 ruins the house its old way (no bays)", () => {
    const g4 = resolvePlan({ ...plan, generator: 4 }, pal).levels[0]?.structures ?? [];
    for (const id of ["ruin", "fallen"]) expect(g4.find((s) => s.id === id)?.ruin?.bays).toBeUndefined();
  });
});

describe("wear on worn and ramshackle buildings (switches roofPatches, porchWear)", () => {
  it("patches a worn roof a little and a ramshackle one more, a kept one never", () => {
    // (of the roof that stands: a weathered roof's fallen patch is not re-laid)
    const share = (id: string): number => {
      const s = st(id);
      const holes = new Set((s.ruin?.roofHoles ?? []).map(([x, y]) => key(x, y)));
      const top = new Set(s.cells.map(([x, y]) => key(x, y)).filter((k) => !holes.has(k)));
      return (s.roofPatch ?? []).filter(([x, y]) => top.has(key(x, y))).length / top.size;
    };
    expect(st("kept").roofPatch).toBeUndefined();
    expect(share("worn")).toBeGreaterThan(0);
    expect(share("worn")).toBeLessThan(0.25);
    expect(share("shack")).toBeGreaterThanOrEqual(0.25);
    expect(share("shack")).toBeLessThanOrEqual(0.5);
  });

  it("re-lays the patch in another kit: the roof's pieces change when the patch is taken away", () => {
    const without: ResolvedPlan = {
      ...resolved,
      levels: resolved.levels.map((L) => ({
        ...L,
        structures: (L.structures ?? []).map((s) => {
          if (s.id !== "shack") return s;
          const rest = { ...s };
          delete rest.roofPatch;
          return rest;
        }),
      })),
    };
    const roofOf = (p: ResolvedPlan) =>
      realize(p, pal, {})
        .levels.flatMap((L) => L.placements)
        .filter((q) => q.source.elementId === "shack~roof")
        .map((q) => q.asset)
        .sort();
    expect(roofOf(resolved)).not.toEqual(roofOf(without));
  });

  it("sags a ramshackle porch's outer row one step and stands it on two kinds of post", () => {
    // ramshackle porches draw a sag about 60 % of the time, mixed posts about 70 %; worn ones less
    const share = (family: string, state: "worn" | "ramshackle", opt: string): number => {
      const s = { ...buildingSubject("b", [[0, 0]], "wood_town", 1, {}), state };
      let n = 0;
      for (let i = 0; i < 400; i++) if (drawStructureOption(family, s, `s${i}`) === opt) n++;
      return n / 400;
    };
    expect(share("porchSag", "ramshackle", "sag")).toBeGreaterThan(0.45);
    expect(share("porchSag", "worn", "sag")).toBeLessThan(share("porchSag", "ramshackle", "sag"));
    expect(share("porchPosts", "ramshackle", "mixed")).toBeGreaterThan(0.55);
    // the build: the shack's porch drawn both ways
    const shack = st("shack");
    const worn: ResolvedPlan = {
      ...resolved,
      levels: resolved.levels.map((L) => ({
        ...L,
        structures: (L.structures ?? []).map((s) =>
          s.id === "shack"
            ? { ...s, porches: s.porches.map((q) => ({ ...q, sag: 0.25, posts: "mixed" as const })) }
            : s,
        ),
      })),
    };
    expect(shack.porches[0]?.roof).toBe(true);
    const pl = realize(worn, pal, {}).levels.flatMap((L) => L.placements);
    const roofYs = new Set(pl.filter((q) => q.source.elementId === "shack~porchroof0").map((q) => q.y));
    expect([...roofYs].sort((a, b) => a - b).map((y, i, a) => y - (a[0] ?? 0))).toContain(0.25);
    const posts = new Set(pl.filter((q) => q.source.elementId === "shack~porch0").map((q) => q.asset));
    expect(posts.size).toBe(2);
    // a kept porch is level and matched
    expect(st("kept").porches[0]?.sag).toBeUndefined();
  });

  it("never comes to a kept or ruined building, over many seeds", () => {
    for (let i = 0; i < 60; i++)
      for (const state of ["kept", "ruined"] as const) {
        const s = { ...buildingSubject("b", [[0, 0]], "wood_town", 1, {}), state };
        expect(drawStructureOption("roofPatch", s, `seed${i}`)).toBe("plain");
        expect(drawStructureOption("porchSag", s, `seed${i}`)).toBe("plain");
      }
  });
});

describe("structure at every condition", () => {
  it("keeps every building's tiles on the quarter turns, kept to collapsed", () => {
    for (const id of ["kept", "worn", "shack", "ruin", "fallen", "shrine"])
      expect(structureOnAxis(ofBuilding(id)), id).toEqual([]);
  });

  it("builds no condition warning (no prop in a wall, nothing floating)", () => {
    expect(set.diagnostics.filter((d) => d.severity !== "info").map((d) => d.code)).toEqual([]);
  });
});

describe("growth at the wall feet (wallFootGrowth)", () => {
  const growth = all.attached.filter((x) => x.recipe === "wallFootGrowth");

  it("grows only on faces without a door, more away from the doors than on the street face", () => {
    expect(growth.length).toBeGreaterThan(0);
    const faces = new Map(anchors.of("face").map((f) => [f.key, f]));
    let front = 0;
    let back = 0;
    for (const x of growth) {
      const f = faces.get(x.id.replace("wallFootGrowth@", "").split("#")[0] ?? "");
      expect(f?.gaps.some((g) => isPassage(g.kind))).toBe(false);
      const s = (L0.structures ?? []).find((q) => q.id === f?.structure);
      const [nx, ny] = planPointOf([0, 0], f?.frame.turn ?? 0, 0, 1);
      const side = Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? "E" : "W") : ny > 0 ? "S" : "N";
      if (side === s?.frontage?.side) front += x.pieces.length;
      else if (side === ({ N: "S", S: "N", E: "W", W: "E" } as const)[s?.frontage?.side ?? "S"])
        back += x.pieces.length;
    }
    expect(back).toBeGreaterThan(front);
  });

  it("is drawn by condition: a kept building is weeded, the others grow when their treatment says", () => {
    const drawn = run(generatorProfile(5), TREATMENTS).attached.filter((x) => x.recipe === "wallFootGrowth");
    expect(drawn.some((x) => x.host === "kept")).toBe(false);
  });
});

describe("rubble graded from a breach (breachRubble)", () => {
  const rubble = all.attached.filter((x) => x.recipe === "breachRubble");

  it("lies big near the breach and small far from it", () => {
    expect(rubble.length).toBeGreaterThan(0);
    const pts: Array<{ d: number; v: number }> = [];
    for (const x of rubble)
      for (const p of x.pieces) {
        const v = view.roles
          .resolve(view.roles.paletteTheme(p.palette), p.role)
          .resolution?.variants.find((q) => q.wanted === p.asset)?.geom.size;
        if (v) pts.push({ d: Math.abs(p.z), v: v.x * v.y * v.z });
      }
    const near = pts.filter((q) => q.d < 2);
    const far = pts.filter((q) => q.d >= 3);
    const mean = (xs: typeof pts) => xs.reduce((s, q) => s + q.v, 0) / Math.max(1, xs.length);
    expect(near.length).toBeGreaterThan(0);
    expect(far.length).toBeGreaterThan(0);
    expect(mean(near)).toBeGreaterThan(mean(far));
  });

  it("keeps the breach walkable: nothing in its way", () => {
    expect(all.skipped.some((s) => s.recipe === "breachRubble" && /way|lane/.test(s.why))).toBe(true);
  });
});

describe("the threshold pair (guardianPair, approachLights)", () => {
  const at = (r: string) => all.attached.filter((x) => x.recipe === r);

  it("flanks only a sacred or formal building's main door when drawn: the shrine alone", () => {
    const drawn = run(generatorProfile(5), TREATMENTS).attached;
    const pairs = drawn.filter((x) => /guardianPair|approachLights/.test(x.recipe));
    const hosts = new Set(pairs.map((x) => x.host));
    expect(pairs.length).toBeGreaterThan(0);
    expect([...hosts].every((h) => h === "shrine")).toBe(true);
  });

  it("mirrors the guardian pair about the door's axis, 1.25-2.5 from it", () => {
    const g = at("guardianPair").find((x) => x.host === "shrine");
    expect(g?.pieces).toHaveLength(2);
    const [a, b] = g?.pieces ?? [];
    expect(Math.abs((a?.x ?? 0) + (b?.x ?? 0))).toBeLessThanOrEqual(0.3);
    expect(Math.abs((a?.z ?? 0) - (b?.z ?? 1))).toBeLessThanOrEqual(0.3);
    expect(a?.asset).toBe(b?.asset);
    expect(Math.abs(a?.x ?? 0)).toBeGreaterThanOrEqual(1.25);
    expect(Math.abs(a?.x ?? 0)).toBeLessThanOrEqual(2.5);
  });

  it("sets the approach lights as a pair further out, beside the way", () => {
    const l = at("approachLights").find((x) => x.host === "shrine");
    const g = at("guardianPair").find((x) => x.host === "shrine");
    expect(l?.pieces).toHaveLength(2);
    expect(Math.min(...(l?.pieces ?? []).map((p) => p.z))).toBeGreaterThan(
      Math.max(...(g?.pieces ?? []).map((p) => p.z)),
    );
  });
});

describe("the condition and threshold recipes against the meter's hard rules", () => {
  it("rest, never duplicate, never flicker", () => {
    for (const r of ["wallFootGrowth", "breachRubble", "guardianPair", "approachLights"]) {
      const ps = ofRecipe(r);
      expect(ps.length, r).toBeGreaterThan(0);
      expect(duplicateCount(ps), r).toBe(0);
      expect(coplanarShare(ps), r).toBe(0);
      expect(restContact(ps, everything), r).toEqual([]);
    }
  }, 60_000);

  it("are deterministic, and none is built before generator 5 or with its switch off", () => {
    expect(run().attached).toEqual(all.attached);
    expect(resolvePlan({ ...plan, generator: 4 }, pal).levels[0]?.arrangements).toBeUndefined();
    const off = {
      ...generatorProfile(5),
      wallFootGrowth: false,
      breachRubble: false,
      guardianPair: false,
      approachLights: false,
    };
    expect(run(off).attached).toEqual([]);
  });
});
