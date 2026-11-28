/**
 * Generator 3 cave walls: a rock mass that closes the solid rock behind the cave, not a palisade.
 *
 * Generator 2 closes a natural wall with one 1×1 block column per rock cell beside the floor: a row of identical
 * posts, and nothing behind them. The first generator-3 try put a thin ring of separate lumps outside the posts (three
 * tones, gaps between the pieces, the solid rock still empty). This module plans the whole solid band instead:
 *
 *  - Course 0 covers every solid cell (a quarter-cell sample grid, so no gap wider than a quarter cell stays open)
 *    with large pieces of ONE rock family, overlapping, turned in 15° steps (near the wall within 30° of its
 *    direction, deeper freely), standing wholly in rock cells (the verifier judges boxes). Pieces are placed
 *    best-of-several by the new area they cover, so neighbours overlap and big pieces dominate.
 *  - Taller towers where the rock is deeper: further courses are lifted on the one below (strata), shifted and turned,
 *    up to a target top that rises with the distance from the open floor and flattens into a plateau (the far part
 *    of a deep band is just the plateau, not more boulders).
 *  - The wall columns the realizer used to build on every face cell are now only fill: a column stays only where no
 *    piece closes the face cell (the verifier needs the wall closed from the floor up to 1.4).
 *  - Foot stones (low, sunk, against straight stretches, in clusters) lie in front of the face and break the
 *    line of the wall.
 *
 * Pure planning over a small read-only view of the level; the realizer (compile/realize.ts) resolves the shapes to
 * palette assets and emits them. Nothing here touches a cell that is open floor except the foot stones, so doors,
 * links and routes are never built over (the foot stones keep off paths, links, water, openings and features).
 */
import { subSeed } from "../util/hash";
import { createPrng } from "../util/prng";
import { quarterTurn } from "../util/turn";
import { NEIGHBOURS4 as D4, cellKey as key } from "./gridGeometry";
import { ValueNoise } from "./noise";
import { massDepth, massFoot } from "./solidMass";

/** One piece shape on offer (tiles). `family` A = mass, cap = flat cap sheets, toe = foot stones. */
export interface WallShape {
  id: number;
  family: "A" | "cap" | "toe";
  /** Outline along its length at turn 0, across it, and height. */
  w: number;
  d: number;
  h: number;
  /** Pick weight (default 1). */
  weight?: number;
  /** Foot stones only: the lift (negative = sunk into the floor). */
  lift?: number;
  /**
   * The game draws this piece at quarter turns only (a tile: an in-between turn is drawn as the quarter turn below
   * it, docs/decisions.md), so the plan turns it in quarter turns and its outline here is the one the game draws.
   */
  quarterTurns?: boolean;
}

/** A rock cell beside the floor (the realizer's wall column). */
export interface WallFace {
  x: number;
  y: number;
  /** Bottom of the column and its top (absolute tiles). */
  base: number;
  top: number;
  /** Where the wall of this cell starts (the verifier closes it from here, 1.4 up): the floor beside it, or lower at a drop. */
  edgeBase?: number;
}

export interface CaveWallInput {
  seed: number;
  faces: ReadonlyArray<WallFace>;
  /** Level bounds (plan cells). */
  bounds: { x: number; y: number; w: number; h: number };
  /** A cell the mass may stand in: inside the level, solid rock. */
  rock: (x: number, y: number) => boolean;
  open: (x: number, y: number) => boolean;
  /** A floor cell a foot stone may lean into: floor, no path, link, water, feature, opening or step nearby. */
  toeOk: (x: number, y: number) => boolean;
  /** Surface of the floor at an open cell (absolute tiles). */
  floorTop: (x: number, y: number) => number;
  shapes: ReadonlyArray<WallShape>;
  /** Lowest ceiling over the level (Infinity when none): nothing rises through it. */
  ceiling: number;
  /**
   * Generator 4 (switch `solidCaveRock`, named after it so a search for the switch finds its rules): solid rock. Every
   * rock cell is filled from its foot up to its top with no see-through gap (no flat cap over empty rock, no
   * free-standing towers): upper courses are laid as layers, each piece resting on the highest rock already under its
   * whole outline; tops swell broadly and come down toward the level's edge.
   */
  solidCaveRock?: boolean;
}

export interface WallPiece {
  shape: number;
  family: "A" | "cap" | "toe";
  /** Centre in plan tiles, turn in plan degrees (multiple of 15), bottom (absolute tiles). */
  cx: number;
  cy: number;
  rot: number;
  base: number;
  /** Cells deep from the floor line (0 for a foot stone). */
  layer: number;
  /** Course in its tower (0 = on the ground). */
  course: number;
}

export interface CaveWallPlan {
  pieces: WallPiece[];
  /** Face cells ("x,y") no piece closes: the realizer still builds its block column there. */
  columns: Set<string>;
}

