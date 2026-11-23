/**
 * Generator 5 interiors, packages P, D and L, measured on resolved builds:
 *   placementOrder  a tidy room sets its loose things square, a rough one lets them lie askew; big furniture stays on
 *                   quarter turns everywhere (gen/rooms4/order.ts);
 *   floorGroups     groups of tables in the middle of a taproom, desks in rows before a schoolmaster, bunks along both
 *                   long walls, stock in rows with an aisle; lanes and doorways clear, seats and beds reachable
 *                   (gen/rooms4/floor.ts);
 *   lightRegimes    a light level per scene and room, one regime per room, at least three regimes across the interiors
 *                   fixture, floor lights only where they belong (gen/rooms4/regimes.ts, gen/lightLevels.ts).
 * Each behaviour test fails with its switch off (checked by turning the switch's branch off).
 */
import { describe, expect, it } from "vitest";
import type { Area, MapPlan, Opening } from "../../../src/contracts/plan";
import type { ResolvedFeature, ResolvedLevel } from "../../../src/contracts/resolved";
import { LIGHT_FEATURES, featureInfo } from "../../../src/gen/catalog";
import { sceneLight } from "../../../src/gen/lightLevels";
import { classifyRoom, furnishedPurpose } from "../../../src/gen/roomPurpose";
import { type LitNeighbour, type RoomLightPlan, drawLighting } from "../../../src/gen/rooms4";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { elementSeed, subSeed } from "../../../src/util/hash";
import { loadPlan } from "../../fixtures";
import { dungeonPlan } from "../../fixtures/planBuilder";

type RoomSpec = { name: string; w?: number; h?: number };

/** Rooms in a row north of a passage, each with a door onto it. */
function building(rooms: ReadonlyArray<RoomSpec>, opts: { theme?: string; title?: string } = {}): MapPlan {
  const widths = rooms.map((s) => s.w ?? 6);
  const total = widths.reduce((a, b) => a + b + 1, 1);
  const tallest = Math.max(...rooms.map((s) => s.h ?? 6));
  const py = tallest + 1;
  const areas: Area[] = [
    {
      id: "passage",
      kind: "corridor",
      name: "Passage",
      shape: { type: "rect", x: 1, y: py, w: total - 2, h: 2 },
    },
  ];
  const openings: Opening[] = [];
  let x = 1;
  rooms.forEach((s, i) => {
    const w = s.w ?? 6;
    const h = s.h ?? 6;
    areas.push({ id: `r${i}`, kind: "room", name: s.name, shape: { type: "rect", x, y: py - h, w, h } });
    openings.push({ id: `d${i}`, kind: "door", between: [`r${i}`, "passage"], position: 0.5 });
    x += w + 1;
  });
  const plan = dungeonPlan({
    generator: 5,
    w: total + 1,
    h: py + 3,
    id: "7c3e1f2b-5d9e-4f80-8b42-9a0f3d4e5b62",
    title: opts.title ?? "Rooms test",
    kind: "building",
    seed: 4242,
    theme: opts.theme ?? "wood_town",
    summary: "Rooms off a passage.",
    levelId: "l1",
    areas,
    openings,
    level: { name: "Ground", structures: [] },
  });
  return { ...plan, entryLevel: "l1" };
}

const level = (plan: MapPlan): ResolvedLevel =>
  resolvePlan(plan, bundledPalettes()).levels[0] as ResolvedLevel;
const inRoom = (L: ResolvedLevel, id: string): ResolvedFeature[] =>
  L.features.filter((f) => f.area === id && f.generatedBy !== "walls");
const centre = (f: ResolvedFeature): [number, number] => [
  f.at[0] + f.size[0] / 2 + (f.offset?.[0] ?? 0),
  f.at[1] + f.size[1] / 2 + (f.offset?.[1] ?? 0),
];
const lightsIn = (L: ResolvedLevel, id: string): ResolvedFeature[] =>
  inRoom(L, id).filter((f) => LIGHT_FEATURES.has(f.type));
