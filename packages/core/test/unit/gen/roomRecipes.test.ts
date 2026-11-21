/**
 * Generator 4 room recipes. The owner admired a community interior and called our dungeon
 * "a plain hall and identical cells": rooms are now dressed from their purpose (anchor, wall run, things on things,
 * lights), rooms of one purpose differ, abandoned rooms stay sparse and dark, and the review notices bare, alike,
 * unlit and adrift rooms. Generators 1-3 are untouched (the golden tests pin them).
 */
import { describe, expect, it } from "vitest";
import { compileResolved } from "../../../src/compile";
import type { Area, MapPlan, Opening, RoomPurpose } from "../../../src/contracts/plan";
import { EDGE, type ResolvedLevel } from "../../../src/contracts/resolved";
import { LIGHT_FEATURES, featureInfo } from "../../../src/gen/catalog";
import { classifyRoom } from "../../../src/gen/roomPurpose";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { STRUCTURE_ONLY, validatePlan } from "../../../src/plan";
import { resolvePlan } from "../../../src/resolve";
import { reviewDesign } from "../../../src/review";
import { interiorNotes, roomStats } from "../../../src/review/interiors";
import { slabCodec } from "../../../src/slab";
import { loadPlan } from "../../fixtures";

const palettes = loadPalettes();

/** Rooms off one passage: a name (and optional extra fields) per room, north row then south row. */
function building(
  names: ReadonlyArray<string | { name: string; notes?: string; tags?: string[]; purpose?: RoomPurpose }>,
  opts: { generator?: 3 | 4; theme?: string; roomDress?: false } = {},
): MapPlan {
  const areas: Area[] = [
    {
      id: "passage",
      kind: "corridor",
      name: "Passage",
      shape: { type: "rect", x: 1, y: 8, w: 7 * Math.ceil(names.length / 2) - 1, h: 3 },
      floor: "wood_plank",
    },
  ];
  const openings: Opening[] = [];
  names.forEach((n, i) => {
    const spec = typeof n === "string" ? { name: n } : n;
    const north = i % 2 === 0;
    const col = Math.floor(i / 2);
    const id = `r${i}`;
    areas.push({
      id,
      kind: "room",
      ...spec,
      shape: { type: "rect", x: 1 + col * 7, y: north ? 2 : 11, w: 6, h: 6 },
      floor: "wood_plank",
    });
    openings.push({ id: `d${i}`, kind: "door", between: [id, "passage"], position: 0.5 });
  });
  const w = 7 * Math.ceil(names.length / 2) + 2;
  return {
    schema: "slabyrinth/plan@1",
    generator: opts.generator ?? 4,
    id: "5a1f0c9e-3b7d-4a6e-9c21-7e8d1b2c3f40",
    title: "Inn test",
    kind: "building",
    seed: 4242,
    theme: opts.theme ?? "wood_town",
    summary: "A row of rooms off a passage.",
    entryLevel: "l1",
    levels: [
      {
        id: "l1",
        name: "Ground",
        elevation: 0,
        bounds: { x: 0, y: 0, w, h: 19 },
        base: { type: "solid" },
        ...(opts.roomDress === false ? { roomDress: false as const } : {}),
        areas,
        openings,
        walls: [],
        features: [],
        terrain: [],
        labels: [],
        structures: [],
      },
    ],
    links: [],
  } as unknown as MapPlan;
}

const NAMES = [
  "Tavern common room",
  "Kitchen",
  "Library",
  "Armoury",
  "Guard room",
  "Guest bedroom",
  "Guest bedroom",
  "Store room",
  "Shrine",
  "Study",
  "Washroom",
  "Cells",
];

function level(plan: MapPlan): ResolvedLevel {
  return resolvePlan(plan, bundledPalettes()).levels[0] as ResolvedLevel;
}

/** Features other than the loose wall-foot rubble of the wall pass (not part of the room recipes). */
const own = (L: ResolvedLevel): ResolvedLevel["features"] =>
  L.features.filter((f) => f.generatedBy !== "walls");

const roomFeatures = (L: ResolvedLevel, id: string): ResolvedLevel["features"] =>
  own(L).filter((f) => f.area === id);