export const CAVE_WALL = {
  /** Pieces tried per uncovered sample point, and the least new area (sample points of 16 per cell) one must cover in
   * each pass: big pieces first, then what still fits, then small shapes for the corners. */
  tries: 9,
  passes: [12, 6],
  /** Tries to lay a piece over the middle of a face cell the passes left open. */
  closeTries: 60,
  minNewSmall: 1,
  /** Neighbouring pieces overlap by at least this much (tiles): a sample point counts as covered this far inside a piece. */
  overlap: 0.1,
  /** Cells this deep (or more) from the floor, and this far from the level edge, are closed by a flat cap at the
   * plateau height instead of towers (when the theme has cap sheets). */
  capDepth: 5,
  capEdge: 3,
  /** A face-course piece is at least this tall (the verifier wants the wall closed 1.4 above the floor). */
  minCourse0: 1.75,
  /** Turn either side of the wall's direction (15° steps) for pieces within two cells of the floor. */
  turnSteps: 2,
  /** Share of near-wall pieces turned broadside instead. */
  broadside: 0.12,
  /** Target top above the floor by depth (cells from the floor, 1 = the face cell), flat from the last entry on. */
  topByDepth: [2.2, 2.9, 3.5, 4.0],
  /** Wander of the skyline (tiles, ± half) from value noise. */
  skyline: 1.8,
  /** Course lift as a share of the piece below, and its sideways shift (tiles). */
  courseLift: [0.78, 0.95],
  courseShift: [0.25, 0.8],
  /** Most courses in a tower. */
  maxCourses: 4,
  /** Course 0 sinks this far below the base (tiles, 0..): tops of overlapping pieces never coincide. */
  sink: 0.15,
  /** Foot stones: cluster field threshold, chance inside a cluster, spacing, how far they lean in (tiles). */
  toeCluster: 0.38,
  toeChance: 0.9,
  toeSpacing: 1.5,
  /** Open floor needed straight out from the wall (cells) before a foot stone may lean in; wide stones need more. */
  toeRun: 4,
  /** Generator 4 (solid): broad swell of the skyline (cells across, tiles ± half), the share of the rise kept at 0, 1
   * and 2 cells from the level's edge, the least lift (point-tiles, 16 points a cell) a layer piece must add in each
   * pass, and how far over the target top it may stand. */
  swellScale: 7,
  swell: 1.6,
  edgeRise: [0.45, 0.65, 0.85],
  layerPasses: [16, 6],
  overshoot: 0.6,
} as const;

const D8: ReadonlyArray<readonly [number, number]> = [...D4, [1, 1], [-1, 1], [1, -1], [-1, -1]];
const SUB = 4;

interface Rect {
  cx: number;
  cy: number;
  rot: number;
  w: number;
  d: number;
}

