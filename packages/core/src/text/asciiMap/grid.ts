/**
 * The map rows. Narrow crops: a (2w+1)×(2h+1) character grid where odd/odd positions are cells and even positions
 * are edges and vertices (walls, openings, ledges, steps), with room keys and issue marks over it. Wide crops: one
 * character per cell, no walls, and a hint.
 */
import type { Vec2 } from "../../contracts/plan";
import type { ResolvedLevel } from "../../contracts/resolved";
import { EDGE } from "../../contracts/resolved";
import { hEdgeIndex, vEdgeIndex } from "../../resolve/levelGrid";
import { type CellView, shown } from "./cells";
import type { AsciiCtx, AsciiSeen } from "./context";
import { OPENING_CHAR } from "./legend";

type CellReader = (gx: number, gy: number) => CellView;

/** The eight cells around a room's anchor, tried in this order when the anchor has no room for the key. */
const KEY_NEIGHBOURS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;

/** One character per cell, walls and doors omitted, and the hint that says so. */
export function singleCharRows(
  c: AsciiCtx,
  view: CellReader,
  marked: ReadonlySet<string>,
  maxW: number,
): string[] {
  const { rx0, ry0, rx1, ry1, rw } = c;
  const lw = rowLabelWidth(ry0, ry1);
  const lines: string[] = [header1(rx0, rw, lw)];
  for (let gy = ry0; gy < ry1; gy++) {
    let row = "";
    for (let gx = rx0; gx < rx1; gx++) row += marked.has(`${gx},${gy}`) ? "!" : shown(view(gx, gy));
    lines.push(rowLabel(gy, lw) + row);
  }
  lines.push(
    `(level crop is ${rw} cells wide: 1 char per cell, walls and doors omitted; call view_plan ascii with region ≤ ${maxW} wide for walls)`,
  );
  return lines;
}

/**
 * A crop of more than `maxCells` cells: one character per block of s × s cells (the smallest s that keeps the blocks
 * within `maxCells`), walls and doors omitted. A block shows "!" if it holds a marked cell, else the first feature in
 * it, else the character most of its cells show. The last line states the scale and how to ask for full detail.
 */
export function overviewRows(
  c: AsciiCtx,
  view: CellReader,
  marked: ReadonlySet<string>,
  maxCells: number,
  maxW: number,
): string[] {
  const { rx0, ry0, rx1, ry1, rw, rh } = c;
  let s = Math.max(2, Math.ceil(Math.sqrt((rw * rh) / maxCells)));
  while (Math.ceil(rw / s) * Math.ceil(rh / s) > maxCells) s++;
  const bw = Math.ceil(rw / s);
  const labelled: number[] = [];
  for (let by = ry0, k = 0; by < ry1; by += s, k++) if (k % 5 === 0) labelled.push(by);
  const lw = labelWidth(labelled);
  const lines: string[] = [blockHeader(rx0, bw, s, lw)];
  for (let by = ry0; by < ry1; by += s) {
    let row = "";
    for (let bx = rx0; bx < rx1; bx += s)
      row += blockChar(view, marked, bx, by, Math.min(bx + s, rx1), Math.min(by + s, ry1));
    lines.push(blockRowLabel(by, (by - ry0) / s, lw) + row);
  }
  const side = Math.floor(Math.sqrt(maxCells));
  lines.push(
    `(overview: level crop is ${rw}×${rh} cells, more than one view draws (${maxCells}), so 1 char = ${s}×${s} cells (x and y labels are cell coordinates), walls and doors omitted; call view_plan ascii with a region of at most ${side}×${side} cells for every cell, ≤ ${maxW} wide for walls)`,
  );
  return lines;
}

function blockChar(
  view: CellReader,
  marked: ReadonlySet<string>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): string {
  const count = new Map<string, number>();
  for (let gy = y0; gy < y1; gy++)
    for (let gx = x0; gx < x1; gx++) {
      if (marked.has(`${gx},${gy}`)) return "!";
      const v = view(gx, gy);
      if (v.feat !== null) return v.feat;
      const ch = shown(v);
      count.set(ch, (count.get(ch) ?? 0) + 1);
    }
  let best = " ";
  let n = 0;
  for (const [ch, k] of count) if (k > n) [best, n] = [ch, k];
  return best;
}

