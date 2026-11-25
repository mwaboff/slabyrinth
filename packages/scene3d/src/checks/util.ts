/** Small helpers the checks share: boxes, grouping neighbours, rounding measures. */
import type { Box3, Scene } from "../types/index";

export function emptyBox(): Box3 {
  return {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
}

export function grow(b: Box3, o: Box3): Box3 {
  b.min.x = Math.min(b.min.x, o.min.x);
  b.min.y = Math.min(b.min.y, o.min.y);
  b.min.z = Math.min(b.min.z, o.min.z);
  b.max.x = Math.max(b.max.x, o.max.x);
  b.max.y = Math.max(b.max.y, o.max.y);
  b.max.z = Math.max(b.max.z, o.max.z);
  return b;
}

export const copyBox = (b: Box3): Box3 => ({ min: { ...b.min }, max: { ...b.max } });

/** Do two boxes come within `d` of each other? */
export function near(a: Box3, b: Box3, d: number): boolean {
  return (
    a.max.x + d >= b.min.x &&
    b.max.x + d >= a.min.x &&
    a.max.y + d >= b.min.y &&
    b.max.y + d >= a.min.y &&
    a.max.z + d >= b.min.z &&
    b.max.z + d >= a.min.z
  );
}

/** The box of some pieces. */
export function boxOfPieces(scene: Scene, idx: readonly number[]): Box3 {
  const b = emptyBox();
  for (const i of idx) {
    const a = scene.instances[i]?.aabb;
    if (a) grow(b, a);
  }
  return b;
}

/** Groups items by a "belongs with" relation given as neighbour lists (union-find); groups in first-member order. */
export function groups<T>(items: readonly T[], neighbours: (i: number) => readonly number[]): T[][] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    let k = i;
    while (parent[k] !== r) {
      const n = parent[k] ?? r;
      parent[k] = r;
      k = n;
    }
    return r;
  };
  items.forEach((_, i) => {
    for (const j of neighbours(i)) {
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  });
  const out = new Map<number, T[]>();
  items.forEach((it, i) => {
    const r = find(i);
    let g = out.get(r);
    if (!g) out.set(r, (g = []));
    g.push(it);
  });
  return [...out.keys()].sort((a, b) => a - b).map((k) => out.get(k) ?? []);
}

/** A measure rounded to hundredths (stable in JSON). */
export const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Plain words for a length in tiles. */
export const tiles = (v: number): string => `${r2(v).toFixed(2)} tile${Math.abs(v - 1) < 1e-9 ? "" : "s"}`;
