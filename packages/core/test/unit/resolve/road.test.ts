/**
 * Roads (generator 2): a path op in road form (`sidewalk`, `crossings`). Measured on resolved cells and realized
 * pieces: straightness, constant width, board edges, pavement beside the carriageway and up to building lots,
 * continuous kerbs with gaps at crossings and junction mouths, merged junctions, tile orientation along the axis.
 */
import { describe, expect, it } from "vitest";
import type { Level, MapPlan, TerrainOp } from "../../../src/contracts/plan";
import { CELL_FLAG, type ResolvedLevel } from "../../../src/contracts/resolved";
import { compileResolved, placementMeta, realize } from "../../../src/compile";
import { loadPalettes } from "../../../src/palette";
import { checkPlayability, resolvePlan } from "../../../src/resolve";
import { slabCodec } from "../../../src/slab";

const W = 40;
const H = 30;

function street(terrain: TerrainOp[], extra: Partial<Level> = {}, generator: 1 | 2 = 2): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator,
    id: "street",
    title: "Street",
    kind: "outdoor",
    theme: "outdoor",
    seed: 7,
    links: [],
    levels: [
      {
        id: "g",
        name: "Street",
        elevation: 0,
        bounds: { x: 0, y: 0, w: W, h: H },
        base: { type: "ground", material: "concrete" },
        areas: [],
        openings: [],
        walls: [],
        features: [],
        terrain,
        labels: [],
        ...extra,
      },
    ],
  };
}

const sidewalk = { width: 2, material: "concrete" as const };
const main = (extra: Partial<Extract<TerrainOp, { op: "path" }>> = {}): TerrainOp => ({
  id: "main",
  op: "path",
  points: [
    [0, 20],
    [39, 20],
  ],
  width: 6,
  material: "asphalt",
  sidewalk,
  ...extra,
});
const side: TerrainOp = {
  id: "side",
  op: "path",
  points: [
    [20, 20],
    [20, 0],
  ],
  width: 4,
  material: "asphalt",
  sidewalk,
};

const L0 = (p: MapPlan): ResolvedLevel => resolvePlan(p).levels[0] as ResolvedLevel;
const key = (c: readonly [number, number]): string => `${c[0]},${c[1]}`;