/** Row label: the block's first cell row, on every 5th block row, right-aligned in `lw` characters. */
function blockRowLabel(by: number, k: number, lw: number): string {
  return k % 5 === 0 ? String(by).padStart(lw, " ") + " " : " ".repeat(lw + 1);
}

/** Column header: the block's first cell column, on every 10th block. */
function blockHeader(rx0: number, bw: number, s: number, lw: number): string {
  const chars = new Array<string>(bw).fill(" ");
  for (let b = 0; b < bw; b += 10) {
    const t = String(rx0 + b * s);
    for (let k = 0; k < t.length && b + k < bw; k++) chars[b + k] = t[k] as string;
  }
  return " ".repeat(lw + 1) + chars.join("").replace(/\s+$/, "");
}

interface Edge {
  kind: number;
  ref: number;
}

/** The double-resolution grid and what drawing it needs: cell views (with a one-cell border) and edges. */
class DoubleGrid {
  readonly GW: number;
  readonly g: string[][];
  private readonly cells: CellView[][] = [];
  constructor(
    private readonly c: AsciiCtx,
    view: CellReader,
    private readonly seen: AsciiSeen,
  ) {
    const { rx0, ry0, rx1, ry1, rw, rh } = c;
    this.GW = 2 * rw + 1;
    const GH = 2 * rh + 1;
    this.g = Array.from({ length: GH }, () => new Array<string>(this.GW).fill(" "));
    for (let y = ry0 - 1; y <= ry1; y++) {
      const row: CellView[] = [];
      for (let x = rx0 - 1; x <= rx1; x++) row.push(view(x, y));
      this.cells.push(row);
    }
  }
  /** The view of a cell in the region or its one-cell border. */
  cv(gx: number, gy: number): CellView {
    return (this.cells[gy - this.c.ry0 + 1] as CellView[])[gx - this.c.rx0 + 1] as CellView;
  }
  private edgeAt(grid: ResolvedLevel["hEdges"], i: number): Edge {
    return i < 0 ? { kind: EDGE.NONE, ref: 0 } : { kind: grid.kind[i] as number, ref: grid.ref[i] as number };
  }
  /** The horizontal edge north of a global cell, the vertical edge west of it. */
  hEdge(gx: number, gy: number): Edge {
    const B = this.c.lvl.bounds;
    return this.edgeAt(this.c.lvl.hEdges, hEdgeIndex(B, gx - B.x, gy - B.y));
  }
  vEdge(gx: number, gy: number): Edge {
    const B = this.c.lvl.bounds;
    return this.edgeAt(this.c.lvl.vEdges, vEdgeIndex(B, gx - B.x, gy - B.y));
  }
  /** Writes a character at grid row r, column col. */
  put(r: number, col: number, ch: string): void {
    (this.g[r] as string[])[col] = ch;
  }
  /** The character of an edge between cells a and b; an open edge joins what the two cells show. */
  edgeChar(e: Edge, wallCh: string, a: CellView, b: CellView): string {
    if (e.kind === EDGE.WALL) return wallCh;
    if (e.kind === EDGE.STAIR) {
      this.seen.stair = true;
      return "/";
    }
    if (e.kind === EDGE.LEDGE) {
      this.seen.ledge = true;
      return ":";
    }
    if (e.kind === EDGE.OPENING) {
      const o = this.c.lvl.openings[e.ref];
      const ch = o ? OPENING_CHAR[o.kind] : "d";
      this.seen.edgeChars.add(ch);
      return ch;
    }
    return join(a, b);
  }
}

/** Two cells across an open edge: the feature spanning both, else their common base. */
function join(a: CellView, b: CellView): string {
  if (a.featId !== null && a.featId === b.featId && a.feat !== null) return a.feat;
  if (a.base === "") return b.base === "" ? " " : b.base;
  if (b.base === "") return a.base;
  return a.base === b.base ? a.base : " ";
}

