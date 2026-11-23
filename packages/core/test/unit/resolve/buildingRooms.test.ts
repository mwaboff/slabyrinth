/**
 * Ground-storey rooms (generator 5, switch `buildingRooms`): the programme table (gen/buildingProgramme.ts) and the
 * splitter (resolve/building/rooms.ts) on the street fixture building-rooms-street-v1 (a house, a shop, an inn, a
 * workshop and a tiny cottage) and on single houses: the rooms are ordinary furnished rooms, the street door opens into
 * the public room, every room is reached, no partition meets a window or door, the same plan builds the same rooms, the
 * same kind of house differs over seeds, the build verifies clean, the storeys above are untouched, and generator 4
 * builds the shells it always built.
 */
import { describe, expect, it } from "vitest";
import { compileResolved, realize } from "../../../src/compile";
import type { Building, MapPlan, Side } from "../../../src/contracts/plan";
import type { ResolvedLevel, ResolvedPlan } from "../../../src/contracts/resolved";
import { CELL } from "../../../src/contracts/resolved";
import {
  BUILDING_KINDS,
  BUILDING_KIND_NAMES,
  type BuildingKindRow,
  buildingKind,
} from "../../../src/gen/buildingProgramme";
import { SIDE_STEP } from "../../../src/gen/gridGeometry";
import { isPassage } from "../../../src/gen/openingKinds";
import { classifyRoom } from "../../../src/gen/roomPurpose";
import { bundledPalettes } from "../../../src/palette";
import { generatorProfile } from "../../../src/plan/generator";
import { resolvePlan, walkPathsFrom } from "../../../src/resolve";
import { decompose, splitGroundStorey } from "../../../src/resolve/building/rooms";
import { LevelGrid } from "../../../src/resolve/levelGrid";
import { slabCodec } from "../../../src/slab";
import { loadPlan } from "../../fixtures";

const pal = bundledPalettes();
const street = loadPlan("building-rooms-street-v1");
const at = (plan: MapPlan, generator: 4 | 5): MapPlan => ({ ...plan, generator });
const resolved5 = resolvePlan(street, pal);
const L5 = resolved5.levels[0] as ResolvedLevel;

/** The rooms a building's ground storey was split into. */
const roomsOf = (L: ResolvedLevel, id: string) => L.areas.filter((a) => a.building === id);
/** A room's floor cells, by the cells the level shows as it. */
const cellsOf = (L: ResolvedLevel, areaId: string): Array<[number, number]> => {
  const ai = L.areaIds.indexOf(areaId) + 1;
  const out: Array<[number, number]> = [];
  L.cells.area.forEach((a, i) => {
    if (a === ai && L.cells.state[i] === CELL.OPEN)
      out.push([L.bounds.x + (i % L.bounds.w), L.bounds.y + Math.floor(i / L.bounds.w)]);
  });
  return out;
};
/** The building's street door: its first ground opening a person walks through. */
const streetDoor = (L: ResolvedLevel, id: string) => {
  const st = L.structures?.find((s) => s.id === id);
  return L.openings.find((o) => st?.openingIds.includes(o.id) === true && isPassage(o.kind));
};

describe("the switch", () => {
  it("starts in generator 5", () => {
    expect(generatorProfile(4).buildingRooms).toBe(false);
    expect(generatorProfile(5).buildingRooms).toBe(true);
  });
});

