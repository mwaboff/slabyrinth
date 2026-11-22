/**
 * Generator 5 interiors: anchor-and-companion groups (switch companionGroups, gen/rooms4/groups.ts) and lights by
 * occupancy (switch occupancyLights, gen/rooms4/occupancy.ts), measured on resolved builds. The rules come from the
 * room-purpose table of the interior study: a bed has a nightstand touching its head with a light and a chest at its
 * foot; a bar's stools face it at a pitch of 0.65-1.0; doors and the lane to the anchor stay clear; a room down to 3
 * tiles holds its minimum set and a light. Each test fails at generator 4 (the same plan, the gen-4 furnisher).
 */
import { describe, expect, it } from "vitest";
import { compileResolved } from "../../../src/compile";
import type { Area, MapPlan, Opening } from "../../../src/contracts/plan";
import type { ResolvedFeature, ResolvedLevel } from "../../../src/contracts/resolved";
import { LIGHT_FEATURES, featureInfo } from "../../../src/gen/catalog";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { slabCodec } from "../../../src/slab";
import { dungeonPlan } from "../../fixtures/planBuilder";

const palettes = loadPalettes();

type RoomSpec = { name: string; w?: number; h?: number; windows?: boolean };

/** Rooms in a row north of a passage, each with a door onto it (and windows in its north wall when asked). */
function building(
  rooms: ReadonlyArray<string | RoomSpec>,
  opts: { generator?: 4 | 5; theme?: string } = {},
): MapPlan {
  const specs = rooms.map((r) => (typeof r === "string" ? { name: r } : r));
  const widths = specs.map((s) => s.w ?? 6);
  const total = widths.reduce((a, b) => a + b + 1, 1);
  const areas: Area[] = [
    {
      id: "passage",
      kind: "corridor",
      name: "Passage",
      shape: { type: "rect", x: 1, y: 9, w: total - 2, h: 3 },
    },
  ];
  const openings: Opening[] = [];
  let x = 1;
  specs.forEach((s, i) => {
    const w = s.w ?? 6;
    const h = s.h ?? 6;
    const id = `r${i}`;
    areas.push({ id, kind: "room", name: s.name, shape: { type: "rect", x, y: 9 - h, w, h } });
    openings.push({ id: `d${i}`, kind: "door", between: [id, "passage"], position: 0.5 });
    if (s.windows === true)
      openings.push({
        id: `w${i}`,
        kind: "window",
        at: { x: x + Math.floor(w / 2) - 1, y: 9 - h, side: "N" },
        width: 1,
      });
    x += w + 1;
  });
  const plan = dungeonPlan({
    generator: opts.generator ?? 5,
    w: total + 1,
    h: 14,
    id: "6b2e0f1a-4c8d-4e7f-9a31-8f9e2c3d4a51",
    title: "Interiors test",
    kind: "building",
    seed: 777,
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
/** The direction a piece faces (rot 0 faces south). */
const facing = (f: ResolvedFeature): [number, number] => {
  const r = (f.rotFine * Math.PI) / 180;
  return [-Math.sin(r), Math.cos(r)];
};
const dot = (a: readonly number[], b: readonly number[]): number =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0);
const sub = (a: readonly number[], b: readonly number[]): [number, number] => [
  (a[0] ?? 0) - (b[0] ?? 0),
  (a[1] ?? 0) - (b[1] ?? 0),
];

describe("anchor and companions (generator 5, companionGroups)", () => {
  it("a bedroom's bed has a nightstand at its head with a light, and a chest at its foot", () => {
    for (const theme of ["wood_town", "stone_dungeon"]) {
      const L = level(building(["Guest bedroom", "Bedroom", "Bedchamber"], { theme }));
      for (const id of ["r0", "r1", "r2"]) {
        const fs = inRoom(L, id);
        const bed = fs.find((f) => f.type === "bed");
        expect(bed, `${theme} ${id} bed`).toBeDefined();
        const b = bed as ResolvedFeature;
        const face = facing(b);
        const across: [number, number] = [-face[1], face[0]];
        const half = Math.max(b.size[0], b.size[1]) / 2;
        // the chest: in front of the bed's foot, within 1.5 of it, in line with the bed
        const chests = fs.filter((f) => f.type === "chest" || (f.type === "crate" && f.variant === "small"));
        const atFoot = chests.filter((c) => {
          const d = sub(centre(c), centre(b));
          return dot(d, face) > half && dot(d, face) < half + 1.5 && Math.abs(dot(d, across)) < 0.6;
        });
        expect(atFoot.length, `${theme} ${id} chest at the foot`).toBeGreaterThanOrEqual(1);
        // the nightstand: beside the head half, touching it (its centre within half a bed width + 0.3 + its own half)
        const stands = chests.filter((c) => {
          const d = sub(centre(c), centre(b));
          return (
            dot(d, face) < 0 && Math.abs(dot(d, across)) > 0.4 && Math.abs(dot(d, across)) < 0.46 + 0.3 + 0.45
          );
        });
        expect(stands.length, `${theme} ${id} nightstand at the head`).toBeGreaterThanOrEqual(1);
        // with a light on it
        const lit = stands.some((s) =>
          fs.some(
            (l) =>
              LIGHT_FEATURES.has(l.type) &&
              l.at[0] === s.at[0] &&
              l.at[1] === s.at[1] &&
              l.baseHeight > s.baseHeight,
          ),
        );
        expect(lit, `${theme} ${id} light on the nightstand`).toBe(true);
      }
    }
  });

  it("generator 4 has no such group (the test above measures a generator-5 rule)", () => {
    const L = level(building(["Guest bedroom", "Bedroom", "Bedchamber"], { generator: 4 }));
    const groups = ["r0", "r1", "r2"].filter((id) => {
      const fs = inRoom(L, id);
      const b = fs.find((f) => f.type === "bed");
      if (!b) return false;
      const face = facing(b);
      return fs.some(
        (c) =>
          (c.type === "chest" || c.type === "crate") &&
          dot(sub(centre(c), centre(b)), face) > Math.max(b.size[0], b.size[1]) / 2 &&
          dot(sub(centre(c), centre(b)), face) < Math.max(b.size[0], b.size[1]) / 2 + 1.5,
      );
    });
    expect(groups.length).toBeLessThan(3);
  });

  it("a bar's stools face it along its public face at a pitch of 0.65-1.0, a tile or less off it", () => {
    for (const theme of ["wood_town", "stone_dungeon"]) {
      const L = level(building([{ name: "Taproom", w: 9, h: 7 }], { theme }));
      const fs = inRoom(L, "r0");
      const bar = fs.filter((f) => f.type === "bar_counter");
      expect(bar.length, theme).toBeGreaterThanOrEqual(2);
      const stools = fs.filter((f) => f.type === "stool" || f.type === "chair");
      const atBar = stools.filter((s) => bar.some((c) => Math.hypot(...sub(centre(s), centre(c))) < 1.05));
      expect(atBar.length, `${theme} stools at the bar`).toBeGreaterThanOrEqual(2);
      for (const s of atBar) {
        const c = bar.reduce((a, q) =>
          Math.hypot(...sub(centre(q), centre(s))) < Math.hypot(...sub(centre(a), centre(s))) ? q : a,
        );
        const to = sub(centre(c), centre(s));
        const len = Math.hypot(...to);
        expect(dot(facing(s), [to[0] / len, to[1] / len]), `${theme} stool faces the bar`).toBeGreaterThan(
          0.9,
        );
      }
      const pts = atBar.map(centre).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      for (let i = 1; i < pts.length; i++) {
        const gap = Math.hypot(...sub(pts[i] as number[], pts[i - 1] as number[]));
        expect(gap, `${theme} stool pitch`).toBeGreaterThanOrEqual(0.65);
        expect(gap, `${theme} stool pitch`).toBeLessThanOrEqual(1.01);
      }
    }
  });

  it("a study's desk has its chair in front facing it, and a lamp on it", () => {
    const L = level(building(["Study", "Office", { name: "Study", windows: true }]));
    for (const id of ["r0", "r1", "r2"]) {
      const fs = inRoom(L, id);
      const desks = fs.filter((f) => f.type === "desk" || f.type === "table");
      const chairs = fs.filter((f) => f.type === "chair");
      // a chair is at a desk when the desk's footprint is within 0.8 of it and it faces the desk
      const attended = desks.filter((d) =>
        chairs.some((c) => {
          const [cx, cy] = centre(c);
          const near: [number, number] = [
            Math.max(d.at[0], Math.min(d.at[0] + d.size[0], cx)),
            Math.max(d.at[1], Math.min(d.at[1] + d.size[1], cy)),
          ];
          const to = sub(centre(d), [cx, cy]);
          const len = Math.hypot(...to);
          return Math.hypot(...sub(near, [cx, cy])) < 0.8 && dot(facing(c), [to[0] / len, to[1] / len]) > 0.7;
        }),
      );
      expect(attended.length, id).toBeGreaterThanOrEqual(1);
      expect(
        fs.some(
          (l) =>
            l.type === "candles" &&
            desks.some(
              (d) =>
                l.at[0] >= d.at[0] &&
                l.at[0] < d.at[0] + d.size[0] &&
                l.at[1] >= d.at[1] &&
                l.at[1] < d.at[1] + d.size[1],
            ),
        ),
        id,
      ).toBe(true);
    }
  });

  it("a desk goes under a window when the room has one", () => {
    const L = level(building([{ name: "Study", windows: true }]));
    const desk = inRoom(L, "r0").find((f) => f.type === "desk");
    expect(desk).toBeDefined();
    // the window is in the north wall at the room's middle: the desk backs onto the north wall there
    expect((desk as ResolvedFeature).at[1]).toBe(3);
    expect(Math.abs(centre(desk as ResolvedFeature)[0] - 3.5)).toBeLessThanOrEqual(1);
  });

  it("a small room too tight for the whole group gets its minimum set: the bed, its nightstand and a light", () => {
    const plan = building([{ name: "Bedroom", w: 2, h: 3 }, "Kitchen"]);
    const L5 = level(plan);
    for (const id of ["r0"]) {
      const fs = inRoom(L5, id);
      const bed = fs.find((f) => f.type === "bed");
      expect(bed, id).toBeDefined();
      const stand = fs.find(
        (f) =>
          (f.type === "crate" || f.type === "chest" || f.type === "stool") &&
          Math.hypot(...sub(centre(f), centre(bed as ResolvedFeature))) < 1.6,
      );
      expect(stand, `${id} nightstand`).toBeDefined();
      expect(
        fs.some((f) => LIGHT_FEATURES.has(f.type)),
        `${id} light`,
      ).toBe(true);
    }
  });
});

describe("the way stays clear (generator 5)", () => {
  const ROOMS = [
    "Taproom",
    "Kitchen",
    "Guest bedroom",
    "Study",
    "General shop",
    "Store room",
    "Parlour",
    "Schoolroom",
    "Barracks",
    "Infirmary",
    "Stables",
    "Helm",
  ];

  /** Cells under a blocking feature's footprint. */
  const blockedCells = (L: ResolvedLevel): Set<string> => {
    const out = new Set<string>();
    for (const f of L.features.filter((q) => q.blocking))
      for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
        for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) out.add(`${x},${y}`);
    return out;
  };

  it("no blocking piece stands in a doorway or the cell inside it", () => {
    const L = level(building(ROOMS.map((n) => ({ name: n, w: 6, h: 6 }))));
    const blocked = blockedCells(L);
    for (const o of L.openings) {
      if (o.kind === "window") continue;
      for (let k = 0; k < o.width; k++) {
        // the room side of a door on the passage's north edge: the cell north of it and the one north of that
        const [x, y] = o.orientation === "h" ? [o.start[0] + k, o.start[1]] : [o.start[0], o.start[1] + k];
        for (const c of [`${x},${y - 1}`, `${x},${y - 2}`, `${x},${y}`])
          expect(blocked.has(c), `${o.id} ${c}`).toBe(false);
      }
    }
  });

  it("every seat, bed and the anchor's face can be reached from the door through free cells", () => {
    const L = level(building(ROOMS.map((n) => ({ name: n, w: 6, h: 6 }))));
    const blocked = blockedCells(L);
    for (const area of L.areas.filter((a) => a.kind === "room")) {
      const door = L.openings.find((o) => o.sides.includes(area.id) && o.kind !== "window");
      if (!door) continue;
      const start: [number, number] = [door.start[0], door.start[1] - 1];
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
      // a seat or a bed is reached when a free cell beside it is
      for (const f of inRoom(L, area.id).filter(
        (q) => featureInfo(q.type).seat === true || q.type === "bed",
      )) {
        const ring: Array<[number, number]> = [];
        for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++)
          ring.push([x, f.at[1] - 1], [x, f.at[1] + f.size[1]]);
        for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
          ring.push([f.at[0] - 1, y], [f.at[0] + f.size[0], y]);
        const near = ring.some(([x, y]) => seen.has(`${x},${y}`));
        expect(near, `${area.id} ${f.type} at ${f.at.join(",")} reachable`).toBe(true);
      }
    }
  });

  it("deterministic: the same plan gives the same rooms", () => {
    const plan = building(ROOMS);
    expect(JSON.stringify(level(plan).features)).toBe(JSON.stringify(level(plan).features));
  });

  it("the build is clean in three themes: no floating, sunk, walled-in or overlapping prop", () => {
    for (const theme of ["wood_town", "stone_dungeon", "city"]) {
      const plan = building(ROOMS, { theme });
      const bundle = compileResolved(resolvePlan(plan, bundledPalettes()), palettes, slabCodec, { plan });
      expect(
        bundle.diagnostics.filter((d) => d.severity !== "info"),
        theme,
      ).toEqual([]);
    }
  });
});
