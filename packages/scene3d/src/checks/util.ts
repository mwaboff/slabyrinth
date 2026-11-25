/** Small helpers the checks share: grouping neighbours, rounding measures (boxes: geom/box.ts). */

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