describe("the programme table", () => {
  it("names every room with words the room classifier reads as its kind", () => {
    for (const kind of BUILDING_KIND_NAMES) {
      const row: BuildingKindRow = BUILDING_KINDS[kind];
      for (const room of [...row.programmes.flatMap((p) => p.rooms), ...row.zones, row.single])
        expect(classifyRoom({ name: room.name }, { kinds: true }).kind, `${kind}: ${room.name}`).toBe(
          room.kind,
        );
    }
  });

  it("reads a building's kind from its use, then its name, then a shopfront, else a dwelling", () => {
    expect(buildingKind({ use: "inn" })).toBe("inn");
    expect(buildingKind({ use: "baker" })).toBe("shop");
    expect(buildingKind({ use: "smith", name: "The Old Shop" })).toBe("workshop");
    expect(buildingKind({ name: "The Gilded Goose Tavern" })).toBe("inn");
    expect(buildingKind({ shopfront: true })).toBe("shop");
    expect(buildingKind({ style: "keep" })).toBe("guard");
    expect(buildingKind({ name: "Brick house" })).toBe("dwelling");
    expect(buildingKind({})).toBe("dwelling");
  });

  it("puts the public room first in every programme, with service and private rooms behind it", () => {
    for (const kind of BUILDING_KIND_NAMES)
      for (const p of BUILDING_KINDS[kind].programmes) {
        expect(p.rooms[0].role, p.id).toBe("public");
        expect(
          p.rooms.slice(1).every((r) => r.role !== "public"),
          p.id,
        ).toBe(true);
      }
  });
});

