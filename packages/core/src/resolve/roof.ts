/**
 * Roof strategies: pure geometry in plan cells, shared by the compiler (pieces) and the 2D overlay
 * (outline, ridge). Built today: gable; flat and none need no geometry here. New strategies (hip, shed, cone, dome)
 * add a function with the same output shape.
 *
 * Gable rule (verified in game with the slate kit, the community-build technique): pitch 45° (one tile up per
 * cell), courses step one cell in and one tile up from the eave; run-2 pieces (two cells of run, rise 2) are laid
 * at every course so consecutive courses overlap by half (thick, seamless shingles); the ridge is a pair of opposed
 * one-cell pieces; an odd span gets a flat cap row on the ridge line. The roof outline is the wing plus the ring of
 * cells the walls stand in, so the eaves and gable ends overhang the wall faces by half a cell.
 */
import type { Side } from "../contracts/plan";
import type { ResolvedStructure, ResolvedVolume } from "../contracts/resolved";
import { isPitchedRoof } from "./roofTypes";

export interface RoofWing {
  /** Footprint rectangle (cells), without the wall ring. */
  x: number;
  y: number;
  w: number;
  h: number;
  ridge: "ew" | "ns";
}

/**
 * slope: 1×1 cell, rise 1. slope2: 1 cell along the ridge × 2 cells of run, rise 2. slope2x2: 2 along × 2 run, rise 2.
 * cap: a flat ridge cap on an odd span's middle row (its TOP is at `course`).
 */
export type RoofPieceKind = "slope" | "slope2" | "slope2x2" | "cap" | "corner" | "step";

export interface RoofPiece {
  kind: RoofPieceKind;
  /** Plan cells covered (rect). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Side the slope falls toward (the eave); caps: the ridge's low side, unused. */
  eave: Side;
  /** Course index: the piece's bottom is `course` tiles above the roof base (caps: their top). */
  course: number;
  /** corner pieces: the two low sides (an outer hip corner), e.g. "NE". */
  corner?: Corner;
}

export type Corner = "NE" | "SE" | "SW" | "NW";

export interface GableRoof {
  /** Wing dilated by the wall ring. */
  outline: { x: number; y: number; w: number; h: number };
  pieces: RoofPiece[];
  /** Ridge line, cell-edge coordinates (for the 2D overlay). */
  ridge: [number, number, number, number];
  /** Height of the ridge above the roof base (tiles). */
  ridgeTop: number;
  /** Underside height above the roof base at the OUTER edge of each across-row (index = across row 0..span-1). */
  rowCourse: number[];
}

const key = (x: number, y: number): string => `${x},${y}`;

/**
 * Gable roof over one wing. `holes` are cells left open (chimney breasts); pieces that would cover one are dropped
 * and the other cells they covered get one-cell slopes.
 */