const bbox = (L: ResolvedLevel, id: string): { x: number; y: number; w: number; h: number } =>
  (L.areas.find((a) => a.id === id) as { bbox: { x: number; y: number; w: number; h: number } }).bbox;

/** Is the piece a tile or more off every wall of its (rectangular) room? */
const free = (L: ResolvedLevel, id: string, f: ResolvedFeature): boolean => {
  const b = bbox(L, id);
  return f.at[0] > b.x && f.at[1] > b.y && f.at[0] + f.size[0] < b.x + b.w && f.at[1] + f.size[1] < b.y + b.h;
};

/** Each furnished room's light level and regime, drawn as the resolver draws them (resolve/level/rooms.ts). */
function lightingOf(plan: MapPlan, L: ResolvedLevel): Map<string, RoomLightPlan> {
  const lv = plan.levels[0];
  const scene = sceneLight({ theme: plan.theme, texts: [plan.title, plan.summary, plan.kind, lv?.name] });
  const lit: LitNeighbour[] = [];
  const out = new Map<string, RoomLightPlan>();
  for (const a of L.areas) {
    if (a.kind !== "room") continue;
    const pa = (lv?.areas ?? []).find((q) => q.id === a.id);
    const cls = classifyRoom(pa ?? {}, { kinds: true });
    if (!furnishedPurpose(cls.purpose)) continue;
    const idx = L.areaIds.indexOf(a.id) + 1;
    const cells: Array<[number, number]> = [];
    for (let y = a.bbox.y; y < a.bbox.y + a.bbox.h; y++)
      for (let x = a.bbox.x; x < a.bbox.x + a.bbox.w; x++) {
        const i = (y - L.bounds.y) * L.bounds.w + (x - L.bounds.x);
        if (L.cells.area[i] === idx && L.cells.state[i] === 2) cells.push([x, y]);
      }
    const at: [number, number] = [
      cells.reduce((s, c) => s + c[0] + 0.5, 0) / cells.length,
      cells.reduce((s, c) => s + c[1] + 0.5, 0) / cells.length,
    ];
    const d = drawLighting({
      kind: cls.kind ?? cls.purpose,
      scene,
      words: [pa?.name, ...(pa?.tags ?? []), pa?.notes],
      seed: subSeed(elementSeed(plan.seed, `${L.id}~${a.id}~room`, undefined), "room"),
      at,
      neighbours: lit,
      abandoned: cls.abandoned,
    });
    if (d.regime !== null) lit.push({ at, regime: d.regime });
    out.set(a.id, d);
  }
  return out;
}

describe("placement by room order (generator 5, placementOrder)", () => {
  const offAxis = (fs: readonly ResolvedFeature[]): number =>
    fs.length === 0 ? 0 : fs.filter((f) => f.rotFine % 90 !== 0).length / fs.length;
  const plan = building([
    { name: "Study", w: 7, h: 7 },
    { name: "Library", w: 7, h: 7 },
    { name: "Taproom", w: 9, h: 7 },
    { name: "Kitchen", w: 7, h: 7 },
    { name: "Store room", w: 6, h: 7 },
  ]);
  const L = level(plan);
  const loose = (id: string): ResolvedFeature[] => inRoom(L, id).filter((f) => f.type === "clutter");

  it("a tidy room sets its loose things square; a lived-in or working room lets them lie askew", () => {
    const tidy = [...loose("r0"), ...loose("r1")];
    const rough = [...loose("r2"), ...loose("r3"), ...loose("r4")];
    expect(tidy.length).toBeGreaterThan(5);
    expect(rough.length).toBeGreaterThan(5);
    expect(offAxis(tidy)).toBeLessThanOrEqual(0.25);
    expect(offAxis(rough)).toBeGreaterThan(offAxis(tidy) + 0.1);
  });

  it("structure and big furniture stay on quarter turns in every room", () => {
    for (const id of ["r0", "r1", "r2", "r3", "r4"])
      for (const f of inRoom(L, id)) {
        const info = featureInfo(f.type);
        // (a thing stacked on another, a crate on a crate, is a loose thing)
        if (
          !info.blocking ||
          info.seat === true ||
          LIGHT_FEATURES.has(f.type) ||
          f.baseHeight > L.elevation + 1
        )
          continue;
        expect(f.rotFine % 90, `${id} ${f.type} at ${f.at.join(",")}`).toBe(0);
      }
  });

  it("a seat in a tidy room faces its table square", () => {
    for (const id of ["r0", "r1"])
      for (const f of inRoom(L, id).filter((q) => featureInfo(q.type).seat === true))
        expect(f.rotFine % 90, `${id} seat at ${f.at.join(",")}`).toBe(0);
  });
});