describe("ground-storey rooms on the street fixture", () => {
  it("gives a house a furnished, lit ground storey; generator 4 leaves it a shell", () => {
    const rooms = roomsOf(L5, "house");
    expect(rooms.length).toBeGreaterThanOrEqual(2);
    for (const r of rooms) {
      expect(r.kind).toBe("room");
      const mine = L5.features.filter((f) => f.area === r.id);
      expect(mine.length, r.id).toBeGreaterThan(0);
      expect(
        mine.some((f) => ["candles", "candelabra", "torch_wall", "brazier", "lantern"].includes(f.type)),
        r.id,
      ).toBe(true);
    }
    const L4 = resolvePlan(at(street, 4), pal).levels[0] as ResolvedLevel;
    expect(L4.areas.some((a) => a.building !== undefined)).toBe(false);
    const house4 = new Set(L4.structures?.find((s) => s.id === "house")?.cells.map(([x, y]) => `${x},${y}`));
    expect(L4.features.filter((f) => house4.has(`${f.at[0]},${f.at[1]}`))).toEqual([]);
  });

  it("opens the shop's street door into the shop floor, which holds its counter", () => {
    const door = streetDoor(L5, "shop");
    const floor = roomsOf(L5, "shop")[0];
    expect(floor?.name).toBe("Shop floor");
    expect(door?.sides).toContain(floor?.id);
    expect(
      L5.features.some((f) => f.area === floor?.id && (f.type === "counter" || f.type === "bar_counter")),
    ).toBe(true);
  });

  it("makes the inn's taproom the largest room, at the street door", () => {
    const rooms = roomsOf(L5, "inn");
    const tap = rooms.find((r) => r.name === "Taproom");
    expect(tap).toBeDefined();
    for (const r of rooms) expect(tap?.cellCount ?? 0).toBeGreaterThanOrEqual(r.cellCount);
    expect(streetDoor(L5, "inn")?.sides).toContain(tap?.id);
    expect(rooms.some((r) => r.name === "Kitchen")).toBe(true);
  });

  it("makes a tiny cottage one room", () => {
    expect(roomsOf(L5, "cottage").length).toBe(1);
  });

  it("reaches every room from outside, by its doorways", () => {
    const walk = walkPathsFrom(resolved5, undefined).reached.get("g") as Uint8Array;
    for (const r of L5.areas.filter((a) => a.building !== undefined)) {
      const ai = L5.areaIds.indexOf(r.id) + 1;
      const reached = L5.cells.area.some((a, i) => a === ai && walk[i] === 1);
      expect(reached, r.id).toBe(true);
    }
  });

  it("never runs a partition into a window or door, or against a door's jamb", () => {
    const g = new LevelGrid(L5);
    for (const st of L5.structures ?? []) {
      const cells = new Set(st.cells.map(([x, y]) => `${x},${y}`));
      const roomAt = new Map<string, string>();
      for (const r of roomsOf(L5, st.id))
        for (const [x, y] of cellsOf(L5, r.id)) roomAt.set(`${x},${y}`, r.id);
      for (const o of L5.openings.filter((q) => st.openingIds.includes(q.id))) {
        const h = o.orientation === "h";
        const [sx, sy] = o.start;
        // the row of cells inside the building along the opening's wall (south / east of the edge, or north / west)
        const row = cells.has(`${sx},${sy}`) ? 0 : -1;
        const cellAt = (k: number): [number, number] => (h ? [sx + k, sy + row] : [sx + row, sy + k]);
        // at each vertex along the opening (and at its ends for a way in), no wall between two of the building's rooms
        const from = isPassage(o.kind) ? 0 : 1;
        const to = isPassage(o.kind) ? o.width : o.width - 1;
        for (let k = from; k <= to; k++) {
          const [cx, cy] = cellAt(k);
          const [px, py] = cellAt(k - 1);
          const a = roomAt.get(`${cx},${cy}`);
          const b = roomAt.get(`${px},${py}`);
          if (a === undefined || b === undefined || a === b) continue;
          const side: Side = h ? "W" : "N";
          expect(g.wallOn(cx, cy, side), `${st.id} ${o.id} at ${k}`).toBe(false);
        }
      }
    }
  });

  it("builds the same rooms from the same plan", () => {
    const again = resolvePlan(street, pal).levels[0] as ResolvedLevel;
    expect(JSON.stringify(again.areas)).toBe(JSON.stringify(L5.areas));
    expect(JSON.stringify(again.openings)).toBe(JSON.stringify(L5.openings));
    expect(JSON.stringify(again.features)).toBe(JSON.stringify(L5.features));
  });

  it("verifies clean: no error and no warning", () => {
    const bundle = compileResolved(resolved5, pal, slabCodec, { createdAt: "t", plan: street });
    const bad = bundle.diagnostics.filter((d) => d.severity === "error" || d.severity === "warning");
    expect(bad.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });

  it("leaves the storeys above and the roofs as they were", () => {
    // the same street with a piece of the plan's own in every building: the plan describes the ground storeys, which
    // keep no rooms
    const described: MapPlan = structuredClone(street);
    const lv = described.levels[0];
    if (!lv) throw new Error("no level");
    for (const st of lv.structures ?? []) {
      const w = (st as Building).wings?.[0];
      if (w) lv.features.push({ id: `${st.id}_crate`, type: "crate", at: [w.x + 1, w.y + 1] });
    }
    const shell = resolvePlan(described, pal);
    expect(shell.levels[0]?.areas.some((a) => a.building !== undefined)).toBe(false);
    const upper = (r: ResolvedPlan): string[] =>
      realize(r, pal, {})
        .levels.flatMap((l) => l.placements)
        .filter(
          (p) =>
            (p.layer === "roof" || /^storey:[1-9]/.test(p.layer ?? "")) &&
            // the building's own pieces (the detail recipes keep clear of what stands inside)
            !(p.source.elementId ?? "").includes("@"),
        )
        .map((p) => `${p.asset} ${p.x.toFixed(3)} ${p.y.toFixed(3)} ${p.z.toFixed(3)} ${p.rot} ${p.layer}`)
        .sort();
    expect(upper(resolved5)).toEqual(upper(shell));
    expect(JSON.stringify(resolved5.levels[0]?.structures)).toBe(JSON.stringify(shell.levels[0]?.structures));
  });
});

describe("the same kind of house over seeds", () => {
  const house = (seed: number, footprint = { x: 6, y: 4, w: 8, h: 7 }): MapPlan => ({
    ...at(street, 5),
    seed: 900 + seed,
    levels: [
      {
        id: "g",
        name: "Lane",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 24, h: 20 },
        base: { type: "ground", material: "grass" },
        areas: [],
        openings: [],
        walls: [],
        features: [],
        labels: [],
        terrain: [],
        structures: [
          {
            id: "h",
            name: "House",
            use: "house",
            style: "cottage",
            seed,
            wings: [footprint],
            storeys: [{}, {}],
            front: "S",
          },
        ],
      },
    ],
  });

  it("draws at least three layouts over twenty seeds", () => {
    const layouts = new Set<string>();
    for (let s = 1; s <= 20; s++) {
      const L = resolvePlan(house(s), pal).levels[0] as ResolvedLevel;
      layouts.add(
        roomsOf(L, "h")
          .map((r) => `${r.name}@${r.bbox.x},${r.bbox.y},${r.bbox.w}x${r.bbox.h}`)
          .join("|"),
      );
    }
    expect(layouts.size).toBeGreaterThanOrEqual(3);
  });
});