export function gableRoof(wing: RoofWing, holes: ReadonlySet<string> = new Set()): GableRoof {
  const ox = wing.x - 1;
  const oy = wing.y - 1;
  const ow = wing.w + 2;
  const oh = wing.h + 2;
  const ew = wing.ridge === "ew";
  const span = ew ? oh : ow; // across the ridge
  const len = ew ? ow : oh; // along the ridge
  const half = Math.floor(span / 2);
  const odd = span % 2 === 1;
  /** Rows per side covered by slopes (the ridge row of an even span is handled separately). */
  const rows = odd ? half : half - 1;
  const lowSide: Side = ew ? "N" : "W";
  const highSide: Side = ew ? "S" : "E";
  const pieces: RoofPiece[] = [];

  /** Plan rect for (along b, across a .. a+run-1) */
  const rect = (
    b: number,
    along: number,
    a: number,
    run: number,
  ): { x: number; y: number; w: number; h: number } =>
    ew ? { x: ox + b, y: oy + a, w: along, h: run } : { x: ox + a, y: oy + b, w: run, h: along };
  const cellsOf = (r: { x: number; y: number; w: number; h: number }): string[] => {
    const out: string[] = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push(key(x, y));
    return out;
  };
  const push = (
    kind: RoofPieceKind,
    r: { x: number; y: number; w: number; h: number },
    eave: Side,
    course: number,
  ): void => {
    pieces.push({ kind, ...r, eave, course });
  };
  /** One-cell slope at across-row a (course = its distance from the nearer eave). */
  const single = (b: number, a: number, eave: Side): void => {
    const r = rect(b, 1, a, 1);
    if (holes.has(key(r.x, r.y))) return;
    push("slope", r, eave, Math.min(a, span - 1 - a));
  };

  // along-the-ridge tiling: the gable columns (b = 0, len-1) take single-width pieces, the inside pairs
  const columns: Array<{ b: number; along: number }> = [];
  {
    columns.push({ b: 0, along: 1 });
    let b = 1;
    while (b < len - 1) {
      const along = b + 1 < len - 1 ? 2 : 1;
      columns.push({ b, along });
      b += along;
    }
    if (len > 1) columns.push({ b: len - 1, along: 1 });
  }

  for (const side of [lowSide, highSide]) {
    const low = side === lowSide;
    // run-2 courses k = 0 .. rows-2 (each covers rows k and k+1); a single row left alone gets one-cell slopes
    if (rows >= 2) {
      for (let k = 0; k <= rows - 2; k++) {
        const a = low ? k : span - 2 - k; // first across row of the 2-row run
        for (const c of columns) {
          const r = rect(c.b, c.along, a, 2);
          const cells = cellsOf(r);
          if (cells.some((cc) => holes.has(cc))) {
            // split around the hole: one-cell slopes where the piece would have been
            for (let bb = c.b; bb < c.b + c.along; bb++)
              for (const aa of [a, a + 1]) {
                const rr = rect(bb, 1, aa, 1);
                if (!holes.has(key(rr.x, rr.y))) push("slope", rr, side, Math.min(aa, span - 1 - aa));
              }
            continue;
          }
          push(c.along === 2 ? "slope2x2" : "slope2", r, side, k);
        }
      }
    } else if (rows === 1) {
      for (let b = 0; b < len; b++) single(b, low ? 0 : span - 1, side);
    }
    // even span: the ridge pair, one opposed 1×1 piece per side at course half-1
    if (!odd) for (let b = 0; b < len; b++) single(b, low ? half - 1 : half, side);
  }
  if (odd) {
    for (let b = 0; b < len; b++) {
      const r = rect(b, 1, half, 1);
      if (!holes.has(key(r.x, r.y))) push("cap", r, lowSide, half);
    }
  }

  const ridge: [number, number, number, number] = ew
    ? [ox, oy + span / 2, ox + ow, oy + span / 2]
    : [ox + span / 2, oy, ox + span / 2, oy + oh];
  const rowCourse = Array.from({ length: span }, (_, a) => Math.min(a, span - 1 - a));
  return { outline: { x: ox, y: oy, w: ow, h: oh }, pieces, ridge, ridgeTop: half, rowCourse };
}

/** Default ridge: along the longer side (east-west on a square). */
export function defaultRidge(w: number, h: number): "ew" | "ns" {
  return h > w ? "ns" : "ew";
}

// ───────────────────────────── more strategies (hip, shed, ring layers, spire) ─────────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Common output of the cell-based strategies (hip, shed, skirt, stepped). */
export interface RoofShape {
  outline: Rect;
  pieces: RoofPiece[];
  /** Height of the top above the roof base (tiles). */
  top: number;
  /** Underside height above the base at a cell's outer edge (the gable-fill target), or -1 outside. */
  surface: (x: number, y: number) => number;
  /** Flat top left inside (skirt, stepped); null when the strategy closes the roof. */
  inner: Rect | null;
  /** Ridge lines (cell-edge coordinates) for the 2D overlay. */
  ridges: Array<[number, number, number, number]>;
}

const inside = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

