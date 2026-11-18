import { describe, expect, it } from "vitest";
import type { AssetAvailability, Placement, PlacementSet } from "../../../src/contracts/compiler";
import { realize } from "../../../src/compile";
import { loadPalettes } from "../../../src/palette";
import { handLevel, handPlan } from "./handResolved";

const cat = loadPalettes();
const nameOf = new Map<string, string>();
for (const p of Object.values(cat.palettes))
  for (const r of Object.values(p.roles)) for (const v of r.variants) nameOf.set(v.asset, v.name ?? "");
const named = (set: PlacementSet, role?: string): Array<[string, number, number, number, number]> =>
  set.levels
    .flatMap((l) => l.placements)
    .filter((p) => !role || p.role === role)
    .map((p) => [nameOf.get(p.asset) ?? p.asset, p.x, p.y, p.z, p.rot]);

/**
 * 3×2 room, rock around it. Plan rows 0..3 → world z = 3 − row (Hg = 4).
 *   row 0  #####
 *   row 1  #...#     room cells x 1..3, y 1..2 → world x 1..4, z 1..3
 *   row 2  #...#
 *   row 3  #####
 */
const room = (extra: Parameters<typeof handLevel>[0] extends infer T ? Partial<T> : never = {}) =>
  handLevel({ id: "l1", rows: ["#####", "#...#", "#...#", "#####"], ...extra });

describe("realize: walls, posts, floors (calibrated conventions)", () => {
  const set = realize(handPlan([room()]), cat, { seed: 1 });

  it("places floors at the min corner of the covered cells, top at +0.5", () => {
    const floors = set.levels[0]?.placements.filter((p) => p.role === "floor") ?? [];
    // greedy: one 2×2 + two 1×1 for a 3×2 room
    expect(floors).toHaveLength(3);
    const two = floors.find(
      (p) => nameOf.get(p.asset) === "Dungeon Floor 02" || nameOf.get(p.asset) === "Dungeon Floor - Cracked",
    );
    expect(two).toMatchObject({ x: 1, y: 0, z: 1 });
    for (const f of floors) expect(f.y).toBe(0);
  });

  it("puts walls in the host half: south edge at z, north edge at z+0.5, west at x, east at x+0.5", () => {
    const walls = named(set, "wall");
    // north wall: host = rock row 0 (world z 3); edge on its south side → stored z = 3, rot 0 (runs E-W)
    expect(walls.filter(([, , , z]) => z === 3).map(([n, x, y, , r]) => [n, x, y, r])).toEqual([
      ["Dungeon Wall 02", 1, 0.5, 0],
      ["Dungeon Wall 01", 3, 0.5, 0],
    ]);
    // south wall: host = rock row 3 (world z 0); edge on its north side → z = 0 + 0.5
    expect(
      walls
        .filter(([, , , z]) => z === 0.5)
        .map(([, x]) => x)
        .sort(),
    ).toEqual([1, 3]);
    // west wall: host = rock col 0; edge on its east side → x = 0 + 0.5, rot 90 (6 steps), anchored at the south cell
    expect(walls.filter(([, x]) => x === 0.5)).toEqual([["Dungeon Wall 02", 0.5, 0.5, 1, 90]]);
    // east wall: host = rock col 4; edge on its west side → x = 4
    expect(walls.filter(([, x]) => x === 4)).toEqual([["Dungeon Wall 02", 4, 0.5, 1, 90]]);
  });

  it("fills the four outer corners with 0.5×0.5 posts", () => {
    expect(
      named(set, "wall_post")
        .map(([, x, , z]) => [x, z])
        .sort(),
    ).toEqual([
      [0.5, 0.5],
      [0.5, 3],
      [4, 0.5],
      [4, 3],
    ]);
  });

  it("is deterministic", () => {
    expect(realize(handPlan([room()]), cat, { seed: 1 })).toEqual(set);
  });
});