describe("the splitter", () => {
  const rect = (w: number, h: number, x0 = 0, y0 = 0): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push([x, y]);
    return out;
  };

  it("cuts an L into two rectangles and leaves a shape it cannot cut", () => {
    expect(decompose(rect(6, 5))).toEqual([{ x: 0, y: 0, w: 6, h: 5 }]);
    const l = [...rect(8, 4), ...rect(4, 4, 0, 4)];
    expect(decompose(l)?.length).toBe(2);
    // a plus: no one cut leaves two rectangles
    const plus = [...rect(3, 3, 3, 0), ...rect(9, 3, 0, 3), ...rect(3, 3, 3, 6)];
    expect(decompose(plus)).toBeNull();
    // the splitter makes it one room
    const one = splitGroundStorey({
      id: "b",
      cells: plus,
      openings: [{ kind: "door", at: [4, 8], side: "S", width: 1 }],
      hearths: [],
      kind: "dwelling",
      seed: 1,
    });
    expect(one?.rooms.length).toBe(1);
    expect(one?.layout).toBe("whole");
  });

  it("splits an L with a wing room, every room joined to the public room", () => {
    const l = [...rect(9, 5), ...rect(5, 5, 0, 5)];
    for (let seed = 1; seed <= 12; seed++) {
      const got = splitGroundStorey({
        id: "b",
        cells: l,
        openings: [{ kind: "door", at: [6, 4], side: "S", width: 1 }],
        hearths: [],
        kind: "inn",
        seed,
      });
      expect(got).not.toBeNull();
      const n = got?.rooms.length ?? 0;
      expect(got?.doorways.length).toBe(n - 1);
      const cells = new Set(got?.rooms.flatMap((r) => r.cells.map(([x, y]) => `${x},${y}`)));
      expect(cells.size).toBe(l.length);
      // the street door's cell is the public room's
      expect(got?.rooms[0]?.cells.some(([x, y]) => x === 6 && y === 4)).toBe(true);
    }
  });

  it("keeps a chimney breast in a hearth room and a kitchen's doorway off a bedroom", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const got = splitGroundStorey({
        id: "b",
        cells: rect(9, 7),
        openings: [{ kind: "door", at: [4, 6], side: "S", width: 1 }],
        hearths: [[0, 3]],
        kind: "dwelling",
        seed,
      });
      const holder = got?.rooms.find((r) => r.cells.some(([x, y]) => x === 0 && y === 3));
      expect(["kitchen", "dining", "lounge"]).toContain(holder?.kind);
      if (!got || got.programme === "zones") continue;
      const roomOf = new Map<string, number>();
      got.rooms.forEach((r, i) => {
        for (const [x, y] of r.cells) roomOf.set(`${x},${y}`, i);
      });
      for (const d of got.doorways) {
        const [dx, dy] = SIDE_STEP[d.side];
        const a = got.rooms[roomOf.get(`${d.at[0]},${d.at[1]}`) ?? -1];
        const b = got.rooms[roomOf.get(`${d.at[0] + dx},${d.at[1] + dy}`) ?? -1];
        const pair = [a?.kind, b?.kind].sort().join("|");
        if (a?.role !== "public" && b?.role !== "public") expect(pair).not.toBe("bedroom|kitchen");
      }
    }
  });
});
