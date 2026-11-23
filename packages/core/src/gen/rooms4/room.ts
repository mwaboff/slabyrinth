/**
 * The room being dressed (gen/rooms4): its floor cells, doors and the cleared zone round them, its walls, corners and
 * corner posts, what is placed so far, which cells are taken (blocking) or used (not blocking), and the way from the
 * doors (`walk`, `keepsWay`). The placers (wall.ts, things.ts, lights.ts) read and write it; nothing else holds state.
 */
import type { FeatureType, Side } from "../../contracts/plan";
import { subSeed } from "../../util/hash";
import { createPrng, type Prng } from "../../util/prng";
import type { GeneratedPlacement, PlacementGrid } from "../placementGrid";
import {
  EDGE_OPENING,
  EDGE_STAIR,
  EDGE_WALL,
  FLAG_FEATURE,
  FLAG_LINK,
  FLAG_NO_FLOOR,
  INWARD,
  SIDES,
  cellKey,
  stepSide,
  wallSides,
} from "../gridGeometry";
import { isNaturalWallStyle } from "../wallStyles";
import type { RoomOrder } from "../roomTraits";
import type { Family } from "./recipes";

/**
 * Where a piece stands in its footprint: pushed against the wall it backs onto (and the side wall in a corner) so its
 * back touches the wall and nothing of it reaches into the next cell. The generator-3 rule shifts every wall piece 0.45
 * off its wall, which leaves a piece half in the next row and overlapping what stands there. A wall strip hosted in
 * this very cell takes half of it. Null when the piece is too big for the room between its walls. `postAt` (generator 5,
 * RoomOpts.junctionPosts): a post stands at this vertex of the wall the piece backs onto (where another wall meets it
 * from outside the room, a T), and takes the 0.5 square there as a corner post does.
 */
export function touchShift(
  grid: PlacementGrid,
  at: readonly [number, number],
  size: readonly [number, number],
  rot: number,
  ext: { wMax: number; dMax: number },
  postAt?: (vx: number, vy: number) => boolean,
): [number, number] | null {
  const [x0, y0] = at;
  const [x1, y1] = [at[0] + size[0] - 1, at[1] + size[1] - 1];
  const swap = rot === 90 || rot === 270;
  // the largest variant of the role decides the fit (a smaller one then stands a little off the wall, never in it)
  const exX = swap ? ext.dMax : ext.wMax;
  const exY = swap ? ext.wMax : ext.dMax;
  // generator 5: a window's frame stands in the wall line, so a piece keeps off it as off the wall
  const wall = (x: number, y: number, s: Side): { wall: boolean; hosted: boolean } => ({
    wall: grid.edge(x, y, s) === EDGE_WALL || grid.windowOn?.(x, y, s) === true,
    hosted: grid.wallHosted?.(x, y, s) === true,
  });
  // the corner post where two walls meet takes the 0.5 square of the corner: a piece in a corner starts clear of it
  const axis = (
    n: number,
    lo: { wall: boolean; hosted: boolean },
    hi: { wall: boolean; hosted: boolean },
    ex: number,
    post: boolean,
    junction: readonly [boolean, boolean] = [false, false],
  ): number | null => {
    const [jLo, jHi] = junction;
    const loStop = lo.wall || jLo;
    const hiStop = hi.wall || jHi;
    const cLo = (lo.wall && (lo.hosted || post)) || jLo ? 0.5 : 0;
    const cHi = (hi.wall && (hi.hosted || post)) || jHi ? 0.5 : 0;
    if (ex > n - cLo - cHi + (post || jLo || jHi ? 0.15 : 0.06)) return null;
    if (loStop && !hiStop) return cLo + ex / 2 - n / 2;
    if (hiStop && !loStop) return n / 2 - cHi - ex / 2;
    if (loStop && hiStop) return (cLo - cHi) / 2;
    return 0;
  };
  const anyOf = (
    cells: ReadonlyArray<readonly [number, number]>,
    s: Side,
  ): { wall: boolean; hosted: boolean } => {
    let wl = false;
    let ho = false;
    for (const [x, y] of cells) {
      const r = wall(x, y, s);
      if (r.wall) wl = true;
      if (r.wall && r.hosted) ho = true;
    }
    return { wall: wl, hosted: ho };
  };
  const col = (x: number): Array<[number, number]> =>
    Array.from({ length: size[1] }, (_, i) => [x, y0 + i] as [number, number]);
  const row = (y: number): Array<[number, number]> =>
    Array.from({ length: size[0] }, (_, i) => [x0 + i, y] as [number, number]);
  const wl = anyOf(col(x0), "W");
  const we = anyOf(col(x1), "E");
  const wn = anyOf(row(y0), "N");
  const ws = anyOf(row(y1), "S");
  const corner = (wl.wall || we.wall) && (wn.wall || ws.wall);
  // only the axis along the backing wall needs the corner clearance (the piece touches the backing wall itself)
  const alongX = rot === 0 || rot === 180;
  // the posts at the ends of the backing wall where other walls meet it (generator 5)
  const ends = (line: number | null, x: boolean): [boolean, boolean] =>
    postAt === undefined || line === null
      ? [false, false]
      : x
        ? [postAt(x0, line), postAt(x1 + 1, line)]
        : [postAt(line, y0), postAt(line, y1 + 1)];
  const ox = axis(
    size[0],
    wl,
    we,
    exX,
    corner && alongX,
    alongX ? ends(wn.wall ? y0 : ws.wall ? y1 + 1 : null, true) : undefined,
  );
  const oy = axis(
    size[1],
    wn,
    ws,
    exY,
    corner && !alongX,
    alongX ? undefined : ends(wl.wall ? x0 : we.wall ? x1 + 1 : null, false),
  );
  if (ox === null || oy === null) return null;
  const c = (v: number): number => Math.max(-0.5, Math.min(0.5, Math.round(v * 100) / 100));
  return [c(ox), c(oy)];
}