describe("realize: doors pick the rotation that puts the handle at the preferred end", () => {
  it("north-edge door: rot 0 (handle west); east-edge door: rot 90 (handle north)", () => {
    const set = realize(
      handPlan([
        room({
          doors: [
            { x: 2, y: 1, side: "N" },
            { x: 3, y: 2, side: "E" },
          ],
        }),
      ]),
      cat,
    );
    const doors = named(set, "opening").filter(([n]) => n.startsWith("Door"));
    expect(doors).toEqual([
      ["Door - Dungeon", 2, 0.5, 3, 0],
      ["Door - Dungeon", 4, 0.5, 1, 90],
    ]);
    // no lintel ships (the crenellation was rejected in game; the kit has no lintel piece)
    expect(named(set, "opening").filter(([n]) => !n.startsWith("Door"))).toEqual([]);
    // the wall run on the north side is split around the door
    expect(
      named(set, "wall")
        .filter(([, , , z]) => z === 3)
        .map(([, x]) => x)
        .sort(),
    ).toEqual([1, 3]);
  });

  it("double door replaces two wall edges; an archway with no fitting piece is a plain opening (info)", () => {
    const set = realize(
      handPlan([
        room({
          doors: [
            { x: 1, y: 1, side: "N", kind: "double_door", width: 2 },
            { x: 1, y: 2, side: "S", kind: "archway" },
          ],
        }),
      ]),
      cat,
    );
    expect(named(set, "opening").filter(([n]) => n.startsWith("Door"))).toEqual([
      ["Doors - Dungeon Double", 1, 0.5, 3, 0],
    ]);
    expect(named(set, "opening").filter(([n]) => !n.startsWith("Door"))).toHaveLength(0); // no lintel role shipped
    expect(
      set.diagnostics.find((d) => d.code === "role_missing" && d.role === "opening.archway")?.severity,
    ).toBe("info");
  });

  it("Fix 3: west/south-edge doors get the documented handle end (rot 6 → N end, rot 0 → W end)", () => {
    const set = realize(
      handPlan([
        room({
          doors: [
            { x: 1, y: 1, side: "W" },
            { x: 2, y: 2, side: "S" },
          ],
        }),
      ]),
      cat,
    );
    // handle at rot r = W turned clockwise by r/6 quarters: rot 90 (6) → N, rot 0 → W
    expect(named(set, "opening").filter(([n]) => n === "Door - Dungeon")).toEqual([
      ["Door - Dungeon", 0.5, 0.5, 2, 90],
      ["Door - Dungeon", 2, 0.5, 0.5, 0],
    ]);
  });

  it("a palette that defines lintel.<style> gets one lintel per door edge on top of the leaf (data-driven)", () => {
    const wall1 = cat.palettes["stone_dungeon"]?.roles["wall.wall"]?.variants[0];
    if (!wall1) throw new Error("fixture");
    const withLintel = loadPalettes({
      user: [
        {
          source: "stone_dungeon.json",
          data: {
            schema: "slabyrinth/palette@1",
            id: "stone_dungeon",
            overrides: true,
            roles: { "lintel.wall": { mount: "half-cell", variants: [{ ...wall1, name: "test lintel" }] } },
          },
        },
      ],
    });
    const set = realize(handPlan([room({ doors: [{ x: 2, y: 1, side: "N" }] })]), withLintel);
    expect(named(set, "opening").filter(([n]) => n === "Dungeon Wall 01")).toEqual([
      ["Dungeon Wall 01", 2, 2.5, 3, 0],
    ]);
  });

  it("wooden kits get no lintel", () => {
    const set = realize(
      handPlan([room({ theme: "wood_town", material: "wood_plank", doors: [{ x: 2, y: 1, side: "N" }] })]),
      cat,
    );
    expect(named(set, "opening").map(([n]) => n)).toEqual(["Door -Peasant"]);
  });

  it("walls taller than a door are filled above it on every edge, also when the opening's edges have mixed hosts", () => {
    // row 0: (1,0) rock, (2,0) open → the opening's two edges are hosted on different sides; wall height 3
    const lv = handLevel({
      id: "l1",
      rows: ["##.##", "#...#", "#...#", "#####"],
      wallHeight: 3,
      doors: [{ x: 1, y: 1, side: "N", width: 2 }],
    });
    lv.hEdges.height[1 * 5 + 2] = 3; // north edge of (2,1): the open/open edge carries the wall height too
    const set = realize(handPlan([lv]), cat);
    const doors = set.levels[0]?.placements.filter((p) => p.role === "opening") ?? [];
    expect(doors).toHaveLength(2);
    const leafTop = 0.5 + 2; // floor top + door height
    const above = (set.levels[0]?.placements ?? []).filter(
      (p) => p.role === "wall" && p.source.elementId === "door0" && Math.abs(p.y - leafTop) < 1e-6,
    );
    expect(above.map((p) => p.x).sort()).toEqual([1, 2]);
  });

  it("secret doors fall back to a plain wall piece (alias role)", () => {
    const set = realize(handPlan([room({ doors: [{ x: 2, y: 1, side: "N", kind: "secret_door" }] })]), cat);
    expect(named(set, "opening")).toEqual([]);
    expect(named(set, "wall").filter(([, x, , z]) => x === 2 && z === 3)).toEqual([
      ["Dungeon Wall 01", 2, 0.5, 3, 0],
    ]);
  });
});