describe("room purpose from words (gen/roomPurpose.ts classifyRoom, the one classifier)", () => {
  const purpose = (w: Parameters<typeof classifyRoom>[0]) => classifyRoom(w).purpose;
  const abandoned = (w: Parameters<typeof classifyRoom>[0]) => classifyRoom(w).abandoned;

  it("reads the purpose from the name, then the tags, then the notes", () => {
    expect(purpose({ name: "Guard room" })).toBe("barracks");
    expect(purpose({ name: "Tavern common room" })).toBe("tavern");
    expect(purpose({ name: "Cell A" })).toBe("prison");
    expect(purpose({ name: "Hidden shrine" })).toBe("shrine");
    expect(purpose({ name: "Store room" })).toBe("storeroom");
    expect(purpose({ name: "Guest bedroom" })).toBe("bedroom");
    expect(purpose({ name: "Room 4", tags: ["library"] })).toBe("library");
    expect(
      purpose({
        name: "Room 4",
        notes: "Off-duty guards, a dice game; the keys to the cell block hang by the door.",
      }),
    ).toBe("barracks");
    expect(purpose({ name: "Chamber" })).toBeUndefined(); // never invent a purpose
  });

  it("the head noun of a name wins: the last purpose word before a linking word", () => {
    expect(purpose({ name: "Shrine antechamber" })).toBe("passage");
    expect(purpose({ name: "Stair landing" })).toBe("passage");
    expect(purpose({ name: "Kitchen cellar" })).toBe("storeroom");
    expect(purpose({ name: "Shrine of the Hearth" })).toBe("shrine");
    expect(purpose({ name: "Guard room by the cells" })).toBe("barracks");
    expect(purpose({ name: "Iron bars" })).toBeUndefined(); // "bars" is not a tavern
  });

  it("the notes give a use, never a passage or a ruin (they mention neighbours and debris)", () => {
    expect(purpose({ name: "Room 7", notes: "The keys hang by the stair door." })).toBeUndefined();
    expect(purpose({ name: "Room 7", notes: "Rubble by the north wall; the kitchen is next door." })).toBe(
      "kitchen",
    );
  });

  it("abandoned: a place nobody keeps, a word of neglect, or a passage of such a place", () => {
    expect(abandoned({ name: "Crypt" })).toBe(true);
    expect(abandoned({ name: "Cell B" })).toBe(true);
    expect(abandoned({ name: "Derelict store room" })).toBe(true);
    expect(purpose({ name: "Derelict store room" })).toBe("storeroom");
    expect(classifyRoom({ name: "Looted chapel" })).toEqual({ purpose: "shrine", abandoned: true });
    expect(classifyRoom({ name: "Ruined chapel" })).toEqual({ purpose: "ruin", abandoned: true });
    expect(classifyRoom({ name: "Abandoned chamber" })).toEqual({ purpose: "ruin", abandoned: true });
    expect(classifyRoom({ name: "Hall", tags: ["ruined"] })).toEqual({ purpose: "ruin", abandoned: true });
    expect(classifyRoom({ name: "Collapsed tunnel passage" })).toEqual({
      purpose: "passage",
      abandoned: true,
    });
    expect(classifyRoom({ name: "Crypt passage" })).toEqual({ purpose: "passage", abandoned: true });
    expect(classifyRoom({ name: "Cell block corridor" })).toEqual({ purpose: "passage", abandoned: true });
    expect(classifyRoom({ name: "Hall passage" })).toEqual({ purpose: "passage", abandoned: false });
    expect(abandoned({ name: "Tavern" })).toBe(false);
  });

  it("every stage reads the resolver's one classification from the resolved area", () => {
    const names = ["Kitchen", { name: "Hall", tags: ["ruined"] }];
    const L = level(building(names));
    expect(L.areas.find((a) => a.id === "r0")).toMatchObject({ purpose: "kitchen", finish: "tidy" });
    expect(L.areas.find((a) => a.id === "r0")?.abandoned).toBeUndefined();
    // a tag-only "ruined" makes a timber room abandoned for the resolver, the compiler and the review alike (the review
    // used to read the name and notes only, the wall tops the name and notes of the resolved area); it is still built
    // of timber (its finish is the theme's), only dressed rough
    expect(L.areas.find((a) => a.id === "r1")).toMatchObject({
      purpose: "ruin",
      abandoned: true,
      finish: "tidy",
    });
    expect(roomStats(L).find((s) => s.id === "r1")?.abandoned).toBe(true);
    // generator 3 resolves no classification
    const g3 = level(building(names, { generator: 3 }));
    for (const a of g3.areas)
      expect([a.purpose, a.abandoned, a.finish]).toEqual([undefined, undefined, undefined]);
    // ... and its review classifies from the plan with the same classifier: the ruined hall is not judged unlit
    const p3 = building(names, { generator: 3 });
    const unlit3 = interiorNotes(p3, resolvePlan(p3, bundledPalettes())).find((n) => n.code === "room_unlit");
    expect(unlit3?.elementIds).toEqual(["r0"]);
  });

  it("the review only promises what the plan's generator does (naming a room dresses and lights it at 4 only)", () => {
    const p3 = building(["Kitchen", "Library"], { generator: 3 });
    const unlit3 = interiorNotes(p3, resolvePlan(p3, bundledPalettes())).find((n) => n.code === "room_unlit");
    expect(unlit3?.action).toBeDefined();
    expect(unlit3?.action).not.toMatch(/naming a room/);
    const p4 = building(["Kitchen", "Library"], { roomDress: false });
    const unlit4 = interiorNotes(p4, resolvePlan(p4, bundledPalettes())).find((n) => n.code === "room_unlit");
    expect(unlit4?.action).toMatch(/naming a room for its purpose lights it/);
  });
});

