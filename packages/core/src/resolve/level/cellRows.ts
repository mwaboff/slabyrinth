/**
 * Cell rows (generator 5, switch `cellRows`; technique int-cell-row, plan package IWP-G), after the openings (step 6): a
 * long room whose kind has a cell row in the room-kind table (gen/roomTraits.ts CELL_ROWS: cells, stalls, ward bays,
 * bunk alcoves) is lined along one or both long walls with a row of like cells, one module repeated: partitions between
 * them and a shared front on the aisle (bars, a wall, a half wall or none) with a doorway in each at the row's pitch.
 * The room stays one room of the map (its key, its review, its layout); the cells are partitions inside it, so the
 * furnisher dresses each as a small room with its kit and the aisle with its own set (resolve/level/rooms.ts
 * stepRoomRecipes). Drawn per room from the seed: cells or the kind's ordinary layout (the plain option), one row or
 * two, the cells' width and depth within the kind's ranges, the front by weight; per cell, one left empty now and then
 * and one in disorder. Left alone: a room the plan furnishes or dresses, a room that is not a rectangle of one floor
 * height, a room too narrow to keep its aisle. A slot before a doorway of the room is skipped, so every door keeps its
 * landing on the aisle. Any level and any room: a plan room underground or on a town level, or a room a building's
 * ground storey is split into (resolve/building/rooms.ts); the walls and openings round it are read from the grid's
 * edges (whatever stands there: rock, a shell wall, a partition), never assumed. Inside a building the partitions are
 * level edges within its storey, so the build stops them at the storey's wall top (wallsUnderCeiling).
 * Reads: the room's cells, class and walls, the openings already placed. Writes: the partition and front edges (walls),
 * the cells' doorways (the level's openings) and the rows for the furnisher (CellRowRecords).
 */
import type { OpeningKind, Side, WallStyle } from "../../contracts/plan";
import { CELL_FLAG, EDGE, type ResolvedOpening } from "../../contracts/resolved";
import type { RoomKind } from "../../gen/roomPurpose";
import { cellRowOf, type CellFront, type CellRowSpec } from "../../gen/roomTraits";
import { isGap, isPassage } from "../../gen/openingKinds";
import { THEME_WALL_STYLE, isLowWallStyle } from "../../gen/wallStyles";
import { elementSeed } from "../../util/hash";
import { maxOf, minOf } from "../../util/lists";
import { createPrng, type Prng } from "../../util/prng";
import { RAILING_HEIGHT, type AreaInfo, type ResolveGrid } from "./grid";
import { placeOpening } from "./openings";

/** What each front is built of: its wall (none: an open front) and the doorway in it (a gap in a half wall). */
export const CELL_FRONTS: Readonly<Record<CellFront, { wall: WallStyle | null; door: OpeningKind | null }>> =
  {
    // (a barred gate one cell wide is no theme's piece yet: the portcullis spans two; a door hangs in the bars)
    bars: { wall: "iron_bars", door: "door" },
    wall: { wall: THEME_WALL_STYLE, door: "door" },
    half: { wall: "low_wall", door: "open" },
    open: { wall: null, door: null },
  };

/** One cell of a row: its floor cells, and how it is kept. */
export interface CellRowCell {
  readonly cells: ReadonlyArray<[number, number]>;
  /** Left empty (a free cell, a stall standing empty). */
  readonly empty: boolean;
  /** Its things lie in disorder (its order one step messier). */
  readonly messy: boolean;
}

/** A room's cell rows, for the furnisher. */
export interface CellRowRecord {
  readonly areaIndex: number;
  readonly kind: RoomKind;
  readonly spec: CellRowSpec;
  readonly front: CellFront;
  readonly cells: readonly CellRowCell[];
}

/** The rooms laid out as cell rows on a level (owner: this stage; read by the room furnisher). */
export class CellRowRecords {
  readonly byArea = new Map<number, CellRowRecord>();
}

type XY = [number, number];

const drawInt = (rng: Prng, [lo, hi]: readonly [number, number]): number =>
  lo + Math.floor(rng.next() * (hi - lo + 1));

function drawFront(rng: Prng, fronts: CellRowSpec["fronts"]): CellFront {
  const opts = (Object.keys(fronts) as CellFront[]).filter((f) => (fronts[f] ?? 0) > 0);
  let r = rng.next() * opts.reduce((a, f) => a + (fronts[f] ?? 0), 0);
  for (const f of opts) {
    r -= fronts[f] ?? 0;
    if (r < 0) return f;
  }
  return opts[opts.length - 1] ?? "open";
}

