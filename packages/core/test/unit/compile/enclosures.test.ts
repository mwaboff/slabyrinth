/**
 * Enclosure gates (resolve/structure.ts addFencesAndGates, compile/realize/structures/enclosures.ts): each gate of a
 * yard is an open gateway of its width on its side, and the build hangs a gate piece in it when the fence style has
 * one of that length (gate.<style>, else opening.door.<style>); otherwise the gateway stays open with a role_missing
 * note. The fixture is test/fixtures/plans/enclosure-gates-v1.json (also in the generator-4 golden and the sweep).
 */
import { describe, expect, it } from "vitest";
import { compileResolved, placedBox, realize } from "../../../src/compile";
import type { Box3, Placement, PlacementSet } from "../../../src/contracts/compiler";
import type { MapPlan, Structure } from "../../../src/contracts/plan";
import type { ResolvedLevel, ResolvedPlan } from "../../../src/contracts/resolved";
import { loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { slabCodec } from "../../../src/slab";
import { loadPlan } from "../../fixtures";

const palettes = loadPalettes();
const PLAN = loadPlan("enclosure-gates-v1");

const levelOf = (r: ResolvedPlan): ResolvedLevel => {
  const L = r.levels[0];
  if (!L) throw new Error("no level");
  return L;
};
const pieces = (set: PlacementSet, id: string): Placement[] =>
  (set.levels[0]?.placements ?? []).filter((p) => p.source.elementId === id);
const box = (set: PlacementSet, p: Placement | undefined): Box3 => {
  if (!p) throw new Error("no piece");
  return placedBox(set, p);
};

/** The fixture with one yard's gates replaced. */
function withGates(
  id: string,
  gates: NonNullable<Extract<Structure, { kind: "enclosure" }>["gates"]>,
): MapPlan {
  const plan = structuredClone(PLAN);
  const st = plan.levels[0]?.structures?.find((s) => s.id === id);
  if (st?.kind !== "enclosure") throw new Error(`fixture: no enclosure ${id}`);
  st.gates = gates;
  return plan;
}

describe("enclosure gates: resolve", () => {
  const r = resolvePlan(PLAN, palettes);
  const L = levelOf(r);

  it("each gate is an open gateway of its width on the side the plan names", () => {
    const gate = (id: string) => L.openings.find((o) => o.id === id);
    // paddock (3,3) 10x7: S edge row 10, E edge column 13; pen (20,3) 9x7: N edge row 3, W edge column 20
    expect(gate("paddock~gate0")).toMatchObject({ kind: "open", orientation: "h", width: 2, start: [7, 10] });
    expect(gate("paddock~gate1")).toMatchObject({ kind: "open", orientation: "v", width: 1 });
    expect(gate("paddock~gate1")?.start[0]).toBe(13);
    expect(gate("pen~gate0")).toMatchObject({ kind: "open", orientation: "h", width: 3, start: [23, 3] });
    expect(gate("pen~gate1")).toMatchObject({ kind: "open", orientation: "v", width: 1 });
    expect(gate("pen~gate1")?.start[0]).toBe(20);
    const fence = L.structures?.find((s) => s.id === "garden")?.fence;
    expect(fence).toEqual({ style: "hedge", gates: [{ at: [8, 17], side: "N" }] });
  });

  it("a yard without a floor of its own raises no warning about walls the plan never set (quietYardZones)", () => {
    const noEffect = (p: MapPlan): string[] =>
      resolvePlan(p, palettes)
        .issues.filter((i) => i.code === "no_effect")
        .map((i) => i.elementId ?? "");
    expect(noEffect(PLAN)).toEqual([]);
    // generator 3 is frozen: it still says so
    expect(noEffect({ ...PLAN, generator: 3 })).toEqual(["pen", "garden"]);
  });
});

describe("enclosure gates: realize", () => {
  const r = resolvePlan(PLAN, palettes);
  const set = realize(r, palettes, {});
  const missing = set.diagnostics.filter((d) => d.code === "role_missing").map((d) => d.message);

  it("a gateway as wide as the gate piece gets one piece that spans it on its edge", () => {
    const gate = pieces(set, "paddock~gate0");
    expect(gate).toHaveLength(1);
    expect(gate[0]?.role).toBe("opening");
    const b = box(set, gate[0]);
    // the gateway's cells are x 7 and 8; the edge line is the paddock's south edge, world z 16 (rows run north to south)
    expect(b.min.x).toBeCloseTo(7, 5);
    expect(b.max.x).toBeCloseTo(9, 5);
    expect(b.min.z).toBeGreaterThanOrEqual(15);
    expect(b.max.z).toBeLessThanOrEqual(17);
  });

  it("a gateway with no gate piece of its width, and a fence style with none at all, stay open with a note", () => {
    for (const id of ["paddock~gate1", "pen~gate0", "pen~gate1", "garden~gate0", "yard~gate0"])
      expect(pieces(set, id), id).toEqual([]);
    // (notes are gathered per role: one for the palisade's three open gateways)
    expect(missing.some((m) => m.includes("palisade fence"))).toBe(true);
    expect(missing.some((m) => m.includes("hedge fence") && m.includes("garden"))).toBe(true);
    expect(missing.some((m) => m.includes("low_wall fence") && m.includes("yard"))).toBe(true);
  });

  it("the fixture builds without verify errors", () => {
    const bundle = compileResolved(r, palettes, slabCodec, { createdAt: "t", plan: PLAN });
    expect(bundle.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)).toEqual([]);
  });

  // Known bug (left for the owner): the bundled palisade gate ("Doors - Palisade") has its origin off its box (geom
  // originAt "other", no variant offset), and placeEdgePiece places by origin. It lands in the yard's half cell, not
  // the fence's; on a west or east side it is also turned onto the wrong cells (verify_door_misplaced, _buried).
  // When this passes, drop `.fails`.
  it.fails("a gate piece stands in its fence's half cell, on any side", () => {
    const gate = box(set, pieces(set, "paddock~gate0")[0]);
    const fence = (set.levels[0]?.placements ?? []).filter(
      (p) => p.role === "wall" && placedBox(set, p).min.z < 16.25 && placedBox(set, p).max.z > 15.25,
    );
    expect(fence.length).toBeGreaterThan(0);
    const fz = placedBox(set, fence[0] as Placement);
    expect([gate.min.z, gate.max.z]).toEqual([fz.min.z, fz.max.z]);
    const west = withGates("pen", [{ side: "W", width: 2 }]);
    const rw = resolvePlan(west, palettes);
    const errors = compileResolved(rw, palettes, slabCodec, {
      createdAt: "t",
      plan: west,
    }).diagnostics.filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
  });
});
