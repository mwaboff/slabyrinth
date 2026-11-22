/**
 * The quality meter over whole builds (src/review/qualityMap.ts), its metric table (qualityMetrics.ts) and the notes it
 * gives the model at generator 5 (qualityNotes.ts): each map metric on a small plan with a known answer, each note
 * firing on a fault and silent without it, and silent at generator 4 (the switch).
 */
import { describe, expect, it } from "vitest";
import type {
  Area,
  Building,
  Feature,
  GeneratorVersion,
  MapPlan,
  Opening,
} from "../../../src/contracts/plan";
import type { ResolvedPlan } from "../../../src/contracts/resolved";
import { realize } from "../../../src/compile";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import {
  QUALITY_METRICS,
  qualityMeter,
  qualityOfBuild,
  qualityTable,
  reviewDesign,
  targetText,
  withinTarget,
  type DesignNoteCode,
} from "../../../src/review";
import { bandCoverage, blockedLanes } from "../../fixtures/quality";
import { dungeonPlan, townPlan } from "../../fixtures/planBuilder";

const palettes = bundledPalettes();

/** Three rooms in a row, doors west and east of the hall: the hall's lane runs along row 6. */
function rooms(generator: GeneratorVersion, features: Feature[]): MapPlan {
  const areas: Area[] = [
    { id: "west", kind: "room", name: "West", shape: { type: "rect", x: 1, y: 5, w: 2, h: 3 } },
    { id: "hall", kind: "room", name: "Hall", shape: { type: "rect", x: 3, y: 2, w: 9, h: 9 } },
    { id: "east", kind: "room", name: "East", shape: { type: "rect", x: 12, y: 5, w: 2, h: 3 } },
  ];
  const openings: Opening[] = [
    { id: "d1", kind: "door", at: { x: 3, y: 6, side: "W" } },
    { id: "d2", kind: "door", at: { x: 11, y: 6, side: "E" } },
  ];
  return dungeonPlan({
    generator,
    id: "quality-rooms",
    theme: "wood_town",
    kind: "building",
    w: 16,
    h: 13,
    levelId: "l1",
    areas,
    openings,
    level: { features, roomDress: false },
  });
}
const table = (x: number, y: number): Feature => ({ id: `table${x}`, type: "table", at: [x, y] });
const chest = (x: number, y: number): Feature => ({ id: `chest${x}`, type: "chest", at: [x, y] });
const torch: Feature = { id: "torch", type: "torch_wall", at: [3, 2], wall: "N" };
/** Two storeys of plaster (a bare `storeys: 2` leaves a cottage's storeys to its style). */
const TWO: Building["storeys"] = [{ walls: "plaster" }, { walls: "plaster" }];
const NO_FURNITURE: Building["roofFurniture"] = { dormers: false, mast: false, finial: false };

const build = (p: MapPlan): { r: ResolvedPlan; set: ReturnType<typeof realize> } => {
  const r = resolvePlan(p, palettes);
  return { r, set: realize(r, palettes, {}) };
};

const codes = (p: MapPlan): DesignNoteCode[] =>
  reviewDesign(p, resolvePlan(p, palettes), palettes, { limit: 999 }).map((n) => n.code);

/** The notes of a plan built with no detail recipes: every building dressed alike (none). */
const undressed = (p: MapPlan): DesignNoteCode[] => {
  const r = resolvePlan(p, palettes);
  const bare = {
    ...r,
    levels: r.levels.map((L) => {
      const c = { ...L };
      delete c.arrangements;
      return c;
    }),
  };
  return reviewDesign(p, bare, palettes, { limit: 999 }).map((n) => n.code);
};

const QUALITY_CODES = ["lane_blocked", "doors_unlit", "silhouette_flat", "facades_alike"] as const;

describe("the metric table", () => {
  it("defines every metric once, and a report has a value for each", () => {
    const ids = QUALITY_METRICS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const { r, set } = build(rooms(5, []));
    expect(Object.keys(qualityMeter(r, set).values).sort()).toEqual([...ids].sort());
  });

  it("targets read as text and judge a value", () => {
    expect(targetText("lights_per_floor_tile")).toBe("0.05–0.38");
    expect(targetText("overlap_share")).toBe("≥ 0.49");
    expect(targetText("lane_blocked")).toBe("≤ 0.1");
    expect(targetText("pieces")).toBe("–");
    expect(withinTarget("lane_blocked", 0.2)).toBe(false);
    expect(withinTarget("lane_blocked", null)).toBe(true);
    expect(withinTarget("pieces", 9999)).toBe(true);
  });

  it("every map metric has a source and a confidence; hard rules are named", () => {
    for (const m of QUALITY_METRICS) expect(m.source.length, m.id).toBeGreaterThan(3);
    expect(QUALITY_METRICS.filter((m) => m.hard).map((m) => m.id)).toEqual([
      "structure_off_axis",
      "prop_rest_contact",
      "coplanar_share",
      "stamped_groups",
      "exact_duplicates",
      "lane_blocked",
      "band_coverage",
    ]);
  });
});

