/**
 * Generator 4: an intact roof is whole. A chimney takes the one cell its stack stands in and nothing else (the village
 * proof had a bare strip along the ridge of every odd-span roof, running out of the chimney, because the kit has no cap
 * piece; a lean-to over a stack lost a whole run-2 piece). Generators 1-3 keep their output (the goldens pin that).
 */
import { describe, expect, it } from "vitest";
import type { Building, MapPlan, Structure } from "../../../src/contracts/plan";
import type { ResolvedLevel, ResolvedStructure } from "../../../src/contracts/resolved";
import type { PlacementSet } from "../../../src/contracts/compiler";
import { realize } from "../../../src/compile";
import { loadPalettes } from "../../../src/palette";
import { reviewDesign } from "../../../src/review";
import { roofCoverOf, uncoveredRoofCells } from "../../../src/review/roofGaps";
import { resolvePlan } from "../../../src/resolve/index";
import "../../../src/resolve/autoregister";
import { townPlan } from "../../fixtures/planBuilder";

const palettes = loadPalettes();

const plan = (structures: Structure[], generator: 3 | 4, theme = "wood_town"): MapPlan =>
  townPlan({
    generator,
    id: "roofgap",
    seed: 3,
    theme,
    w: 60,
    h: 20,
    structures,
    level: { features: [{ id: "f", type: "statue", at: [1, 1] }] },
  });

/** Houses 5 to 9 cells wide with a stack at the middle of a gable end, so an odd span puts it on the ridge row. */
const houses = (roof?: Building["roof"]): Structure[] =>
  [5, 6, 7, 8, 9].map((w, i) => ({
    id: `h${i}`,
    style: "cottage",
    seed: 20 + i,
    wings: [{ x: 3 + i * 11, y: 4, w, h: 6 + (i % 2) }],
    chimneys: [{ side: i % 2 ? "E" : "W", position: 0.5 }],
    front: "S" as const,
    ...(roof ? { roof } : {}),
  }));

function built(p: MapPlan): { set: PlacementSet; sts: ResolvedStructure[]; pId: string } {
  const r = resolvePlan(p);
  return { set: realize(r, palettes), sts: (r.levels[0] as ResolvedLevel).structures ?? [], pId: p.id };
}
const open = (b: ReturnType<typeof built>, st: ResolvedStructure): Array<[number, number]> =>
  uncoveredRoofCells(st, roofCoverOf(b.set, "g", st.id, palettes));

describe("a roof with a chimney (generator 4)", () => {
  it("is open only where the stack stands: no bare ridge strip, no lost neighbour", () => {
    const b = built(plan(houses(), 4));
    expect(b.sts.length).toBe(5);
    for (const st of b.sts) {
      expect(st.chimneys.length).toBe(1);
      expect(open(b, st), st.id).toEqual([]);
    }
  });

  it("generator 3 still leaves the ridge strip open on a kit with no cap piece (frozen behaviour)", () => {
    const b = built(plan(houses(), 3));
    const gaps = b.sts.map((st) => open(b, st).length);
    expect(gaps.some((n) => n > 0)).toBe(true);
  });

  it("a lean-to over a stack keeps every cell beside the stack roofed", () => {
    // stacks on the low and high faces of a lean-to cut through its run-2 pieces
    const lean = (low: "N" | "S", generator: 3 | 4): MapPlan =>
      plan(
        houses({ type: "shed", low }).map(
          (s, i) => ({ ...s, chimneys: [{ side: i % 2 ? "N" : "S", position: 0.5 }] }) as Structure,
        ),
        generator,
      );
    for (const low of ["N", "S"] as const) {
      const g4 = built(lean(low, 4));
      for (const st of g4.sts) expect(open(g4, st), `${st.id} low ${low}`).toEqual([]);
    }
    const g3 = built(lean("S", 3));
    expect(g3.sts.some((st) => open(g3, st).length > 0)).toBe(true);
  });

  it("holds for gable, hip and lean-to roofs, and the helper never counts the stack's own cell", () => {
    for (const roof of [{ type: "gable" }, { type: "hip" }, { type: "shed", low: "W" }] as const) {
      const b = built(plan(houses(roof), 4));
      for (const st of b.sts) {
        expect(open(b, st), `${roof.type} ${st.id}`).toEqual([]);
        const stack = new Set(st.chimneys.map((c) => `${c.at[0]},${c.at[1]}`));
        // with nothing covered every roof cell is open except the stack's
        expect(uncoveredRoofCells(st, new Set()).some(([x, y]) => stack.has(`${x},${y}`))).toBe(false);
      }
    }
  });
});

describe("roof_gap in the review (generator 4)", () => {
  const codes = (p: MapPlan, set: PlacementSet): string[] =>
    reviewDesign(p, resolvePlan(p), { palettes, placements: set, limit: 99 }).map((n) => n.code);
  /** The same build with every roof piece of one building removed. */
  const stripped = (set: PlacementSet, id: string): PlacementSet => ({
    ...set,
    levels: set.levels.map((l) => ({
      ...l,
      placements: l.placements.filter(
        (q) => !(q.layer === "roof" && String(q.source.elementId).startsWith(`${id}~`)),
      ),
    })),
  });

  it("is silent for a whole roof and fires when pieces are missing from an intact building", () => {
    const p = plan(houses(), 4);
    const b = built(p);
    expect(codes(p, b.set)).not.toContain("roof_gap");
    const notes = reviewDesign(p, resolvePlan(p), {
      palettes,
      placements: stripped(b.set, "h2"),
      limit: 99,
    }).filter((n) => n.code === "roof_gap");
    expect(notes.length).toBe(1);
    expect(notes[0]?.elementIds).toEqual(["h2"]);
  });

  it("does not fire for a ruin or a weathered roof, which are meant to be broken", () => {
    for (const condition of ["ruined", "weathered"] as const) {
      const p = plan(
        houses().map((s) => ({ ...s, condition }) as Structure),
        4,
      );
      const b = built(p);
      expect(codes(p, stripped(b.set, "h2")), condition).not.toContain("roof_gap");
    }
  });

  it("is silent for generator 3 plans (their notes are frozen)", () => {
    const p = plan(houses(), 3);
    const b = built(p);
    expect(codes(p, stripped(b.set, "h2"))).not.toContain("roof_gap");
  });
});
