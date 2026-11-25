/**
 * Clashing pieces: two pieces of different plan elements whose real meshes run into each other. Each piece's volume is
 * measured in vertical columns (`clashStep` apart): in each column the span from its lowest to its highest surface.
 * Two pieces clash where those spans overlap by more than `clashShare` of the smaller piece's own volume (and more
 * than `clashVolume`). Pairs come from the space's hash (boxes that meet), never every pair.
 *
 * Known nestings are not clashes: structure against structure (walls meet at corners, floors under walls), anything on
 * ground (sunk measures that), parts of one element (an assembled tree), a hollow shell round what stands in it,
 * organic dressing (plants and rocks grow into things) and flat cover (a chest on a rug).
 */
import type { SceneInstance } from "../types/index";
import { findingPiece, flatCover, groundPiece, organic, shellPiece, structural } from "./pieces";
import type { SceneSpace } from "./space";
import { CHECK_THRESHOLDS as T } from "./thresholds";
import type { Finding, SceneCheck } from "./types";
import { r2 } from "./util";

/** A piece's span in the column through (x, z), or null. */
function span(space: SceneSpace, i: number, x: number, z: number): [number, number] | null {
  const hs = space.heightsOf(i, x, z);
  if (hs.length < 2) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of hs) {
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  return hi - lo > 1e-6 ? [lo, hi] : null;
}

/** Column volume of piece i over a plan rectangle. */
function volume(space: SceneSpace, i: number, x0: number, x1: number, z0: number, z1: number): number {
  const s = T.clashStep;
  let v = 0;
  for (let x = x0 + s / 2; x < x1; x += s)
    for (let z = z0 + s / 2; z < z1; z += s) {
      const p = span(space, i, x, z);
      if (p) v += (p[1] - p[0]) * s * s;
    }
  return v;
}

export const clashCheck: SceneCheck = {
  code: "clash",
  needsPlan: false,
  run({ scene, space, plan }) {
    const out: Finding[] = [];
    const own = new Map<number, number>();
    const ownVolume = (i: number): number => {
      let v = own.get(i);
      if (v === undefined) {
        const b = space.boxes[i];
        v = b ? volume(space, i, b.min.x, b.max.x, b.min.z, b.max.z) : 0;
        own.set(i, v);
      }
      return v;
    };
    // cover the plan sets into the ground (layered ground's rocks gathered at a wall's foot) nests by design too
    const cover = (p: SceneInstance): boolean =>
      p.elementId !== null && (plan?.sunkByPlan.has(p.elementId) ?? false);
    const exempt = (p: SceneInstance): boolean =>
      p.role === "marker" || groundPiece(p) || shellPiece(p) || organic(p, plan) || flatCover(p) || cover(p);
    scene.instances.forEach((a, i) => {
      if (exempt(a)) return;
      const aStruct = structural(a, plan);
      for (const j of space.overlapping(a.aabb)) {
        if (j <= i) continue;
        const b = scene.instances[j];
        if (!b || exempt(b)) continue;
        if (aStruct && structural(b, plan)) continue;
        if (a.elementId !== null && a.elementId === b.elementId) continue;
        const x0 = Math.max(a.aabb.min.x, b.aabb.min.x);
        const x1 = Math.min(a.aabb.max.x, b.aabb.max.x);
        const z0 = Math.max(a.aabb.min.z, b.aabb.min.z);
        const z1 = Math.min(a.aabb.max.z, b.aabb.max.z);
        if (x1 - x0 < T.clashStep / 2 || z1 - z0 < T.clashStep / 2) continue;
        const s = T.clashStep;
        let v = 0;
        for (let x = x0 + s / 2; x < x1; x += s)
          for (let z = z0 + s / 2; z < z1; z += s) {
            const p = span(space, i, x, z);
            if (!p) continue;
            const q = span(space, j, x, z);
            if (!q) continue;
            const d = Math.min(p[1], q[1]) - Math.max(p[0], q[0]);
            if (d > 0) v += d * s * s;
          }
        if (v < T.clashVolume) continue;
        const smaller = Math.min(ownVolume(i), ownVolume(j));
        const share = smaller > 0 ? v / smaller : 0;
        if (share < T.clashShare) continue;
        const box = {
          min: { x: x0, y: Math.max(a.aabb.min.y, b.aabb.min.y), z: z0 },
          max: { x: x1, y: Math.min(a.aabb.max.y, b.aabb.max.y), z: z1 },
        };
        out.push({
          code: "clash",
          severity: share >= T.clashFault ? "fault" : "warn",
          where: {
            levelId: a.levelId,
            levelIndex: a.levelIndex,
            box,
            cells: [a.cell, b.cell].filter((c): c is readonly [number, number] => c !== null),
            elementId: a.elementId ?? b.elementId,
          },
          pieces: [findingPiece(a, i), findingPiece(b, j)],
          measure: { share: r2(share), volume: r2(v) },
          message: `${a.name} and ${b.name} run into each other: ${String(Math.round(share * 100))}% of the smaller is inside the other`,
        });
      }
    });
    return out;
  },
};