const wallish = (k: number): boolean => k === EDGE.WALL || k === EDGE.OPENING;

/** The double-resolution map: cells, edges, vertices, room keys and issue marks, under its column header. */
export function doubleCharRows(
  c: AsciiCtx,
  view: CellReader,
  seen: AsciiSeen,
  marked: ReadonlySet<string>,
): string[] {
  const grid = new DoubleGrid(c, view, seen);
  drawCells(c, grid);
  drawEdges(c, grid);
  drawVertices(c, grid);
  drawRoomKeys(c, grid);
  for (const k of marked) {
    const [mx, my] = k.split(",").map(Number) as [number, number];
    grid.put(2 * (my - c.ry0) + 1, 2 * (mx - c.rx0) + 1, "!");
  }
  const lw = rowLabelWidth(c.ry0, c.ry1);
  const lines = [header2(c.rx0, c.rw, lw)];
  grid.g.forEach((row, r) => {
    const gy = c.ry0 + (r - 1) / 2;
    lines.push((r % 2 === 1 ? rowLabel(gy, lw) : " ".repeat(lw + 1)) + row.join("").replace(/\s+$/, ""));
  });
  return lines;
}

function drawCells(c: AsciiCtx, grid: DoubleGrid): void {
  for (let gy = c.ry0; gy < c.ry1; gy++)
    for (let gx = c.rx0; gx < c.rx1; gx++)
      grid.put(2 * (gy - c.ry0) + 1, 2 * (gx - c.rx0) + 1, shown(grid.cv(gx, gy)));
}

/** Horizontal edges (rows 0, 2, ..), then vertical edges (cols 0, 2, ..). */
function drawEdges(c: AsciiCtx, grid: DoubleGrid): void {
  const { rx0, ry0, rx1, ry1 } = c;
  for (let gy = ry0; gy <= ry1; gy++)
    for (let gx = rx0; gx < rx1; gx++)
      grid.put(
        2 * (gy - ry0),
        2 * (gx - rx0) + 1,
        grid.edgeChar(grid.hEdge(gx, gy), "-", grid.cv(gx, gy - 1), grid.cv(gx, gy)),
      );
  for (let gy = ry0; gy < ry1; gy++)
    for (let gx = rx0; gx <= rx1; gx++)
      grid.put(
        2 * (gy - ry0) + 1,
        2 * (gx - rx0),
        grid.edgeChar(grid.vEdge(gx, gy), "|", grid.cv(gx - 1, gy), grid.cv(gx, gy)),
      );
}

/** Vertices: wall corners and runs, ledges, else what the four cells around share. */
function drawVertices(c: AsciiCtx, grid: DoubleGrid): void {
  const { rx0, ry0, rx1, ry1 } = c;
  for (let gy = ry0; gy <= ry1; gy++) {
    for (let gx = rx0; gx <= rx1; gx++) {
      const hz = wallish(grid.hEdge(gx - 1, gy).kind) || wallish(grid.hEdge(gx, gy).kind);
      const vt = wallish(grid.vEdge(gx, gy - 1).kind) || wallish(grid.vEdge(gx, gy).kind);
      let ch: string;
      if (hz && vt) ch = "+";
      else if (hz) ch = "-";
      else if (vt) ch = "|";
      else {
        const around = [grid.cv(gx - 1, gy - 1), grid.cv(gx, gy - 1), grid.cv(gx - 1, gy), grid.cv(gx, gy)];
        const ledge =
          grid.hEdge(gx - 1, gy).kind === EDGE.LEDGE ||
          grid.hEdge(gx, gy).kind === EDGE.LEDGE ||
          grid.vEdge(gx, gy - 1).kind === EDGE.LEDGE ||
          grid.vEdge(gx, gy).kind === EDGE.LEDGE;
        const real = around.filter((v) => v.base !== "");
        const r0 = real[0];
        if (ledge) ch = ":";
        else if (r0 && real.every((v) => v.base === r0.base)) {
          const sameFeat =
            r0.featId !== null && real.length === 4 && real.every((v) => v.featId === r0.featId);
          ch = sameFeat && r0.feat ? r0.feat : r0.base;
        } else ch = " ";
      }
      grid.put(2 * (gy - ry0), 2 * (gx - rx0), ch);
    }
  }
}

