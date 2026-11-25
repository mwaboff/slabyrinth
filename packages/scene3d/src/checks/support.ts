/**
 * Floating and sunk pieces, from the meshes. A piece is carried when it rests on another (a line down from its mesh's
 * lowest points meets one within `floatGap` below, or `restDepth` into it), when it is structure touching structure
 * (a floor beside a floor at the same top, a floor on a wall, a roof on a roof: structure carries structure), or when
 * it hangs (facts, the plan or its role say so) within reach of structure. Carrying spreads from the ground: a piece
 * whose bottom is its level's base with nothing at all under it. Whatever the ground never reaches floats: one finding
 * per group of touching floating pieces.
 *
 * Sunk: a loose piece (not organic dressing, which grows out of the ground) more than `sunkShare` of whose height is
 * below the ground it stands in.
 */
import { objectOf } from "@slabyrinth/core/objects";
import type { SceneInstance, Vec3 } from "../types/index";
import { bodyPiece, findingPiece, groundPiece, hangs, organic, structural } from "./pieces";
import type { SceneSpace } from "./space";
import { CHECK_THRESHOLDS as T } from "./thresholds";
import type { CheckInput, Finding, SceneCheck } from "./types";
import { boxOfPieces, groups, near, r2, tiles } from "./util";

/** At most this many bottom points per piece. */
const MAX_SAMPLES = 9;

