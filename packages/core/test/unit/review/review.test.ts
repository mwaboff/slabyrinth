/**
 * Design review (review/): each note fires on a bad fixture and stays silent on a good one. Fixtures are original
 * (never copied from a user's saved map).
 */
import { describe, expect, it } from "vitest";
import type { Building, DesignBrief, Feature, Level, MapPlan, TerrainOp } from "../../../src/contracts/plan";
import type { ResolvedPlan } from "../../../src/contracts/resolved";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import {
  briefCheckLine,
  designReviewText,
  reviewDesign,
  substitutionNotes,
  type DesignNoteCode,
} from "../../../src/review";

function plan(level: Partial<Level>, extra: Partial<MapPlan> = {}): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator: 2,
    id: "rv",
    title: "Review",
    kind: "outdoor",
    theme: "outdoor",
    seed: 7,
    links: [],
    levels: [
      {
        id: "g",
        name: "G",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 40, h: 30 },
        base: { type: "ground", material: "grass" },
        areas: [],
        openings: [],
        walls: [],
        features: [],
        terrain: [],
        labels: [],
        ...level,
      },
    ],
    ...extra,
  };
}

const codes = (
  p: MapPlan,
  opts: { brief?: DesignBrief; mutate?: (r: ResolvedPlan) => void } = {},
): DesignNoteCode[] => {
  const r = resolvePlan(p, bundledPalettes());
  opts.mutate?.(r);
  // every note, not just the top six
  return reviewDesign(p, r, bundledPalettes(), opts.brief ? { brief: opts.brief } : {}).map((n) => n.code);
};
const allCodes = (p: MapPlan, brief?: DesignBrief): Set<DesignNoteCode> => {
  // the cap hides lower notes; review each concern on its own fixture, so the cap rarely matters, but be safe
  return new Set(codes(p, brief ? { brief } : {}));
};
const f = (id: string, type: Feature["type"], x: number, y: number): Feature => ({ id, type, at: [x, y] });
const statue = f("focus", "statue", 20, 14);
const bldg = (
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Partial<Building> = {},
): Building => ({
  id,
  style: "modern_block",
  wings: [{ x, y, w, h }],
  ...extra,
});

