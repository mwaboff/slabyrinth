/**
 * Roads (generator 2): the geometry half of a path op in road form (`sidewalk` / `crossings`). The resolver
 * (level.ts) lays the cells; these helpers measure along the axis and describe the result for the build and dressing:
 * crossings, kerb lines and pavement corners. Theme-neutral: nothing here knows what the road is made of.
 */
import type { Side, Vec2 } from "../contracts/plan";
import type { ResolvedRoad } from "../contracts/resolved";

const STEP: Record<Side, readonly [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const SIDES: readonly Side[] = ["N", "E", "S", "W"];

/** Arc-length position of a cell centre projected on the nearest segment of the axis, and that segment's direction. */
export function axisPosition(axis: readonly Vec2[], x: number, y: number): { s: number; dir: "h" | "v" } {
  let best = Infinity;
  let out = { s: 0, dir: "h" as "h" | "v" };
  let acc = 0;
  for (let k = 0; k + 1 < axis.length; k++) {
    const [ax, ay] = axis[k] as Vec2;
    const [bx, by] = axis[k + 1] as Vec2;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const t = Math.max(0, Math.min(len, ((x - ax) * dx + (y - ay) * dy) / len));
    const px = ax + (dx / len) * t;
    const py = ay + (dy / len) * t;
    const d = Math.hypot(x - px, y - py);
    if (d < best - 1e-9) {
      best = d;
      out = { s: acc + t, dir: Math.abs(dx) >= Math.abs(dy) ? "h" : "v" };
    }
    acc += len;
  }
  return out;
}

export function axisLength(axis: readonly Vec2[]): number {
  let acc = 0;
  for (let k = 0; k + 1 < axis.length; k++) {
    const a = axis[k] as Vec2;
    const b = axis[k + 1] as Vec2;
    acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return acc;
}

/** Crossings: carriageway cells within one cell either way of each fraction of the axis length (2 cells wide). */
export function crossingCells(
  axis: readonly Vec2[],
  carriageway: readonly Vec2[],
  fractions: readonly number[],
): ResolvedRoad["crossings"] {
  const total = axisLength(axis);
  const out: ResolvedRoad["crossings"] = [];
  for (const f of fractions) {
    // clamp so a crossing at 0 or 1 still has both its rows on the road
    const s = Math.max(1, Math.min(total - 1, f * total));
    const cells: Vec2[] = [];
    let dir: "h" | "v" = "h";
    for (const [x, y] of carriageway) {
      const p = axisPosition(axis, x, y);
      if (p.s >= s - 1 && p.s < s + 1) {
        cells.push([x, y]);
        dir = p.dir;
      }
    }
    if (cells.length > 0) out.push({ cells, axis: dir });
  }
  return out;
}

const key = (x: number, y: number): string => `${x},${y}`;

/**
 * Kerb lines (straight runs of pavement cells whose `side` neighbour is carriageway, crossings excluded) and pavement
 * corners. `carriage` / `crossing` hold every road's cells ("x,y"), so junction mouths read as carriageway.
 */
export function kerbLinesAndCorners(
  pavement: readonly Vec2[],
  carriage: ReadonlySet<string>,
  crossing: ReadonlySet<string>,
  pavedAll: ReadonlySet<string>,
): Pick<ResolvedRoad, "kerbLines" | "corners"> {
  const pave = new Set(pavement.map(([x, y]) => key(x, y)));
  const onKerb = (x: number, y: number, s: Side): boolean => {
    const [dx, dy] = STEP[s];
    const k = key(x + dx, y + dy);
    return pave.has(key(x, y)) && carriage.has(k) && !crossing.has(k);
  };
  const kerbLines: ResolvedRoad["kerbLines"] = [];
  for (const s of SIDES) {
    const along: readonly [number, number] = s === "N" || s === "S" ? [1, 0] : [0, 1];
    const seen = new Set<string>();
    const sorted = [...pavement].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (const [x, y] of sorted) {
      if (seen.has(key(x, y)) || !onKerb(x, y, s)) continue;
      // walk back to the start of the run, then forward to its end
      let sx = x;
      let sy = y;
      while (onKerb(sx - along[0], sy - along[1], s)) {
        sx -= along[0];
        sy -= along[1];
      }
      let ex = sx;
      let ey = sy;
      seen.add(key(ex, ey));
      while (onKerb(ex + along[0], ey + along[1], s)) {
        ex += along[0];
        ey += along[1];
        seen.add(key(ex, ey));
      }
      kerbLines.push({ from: [sx, sy], to: [ex, ey], side: s });
    }
  }
  const corners: ResolvedRoad["corners"] = [];
  const pairs: ReadonlyArray<[Side, Side]> = [
    ["N", "E"],
    ["E", "S"],
    ["S", "W"],
    ["W", "N"],
  ];
  for (const [x, y] of pavement) {
    const road = (s: Side): boolean => carriage.has(key(x + STEP[s][0], y + STEP[s][1]));
    const anyRoad = SIDES.some(road);
    for (const [a, b] of pairs) {
      if (road(a) && road(b)) corners.push({ at: [x, y], kind: "outer", sides: [a, b] });
      else if (!anyRoad) {
        const dx = STEP[a][0] + STEP[b][0];
        const dy = STEP[a][1] + STEP[b][1];
        const pa = pavedAll.has(key(x + STEP[a][0], y + STEP[a][1]));
        const pb = pavedAll.has(key(x + STEP[b][0], y + STEP[b][1]));
        if (carriage.has(key(x + dx, y + dy)) && pa && pb)
          corners.push({ at: [x, y], kind: "inner", sides: [a, b] });
      }
    }
  }
  return { kerbLines, corners };
}
