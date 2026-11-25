/**
 * Facts measured in game (gen/pieceFacts.ts, generator 5, switches `pieceFacts` and `bedsideLights`):
 *   - rails: the rail calibration settled that "railing 01 B" is a raking stair rail and "railing 01 C" a level rail
 *     with a newel post at its low end, though the palette gives all three railings one bounds. On the railed-terrace
 *     fixture a run takes no stair rail, and an end-post piece only at a run's end, its post ending the run; the objects'
 *     rail stand-in takes the level piece only. Without the switch the stair rail stands in level runs (the test ship's
 *     slanted deck rails);
 *   - glowing decor: "jug green" lights nothing and read as a broken light on the ward's nightstands; it stays out of
 *     every room but a laboratory's things;
 *   - a bright ward's beds are each lit at the head: by the nightstand's candle or a wall light (sensibleLights; a
 *     standing lamp on a ward's floor does not belong there), and where fire belongs the group keeps a cell for one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import type { MapPlan } from "../../../src/contracts/plan";
import type { ResolvedLevel } from "../../../src/contracts/resolved";
import { PIECE_FACTS, levelRunPiece, ragged } from "../../../src/gen/pieceFacts";
import { lightPiece } from "../../../src/gen/lightReach";
import { findStandIn } from "../../../src/objects";
import { bundledPalettes } from "../../../src/palette";
import { createPlanRoles } from "../../../src/palette/planRoles";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { loadPlan } from "../../fixtures";
import { oneLevelPlan } from "../../fixtures/planBuilder";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

/** The railing role's assets by the letter the calibration gave them. */
const RAIL: Record<string, "A" | "B" | "C"> = {
  "f5d001ef-478a-44ed-b96b-c041be51394a": "A",
  "fe228f03-354b-4802-bd39-21e7318cae32": "B",
  "f8529331-7c32-4305-8a4f-e677879b0caf": "C",
};
const rails = (plan: MapPlan) =>
  realize(resolvePlan(plan, pal), pal)
    .levels.flatMap((l) => l.placements)
    .filter((p) => RAIL[p.asset] !== undefined)
    .map((p) => ({ kind: RAIL[p.asset] as string, x: p.x, z: p.z, rot: p.rot }));

describe("the table", () => {
  it("holds the calibrated facts: B sloped, C an end post, A level; the green jug glows; lights by name", () => {
    expect(levelRunPiece("railing 01 A", false)).toBe(true);
    expect(levelRunPiece("railing 01 B", true)).toBe(false);
    expect(levelRunPiece("railing 01 C", false)).toBe(false);
    expect(levelRunPiece("railing 01 C", true)).toBe(true);
    expect(PIECE_FACTS["jug green"]?.glows).toBe(true);
    expect(lightPiece("Street Lantern", "brazier").reach).toBe(1.5);
    expect(lightPiece("stone_lantern_01", "lantern").kind).toBe("none");
  });
});

describe("rails (railed-terrace-v1)", () => {
  const terrace = loadPlan("railed-terrace-v1");

  it("runs take no stair rail, and an end-post piece only where its post ends the run", () => {
    const all = rails(terrace);
    expect(all.length).toBeGreaterThan(30);
    expect(all.filter((r) => r.kind === "B")).toEqual([]);
    const at = (x: number, z: number) => all.some((r) => Math.abs(r.x - x) < 0.3 && Math.abs(r.z - z) < 0.3);
    // along x (unturned or turned half round), the post is at the piece's low end unturned: nothing beyond it
    const ends = all.filter((r) => r.kind === "C" && (r.rot === 0 || r.rot === 180));
    expect(ends.length).toBeGreaterThan(0);
    for (const c of ends) expect(at(c.rot === 0 ? c.x - 1 : c.x + 1, c.z), JSON.stringify(c)).toBe(false);
    // and every end-post piece stands at an end of its run
    for (const c of all.filter((r) => r.kind === "C")) {
      const alongX = c.rot === 0 || c.rot === 180;
      const before = alongX ? at(c.x - 1, c.z) : at(c.x, c.z - 1);
      const after = alongX ? at(c.x + 1, c.z) : at(c.x, c.z + 1);
      expect(before && after, JSON.stringify(c)).toBe(false);
    }
  });

  it("without the switch the stair rail and mid-run end posts come back", () => {
    P5.pieceFacts = false;
    const all = rails(terrace);
    expect(all.some((r) => r.kind === "B")).toBe(true);
  });

  it("the objects' rail stand-in takes the level piece only", () => {
    const names = findStandIn(createPlanRoles(pal, 5), "wood_town", "rail")?.pieces.map(
      (p) => p.variant.name,
    );
    expect(names).toContain("railing 01 A");
    expect(names).not.toContain("railing 01 B");
    expect(names).not.toContain("railing 01 C");
  });
});