describe("map tier", () => {
  it("lane: a table on the line between the doors blocks the hall's lane; one by the wall does not", () => {
    const blocked = build(rooms(5, [table(7, 6)]));
    const hall = qualityMeter(blocked.r, blocked.set).rooms.find((x) => x.id === "hall");
    expect(hall?.lane).toBe(9); // the cells (3..11, 6)
    expect(hall?.laneBlocked).toBeGreaterThan(0.1);
    expect(blockedLanes(blocked.r, blocked.set).map((x) => x.id)).toEqual(["hall"]);
    const clear = build(rooms(5, [table(4, 3)]));
    expect(qualityMeter(clear.r, clear.set).values.lane_blocked).toBe(0);
    expect(blockedLanes(clear.r, clear.set)).toEqual([]);
  });

  it("props by walls: a chest in a corner is by a wall, a table in the middle is not", () => {
    const { r, set } = build(rooms(5, [chest(3, 10), table(7, 6)]));
    expect(qualityMeter(r, set).values.props_near_wall).toBe(0.5);
  });

  it("lights per floor tile over the rooms' walkable cells", () => {
    const { r, set } = build(rooms(5, [torch]));
    const v = qualityMeter(r, set);
    // 6 + 81 + 6 walkable cells, one light
    expect(v.values.lights_per_floor_tile).toBeCloseTo(1 / 93, 4);
    expect(v.rooms.find((x) => x.id === "hall")?.lights).toBeCloseTo(1 / 81, 4);
  });

  it("focal contrast: detail piled in one corner against an empty room is high; none measures nothing", () => {
    const piled = build(rooms(5, [chest(3, 10), chest(4, 10), chest(3, 9), table(4, 8)]));
    expect(qualityMeter(piled.r, piled.set).values.focal_contrast).toBeGreaterThanOrEqual(3);
    const bare = build(rooms(5, []));
    expect(qualityMeter(bare.r, bare.set).values.focal_contrast).toBeNull();
  });

  it("outside doors lit: door lights on, every door lit; off, none; ruins are not counted", () => {
    const house = (lighting: Building["lighting"], condition?: Building["condition"]): MapPlan =>
      townPlan({
        generator: 5,
        w: 24,
        h: 20,
        theme: "wood_town",
        structures: [
          {
            id: "house",
            style: "cottage",
            wings: [{ x: 6, y: 6, w: 8, h: 6 }],
            openings: [
              { kind: "door", side: "S", position: 0.3 },
              { kind: "door", side: "N", position: 0.6 },
            ],
            ...(lighting ? { lighting } : {}),
            ...(condition ? { condition } : {}),
          },
        ],
      });
    const lit = build(house({ doors: true }));
    expect(qualityMeter(lit.r, lit.set).values.doors_lit).toBe(1);
    const dark = build(house({ doors: false }));
    expect(qualityMeter(dark.r, dark.set).values.doors_lit).toBe(0);
    const ruin = build(house({ doors: false }, "ruined"));
    expect(qualityMeter(ruin.r, ruin.set).values.doors_lit).toBeNull();
  });

  it("band coverage: measured on two-storey buildings only", () => {
    const one = build(
      townPlan({
        generator: 5,
        w: 20,
        h: 20,
        theme: "wood_town",
        structures: [{ id: "a", style: "cottage", wings: [{ x: 5, y: 5, w: 6, h: 6 }], storeys: [{}] }],
      }),
    );
    expect(bandCoverage(one.r, one.set)).toBeNull();
    const two = build(
      townPlan({
        generator: 5,
        w: 20,
        h: 20,
        theme: "wood_town",
        structures: [{ id: "a", style: "cottage", wings: [{ x: 5, y: 5, w: 6, h: 6 }], storeys: TWO }],
      }),
    );
    const band = bandCoverage(two.r, two.set);
    expect(band).not.toBeNull();
    expect(band).toBeGreaterThanOrEqual(0);
    expect(band).toBeLessThanOrEqual(1);
  });

  it("the report prints a table with targets, and the build measured is the verified one", () => {
    const p = rooms(5, [table(7, 6)]);
    const report = qualityOfBuild(p, resolvePlan(p, palettes), palettes);
    const text = qualityTable(report);
    expect(text).toMatch(/^metric\s+value\s+target/);
    expect(text).toMatch(/lane_blocked\s+[\d.]+\s+≤ 0\.1\s+OUT/);
    expect(text).toMatch(/hall/);
    expect(report.values.exact_duplicates).toBe(0);
  });
});

