/**
 * Cliffs as rock bands (docs/internal/cliffs-lessons-reference.md, 2026-11-20). A natural rise of 2 tiles or more
 * is faced by courses of long low face rocks (`cliff_face` → palette role cliff.formation_face) that rest on the
 * low ground and step back as they climb, finished by crest boulders (`cliff_crest` → cliff.formation_crest) standing
 * on the upper ground at the lip so the edge never shows. Pieces lie along the edge, overlap their neighbours, turn
 * up to 30° either way in 15° steps (and either end first) and are spaced irregularly; run ends fade into a few
 * loose boulders; routes (paths, stairs, links) keep their gap; a rock ramp's sides are lined from the upper ground.
 * Rises of 1–1.5 tiles get a broken single row of crest boulders only. Growth that follows the rock is the composer's (setpieces.ts).
 *
 * Every piece is supported: the base course and the crest boulders stand on the ground at their centre (nothing is
 * sunk, nothing floats), and an upper course stands on the top of the rock beneath its centre (`lift`).
 *
 * Theme-neutral and palette-agnostic: piece sizes come from `PlacementGrid.pieceSize` when the resolver provides it
 * (from the palette's assets), else nominal sizes (the live Cliff Face and Boulder - Large props). A theme without the
 * formation roles realizes nothing here, and its cliff keeps the built face (the realizer decides that).
 */
import type { Rotation, Side } from "../contracts/plan";
import { subSeed } from "../util/hash";
import { createPrng } from "../util/prng";
import type { GeneratedPlacement, PlacementGrid } from "./place";

