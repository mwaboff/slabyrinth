/**
 * Enclosure gates (resolve/structure.ts addFencesAndGates, compile/realize/structures/enclosures.ts): each gate of a
 * yard is an open gateway of its width on its side, and the build fills it with the fence style's gate pieces
 * (gate.<style>, else opening.door.<style>), longest first, end to end, in the fence's half cell (generator 4,
 * `gatesTiled`, `edgePiecesByBox`); a span no piece fits stays open with a role_missing note naming the gateway. The fixture is test/fixtures/plans/enclosure-gates-v1.json (also in the generator-4 golden and the sweep).
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
    expect(gate("paddock~gate1")).toMatchObject({ kind: "open", orientation: "v", width: 2 });
    expect(gate("paddock~gate1")?.start[0]).toBe(13);
    expect(gate("pen~gate0")).toMatchObject({ kind: "open", orientation: "h", width: 3, start: [23, 3] });
    expect(gate("pen~gate1")).toMatchObject({ kind: "open", orientation: "v", width: 3 });
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

  it("a wider gateway is filled with the longest gate pieces that fit; the rest stays open, and the note says so", () => {
    // pen's west gateway is 3 cells from row 5 (world z 21 down to 18): one 2-wide gate over rows 5 and 6
    const west = pieces(set, "pen~gate1").map((p) => box(set, p));
    expect(west).toHaveLength(1);
    expect([west[0]?.min.z, west[0]?.max.z]).toEqual([19, 21]);
    expect(missing.find((m) => m.includes("pen~gate1"))).toContain("last 1 of the 3 cells");
    // pen's north gateway is 3 cells: one 2-wide gate from its first cell, the last cell open
    const north = pieces(set, "pen~gate0").map((p) => box(set, p));
    expect(north).toHaveLength(1);
    expect([north[0]?.min.x, north[0]?.max.x]).toEqual([23, 25]);
    const note = missing.find((m) => m.includes("pen~gate0")) ?? "";
    expect(note).toContain("last 1 of the 3 cells");
    expect(note).toContain("2 wide");
    expect(note).not.toContain("No gate piece for a palisade fence");
    // a gateway narrower than every piece the fence has stays open, and the note says why
    const narrow = withGates("pen", [{ side: "E", width: 1 }]);
    const sn = realize(resolvePlan(narrow, palettes), palettes, {});
    expect(pieces(sn, "pen~gate0")).toEqual([]);
    const said = sn.diagnostics.find(
      (d) => d.code === "role_missing" && d.elementId === "pen~gate0",
    )?.message;
    expect(said).toContain("last 1 of the 1 cells");
  });

  it("a fence style with no gate piece at all leaves its gateways open with a note naming each", () => {
    for (const id of ["garden~gate0", "yard~gate0"]) expect(pieces(set, id), id).toEqual([]);
    expect(missing.some((m) => m.includes("hedge fence") && m.includes("garden~gate0"))).toBe(true);
    expect(missing.some((m) => m.includes("low_wall fence") && m.includes("yard~gate0"))).toBe(true);
  });

  it("the fixture builds without verify errors", () => {
    const bundle = compileResolved(r, palettes, slabCodec, { createdAt: "t", plan: PLAN });
    expect(bundle.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)).toEqual([]);
  });

  // The bundled palisade gate ("Doors - Palisade") has its origin off its box (geom originAt "other", boundsCenter
  // z 0.75 for a 0.5-deep box); placeEdgePiece places such a piece by its box (`edgePiecesByBox`).
  it("a gate piece stands in its fence's half cell, on every side", () => {
    const fence = (set.levels[0]?.placements ?? [])
      .filter((p) => p.role === "wall")
      .map((p) => placedBox(set, p));
    for (const id of ["paddock~gate0", "paddock~gate1", "pen~gate0", "pen~gate1"]) {
      const gates = pieces(set, id).map((p) => box(set, p));
      expect(gates.length, id).toBeGreaterThan(0);
      for (const g of gates) {
        const acrossX = g.max.x - g.min.x < g.max.z - g.min.z;
        // a fence piece on the same line, beside the gate: the same half cell across the line
        const line = fence.filter((f) =>
          acrossX
            ? f.min.x === g.min.x && f.max.x === g.max.x && (f.max.z === g.min.z || f.min.z === g.max.z)
            : f.min.z === g.min.z && f.max.z === g.max.z && (f.max.x === g.min.x || f.min.x === g.max.x),
        );
        expect(line.length, `${id}: a fence piece in line with the gate`).toBeGreaterThan(0);
      }
    }
    // generator 3 is frozen: its gate still stands by its origin, half a cell into the yard
    const g3 = { ...PLAN, generator: 3 as const };
    const s3 = realize(resolvePlan(g3, palettes), palettes, {});
    const b3 = box(s3, pieces(s3, "paddock~gate0")[0]);
    expect(b3.min.z).not.toBe(box(set, pieces(set, "paddock~gate0")[0]).min.z);
  });
});