export function stepCellRows(work: ResolveGrid, openings: ResolvedOpening[], records: CellRowRecords): void {
  if (!work.profile.cellRows || work.level.roomDress === false) return;
  const dressed = new Set(
    work.level.terrain.flatMap((op) => (op.op === "dress" && op.area !== undefined ? [op.area] : [])),
  );
  for (const info of work.areas) {
    if (info.kind !== "room" || info.isZone || dressed.has(info.area.id)) continue;
    const kind = info.room.kind ?? info.room.purpose;
    const spec = cellRowOf(kind);
    if (spec === undefined) continue;
    const rec = layRoom(work, info, spec, kind as RoomKind, openings);
    if (rec !== null) records.byArea.set(info.index, rec);
  }
}

/** One room's rows; null when it is left alone (see the file header). */
function layRoom(
  work: ResolveGrid,
  info: AreaInfo,
  spec: CellRowSpec,
  kind: RoomKind,
  openings: ResolvedOpening[],
): CellRowRecord | null {
  const own = work.areaCells(info.index);
  if (own.length === 0) return null;
  const xy = own.map((i) => work.cellXY(i));
  const x0 = minOf(xy.map((c) => c[0]));
  const y0 = minOf(xy.map((c) => c[1]));
  const W = maxOf(xy.map((c) => c[0])) - x0 + 1;
  const H = maxOf(xy.map((c) => c[1])) - y0 + 1;
  if (own.length !== W * H) return null;
  // one floor height, no hole, link, stair or water in it
  const h0 = work.height[own[0] as number];
  const odd = CELL_FLAG.NO_FLOOR | CELL_FLAG.LINK | CELL_FLAG.STEPS | CELL_FLAG.STAIRWELL | CELL_FLAG.WATER;
  if (own.some((i) => work.height[i] !== h0 || ((work.flags[i] as number) & odd) !== 0)) return null;
  // a room the plan furnishes itself
  if (work.level.features.some((f) => f.at[0] >= x0 && f.at[0] < x0 + W && f.at[1] >= y0 && f.at[1] < y0 + H))
    return null;
  const alongX = W >= H;
  const along = alongX ? W : H;
  const across = alongX ? H : W;
  if (across < spec.minAcross || along < 2 * spec.width[0]) return null;
  const rng = createPrng(elementSeed(work.plan.seed, `${work.level.id}~${info.area.id}~cellrow`, undefined));
  // the plain option: the kind's ordinary layout
  if (rng.next() >= spec.chance) return null;
  // (along, across) to a cell; the long walls are at across 0 and across - 1
  const at = (a: number, c: number): XY => (alongX ? [x0 + a, y0 + c] : [x0 + c, y0 + a]);
  const key = (c: XY): string => `${c[0]},${c[1]}`;
  // the door landings: a cell inside an opening of the room's boundary, and the cell beyond it
  const landing = new Set<string>();
  for (let a = 0; a < along; a++)
    for (let c = 0; c < across; c++) {
      const [x, y] = at(a, c);
      for (const s of ["N", "S", "W", "E"] as const) {
        const ed = work.sideEdge(x, y, s);
        if (ed === null) continue;
        // a way through: a gap, or an opening a person walks through (a window in a building's wall is none)
        const door =
          ed.e.opened[ed.i] === 1 ||
          (ed.e.kind[ed.i] === EDGE.OPENING && isPassage(openings[ed.e.ref[ed.i] as number]?.kind ?? "door"));
        if (!door) continue;
        landing.add(key([x, y]));
        landing.add(
          key(s === "N" ? [x, y + 1] : s === "S" ? [x, y - 1] : s === "W" ? [x + 1, y] : [x - 1, y]),
        );
        // and the cells either side of it along its wall: no partition ends at a door's jamb (its frame stands there)
        const along: XY[] =
          s === "N" || s === "S"
            ? [
                [x - 1, y],
                [x + 1, y],
              ]
            : [
                [x, y - 1],
                [x, y + 1],
              ];
        for (const c of along) landing.add(key(c));
      }
    }
  const front = drawFront(rng, spec.fronts);
  const depth = drawInt(rng, spec.depth);
  const width = drawInt(rng, spec.width);
  if (across - depth < spec.aisle) return null;
  const both = across >= 2 * depth + spec.aisle && rng.next() < spec.both;
  // the long walls, the one with fewer landings in its band first (a single row stands there)
  const landingsBy = (wallC: number): number => {
    let n = 0;
    for (let a = 0; a < along; a++)
      for (let k = 0; k < depth; k++) if (landing.has(key(at(a, wallC === 0 ? k : across - 1 - k)))) n++;
    return n;
  };
  const first = rng.next() < 0.5 ? 0 : across - 1;
  const walls = [first, across - 1 - first].sort((p, q) => landingsBy(p) - landingsBy(q));
  const rows = both ? walls : walls.slice(0, 1);
  const height = info.wallHeight;
  const setWall = (x: number, y: number, s: Side, st: WallStyle): void => {
    const ed = work.sideEdge(x, y, s);
    if (ed === null || ed.e.kind[ed.i] !== EDGE.NONE || ed.e.opened[ed.i] === 1) return;
    ed.e.kind[ed.i] = EDGE.WALL;
    ed.e.style[ed.i] = st;
    // a low wall (a half wall, a fence) is as high as a railing: nothing hangs on it
    ed.e.height[ed.i] = isLowWallStyle(st) ? Math.min(height, RAILING_HEIGHT) : height;
    ed.e.run[ed.i] = 1;
  };
  const f = CELL_FRONTS[front];
  // every cell's doorway at one place along its front, the row's pitch: a door with a leaf in the middle, clear of the
  // partitions at both ends (a door beside a wall's end is walled up by its piece); a gap anywhere
  const leaf = f.door !== null && !isGap(f.door);
  if (leaf && width < 3) return null;
  const doorCol = leaf ? Math.floor(width / 2) : Math.floor(rng.next() * width);
  const ends: readonly [Side, Side] = alongX ? ["W", "E"] : ["N", "S"];
  const cells: CellRowCell[] = [];
  for (const wallC of rows) {
    const inward = wallC === 0 ? 1 : -1;
    const frontC = wallC + inward * (depth - 1);
    const frontSide: Side = alongX ? (inward > 0 ? "S" : "N") : inward > 0 ? "E" : "W";
    const n = Math.floor(along / width);
    const start = Math.floor((along - n * width) / 2);
    for (let s = 0; s < n; s++) {
      const a0 = start + s * width;
      // the doorway off the cell's corner where its end is the room's own end wall (a door's frame stands clear of it)
      const col = a0 + doorCol === 0 || a0 + doorCol === along - 1 ? width - 1 - doorCol : doorCol;
      const slot: XY[] = [];
      for (let a = a0; a < a0 + width; a++)
        for (let k = 0; k < depth; k++) slot.push(at(a, wallC + inward * k));
      // a slot before a doorway of the room is skipped, and its doorway's cell on the aisle must be free to stand on
      if (slot.some((c) => landing.has(key(c))) || landing.has(key(at(a0 + col, frontC + inward)))) continue;
      for (let k = 0; k < depth; k++) {
        const [ex0, ey0] = at(a0, wallC + inward * k);
        const [ex1, ey1] = at(a0 + width - 1, wallC + inward * k);
        if (a0 > 0) setWall(ex0, ey0, ends[0], spec.partition);
        if (a0 + width < along) setWall(ex1, ey1, ends[1], spec.partition);
      }
      if (f.wall !== null)
        for (let a = a0; a < a0 + width; a++) {
          const [fx, fy] = at(a, frontC);
          setWall(fx, fy, frontSide, f.wall);
        }
      if (f.door !== null) {
        const [dx, dy] = at(a0 + col, frontC);
        const ed = work.sideEdge(dx, dy, frontSide);
        if (ed !== null)
          placeOpening(
            work,
            openings,
            { id: `${info.area.id}~cell${cells.length}`, kind: f.door },
            ed.orient,
            [ed.i],
            `/levels/${work.li}/areas/${info.index}`,
            true,
            true,
          );
      }
      cells.push({ cells: slot, empty: false, messy: false });
    }
  }
  if (cells.length === 0) return null;
  // per cell, small differences: one left empty now and then (one in four at most), one in disorder
  const maxEmpty = Math.floor(cells.length / 4);
  let empties = 0;
  const varied = cells.map((c) => {
    const empty = empties < maxEmpty && rng.next() < spec.empty;
    if (empty) empties++;
    return { ...c, empty, messy: !empty && rng.next() < spec.messy };
  });
  return { areaIndex: info.index, kind, spec, front, cells: varied };
}