/** Points just inside a piece's lowest vertices (its feet, its base's corners), at most MAX_SAMPLES. */
export function bottomSamples(space: SceneSpace, idx: number): Vec3[] {
  const inst = space.scene.instances[idx];
  if (!inst) return [];
  const v = space.worldVertices(idx);
  const minY = inst.aabb.min.y;
  const cx = (inst.aabb.min.x + inst.aabb.max.x) / 2;
  const cz = (inst.aabb.min.z + inst.aabb.max.z) / 2;
  const seen = new Set<string>();
  const pts: Vec3[] = [];
  for (let i = 0; i + 2 < v.length; i += 3) {
    if ((v[i + 1] ?? Infinity) > minY + 0.03) continue;
    let x = v[i] ?? 0;
    let z = v[i + 2] ?? 0;
    const dx = cx - x;
    const dz = cz - z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-6) {
      const k = Math.min(0.04, d) / d;
      x += dx * k;
      z += dz * k;
    }
    const key = `${Math.round(x * 20)},${Math.round(z * 20)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pts.push({ x, y: minY, z });
  }
  pts.sort((a, b) => a.x - b.x || a.z - b.z);
  if (pts.length <= MAX_SAMPLES) return pts.length > 0 ? pts : [{ x: cx, y: minY, z: cz }];
  const out: Vec3[] = [];
  for (let k = 0; k < MAX_SAMPLES; k++) {
    const p = pts[Math.floor((k * (pts.length - 1)) / (MAX_SAMPLES - 1))];
    if (p) out.push(p);
  }
  return out;
}

/** Do two structural pieces carry each other where they touch? Two grounds only when their tops are a step apart at most. */
function carries(a: SceneInstance, b: SceneInstance): boolean {
  if (!near(a.aabb, b.aabb, T.touch)) return false;
  if (groundPiece(a) && groundPiece(b)) return Math.abs(a.aabb.max.y - b.aabb.max.y) <= T.flushStep;
  return true;
}

interface Support {
  /** Each piece's carriers. */
  carriers: number[][];
  supported: boolean[];
  /** The highest surface under each piece's bottom points (−Infinity: nothing at all). */
  below: number[];
  /** The piece that surface belongs to (−1: none). */
  under: number[];
}

/** Who carries whom, and what the ground reaches. */
export function support(input: CheckInput): Support {
  const { scene, space, plan } = input;
  const n = scene.instances.length;
  const carriers: number[][] = Array.from({ length: n }, () => []);
  const roots: boolean[] = new Array<boolean>(n).fill(false);
  const below: number[] = new Array<number>(n).fill(-Infinity);
  const under: number[] = new Array<number>(n).fill(-1);
  const sceneBase = scene.bounds.min.y;
  for (let i = 0; i < n; i++) {
    const inst = scene.instances[i];
    if (!inst || inst.role === "marker") continue;
    const bottom = inst.aabb.min.y;
    const rests = new Set<number>();
    let anyBelow = false;
    for (const s of bottomSamples(space, i))
      for (const h of space.column(s.x, s.z, -Infinity, bottom + T.restDepth, (j) => j === i)) {
        anyBelow = true;
        if (h.at > (below[i] ?? -Infinity)) {
          below[i] = h.at;
          under[i] = h.index;
        }
        if (h.at >= bottom - T.floatGap) rests.add(h.index);
      }
    // what runs up through its middle carries it too (a crown on its trunk, a shade on its post): a piece whose
    // lowest points are its rim sits on what its centre line meets within its height
    const cx = (inst.aabb.min.x + inst.aabb.max.x) / 2;
    const cz = (inst.aabb.min.z + inst.aabb.max.z) / 2;
    for (const h of space.column(cx, cz, bottom - T.floatGap, inst.aabb.max.y, (j) => j === i))
      rests.add(h.index);
    // and structure its top meets right above it holds it up (a lantern under a canopy, a lamp from a beam)
    const top = inst.aabb.max.y;
    for (const h of space.column(cx, cz, top - T.touch, top + T.mountReach, (j) => {
      const o = scene.instances[j];
      return j === i || !o || !structural(o, plan);
    }))
      rests.add(h.index);
    const base = plan?.levelBase[inst.levelIndex] ?? sceneBase;
    roots[i] = (!anyBelow && bottom <= base + T.groundSlack) || bottom <= sceneBase + T.groundSlack;
    const list = carriers[i] ?? [];
    for (const j of rests) list.push(j);
    const isStructure = structural(inst, plan);
    // organic dressing clings to what it touches (a cliff face on a terrace's side, roots on a wall)
    const hanging = hangs(inst, plan) || organic(inst, plan);
    // an object's body is one assembled thing: its parts (rigging, a lantern on its post) hang on each other
    const body = bodyPiece(inst, plan);
    if (isStructure || hanging) {
      const reach = hanging || body ? T.mountReach : T.touch;
      const g = inst.aabb;
      for (const j of space.overlapping({
        min: { x: g.min.x - reach, y: g.min.y - reach, z: g.min.z - reach },
        max: { x: g.max.x + reach, y: g.max.y + reach, z: g.max.z + reach },
      })) {
        const o = scene.instances[j];
        if (j === i || !o || !structural(o, plan)) continue;
        const sameBody = body && objectOf(o.elementId ?? undefined) === objectOf(inst.elementId ?? undefined);
        if (hanging || sameBody ? near(inst.aabb, o.aabb, T.mountReach) : carries(inst, o)) list.push(j);
      }
    }
  }
  // spread from the ground: j carries i when j is in carriers[i]
  const carried: number[][] = Array.from({ length: n }, () => []);
  carriers.forEach((cs, i) => {
    for (const j of cs) carried[j]?.push(i);
  });
  const supported: boolean[] = roots.slice();
  const queue: number[] = [];
  roots.forEach((r, i) => {
    if (r) queue.push(i);
  });
  for (let q = 0; q < queue.length; q++) {
    const j = queue[q] ?? 0;
    for (const i of carried[j] ?? []) {
      if (supported[i]) continue;
      supported[i] = true;
      queue.push(i);
    }
  }
  scene.instances.forEach((inst, i) => {
    if (inst.role === "marker") supported[i] = true;
  });
  return { carriers, supported, below, under };
}

export const floatingCheck: SceneCheck = {
  code: "floating",
  needsPlan: false,
  run(input) {
    const { scene } = input;
    const s = support(input);
    const loose = scene.instances.map((_, i) => i).filter((i) => !s.supported[i]);
    const out: Finding[] = [];
    const clusters = groupTouching(input.space, loose);
    for (const idx of clusters) {
      const first = scene.instances[idx[0] ?? -1];
      if (!first) continue;
      const box = boxOfPieces(scene, idx);
      // the air under the group: from a piece's bottom to the highest surface under it that is not the group's own
      // (a candle on a plate on a bench: the air is under the plate)
      const own = new Set(idx);
      let gap = Infinity;
      let over = -1;
      let low = first;
      for (const i of idx) {
        const inst = scene.instances[i];
        if (!inst) continue;
        const bottom = inst.aabb.min.y;
        for (const p of idx.length === 1 ? [] : bottomSamples(input.space, i)) {
          const h = input.space.column(p.x, p.z, -Infinity, bottom + T.restDepth, (j) => own.has(j))[0];
          if (h && bottom - h.at < gap) {
            gap = bottom - h.at;
            over = h.index;
            low = inst;
          }
        }
        const b = s.below[i] ?? -Infinity;
        if (idx.length === 1 && Number.isFinite(b) && bottom - b < gap) {
          gap = bottom - b;
          over = s.under[i] ?? -1;
          low = inst;
        }
      }
      const names = [...new Set(idx.map((i) => scene.instances[i]?.name ?? "?"))];
      const base = scene.instances[over];
      // what it stands over, and whether it was set on that piece's box top rather than its real surface
      const onBoxTop = base !== undefined && Math.abs(base.aabb.max.y - low.aabb.min.y) <= T.floatGap;
      const air = Number.isFinite(gap)
        ? `${tiles(gap)} of air between it and the ${base?.name ?? "surface"} under it${onBoxTop ? " (it stands at that piece's box top, above its real surface)" : ""}`
        : "nothing at all under it";
      out.push({
        code: "floating",
        severity: "fault",
        where: {
          levelId: first.levelId,
          levelIndex: first.levelIndex,
          box,
          cells: cellsOf(scene.instances, idx),
          elementId: first.elementId,
        },
        pieces: idx.map((i) => findingPiece(scene.instances[i] as SceneInstance, i)),
        measure: {
          pieces: idx.length,
          ...(Number.isFinite(gap) ? { gap: r2(gap) } : {}),
          ...(base ? { underBoxTop: r2(base.aabb.max.y - low.aabb.min.y) } : {}),
        },
        message: `${String(idx.length)} piece(s) float (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}): ${air}, and nothing that reaches the ground carries them`,
      });
    }
    return out;
  },
};

export const sunkCheck: SceneCheck = {
  code: "sunk",
  needsPlan: false,
  run({ scene, space, plan }) {
    const out: Finding[] = [];
    scene.instances.forEach((inst, i) => {
      if (inst.role === "marker" || structural(inst, plan) || hangs(inst, plan) || organic(inst, plan))
        return;
      if (inst.elementId !== null && plan?.sunkByPlan.has(inst.elementId)) return;
      const h = inst.aabb.max.y - inst.aabb.min.y;
      if (h < T.sunkMinHeight) return;
      const cx = (inst.aabb.min.x + inst.aabb.max.x) / 2;
      const cz = (inst.aabb.min.z + inst.aabb.max.z) / 2;
      const hits = space.column(cx, cz, inst.aabb.min.y, inst.aabb.max.y, (j) => {
        const o = scene.instances[j];
        return j === i || !o || !groundPiece(o);
      });
      const surface = hits[0]?.at;
      if (surface === undefined) return;
      const share = (surface - inst.aabb.min.y) / h;
      if (share <= T.sunkShare) return;
      const ground = scene.instances[hits[0]?.index ?? -1];
      out.push({
        code: "sunk",
        severity: share > 0.85 ? "fault" : "warn",
        where: {
          levelId: inst.levelId,
          levelIndex: inst.levelIndex,
          box: inst.aabb,
          cells: inst.cell ? [inst.cell] : [],
          elementId: inst.elementId,
        },
        pieces: [findingPiece(inst, i), ...(ground ? [findingPiece(ground, hits[0]?.index ?? -1)] : [])],
        measure: { buried: r2(share), depth: r2(surface - inst.aabb.min.y) },
        message: `${inst.name} is ${String(Math.round(share * 100))}% under the ${ground?.name ?? "ground"} it stands in (${tiles(surface - inst.aabb.min.y)} deep)`,
      });
    });
    return out;
  },
};

/** Groups pieces (indexes) whose boxes touch, on the same level (through the space's hash, never every pair). */
export function groupTouching(space: SceneSpace, idx: readonly number[], d: number = T.touch): number[][] {
  const pos = new Map(idx.map((i, k) => [i, k]));
  return groups(idx, (k) => {
    const a = space.scene.instances[idx[k] ?? -1];
    if (!a) return [];
    const g = a.aabb;
    return space
      .overlapping({
        min: { x: g.min.x - d, y: g.min.y - d, z: g.min.z - d },
        max: { x: g.max.x + d, y: g.max.y + d, z: g.max.z + d },
      })
      .map((j) => pos.get(j))
      .filter((m): m is number => m !== undefined && m > k)
      .filter((m) => space.scene.instances[idx[m] ?? -1]?.levelIndex === a.levelIndex);
  });
}

/** The plan cells of some pieces (distinct, in order). */
export function cellsOf(
  instances: readonly SceneInstance[],
  idx: readonly number[],
): Array<readonly [number, number]> {
  const seen = new Set<string>();
  const out: Array<readonly [number, number]> = [];
  for (const i of idx) {
    const c = instances[i]?.cell;
    if (!c) continue;
    const k = `${String(c[0])},${String(c[1])}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}
