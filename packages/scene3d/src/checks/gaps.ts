/**
 * Gaps in a shell: along every closed side the build planned (a building storey's walls, an object's rail, bulwark or
 * hull round its decks; plan.ts `boundaries`, which leave out every planned opening, gangway and stair), short
 * horizontal rays cross the side at a few heights every `runStep`. A stretch where no structural piece stops the rays,
 * wider than `gapMin`, is a gap a person could see (or fall) through: one finding per stretch.
 */
import { maxOf, minOf } from "@slabyrinth/core";
import { objectOf } from "@slabyrinth/core/objects";
import type { Box3, Vec3 } from "../types/index";
import { findingPiece, structural } from "./pieces";
import type { PlanBoundary } from "./plan";
import { CHECK_THRESHOLDS as T } from "./thresholds";
import type { CheckInput, Finding, SceneCheck } from "./types";
import { r2, tiles } from "./util";

interface Stretch {
  from: number;
  to: number;
  heights: Set<number>;
}

/** The clear stretches of one boundary: sample positions (distance along it) open at one height or more. */
function clearStretches(
  input: CheckInput,
  run: PlanBoundary,
): { stretches: Stretch[]; length: number; u: Vec3 } {
  const { scene, space, plan } = input;
  const dx = run.b.x - run.a.x;
  const dz = run.b.z - run.a.z;
  const length = Math.hypot(dx, dz);
  const u = { x: dx / (length || 1), y: 0, z: dz / (length || 1) };
  const n = run.outward;
  const reach = T.rayInside + (run.kind === "rail" ? T.railOutside : T.rayOutside);
  // a wall is closed by any structure; an object's rail only by its own body (not the quay it lies against)
  const skip = (j: number): boolean => {
    const o = scene.instances[j];
    if (!o || !structural(o, plan)) return true;
    return run.kind === "rail" && objectOf(o.elementId ?? undefined) !== run.owner;
  };
  const stretches: Stretch[] = [];
  let cur: Stretch | null = null;
  const count = Math.max(1, Math.floor(length / T.runStep));
  for (let k = 0; k < count; k++) {
    const t = (k + 0.5) * (length / count);
    const open = new Set<number>();
    for (const h of run.heights) {
      const o = { x: run.a.x + u.x * t - n.x * T.rayInside, y: h, z: run.a.z + u.z * t - n.z * T.rayInside };
      if (space.ray(o, n, reach, skip) === null) open.add(h);
    }
    if (open.size > 0) {
      const lo = t - length / count / 2;
      const hi = t + length / count / 2;
      if (cur) {
        cur.to = hi;
        for (const h of open) cur.heights.add(h);
      } else cur = { from: lo, to: hi, heights: open };
    } else if (cur) {
      stretches.push(cur);
      cur = null;
    }
  }
  if (cur) stretches.push(cur);
  return { stretches, length, u };
}

export const shellGapCheck: SceneCheck = {
  code: "shell_gap",
  needsPlan: true,
  run(input) {
    const { scene, space, plan } = input;
    if (!plan) return [];
    const out: Finding[] = [];
    for (const run of plan.boundaries) {
      const { stretches, u } = clearStretches(input, run);
      for (const s of stretches) {
        const width = s.to - s.from;
        if (width < T.gapMin) continue;
        const hs = [...s.heights].sort((a, b) => a - b);
        const lo = minOf(hs);
        const hi = maxOf(hs);
        const p0 = { x: run.a.x + u.x * s.from, z: run.a.z + u.z * s.from };
        const p1 = { x: run.a.x + u.x * s.to, z: run.a.z + u.z * s.to };
        const box: Box3 = {
          min: {
            x: Math.min(p0.x, p1.x) - Math.abs(run.outward.x) * 0.5,
            y: lo - 0.25,
            z: Math.min(p0.z, p1.z) - Math.abs(run.outward.z) * 0.5,
          },
          max: {
            x: Math.max(p0.x, p1.x) + Math.abs(run.outward.x) * 0.5,
            y: hi + 0.25,
            z: Math.max(p0.z, p1.z) + Math.abs(run.outward.z) * 0.5,
          },
        };
        // the pieces either side of the gap: those of the enclosure's side within half a tile of it
        const side = space
          .overlapping({
            min: { x: box.min.x - 0.5, y: box.min.y, z: box.min.z - 0.5 },
            max: { x: box.max.x + 0.5, y: box.max.y, z: box.max.z + 0.5 },
          })
          .filter((j) => {
            const o = scene.instances[j];
            return o !== undefined && structural(o, plan) && o.role !== "floor" && o.role !== "fill";
          })
          .slice(0, 6);
        // the plan cells beside the stretch
        const cells = run.cells.filter((_, i) => {
          const c0 = i;
          const c1 = i + 1;
          return c1 > s.from && c0 < s.to;
        });
        const what = run.kind === "wall" ? "wall" : "rail or hull";
        out.push({
          code: "shell_gap",
          severity: width >= T.gapFault ? "fault" : "warn",
          where: {
            levelId: scene.levels[run.levelIndex]?.id ?? "",
            levelIndex: run.levelIndex,
            box,
            cells,
            elementId: run.owner,
          },
          pieces: side.flatMap((j) => {
            const o = scene.instances[j];
            return o ? [findingPiece(o, j)] : [];
          }),
          measure: { width: r2(width), from: r2(lo), to: r2(hi) },
          message: `a ${tiles(width)} gap in ${run.owner}'s ${what} where no opening is planned (open at ${hs.map((h) => r2(h)).join(", ")} high)`,
        });
      }
    }
    return out;
  },
};