const EDGE_LEDGE = 3;
const EDGE_STAIR = 4;
const FLAG_WATER = 4;
const FLAG_PATH = 8;
const FLAG_LINK = 16;
const SIDES: readonly Side[] = ["N", "E", "S", "W"];
const STEP: Record<Side, readonly [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const key = (x: number, y: number): number => (x + 16384) * 32768 + (y + 16384);

type Piece = "cliff_face" | "cliff_crest";
interface Size {
  w: number;
  d: number;
  h: number;
}

/** Nominal piece sizes (tiles) when the resolver gives none: the live Cliff Face and Boulder - Large props. */
const NOMINAL: Record<Piece, Size> = {
  cliff_face: { w: 4.6, d: 3, h: 2.3 },
  cliff_crest: { w: 1.8, d: 1.5, h: 1.6 },
};

/** Band tuning, data rather than code. */
const BAND = {
  /** Rise (tiles) from which a cliff gets face courses; below it, crest boulders only. */
  faceFrom: 2,
  /** The top of the rise (tiles) the crest boulders finish, so the courses need not reach it. */
  crestShare: 0.5,
  /** Centre spacing of face rocks, as a share of their length (neighbours overlap by about a third to a half). */
  faceGap: [0.3, 0.66],
  /** Spacing of the fill pass (a share of the length): closes any gap of four cells or more. */
  faceFill: 0.41,
  /** Centre spacing of crest boulders, as a share of their width. */
  crestGap: [0.7, 1.1],
  /** Step back per course (cells), toward the upper ground. */
  stepBack: [1.0, 1.3],
  /** Share of a low rise's edge that gets crest boulders. */
  lowCrest: 0.8,
  /** Share of crest boulders set a cell further back from the lip. */
  crestBack: 0.15,
  /** Turn either way of the edge, in 15° steps. */
  maxTurnSteps: 2,
  /** Share of a face rock's bounding box an upper course may stand on. */
  standOn: 0.6,
} as const;

/** One cell edge across which the ground rises: the low cell, the side toward the high cell, the heights. */
export interface RiseUnit {
  /** The low cell (rocks stand on it). */
  low: [number, number];
  /** Side of the low cell the rise is on (toward the upper ground). */
  side: Side;
  lo: number;
  hi: number;
}

export interface BandParams {
  /** Cells the band may be planned for (the upper cells of the rise must be among them). */
  areaCells: ReadonlyArray<[number, number]>;
  seed: number;
  /** Cells not to touch (door zones, keep-clear, anything already taken by the caller). */
  avoid?: (x: number, y: number) => boolean;
  /**
   * The caller's last word on a piece that would block these cells for walking (its reachability guard); false
   * leaves it out, and the band tries the next way to cover that edge. Called once per piece, last.
   */
  accept?: (cells: ReadonlyArray<[number, number]>) => boolean;
}

export interface BandResult {
  placements: Array<GeneratedPlacement & { lift: number }>;
  /** Edge units with rise ≥ 1 and how many of them the band clads (a piece's footprint covers either cell). */
  units: number;
  clad: number;
  /** Cells under the band's pieces (other dressing keeps off them). */
  cells: Array<[number, number]>;
  /** Rise units the band faces (for growth that follows the rock). */
  rises: RiseUnit[];
  /**
   * Cells each placement blocks for walking (parallel to `placements`), for the caller's reachability guard: the
   * cells under it at about its base height.
   */
  footprints: Array<Array<[number, number]>>;
  /** Per placement, the index of the placement it stands on (-1: the ground); drop it if that one is dropped. */
  restsOn: number[];
}

/** Every rise unit of the area: the upper cell is in the area, the low neighbour is floor 1 tile or more below. */
export function riseUnits(grid: PlacementGrid, cells: ReadonlyArray<[number, number]>): RiseUnit[] {
  const out: RiseUnit[] = [];
  const h = (x: number, y: number): number => grid.height?.(x, y) ?? 0;
  for (const [x, y] of cells) {
    if (!grid.isFloor(x, y)) continue;
    for (const s of SIDES) {
      if (grid.edge(x, y, s) !== EDGE_LEDGE) continue;
      const [dx, dy] = STEP[s];
      const lx = x + dx;
      const ly = y + dy;
      if (!grid.inBounds(lx, ly) || !grid.isFloor(lx, ly)) continue;
      const rise = h(x, y) - h(lx, ly);
      if (rise < 1) continue;
      const back: Side = s === "N" ? "S" : s === "S" ? "N" : s === "E" ? "W" : "E";
      out.push({ low: [lx, ly], side: back, lo: h(lx, ly), hi: h(x, y) });
    }
  }
  return out;
}

/** Builds the rock band for every rise in the area. */
export function cliffBand(grid: PlacementGrid, p: BandParams): BandResult {
  const rng = createPrng(subSeed(p.seed, "cliffband"));
  const between = (r: readonly [number, number]): number => r[0] + rng.next() * (r[1] - r[0]);
  const h = (x: number, y: number): number => grid.height?.(x, y) ?? 0;
  const size = (t: Piece): Size => grid.pieceSize?.(t) ?? NOMINAL[t];
  const units = riseUnits(grid, p.areaCells);
  // a theme without the formation roles (the resolver says so through pieceSize) gets no band: its cliff keeps the
  // built face, and the composer's growth along the rises still follows the edge
  if (
    grid.pieceSize &&
    grid.pieceSize("cliff_face") === undefined &&
    grid.pieceSize("cliff_crest") === undefined
  )
    return {
      placements: [],
      units: units.length,
      clad: 0,
      cells: [],
      rises: units,
      footprints: [],
      restsOn: [],
    };
  const out: Array<GeneratedPlacement & { lift: number }> = [];
  const footprints: Array<Array<[number, number]>> = [];
  const pieceCells = new Set<number>();
  /** The top (absolute tiles) of the rock a piece could stand on, per cell (the inner part of each face rock). */
  const rockTop = new Map<number, number>();
  /** Which placement that top belongs to. */
  const rockOf = new Map<number, number>();
  /** Per placement: the index of the placement it stands on (-1: the ground). */
  const restsOn: number[] = [];
  /** Cells no part of a piece may cover: links (steps, bridges), paths, and what the caller keeps clear. */
  const blockedFor = (x: number, y: number): boolean => {
    if (!grid.inBounds(x, y)) return true;
    if ((grid.flags(x, y) & (FLAG_LINK | FLAG_PATH)) !== 0) return true;
    return p.avoid?.(x, y) === true;
  };
  /** Cells a piece may not stand on: water (it may overhang a stream from the bank). */
  const noStand = (x: number, y: number): boolean => (grid.flags(x, y) & FLAG_WATER) !== 0;
  /** A rock ramp's cell: no piece covers it (the band lines its sides from beside it). */
  const isRamp = (x: number, y: number): boolean => grid.ramp?.(x, y) === true;
  /**
   * A route crosses here and keeps its gap in the band: a flight of steps, a link, or a path on both sides of the
   * edge (a path running along the lip or the foot is no crossing: the band lines it).
   */
  const route = (u: RiseUnit): boolean => {
    const [dx, dy] = STEP[u.side];
    if (grid.edge(u.low[0], u.low[1], u.side) === EDGE_STAIR) return true;
    const f0 = grid.flags(u.low[0], u.low[1]);
    const f1 = grid.flags(u.low[0] + dx, u.low[1] + dy);
    if (((f0 | f1) & FLAG_LINK) !== 0) return true;
    return (f0 & f1 & FLAG_PATH) !== 0;
  };
  /** Cells within a box of half-extents (hw, hd) round a cell centre. */
  const cellsRound = (ax: number, ay: number, hw: number, hd: number): Array<[number, number]> => {
    const cs: Array<[number, number]> = [];
    const cx = ax + 0.5;
    const cy = ay + 0.5;
    const x0 = Math.min(ax, Math.floor(cx - hw + 0.25));
    const x1 = Math.max(ax, Math.ceil(cx + hw - 0.25) - 1);
    const y0 = Math.min(ay, Math.floor(cy - hd + 0.25));
    const y1 = Math.max(ay, Math.ceil(cy + hd - 0.25) - 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cs.push([x, y]);
    return cs;
  };

  /**
   * Places one piece with its centre in cell (ax, ay), lying along the edge of `side`; `base` is "ground" (stands
   * on the floor of that cell) or "rock" (stands on the rock beneath it). False when it cannot stand there.
   */
  const place = (t: Piece, ax: number, ay: number, side: Side, base: "ground" | "rock"): boolean => {
    if (!grid.inBounds(ax, ay) || !grid.isFloor(ax, ay)) return false;
    const s = size(t);
    const along = side === "N" || side === "S" ? 0 : 90;
    const turn = (rng.int(BAND.maxTurnSteps * 2 + 1) - BAND.maxTurnSteps) * 15 + (rng.chance(0.5) ? 180 : 0);
    const rotFine = (along + turn + 360) % 360;
    const rad = (rotFine * Math.PI) / 180;
    const bw = Math.abs(s.w * Math.cos(rad)) + Math.abs(s.d * Math.sin(rad));
    const bd = Math.abs(s.w * Math.sin(rad)) + Math.abs(s.d * Math.cos(rad));
    // its footprint: the odd box of cells centred on its cell that its turned outline fills (5×3 for a 4.6×3 face
    // rock along the edge, 1×1 for a crest boulder); emitted as the feature's at/size, so the realizer centres the
    // asset on (ax, ay) and the review and verify measure the rock where it stands
    const kx = Math.max(0, Math.round(bw / 2 - 0.5));
    const ky = Math.max(0, Math.round(bd / 2 - 0.5));
    const fp: Array<[number, number]> = [];
    for (let y = ay - ky; y <= ay + ky; y++) for (let x = ax - kx; x <= ax + kx; x++) fp.push([x, y]);
    const off = (x: number, y: number): boolean => blockedFor(x, y) || isRamp(x, y);
    if (fp.some(([x, y]) => !grid.inBounds(x, y) || off(x, y))) return false;
    const ground = h(ax, ay);
    if (noStand(ax, ay)) return false;
    let b = ground;
    if (base === "rock") {
      const top = rockTop.get(key(ax, ay));
      if (top === undefined || top <= ground + 0.5) return false;
      b = top;
    }
    const under = base === "rock" ? (rockOf.get(key(ax, ay)) ?? -1) : -1;
    // a lift in quarter tiles, never below the top it stands on (so the rock beneath carries it)
    const lift = Math.ceil((b - ground) * 4 - 1e-6) / 4;
    // the cells it blocks for walking: where it stands on the floor (an overhang high above the low ground, or the
    // hill rising above a face rock leaning on it, stays walkable)
    const foot = ground + lift;
    const inside = fp.filter(
      ([x, y]) => grid.inBounds(x, y) && !isRamp(x, y) && h(x, y) >= foot - 0.5 && h(x, y) < foot + s.h,
    );
    if (inside.some(([x, y]) => noStand(x, y))) return false;
    if (p.accept && !p.accept(inside)) return false;
    for (const [x, y] of fp) pieceCells.add(key(x, y));
    if (t === "cliff_face")
      for (const [x, y] of cellsRound(ax, ay, (bw * BAND.standOn) / 2, (bd * BAND.standOn) / 2)) {
        const k = key(x, y);
        const top = ground + lift + s.h;
        if (top > (rockTop.get(k) ?? -Infinity)) {
          rockTop.set(k, top);
          rockOf.set(k, out.length);
        }
      }
    const rot = ((Math.round(rotFine / 90) % 4) * 90) as Rotation;
    // the lift is measured from the floor of the footprint's first cell (where the feature is anchored)
    const corner = h(ax - kx, ay - ky);
    out.push({
      type: t,
      at: [ax - kx, ay - ky],
      size: [2 * kx + 1, 2 * ky + 1],
      rot,
      rotFine,
      lift: ground + lift - corner,
    });
    footprints.push(inside);
    restsOn.push(under);
    return true;
  };

  /** Centres placed so far (cell centres), per course of face rock and for the crest. */
  const faceAt: Array<Array<[number, number]>> = [];
  const crestAt: Array<[number, number]> = [];
  const near = (list: ReadonlyArray<[number, number]>, x: number, y: number, r: number): boolean =>
    list.some(([a, b]) => (a - x) * (a - x) + (b - y) * (b - y) < r * r);
  /** The cell `out` cells out from the edge of unit u (negative: back over the upper ground), jittered along it. */
  const cellOut = (u: RiseUnit, outward: number, jitter: number): [number, number] => {
    const [dx, dy] = STEP[u.side];
    const ns = u.side === "N" || u.side === "S";
    const ex = u.low[0] + 0.5 + dx * 0.5 - dx * outward + (ns ? jitter : 0);
    const ey = u.low[1] + 0.5 + dy * 0.5 - dy * outward + (ns ? 0 : jitter);
    return [Math.floor(ex), Math.floor(ey)];
  };
  // edges in reading order: a straight run comes in sequence; corners and ragged steps are sorted out by distance
  const order = [...units].sort((a, b) => a.low[1] - b.low[1] || a.low[0] - b.low[0]);
  const face = size("cliff_face");
  const crest = size("cliff_crest");
  const coursesOf = (u: RiseUnit): number =>
    u.hi - u.lo < BAND.faceFrom ? 0 : Math.max(1, Math.ceil((u.hi - u.lo - BAND.crestShare) / face.h));

  // ── face courses: the base course on the low ground, each course above a step back toward the cliff, on the rock
  const maxCourses = Math.max(0, ...units.map(coursesOf));
  for (let c = 0; c < maxCourses; c++) {
    const mine: Array<[number, number]> = [];
    faceAt.push(mine);
    // a seeded spacing pass, then a fill pass that closes any gap wider than the overlap allows (where the edge
    // steps, the two lines of rock meet out of order)
    for (const gap of [null, BAND.faceFill] as const)
      for (const u of order) {
        const n = coursesOf(u);
        if (c >= n || route(u)) continue;
        // the base course reaches further out the more courses stand on it, so every course rests on rock
        const outward = 0.5 + (n - 1 - c) * between(BAND.stepBack) + rng.next() * 0.6;
        const [ax, ay] = cellOut(u, outward, (rng.next() - 0.5) * 0.9);
        if (near(mine, ax + 0.5, ay + 0.5, face.w * (gap ?? between(BAND.faceGap)))) continue;
        // the base course stands on the low ground (never on the upper cell, where it would sink into the hill)
        if (h(ax, ay) > u.lo + 0.25) continue;
        if (place("cliff_face", ax, ay, u.side, c === 0 ? "ground" : "rock")) mine.push([ax + 0.5, ay + 0.5]);
      }
  }

  // ── crest boulders on the upper ground at the lip, every rise; on low rises a broken single row
  for (const u of order) {
    if (route(u)) continue;
    const low = u.hi - u.lo < BAND.faceFrom;
    if (low && !rng.chance(BAND.lowCrest)) continue;
    const back = rng.chance(BAND.crestBack) ? 1.5 : 0.5;
    const [ax, ay] = cellOut(u, -back, (rng.next() - 0.5) * 0.8);
    if (near(crestAt, ax + 0.5, ay + 0.5, crest.w * between(BAND.crestGap))) continue;
    if (h(ax, ay) < u.hi - 0.25) continue;
    if (place("cliff_crest", ax, ay, u.side, "ground")) crestAt.push([ax + 0.5, ay + 0.5]);
  }

  // ── plugs: a cliff of 2 tiles or more shows the void behind it wherever no rock covers the middle of its edge
  //    (the realizer lays no face blocks there), so every such edge still bare gets a face rock tried a cell either
  //    way along it, then a crest boulder at the lip
  const covers = (u: RiseUnit): boolean => {
    const [dx, dy] = STEP[u.side];
    const mx = u.low[0] + 0.5 + dx * 0.5;
    const my = u.low[1] + 0.5 + dy * 0.5;
    return out.some(
      (q) =>
        mx >= q.at[0] - 0.3 &&
        mx <= q.at[0] + q.size[0] + 0.3 &&
        my >= q.at[1] - 0.3 &&
        my <= q.at[1] + q.size[1] + 0.3,
    );
  };
  for (const u of order) {
    if (coursesOf(u) === 0 || route(u) || covers(u)) continue;
    const [dx, dy] = STEP[u.side];
    const ns = u.side === "N" || u.side === "S";
    const tries: Array<[Piece, number, number]> = [];
    for (const along of [0, 1, -1])
      tries.push(["cliff_face", u.low[0] + (ns ? along : 0), u.low[1] + (ns ? 0 : along)]);
    tries.push(["cliff_crest", u.low[0] + dx, u.low[1] + dy], ["cliff_crest", u.low[0], u.low[1]]);
    for (const [t, ax, ay] of tries) {
      const standsLow = t === "cliff_face" || (ax === u.low[0] && ay === u.low[1]);
      if (standsLow ? h(ax, ay) > u.lo + 0.25 : h(ax, ay) < u.hi - 0.25) continue;
      if (place(t, ax, ay, u.side, "ground")) {
        if (t === "cliff_crest") crestAt.push([ax + 0.5, ay + 0.5]);
        else faceAt[0]?.push([ax + 0.5, ay + 0.5]);
        break;
      }
    }
  }

  // ── run ends fade into two or three loose boulders on the low ground (an edge that turns a corner goes on)
  const at = new Set<number>();
  for (const u of units) {
    const [dx, dy] = STEP[u.side];
    at.add(key(u.low[0], u.low[1]));
    at.add(key(u.low[0] + dx, u.low[1] + dy));
  }
  for (const u of units) {
    if (coursesOf(u) === 0 || route(u)) continue;
    const ns = u.side === "N" || u.side === "S";
    for (const dir of [-1, 1] as const) {
      const nx = u.low[0] + (ns ? dir : 0);
      const ny = u.low[1] + (ns ? 0 : dir);
      let goesOn = false;
      for (let y = ny - 1; y <= ny + 1 && !goesOn; y++)
        for (let x = nx - 1; x <= nx + 1; x++)
          if (at.has(key(x, y)) && !(x === u.low[0] && y === u.low[1])) {
            const [dx, dy] = STEP[u.side];
            if (!(x === u.low[0] + dx && y === u.low[1] + dy)) {
              goesOn = true;
              break;
            }
          }
      if (goesOn) continue;
      const [dx, dy] = STEP[u.side];
      const k = 2 + rng.int(2);
      let along = 0;
      for (let i = 0; i < k; i++) {
        along += 0.8 + rng.next();
        const out_ = 0.5 + rng.next() * 1.5;
        const bx = Math.floor(u.low[0] + 0.5 + (ns ? dir * along : 0) - dx * out_);
        const by = Math.floor(u.low[1] + 0.5 + (ns ? 0 : dir * along) - dy * out_);
        if (grid.inBounds(bx, by) && h(bx, by) <= u.lo + 0.25) place("cliff_crest", bx, by, u.side, "ground");
      }
    }
  }

  // coverage: a unit is clad when a piece covers its low cell or its upper cell
  let clad = 0;
  for (const u of units) {
    const [dx, dy] = STEP[u.side];
    if (pieceCells.has(key(u.low[0], u.low[1])) || pieceCells.has(key(u.low[0] + dx, u.low[1] + dy))) clad++;
  }
  const cells: Array<[number, number]> = [];
  for (const k of pieceCells) cells.push([Math.floor(k / 32768) - 16384, (k % 32768) - 16384]);
  return { placements: out, units: units.length, clad, cells, rises: units, footprints, restsOn };
}
