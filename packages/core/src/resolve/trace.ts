/**
 * Boundary tracing of a cell mask into polygon rings ("marching squares" on a binary grid, §2.4 step 10).
 * Rings are in vertex coordinates. In screen orientation (y down) outer rings run clockwise and holes
 * counter-clockwise, so non-zero and even-odd fills agree. Diagonally touching cells stay separate rings
 * (4-connectivity: the tracer prefers right turns at pinch vertices). Collinear points are removed.
 */

export type Ring = Array<[number, number]>;

/**
 * @param w,h     grid size in units
 * @param inside  membership of unit (ux, uy), 0 ≤ ux < w, 0 ≤ uy < h
 * @param ox,oy   coordinate of unit (0,0)'s top-left corner
 * @param unit    size of one unit (1 for cells, 0.5 for half cells)
 */
export function traceRings(
  w: number,
  h: number,
  inside: (ux: number, uy: number) => boolean,
  ox = 0,
  oy = 0,
  unit = 1,
): Ring[] {
  const W1 = w + 1;
  // directed edges: start vertex, direction (0 E, 1 S, 2 W, 3 N)
  const startV: number[] = [];
  const dirs: number[] = [];
  const outgoing = new Map<number, number[]>();
  const add = (vx: number, vy: number, d: number): void => {
    const v = vy * W1 + vx;
    const id = startV.length;
    startV.push(v);
    dirs.push(d);
    const list = outgoing.get(v);
    if (list) list.push(id);
    else outgoing.set(v, [id]);
  };
  const isIn = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && inside(x, y);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isIn(x, y)) continue;
      if (!isIn(x, y - 1)) add(x, y, 0);
      if (!isIn(x + 1, y)) add(x + 1, y, 1);
      if (!isIn(x, y + 1)) add(x + 1, y + 1, 2);
      if (!isIn(x - 1, y)) add(x, y + 1, 3);
    }
  }
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const used = new Uint8Array(startV.length);
  const rings: Ring[] = [];
  for (let s = 0; s < startV.length; s++) {
    if (used[s]) continue;
    const verts: number[] = [];
    const vdirs: number[] = [];
    let e = s;
    for (;;) {
      used[e] = 1;
      const v = startV[e] as number;
      const d = dirs[e] as number;
      verts.push(v);
      vdirs.push(d);
      const vx = (v % W1) + (DX[d] as number);
      const vy = Math.floor(v / W1) + (DY[d] as number);
      const next = outgoing.get(vy * W1 + vx) ?? [];
      let pick = -1;
      for (const turn of [1, 0, 3]) {
        const want = (d + turn) % 4;
        const cand = next.find((id) => !used[id] && dirs[id] === want);
        if (cand !== undefined) {
          pick = cand;
          break;
        }
      }
      if (pick < 0) break;
      e = pick;
    }
    // keep only corners (direction changes), circularly
    const ring: Ring = [];
    const n = verts.length;
    for (let i = 0; i < n; i++) {
      const prevDir = vdirs[(i + n - 1) % n] as number;
      if (prevDir === vdirs[i]) continue;
      const v = verts[i] as number;
      ring.push([ox + (v % W1) * unit, oy + Math.floor(v / W1) * unit]);
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Signed area of a ring (positive = clockwise in screen orientation, y down). */
export function ringArea(ring: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p = ring[j] as readonly [number, number];
    const q = ring[i] as readonly [number, number];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
