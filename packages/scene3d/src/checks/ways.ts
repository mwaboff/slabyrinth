/**
 * Blocked ways: every passage the plan makes through a wall (a door, an arch, a gap) is crossed by short horizontal
 * rays every `runStep` along it and every `wayStep` up to a walker's height. The door's own leaf and frame do not
 * count (a door opens); anything else a ray meets (a wall piece, a beam, a prop) closes that point. A passage whose
 * widest clear stretch is narrower than a walker, or whose clear height is lower, is blocked.
 */
import { findingPiece } from "./pieces";
import { CHECK_THRESHOLDS as T } from "./thresholds";
import type { Finding, SceneCheck } from "./types";
import { r2, tiles } from "./util";

export const wayBlockedCheck: SceneCheck = {
  code: "way_blocked",
  needsPlan: true,
  run({ scene, space, plan }) {
    if (!plan) return [];
    const out: Finding[] = [];
    for (const p of plan.passages) {
      const dx = p.b.x - p.a.x;
      const dz = p.b.z - p.a.z;
      const length = Math.hypot(dx, dz);
      if (length <= 2 * T.wayInset) continue;
      const u = { x: dx / length, z: dz / length };
      const n = p.normal;
      const skip = (j: number): boolean => {
        const o = scene.instances[j];
        return !o || o.role === "opening" || o.role === "marker" || o.elementId === p.id;
      };
      const heights: number[] = [];
      for (let h = 0.2; h <= T.walkerHeight + 1e-9; h += T.wayStep) heights.push(p.a.y + h);
      const count = Math.max(1, Math.round((length - 2 * T.wayInset) / T.runStep));
      const step = (length - 2 * T.wayInset) / count;
      const blockers = new Map<number, number>();
      let best = 0;
      let run = 0;
      let bestHeight = 0;
      for (let k = 0; k < count; k++) {
        const t = T.wayInset + (k + 0.5) * step;
        let clearTo = 0;
        let closed = false;
        for (const y of heights) {
          const o = { x: p.a.x + u.x * t - n.x * T.wayReach, y, z: p.a.z + u.z * t - n.z * T.wayReach };
          const hit = space.ray(o, n, 2 * T.wayReach, skip);
          if (hit) {
            closed = true;
            blockers.set(hit.index, (blockers.get(hit.index) ?? 0) + 1);
            break;
          }
          clearTo = y - p.a.y + T.wayStep / 2;
        }
        bestHeight = Math.max(bestHeight, clearTo);
        run = closed ? 0 : run + step;
        best = Math.max(best, run);
      }
      const wide = best >= Math.min(T.walkerWidth, length - 2 * T.wayInset - 1e-9);
      const tall = bestHeight >= T.walkerHeight;
      if (wide && tall) continue;
      const pieces = [...blockers]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, 4)
        .flatMap(([j]) => {
          const o = scene.instances[j];
          return o ? [findingPiece(o, j)] : [];
        });
      const blockedBy = [...new Set(pieces.map((q) => q.name))].join(", ");
      out.push({
        code: "way_blocked",
        severity: best < T.wayFault ? "fault" : "warn",
        where: {
          levelId: scene.levels[p.levelIndex]?.id ?? "",
          levelIndex: p.levelIndex,
          box: {
            min: {
              x: Math.min(p.a.x, p.b.x) - Math.abs(n.x) * T.wayReach,
              y: p.a.y,
              z: Math.min(p.a.z, p.b.z) - Math.abs(n.z) * T.wayReach,
            },
            max: {
              x: Math.max(p.a.x, p.b.x) + Math.abs(n.x) * T.wayReach,
              y: p.a.y + T.walkerHeight,
              z: Math.max(p.a.z, p.b.z) + Math.abs(n.z) * T.wayReach,
            },
          },
          cells: [],
          elementId: p.id,
        },
        pieces,
        measure: { clearWidth: r2(best), clearHeight: r2(bestHeight), width: p.width },
        message: `the ${p.kind.replace(/_/g, " ")} ${p.id} is ${wide ? "too low" : "too narrow"} to walk through: ${tiles(best)} clear wide, ${tiles(bestHeight)} high${blockedBy ? ` (in the way: ${blockedBy})` : ""}`,
      });
    }
    return out;
  },
};