/** A cell a room key may cover: plain floor of the room (no feature, no link, wall or hole). */
const keyFloor = (base: string): boolean =>
  base === "." || base === "," || base === "~" || base === "_" || base === "^" || /^[1-9]$/.test(base);

/** Room keys "[k]" at the anchor, else the first neighbour where the text covers only the room's plain floor. */
function drawRoomKeys(c: AsciiCtx, grid: DoubleGrid): void {
  const { lvl, rx0, ry0 } = c;
  lvl.areas.forEach((a, ai) => {
    if (!a.key || a.cellCount === 0) return;
    const text = `[${a.key}]`;
    const tries: Vec2[] = [a.anchor];
    for (const [dx, dy] of KEY_NEIGHBOURS) tries.push([a.anchor[0] + dx, a.anchor[1] + dy]);
    for (const [ax, ay] of tries) {
      if (!c.inView(ax, ay)) continue;
      const r = 2 * (ay - ry0) + 1;
      const c0 = 2 * (ax - rx0);
      if (c0 + text.length > grid.GW) continue;
      let ok = true;
      for (let k = 0; k < text.length && ok; k++) {
        const col = c0 + k;
        if (col % 2 === 1) {
          const gx = rx0 + (col - 1) / 2;
          const i = c.cellI(gx, ay);
          const v = grid.cv(gx, ay);
          ok = i >= 0 && lvl.cells.area[i] === ai + 1 && v.feat === null && keyFloor(v.base);
        } else {
          ok = grid.vEdge(rx0 + col / 2, ay).kind === EDGE.NONE;
        }
      }
      if (!ok) continue;
      for (let k = 0; k < text.length; k++) grid.put(r, c0 + k, text[k] as string);
      break;
    }
  });
}

/**
 * The width of the row-label column: the widest label the view shows, at least 3 (so a view whose labels fit 3
 * characters keeps its layout). One width for every row and the header, so each row's cells start in one column.
 */
function labelWidth(labels: readonly number[]): number {
  let w = 3;
  for (const v of labels) w = Math.max(w, String(v).length);
  return w;
}

/** The label width of rows ry0..ry1 (exclusive), labelled on every 5th coordinate. */
function rowLabelWidth(ry0: number, ry1: number): number {
  const labelled: number[] = [];
  for (let gy = ry0; gy < ry1; gy++) if (gy % 5 === 0) labelled.push(gy);
  return labelWidth(labelled);
}

/** Row label: the cell row on every 5th coordinate, right-aligned in `lw` characters. */
function rowLabel(gy: number, lw: number): string {
  return gy % 5 === 0 ? String(gy).padStart(lw, " ") + " " : " ".repeat(lw + 1);
}

function header2(rx0: number, rw: number, lw: number): string {
  const chars = new Array<string>(2 * rw + 1).fill(" ");
  for (let gx = rx0; gx < rx0 + rw; gx++) {
    if (gx % 5 !== 0) continue;
    const s = String(gx);
    const col = 2 * (gx - rx0) + 1;
    for (let k = 0; k < s.length && col + k < chars.length; k++) chars[col + k] = s[k] as string;
  }
  return " ".repeat(lw + 1) + chars.join("").replace(/\s+$/, "");
}

function header1(rx0: number, rw: number, lw: number): string {
  const chars = new Array<string>(rw).fill(" ");
  for (let gx = rx0; gx < rx0 + rw; gx++) {
    if (gx % 10 !== 0) continue;
    const s = String(gx);
    for (let k = 0; k < s.length && gx - rx0 + k < chars.length; k++) chars[gx - rx0 + k] = s[k] as string;
  }
  return " ".repeat(lw + 1) + chars.join("").replace(/\s+$/, "");
}