describe("an explicit purpose (Area.purpose) wins over the words", () => {
  it("the plan's purpose beats the name, tags and notes; without it the words decide as before", () => {
    expect(classifyRoom({ name: "Shrine antechamber" }).purpose).toBe("passage");
    expect(classifyRoom({ name: "Shrine antechamber", purpose: "shrine" }).purpose).toBe("shrine");
    expect(classifyRoom({ name: "Sala de guardia", purpose: "barracks" }).purpose).toBe("barracks");
    expect(classifyRoom({ name: "Kitchen", tags: ["library"], purpose: "forge" }).purpose).toBe("forge");
  });

  it("a word of wreckage still marks it abandoned but never replaces the stated purpose", () => {
    expect(classifyRoom({ name: "Ruined chapel" })).toEqual({ purpose: "ruin", abandoned: true });
    expect(classifyRoom({ name: "Ruined chapel", purpose: "shrine" })).toEqual({
      purpose: "shrine",
      abandoned: true,
    });
    // the stated purpose decides abandonment by purpose: a crypt kept as a shrine is kept up
    expect(classifyRoom({ name: "Crypt", purpose: "shrine" })).toEqual({
      purpose: "shrine",
      abandoned: false,
    });
  });

  it("the notes are read in whole words: a word cut by the 160-character limit names nothing", () => {
    const filler = "x".repeat(156);
    // "barracks" cut to "bar" would have read as a tavern
    expect(classifyRoom({ name: "Room 9", notes: `${filler} barracks` }).purpose).toBeUndefined();
    expect(classifyRoom({ name: "Room 9", notes: `${filler.slice(5)} barracks` }).purpose).toBe("barracks");
  });

  it("the resolver writes the stated purpose and dresses the room for it", () => {
    const L = level(building([{ name: "Shrine antechamber", purpose: "shrine" }, "Shrine antechamber"]));
    expect(L.areas.find((a) => a.id === "r0")?.purpose).toBe("shrine");
    expect(L.areas.find((a) => a.id === "r1")?.purpose).toBe("passage");
    expect(roomFeatures(L, "r0").some((f) => f.type === "altar")).toBe(true);
    expect(roomFeatures(L, "r1").some((f) => f.type === "altar")).toBe(false);
  });

  it("is rejected below generator 4, so plans for released generators validate as before", () => {
    const names = [{ name: "Shrine antechamber", purpose: "shrine" as const }];
    const v3 = validatePlan(building(names, { generator: 3 }), STRUCTURE_ONLY);
    expect(v3.ok).toBe(false);
    expect(v3.issues.filter((i) => i.severity === "error")).toMatchObject([
      { code: "schema", path: "/levels/0/areas/1/purpose", elementId: "r0" },
    ]);
    expect(v3.issues[0]?.message).toMatch(/purpose needs generator 4; this plan is generator 3/);
    expect(validatePlan(building(["Shrine antechamber"], { generator: 3 }), STRUCTURE_ONLY).ok).toBe(true);
    expect(validatePlan(building(names), STRUCTURE_ONLY).ok).toBe(true);
  });

  it("the stored purpose line-up resolves every room to its stated purpose (the golden builds it)", () => {
    const plan = loadPlan("purpose-lineup-v1");
    expect(validatePlan(plan, STRUCTURE_ONLY).ok).toBe(true);
    const L = level(plan);
    const by = (id: string) => L.areas.find((a) => a.id === id);
    expect(
      Object.fromEntries(
        ["antechamber", "oaths", "armas", "mess", "kitchen", "cellar"].map((id) => [id, by(id)?.purpose]),
      ),
    ).toEqual({
      antechamber: "shrine",
      oaths: "throne_room",
      armas: "armoury",
      mess: "barracks",
      kitchen: "kitchen",
      cellar: "storeroom",
    });
    // "Ruined cellar": the stated purpose stands, the word of wreckage still marks it abandoned
    expect(by("cellar")?.abandoned).toBe(true);
  });

  it("an unknown purpose is rejected with the valid values and the nearest one", () => {
    const plan = building([{ name: "Cookhouse", purpose: "kitchens" as RoomPurpose }]);
    const bad = validatePlan(plan, STRUCTURE_ONLY).issues.filter((i) => i.severity === "error");
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ code: "schema", path: "/levels/0/areas/1/purpose" });
    expect(bad[0]?.message).toMatch(/"kitchens" is not a valid value/);
    expect(bad[0]?.hint).toMatch(/did you mean "kitchen"\? valid: .*throne_room/);
  });
});

