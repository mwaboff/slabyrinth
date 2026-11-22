/**
 * Multi-chunk builds pasted from beside the map (switch pasteBesideMap, compile/chunk.ts besideMapBox). TaleSpire
 * pastes a slab at the centre of its box; a chunk whose placement ray lands on a piece an earlier chunk placed sits
 * about half a tile high, and so does every chunk after it. With the cursor on bare ground four cells beside the map
 * every chunk landed level (both measured in game 2026-11-21).
 *
 * These tests read the chunks as TaleSpire gets them (decoded slabs) and judge them by their own arithmetic: the box
 * from the decoded pillars, the anchor cell from its centre, each piece's footprint from the realized set.
 */
import { describe, expect, it } from "vitest";
import type { ExportBundle, PlacementSet, SlabAsset } from "../../../src/contracts/compiler";
import { chunkAndEncode, compileResolved, realize } from "../../../src/compile";
import type { RealizedSet } from "../../../src/compile/realize/output";
import { loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import { SLAB_LIMITS, decodeDetailed, slabCodec } from "../../../src/slab";
import { loadPlan, type StoredPlan } from "../../fixtures";
import { handLevel, handPlan } from "./handResolved";

const cat = loadPalettes();
const marker = cat.palettes["generic"]?.roles["marker.alignment"]?.variants[0]?.asset ?? "";
const T = 100; // stored units per tile
const CLEARANCE = 4; // empty cells between the anchor cell and anything placed (the passing in-game test)

/** A dense hand-made level: walls, floor and many props. */
function denseLevel(id: string, w: number, h: number, elevation = 0): ReturnType<typeof handLevel> {
  const rows = [
    "#".repeat(w + 2),
    ...Array.from(
      { length: h },
      (_, y) =>
        "#" + Array.from({ length: w }, (_, x) => ((x * 7 + y * 3) % 11 === 0 ? "2" : ".")).join("") + "#",
    ),
    "#".repeat(w + 2),
  ];
  const features = Array.from({ length: 60 }, (_, i) => ({
    id: `f${i}`,
    type: (["chest", "barrel", "crate", "statue"] as const)[i % 4] ?? "chest",
    at: [1 + ((i * 5) % w), 1 + ((i * 3) % h)] as [number, number],
    baseHeight: elevation + 0.5,
  }));
  return handLevel({ id, rows, elevation, features });
}

/** Two stacked dense levels, realized at the given generator. */
function denseSet(generator: number, w = 80, h = 60): RealizedSet {
  return realize({ ...handPlan([denseLevel("lo", w, h), denseLevel("up", w, h, 2.5)]), generator }, cat);
}

function fixtureSet(name: StoredPlan): RealizedSet {
  return realize(resolvePlan(loadPlan(name), cat), cat, {});
}

type Key = Pick<SlabAsset, "uuid" | "sx" | "sy" | "sz" | "rot">;
const keyOf = (a: Key): string => `${a.uuid}|${a.sx}|${a.sy}|${a.sz}|${a.rot}`;
interface Span {
  x: [number, number];
  z: [number, number];
}
const counts = (keys: readonly string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
};
const overlaps = (a: Span, b: Span): boolean =>
  a.x[0] < b.x[1] - 0.5 && a.x[1] > b.x[0] + 0.5 && a.z[0] < b.z[1] - 0.5 && a.z[1] > b.z[0] + 0.5;

/** What the chunks of a multi-chunk build look like to the paste. */
function readBundle(set: PlacementSet, bundle: ExportBundle) {
  const decoded = bundle.chunks.map((c) => decodeDetailed(c.slab).assets);
  // the alignment pillars: the marker pieces every chunk carries at the same spot (the map may use the asset too)
  const markerKeys = decoded.map((as) => new Set(as.filter((a) => a.uuid === marker).map(keyOf)));
  const pillarKeys = [...(markerKeys[0] ?? [])].filter((k) => markerKeys.every((s) => s.has(k)));
  const pillars = (decoded[0] ?? []).filter((a) => pillarKeys.includes(keyOf(a)));
  const content = decoded.map((as) => {
    const left = counts(pillarKeys);
    return as.filter((a) => {
      const n = left.get(keyOf(a)) ?? 0;
      if (n > 0) left.set(keyOf(a), n - 1);
      return n === 0;
    });
  });
  // the pillar is 1x1 with its pivot at its min corner: the box runs from the min pillar to the far side of the max one
  const box: Span = {
    x: [Math.min(...pillars.map((a) => a.sx)), Math.max(...pillars.map((a) => a.sx)) + T],
    z: [Math.min(...pillars.map((a) => a.sz)), Math.max(...pillars.map((a) => a.sz)) + T],
  };
  const centre = { x: (box.x[0] + box.x[1]) / 2, z: (box.z[0] + box.z[1]) / 2 };
  const cell = { x: Math.floor(centre.x / T) * T, z: Math.floor(centre.z / T) * T };
  const zone: Span = {
    x: [cell.x - CLEARANCE * T, cell.x + (1 + CLEARANCE) * T],
    z: [cell.z - CLEARANCE * T, cell.z + (1 + CLEARANCE) * T],
  };
  // the stored offset (whole tiles on x and z, quarters in height), read from the chunks: the lowest pivot of the
  // content against the lowest placement pivot
  const q = (v: number): number => Math.round(v * 4) / 4;
  const all = set.levels.flatMap((l) => l.placements);
  const flat = content.flat();
  const off = {
    x: q(Math.min(...all.map((p) => p.x)) - Math.min(...flat.map((a) => a.sx)) / T),
    y: q(Math.min(...all.map((p) => p.y)) - Math.min(...flat.map((a) => a.sy)) / T),
    z: q(Math.min(...all.map((p) => p.z)) - Math.min(...flat.map((a) => a.sz)) / T),
  };
  const stored = all.map((p) => {
    const b = set.placed?.get(p)?.box ?? { min: p, max: p };
    const span: Span = {
      x: [(Math.min(b.min.x, p.x) - off.x) * T, (Math.max(b.max.x, p.x) - off.x) * T],
      z: [(Math.min(b.min.z, p.z) - off.z) * T, (Math.max(b.max.z, p.z) - off.z) * T],
    };
    const key = keyOf({
      uuid: p.asset,
      sx: slabCodec.toScaled(p.x - off.x),
      sy: slabCodec.toScaled(p.y - off.y),
      sz: slabCodec.toScaled(p.z - off.z),
      rot: slabCodec.degreesToRot(p.rot),
    });
    return { key, span };
  });
  const map: Span = {
    x: [Math.min(...stored.map((s) => s.span.x[0])), Math.max(...stored.map((s) => s.span.x[1]))],
    z: [Math.min(...stored.map((s) => s.span.z[0])), Math.max(...stored.map((s) => s.span.z[1]))],
  };
  return { decoded, pillars, content, box, centre, cell, zone, stored, map };
}

/** The rule, judged from the decoded chunks: what every multi-chunk build of a beside-the-map generator must hold. */
function expectPastedBeside(set: PlacementSet, bundle: ExportBundle): void {
  expect(bundle.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(bundle.chunks.length).toBeGreaterThan(1);
  const r = readBundle(set, bundle);
  // one shared box: the same two pillars in every chunk, and no more alignment pieces than that
  expect(r.pillars).toHaveLength(2);
  // its centre is in the middle of a cell, outside the map's footprint (south of it)
  expect(r.centre.x % T).toBe(T / 2);
  expect(r.centre.z % T).toBe(T / 2);
  expect(r.centre.z).toBeLessThan(r.map.z[0]);
  expect(r.centre.x).toBeGreaterThan(r.map.x[0]);
  expect(r.centre.x).toBeLessThan(r.map.x[1]);
  // nothing any chunk places, of any kind and on any level, comes within the clearance of the anchor cell
  for (const s of r.stored) expect(overlaps(s.span, r.zone), s.key).toBe(false);
  expect(r.map.z[0] - (r.cell.z + T)).toBeGreaterThanOrEqual(CLEARANCE * T);
  // nor do the pillars
  for (const a of r.pillars)
    expect(overlaps({ x: [a.sx, a.sx + T], z: [a.sz, a.sz + T] }, r.zone)).toBe(false);
  // the union of the chunks is the unchunked set; no chunk is empty; every chunk is under the cap and in range
  const union = counts(r.content.flat().map(keyOf));
  expect([...union].sort()).toEqual([...counts(r.stored.map((s) => s.key))].sort());
  for (const [i, c] of bundle.chunks.entries()) {
    expect(r.content[i]?.length).toBeGreaterThan(0);
    expect(c.compressedBytes).toBeLessThanOrEqual(SLAB_LIMITS.maxCompressedBytes);
    for (const a of r.decoded[i] ?? [])
      expect(Math.max(a.sx, a.sy, a.sz)).toBeLessThanOrEqual(SLAB_LIMITS.maxCoord);
  }
  // the bundle says where the cursor goes and where the far pillar stands
  expect(bundle.pasteAnchor).toEqual({
    side: "south",
    clearanceCells: CLEARANCE,
    // empty cells between the far pillar and the map's south edge (whole cells)
    farMarkerCells: (Math.floor(r.map.z[0] / T) * T - (r.box.z[0] + T)) / T,
  });
  expect(bundle.instructions).toMatch(/bare cell 5 cells south of the middle of the map/);
}

describe("multi-chunk builds are pasted from bare ground beside the map (pasteBesideMap)", () => {
  it("a dense synthetic two-level build cut into many chunks", () => {
    const set = denseSet(4);
    const b = chunkAndEncode(set, slabCodec, { fill: 0.1, createdAt: "t" });
    expect(b.chunks.length).toBeGreaterThanOrEqual(4);
    expectPastedBeside(set, b);
  });

  it("odd and even map widths and depths all put the anchor mid-cell", () => {
    for (const [w, h] of [
      [40, 30],
      [41, 30],
      [40, 31],
      [41, 31],
    ] as const) {
      const set = denseSet(4, w, h);
      expectPastedBeside(set, chunkAndEncode(set, slabCodec, { fill: 0.05, createdAt: "t" }));
    }
  });

  it.each(["keep-dungeon-v8", "market-street-v3", "inn-interior-v1", "smugglers-grotto-v3"] as const)(
    "the %s fixture, cut into chunks",
    (name) => {
      const set = fixtureSet(name);
      expectPastedBeside(set, chunkAndEncode(set, slabCodec, { fill: 0.1, createdAt: "t" }));
    },
  );

  it('"always" alignment and per-level grouping are pasted from beside the map too', () => {
    const set = denseSet(4);
    expectPastedBeside(
      set,
      chunkAndEncode(set, slabCodec, { fill: 0.1, alignment: "always", createdAt: "t" }),
    );
    expectPastedBeside(set, chunkAndEncode(set, slabCodec, { grouping: "per-level", createdAt: "t" }));
  });

  it("levels laid side by side: the anchor is south of everything, with the clearance to every pivot", () => {
    const set = denseSet(4);
    const b = chunkAndEncode(set, slabCodec, { fill: 0.1, levelLayout: "side_by_side", createdAt: "t" });
    expect(b.chunks.length).toBeGreaterThan(1);
    const r = readBundle(set, b);
    expect(r.centre.x % T).toBe(T / 2);
    expect(r.centre.z % T).toBe(T / 2);
    const lowest = Math.min(...r.content.flat().map((a) => a.sz));
    expect(lowest - (r.cell.z + T)).toBeGreaterThanOrEqual(CLEARANCE * T);
  });

  it("generators before 4 are unchanged: the anchor is inside the map", () => {
    const set = denseSet(1);
    const b = chunkAndEncode(set, slabCodec, { fill: 0.1, createdAt: "t" });
    const r = readBundle(set, b);
    expect(r.centre.z).toBeGreaterThan(r.map.z[0]);
    expect(b.pasteAnchor).toBeUndefined();
  });

  it("a one-chunk build is byte-identical with and without the switch", () => {
    for (const name of ["keep-dungeon-v8", "market-street-v3"] as const) {
      const set = fixtureSet(name);
      const on = chunkAndEncode(set, slabCodec, { createdAt: "t" });
      const off = chunkAndEncode({ ...set, facts: undefined } as unknown as PlacementSet, slabCodec, {
        createdAt: "t",
      });
      expect(on.chunks).toHaveLength(1);
      expect(on).toEqual(off);
      expect(on.pasteAnchor).toBeUndefined();
    }
  });

  it("compile reads the switch from the plan's generator", () => {
    const plan = loadPlan("keep-dungeon-v8");
    const b = compileResolved(resolvePlan(plan, cat), cat, slabCodec, { fill: 0.1, createdAt: "t", plan });
    expect(b.pasteAnchor?.side).toBe("south");
  });
});