describe("quality notes (generator 5)", () => {
  it("lane_blocked: the plan's table between the doors; silent by the wall and at generator 4", () => {
    expect(codes(rooms(5, [table(7, 6)]))).toContain("lane_blocked");
    expect(codes(rooms(5, [table(4, 3)]))).not.toContain("lane_blocked");
    expect(codes(rooms(4, [table(7, 6)]))).not.toContain("lane_blocked");
  });

  const street = (generator: GeneratorVersion, buildings: Building[]): MapPlan =>
    townPlan({ generator, w: 44, h: 20, theme: "wood_town", structures: buildings });
  const house = (id: string, x: number, extra: Partial<Building> = {}): Building => ({
    id,
    style: "cottage",
    wings: [{ x, y: 6, w: 6, h: 6 }],
    chimneys: [{ side: "E" }],
    lighting: { doors: true },
    ...extra,
  });

  it("doors_unlit: two outside doors with no light and door lights off; silent with door lights", () => {
    const doors: Building["openings"] = [
      { kind: "door", side: "S", position: 0.3 },
      { kind: "door", side: "N", position: 0.6 },
    ];
    expect(codes(street(5, [house("a", 4, { openings: doors, lighting: { doors: false } })]))).toContain(
      "doors_unlit",
    );
    expect(codes(street(5, [house("a", 4, { openings: doors })]))).not.toContain("doors_unlit");
    expect(codes(street(4, [house("a", 4, { openings: doors, lighting: { doors: false } })]))).not.toContain(
      "doors_unlit",
    );
  });

  it("silhouette_flat: a two-storey house with nothing above its roof; a chimney is enough", () => {
    const bare = house("a", 4, { storeys: TWO, chimneys: [], roofFurniture: NO_FURNITURE });
    expect(codes(street(5, [bare]))).toContain("silhouette_flat");
    expect(codes(street(5, [house("a", 4, { storeys: TWO })]))).not.toContain("silhouette_flat");
    expect(codes(street(4, [bare]))).not.toContain("silhouette_flat");
  });

  it("facades_alike: three neighbours with the same storeys, walls and dressing; varied ones are fine", () => {
    const same = (id: string, x: number): Building =>
      house(id, x, { storeys: [{ walls: "plaster" }, { walls: "plaster" }] });
    expect(undressed(street(5, [same("a", 2), same("b", 10), same("c", 18)]))).toContain("facades_alike");
    // the detail treatments dress neighbours differently (resolve/recipes/treatments.ts), so the built street is varied
    expect(codes(street(5, [same("a", 2), same("b", 10), same("c", 18)]))).not.toContain("facades_alike");
    const varied = [
      same("a", 2),
      house("b", 10, { storeys: [{ walls: "stone" }] }),
      house("c", 18, {
        storeys: [{ walls: "plaster" }, { walls: "plaster" }, { walls: "plaster" }, { walls: "plaster" }],
      }),
    ];
    expect(codes(street(5, varied))).not.toContain("facades_alike");
    expect(codes(street(4, [same("a", 2), same("b", 10), same("c", 18)]))).not.toContain("facades_alike");
  });

  it("no quality note runs below generator 5 (the switch), so released reviews are unchanged", () => {
    const busy = street(4, [
      house("a", 2, { storeys: TWO, chimneys: [], roofFurniture: NO_FURNITURE }),
      house("b", 10, { storeys: TWO, chimneys: [], roofFurniture: NO_FURNITURE }),
      house("c", 18, { storeys: TWO, chimneys: [], roofFurniture: NO_FURNITURE }),
    ]);
    // the same street at generator 5 has them (so the silence above is the switch, not the street)
    const at5 = codes({ ...busy, generator: 5 });
    expect(undressed({ ...busy, generator: 5 })).toContain("facades_alike");
    expect(at5).toContain("silhouette_flat");
    const found = codes(busy);
    for (const c of QUALITY_CODES) expect(found).not.toContain(c);
  });
});