describe("floor groups and station rows (generator 5, floorGroups)", () => {
  const plan = building([
    { name: "Taproom", w: 11, h: 9 },
    { name: "Dining hall", w: 9, h: 8 },
    { name: "Schoolroom", w: 8, h: 9 },
    { name: "Barracks", w: 7, h: 9 },
    { name: "Store room", w: 7, h: 9 },
    { name: "Sick ward", w: 7, h: 9 },
  ]);
  const L = level(plan);

  it("a taproom and a dining hall have free-standing table groups in the middle, seats facing in", () => {
    for (const id of ["r0", "r1"]) {
      const fs = inRoom(L, id);
      const tables = fs.filter((f) => (f.type === "table" || f.type === "round_table") && free(L, id, f));
      expect(tables.length, `${id} free tables`).toBeGreaterThanOrEqual(2);
      // each has a seat beside it facing it
      for (const t of tables) {
        const seats = fs.filter(
          (s) => featureInfo(s.type).seat === true && Math.hypot(...sub(centre(s), centre(t))) < 1.9,
        );
        expect(seats.length, `${id} seats at ${t.at.join(",")}`).toBeGreaterThanOrEqual(1);
      }
      // centres at least two tiles apart
      for (let i = 0; i < tables.length; i++)
        for (let j = i + 1; j < tables.length; j++)
          expect(
            Math.hypot(...sub(centre(tables[i] as ResolvedFeature), centre(tables[j] as ResolvedFeature))),
          ).toBeGreaterThanOrEqual(2);
    }
  });

  it("the groups of a room are not stamps: they differ in table, turn or seat count", () => {
    const fs = inRoom(L, "r0");
    const tables = fs.filter(
      (f) => (f.type === "table" || f.type === "round_table" || f.type === "barrel") && free(L, "r0", f),
    );
    const sig = (t: ResolvedFeature): string => {
      const seats = fs.filter(
        (s) => featureInfo(s.type).seat === true && Math.hypot(...sub(centre(s), centre(t))) < 1.9,
      );
      return `${t.type}:${t.rot % 180}:${seats.length}`;
    };
    expect(new Set(tables.map(sig)).size).toBeGreaterThanOrEqual(2);
  });

  it("a schoolroom's desks stand in rows in the middle, each with its chair", () => {
    const fs = inRoom(L, "r2");
    const desks = fs.filter((f) => f.type === "desk" && free(L, "r2", f));
    expect(desks.length).toBeGreaterThanOrEqual(3);
    for (const d of desks)
      expect(
        fs.some((c) => c.type === "chair" && Math.hypot(...sub(centre(c), centre(d))) < 1.3),
        `desk at ${d.at.join(",")}`,
      ).toBe(true);
  });

  it("a barracks, a ward and a store keep rows on both long walls with an aisle down the middle", () => {
    for (const [id, types] of [
      ["r3", ["bunk_bed", "chest"]],
      ["r4", ["crate", "barrel", "sack"]],
      ["r5", ["bed"]],
    ] as const) {
      const b = bbox(L, id);
      const fs = inRoom(L, id).filter(
        (f) => (types as readonly string[]).includes(f.type) && f.baseHeight < 1,
      );
      const west = fs.filter((f) => f.at[0] === b.x).length;
      const east = fs.filter((f) => f.at[0] + f.size[0] === b.x + b.w).length;
      expect(west, `${id} west row`).toBeGreaterThanOrEqual(2);
      expect(east, `${id} east row`).toBeGreaterThanOrEqual(2);
      // an aisle: a column between the rows with at most one blocker in it
      const blockers = (x: number): number =>
        inRoom(L, id).filter((f) => f.blocking && f.baseHeight < 1 && f.at[0] <= x && x < f.at[0] + f.size[0])
          .length;
      const aisles = Array.from({ length: b.w - 2 }, (_, i) => b.x + 1 + i).filter((x) => blockers(x) <= 1);
      expect(aisles.length, `${id} aisle`).toBeGreaterThanOrEqual(1);
    }
  });

  it("doorways stay clear and every seat and bed is reached from the door", () => {
    const blocked = new Set<string>();
    for (const f of L.features.filter((q) => q.blocking))
      for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
        for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) blocked.add(`${x},${y}`);
    for (const area of L.areas.filter((a) => a.kind === "room")) {
      const door = L.openings.find((o) => o.sides.includes(area.id) && o.kind !== "window");
      if (!door) continue;
      const start: [number, number] = [door.start[0], door.start[1] - 1];
      expect(blocked.has(`${start[0]},${start[1]}`), `${area.id} doorway`).toBe(false);
      const { x: bx, y: by, w: bw, h: bh } = area.bbox;
      const inside = (x: number, y: number): boolean => x >= bx && y >= by && x < bx + bw && y < by + bh;
      const seen = new Set([`${start[0]},${start[1]}`]);
      const queue = [start];
      for (let h = 0; h < queue.length; h++) {
        const [x, y] = queue[h] as [number, number];
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const k = `${x + dx},${y + dy}`;
          if (!inside(x + dx, y + dy) || blocked.has(k) || seen.has(k)) continue;
          seen.add(k);
          queue.push([x + dx, y + dy]);
        }
      }
      for (const f of inRoom(L, area.id).filter(
        (q) => featureInfo(q.type).seat === true || q.type === "bed" || q.type === "bunk_bed",
      )) {
        const ring: Array<[number, number]> = [];
        for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++)
          ring.push([x, f.at[1] - 1], [x, f.at[1] + f.size[1]]);
        for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
          ring.push([f.at[0] - 1, y], [f.at[0] + f.size[0], y]);
        expect(
          ring.some(([x, y]) => seen.has(`${x},${y}`)),
          `${area.id} ${f.type} at ${f.at.join(",")} reachable`,
        ).toBe(true);
      }
    }
  });

  it("deterministic", () => {
    expect(JSON.stringify(level(plan).features)).toBe(JSON.stringify(L.features));
  });
});