/**
 * Rings of the rect, outermost first: ring k is the border of the rect inset by k. Edge cells slope outward, the four
 * corner cells are outer corners. `kind` "step" lays steps (rise 1, climbing inward) instead of slopes. A ring that is
 * one cell wide (the last ring of a hip) gets caps where both of its long sides are open.
 */
function rings(
  r: Rect,
  courses: number,
  kind: "slope" | "step",
  holes: ReadonlySet<string>,
): { pieces: RoofPiece[]; ringOf: (x: number, y: number) => number; inner: Rect | null } {
  const pieces: RoofPiece[] = [];
  let k = 0;
  for (; k < courses; k++) {
    const x0 = r.x + k;
    const y0 = r.y + k;
    const x1 = r.x + r.w - 1 - k;
    const y1 = r.y + r.h - 1 - k;
    if (x0 > x1 || y0 > y1) break;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (x !== x0 && x !== x1 && y !== y0 && y !== y1) continue;
        if (holes.has(key(x, y))) continue;
        const n = y === y0;
        const s = y === y1;
        const w = x === x0;
        const e = x === x1;
        const thinNS = n && s;
        const thinWE = w && e;
        if (thinNS || thinWE) {
          // a one-cell-wide strip: the ridge line of a hip, capped
          const eave: Side = thinNS ? (w ? "W" : e ? "E" : "N") : n ? "N" : s ? "S" : "W";
          pieces.push({
            kind: kind === "step" ? "step" : "cap",
            x,
            y,
            w: 1,
            h: 1,
            eave,
            course: kind === "step" ? k : k + 1,
          });
          continue;
        }
        if ((n || s) && (w || e)) {
          if (kind === "slope") {
            const corner = `${n ? "N" : "S"}${e ? "E" : "W"}` as Corner;
            pieces.push({ kind: "corner", x, y, w: 1, h: 1, eave: n ? "N" : "S", course: k, corner });
          } else pieces.push({ kind: "step", x, y, w: 1, h: 1, eave: n ? "N" : "S", course: k });
          continue;
        }
        const eave: Side = n ? "N" : s ? "S" : w ? "W" : "E";
        pieces.push({ kind: kind === "step" ? "step" : "slope", x, y, w: 1, h: 1, eave, course: k });
      }
  }
  const ix = r.x + k;
  const iy = r.y + k;
  const iw = r.w - 2 * k;
  const ih = r.h - 2 * k;
  const ringOf = (x: number, y: number): number =>
    inside(r, x, y) ? Math.min(x - r.x, y - r.y, r.x + r.w - 1 - x, r.y + r.h - 1 - y) : -1;
  return { pieces, ringOf, inner: iw > 0 && ih > 0 ? { x: ix, y: iy, w: iw, h: ih } : null };
}

/** Hip roof over a wing: rings stepping in until the roof closes; the last thin ring is capped as the ridge. */
export function hipRoof(wing: Rect, holes: ReadonlySet<string> = new Set()): RoofShape {
  const o: Rect = { x: wing.x - 1, y: wing.y - 1, w: wing.w + 2, h: wing.h + 2 };
  const n = Math.ceil(Math.min(o.w, o.h) / 2);
  const r = rings(o, n, "slope", holes);
  const top = Math.max(0, ...r.pieces.map((p) => (p.kind === "cap" ? p.course : p.course + 1)));
  const half = Math.min(o.w, o.h) / 2;
  const ridges: RoofShape["ridges"] =
    o.w >= o.h
      ? [[o.x + half, o.y + half, o.x + o.w - half, o.y + half]]
      : [[o.x + half, o.y + half, o.x + half, o.y + o.h - half]];
  return { outline: o, pieces: r.pieces, top, surface: r.ringOf, inner: null, ridges };
}

/**
 * Shed (lean-to) roof: one slope rising from the `low` side across the whole outline, run-2 pieces at every course
 * like the gable; the top course ends at the high side.
 */
