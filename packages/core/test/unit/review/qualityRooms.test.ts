/**
 * The meter's room rows the owner's interiors screenshots asked for (review/qualityRooms.ts): a big room's bare middle
 * and one even wall-light pitch in every room, each on a small plan with a known answer.
 */
import { describe, expect, it } from "vitest";
import type { Area, Feature, MapPlan, Opening } from "../../../src/contracts/plan";
import { realize } from "../../../src/compile";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { qualityMeter } from "../../../src/review";
import { dungeonPlan } from "../../fixtures/planBuilder";

const pal = bundledPalettes();

/** Four 6 x 5 rooms in a row, door to door, holding exactly `features` (no generated dressing). */
function row(features: Feature[]): MapPlan {
  const areas: Area[] = [0, 1, 2, 3].map((i) => ({
    id: `r${String(i)}`,
    kind: "room",
    name: `R${String(i)}`,
    shape: { type: "rect", x: 1 + 6 * i, y: 1, w: 6, h: 5 },
  }));
  const openings: Opening[] = [1, 2, 3].map((i) => ({
    id: `d${String(i)}`,
    kind: "door",
    between: [`r${String(i - 1)}`, `r${String(i)}`],
  }));
  return dungeonPlan({ generator: 5, w: 27, h: 8, areas, openings, level: { features, roomDress: false } });
}

/** One 9 x 9 hall holding exactly `features`. */
const hall = (features: Feature[]): MapPlan =>
  dungeonPlan({
    generator: 5,
    w: 12,
    h: 12,
    areas: [{ id: "hall", kind: "room", name: "Hall", shape: { type: "rect", x: 1, y: 1, w: 9, h: 9 } }],
    level: { features, roomDress: false },
  });

const meter = (p: MapPlan) => {
  const r = resolvePlan(p, pal);
  return qualityMeter(r, realize(r, pal, {})).values;
};

const torches = (room: number, pitch: number): Feature[] =>
  [0, 1, 2].map((k) => ({
    id: `t${String(room)}-${String(k)}`,
    type: "torch_wall",
    at: [1 + 6 * room + k * pitch, 1],
    wall: "N",
  }));

describe("room rows of the quality meter", () => {
  it("middle_bare: a hall with nothing in its middle is bare; a table there is not", () => {
    const wall: Feature[] = [{ id: "c", type: "chest", at: [1, 1] }];
    expect(meter(hall(wall)).middle_bare).toBe(1);
    expect(meter(hall([...wall, { id: "t", type: "table", at: [4, 5] }])).middle_bare).toBe(0);
  });

  it("light_pitch_alike: every room's torches at one pitch is 1; pitches that differ are less", () => {
    expect(meter(row([0, 1, 2, 3].flatMap((i) => torches(i, 2)))).light_pitch_alike).toBe(1);
    const mixed = meter(row([...torches(0, 1), ...torches(1, 2), ...torches(2, 2), ...torches(3, 1)]));
    expect(mixed.light_pitch_alike).toBe(0.5);
  });
});