/** A piece the recipe placed (furniture, a seat), as the later steps read it. */
export interface Placed {
  type: FeatureType;
  at: [number, number];
  size: [number, number];
  centre: [number, number];
  side: Side;
  /** Family of the small things on it; "none" for none. */
  family: Family | "none";
  height: number;
  light: boolean;
  /** The variant the piece was placed as (a small crate), so its top height is the variant's. */
  variant?: string;
  /** Generator 5: a light belongs on its top (a nightstand, a desk, a table, a bar segment: gen/roomTraits.ts). */
  wantsLight?: boolean;
  /**
   * Generator 5: it stands free of the wall on `side` (a chest at a bed's foot, a free-standing counter), so the things
   * on it are not kept off that side as they are off a wall behind.
   */
  unbacked?: boolean;
}

/** Generator 5's reading of a room (gen/rooms4/furnish.ts); absent, the room is read as generator 4 reads it. */
export interface RoomOpts {
  /** Is there a window in the wall on the cell's side? A desk may stand under it, nothing tall across it. */
  windowOn?: (x: number, y: number, side: Side) => boolean;
  /**
   * A room of fewer floor cells keeps only a landing at each door (the doorway cell: a tile deep, the door's width),
   * not the cells either side and two deep, so a small room still has floor to furnish.
   */
  compactDoorsBelow?: number;
  /**
   * A floor light (a brazier, candles) keeps a cell from anything the level already holds there (the plan's own
   * pieces: an altar's outline overhangs its cells), so it never stands in it.
   */
  floorLightsApart?: boolean;
  /** A wall meeting the room's wall from outside (a T) has a post at the joint, as a corner does (touchShift). */
  junctionPosts?: boolean;
  /** How squarely loose things and seats are set (gen/rooms4/order.ts, switch placementOrder). */
  order?: RoomOrder;
  /**
   * Generator 5 (floorGroups): a seat or a bed keeps a free cell beside it, reached from the doors, that nothing blocking
   * takes later (the free tile in front of every station), so no seat is boxed in by what comes after it.
   */
  standingRoom?: boolean;
  /**
   * Generator 5 (bedsideLights, a bright room): a group whose companion carries a light (a bed's nightstand) keeps a
   * cell at its head for a standing light (`lightSpots`), so the lining and the standing room never take it first.
   */
  bedsideLights?: boolean;
  /**
   * Generator 5 (freeCounters): a free-standing anchor (a shop counter, a bar) may keep its staff lane along a window
   * wall, and with no room for a lane two rows deep stands free with one row behind it before it takes a wall.
   */
  freeCounters?: boolean;
  /** Generator 5 (freeCounters): the cell inside the main door, the room's entry when it is one of its doorways. */
  mainDoor?: readonly [number, number];
  /**
   * Generator 5 (sensibleLights): only lights that make sense here stand in the room: no outdoor piece
   * (gen/pieceFacts.ts `setting`), an open fire only where `fire` (the kind's row), and nothing free-standing off the
   * walls but the room's focal piece.
   */
  sensibleLights?: { readonly fire: boolean };
}

