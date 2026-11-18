/**
 * Cell masks: a boolean grid over a rectangle of GLOBAL cell coordinates.
 * Every rasterizer and generator produces one; the resolver clips them to level bounds.
 */

export interface CellMask {
  /** Global cell coordinate of the mask's top-left cell. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Row-major, 1 = inside. */
  bits: Uint8Array;
}

export function emptyMask(x: number, y: number, w: number, h: number): CellMask {
  const ww = Math.max(0, Math.floor(w));
  const hh = Math.max(0, Math.floor(h));
  return { x: Math.floor(x), y: Math.floor(y), w: ww, h: hh, bits: new Uint8Array(ww * hh) };
}

export function maskGet(m: CellMask, gx: number, gy: number): boolean {
  const lx = gx - m.x;
  const ly = gy - m.y;
  if (lx < 0 || ly < 0 || lx >= m.w || ly >= m.h) return false;
  return m.bits[ly * m.w + lx] === 1;
}

export function maskSet(m: CellMask, gx: number, gy: number, v = true): void {
  const lx = gx - m.x;
  const ly = gy - m.y;
  if (lx < 0 || ly < 0 || lx >= m.w || ly >= m.h) return;
  m.bits[ly * m.w + lx] = v ? 1 : 0;
}

/** Mask from a predicate evaluated for every cell of a box (global coords). */
export function maskFromPredicate(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  inside: (gx: number, gy: number) => boolean,
): CellMask {
  const m = emptyMask(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  for (let ly = 0; ly < m.h; ly++) {
    for (let lx = 0; lx < m.w; lx++) {
      if (inside(m.x + lx, m.y + ly)) m.bits[ly * m.w + lx] = 1;
    }
  }
  return m;
}

export function maskCount(m: CellMask): number {
  let n = 0;
  for (const b of m.bits) n += b;
  return n;
}

/** Visits inside cells in row-major order (global coords). */
export function forEachMaskCell(m: CellMask, fn: (gx: number, gy: number) => void): void {
  for (let ly = 0; ly < m.h; ly++) {
    for (let lx = 0; lx < m.w; lx++) {
      if (m.bits[ly * m.w + lx] === 1) fn(m.x + lx, m.y + ly);
    }
  }
}

/** Inside cells as a row-major list of [x, y] (global). */
export function maskCells(m: CellMask): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  forEachMaskCell(m, (x, y) => out.push([x, y]));
  return out;
}

/** Union of masks into a new mask covering all of them. */
export function maskUnion(masks: readonly CellMask[]): CellMask {
  const live = masks.filter((m) => m.w > 0 && m.h > 0);
  if (live.length === 0) return emptyMask(0, 0, 0, 0);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const m of live) {
    x0 = Math.min(x0, m.x);
    y0 = Math.min(y0, m.y);
    x1 = Math.max(x1, m.x + m.w - 1);
    y1 = Math.max(y1, m.y + m.h - 1);
  }
  const out = emptyMask(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  for (const m of live)
    forEachMaskCell(m, (x, y) => {
      maskSet(out, x, y);
    });
  return out;
}

/**
 * Keeps one 4-connected component. `prefer` (global cell) selects the component containing it when that
 * cell is inside; otherwise the largest component wins (ties: first found in row-major order).
 */
export function keepComponent(m: CellMask, prefer?: readonly [number, number]): CellMask {
  const n = m.w * m.h;
  const label = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (m.bits[i] !== 1 || label[i] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    label[i] = id;
    stack.push(i);
    while (stack.length > 0) {
      const c = stack.pop() as number;
      size++;
      const cx = c % m.w;
      const cy = (c - cx) / m.w;
      const nb = [
        cx > 0 ? c - 1 : -1,
        cx < m.w - 1 ? c + 1 : -1,
        cy > 0 ? c - m.w : -1,
        cy < m.h - 1 ? c + m.w : -1,
      ];
      for (const k of nb) {
        if (k >= 0 && m.bits[k] === 1 && label[k] === -1) {
          label[k] = id;
          stack.push(k);
        }
      }
    }
    sizes.push(size);
  }
  if (sizes.length <= 1) return m;
  let keep = -1;
  if (prefer) {
    const lx = prefer[0] - m.x;
    const ly = prefer[1] - m.y;
    if (lx >= 0 && ly >= 0 && lx < m.w && ly < m.h) keep = label[ly * m.w + lx] ?? -1;
  }
  if (keep < 0) {
    let best = -1;
    sizes.forEach((s, id) => {
      if (s > best) {
        best = s;
        keep = id;
      }
    });
  }
  const out = emptyMask(m.x, m.y, m.w, m.h);
  for (let i = 0; i < n; i++) if (label[i] === keep) out.bits[i] = 1;
  return out;
}

/** True when the inside cells form one 4-connected component (empty masks count as connected). */
export function isConnected4(cells: ReadonlyArray<readonly [number, number]>): boolean {
  if (cells.length <= 1) return true;
  const key = (x: number, y: number): string => `${x},${y}`;
  const set = new Set(cells.map(([x, y]) => key(x, y)));
  const first = cells[0] as readonly [number, number];
  const seen = new Set<string>([key(first[0], first[1])]);
  const stack: Array<readonly [number, number]> = [first];
  while (stack.length > 0) {
    const [x, y] = stack.pop() as readonly [number, number];
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as const) {
      const k = key(nx, ny);
      if (set.has(k) && !seen.has(k)) {
        seen.add(k);
        stack.push([nx, ny]);
      }
    }
  }
  return seen.size === set.size;
}