export function shedRoof(
  wing: Rect,
  low: Side,
  holes: ReadonlySet<string> = new Set(),
  /** Generator 4: a run-2 piece over a hole becomes one-cell slopes on the cells that stay open (was: dropped whole). */
  fill = false,
): RoofShape {
  const o: Rect = { x: wing.x - 1, y: wing.y - 1, w: wing.w + 2, h: wing.h + 2 };
  const acrossY = low === "N" || low === "S";
  const span = acrossY ? o.h : o.w;
  const len = acrossY ? o.w : o.h;
  const lowFirst = low === "N" || low === "W";
  const fromLow = (a: number): number => (lowFirst ? a : span - 1 - a);
  const rect = (b: number, along: number, a: number, run: number): Rect =>
    acrossY ? { x: o.x + b, y: o.y + a, w: along, h: run } : { x: o.x + a, y: o.y + b, w: run, h: along };
  const pieces: RoofPiece[] = [];
  const cols: Array<{ b: number; along: number }> = [{ b: 0, along: 1 }];
  for (let b = 1; b < len - 1;) {
    const along = b + 1 < len - 1 ? 2 : 1;
    cols.push({ b, along });
    b += along;
  }
  if (len > 1) cols.push({ b: len - 1, along: 1 });
  const cellsOf = (rr: Rect): string[] => {
    const out: string[] = [];
    for (let y = rr.y; y < rr.y + rr.h; y++) for (let x = rr.x; x < rr.x + rr.w; x++) out.push(key(x, y));
    return out;
  };
  for (let k = 0; k <= span - 2; k++) {
    const aStart = lowFirst ? k : span - 2 - k;
    for (const c of cols) {
      const rr = rect(c.b, c.along, aStart, 2);
      const piece: RoofPiece = { kind: c.along === 2 ? "slope2x2" : "slope2", ...rr, eave: low, course: k };
      if (cellsOf(rr).some((cc) => holes.has(cc))) {
        if (fill)
          for (const cc of cellsOf(rr)) {
            if (holes.has(cc)) continue;
            const [x, y] = cc.split(",").map(Number) as [number, number];
            pieces.push({ kind: "slope", x, y, w: 1, h: 1, eave: low, course: cellCourse(piece, x, y) });
          }
        continue;
      }
      pieces.push(piece);
    }
  }
  const surface = (x: number, y: number): number =>
    inside(o, x, y) ? fromLow(acrossY ? y - o.y : x - o.x) : -1;
  const hiEdge: [number, number, number, number] =
    low === "N"
      ? [o.x, o.y + o.h, o.x + o.w, o.y + o.h]
      : low === "S"
        ? [o.x, o.y, o.x + o.w, o.y]
        : low === "W"
          ? [o.x + o.w, o.y, o.x + o.w, o.y + o.h]
          : [o.x, o.y, o.x, o.y + o.h];
  return { outline: o, pieces, top: span, surface, inner: null, ridges: [hiEdge] };
}

/**
 * Skirt (mansard ring) or stepped layer: `courses` rings sloping (or stepping) up and in by one cell and one tile per
 * course, leaving a flat top for the next layer. `overhang` dilates the rect by the wall ring first (a roof layer on
 * walls); without it the rings lie on the rect itself (a skirt round a set-in, on the storey below).
 */
export function ringLayer(
  r: Rect,
  courses: number,
  kind: "slope" | "step",
  overhang: boolean,
  holes: ReadonlySet<string> = new Set(),
): RoofShape {
  const o: Rect = overhang ? { x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 } : { ...r };
  const g = rings(o, courses, kind, holes);
  const surface = (x: number, y: number): number => {
    const k = g.ringOf(x, y);
    return k < 0 ? -1 : Math.min(k, courses);
  };
  return { outline: o, pieces: g.pieces, top: courses, surface, inner: g.inner, ridges: [] };
}

/** One course of a spire shell: a square ring of thin wall strips, in plan coordinates (may be on half cells). */
export interface SpireCourse {
  /** Outer boundary of the course (plan, multiples of 0.5). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Bottom of the course above the spire base (tiles). */
  y: number;
  /** A flared band (ring of slope pieces round the outside) at this course. */
  band: boolean;
}