export class Room {
  readonly rng: Prng;
  readonly out: GeneratedPlacement[] = [];
  readonly placed: Placed[] = [];
  readonly taken = new Set<number>();
  readonly used = new Set<number>();
  readonly inRoom = new Set<number>();
  readonly cells: Array<[number, number]> = [];
  readonly thresholds: Array<[number, number]> = [];
  readonly zone = new Set<number>();
  readonly wallPairs: Array<[number, number, Side]> = [];
  readonly cornerPairs = new Set<number>();
  /** Vertices of the room's inner corners (a corner post stands there). */
  readonly posts: Array<[number, number]> = [];
  /** Wall spots (cell key × 4 + side) a shelf plank hangs on, and those a wall torch took. */
  readonly hung = new Set<number>();
  readonly torched = new Set<number>();
  /** Generator 5: the room's cells with a window in the wall on a side, and the side (no wall pair: an opening). */
  readonly windowPairs: Array<[number, number, Side]> = [];
  /** The same as keys (cell key × 4 + side index). */
  readonly windows = new Set<number>();
  /** Generator 5 (RoomOpts.bedsideLights): cells kept for a group's standing light (held in `used` until it stands). */
  readonly lightSpots = new Set<number>();

  /**
   * Generator 5 (RoomOpts.junctionPosts): does a post stand at vertex (vx, vy): walls meet there both ways (a corner, a
   * T, a cross)? Undefined for a room read as generator 4 reads it; the placers hand it to touchShift.
   */
  get postAt(): ((vx: number, vy: number) => boolean) | undefined {
    if (this.opts.junctionPosts !== true) return undefined;
    const g = this.grid;
    // a built wall: natural rock has no post where two faces meet
    const w = (x: number, y: number, s: Side): boolean =>
      g.inBounds(x, y) && g.edge(x, y, s) === EDGE_WALL && !isNaturalWallStyle(g.wallStyle?.(x, y, s));
    return (vx, vy) =>
      (w(vx, vy, "N") || w(vx, vy - 1, "S") || w(vx - 1, vy, "N") || w(vx - 1, vy - 1, "S")) &&
      (w(vx, vy, "W") || w(vx - 1, vy, "E") || w(vx, vy - 1, "W") || w(vx - 1, vy - 1, "E"));
  }

  /** Is there a window in the wall on side `s` of the cell (generator 5; never at generator 4)? */
  windowAt(x: number, y: number, s: Side): boolean {
    return this.windows.has(cellKey(x, y) * 4 + SIDES.indexOf(s));
  }
  /** Generator 5: the door edges of the room (a doorway's cells and the side the opening is on). */
  readonly doorPairs: Array<[number, number, Side]> = [];