describe("design review", () => {
  it("flat_map: an empty meadow is flat; a broad raised terrace is not", () => {
    expect(allCodes(plan({}))).toContain("flat_map");
    const terrace: TerrainOp = {
      id: "t",
      op: "platform",
      shape: { type: "rect", x: 4, y: 4, w: 24, h: 18 },
      tiers: 2,
      rise: 1,
      material: "grass",
    };
    expect(allCodes(plan({ terrain: [terrace] }))).not.toContain("flat_map");
  });

  it("straight_natural: a straight dirt trail and a clean-edged natural rise; a winding trail and ragged rise are fine", () => {
    const trail = (style: "natural" | "straight"): TerrainOp => ({
      id: "p",
      op: "path",
      points: [
        [0, 15],
        [39, 15],
      ],
      width: 2,
      material: "dirt",
      style,
    });
    expect(allCodes(plan({ terrain: [trail("straight")], features: [statue] }))).toContain(
      "straight_natural",
    );
    expect(allCodes(plan({ terrain: [trail("natural")], features: [statue] }))).not.toContain(
      "straight_natural",
    );
    const rise = (edge: "clean" | "ragged"): TerrainOp => ({
      id: "r",
      op: "platform",
      shape: { type: "rect", x: 5, y: 5, w: 20, h: 12 },
      tiers: 1,
      rise: 1,
      material: "grass",
      edge,
    });
    expect(allCodes(plan({ terrain: [rise("clean")], features: [statue] }))).toContain("straight_natural");
    expect(allCodes(plan({ terrain: [rise("ragged")], features: [statue] }))).not.toContain(
      "straight_natural",
    );
  });

  it("water_on_edge: water along the border; water across the middle is fine", () => {
    // still water (a pond) keeps its drawn course; a river would be brought off the border by the generator
    const water = (pts: Array<[number, number]>, id = "pond"): TerrainOp => ({
      id,
      op: "path",
      points: pts,
      width: 2,
      material: "water_shallow",
      style: "natural",
    });
    expect(
      allCodes(
        plan({
          terrain: [
            water([
              [0, 28],
              [39, 28],
            ]),
          ],
        }),
      ),
    ).toContain("water_on_edge");
    expect(
      allCodes(
        plan({
          terrain: [
            water([
              [20, 0],
              [18, 15],
              [21, 29],
            ]),
          ],
        }),
      ),
    ).not.toContain("water_on_edge");
  });

  it("rows_or_even_scatter: trees evenly spaced in a row; a loose clump is fine", () => {
    const row = [5, 8, 11, 14, 17].map((x, i) => f(`t${i}`, "tree", x, 6));
    expect(allCodes(plan({ features: [...row, statue] }))).toContain("rows_or_even_scatter");
    const clump = [
      [5, 5],
      [6, 7],
      [8, 6],
      [27, 21],
      [29, 22],
    ].map(([x, y], i) => f(`t${i}`, "tree", x as number, y as number));
    expect(allCodes(plan({ features: [...clump, statue] }))).not.toContain("rows_or_even_scatter");
  });

  it("dead_space: a large empty meadow; a dressed one is fine", () => {
    expect(allCodes(plan({}))).toContain("dead_space");
    const dressed: TerrainOp = { id: "s", op: "scatter", feature: "bush", density: 0.2, minSpacing: 2 };
    expect(allCodes(plan({ terrain: [dressed] }))).not.toContain("dead_space");
  });

  it("blank_lot: an empty paved square; one with stalls and crates is fine", () => {
    const paved = { base: { type: "ground" as const, material: "concrete" as const } };
    expect(allCodes(plan({ ...paved, features: [statue] }))).toContain("blank_lot");
    const stalls: TerrainOp = { id: "s", op: "scatter", feature: "crate", density: 0.25, minSpacing: 2 };
    expect(allCodes(plan({ ...paved, terrain: [stalls], features: [statue] }))).not.toContain("blank_lot");
  });

  it("lookalike_neighbours, tone_cluster, roofs_alike: three identical dark blocks; varied neighbours are fine", () => {
    const same = (id: string, x: number): Building =>
      bldg(id, x, 6, 6, 6, {
        storeys: [{ walls: "concrete" }, { walls: "concrete" }],
        roof: { type: "flat", style: "concrete" },
      });
    const bad = allCodes(
      plan({ structures: [same("a", 4), same("b", 11), same("c", 18)], features: [statue] }),
    );
    for (const c of ["lookalike_neighbours", "tone_cluster", "roofs_alike"] as const)
      expect(bad).toContain(c);
    const good = allCodes(
      plan({
        structures: [
          bldg("a", 4, 6, 6, 6, { storeys: [{ walls: "brick" }], roof: { type: "flat", style: "concrete" } }),
          bldg("b", 11, 4, 5, 8, {
            storeys: [{ walls: "panel" }, { walls: "panel" }, { walls: "panel" }],
            roof: { type: "flat", style: "industrial" },
          }),
          bldg("c", 18, 6, 8, 5, {
            storeys: [{ walls: "concrete" }, { walls: "marble" }],
            roof: { type: "hip", style: "slate" },
          }),
        ],
        features: [statue],
      }),
    );
    for (const c of ["lookalike_neighbours", "tone_cluster", "roofs_alike"] as const)
      expect(good).not.toContain(c);
  });

  it("floor_patchwork: three floors with none dominant, and a floor of contrasting tile families; one floor is fine", () => {
    const thirds: TerrainOp[] = [
      { id: "a", op: "paint", shape: { type: "rect", x: 0, y: 0, w: 14, h: 30 }, material: "dirt" },
      { id: "b", op: "paint", shape: { type: "rect", x: 14, y: 0, w: 13, h: 30 }, material: "sand" },
    ];
    expect(allCodes(plan({ terrain: thirds, features: [statue] }))).toContain("floor_patchwork");
    expect(allCodes(plan({ features: [statue] }))).not.toContain("floor_patchwork");
    const cave = plan(
      { base: { type: "ground", material: "rock" }, features: [statue] },
      { theme: "cave", kind: "cave" },
    );
    expect(allCodes(cave)).toContain("floor_patchwork");
  });

  it("no_focal_point and competing_focals: nothing to look at, or three landmarks apart; one group is fine", () => {
    expect(allCodes(plan({}))).toContain("no_focal_point");
    expect(allCodes(plan({ features: [statue] }))).not.toContain("no_focal_point");
    const apart = [f("m1", "monolith", 3, 3), f("m2", "monolith", 34, 4), f("m3", "monolith", 18, 25)];
    expect(allCodes(plan({ features: apart }))).toContain("competing_focals");
    const ring = [f("m1", "monolith", 18, 12), f("m2", "monolith", 21, 12), f("m3", "monolith", 19, 15)];
    expect(allCodes(plan({ features: ring }))).not.toContain("competing_focals");
  });

  it("landmark_against_wall: a monolith touching the cave wall; one in the open is fine", () => {
    const cave = (at: [number, number]): MapPlan =>
      plan(
        {
          base: { type: "solid" },
          areas: [{ id: "c", kind: "cave", shape: { type: "rect", x: 2, y: 2, w: 30, h: 20 } }],
          features: [f("m", "monolith", at[0], at[1])],
        },
        { theme: "cave", kind: "cave" },
      );
    expect(allCodes(cave([2, 10]))).toContain("landmark_against_wall");
    expect(allCodes(cave([16, 11]))).not.toContain("landmark_against_wall");
  });

  it("single_route: rooms in a chain with no loop; a loop is fine", () => {
    const rooms = ["a", "b", "c", "d", "e"];
    const graph = (pairs: Array<[string, string]>) => (r: ResolvedPlan) => {
      const L = r.levels[0];
      if (!L) return;
      L.areas = rooms.map((id) => ({ ...(L.areas[0] ?? ({} as never)), id, kind: "room" }));
      L.openings = pairs.map(([a, b], i) => ({
        id: `o${i}`,
        kind: "door",
        orientation: "h",
        start: [1, 1],
        width: 1,
        sides: [a, b],
        wallStyle: "wall",
        theme: "outdoor",
      }));
    };
    const chain: Array<[string, string]> = [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["d", "e"],
    ];
    const p = plan({ features: [statue] });
    expect(codes(p, { mutate: graph(chain) })).toContain("single_route");
    expect(codes(p, { mutate: graph([...chain, ["e", "a"]]) })).not.toContain("single_route");
  });

  it("path_to_nowhere: a trail that stops in open grass; one from the edge to the statue is fine", () => {
    const trail = (from: [number, number], to: [number, number]): TerrainOp => ({
      id: "p",
      op: "path",
      points: [from, to],
      width: 1,
      material: "dirt",
    });
    expect(allCodes(plan({ terrain: [trail([8, 8], [14, 22])], features: [statue] }))).toContain(
      "path_to_nowhere",
    );
    expect(allCodes(plan({ terrain: [trail([0, 14], [19, 14])], features: [statue] }))).not.toContain(
      "path_to_nowhere",
    );
  });

  it("pieces_substituted: build diagnostics of substituted pieces become one note", () => {
    const n = substitutionNotes([
      { severity: "warning", stage: "verify", code: "custom_unresolved", message: "x", elementId: "vend" },
      {
        severity: "info",
        stage: "verify",
        code: "structure_style_fallback",
        message: "y",
        role: "opening.door.brick",
      },
    ]);
    expect(n.map((q) => q.code)).toEqual(["pieces_substituted"]);
    expect(n[0]?.message).toContain("vend");
    expect(
      substitutionNotes([{ severity: "info", stage: "verify", code: "landmark_short", message: "z" }]),
    ).toEqual([]);
  });

  it("repeated_prop: six of a prop the theme has one kind of; three are fine", () => {
    const cars = (n: number) => Array.from({ length: n }, (_, i) => f(`v${i}`, "vehicle", 3 + i * 5, 20));
    expect(allCodes(plan({ features: [...cars(6), statue] }))).toContain("repeated_prop");
    expect(allCodes(plan({ features: [...cars(3), statue] }))).not.toContain("repeated_prop");
  });

  it("symmetry: buildings mirrored across the centre line; an offset layout is fine", () => {
    const mirrored = [
      bldg("a", 4, 6, 7, 6),
      bldg("b", 29, 6, 7, 6),
      bldg("c", 4, 18, 5, 5),
      bldg("d", 31, 18, 5, 5),
    ];
    expect(allCodes(plan({ structures: mirrored, features: [statue] }))).toContain("symmetry");
    const offset = [
      bldg("a", 4, 6, 7, 6),
      bldg("b", 24, 2, 9, 5),
      bldg("c", 6, 19, 5, 5),
      bldg("d", 28, 20, 8, 6),
    ];
    expect(allCodes(plan({ structures: offset, features: [statue] }))).not.toContain("symmetry");
  });

  it("no_relief: a paved block with no green, and a wild meadow with no trace of people; with relief both are fine", () => {
    const blocks = [bldg("a", 3, 3, 6, 6), bldg("b", 16, 3, 6, 6), bldg("c", 29, 3, 6, 6)];
    const paved = { base: { type: "ground" as const, material: "concrete" as const }, structures: blocks };
    expect(allCodes(plan({ ...paved, features: [statue] }))).toContain("no_relief");
    const trees = [f("t1", "tree", 5, 20), f("t2", "tree", 7, 22), f("t3", "tree", 9, 20)];
    expect(allCodes(plan({ ...paved, features: [statue, ...trees] }))).not.toContain("no_relief");
    expect(allCodes(plan({ features: [f("b", "bush", 4, 4)] }))).toContain("no_relief");
    expect(allCodes(plan({ features: [f("c", "campfire", 20, 15)] }))).not.toContain("no_relief");
  });

  it("street_without_sidewalk and misplaced_props", () => {
    const road: TerrainOp = {
      id: "road",
      op: "path",
      points: [
        [0, 15],
        [39, 15],
      ],
      width: 6,
      material: "asphalt",
      sidewalk: { width: 2, material: "concrete" },
    };
    const side = (sidewalk: boolean): TerrainOp => ({
      id: "side",
      op: "path",
      points: [
        [20, 15],
        [20, 0],
      ],
      width: 4,
      material: "asphalt",
      ...(sidewalk ? { sidewalk: { width: 2, material: "concrete" as const } } : {}),
    });
    const plaza = f("focus", "statue", 20, 25);
    const base = { base: { type: "ground" as const, material: "concrete" as const } };
    expect(allCodes(plan({ ...base, terrain: [road, side(false)], features: [plaza] }))).toContain(
      "street_without_sidewalk",
    );
    expect(allCodes(plan({ ...base, terrain: [road, side(true)], features: [plaza] }))).not.toContain(
      "street_without_sidewalk",
    );
    // carriageway rows 13–18, pavements 11–12 and 19–20 (vehicles are snapped to the carriageway by the dressing)
    const crateInRoad = [f("cr", "crate", 8, 14)];
    const parked = [f("car", "vehicle", 5, 13)];
    expect(allCodes(plan({ ...base, terrain: [road], features: [plaza, ...crateInRoad] }))).toContain(
      "misplaced_props",
    );
    expect(allCodes(plan({ ...base, terrain: [road], features: [plaza, ...parked] }))).not.toContain(
      "misplaced_props",
    );
  });

  it("brief_not_met and the brief check line", () => {
    const brief: DesignBrief = {
      mapType: { value: "Wizard tower", source: "user" },
      mustInclude: { value: ["a river crossing"], source: "user" },
    };
    const wide = plan({ structures: [bldg("t", 10, 8, 12, 9, { storeys: 1 })], features: [statue] });
    const notes = reviewDesign(wide, resolvePlan(wide, bundledPalettes()), bundledPalettes(), { brief });
    const msgs = notes.filter((n) => n.code === "brief_not_met").map((n) => n.message);
    expect(msgs.some((m) => m.includes("tower"))).toBe(true);
    expect(msgs.some((m) => m.includes("river"))).toBe(true);
    const tall = plan({
      structures: [bldg("t", 10, 8, 3, 3, { storeys: 8 })],
      terrain: [
        {
          id: "w",
          op: "path",
          points: [
            [30, 0],
            [32, 29],
          ],
          width: 2,
          material: "water_shallow",
        },
      ],
      features: [statue],
    });
    expect(
      reviewDesign(tall, resolvePlan(tall, bundledPalettes()), bundledPalettes(), { brief }).filter(
        (n) => n.code === "brief_not_met",
      ),
    ).toEqual([]);
    const line = briefCheckLine(brief, tall);
    expect(line).toContain("BRIEF CHECK");
    expect(line).toContain("Wizard tower");
    expect(line).toContain("a river crossing");
    expect(designReviewText([], line)).toContain("DESIGN REVIEW");
  });

  it("is capped, ranked and deterministic", () => {
    const p = plan({});
    const a = reviewDesign(p, resolvePlan(p, bundledPalettes()), bundledPalettes());
    const b = reviewDesign(p, resolvePlan(p, bundledPalettes()), bundledPalettes());
    expect(a).toEqual(b);
    expect(a.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < a.length; i++) expect((a[i - 1]?.score ?? 0) >= (a[i]?.score ?? 0)).toBe(true);
  });
});

