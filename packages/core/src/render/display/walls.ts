/**
 * Walls: half-cell strips in the HOST cell (EdgeGrid.host), painted on a half-cell ("quarter") grid with corner posts
 * and traced per wall style, so the 2D view shows exactly the usable floor the compiler builds.
 */
import type { DisplayItem, ResolvedLevel, ResolvedOpening } from "../../contracts/resolved";
import { EDGE } from "../../contracts/resolved";
import { isSecret, isWindow } from "../../gen/openingKinds";
import { THEME_WALL_STYLE } from "../../gen/wallStyles";
import { hEdgeIndex, vEdgeIndex } from "../../resolve/levelGrid";
import { traceRings } from "../../resolve/trace";
import type { DisplayCtx } from "./context";
import { flat } from "./rings";

type EdgeGrid = ResolvedLevel["hEdges"];

/** Wall style -> display token ("wall" for the theme's own walls, "wall-<style>" otherwise), numbered from 1. */
class StyleKeys {
  readonly tokens: string[] = [""];
  key(style: string): number {
    const tok = style === THEME_WALL_STYLE ? "wall" : `wall-${style}`;
    let k = this.tokens.indexOf(tok);
    if (k < 0) {
      k = this.tokens.length;
      this.tokens.push(tok);
    }
    return k;
  }
}

/** The half-cell grid the walls are painted on: one style key per quarter (0 = no wall). */
class Quarters {
  readonly QW: number;
  readonly QH: number;
  readonly keys: Uint8Array;
  constructor(w: number, h: number) {
    this.QW = 2 * w;
    this.QH = 2 * h;
    this.keys = new Uint8Array(this.QW * this.QH);
  }
  inside(qx: number, qy: number): boolean {
    return qx >= 0 && qy >= 0 && qx < this.QW && qy < this.QH;
  }
  set(qx: number, qy: number, k: number): void {
    if (this.inside(qx, qy)) this.keys[qy * this.QW + qx] = k;
  }
  /** Sets the quarter only when it holds no wall yet. */
  fill(qx: number, qy: number, k: number): void {
    if (this.inside(qx, qy) && this.keys[qy * this.QW + qx] === 0) this.set(qx, qy, k);
  }
}

/** The quarter row (h edge) or column (v edge) an edge's strip lies in: on its host cell's side. */
const hostQuarter = (g: EdgeGrid, e: number, line: number): number =>
  g.host[e] === 1 ? 2 * line : 2 * line - 1;

export function wallItems(c: DisplayCtx): DisplayItem[] {
  const { bx, by, w, h, level, opts } = c;
  const H = level.hEdges;
  const V = level.vEdges;
  const openings = level.openings;
  const openingAsWall = (o: ResolvedOpening | undefined): boolean =>
    !!o &&
    // a window is drawn as wall (with an overlay symbol) rather than as a gap
    (isWindow(o.kind) || (!opts.gmLayer && (o.gmOnly === true || isSecret(o.kind))));
  const styles = new StyleKeys();
  /** Style key if the edge is drawn as wall (0 if not). */
  const edgeWall = (g: EdgeGrid, e: number): number => {
    const kind = g.kind[e];
    if (kind === EDGE.WALL) return styles.key(level.wallStyles[g.ref[e] as number] ?? THEME_WALL_STYLE);
    if (kind === EDGE.OPENING) {
      const o = openings[g.ref[e] as number];
      if (openingAsWall(o)) return styles.key(o?.wallStyle ?? THEME_WALL_STYLE);
    }
    return 0;
  };
  const q = new Quarters(w, h);
  for (let ly = 0; ly <= h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      const e = hEdgeIndex(level.bounds, lx, ly);
      const k = edgeWall(H, e);
      if (!k) continue;
      const qy = hostQuarter(H, e, ly);
      q.set(2 * lx, qy, k);
      q.set(2 * lx + 1, qy, k);
    }
  }
  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx <= w; lx++) {
      const e = vEdgeIndex(level.bounds, lx, ly);
      const k = edgeWall(V, e);
      if (!k) continue;
      const qx = hostQuarter(V, e, lx);
      q.set(qx, 2 * ly, k);
      q.set(qx, 2 * ly + 1, k);
    }
  }
  // corner posts: for each perpendicular pair of wall-ish edges at a vertex, fill the quarter on both hosts' sides
  for (let vy = 0; vy <= h; vy++) {
    for (let vx = 0; vx <= w; vx++) {
      const hs: Array<[number, number]> = [];
      for (const ex of [vx - 1, vx]) {
        if (ex < 0 || ex >= w) continue;
        const e = hEdgeIndex(level.bounds, ex, vy);
        const k = edgeWall(H, e);
        if (k) hs.push([k, hostQuarter(H, e, vy)]);
      }
      if (hs.length === 0) continue;
      for (const ey of [vy - 1, vy]) {
        if (ey < 0 || ey >= h) continue;
        const e = vEdgeIndex(level.bounds, vx, ey);
        if (!edgeWall(V, e)) continue;
        const qx = hostQuarter(V, e, vx);
        for (const [k, qy] of hs) q.fill(qx, qy, k);
      }
    }
  }
  const items: DisplayItem[] = [];
  for (let k = 1; k < styles.tokens.length; k++) {
    const rings = traceRings(q.QW, q.QH, (qx, qy) => q.keys[qy * q.QW + qx] === k, bx, by, 0.5).map(flat);
    if (rings.length > 0)
      items.push({ layer: "wall", style: styles.tokens[k] as string, geom: { rings, closed: true } });
  }
  return items;
}
