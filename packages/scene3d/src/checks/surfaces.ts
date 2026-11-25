/**
 * Walking surfaces and cover, measured by vertical lines through each planned cell (a grid of samples inset from the
 * cell's sides, so wall strips at the edges are not read):
 *
 * - deck_hole: a cell planned with a floor where lines meet no floor, stair or deck piece near the planned top (a hole
 *   in a deck, ragged boards, a hull floor short of its outline);
 * - floor_over_open: a cell planned open with no floor (a hole, a well, a stairwell) where a floor piece covers it;
 * - roof_open: a cell of a roofed building where lines from the sky reach the ground storey's floor.
 * Neighbouring cells with the same fault are one finding.
 */
import type { Box3 } from "../types/index";
import { findingPiece, groundPiece, structural } from "./pieces";
import type { PlanCell } from "./plan";
import { CHECK_THRESHOLDS as T } from "./thresholds";
import type { CheckCode, CheckInput, Finding, SceneCheck, Severity } from "./types";
import { groups } from "./util";

/** The sample points of a cell (world x, z). */
function samples(c: PlanCell): Array<[number, number]> {
  const n: number = T.cellSamples;
  const out: Array<[number, number]> = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const f = (k: number): number => (n === 1 ? 0.5 : T.cellInset + ((1 - 2 * T.cellInset) * k) / (n - 1));
      out.push([c.x0 + f(i), c.z0 + f(j)]);
    }
  return out;
}

/** Neighbouring faulty cells (same level, sharing a side) as one finding each. */
function cellFindings(
  input: CheckInput,
  bad: Array<{ cell: PlanCell; share: number; pieces: number[]; low?: number; high?: number }>,
  code: CheckCode,
  severity: (share: number, n: number) => Severity,
  words: (n: number, share: number) => string,
): Finding[] {
  const key = (c: PlanCell): string => `${String(c.levelIndex)}:${String(c.cell[0])},${String(c.cell[1])}`;
  const pos = new Map(bad.map((b, k) => [key(b.cell), k]));
  const clusters = groups(bad, (k) => {
    const c = bad[k]?.cell;
    if (!c) return [];
    const out: number[] = [];
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ] as const) {
      const m = pos.get(`${String(c.levelIndex)}:${String(c.cell[0] + dx)},${String(c.cell[1] + dy)}`);
      if (m !== undefined) out.push(m);
    }
    return out;
  });
  const levels = input.scene.levels;
  return clusters.map((g) => {
    const first = g[0];
    const box: Box3 = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
    };
    for (const b of g) {
      box.min.x = Math.min(box.min.x, b.cell.x0);
      box.max.x = Math.max(box.max.x, b.cell.x0 + 1);
      box.min.z = Math.min(box.min.z, b.cell.z0);
      box.max.z = Math.max(box.max.z, b.cell.z0 + 1);
      box.min.y = Math.min(box.min.y, b.low ?? b.cell.top - 0.5);
      box.max.y = Math.max(box.max.y, b.high ?? b.cell.top);
    }
    const share = g.reduce((s, b) => s + b.share, 0) / Math.max(1, g.length);
    const pieces = [...new Set(g.flatMap((b) => b.pieces))].slice(0, 12);
    const li = first?.cell.levelIndex ?? 0;
    return {
      code,
      severity: severity(share, g.length),
      where: {
        levelId: levels[li]?.id ?? "",
        levelIndex: li,
        box,
        cells: g.map((b) => b.cell.cell),
        elementId: null,
      },
      pieces: pieces.flatMap((i) => {
        const inst = input.scene.instances[i];
        return inst ? [findingPiece(inst, i)] : [];
      }),
      measure: { cells: g.length, share: Math.round(share * 100) / 100 },
      message: words(g.length, share),
    };
  });
}

export const deckHoleCheck: SceneCheck = {
  code: "deck_hole",
  needsPlan: true,
  run(input) {
    const { scene, space, plan } = input;
    if (!plan) return [];
    const bad: Array<{ cell: PlanCell; share: number; pieces: number[] }> = [];
    for (const c of plan.cells) {
      if (!c.floor || c.link) continue;
      const ps = samples(c);
      let miss = 0;
      const near: number[] = [];
      for (const [x, z] of ps) {
        const hits = space.column(x, z, c.top - T.floorBand - 0.5, c.top + T.floorBand, (j) => {
          const o = scene.instances[j];
          return !o || !structural(o, plan);
        });
        if (hits.length === 0) miss++;
        else near.push(hits[0]?.index ?? 0);
      }
      if (miss >= T.holeSamples) bad.push({ cell: c, share: miss / ps.length, pieces: [...new Set(near)] });
    }
    return cellFindings(
      input,
      bad,
      "deck_hole",
      (share, n) => (share >= 0.66 || n > 1 ? "fault" : "warn"),
      (n, share) =>
        `${String(n)} cell(s) planned with a floor have a hole in it: ${String(Math.round(share * 100))}% of the floor is missing there`,
    );
  },
};

export const floorOverOpenCheck: SceneCheck = {
  code: "floor_over_open",
  needsPlan: true,
  run(input) {
    const { scene, space, plan } = input;
    if (!plan) return [];
    const bad: Array<{ cell: PlanCell; share: number; pieces: number[] }> = [];
    for (const c of plan.cells) {
      if (!c.open || c.floor || c.link) continue;
      const ps = samples(c);
      let hit = 0;
      const pieces: number[] = [];
      for (const [x, z] of ps) {
        const hits = space.column(x, z, c.top - T.floorBand - 0.5, c.top + T.floorBand, (j) => {
          const o = scene.instances[j];
          return !o || !groundPiece(o) || o.levelIndex !== c.levelIndex;
        });
        if (hits.length > 0) {
          hit++;
          pieces.push(hits[0]?.index ?? 0);
        }
      }
      if (hit >= T.holeSamples) bad.push({ cell: c, share: hit / ps.length, pieces: [...new Set(pieces)] });
    }
    return cellFindings(
      input,
      bad,
      "floor_over_open",
      () => "warn",
      (n) => `${String(n)} cell(s) planned open (a hole, a well, a drop) are floored over`,
    );
  },
};

export const roofOpenCheck: SceneCheck = {
  code: "roof_open",
  needsPlan: true,
  run(input) {
    const { scene, space, plan } = input;
    if (!plan) return [];
    const sky = scene.bounds.max.y + 1;
    const bad: Array<{ cell: PlanCell; share: number; pieces: number[]; low: number; high: number }> = [];
    for (const c of plan.cells) {
      if (c.roofedBy === null || !c.open) continue;
      const ps = samples(c);
      let open = 0;
      for (const [x, z] of ps) {
        const hits = space.column(x, z, c.roofedFloor + T.coverAbove, sky, (j) => {
          const o = scene.instances[j];
          return !o || !structural(o, plan);
        });
        if (hits.length === 0) open++;
      }
      if (open >= T.skySamples)
        bad.push({
          cell: c,
          share: open / ps.length,
          pieces: [],
          low: c.roofedFloor,
          high: c.roofedFloor + 2.5,
        });
    }
    return cellFindings(
      input,
      bad,
      "roof_open",
      (share, n) => (share >= 0.66 || n > 1 ? "fault" : "warn"),
      (n, share) =>
        `${String(n)} cell(s) inside a roofed building see the sky: ${String(Math.round(share * 100))}% of each is uncovered`,
    );
  },
};