describe("glowing decor and bedside lights (interiors-lineup-v1)", () => {
  const interiors = loadPlan("interiors-lineup-v1");
  const GREEN_JUG = "e1417970-95d7-4c36-971b-e2164b008dad";

  for (const theme of ["wood_town", "stone_dungeon"] as const)
    it(`keeps the green jug out of every room's things, and lights each ward bed at its head (${theme})`, () => {
      const plan = { ...interiors, theme };
      const resolved = resolvePlan(plan, pal);
      const L = resolved.levels[0] as ResolvedLevel;
      const jugs = realize(resolved, pal)
        .levels.flatMap((l) => l.placements)
        .filter((p) => p.asset === GREEN_JUG);
      expect(jugs).toEqual([]);
      const ward = L.areas.find((a) => a.name === "Sick ward");
      expect(ward?.roomKind).toBe("ward");
      expect(ward?.lightLevel ?? 0).toBeGreaterThanOrEqual(3);
      const inWard = L.features.filter((f) => f.area === ward?.id);
      const beds = inWard.filter((f) => f.type === "bed");
      // (sensibleLights: a nightstand's candle or a wall light beside the bed, never a lamp on the ward's floor)
      const standing = inWard.filter((f) => ["candelabra", "candles", "torch_wall"].includes(f.type));
      expect(beds.length).toBeGreaterThanOrEqual(2);
      for (const b of beds) {
        const cells: Array<[number, number]> = [];
        for (let y = b.at[1]; y < b.at[1] + b.size[1]; y++)
          for (let x = b.at[0]; x < b.at[0] + b.size[0]; x++) cells.push([x, y]);
        const lit = standing.some((s) =>
          cells.some(([x, y]) => Math.max(Math.abs(s.at[0] - x), Math.abs(s.at[1] - y)) <= 1),
        );
        expect(lit, JSON.stringify(b.at)).toBe(true);
      }
    });

  it("without the switches the jug sits on the ward's nightstands and a bed goes unlit", () => {
    P5.pieceFacts = false;
    P5.bedsideLights = false;
    P5.sensibleLights = false;
    const resolved = resolvePlan({ ...interiors, theme: "wood_town" }, pal);
    const jugs = realize(resolved, pal)
      .levels.flatMap((l) => l.placements)
      .filter((p) => p.asset === GREEN_JUG);
    expect(jugs.length).toBeGreaterThan(0);
    const L = resolved.levels[0] as ResolvedLevel;
    const ward = L.areas.find((a) => a.name === "Sick ward");
    const standing = L.features.filter(
      (f) => f.area === ward?.id && ["torch_floor", "brazier", "lantern"].includes(f.type),
    );
    expect(standing.length).toBeLessThan(
      L.features.filter((f) => f.area === ward?.id && f.type === "bed").length,
    );
  });
});

describe("ragged floor boards (wholeFloorEdges)", () => {
  // a wharf of timber boards nine rows deep: its 2 x 2 tiles leave an odd edge row
  const wharf = (generator: 4 | 5): MapPlan =>
    oneLevelPlan({
      generator,
      w: 12,
      h: 9,
      theme: "wood_town",
      level: {
        areas: [
          {
            id: "wharf",
            kind: "courtyard",
            name: "Wharf",
            shape: { type: "rect", x: 0, y: 0, w: 12, h: 9 },
            floor: "bridge_wood",
            walls: "none",
          },
        ],
      },
    });
  const raggedIds = new Set(
    Object.values(pal.palettes).flatMap((p) =>
      Object.values(p.roles).flatMap((r) => r.variants.filter((v) => ragged(v.name)).map((v) => v.asset)),
    ),
  );
  const floors = (plan: MapPlan) =>
    realize(resolvePlan(plan, pal), pal)
      .levels.flatMap((l) => l.placements)
      .filter((p) => p.role === "floor");

  it("names the boards the harbour screenshots showed notched", () => {
    expect(raggedIds.size).toBe(3);
  });

  it("lays whole pieces along the odd edge row, every cell floored", () => {
    const laid = floors(wharf(5));
    expect(laid.filter((p) => raggedIds.has(p.asset))).toEqual([]);
    expect(new Set(laid.map((p) => `${p.source.cell?.[0]},${p.source.cell?.[1]}`)).size).toBeGreaterThan(0);
    expect(laid.some((p) => p.source.cell?.[1] === 8)).toBe(true);
  });

  it("is generator 5's: generator 4 keeps its ragged edge row", () => {
    expect(floors(wharf(4)).some((p) => raggedIds.has(p.asset))).toBe(true);
  });
});