describe("realize: features", () => {
  it("props are centred on their footprint; rot turns the default N (+z) front to the feature facing", () => {
    const set = realize(
      handPlan([
        room({
          features: [
            { id: "c", type: "chest", at: [1, 1], rot: 0 },
            { id: "c90", type: "chest", at: [2, 1], rot: 90 },
            { id: "t", type: "table", at: [1, 2], size: [2, 1] },
          ],
        }),
      ]),
      cat,
    );
    const f = set.levels[0]?.placements.filter((p) => p.role === "feature") ?? [];
    const by = (id: string): Placement | undefined => f.find((p) => p.source.elementId === id);
    expect(by("c")).toMatchObject({ x: 1.5, y: 0.5, z: 2.5, rot: 180 }); // plan rot 0 = front S; asset front N → 180°
    expect(by("c90")?.rot).toBe(270); // plan rot 90 = front W; N → W is three clockwise quarter turns
    expect(by("t")?.x).toBeCloseTo(
      2 - (cat.palettes["generic"]?.roles["feature.table"]?.variants[0]?.geom.boundsCenter.x ?? 0),
      6,
    );
    expect(by("t")?.z).toBeCloseTo(1.5, 1);
  });

  it("wall-mounted props sit on the wall plane, turned so their mounting side faces the wall", () => {
    const set = realize(
      handPlan([room({ features: [{ id: "torch", type: "torch_wall", at: [2, 1], wall: "N" }] })]),
      cat,
    );
    const t = set.levels[0]?.placements.find((p) => p.role === "feature");
    expect(t).toMatchObject({ x: 2.5, z: 3, rot: 180, y: 0.5 + 1.25 });
  });

  it("chairs face the table: chair front N at rot 0 (verified in game), so a chair north of the table (plan rot 0) is 180°", () => {
    const set = realize(
      handPlan([
        room({
          features: [
            { id: "n", type: "chair", at: [2, 1], rot: 0 }, // north of the table, front S → toward it
            { id: "s", type: "chair", at: [3, 2], rot: 180 }, // south-side seat, front N
          ],
        }),
      ]),
      cat,
    );
    const f = set.levels[0]?.placements.filter((p) => p.role === "feature") ?? [];
    expect(f.find((p) => p.source.elementId === "n")?.rot).toBe(180);
    expect(f.find((p) => p.source.elementId === "s")?.rot).toBe(0);
  });

  it("verified fronts: Bookshelf 01 and Red Bed face N at rot 0, so plan rot 0 (front S) turns them 180°", () => {
    const set = realize(
      handPlan([
        room({
          features: [
            { id: "s", type: "bookshelf", at: [1, 1], size: [2, 1] },
            { id: "b", type: "bed", at: [3, 1], size: [1, 2] },
          ],
        }),
      ]),
      cat,
    );
    const f = set.levels[0]?.placements.filter((p) => p.role === "feature") ?? [];
    expect(f.map((p) => [p.source.elementId, p.rot])).toEqual([
      ["s", 180],
      ["b", 180],
    ]);
  });

  it("wall furniture whose front would face a wall is turned to face into the room", () => {
    // bookshelf against the SOUTH wall asked to face south (rot 0) → faces north instead (into the room)
    const set = realize(
      handPlan([
        room({
          features: [
            { id: "s", type: "bookshelf", at: [1, 2], size: [2, 1], rot: 0 },
            { id: "c", type: "chest", at: [3, 2], rot: 0 },
          ],
        }),
      ]),
      cat,
    );
    const f = set.levels[0]?.placements.filter((p) => p.role === "feature") ?? [];
    expect(f.find((p) => p.source.elementId === "s")?.rot).toBe(0); // front N at rot 0 already faces north
    // chests are not wall furniture: plan rot 0 (front S) is kept even into the wall → asset front N turned 180°
    expect(f.find((p) => p.source.elementId === "c")?.rot).toBe(180);
  });

  it("centred wall props (banners) hang with their back on the wall plane", () => {
    const set = realize(
      handPlan([room({ features: [{ id: "bn", type: "banner_wall", at: [2, 1], wall: "N" }] })]),
      cat,
    );
    const b = set.levels[0]?.placements.find((p) => p.role === "feature");
    const depth = cat.palettes["generic"]?.roles["feature.banner_wall"]?.variants[0]?.geom.size.z ?? 0;
    expect(b?.z).toBeCloseTo(3 - depth / 2, 6); // north wall plane at z = 3, pushed half its depth into the room
    expect(b?.y).toBeCloseTo(0.5 + 0.6, 6);
  });

  it("unknown variants fall back with info; custom features without a catalog warn", () => {
    const set = realize(
      handPlan([
        room({
          features: [
            { id: "s", type: "statue", at: [1, 1], variant: "broken" },
            { id: "x", type: "custom", at: [2, 1], hint: "telescope" },
          ],
        }),
      ]),
      cat,
    );
    expect(set.diagnostics.find((d) => d.code === "variant_unknown")?.severity).toBe("info");
    expect(set.diagnostics.find((d) => d.code === "custom_unresolved")?.severity).toBe("warning");
  });
});