function toLocal(r: Rect, px: number, py: number): [number, number] {
  const a = (r.rot * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = px - r.cx;
  const dy = py - r.cy;
  return [dx * c + dy * s, -dx * s + dy * c];
}

function inRect(r: Rect, px: number, py: number, grow = 0): boolean {
  const [u, v] = toLocal(r, px, py);
  return Math.abs(u) <= r.w / 2 + grow && Math.abs(v) <= r.d / 2 + grow;
}

function extent(rot: number, w: number, d: number): [number, number] {
  const r = (rot * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return [(w / 2) * c + (d / 2) * s, (w / 2) * s + (d / 2) * c];
}

function outlineFits(rock: (x: number, y: number) => boolean, r: Rect): boolean {
  const a = (r.rot * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // the verifier judges a piece by its axis-aligned box: it touches no open cell at all (0.08 margin), and
  // the outline itself, sampled out to 0.12 beyond, stays in rock
  const hw = r.w / 2 + 0.12;
  const hd = r.d / 2 + 0.12;
  for (const u of [-1, -0.5, 0, 0.5, 1])
    for (const v of [-1, 0, 1]) {
      const x = r.cx + u * hw * c - v * hd * s;
      const y = r.cy + u * hw * s + v * hd * c;
      if (!rock(Math.floor(x), Math.floor(y))) return false;
    }
  const [ex, ey] = extent(r.rot, r.w, r.d);
  for (let y = Math.floor(r.cy - ey - 0.08); y <= Math.floor(r.cy + ey + 0.08); y++)
    for (let x = Math.floor(r.cx - ex - 0.08); x <= Math.floor(r.cx + ex + 0.08); x++)
      if (!rock(x, y)) return false;
  return true;
}

interface Stored extends Rect {
  shape: WallShape;
  base: number;
  top: number;
}

/**
 * Plans a cave wall's pieces. The steps run in draw order (one stream, "cavewall"): each reads the wall's measures and
 * adds to its record (`CaveWall`: the pieces, the sample points they cover, the rock top under each point, the faces
 * still kept as columns), the one record that lives across the steps on purpose, as every piece is laid on or beside
 * the ones before it.
 */
export function planCaveWall(input: CaveWallInput): CaveWallPlan {
  const w = startCaveWall(input);
  if (w.mass.length === 0 && w.toes.length === 0) return { pieces: w.out, columns: w.columns };
  const sweep = sweepOrder(w);
  coverCourse0(w, sweep);
  closeOpenFaces(w);
  raiseLayers(w, sweep);
  raiseTowers(w);
  layCap(w);
  // a face cell that a piece closes needs no column
  for (const f of input.faces) if (w.closed(f)) w.columns.delete(`${f.x},${f.y}`);
  placeFootStones(w);
  return { pieces: w.out, columns: w.columns };
}

/** The wall's streams, the shapes by family, the depth of the band and its measures, and the record of its pieces. */
function startCaveWall(input: CaveWallInput) {
  const rng = createPrng(subSeed(input.seed, "cavewall"));
  const noise = new ValueNoise(subSeed(input.seed, "cavewall:skyline"));
  const toeNoise = new ValueNoise(subSeed(input.seed, "cavewall:toe"));
  // generator 4 (`solidCaveRock`): every rule below that reads `solid` is this switch's
  const solid = input.solidCaveRock === true;
  const swellNoise = new ValueNoise(subSeed(input.seed, "cavewall:swell"));
  const mass = input.shapes.filter((s) => s.family === "A");
  const caps = input.shapes.filter((s) => s.family === "cap");
  const toes = input.shapes.filter((s) => s.family === "toe");
  const out: WallPiece[] = [];
  const columns = new Set<string>();
  for (const f of input.faces) columns.add(`${f.x},${f.y}`);

  const { bounds } = input;
  const idx = (x: number, y: number): number => (y - bounds.y) * bounds.w + (x - bounds.x);
  const inLevel = (x: number, y: number): boolean =>
    x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.w && y < bounds.y + bounds.h;

  // depth from the floor (faces = 1) and the face each cell belongs to (its floor and ground)
  // (gen/solidMass.ts: the same depth, and below the same foot rule, the interior shell and the review use)
  const grid = { w: bounds.w, h: bounds.h };
  const { depth, nearest } = massDepth(
    grid,
    (i) => input.rock(bounds.x + (i % bounds.w), bounds.y + Math.floor(i / bounds.w)),
    input.faces.map((f) => idx(f.x, f.y)),
  );
  const depthOf = (x: number, y: number): number => (inLevel(x, y) ? (depth[idx(x, y)] as number) : 0);

  // inward direction (away from the floor) per face, and the floor beside it
  const inward = new Map<number, [number, number]>();
  const floorOf = new Map<number, number>();
  const floorLoOf = new Map<number, number>();
  for (const f of input.faces) {
    let sx = 0;
    let sy = 0;
    let hi: number | undefined;
    let lo: number | undefined;
    for (const [dx, dy] of D8)
      if (input.open(f.x + dx, f.y + dy)) {
        sx += dx;
        sy += dy;
      }
    // the wall closes the floor beside it: every open neighbour across an edge (else the diagonal ones); the mass
    // stands on the lowest and closes up from the highest
    for (const list of [D4, D8]) {
      for (const [dx, dy] of list)
        if (input.open(f.x + dx, f.y + dy)) {
          const t = input.floorTop(f.x + dx, f.y + dy);
          hi = Math.max(hi ?? -Infinity, t);
          lo = Math.min(lo ?? Infinity, t);
        }
      if (hi !== undefined) break;
    }
    const len = Math.hypot(sx, sy);
    inward.set(key(f.x, f.y), len > 0 ? [-sx / len, -sy / len] : [0, 0]);
    // beside a drop the wall starts lower than any floor next to it: the mass stands there and closes from there
    floorOf.set(key(f.x, f.y), Math.max(hi ?? f.base, f.edgeBase ?? -Infinity));
    floorLoOf.set(key(f.x, f.y), Math.min(lo ?? f.base, f.edgeBase ?? Infinity));
  }
  const faceOfCell = (x: number, y: number): WallFace | undefined => {
    const i = nearest[idx(x, y)] as number;
    return i >= 0 ? input.faces[i] : undefined;
  };
  const floorAt = (x: number, y: number): number => {
    const f = faceOfCell(x, y);
    return f ? (floorOf.get(key(f.x, f.y)) ?? f.base) : 0;
  };
  // the mass stands a quarter tile under the floor beside it: the floor tiles hide its foot, and the face is closed at
  // the verifier's 1.4 above the floor with a single course (the columns reached the lowest ground of the level; the
  // solid band needs nothing that deep to read as rock from above and inside)
  const faceGround = (x: number, y: number): number => {
    const f = faceOfCell(x, y);
    return (f ? (floorLoOf.get(key(f.x, f.y)) ?? f.base) : 0) - 0.25;
  };
  // generator 4: a rock cell's foot is never above the foot of a shallower neighbour, so the mass reaches down to the
  // lowest floor beside it wherever floors step (no gap under the rock behind a low stretch of floor)
  let solidGround: Float64Array | null = null;
  const groundAt = (x: number, y: number): number => {
    if (!solid || !inLevel(x, y)) return faceGround(x, y);
    if (!solidGround)
      solidGround = massFoot(grid, depth, (i) =>
        faceGround(bounds.x + (i % bounds.w), bounds.y + Math.floor(i / bounds.w)),
      );
    return (depth[idx(x, y)] as number) > 0 ? (solidGround[idx(x, y)] as number) : faceGround(x, y);
  };
  const wallAngle = (x: number, y: number): number => {
    const f = faceOfCell(x, y);
    const dir = f ? inward.get(key(f.x, f.y)) : undefined;
    if (!dir || (dir[0] === 0 && dir[1] === 0)) return 0;
    return (Math.atan2(dir[0], -dir[1]) * 180) / Math.PI; // the tangent (-dir.y, dir.x)
  };
  const targetTop = (x: number, y: number): number => {
    const d = Math.max(1, depthOf(Math.floor(x), Math.floor(y)));
    const t = CAVE_WALL.topByDepth;
    const rise = t[Math.min(d, t.length) - 1] as number;
    if (solid) {
      // generator 4: broad swells, not per-cell wander, and lower toward the level's edge (the mass thins out there)
      const e = edgeDist(Math.floor(x), Math.floor(y));
      const keep = e < CAVE_WALL.edgeRise.length ? (CAVE_WALL.edgeRise[e] as number) : 1;
      const swell =
        (swellNoise.sample(x / CAVE_WALL.swellScale, y / CAVE_WALL.swellScale) - 0.5) * 2 * CAVE_WALL.swell;
      return floorAt(Math.floor(x), Math.floor(y)) + Math.max(CAVE_WALL.minCourse0, (rise + swell) * keep);
    }
    const wander = (noise.sample(x / 3.5, y / 3.5) - 0.5) * CAVE_WALL.skyline;
    return floorAt(Math.floor(x), Math.floor(y)) + rise + wander;
  };

  // sample grid: SUB × SUB points per reachable rock cell
  const covered = new Uint8Array(bounds.w * bounds.h * SUB * SUB);
  const stored: Stored[] = [];
  const pointAt = (cell: number, k: number): [number, number] => {
    const cx = bounds.x + (cell % bounds.w);
    const cy = bounds.y + Math.floor(cell / bounds.w);
    return [cx + ((k % SUB) + 0.5) / SUB, cy + (Math.floor(k / SUB) + 0.5) / SUB];
  };
  // a point counts as covered only well inside a piece (CAVE_WALL.overlap), so neighbours must overlap, not just meet
  const newArea = (r: Rect): number => {
    let n = 0;
    const [ex, ey] = extent(r.rot, r.w, r.d);
    for (let y = Math.floor(r.cy - ey); y <= Math.floor(r.cy + ey); y++)
      for (let x = Math.floor(r.cx - ex); x <= Math.floor(r.cx + ex); x++) {
        if (!inLevel(x, y) || (depth[idx(x, y)] as number) === 0) continue;
        const cell = idx(x, y);
        for (let k = 0; k < SUB * SUB; k++) {
          if (covered[cell * SUB * SUB + k]) continue;
          const [px, py] = pointAt(cell, k);
          if (inRect(r, px, py, -CAVE_WALL.overlap)) n++;
        }
      }
    return n;
  };
  // generator 4 (solid): the top of the rock under each sample point, filled from the foot with no gap
  const reach = new Float64Array(solid ? bounds.w * bounds.h * SUB * SUB : 0).fill(-Infinity);
  const mark = (r: Rect, top = -Infinity): void => {
    const [ex, ey] = extent(r.rot, r.w, r.d);
    for (let y = Math.floor(r.cy - ey); y <= Math.floor(r.cy + ey); y++)
      for (let x = Math.floor(r.cx - ex); x <= Math.floor(r.cx + ex); x++) {
        if (!inLevel(x, y) || (depth[idx(x, y)] as number) === 0) continue;
        const cell = idx(x, y);
        for (let k = 0; k < SUB * SUB; k++) {
          const [px, py] = pointAt(cell, k);
          if (inRect(r, px, py, -CAVE_WALL.overlap)) {
            covered[cell * SUB * SUB + k] = 1;
            if (solid) reach[cell * SUB * SUB + k] = Math.max(reach[cell * SUB * SUB + k] as number, top);
          }
        }
      }
  };

  const weightedPick = (list: ReadonlyArray<WallShape>): WallShape => {
    let total = 0;
    for (const s of list) total += s.weight ?? 1;
    let r = rng.next() * total;
    for (const s of list) {
      r -= s.weight ?? 1;
      if (r <= 0) return s;
    }
    return list[list.length - 1] as WallShape;
  };
  /** A turn the game can draw the shape at: a 15° step, or a quarter turn for a piece drawn at quarter turns only. */
  const snap = (deg: number, shape: WallShape): number =>
    shape.quarterTurns === true ? quarterTurn(deg) : (((Math.round(deg / 15) * 15) % 360) + 360) % 360;

  const course0 = mass.filter((s) => s.h >= CAVE_WALL.minCourse0);
  const small = mass.filter((s) => s.h >= CAVE_WALL.minCourse0 && s.w * s.d <= 2.2);
  const ceilingOk = (base: number, h: number): boolean => base + h <= input.ceiling - 0.05;

  // the far part of a deep band is closed by a flat cap, not by towers (only with cap sheets, and never at the level edge)
  const edgeDist = (x: number, y: number): number =>
    Math.min(x - bounds.x, y - bounds.y, bounds.x + bounds.w - 1 - x, bounds.y + bounds.h - 1 - y);
  // (generator 4 builds no cap: a cap sheet over empty rock is see-through from the side)
  const capCell = (x: number, y: number): boolean =>
    !solid && caps.length > 0 && depthOf(x, y) >= CAVE_WALL.capDepth && edgeDist(x, y) >= CAVE_WALL.capEdge;

  /** Lays one course-0 piece over point (px, py) from `pool` (the best of `tries`), if one fits and adds enough. */
  const placeAt = (
    pool: ReadonlyArray<WallShape>,
    px: number,
    py: number,
    minNew: number,
    tries: number = CAVE_WALL.tries,
    anywhere = false,
  ): boolean => {
    if (pool.length === 0) return false;
    const cellX = Math.floor(px);
    const cellY = Math.floor(py);
    const d = depthOf(cellX, cellY);
    let best: { r: Rect; shape: WallShape; gain: number } | undefined;
    for (let t = 0; t < tries; t++) {
      const shape = weightedPick(pool);
      let rot: number;
      if (d <= 2) {
        const broad = rng.chance(CAVE_WALL.broadside);
        rot = snap(
          wallAngle(cellX, cellY) +
            rng.range(-CAVE_WALL.turnSteps, CAVE_WALL.turnSteps) * 15 +
            (broad ? 90 : 0),
          shape,
        );
      } else rot = snap(rng.range(0, 11) * 15, shape);
      // the point lies near the piece's upper-left (the sweep has covered what lies above and to the left); a piece
      // closing a face cell may lie any way round it
      const [hx, hy] = extent(rot, shape.w, shape.d);
      const cx = anywhere ? px + (rng.next() - 0.5) * hx * 1.6 : px + hx * (0.15 + rng.next() * 0.75);
      const cy = anywhere ? py + (rng.next() - 0.5) * hy * 1.6 : py + hy * (0.15 + rng.next() * 0.75);
      const r: Rect = { cx, cy, rot, w: shape.w, d: shape.d };
      if (!inRect(r, px, py, -CAVE_WALL.overlap) || !outlineFits(input.rock, r)) continue;
      const gain = newArea(r);
      if (gain < minNew) continue;
      if (!best || gain * (0.85 + rng.next() * 0.3) > best.gain) best = { r, shape, gain };
    }
    if (!best) return false;
    const { r, shape } = best;
    let ground = groundAt(cellX, cellY);
    // generator 4: the piece stands on the lowest foot under it, so no gap opens under any part of it
    if (solid) {
      const [ex, ey] = extent(r.rot, r.w, r.d);
      for (let y = Math.floor(r.cy - ey); y <= Math.floor(r.cy + ey); y++)
        for (let x = Math.floor(r.cx - ex); x <= Math.floor(r.cx + ex); x++)
          if (depthOf(x, y) > 0) ground = Math.min(ground, groundAt(x, y));
    }
    const base = ground - rng.next() * CAVE_WALL.sink;
    if (!ceilingOk(base, shape.h)) return false;
    mark(r, base + shape.h);
    stored.push({ ...r, shape, base, top: base + shape.h });
    out.push({
      shape: shape.id,
      family: "A",
      cx: r.cx,
      cy: r.cy,
      rot: r.rot,
      base,
      layer: Math.max(1, d),
      course: 0,
    });
    return true;
  };
  /**
   * The wall must be closed from the floor to 1.4 above it at the middle of every face cell (the verifier's test):
   * the pieces over the middle of the cell, lowest first, must stack up to there.
   */
  const closed = (f: WallFace): boolean => {
    const floor = floorOf.get(key(f.x, f.y)) ?? f.base;
    const px = f.x + 0.5;
    const py = f.y + 0.5;
    let reach = (floorLoOf.get(key(f.x, f.y)) ?? floor) + 0.1;
    // pieces over the middle of the cell, lowest first
    const over: Array<[number, number]> = [];
    // (the verifier wants the middle of the cell strictly inside the piece's box: a margin)
    for (const q of stored) if (inRect(q, px, py, -0.05)) over.push([q.base, q.top]);
    over.sort((a, b) => a[0] - b[0]);
    for (const [lo, hi] of over) {
      if (lo > reach + 0.02) break;
      reach = Math.max(reach, hi);
    }
    return reach >= floor + 1.45;
  };
  return {
    input,
    rng,
    toeNoise,
    solid,
    mass,
    caps,
    toes,
    out,
    columns,
    bounds,
    idx,
    inLevel,
    depth,
    depthOf,
    inward,
    floorAt,
    wallAngle,
    targetTop,
    covered,
    stored,
    pointAt,
    reach,
    mark,
    weightedPick,
    snap,
    course0,
    small,
    ceilingOk,
    capCell,
    placeAt,
    closed,
  };
}

type CaveWall = ReturnType<typeof startCaveWall>;

/**
 * The band's sample points (cell, sub-point, depth), swept row by row: each piece starts at the first bare point, so
 * the next one abuts it (a random order leaves gaps that only small pieces can close, and twice the pieces). The far
 * part a cap closes is left out.
 */
function sweepOrder({ bounds, depth, capCell }: CaveWall): ReadonlyArray<[number, number, number]> {
  const order: Array<[number, number, number]> = []; // cell, sub-point, depth
  for (let cell = 0; cell < bounds.w * bounds.h; cell++) {
    const d = depth[cell] as number;
    if (d === 0 || capCell(bounds.x + (cell % bounds.w), bounds.y + Math.floor(cell / bounds.w))) continue;
    for (let k = 0; k < SUB * SUB; k++) order.push([cell, k, d]);
  }
  return order.sort((a, b) => {
    const ay = Math.floor(a[0] / bounds.w) * SUB + Math.floor(a[1] / SUB);
    const by = Math.floor(b[0] / bounds.w) * SUB + Math.floor(b[1] / SUB);
    return ay - by || (a[0] % bounds.w) * SUB + (a[1] % SUB) - ((b[0] % bounds.w) * SUB + (b[1] % SUB));
  });
}

/** Course 0: cover the band, face first, in passes that ask less new area each time; stubborn corners last. */
function coverCourse0(w: CaveWall, shuffled: ReadonlyArray<[number, number, number]>): void {
  const { covered, pointAt, placeAt, course0, small } = w;
  for (const minNew of CAVE_WALL.passes)
    for (const [cell, k] of shuffled) {
      if (covered[cell * SUB * SUB + k]) continue;
      const [px, py] = pointAt(cell, k);
      placeAt(course0, px, py, minNew);
    }
  // stubborn corners: small shapes, any new area
  for (const [cell, k] of shuffled) {
    if (covered[cell * SUB * SUB + k]) continue;
    const [px, py] = pointAt(cell, k);
    placeAt(small.length > 0 ? small : course0, px, py, CAVE_WALL.minNewSmall);
  }
}

/**
 * A piece laid over the middle of any face cell that is not closed yet (`closed`), any way round; what still is not
 * keeps its column.
 */
function closeOpenFaces({ input, closed, placeAt, course0 }: CaveWall): void {
  for (const f of input.faces)
    if (!closed(f)) placeAt(course0, f.x + 0.5, f.y + 0.5, 0, CAVE_WALL.closeTries, true);
}

/** Further courses (generators 2-3): towers rise toward the target top, lifted on the piece below, shifted and turned. */
function raiseTowers(w: CaveWall): void {
  const { input, solid, stored, targetTop, weightedPick, mass, rng, ceilingOk, snap, out, depthOf } = w;
  const towers = solid ? [] : [...stored];
  for (const base of towers) {
    let cur = base;
    for (let course = 1; course < CAVE_WALL.maxCourses; course++) {
      const target = targetTop(cur.cx, cur.cy);
      if (cur.top >= target - 0.4) break;
      let placed = false;
      for (let attempt = 0; attempt < 7 && !placed; attempt++) {
        const shape = weightedPick(mass);
        const lift =
          cur.shape.h *
          (CAVE_WALL.courseLift[0] + rng.next() * (CAVE_WALL.courseLift[1] - CAVE_WALL.courseLift[0]));
        const nb = cur.base + lift;
        if (!ceilingOk(nb, shape.h)) continue;
        const shift =
          CAVE_WALL.courseShift[0] + rng.next() * (CAVE_WALL.courseShift[1] - CAVE_WALL.courseShift[0]);
        const ang = rng.next() * Math.PI * 2;
        const r: Rect = {
          cx: cur.cx + Math.cos(ang) * shift,
          cy: cur.cy + Math.sin(ang) * shift,
          rot: snap(cur.rot + rng.range(-2, 2) * 15, shape),
          w: shape.w,
          d: shape.d,
        };
        // it stands on the one below: its centre lies over it
        if (!inRect(cur, r.cx, r.cy, -0.1)) continue;
        if (!outlineFits(input.rock, r)) continue;
        const nxt: Stored = { ...r, shape, base: nb, top: nb + shape.h };
        stored.push(nxt);
        out.push({
          shape: shape.id,
          family: "A",
          cx: r.cx,
          cy: r.cy,
          rot: r.rot,
          base: nb,
          layer: Math.max(1, depthOf(Math.floor(r.cx), Math.floor(r.cy))),
          course,
        });
        cur = nxt;
        placed = true;
      }
      if (!placed) break;
    }
  }
}

/** The cap (generators 2-3): flat sheets laid edge to edge over the far part of the band, at the plateau height. */
function layCap({ input, caps, bounds, capCell, floorAt, out, depthOf }: CaveWall): void {
  if (caps.length > 0) {
    const done = new Set<number>();
    const forms: Array<{ shape: WallShape; cw: number; ch: number; rot: number }> = [];
    for (const s of caps) {
      forms.push({ shape: s, cw: s.w, ch: s.d, rot: 0 });
      if (Math.abs(s.w - s.d) > 0.05) forms.push({ shape: s, cw: s.d, ch: s.w, rot: 90 });
    }
    forms.sort((a, b) => b.cw * b.ch - a.cw * a.ch);
    const plateau = CAVE_WALL.topByDepth[CAVE_WALL.topByDepth.length - 1] as number;
    for (let y = bounds.y; y < bounds.y + bounds.h; y++)
      for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
        if (!capCell(x, y) || done.has(key(x, y))) continue;
        for (const f of forms) {
          const nw = Math.round(f.cw);
          const nh = Math.round(f.ch);
          if (Math.abs(f.cw - nw) > 0.05 || Math.abs(f.ch - nh) > 0.05) continue;
          let fits = true;
          for (let yy = y; yy < y + nh && fits; yy++)
            for (let xx = x; xx < x + nw; xx++)
              if (!capCell(xx, yy) || done.has(key(xx, yy))) {
                fits = false;
                break;
              }
          if (!fits) continue;
          const top = Math.round((floorAt(x, y) + plateau) * 4) / 4;
          if (top > input.ceiling - 0.05) continue;
          for (let yy = y; yy < y + nh; yy++) for (let xx = x; xx < x + nw; xx++) done.add(key(xx, yy));
          out.push({
            shape: f.shape.id,
            family: "cap",
            cx: x + nw / 2,
            cy: y + nh / 2,
            rot: f.rot,
            base: top - f.shape.h,
            layer: depthOf(x, y),
            course: 0,
          });
          break;
        }
      }
  }
}

/** Foot stones: low stones leaning into the floor in loose clusters. */
function placeFootStones({
  input,
  toes,
  rng,
  inward,
  toeNoise,
  weightedPick,
  snap,
  solid,
  out,
}: CaveWall): void {
  const runOut = (f: WallFace, dir: [number, number], need: number): boolean => {
    for (let i = 1; i <= need; i++) {
      const ox = Math.floor(f.x + 0.5 - dir[0] * i);
      const oy = Math.floor(f.y + 0.5 - dir[1] * i);
      if (!input.open(ox, oy) || (i <= 1 && !input.toeOk(ox, oy))) return false;
    }
    return true;
  };
  const toePlaced: Array<{ cx: number; cy: number }> = [];
  if (toes.length > 0)
    for (const f of rng.shuffle(input.faces)) {
      const raw = inward.get(key(f.x, f.y));
      if (!raw || (raw[0] === 0 && raw[1] === 0)) continue;
      // a stone lies against a straight stretch: the wall's normal snapped to an axis, and the face's open neighbour
      // on that axis must really be floor
      const dir: [number, number] =
        Math.abs(raw[0]) >= Math.abs(raw[1]) ? [Math.sign(raw[0]), 0] : [0, Math.sign(raw[1])];
      if (!input.open(f.x - dir[0], f.y - dir[1])) continue;
      if (toeNoise.sample(f.x / 4.5, f.y / 4.5) < CAVE_WALL.toeCluster || !rng.chance(CAVE_WALL.toeChance))
        continue;
      const sh = weightedPick(toes);
      if (!runOut(f, dir, CAVE_WALL.toeRun)) continue;
      const tx = -dir[1];
      const ty = dir[0];
      const slide = (rng.next() - 0.5) * 0.8;
      // the stone's long side lies along the wall (turned within 30°), standing wholly on the floor against it
      const angle = (Math.atan2(ty, tx) * 180) / Math.PI;
      const turn = rng.range(-2, 2) * 15;
      const rot = snap(angle + (sh.w >= sh.d ? 0 : 90) + turn, sh);
      const a = ((rot - angle) * Math.PI) / 180;
      const ext = sh.w * Math.abs(Math.sin(a)) + sh.d * Math.abs(Math.cos(a));
      const reach = 0.5 + ext / 2 + 0.2;
      const cx = f.x + 0.5 - dir[0] * reach + tx * slide;
      const cy = f.y + 0.5 - dir[1] * reach + ty * slide;
      if (toePlaced.some((p) => Math.hypot(p.cx - cx, p.cy - cy) < CAVE_WALL.toeSpacing)) continue;
      const ox = Math.floor(cx);
      const oy = Math.floor(cy);
      if (!input.open(ox, oy) || !input.toeOk(ox, oy)) continue;
      // its whole box (plus a hand's width) stands on floor, clear of every wall and corner
      const [bx, by] = extent(rot, sh.w, sh.d);
      let clear = true;
      // the stone rests on the highest floor under its box (a stone never sinks into a step)
      let ground = input.floorTop(ox, oy);
      for (let yy = Math.floor(cy - by - 0.15); yy <= Math.floor(cy + by + 0.15) && clear; yy++)
        for (let xx = Math.floor(cx - bx - 0.15); xx <= Math.floor(cx + bx + 0.15); xx++) {
          if (!input.open(xx, yy)) {
            clear = false;
            break;
          }
          // generator 4: a stone never straddles a shelf step (it would hang over the lower side)
          if (solid && Math.abs(input.floorTop(xx, yy) - input.floorTop(ox, oy)) > 0.01) {
            clear = false;
            break;
          }
          ground = Math.max(ground, input.floorTop(xx, yy));
        }
      if (!clear) continue;
      toePlaced.push({ cx, cy });
      out.push({
        shape: sh.id,
        family: "toe",
        cx,
        cy,
        rot,
        base: ground + (sh.lift ?? 0),
        layer: 0,
        course: 0,
      });
    }
}

/**
 * Generator 4: further courses as layers over the whole band, each piece resting on the rock under it. A piece rests on
 * the lowest rock top under its outline (so nothing hangs over a gap), and is chosen by how much it lifts the points
 * under it toward their target, less what it stands over the target; big lifts first, then what still fits.
 */
function raiseLayers(w: CaveWall, shuffled: ReadonlyArray<[number, number, number]>): void {
  const { input, solid, bounds, pointAt, targetTop, inLevel, depth, idx, depthOf, weightedPick, mass } = w;
  const { rng, snap, wallAngle, reach, ceilingOk, mark, stored, out, closed } = w;
  if (!solid) return;
  const PTS = SUB * SUB;
  const tgt = new Float64Array(bounds.w * bounds.h * PTS);
  const pts: number[] = [];
  for (const [cell, k] of shuffled) {
    const [px, py] = pointAt(cell, k);
    tgt[cell * PTS + k] = targetTop(px, py);
    pts.push(cell * PTS + k);
  }
  const under = (r: Rect): Array<{ p: number; inner: boolean }> => {
    const list: Array<{ p: number; inner: boolean }> = [];
    const [ex, ey] = extent(r.rot, r.w, r.d);
    for (let y = Math.floor(r.cy - ey); y <= Math.floor(r.cy + ey); y++)
      for (let x = Math.floor(r.cx - ex); x <= Math.floor(r.cx + ex); x++) {
        if (!inLevel(x, y) || (depth[idx(x, y)] as number) === 0) continue;
        const cell = idx(x, y);
        for (let k = 0; k < PTS; k++) {
          const [px, py] = pointAt(cell, k);
          if (!inRect(r, px, py)) continue;
          list.push({ p: cell * PTS + k, inner: inRect(r, px, py, -CAVE_WALL.overlap) });
        }
      }
    return list;
  };
  const layAt = (p: number, minGain: number, course: number, at?: readonly [number, number]): boolean => {
    const cell = Math.floor(p / PTS);
    const [px, py] = at ?? pointAt(cell, p % PTS);
    const cellX = Math.floor(px);
    const cellY = Math.floor(py);
    const d = depthOf(cellX, cellY);
    let best: { r: Rect; shape: WallShape; base: number; score: number } | undefined;
    for (let t = 0; t < (at ? CAVE_WALL.closeTries : CAVE_WALL.tries); t++) {
      const shape = weightedPick(mass);
      const rot =
        d <= 2
          ? snap(wallAngle(cellX, cellY) + rng.range(-CAVE_WALL.turnSteps, CAVE_WALL.turnSteps) * 15, shape)
          : snap(rng.range(0, 11) * 15, shape);
      const [hx, hy] = extent(rot, shape.w, shape.d);
      // a piece closing a face cell may lie any way round its middle; the sweep's lie near the point's upper left
      const r: Rect = at
        ? {
            cx: px + (rng.next() - 0.5) * hx * 1.6,
            cy: py + (rng.next() - 0.5) * hy * 1.6,
            rot,
            w: shape.w,
            d: shape.d,
          }
        : {
            cx: px + hx * (0.15 + rng.next() * 0.75),
            cy: py + hy * (0.15 + rng.next() * 0.75),
            rot,
            w: shape.w,
            d: shape.d,
          };
      if (!inRect(r, px, py, -CAVE_WALL.overlap) || !outlineFits(input.rock, r)) continue;
      const pts0 = under(r);
      let base = Infinity;
      let ok = true;
      for (const q of pts0) {
        const v = reach[q.p] as number;
        // nothing under a point of its outline: it would hang over a gap
        if (v === -Infinity) {
          ok = false;
          break;
        }
        base = Math.min(base, v);
      }
      if (!ok || !Number.isFinite(base)) continue;
      base -= 0.05;
      const top = base + shape.h;
      if (!ceilingOk(base, shape.h)) continue;
      let gain = 0;
      let over = 0;
      for (const q of pts0) {
        if (!q.inner) continue;
        const v = reach[q.p] as number;
        const g = tgt[q.p] as number;
        gain += Math.max(0, Math.min(top, g + 0.3) - v);
        over += Math.max(0, top - g - CAVE_WALL.overshoot);
      }
      const score = gain - 2 * over;
      if (score < minGain) continue;
      if (!best || score * (0.85 + rng.next() * 0.3) > best.score) best = { r, shape, base, score };
    }
    if (!best) return false;
    const { r, shape, base } = best;
    mark(r, base + shape.h);
    stored.push({ ...r, shape, base, top: base + shape.h });
    out.push({
      shape: shape.id,
      family: "A",
      cx: r.cx,
      cy: r.cy,
      rot: r.rot,
      base,
      layer: Math.max(1, d),
      course,
    });
    return true;
  };
  for (let course = 1; course <= CAVE_WALL.maxCourses; course++) {
    let placed = 0;
    for (const minGain of CAVE_WALL.layerPasses)
      for (const p of pts) {
        const v = reach[p] as number;
        if (v === -Infinity || v >= (tgt[p] as number) - 0.35) continue;
        if (layAt(p, minGain, course)) placed++;
      }
    if (placed === 0) break;
  }
  // a face the layers left open (beside a raised shelf the course-0 piece is too low): a piece over its middle
  for (const f of input.faces)
    for (let k = 0; k < 2 && !closed(f); k++)
      layAt(idx(f.x, f.y) * PTS, -Infinity, CAVE_WALL.maxCourses + 1, [f.x + 0.5, f.y + 0.5]);
}