describe("lighting regimes (generator 5, lightRegimes)", () => {
  it("at least three regimes across the interiors fixture, and each room's lights follow its regime", () => {
    for (const theme of ["wood_town", "stone_dungeon"]) {
      const plan = { ...loadPlan("interiors-lineup-v1"), theme };
      const L = level(plan);
      const lighting = lightingOf(plan, L);
      const drawn = new Set([...lighting.values()].map((d) => d.regime).filter((r) => r !== null));
      expect(drawn.size, theme).toBeGreaterThanOrEqual(3);
      for (const [id, d] of lighting) {
        const ls = lightsIn(L, id);
        const wall = ls.filter((f) => f.wall !== undefined);
        // (sensibleLights: a bright room's extra light is on its walls, not lamps on its floor)
        if (d.regime === "surfaces" && d.level < 3)
          expect(wall.length, `${theme} ${id} surfaces: no wall lights`).toBe(0);
        if (d.regime === "dimStore") expect(ls.length, `${theme} ${id} dim store`).toBeLessThanOrEqual(1);
        if (d.regime === "threshold") {
          const door = L.openings.find((o) => o.sides.includes(id) && o.kind !== "window");
          const near = wall.filter(
            (f) => door && Math.hypot(f.at[0] - door.start[0], f.at[1] - door.start[1]) <= 3,
          );
          expect(near.length, `${theme} ${id} threshold pair`).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it("no light stands on a floor in a lane, a door's landing or a passage, and no candle stands on the floor", () => {
    for (const theme of ["wood_town", "stone_dungeon"]) {
      const L = level({ ...loadPlan("interiors-lineup-v1"), theme });
      const kept = new Set(L.keptClear ?? []);
      const floorTop = L.elevation + 0.5;
      for (const f of L.features.filter((q) => LIGHT_FEATURES.has(q.type) && q.wall === undefined)) {
        if (f.baseHeight > floorTop + 0.3) continue;
        const area = L.areas.find((a) => a.id === f.area);
        expect(area?.kind, `${theme} ${f.type} at ${f.at.join(",")}`).not.toBe("corridor");
        const i = (f.at[1] - L.bounds.y) * L.bounds.w + (f.at[0] - L.bounds.x);
        expect(kept.has(i), `${theme} ${f.type} at ${f.at.join(",")} in a lane`).toBe(false);
        expect(["candles", "candelabra"], `${theme} candle on the floor at ${f.at.join(",")}`).not.toContain(
          f.type,
        );
      }
    }
  });

  it("the same plan in a dim scene and a bright one differs in its lights", () => {
    const rooms = [
      { name: "Taproom", w: 9, h: 7 },
      { name: "Kitchen", w: 6, h: 6 },
      { name: "Guest bedroom", w: 6, h: 6 },
      { name: "Parlour", w: 7, h: 7 },
    ];
    const count = (title: string): number => {
      const L = level(building(rooms, { title }));
      return ["r0", "r1", "r2", "r3", "passage"].reduce((n, id) => n + lightsIn(L, id).length, 0);
    };
    expect(count("A bright festive inn")).toBeGreaterThan(count("A dim, intimate inn by night"));
  });

  it("in one scene a bright kind (a ward, a schoolroom) carries more lights per tile than a dim one (a store)", () => {
    const plan = building([
      { name: "Sick ward", w: 7, h: 8 },
      { name: "Store room", w: 7, h: 8 },
      { name: "Schoolroom", w: 7, h: 8 },
      { name: "Cellar store", w: 7, h: 8 },
    ]);
    const L = level(plan);
    const d = lightingOf(plan, L);
    const bright = (d.get("r0")?.level ?? 0) + (d.get("r2")?.level ?? 0);
    const dim = (d.get("r1")?.level ?? 0) + (d.get("r3")?.level ?? 0);
    expect(bright).toBeGreaterThan(dim);
    const n = (id: string): number => lightsIn(L, id).length;
    expect(n("r0") + n("r2")).toBeGreaterThan(n("r1") + n("r3"));
  });

  it("a passage is lit at its doors or junctions, never from its floor, and lived-in rooms keep a light", () => {
    const plan = building([
      { name: "Kitchen" },
      { name: "Study" },
      { name: "Bedroom" },
      { name: "Store room" },
    ]);
    const L = level(plan);
    const ls = lightsIn(L, "passage");
    expect(ls.length).toBeGreaterThanOrEqual(1);
    for (const f of ls) expect(f.wall, `passage light at ${f.at.join(",")}`).toBeDefined();
    for (const id of ["r0", "r1", "r2", "r3"]) expect(lightsIn(L, id).length, id).toBeGreaterThanOrEqual(1);
  });
});

function sub(a: readonly number[], b: readonly number[]): [number, number] {
  return [(a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0)];
}