describe("realize: heights, caves, links", () => {
  it("stacks fill courses under a raised cell, tops aligned", () => {
    const set = realize(handPlan([handLevel({ id: "l1", rows: ["#####", "#.4.#", "#####"] })]), cat); // middle cell +1.0
    const fill = named(set, "fill");
    expect(fill.map(([, x, y]) => [x, y]).sort()).toEqual([
      [2, 0],
      [2, 0.5],
    ]);
    expect(named(set, "floor").find(([, x]) => x === 2)?.[2]).toBe(1);
  });

  it("cave walls are full-cell blocks in the rock cells", () => {
    const set = realize(
      handPlan([
        handLevel({
          id: "c",
          rows: ["###", "#.#", "###"],
          theme: "cave",
          material: "rock",
          wallStyle: "cave_rock",
        }),
      ]),
      cat,
    );
    const blocks = named(set, "wall");
    expect(blocks.map(([n]) => n)).toEqual(["Cave Wall 01", "Cave Wall 01", "Cave Wall 01", "Cave Wall 01"]);
    expect(blocks.map(([, x, , z]) => [x, z]).sort()).toEqual([
      [0, 1],
      [1, 0],
      [1, 2],
      [2, 1],
    ]);
    expect(named(set, "wall_post")).toEqual([]);
  });

  it("stairs rise one per cell toward dir (Dungeon Stairs ascend W at rot 0); a half rise becomes a fill landing", () => {
    const lower = handLevel({ id: "lo", rows: ["#####", "#...#", "#...#", "#...#", "#####"] });
    const upper = handLevel({
      id: "up",
      elevation: 2.5,
      rows: ["     ", " .o. ", " .o. ", " .o. ", "     "],
    });
    const set = realize(
      handPlan(
        [lower, upper],
        [
          {
            id: "s",
            kind: "stairs",
            fromLevel: "lo",
            toLevel: "up",
            lowerCells: [
              [2, 3],
              [2, 2],
              [2, 1],
            ],
            upperCells: [
              [2, 3],
              [2, 2],
              [2, 1],
            ],
            arrival: [2, 0],
            dir: "N",
            rise: 2.5,
            theme: "stone_dungeon",
          },
        ],
      ),
      cat,
    );
    const lo = set.levels.find((l) => l.levelId === "lo")?.placements ?? [];
    const stairs = lo
      .filter((p) => nameOf.get(p.asset) === "Dungeon Stairs")
      .map((p) => [p.x, p.y, p.z, p.rot]);
    expect(stairs).toEqual(
      [
        [2, 1.5, 2, 90],
        [2, 0.5, 1, 90],
      ]
        .sort((a, b) => (a[2] ?? 0) - (b[2] ?? 0))
        .reverse(),
    );
    const landing = lo.filter((p) => p.role === "link" && p.source.cell?.[1] === 1);
    expect(landing.map((p) => p.y).sort()).toEqual([0.5, 1, 1.5, 2, 2.5]); // top at 3.0 = upper floor top
    // no floor on the stairwell cells of the upper level
    const up = set.levels.find((l) => l.levelId === "up")?.placements.filter((p) => p.role === "floor") ?? [];
    expect(up.every((p) => p.x !== 2)).toBe(true);
  });
});

describe("realize: availability, themes and diagnostics", () => {
  it("substitutes alternates when the user's game lacks an asset and reports it", () => {
    const wall1 = "63270c8a-9484-4ae8-926e-22e3de9048a1";
    const av: AssetAvailability = {
      status: (u) => (u === wall1 ? "missing" : "present"),
      name: () => "x",
      search: () => [],
    };
    const set = realize(handPlan([room({ doors: [{ x: 2, y: 1, side: "N" }] })]), {
      ...cat,
      availability: av,
    });
    expect(set.levels[0]?.placements.some((p) => p.asset === wall1)).toBe(false);
    expect(set.substitutions[0]?.wanted.uuid).toBe(wall1);
    expect(set.assetSource).toBe("install");
    expect(set.diagnostics.some((d) => d.code === "asset_substituted")).toBe(true);
  });

  it("unknown themes warn once and use generic; missing roles are aggregated with counts", () => {
    const set = realize(
      handPlan([
        room({
          theme: "castle",
          features: [
            { id: "a", type: "pool", at: [1, 1] },
            { id: "b", type: "pool", at: [2, 1] },
          ],
        }),
      ]),
      cat,
    );
    expect(set.diagnostics.filter((d) => d.code === "theme_fallback")).toHaveLength(1);
    expect(set.diagnostics.find((d) => d.code === "role_missing" && d.role === "feature.pool")?.count).toBe(
      2,
    );
    expect(set.assetSource).toBe("builtin");
    expect(set.stats.total).toBe(set.levels.reduce((s, l) => s + l.placements.length, 0));
  });
});