describe("generator 4 dresses rooms by default", () => {
  it("generator 3 plans are untouched: nothing is generated for named rooms", () => {
    const L = level(building(NAMES, { generator: 3 }));
    expect(own(L)).toEqual([]);
  });

  it("roomDress false turns it off", () => {
    expect(own(level(building(NAMES, { roomDress: false })))).toEqual([]);
  });

  it("every named inhabited room has furniture, small things on it, a light and walls to stand against", () => {
    const L = level(building(NAMES));
    const stats = roomStats(L);
    for (const r of stats.filter((s) => !s.abandoned)) {
      expect(r.lights, `${r.name} lit`).toBeGreaterThanOrEqual(1);
      expect((r.props * 10) / r.floor, `${r.name} props per 10 tiles`).toBeGreaterThanOrEqual(4);
      if (r.blockers >= 4)
        expect(r.nearWall / r.blockers, `${r.name} near walls`).toBeGreaterThanOrEqual(0.8);
    }
    // things rest on things: a third of the props of a dressed room stand on another piece
    const onProps = L.features.filter((f) => f.type === "clutter" || f.type === "candles").length;
    expect(onProps).toBeGreaterThan(30);
    expect(L.features.some((f) => f.type === "shelf_line")).toBe(true);
  });

  it("every light and every small thing has a lift that rests on a support in its own room", () => {
    const L = level(building(NAMES));
    for (const f of L.features.filter((q) => q.type === "clutter" && q.variant !== "shelf")) {
      const floorTop =
        0.5 + (L.cells.height[(f.at[1] - L.bounds.y) * L.bounds.w + (f.at[0] - L.bounds.x)] as number) / 4;
      expect(f.baseHeight - floorTop, f.id).toBeGreaterThan(0.1);
    }
  });

  it("the way stays clear: every door cell reaches every free cell of its room", () => {
    const L = level(building(NAMES));
    const W = L.bounds.w;
    const idx = (x: number, y: number): number => (y - L.bounds.y) * W + (x - L.bounds.x);
    for (const area of L.areas.filter((a) => a.kind === "room")) {
      const ai = L.areas.indexOf(area) + 1;
      const blocked = new Set<number>();
      for (const f of L.features.filter((q) => q.blocking))
        for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
          for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) blocked.add(idx(x, y));
      const cells: Array<[number, number]> = [];
      for (let y = L.bounds.y; y < L.bounds.y + L.bounds.h; y++)
        for (let x = L.bounds.x; x < L.bounds.x + W; x++)
          if (L.cells.area[idx(x, y)] === ai) cells.push([x, y]);
      const free = cells.filter(([x, y]) => !blocked.has(idx(x, y)));
      // start at a cell beside the door (an OPENING edge)
      const doorCell = free.find(([x, y]) =>
        (["N", "S"] as const).some((s) => {
          const lx = x - L.bounds.x;
          const ly = y - L.bounds.y + (s === "S" ? 1 : 0);
          return L.hEdges.kind[ly * W + lx] === EDGE.OPENING;
        }),
      );
      expect(doorCell, `${area.id} has a free cell at its door`).toBeDefined();
      const seen = new Set<number>([
        idx((doorCell as [number, number])[0], (doorCell as [number, number])[1]),
      ]);
      const queue = [doorCell as [number, number]];
      const freeSet = new Set(free.map(([x, y]) => idx(x, y)));
      for (let h = 0; h < queue.length; h++) {
        const [x, y] = queue[h] as [number, number];
        for (const [dx, dy] of [
          [0, -1],
          [1, 0],
          [0, 1],
          [-1, 0],
        ] as const) {
          const k = idx(x + dx, y + dy);
          if (!freeSet.has(k) || seen.has(k)) continue;
          seen.add(k);
          queue.push([x + dx, y + dy]);
        }
      }
      expect(seen.size, `${area.id} free cells reachable`).toBe(freeSet.size);
    }
  });

  it("rooms of one purpose differ: the two guest bedrooms are not copies", () => {
    const L = level(building(NAMES));
    const sig = (id: string): string =>
      roomFeatures(L, id)
        .filter((f) => f.type !== "torch_wall")
        .map((f) => `${f.type}@${f.at.join(",")}`)
        .sort()
        .join(" ");
    const stats = roomStats(L);
    const a = stats.find((s) => s.id === "r5");
    const b = stats.find((s) => s.id === "r6");
    expect(a?.signature).not.toBe(b?.signature);
    // not even the same layout shifted: positions relative to the room differ
    const rel = (id: string, dx: number): string =>
      sig(id)
        .split(" ")
        .map((t) => t.replace(/@(\d+),(\d+)/, (_m, x, y) => `@${Number(x) - dx},${y}`))
        .join(" ");
    expect(rel("r5", 7 * 2 + 1)).not.toBe(rel("r6", 7 * 3 + 1));
    expect(new Set(stats.filter((s) => !s.abandoned).map((s) => s.signature)).size).toBe(
      stats.filter((s) => !s.abandoned).length,
    );
  });

  it("abandoned rooms stay sparse and dark: a crypt and cells keep one light at most per 50 tiles", () => {
    const L = level(building(["Crypt", "Cell A", "Cell B", "Cell C", "Ruined chapel", "Kitchen"]));
    for (const r of roomStats(L).filter((s) => s.abandoned)) {
      expect(r.lights, r.name).toBeLessThanOrEqual(Math.max(1, Math.floor(r.floor / 50)));
      expect((r.props * 10) / r.floor, `${r.name} sparse`).toBeLessThan(6);
    }
    // the ruin gets no furniture and no torch
    expect(roomFeatures(L, "r4")).toEqual([]);
    // the kitchen beside them is lit and dressed
    expect(roomStats(L).find((s) => s.id === "r5")?.props).toBeGreaterThan(15);
  });

  it("a room the plan furnished itself, or a dress op covers, is not redressed", () => {
    const plan = building(["Kitchen", "Library"]);
    const l1 = plan.levels[0] as unknown as { terrain: unknown[]; features: unknown[] };
    l1.terrain.push({ id: "d1", op: "dress", area: "r0", preset: "kitchen", density: 0.5 });
    const L = level(plan);
    // the dress op's own pieces are named d1#n; the default pass adds nothing to r0
    expect(roomFeatures(L, "r0").every((f) => f.generatedBy === "d1")).toBe(true);
    expect(roomFeatures(L, "r0").length).toBeGreaterThan(15); // the op uses the recipe (clutter on counters, lights)
    expect(roomFeatures(L, "r1").some((f) => f.generatedBy === "r1~room")).toBe(true);
  });

  it("a theme without the pieces keeps working: the city palette dresses and lights too", () => {
    const L = level(building(["Kitchen", "Study", "Store room", "Armoury"], { theme: "city" }));
    expect(L.features.length).toBeGreaterThan(30);
    for (const r of roomStats(L)) expect(r.lights, r.name).toBeGreaterThanOrEqual(1);
  });

  it("the build is clean: no floating, sunk or walled-in prop", () => {
    for (const theme of ["wood_town", "stone_dungeon", "city"]) {
      const plan = building(NAMES, { theme });
      const bundle = compileResolved(resolvePlan(plan, bundledPalettes()), palettes, slabCodec, { plan });
      expect(
        bundle.diagnostics.filter((d) => d.severity !== "info"),
        theme,
      ).toEqual([]);
    }
  });

  it("deterministic: the same plan gives the same rooms", () => {
    const a = JSON.stringify(level(building(NAMES)).features);
    const b = JSON.stringify(level(building(NAMES)).features);
    expect(a).toBe(b);
  });

  it("lights sit on walls that are tall, on furniture, or in a brazier; every furniture piece is a real feature type", () => {
    const L = level(building(NAMES));
    for (const f of L.features) {
      expect(featureInfo(f.type)).toBeDefined();
      if (LIGHT_FEATURES.has(f.type) && f.type === "torch_wall") expect(f.wall).toBeDefined();
    }
  });
});