/**
 * Spire: a hollow shell of thin wall pieces, each course `courseHeight` tall and inset `taper` on every side, until
 * it is too narrow; flared bands at evenly spread courses; a finial on top. The base is the top storey's rect.
 */
export function spireShell(
  r: Rect,
  opts: { taper?: number; courseHeight?: number; bands?: number } = {},
): { courses: SpireCourse[]; top: number; finial: { x: number; y: number; at: number } } {
  const taper = opts.taper ?? 0.5;
  const ch = opts.courseHeight ?? 2;
  const courses: SpireCourse[] = [];
  for (let k = 0; k <= 40; k++) {
    const i = k * taper;
    const w = r.w - 2 * i;
    const h = r.h - 2 * i;
    if (w < 1.5 || h < 1.5) break;
    courses.push({ x0: r.x + i, y0: r.y + i, x1: r.x + r.w - i, y1: r.y + r.h - i, y: k * ch, band: false });
  }
  const nb = Math.min(opts.bands ?? 1, Math.max(0, courses.length - 1));
  for (let b = 1; b <= nb; b++) {
    const c = courses[Math.round((b * courses.length) / (nb + 1))];
    if (c) c.band = true;
  }
  const top = courses.length * ch;
  return { courses, top, finial: { x: r.x + r.w / 2, y: r.y + r.h / 2, at: top } };
}

// ───────────────────────────── valleys (generator 3) ─────────────────────────────

/** One roof surface to merge: its pieces, the height of its base, and its underside course at a cell (-1 outside). */
export interface RoofOwner {
  id: string;
  base: number;
  pieces: readonly RoofPiece[];
  surface: (x: number, y: number) => number;
}

const pieceCells = (p: RoofPiece): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) out.push([x, y]);
  return out;
};

/** Course of one cell of a (run-2) slope piece: it climbs from the eave side. */
function cellCourse(p: RoofPiece, x: number, y: number): number {
  switch (p.eave) {
    case "N":
      return p.course + (y - p.y);
    case "S":
      return p.course + (p.y + p.h - 1 - y);
    case "W":
      return p.course + (x - p.x);
    default:
      return p.course + (p.x + p.w - 1 - x);
  }
}

/**
 * Where roofs meet (a cross wing, a lean-to against a house, two wings of one volume) the higher surface owns each cell:
 * the valley runs where two surfaces are level. A piece wholly in its own roof's cells stays, one wholly in another's is
 * dropped, and a run-2 slope piece that is partly covered becomes one-cell slopes on the cells it keeps, so no cell of
 * any outline is left uncovered. Ties go to the roof listed first. Returns the pieces to build per roof id.
 */
export function mergeRoofs(roofs: readonly RoofOwner[]): Map<string, RoofPiece[]> {
  const owner = new Map<string, number>();
  const height = new Map<string, number>();
  roofs.forEach((r, i) => {
    for (const p of r.pieces)
      for (const [x, y] of pieceCells(p)) {
        const s = r.surface(x, y);
        if (s < 0) continue;
        const k = `${x},${y}`;
        const h = r.base + s;
        const cur = height.get(k);
        if (cur === undefined || h > cur + 1e-9) {
          height.set(k, h);
          owner.set(k, i);
        }
      }
  });
  const out = new Map<string, RoofPiece[]>();
  roofs.forEach((r, i) => {
    const mine: RoofPiece[] = [];
    for (const p of r.pieces) {
      const cells = pieceCells(p);
      const own = cells.filter(([x, y]) => owner.get(`${x},${y}`) === i);
      if (own.length === cells.length) mine.push(p);
      else if (own.length > 0 && (p.kind === "slope2" || p.kind === "slope2x2"))
        for (const [x, y] of own)
          mine.push({ kind: "slope", x, y, w: 1, h: 1, eave: p.eave, course: cellCourse(p, x, y) });
    }
    out.set(r.id, mine);
  });
  return out;
}

/**
 * The pitched roofs of a building (first layer of every volume: gable wings, hips, sheds) as owners for `mergeRoofs`,
 * keyed "<volume>#<wing>". Heights match the compiler: the top storey's wall top, plus the attic deck.
 */