describe("ruins", () => {
  const ruinPlan = (b: Building): MapPlan => plan({ outline: "rect", structures: [b], features: [statue] });
  const tower: Building = {
    id: "k",
    style: "tower",
    condition: "ruined",
    seed: 7,
    wings: [{ x: 10, y: 8, w: 5, h: 5 }],
  };
  it("ruin_flat_top: a ruin whose walls broke to one level fires; a tower broken cell by cell is quiet", () => {
    const flat = ruinPlan({ id: "k", style: "ruin", wings: [{ x: 8, y: 6, w: 10, h: 8 }] });
    expect(
      reviewDesign(flat, resolvePlan(flat, bundledPalettes()), bundledPalettes(), { limit: 99 }).map(
        (n) => n.code,
      ),
    ).toContain("ruin_flat_top");
    const good = ruinPlan(tower);
    expect(
      reviewDesign(good, resolvePlan(good, bundledPalettes()), bundledPalettes(), { limit: 99 }).map(
        (n) => n.code,
      ),
    ).not.toContain("ruin_flat_top");
  });
  it("ruin_uniform: a tall ruin decayed evenly fires; the tower with a standing mass is quiet", () => {
    const p = ruinPlan(tower);
    const good = resolvePlan(p, bundledPalettes());
    expect(reviewDesign(p, good, bundledPalettes(), { limit: 99 }).map((n) => n.code)).not.toContain(
      "ruin_uniform",
    );
    // the same tower with every wall broken to one height
    const even = resolvePlan(p, bundledPalettes());
    const st = even.levels[0]?.structures?.[0];
    const floor = st?.storeys[0]?.floorTop ?? 0;
    for (const col of st?.ruin?.columns ?? []) col.top = floor + 3;
    expect(reviewDesign(p, even, bundledPalettes(), { limit: 99 }).map((n) => n.code)).toContain(
      "ruin_uniform",
    );
  });
});