describe("interior review notes", () => {
  const codes = (plan: MapPlan): string[] =>
    reviewDesign(plan, resolvePlan(plan, bundledPalettes()), bundledPalettes(), { limit: 99 }).map(
      (n) => n.code,
    );

  it("silent on a dressed building", () => {
    const c = codes(building(NAMES));
    for (const code of ["room_bare", "rooms_alike", "room_unlit", "furniture_adrift"])
      expect(c).not.toContain(code);
  });

  it("room_bare, rooms_alike and room_unlit fire on the same building with the default dressing off", () => {
    // one room dressed by hand shows the author can; the rest are bare, alike and unlit
    const plan = building(["Kitchen", "Cell", "Cell", "Cell", "Study", "Study"], { roomDress: false });
    const l1 = plan.levels[0] as unknown as { terrain: unknown[] };
    l1.terrain.push({ id: "d1", op: "dress", area: "r0", preset: "kitchen", density: 0.6 });
    const notes = reviewDesign(plan, resolvePlan(plan, bundledPalettes()), bundledPalettes(), { limit: 99 });
    const c = notes.map((n) => n.code);
    expect(c).toContain("room_bare");
    expect(c).toContain("room_unlit");
    expect(c).toContain("rooms_alike");
    const bare = notes.find((n) => n.code === "room_bare");
    expect(bare?.elementIds).toContain("r4");
    expect(bare?.elementIds).not.toContain("r1"); // cells are meant to be sparse
    expect(notes.find((n) => n.code === "room_unlit")?.elementIds).not.toContain("r1");
  });

  it("furniture_adrift: a room whose furniture stands in the middle", () => {
    const plan = building(["Hall of statues", "Kitchen"], { roomDress: false });
    const l1 = plan.levels[0] as unknown as { features: unknown[] };
    for (const [i, at] of [
      [0, [3, 4]],
      [1, [4, 4]],
      [2, [3, 5]],
      [3, [4, 5]],
    ] as const)
      l1.features.push({ id: `p${i}`, type: "barrel", at: [at[0], at[1]] });
    const notes = interiorNotes(plan, resolvePlan(plan, bundledPalettes()));
    expect(notes.map((n) => n.code)).toContain("furniture_adrift");
  });
});