  /** Is the point within 0.9 of a corner post (0.5 square from the vertex, and the width of the thing, turned)? */
  nearPost(px: number, py: number): boolean {
    if (this.posts.some(([vx, vy]) => Math.abs(px - vx) < 0.9 && Math.abs(py - vy) < 0.9)) return true;
    // generator 5: the posts where other walls meet the room's walls from outside (a T) too
    const at = this.postAt;
    if (at === undefined) return false;
    for (const vx of [Math.floor(px), Math.ceil(px)])
      for (const vy of [Math.floor(py), Math.ceil(py)])
        if (Math.abs(px - vx) < 0.9 && Math.abs(py - vy) < 0.9 && at(vx, vy)) return true;
    return false;
  }
  readonly lights: Array<[number, number]> = [];
  /** The wall lights this room hung (cells), for their rhythm (generator 5). */
  readonly wallLights: Array<[number, number]> = [];
  centroid: [number, number] = [0, 0];
  entry: [number, number] = [0, 0];
  reach = new Set<number>();
  capped = false;
  blockCells = 0;

  constructor(
    readonly grid: PlacementGrid,
    readonly areaIndex: number,
    areaCells: ReadonlyArray<readonly [number, number]>,
    seed: number,
    readonly remaining: number,
    readonly opts: RoomOpts = {},
  ) {
    this.rng = createPrng(subSeed(seed, "room4"));
    const sorted = areaCells.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (const [x, y] of sorted) {
      if (!grid.inBounds(x, y) || grid.area(x, y) !== areaIndex || !grid.isFloor(x, y)) continue;
      if ((grid.flags(x, y) & (FLAG_LINK | FLAG_NO_FLOOR)) !== 0) continue;
      this.cells.push([x, y]);
      this.inRoom.add(cellKey(x, y));
    }
    let sx = 0;
    let sy = 0;
    for (const [x, y] of this.cells) {
      sx += x + 0.5;
      sy += y + 0.5;
      const walls = wallSides(grid, x, y);
      for (const s of walls) this.wallPairs.push([x, y, s]);
      if (SIDES.some((s, i) => walls.includes(s) && walls.includes(SIDES[(i + 1) % 4] as Side)))
        this.cornerPairs.add(cellKey(x, y));
      // the vertex of each inner corner: its post takes the 0.5 square beside it
      for (const v of ["N", "S"] as const)
        for (const h of ["W", "E"] as const)
          if (walls.includes(v) && walls.includes(h))
            this.posts.push([h === "E" ? x + 1 : x, v === "S" ? y + 1 : y]);
    }
    const n = Math.max(1, this.cells.length);
    this.centroid = [sx / n, sy / n];
    this.findThresholds();
    this.entry = this.thresholds.length > 0 ? this.meanOf(this.thresholds) : this.centroid;
    const main = opts.mainDoor;
    if (main !== undefined && this.thresholds.some(([x, y]) => x === main[0] && y === main[1]))
      this.entry = [main[0] + 0.5, main[1] + 0.5];
    this.reach = this.walk(new Set());
    for (const [lx, ly] of grid.lightCells?.() ?? [])
      if (this.inRoom.has(cellKey(lx, ly))) this.lights.push([lx, ly]);
  }

