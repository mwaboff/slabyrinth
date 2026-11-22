/**
 * Neighbouring buildings and areas, as the review's street notes group them (tone clusters, alike roofs, alike
 * facades) and as the detail recipes keep neighbours' treatments apart (resolve/recipes/treatments.ts): the one place
 * their footprint boxes, the gap between two of them and the groups of neighbours sharing a key are worked out.
 */
import type { Vec2 } from "../contracts/plan";
import type { ResolvedStructure } from "../contracts/resolved";
import { maxOf, minOf } from "../util/lists";

/** A box of cells (inclusive). */
export interface CellBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The box of a set of cells (inclusive). */
export const cellsBox = (cells: readonly Vec2[]): CellBox => {
  const xs = cells.map((p) => p[0]);
  const ys = cells.map((p) => p[1]);
  return { x0: minOf(xs), y0: minOf(ys), x1: maxOf(xs), y1: maxOf(ys) };
};

/** A structure's footprint box (inclusive cells). */
export const boxOf = (s: ResolvedStructure): CellBox => cellsBox(s.cells);

/** Cells between two boxes (0 when they touch or overlap). */
export const boxGap = (ba: CellBox, bb: CellBox): number => {
  const gx = Math.max(0, Math.max(ba.x0, bb.x0) - Math.min(ba.x1, bb.x1) - 1);
  const gy = Math.max(0, Math.max(ba.y0, bb.y0) - Math.min(ba.y1, bb.y1) - 1);
  return Math.max(gx, gy);
};

/** Cells between two structures' footprint boxes (0 when they touch or overlap). */
export const gapBetween = (a: ResolvedStructure, b: ResolvedStructure): number => boxGap(boxOf(a), boxOf(b));

/** Groups of neighbouring buildings (footprints within `gap` cells, chained) that share a key. */
export function neighbourGroups(
  bs: readonly ResolvedStructure[],
  gap: number,
  key: (s: ResolvedStructure) => string | undefined,
): ResolvedStructure[][] {
  const seen = new Set<string>();
  const out: ResolvedStructure[][] = [];
  for (const b of bs) {
    const k = key(b);
    if (k === undefined || seen.has(b.id)) continue;
    const group = [b];
    seen.add(b.id);
    for (let i = 0; i < group.length; i++)
      for (const o of bs)
        if (!seen.has(o.id) && key(o) === k && gapBetween(group[i] as ResolvedStructure, o) <= gap) {
          seen.add(o.id);
          group.push(o);
        }
    if (group.length > 1) out.push(group);
  }
  return out;
}

/** The mean cell of a group of structures. */
export const centreOf = (g: readonly ResolvedStructure[]): Vec2 => {
  const cs = g.flatMap((s) => s.cells);
  return [cs.reduce((t, p) => t + p[0], 0) / cs.length, cs.reduce((t, p) => t + p[1], 0) / cs.length];
};