export function roofOwners(
  vols: readonly ResolvedVolume[],
  holes: ReadonlySet<string> = new Set(),
  fill = false,
): RoofOwner[] {
  const owners: RoofOwner[] = [];
  for (const v of vols) {
    const top = v.storeys[v.storeys.length - 1];
    const layer = v.roof.layers[0];
    if (!top || !layer || v.roof.gableOnly) continue;
    const base = top.wallTop + (v.roof.deck && isPitchedRoof(layer.type) ? 0.5 : 0);
    if (layer.type === "gable") {
      v.rects.forEach((w, wi) => {
        const g = gableRoof(w, holes);
        const o = g.outline;
        owners.push({
          id: `${v.id}#${wi}`,
          base,
          pieces: g.pieces,
          surface: (x, y) =>
            x < o.x || y < o.y || x >= o.x + o.w || y >= o.y + o.h
              ? -1
              : (g.rowCourse[w.ridge === "ew" ? y - o.y : x - o.x] ?? -1),
        });
      });
    } else if (layer.type === "hip" || layer.type === "shed") {
      const g = layer.type === "hip" ? hipRoof(top.rect, holes) : shedRoof(top.rect, layer.low, holes, fill);
      owners.push({ id: `${v.id}#0`, base, pieces: g.pieces, surface: g.surface });
    }
  }
  return owners;
}

// ───────────────────────────── proportions (generator 3 review and tests) ─────────────────────────────

/** Height of a pitched roof over a volume's top storey, and of the whole building to its highest roof top. */
export interface RoofProportion {
  /** Highest roof top above the ground floor top (tiles). */
  visible: number;
  /** The tallest pitched roof's rise above the wall top it stands on (the deck included). */
  roof: number;
  /** roof ÷ visible. */
  share: number;
  /** Ridge heights above the ground floor top of every pitched volume, tallest first (cross wings, lean-tos). */
  ridges: number[];
}

/**
 * Roof share of a pitched-roof building: how much of its visible height the roof makes (the study's cottages and inns:
 * 55-65 %). Null when the highest roof is not a pitched one (flat roofs, towers) or the building has no volumes.
 */
export function roofProportion(st: ResolvedStructure): RoofProportion | null {
  const floor0 = st.storeys[0]?.floorTop;
  if (floor0 === undefined) return null;
  const tops: Array<{ top: number; wall: number; pitched: boolean }> = [];
  for (const v of st.volumes ?? []) {
    const last = v.storeys[v.storeys.length - 1];
    if (!last || v.roof.layers.length === 0) continue;
    let base = last.wallTop;
    let top = base;
    let pitched = false;
    v.roof.layers.forEach((layer, li) => {
      const isPitched = isPitchedRoof(layer.type);
      if (li === 0 && v.roof.deck && isPitched) base += 0.5;
      const rects = li === 0 ? v.rects : [{ ...last.rect, ridge: layer.ridge }];
      let rise = 0;
      if (layer.type === "gable") rise = Math.max(0, ...rects.map((r) => gableRoof(r).ridgeTop));
      else if (layer.type === "hip") rise = hipRoof(last.rect).top;
      else if (layer.type === "shed") rise = shedRoof(last.rect, layer.low).top;
      else if (layer.type === "skirt" || layer.type === "stepped") rise = layer.courses;
      if (isPitched) pitched = true;
      top = Math.max(top, base + rise);
      base = top;
    });
    tops.push({ top, wall: last.wallTop, pitched });
  }
  if (tops.length === 0) return null;
  tops.sort((a, b) => b.top - a.top);
  const high = tops[0];
  if (!high || !high.pitched) return null;
  const visible = high.top - floor0;
  if (visible <= 0) return null;
  const roof = high.top - high.wall;
  return {
    visible,
    roof,
    share: roof / visible,
    ridges: tops.filter((t) => t.pitched).map((t) => t.top - floor0),
  };
}