  /** The mean of the cells' centres. */
  meanOf(list: ReadonlyArray<readonly [number, number]>): [number, number] {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of list) {
      sx += x + 0.5;
      sy += y + 0.5;
    }
    return [sx / list.length, sy / list.length];
  }

  /** Cells at the doors, flights of steps and open sides of the room; a cleared zone round each. */
  private findThresholds(): void {
    const g = this.grid;
    const seen = new Set<number>();
    const compact = this.cells.length < (this.opts.compactDoorsBelow ?? 0);
    for (const [x, y] of this.cells) {
      for (const s of SIDES) {
        const e = g.edge(x, y, s);
        const [nx, ny] = stepSide(x, y, s);
        // generator 5: a window is an opening in the wall but no way in: it gets no landing, and a low piece may back
        // onto it (a desk under the light)
        if (e === EDGE_OPENING && this.opts.windowOn?.(x, y, s) === true) {
          this.windowPairs.push([x, y, s]);
          this.windows.add(cellKey(x, y) * 4 + SIDES.indexOf(s));
          continue;
        }
        if (e === EDGE_OPENING) this.doorPairs.push([x, y, s]);
        let door = e === EDGE_OPENING || e === EDGE_STAIR;
        if (!door && e === 0 && g.inBounds(nx, ny) && !this.inRoom.has(cellKey(nx, ny)))
          door = g.isFloor(nx, ny) || (g.flags(nx, ny) & FLAG_LINK) !== 0;
        if (
          !door &&
          g.inBounds(nx, ny) &&
          (g.flags(nx, ny) & FLAG_LINK) !== 0 &&
          !this.inRoom.has(cellKey(nx, ny))
        )
          door = true;
        if (!door) continue;
        if (!seen.has(cellKey(x, y))) {
          seen.add(cellKey(x, y));
          this.thresholds.push([x, y]);
        }
        const inward = INWARD[s];
        if (compact) {
          // a landing: the doorway cell, a tile deep and the door's width
          this.zone.add(cellKey(x, y));
          continue;
        }
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) this.zone.add(cellKey(x + dx, y + dy));
        this.zone.add(cellKey(x + inward[0] * 2, y + inward[1] * 2));
      }
    }
  }

  blocked(x: number, y: number): boolean {
    return this.taken.has(cellKey(x, y)) || (this.grid.flags(x, y) & FLAG_FEATURE) !== 0;
  }

  /** The room cells reachable from its doors when `extra` is also blocked. */
  walk(extra: ReadonlySet<number>): Set<number> {
    const seen = new Set<number>();
    const queue: Array<[number, number]> = [];
    const open = (x: number, y: number): boolean =>
      this.inRoom.has(cellKey(x, y)) && !this.blocked(x, y) && !extra.has(cellKey(x, y));
    for (const [x, y] of this.thresholds)
      if (open(x, y) && !seen.has(cellKey(x, y))) {
        seen.add(cellKey(x, y));
        queue.push([x, y]);
      }
    if (queue.length === 0) {
      const first = this.cells.find(([x, y]) => open(x, y));
      if (first) {
        seen.add(cellKey(first[0], first[1]));
        queue.push([first[0], first[1]]);
      }
    }
    for (let h = 0; h < queue.length; h++) {
      const [x, y] = queue[h] as [number, number];
      for (const s of SIDES) {
        if (this.grid.edge(x, y, s) === EDGE_WALL) continue;
        const [nx, ny] = stepSide(x, y, s);
        if (!open(nx, ny) || seen.has(cellKey(nx, ny))) continue;
        seen.add(cellKey(nx, ny));
        queue.push([nx, ny]);
      }
    }
    return seen;
  }

  /** May these cells be blocked: every cell still reachable from the doors stays reachable. */
  keepsWay(cells: ReadonlyArray<readonly [number, number]>): Set<number> | null {
    const extra = new Set(cells.map(([x, y]) => cellKey(x, y)));
    const after = this.walk(extra);
    let lost = 0;
    for (const k of this.reach) if (!after.has(k) && !extra.has(k)) lost++;
    return lost === 0 ? after : null;
  }

  /**
   * Generator 5 (RoomOpts.standingRoom): keep a free cell beside a station (a seat, a bed) on these cells: the one it
   * faces first (`front`), else any beside it reached from the doors, kept clear of blockers. False when none is free.
   */
  keepStanding(cells: ReadonlyArray<readonly [number, number]>, front?: Side): boolean {
    if (this.opts.standingRoom !== true) return true;
    const own = new Set(cells.map(([x, y]) => cellKey(x, y)));
    const sides = front === undefined ? SIDES : [front, ...SIDES.filter((s) => s !== front)];
    for (const s of sides)
      for (const [x, y] of cells) {
        if (this.grid.edge(x, y, s) === EDGE_WALL) continue;
        const [nx, ny] = stepSide(x, y, s);
        const k = cellKey(nx, ny);
        if (own.has(k) || !this.inRoom.has(k) || this.blocked(nx, ny) || !this.reach.has(k)) continue;
        if (this.lightSpots.has(k)) continue;
        this.zone.add(k);
        return true;
      }
    return false;
  }

  free(x: number, y: number): boolean {
    const k = cellKey(x, y);
    return this.inRoom.has(k) && !this.taken.has(k) && !this.used.has(k) && !this.grid.occupied(x, y);
  }

  oneHeight(cells: ReadonlyArray<readonly [number, number]>): boolean {
    const g = this.grid;
    if (!g.height || cells.length === 0) return true;
    const first = cells[0] as readonly [number, number];
    const h0 = g.height(first[0], first[1]);
    return cells.every(([x, y]) => g.height?.(x, y) === h0);
  }

  push(p: GeneratedPlacement): boolean {
    if (this.out.length >= this.remaining) {
      this.capped = true;
      return false;
    }
    this.out.push(p);
    return true;
  }

  /**
   * Does a thing lifted onto a piece (a candle on a desk, a jar on a shelf, a crate on a crate) stay under the floor of
   * the level above, at its tallest variant? A low storey leaves the top of a tall support no room for it.
   */
  underCeiling(p: GeneratedPlacement): boolean {
    const room = this.grid.headroom?.(p.at[0], p.at[1]) ?? Infinity;
    return (p.lift ?? 0) + (this.piece(p.type, p.variant)?.hMax ?? 0) <= room;
  }

  /** The piece a feature type (and variant) resolves to in this room's theme (asked of its first cell). */
  piece(type: FeatureType, variant?: string): ReturnType<NonNullable<PlacementGrid["piece4"]>> {
    const [x, y] = this.cells[0] ?? [0, 0];
    return this.grid.piece4?.(type, x, y, variant);
  }

  has(type: FeatureType, variant?: string): boolean {
    return this.piece(type, variant) !== undefined;
  }

  crossesWall(at: readonly [number, number], size: readonly [number, number]): boolean {
    for (let y = at[1]; y < at[1] + size[1]; y++)
      for (let x = at[0]; x < at[0] + size[0]; x++) {
        if (x + 1 < at[0] + size[0] && this.grid.edge(x, y, "E") !== 0) return true;
        if (y + 1 < at[1] + size[1] && this.grid.edge(x, y, "S") !== 0) return true;
      }
    return false;
  }

  /**
   * Does a wall strip or a joint stand inside the block: a wall on its outline hosted in one of its cells, half a cell in
   * (a partition between two rooms stands in one of them), or a post at a vertex of its outline where a wall meets the
   * room's wall from outside (a T: the joint's filler stands into the room)? A flat piece laid over the whole block
   * would run into it. The room's own corners are not counted (their posts keep to the corner).
   */
  holdsStrip(at: readonly [number, number], size: readonly [number, number]): boolean {
    const x1 = at[0] + size[0];
    const y1 = at[1] + size[1];
    const post = this.postAt;
    for (let vy = at[1]; vy <= y1; vy++)
      for (let vx = at[0]; vx <= x1; vx++) {
        if (vx !== at[0] && vx !== x1 && vy !== at[1] && vy !== y1) continue;
        if (post?.(vx, vy) === true && !this.posts.some(([px, py]) => px === vx && py === vy)) return true;
      }
    for (let y = at[1]; y < y1; y++)
      for (let x = at[0]; x < x1; x++)
        for (const s of SIDES) {
          const outline =
            s === "N" ? y === at[1] : s === "S" ? y === y1 - 1 : s === "W" ? x === at[0] : x === x1 - 1;
          if (outline && this.grid.edge(x, y, s) === EDGE_WALL && this.grid.wallHosted?.(x, y, s) === true)
            return true;
        }
    return false;
  }
}

/** The cell of a support that holds a point, kept inside its footprint (a piece may overhang its cell a little). */
export const clampTo = (v: number, lo: number, n: number): number =>
  Math.min(Math.max(Math.floor(v), lo), lo + n - 1);