describe("roads: path op in road form (generator 2)", () => {
  it("is dead straight with a constant width and reaches both board edges, jitter or not", () => {
    for (const jitter of [0, 1]) {
      const l = L0(street([main({ jitter })]));
      const road = l.roads?.find((r) => r.id === "main");
      expect(road).toBeDefined();
      const rows = new Map<number, number[]>();
      for (const [x, y] of road?.carriageway ?? []) rows.set(x, [...(rows.get(x) ?? []), y]);
      expect(rows.size).toBe(W);
      for (const ys of rows.values()) expect([...ys].sort((a, b) => a - b)).toEqual([18, 19, 20, 21, 22, 23]);
      expect(road?.axis).toEqual([
        [0, 20],
        [39, 20],
      ]);
    }
  });
  it("lays pavement of the sidewalk's width on both sides, a quarter tile above the carriageway by default", () => {
    const l = L0(street([main()]));
    const road = l.roads?.[0];
    const ys = new Set((road?.pavement ?? []).map(([, y]) => y));
    expect([...ys].sort((a, b) => a - b)).toEqual([16, 17, 24, 25]);
    expect(road?.pavement.length).toBe(4 * W);
    expect(road?.pavementRaise).toBe(1);
    for (const [x, y] of road?.pavement ?? []) {
      expect(l.cells.height[y * W + x]).toBe(1);
      expect(l.materials[(l.cells.material[y * W + x] as number) - 1]).toBe("concrete");
    }
    for (const [x, y] of road?.carriageway ?? []) expect(l.cells.height[y * W + x]).toBe(0);
    // an explicit raise (themes without thick pavement tiles)
    const raised = L0(street([main({ sidewalk: { ...sidewalk, raise: 0.5 } })]));
    expect(raised.roads?.[0]?.pavementRaise).toBe(2);
  });
  it("kerbs run continuously along both pavements, with gaps only at crossings", () => {
    const l = L0(street([main({ crossings: [0.3, 0.8] })]));
    const road = l.roads?.[0];
    const crossing = new Set((road?.crossings ?? []).flatMap((c) => c.cells.map(key)));
    expect(road?.crossings.map((c) => [c.cells.length, c.axis])).toEqual([
      [12, "h"],
      [12, "h"],
    ]);
    const kerbs = l.kerbs ?? [];
    // every carriageway edge to pavement has a kerb unless its road cell is on a crossing
    for (const x of Array.from({ length: W }, (_, i) => i)) {
      const n = kerbs.some((k) => k.at[0] === x && k.at[1] === 18 && k.side === "N");
      const s = kerbs.some((k) => k.at[0] === x && k.at[1] === 23 && k.side === "S");
      expect(n).toBe(!crossing.has(`${x},18`));
      expect(s).toBe(!crossing.has(`${x},23`));
    }
    // kerb lines: three runs a side (two crossings)
    expect(road?.kerbLines.filter((k) => k.side === "S").length).toBe(3);
    expect(road?.kerbLines.filter((k) => k.side === "N").length).toBe(3);
    // kerb: false keeps the pavement, drops the kerb pieces
    expect(L0(street([main({ kerb: false })])).kerbs ?? []).toEqual([]);
  });
  it("merges a side street cleanly: no pavement on any carriageway, no kerb across the mouth", () => {
    const l = L0(street([main(), side]));
    const roads = l.roads ?? [];
    expect(roads.map((r) => r.id)).toEqual(["main", "side"]);
    const carriage = new Set(roads.flatMap((r) => r.carriageway.map(key)));
    for (const r of roads) for (const c of r.pavement) expect(carriage.has(key(c))).toBe(false);
    // a carriageway cell is listed once
    expect(roads.flatMap((r) => r.carriageway).length).toBe(carriage.size);
    for (const k of l.kerbs ?? []) {
      const [dx, dy] = k.side === "N" ? [0, -1] : k.side === "S" ? [0, 1] : k.side === "E" ? [1, 0] : [-1, 0];
      expect(carriage.has(`${k.at[0] + dx},${k.at[1] + dy}`)).toBe(false);
    }
    // the main road's north kerb line breaks exactly at the side street (x 19..22)
    const north = roads[0]?.kerbLines.filter((k) => k.side === "S" && k.from[1] === 17) ?? [];
    expect(north.map((k) => [k.from[0], k.to[0]])).toEqual([
      [0, 18],
      [23, 39],
    ]);
    // the block corners at the mouth are outer pavement corners
    expect(roads[0]?.corners.filter((c) => c.kind === "outer").map((c) => key(c.at))).toEqual([
      "18,17",
      "23,17",
    ]);
    // the side street runs to the board edge
    expect(roads[1]?.carriageway.some(([, y]) => y === 0)).toBe(true);
  });
  it("runs the pavement up to building fronts: no bare strip, no pavement in a building", () => {
    const l = L0(
      street([main()], {
        structures: [
          {
            id: "shop",
            name: "Shop",
            style: "modern_block",
            wings: [{ x: 4, y: 6, w: 8, h: 8 }],
          },
        ],
      }),
    );
    const pave = new Set((l.roads?.[0]?.pavement ?? []).map(key));
    // footprint y 6..13, its wall ring y 14; the band reaches y 16: y 15 is paved too
    for (let x = 4; x < 12; x++) {
      expect(pave.has(`${x},15`)).toBe(true);
      for (let y = 6; y <= 13; y++) expect(pave.has(`${x},${y}`)).toBe(false);
    }
  });
  it("the pavement runs right up to every building face: touching, alley-separated and set back", () => {
    const wing = (x: number, y: number, w: number, h: number) => [{ x, y, w, h }];
    const l = L0(
      street([main()], {
        bounds: { x: 0, y: 0, w: W, h: 36 },
        structures: [
          // two plots sharing a party wall, fronts one ring short of the pavement
          { id: "a", name: "A", style: "modern_block", wings: wing(2, 6, 6, 9), front: "S" },
          { id: "b", name: "B", style: "modern_block", wings: wing(8, 6, 6, 9), front: "S" },
          // across a two-cell alley
          { id: "c", name: "C", style: "modern_block", wings: wing(16, 6, 5, 9), front: "S" },
          // south side, set back two cells behind its ring
          { id: "d", name: "D", style: "modern_block", wings: wing(26, 28, 8, 6), front: "N" },
        ],
      }),
    );
    const w = l.bounds.w;
    const h = (x: number, y: number): number => l.cells.height[y * w + x] as number;
    const footprint = new Set((l.structures ?? []).flatMap((st) => st.cells.map(key)));
    // walking from any pavement cell toward a building face, no cell on the way is lower than the pavement
    const dips: string[] = [];
    for (const rd of l.roads ?? [])
      for (const [x, y] of rd.pavement)
        for (const [dx, dy] of [
          [0, -1],
          [1, 0],
          [0, 1],
          [-1, 0],
        ] as const) {
          const way: Array<[number, number]> = [];
          for (let k = 1; k <= 4; k++) {
            const nx = x + dx * k;
            const ny = y + dy * k;
            if (footprint.has(`${nx},${ny}`)) {
              for (const [mx, my] of way) if (h(mx, my) < h(x, y)) dips.push(`${mx},${my}`);
              break;
            }
            way.push([nx, ny]);
          }
        }
    expect(dips).toEqual([]);
    // the frontage row in front of A, B and C is pavement, or a plinth standing higher; C's ring and D's setback
    // are pavement
    const pave = new Set((l.roads?.[0]?.pavement ?? []).map(key));
    for (let x = 2; x < 21; x++) expect(pave.has(`${x},15`) || h(x, 15) > 1).toBe(true);
    for (let x = 16; x < 21; x++) expect(pave.has(`${x},15`)).toBe(true);
    // (a drawn stoop may step out onto the pavement on the street face: its cells count as frontage)
    const stoop = new Set((l.structures ?? []).flatMap((st) => (st.plinth?.cells ?? []).map(key)));
    for (let x = 26; x < 34; x++)
      for (const y of [26, 27]) expect(pave.has(`${x},${y}`) || stoop.has(`${x},${y}`)).toBe(true);
    // the alley behind its mouth stays at ground level
    expect(h(15, 10)).toBe(0);
  });
  it("generator 1 ignores the road form (the path is laid as before)", () => {
    const l = L0(street([main()], {}, 1));
    expect(l.roads).toBeUndefined();
    expect(l.cells.flags.filter((f) => (f & CELL_FLAG.PATH) !== 0).length).toBe(6 * W);
  });
  it("builds: road tiles turned along the axis, kerbs, crossing markings, walkable lip, clean verify", () => {
    const base = loadPalettes();
    // whole-cell floor tiles from the bundled palettes: a thin one (road) and a thick one (pavement)
    const flat = Object.values(base.palettes)
      .flatMap((p) => Object.entries(p.roles))
      .filter(([role]) => role.startsWith("floor."))
      .flatMap(([, r]) => r.variants)
      .filter(
        (v) =>
          v.footprint !== undefined &&
          v.footprint[0] === 1 &&
          v.footprint[1] === 1 &&
          v.geom.originAt === "minCorner" &&
          Math.abs(v.geom.size.x - 1) < 0.05 &&
          Math.abs(v.geom.size.z - 1) < 0.05,
      );
    const thin = flat.find((v) => Math.abs(v.geom.size.y - 0.25) < 0.01);
    const thick = flat.find((v) => Math.abs(v.geom.size.y - 0.5) < 0.01);
    if (!thin || !thick) throw new Error("fixture");
    const city = loadPalettes({
      user: [
        {
          source: "outdoor.json",
          data: {
            schema: "slabyrinth/palette@1",
            id: "outdoor",
            overrides: true,
            roles: {
              "floor.asphalt": { rotation: "random90", variants: [{ ...thin, name: "test road" }] },
              "floor.concrete": { variants: [{ ...thick, name: "test pavement" }] },
              "kerb.default": { mount: "half-cell", variants: [{ ...thin, name: "test kerb" }] },
              "marking.crossing": { variants: [{ ...thin, name: "test crossing" }] },
            },
          },
        },
      ],
    });
    const p = street([main({ crossings: [0.5] }), side]);
    const r = resolvePlan(p);
    const set = realize(r, city);
    const pl = set.levels[0]?.placements ?? [];
    const named = (n: string): typeof pl => pl.filter((q) => placementMeta.get(q)?.name === n);
    const l = r.levels[0] as ResolvedLevel;
    const main0 = l.roads?.[0];
    // every main-road tile has one rotation (along the axis); the side street's are a quarter turn off
    const rotOf = (x: number, y: number): number | undefined =>
      named("test road").find((q) => q.source.cell?.[0] === x && q.source.cell[1] === y)?.rot;
    const mainRots = new Set((main0?.carriageway ?? []).filter(([x]) => x < 15).map(([x, y]) => rotOf(x, y)));
    expect(mainRots.size).toBe(1);
    expect(rotOf(20, 2)).not.toBe(rotOf(5, 20));
    expect(named("test crossing").length).toBe(main0?.crossings[0]?.cells.length);
    expect(named("test kerb").length).toBeGreaterThan(60);
    expect(named("test pavement").length).toBeGreaterThan(100);
    expect(checkPlayability(p, r).filter((i) => i.severity !== "info")).toEqual([]);
    const b = compileResolved(r, city, slabCodec, { plan: p });
    expect(b.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  });
});
