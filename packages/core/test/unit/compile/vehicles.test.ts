/**
 * Vehicles and long props (owner's model test of "a modern city street", 2026-11-20): taxis stood across the road
 * and half on the pavement, a 4×2 "Stalled bus" became a taxi, and the street preset's parked cars stacked on top
 * of the model's own. Measured on resolved features and realized placements.
 */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import { realize } from "../../../src/compile";
import { loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import "../../../src/resolve/autoregister";
import { handLevel, handPlan } from "./handResolved";

const cat = loadPalettes();
const room = ["##########", "#........#", "#........#", "#........#", "##########"];

describe("long assets lie along long features", () => {
  it("a 3×1 vehicle gets the taxi turned a quarter so its length runs along the feature", () => {
    const set = realize(
      handPlan([
        handLevel({
          id: "l1",
          rows: room,
          theme: "city",
          features: [{ id: "car", type: "vehicle", at: [2, 2], size: [3, 1], rot: 0, label: "Parked car" }],
        }),
      ]),
      cat,
    );
    const p = set.levels[0]?.placements.find((q) => q.source.elementId === "car");
    expect(p).toBeDefined();
    expect(Math.round((p?.rot ?? 0) / 90) % 2).toBe(1);
  });

  it("a 4×2 bus the theme cannot honour places nothing and says so", () => {
    const set = realize(
      handPlan([
        handLevel({
          id: "l1",
          rows: room,
          theme: "city",
          features: [{ id: "bus", type: "vehicle", at: [2, 2], size: [4, 2], rot: 0, label: "Stalled bus" }],
        }),
      ]),
      cat,
    );
    expect(set.levels[0]?.placements.some((q) => q.source.elementId === "bus")).toBe(false);
    const d = set.diagnostics.find((q) => q.elementId === "bus");
    expect(d?.severity).toBe("info");
  });
});

const street = (features: MapPlan["levels"][number]["features"], dress = false): MapPlan =>
  ({
    schema: "slabyrinth/plan@1",
    generator: 2,
    id: "veh",
    title: "veh",
    kind: "town",
    theme: "city",
    seed: 5,
    links: [],
    levels: [
      {
        id: "s",
        name: "s",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 48, h: 16 },
        base: { type: "ground", material: "concrete" },
        areas: [{ id: "st", kind: "zone", shape: { type: "rect", x: 0, y: 3, w: 48, h: 10 } }],
        openings: [],
        walls: [],
        features,
        terrain: [
          {
            id: "road",
            op: "path",
            points: [
              [0, 8],
              [47, 8],
            ],
            width: 4,
            material: "asphalt",
            sidewalk: { width: 2, material: "concrete" },
          },
          ...(dress ? [{ id: "d", op: "dress", area: "st", preset: "street", density: 0.7 }] : []),
        ],
        labels: [],
      },
    ],
  }) as unknown as MapPlan;

describe("vehicles the plan places near a road park in the kerb lane", () => {
  it("one on the pavement, set across the road, is moved into the lane along the road with an info note", () => {
    const r = resolvePlan(street([{ id: "car", type: "vehicle", at: [10, 4], size: [2, 3] }]));
    const L = r.levels[0];
    const road = L?.roads?.[0];
    const f = L?.features.find((q) => q.id === "car");
    expect(f && road).toBeTruthy();
    if (!f || !road) return;
    const cw = new Set(road.carriageway.map(([x, y]) => `${String(x)},${String(y)}`));
    const pave = new Set(road.pavement.map(([x, y]) => `${String(x)},${String(y)}`));
    expect(f.size[0]).toBeGreaterThan(f.size[1]); // along the east–west road
    for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
      for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) {
        expect(cw.has(`${String(x)},${String(y)}`)).toBe(true);
        expect(pave.has(`${String(x)},${String(y + (f.at[1] < 8 ? -1 : 1))}`)).toBe(true); // against a kerb
      }
    expect(
      r.issues.some((i) => i.code === "feature_moved" && i.elementId === "car" && i.severity === "info"),
    ).toBe(true);
  });

  it("one in a yard away from the road keeps its spot", () => {
    const r = resolvePlan(street([{ id: "yard", type: "vehicle", at: [10, 0], size: [3, 2] }]));
    const f = r.levels[0]?.features.find((q) => q.id === "yard");
    expect(f?.at).toEqual([10, 0]);
  });

  it("the street preset counts the plan's vehicles toward one parked car per 12 lane cells", () => {
    const plan = street(
      [
        { id: "c1", type: "vehicle", at: [6, 6], size: [3, 1] },
        { id: "c2", type: "vehicle", at: [30, 9], size: [3, 1] },
      ],
      true,
    );
    const L = resolvePlan(plan).levels[0];
    const all = L?.features.filter((q) => q.type === "vehicle") ?? [];
    // two lanes of 48 cells: about 96 lane cells, so at most 8 vehicles in all
    expect(all.length).toBeLessThanOrEqual(8);
    expect(all.length).toBeGreaterThanOrEqual(3);
    // no preset car within four cells of a plan car in the same lane
    for (const p of all.filter((q) => q.generatedBy === "d"))
      for (const c of all.filter((q) => q.generatedBy === undefined))
        if (p.at[1] === c.at[1]) expect(Math.abs(p.at[0] - c.at[0])).toBeGreaterThan(3);
  });
});
