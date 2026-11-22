/**
 * The arrangement operators on synthetic pieces: exact positions and yaws (clockwise from above, x east, z north).
 */
import { describe, expect, it } from "vitest";
import {
  ARRANGE_LIMITS,
  OPERATORS,
  arcPath,
  array,
  bounds,
  extent,
  fan,
  layer,
  lengthwise,
  mirror,
  pathLength,
  pick,
  pieceCount,
  polyline,
  repeat,
  rest,
  ring,
  roundCount,
  run,
  scatter,
  single,
  sink,
  snapYaw,
  stack,
  station,
  thin,
  tier,
  transform,
  twin,
  vary,
  type Arrangement,
} from "../../../src/arrange";
import { must, poses, synthetic } from "./synthetic";

const post = synthetic("post", 0.5, 3, 0.5);
const panel = synthetic("panel", 2, 2, 0.1);
const board = synthetic("board", 0.25, 0.1, 2);
const beam = synthetic("beam", 2, 0.1, 0.1);
const plank = synthetic("plank", 1, 0.1, 0.2);
const crate = synthetic("crate", 1, 1, 1);
const cup = synthetic("cup", 0.2, 0.2, 0.2);
const stone = synthetic("stone", 0.3, 0.2, 0.3);

describe("arrangement operators", () => {
  it("snapYaw keeps turns on TaleSpire's 15° grid, 0..345", () => {
    expect([0, 7, 8, 360, -15, 405, 172.4].map(snapYaw)).toEqual([0, 0, 15, 0, 345, 45, 165]);
  });

  it("transform turns about a point clockwise from above, then moves", () => {
    const a = transform([{ ...must(single(post)[0]), x: 1 }], { turn: 90 });
    expect(poses(a)).toEqual([[0, 0, -1, 90]]);
    expect(poses(transform(single(post), { dx: 1, dy: 2, dz: 3, turn: 30 }))).toEqual([[1, 2, 3, 30]]);
  });

  it("twin: a copy turned 180° at the same centre", () => {
    expect(poses(twin(single(panel)))).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 180],
    ]);
    // back to back, a thickness apart
    expect(poses(twin(single(panel), { offset: [0, 0.1] }))[1]).toEqual([0, 0, 0.1, 180]);
  });

  it("fan: a square post rounded into a full column in 15° steps (6 copies), a long piece needs 12", () => {
    expect(roundCount(single(post))).toBe(6);
    expect(roundCount(single(plank))).toBe(12);
    const column = fan(single(post), { count: roundCount(single(post)) });
    expect(poses(column)).toEqual([0, 15, 30, 45, 60, 75].map((yaw) => [0, 0, 0, yaw]));
    // the round reaches the post's diagonal every way
    expect(extent(column, "x")).toBeCloseTo(0.5 * Math.SQRT2, 9);
    expect(extent(column, "z")).toBeCloseTo(0.5 * Math.SQRT2, 9);
  });

  it("array: boards at a pitch equal to their own width, centred on the origin", () => {
    expect(poses(array(single(board), { axis: "x", count: 4 }))).toEqual([
      [-0.375, 0, 0, 0],
      [-0.125, 0, 0, 0],
      [0.125, 0, 0, 0],
      [0.375, 0, 0, 0],
    ]);
    expect(extent(array(single(board), { axis: "x", count: 4 }), "x")).toBeCloseTo(1, 12);
    expect(poses(array(single(board), { axis: "z", count: 2, pitch: 3, centred: false }))).toEqual([
      [0, 0, 0, 0],
      [0, 0, 3, 0],
    ]);
  });

  it("crossed arrays give a mesh: 5 beams each way, 10 pieces, one way turned a quarter", () => {
    const one = array(lengthwise(beam), { axis: "z", count: 5, pitch: 0.5 });
    const mesh = [...one, ...transform(one, { turn: 90 })];
    expect(pieceCount(mesh)).toBe(10);
    expect(mesh.filter((p) => p.yaw === 0)).toHaveLength(5);
    expect(mesh.filter((p) => p.yaw === 90)).toHaveLength(5);
    expect(poses(mesh.slice(5))).toEqual([-1, -0.5, 0, 0.5, 1].map((z) => [z, 0, 0, 90]));
    const b = bounds(mesh);
    [b.min.x, b.max.x, b.min.z, b.max.z].forEach((v, i) => {
      expect(v).toBeCloseTo(i % 2 === 0 ? -1.05 : 1.05, 12);
    });
  });

  it("run: planks around a 90° corner, the stretches closing the outer corner by half a width", () => {
    const path = polyline([
      [0, 0],
      [3, 0],
      [3, -2],
    ]);
    const out = run(lengthwise(plank), { path, overlap: 0 });
    expect(poses(out)).toEqual([
      [0.5, 0, 0, 0],
      [1.2, 0, 0, 0],
      [1.9, 0, 0, 0],
      [2.6, 0, 0, 0],
      [3, 0, -0.4, 90],
      [3, 0, -0.95, 90],
      [3, 0, -1.5, 90],
    ]);
    // the outer corner (3.1, 0.1) is covered by the first run's last plank
    const lastEast = bounds([must(out[3])]);
    expect(lastEast.max.x).toBeCloseTo(3.1, 12);
  });

  it("run: the step is the module's measured length less the overlap, rounded up to cover the stretch", () => {
    // a piece listed with its long side on z still runs lengthwise
    const zPlank = synthetic("zplank", 0.2, 0.1, 1);
    expect(must(lengthwise(zPlank)[0]).yaw).toBe(90);
    const out = run(lengthwise(zPlank), {
      path: polyline([
        [0, 0],
        [5, 0],
      ]),
      overlap: 0.1,
    });
    // 5 tiles at a step of at most 0.9: ceil(4 / 0.9) + 1 = 6 planks, 0.8 apart (overlap 20%)
    expect(out.map((p) => Math.round(p.x * 1e9) / 1e9)).toEqual([0.5, 1.3, 2.1, 2.9, 3.7, 4.5]);
    expect(out.every((p) => p.yaw === 90)).toBe(true);
  });

  it("run: a filler at each inner corner, turned with the stretch it ends", () => {
    const path = polyline([
      [0, 0],
      [2, 0],
      [2, -2],
    ]);
    const out = run(lengthwise(plank), { path, overlap: 0, filler: single(post) });
    const posts = out.filter((p) => p.piece === post);
    expect(poses(posts)).toEqual([[2, 0, 0, 0]]);
    // with a filler the stretches are not extended: two planks each, ending at the corner
    expect(poses(out.filter((p) => p.piece === plank))).toEqual([
      [0.5, 0, 0, 0],
      [1.5, 0, 0, 0],
      [2, 0, -0.5, 90],
      [2, 0, -1.5, 90],
    ]);
  });

  it("run along an arc: one plank per 15° facet, each tangent to the circle and turned 15° from the last", () => {
    const path = arcPath({ radius: 3, from: 0, sweep: 90 });
    const out = run(lengthwise(plank), { path, overlap: 0 });
    expect(out).toHaveLength(7);
    out.forEach((p, i) => {
      const t = (15 * i * Math.PI) / 180;
      expect(p.x).toBeCloseTo(3 * Math.cos(t), 9);
      expect(p.z).toBeCloseTo(-3 * Math.sin(t), 9);
      expect(p.yaw).toBe(90 + 15 * i);
    });
    // the polygon of facets reaches half a facet past either end
    expect(pathLength(path)).toBeCloseTo(7 * 6 * Math.tan((7.5 * Math.PI) / 180), 9);
  });

  it("stack: courses one height apart", () => {
    expect(poses(stack(single(synthetic("course", 1, 0.5, 1)), { count: 3 })).map((p) => p[1])).toEqual([
      0, 0.5, 1,
    ]);
  });

  it("layer: a second skin proud of the first, shifted half a module", () => {
    const wall = single(panel);
    expect(poses(layer(wall, { normal: "z", proud: 0.05, shift: extent(wall, "x") / 2 }))).toEqual([
      [0, 0, 0, 0],
      [1, 0, 0.05, 0],
    ]);
    expect(poses(layer(wall, { normal: "x", proud: -0.1 }))[1]).toEqual([-0.1, 0, 0, 0]);
  });

  it("ring: copies round a point, each turned to face out", () => {
    expect(poses(ring(single(stone), { count: 4, radius: 2 }))).toEqual([
      [2, 0, 0, 0],
      [0, 0, -2, 90],
      [-2, 0, 0, 180],
      [0, 0, 2, 270],
    ]);
    // an angle off the grid places exactly and snaps the turn
    const seven = ring(single(stone), { count: 7, radius: 1 });
    expect(must(seven[1]).x).toBeCloseTo(Math.cos((2 * Math.PI) / 7), 9);
    expect(must(seven[1]).yaw).toBe(45);
  });

  it("rest: on the top surface of what is under it, as one or piece by piece", () => {
    const table = single(crate);
    expect(poses(rest(single(cup), table))[1]).toEqual([0, 1, 0, 0]);
    const off = transform(single(cup), { dx: 3 });
    expect(poses(rest([...single(cup), ...off], table, { each: true })).slice(1)).toEqual([
      [0, 1, 0, 0],
      [3, 0, 0, 0],
    ]);
    // as one, both lift with the highest support
    expect(
      poses(rest([...single(cup), ...off], table))
        .slice(1)
        .map((p) => p[1]),
    ).toEqual([1, 1]);
    const stacked = rest(single(crate), rest(single(crate), single(crate)));
    expect(stacked.map((p) => p.y)).toEqual([0, 1, 2]);
  });

  it("sink: lowered by a share of its own height", () => {
    expect(poses(sink(single(crate), { fraction: 0.4 }))).toEqual([[0, -0.4, 0, 0]]);
  });

  it("mirror: positions reflected, each piece re-turned (never scaled)", () => {
    const a: Arrangement = [{ ...must(single(plank, 30)[0]), x: 2, z: 1 }];
    expect(poses(mirror(a, { axis: "x" }))).toEqual([
      [2, 0, 1, 30],
      [-2, 0, 1, 150],
    ]);
    expect(poses(mirror(a, { axis: "z", at: 0.5, keep: false }))).toEqual([[2, 0, 0, 330]]);
  });

  it("station: a kit every 2 tiles along an edge, mirrored on the far side", () => {
    const kit = single(stone);
    const out = station(kit, {
      path: polyline([
        [0, 0],
        [6, 0],
      ]),
      every: 2,
      offset: 1,
      mirrored: true,
    });
    expect(poses(out)).toEqual([
      [1, 0, 1, 0],
      [1, 0, -1, 0],
      [3, 0, 1, 0],
      [3, 0, -1, 0],
      [5, 0, 1, 0],
      [5, 0, -1, 0],
    ]);
    // turned with the path: heading south, "left" is east
    const south = station(kit, {
      path: polyline([
        [0, 0],
        [0, -4],
      ]),
      every: 4,
      offset: 1,
    });
    expect(poses(south)).toEqual([[1, 0, -2, 90]]);
  });

  it("scatter: deterministic, inside its area, spaced, emptied and biased as asked", () => {
    const candidates = [...single(stone), ...single(cup)];
    const base = { area: { w: 10, d: 6 }, density: 2, minSpacing: 0.4, seed: "s1" } as const;
    const a = scatter(candidates, base);
    expect(poses(scatter(candidates, base))).toEqual(poses(a));
    expect(poses(scatter(candidates, { ...base, seed: "s2" }))).not.toEqual(poses(a));
    expect(a.length).toBeGreaterThan(40);
    expect(a.every((p) => Math.abs(p.x) <= 5 && Math.abs(p.z) <= 3)).toBe(true);
    for (const [i, p] of a.entries())
      for (const q of a.slice(i + 1)) expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeGreaterThanOrEqual(0.4);
    expect(a.every((p) => p.yaw % 15 === 0)).toBe(true);
    expect(new Set(a.map((p) => p.piece))).toEqual(new Set([stone, cup]));
    expect(scatter(candidates, { ...base, empty: 1 })).toEqual([]);
    const half = scatter(candidates, { ...base, empty: 0.5, minSpacing: 0 });
    const full = scatter(candidates, { ...base, minSpacing: 0 });
    expect(half.length / full.length).toBeGreaterThan(0.35);
    expect(half.length / full.length).toBeLessThan(0.65);
    // edge bias: mean distance from the edge falls when the edge is favoured
    const depth = (xs: Arrangement): number =>
      xs.reduce((n, p) => n + Math.min(5 - Math.abs(p.x), 3 - Math.abs(p.z)), 0) / xs.length;
    const rim = scatter(candidates, { ...base, minSpacing: 0, edgeBias: 1, seed: "e" });
    const core = scatter(candidates, { ...base, minSpacing: 0, edgeBias: -1, seed: "e" });
    expect(depth(rim)).toBeLessThan(depth(core));
    // no turn off the candidate's own
    expect(scatter(candidates, { ...base, yawJitter: 0 }).every((p) => p.yaw === 0)).toBe(true);
    // a polygon area
    const tri = scatter(candidates, {
      area: {
        polygon: [
          [0, 0],
          [4, 0],
          [0, -4],
        ],
      },
      density: 4,
      seed: 1,
    });
    expect(tri.length).toBeGreaterThan(5);
    expect(tri.every((p) => p.x >= 0 && p.z <= 0 && p.x - p.z <= 4)).toBe(true);
  });

  it("thin: a deterministic choice of at most the cap, finest tier first, in the original order", () => {
    const row = array(single(stone), { axis: "x", count: 10 });
    const kept = thin(row, { cap: 3, seed: "k" });
    expect(kept).toHaveLength(3);
    expect(thin(row, { cap: 3, seed: "k" })).toEqual(kept);
    expect(kept.map((p) => row.indexOf(p))).toEqual(
      [...kept.map((p) => row.indexOf(p))].sort((a, b) => a - b),
    );
    expect(thin(row, { cap: 20, seed: "k" })).toBe(row);
    // tier 3 detail goes before tier 0, whatever the draw
    const mixed = [...tier(row.slice(0, 5), { tier: 3 }), ...row.slice(5)];
    expect(thin(mixed, { cap: 5, seed: "k" }).every((p) => p.tier === undefined)).toBe(true);
    expect(thin(mixed, { cap: 7, seed: "k" }).filter((p) => p.tier === 3)).toHaveLength(2);
    expect(ARRANGE_LIMITS.piecesPerLevel).toBeGreaterThan(ARRANGE_LIMITS.piecesPerInstance);
  });

  it("repeat: a count, or a length filled with the last copy pulled back flush", () => {
    // 5 tiles of 1-wide boards at a 0.9 pitch: ceil(4 / 0.9) + 1 = 6, the last at 4 (its far end at 5)
    const filled = repeat(single(synthetic("slat", 1, 0.1, 0.2)), { axis: "x", pitch: 0.9, length: 5 });
    expect(filled.map((p) => Math.round(p.x * 1e9) / 1e9)).toEqual([0, 0.9, 1.8, 2.7, 3.6, 4]);
    expect(bounds(filled).max.x).toBeCloseTo(4.5, 12);
    expect(poses(repeat(single(crate), { axis: "y", count: 2 })).map((p) => p[1])).toEqual([0, 1]);
    // a stair of copies by a step vector
    expect(poses(repeat(single(crate), { axis: [1, 0.25, 0], count: 3 }))).toEqual([
      [0, 0, 0, 0],
      [1, 0.25, 0, 0],
      [2, 0.5, 0, 0],
    ]);
  });

  it("ring facing: out, to the centre, along the circle, or kept", () => {
    const at = (facing: "out" | "centre" | "tangent" | "keep"): number[] =>
      ring(single(stone), { count: 4, radius: 2, facing }).map((p) => p.yaw);
    expect(at("out")).toEqual([0, 90, 180, 270]);
    expect(at("centre")).toEqual([180, 270, 0, 90]);
    expect(at("tangent")).toEqual([90, 180, 270, 0]);
    expect(at("keep")).toEqual([0, 0, 0, 0]);
  });

  it("layer rises a course; rest hangs from an underside; scatter keeps a lane clear", () => {
    expect(poses(layer(single(panel), { normal: "z", proud: 0.02, rise: 0.5 }))[1]).toEqual([
      0, 0.5, 0.02, 0,
    ]);
    const beamOver = transform(lengthwise(beam), { dy: 2.5 });
    // the cup hangs with its top at the beam's underside (2.5)
    expect(poses(rest(single(cup), beamOver, { under: true }))[1]).toEqual([0, 2.3, 0, 0]);
    expect(poses(rest(single(cup), beamOver, { under: true, each: true }))[1]).toEqual([0, 2.3, 0, 0]);
    const lane = scatter(single(stone), {
      area: { w: 8, d: 8 },
      density: 3,
      seed: "lane",
      exclude: (x) => Math.abs(x) < 1,
    });
    expect(lane.length).toBeGreaterThan(20);
    expect(lane.every((p) => Math.abs(p.x) >= 1)).toBe(true);
  });

  it("vary: hash-named imperfection, gaps never two in a row", () => {
    const row = array(lengthwise(plank), { axis: "x", count: 40 });
    const params = {
      seed: "v",
      along: 0.1,
      across: 0.05,
      height: 0.02,
      yaw: 15,
      flip: 0.3,
      empty: 0.4,
    } as const;
    const a = vary(row, params);
    expect(poses(vary(row, params))).toEqual(poses(a));
    expect(a.length).toBeLessThan(40);
    expect(a.length).toBeGreaterThanOrEqual(20);
    // a gap is one place wide at most: the kept pieces' original slots never skip two
    const slots = a.map((p) => Math.round(p.x + 19.5));
    expect(slots.every((s, i) => i === 0 || s - (slots[i - 1] ?? s) <= 2)).toBe(true);
    for (const p of a) expect(p.yaw % 15).toBe(0);
    expect(a.some((p) => p.yaw === 180 || p.yaw === 165 || p.yaw === 195)).toBe(true);
  });

  it("pick: one piece, a mix without long runs, an odd one out, or by height", () => {
    const row = array(single(stone), { axis: "x", count: 30 });
    const from = [stone, cup, crate];
    const same = pick(row, { from, policy: { kind: "same" }, seed: 1 });
    expect(new Set(same.map((p) => p.piece)).size).toBe(1);
    const mix = pick(row, { from, policy: { kind: "mix", noRun: 2 }, seed: 1 });
    const ids = mix.map((p) => from.indexOf(p.piece));
    expect(ids.every((id, i) => i < 2 || !(id === ids[i - 1] && id === ids[i - 2]))).toBe(true);
    const odd = pick(row, { from, policy: { kind: "odd", rate: 0.2 }, seed: 1 });
    const others = odd.filter((p) => p.piece !== stone).length;
    expect(others).toBeGreaterThan(0);
    expect(others).toBeLessThan(15);
    const courses = stack(single(crate), { count: 4 });
    const byHeight = pick(courses, {
      from: [crate, stone],
      policy: { kind: "byHeight", split: 0.5 },
      seed: 1,
    });
    expect(byHeight.map((p) => p.piece)).toEqual([crate, crate, stone, stone]);
    // a candidate long on the other axis is turned a quarter more, so the run stays a run
    const zPlank = synthetic("zplank2", 0.2, 0.1, 1);
    expect(must(pick(lengthwise(plank), { from: [zPlank], policy: { kind: "same" }, seed: 1 })[0]).yaw).toBe(
      90,
    );
  });

  it("the operators compose: a ring of twinned panels rested on a sunk block", () => {
    const base = sink(single(crate), { fraction: 0.25 });
    const out = rest(ring(twin(single(cup)), { count: 3, radius: 0.3 }), base);
    expect(out).toHaveLength(7);
    expect(out.slice(1).every((p) => Math.abs(p.y - 0.75) < 1e-12)).toBe(true);
  });

  it("the operator table names every operator", () => {
    expect(Object.keys(OPERATORS).sort()).toEqual([
      "array",
      "fan",
      "layer",
      "mirror",
      "pick",
      "repeat",
      "rest",
      "ring",
      "run",
      "scatter",
      "sink",
      "stack",
      "station",
      "thin",
      "tier",
      "transform",
      "twin",
      "vary",
    ]);
  });
});
