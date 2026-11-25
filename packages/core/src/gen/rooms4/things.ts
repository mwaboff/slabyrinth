/**
 * Small things and soft things (gen/rooms4): what stands on a support's top, a shelf plank along one wall with things
 * on it, and a rug.
 */
import type { Side } from "../../contracts/plan";
import { gridProfile, type GeneratedPlacement } from "../placementGrid";
import { EDGE_WALL, SIDES, SIDE_ROT, SIDE_STEP, cellKey, footprintCells } from "../gridGeometry";
import { surfaceCount, type SurfaceLoad } from "../surfaces";
import { isNaturalWallStyle } from "../wallStyles";
import { looseShift, looseTurn } from "./order";
import { ROOM_DRESS, SHELF_FAMILY, SHELF_TOP, type Family } from "./recipes";
import { type Placed, type Room, clampTo } from "./room";

/**
 * Small things on the top of a support, spread along its length, at its real top height (its rest surface: the
 * measured top from generator 6, `restSurfaces`; the box top before).
 */
export function addToppers(room: Room, p: Placed, family: Family, rule: SurfaceLoad, stacked: boolean): void {
  const ext = room.piece(p.type, p.variant);
  if (!ext || ext.mixed) return;
  // variants of very different height (a large and a small crate): a thing lifted to one sinks into, or floats over, another
  if (ext.restMax - ext.rest > ROOM_DRESS.heightSpread) return;
  // a second crate on the first (things resting on things): the small variant again, at its top
  if (stacked && rule.stackVariant !== undefined && p.variant === rule.stackVariant) {
    const cx = clampTo(p.centre[0], p.at[0], p.size[0]);
    const cy = clampTo(p.centre[1], p.at[1], p.size[1]);
    if (room.grid.inBounds(cx, cy)) {
      // generator 5 (placementOrder): set by the room's order, square in a tidy room
      const order = room.opts.order;
      const shift = order === undefined ? null : looseShift(room, order);
      const top: GeneratedPlacement = {
        type: p.type,
        at: [cx, cy],
        size: [1, 1],
        rot: 0,
        rotFine: order === undefined ? room.rng.int(24) * 15 : looseTurn(room, order, SIDE_ROT[p.side]),
        variant: rule.stackVariant,
        lift: ext.restMax,
        offset:
          shift === null
            ? [
                p.centre[0] - (cx + 0.5) + (room.rng.next() - 0.5) * 0.12,
                p.centre[1] - (cy + 0.5) + (room.rng.next() - 0.5) * 0.12,
              ]
            : [p.centre[0] - (cx + 0.5) + shift[0], p.centre[1] - (cy + 0.5) + shift[1]],
      };
      if (room.underCeiling(top)) room.push(top);
    }
    return;
  }
  const fam = room.piece("clutter", family) ? family : null;
  if (fam === null) return;
  const n = surfaceCount(rule, (k) => room.rng.int(k));
  const alongX = p.size[0] >= p.size[1];
  const longReal = Math.max(ext.w, ext.d);
  const crossReal = Math.min(ext.w, ext.d);
  const avail = Math.max(0, Math.min(longReal, alongX ? p.size[0] : p.size[1]) - 0.4);
  const spread = Math.max(0, crossReal / 2 - 0.2);
  const tops: Array<[number, number]> = [];
  const order = room.opts.order;
  const thing = room.piece("clutter", family);
  const reach = Math.max(THING_CLEAR, thing ? Math.hypot(thing.wMax, thing.dMax) / 2 : THING_CLEAR);
  for (let i = 0; i < n; i++) {
    let t: number;
    let c: number;
    if (order === undefined) {
      t = n === 1 ? (room.rng.next() - 0.5) * Math.min(avail, 0.5) : (i / (n - 1) - 0.5) * avail;
      c = (room.rng.next() * 2 - 1) * spread * 0.6;
    } else {
      // generator 5 (placementOrder): evenly along the top, then shifted by the room's order (none when tidy)
      const [da, dc] = looseShift(room, order);
      t = (n === 1 ? 0 : (i / (n - 1) - 0.5) * avail) + da;
      c = Math.max(-spread, Math.min(spread, dc));
    }
    let px = p.centre[0] + (alongX ? t : c);
    let py = p.centre[1] + (alongX ? c : t);
    // a thing stands 0.31 clear of the wall behind its support (it has a width of its own; generator 5, where loose
    // things turn any way: half the longest of the family's pieces, turned)
    const hosted = room.grid.wallHosted?.(p.at[0], p.at[1], p.side) === true;
    const clear = (hosted ? 0.5 : 0) + (order === undefined ? 0.31 : reach);
    // (generator 5: a piece standing free of the wall has nothing behind it to keep clear of)
    if (p.unbacked !== true) {
      if (p.side === "N") py = Math.max(py, p.at[1] + clear);
      else if (p.side === "S") py = Math.min(py, p.at[1] + p.size[1] - clear);
      else if (p.side === "W") px = Math.max(px, p.at[0] + clear);
      else px = Math.min(px, p.at[0] + p.size[0] - clear);
    }
    // generator 5 (placementOrder: loose things turn as hands left them): clear of a wall at either end of the support
    // too (a bench or an anvil in a corner, its end against a partition), so a turned tool never reaches into it
    if (order !== undefined) {
      [px, py] = clearOfEndWalls(room, p, px, py, reach);
      // kept that clear, it would stand off its support: left out
      if (px < p.at[0] || px > p.at[0] + p.size[0] || py < p.at[1] || py > p.at[1] + p.size[1]) continue;
    }
    if (tops.some(([qx, qy]) => Math.hypot(qx - px, qy - py) < 0.26)) continue;
    // nothing stands in a corner post (some themes' posts are wider than they look)
    if (room.nearPost(px, py)) continue;
    tops.push([px, py]);
  }
  for (const [px, py] of tops) {
    // the cell is one of the support's own (the pieces may overhang it by a little)
    const cx = clampTo(px, p.at[0], p.size[0]);
    const cy = clampTo(py, p.at[1], p.size[1]);
    if (!room.grid.inBounds(cx, cy)) continue;
    const g: GeneratedPlacement = {
      type: "clutter",
      at: [cx, cy],
      size: [1, 1],
      rot: 0,
      rotFine: order === undefined ? room.rng.int(24) * 15 : looseTurn(room, order, SIDE_ROT[p.side]),
      variant: family,
      lift: ext.restMax,
      offset: [
        Math.max(-0.5, Math.min(0.5, px - (cx + 0.5))),
        Math.max(-0.5, Math.min(0.5, py - (cy + 0.5))),
      ],
    };
    if (!room.underCeiling(g)) continue;
    if (!room.push(g)) return;
    room.used.add(cellKey(cx, cy));
  }
}

/** How far a small thing on a top stands clear of a wall at the least (it has a width of its own). */
const THING_CLEAR = 0.31;

/**
 * A point on a support kept `reach` clear (half a cell more where the wall's strip stands in the cell) of every wall on
 * the support's outline other than the one behind it.
 */
function clearOfEndWalls(room: Room, p: Placed, px: number, py: number, reach: number): [number, number] {
  const g = room.grid;
  const [x0, y0] = p.at;
  const [x1, y1] = [p.at[0] + p.size[0] - 1, p.at[1] + p.size[1] - 1];
  const clear = (x: number, y: number, s: Side): number | null =>
    s === p.side || g.edge(x, y, s) !== EDGE_WALL
      ? null
      : (g.wallHosted?.(x, y, s) === true ? 0.5 : 0) + reach;
  let qx = px;
  let qy = py;
  const cy = clampTo(py, y0, p.size[1]);
  const cx = clampTo(px, x0, p.size[0]);
  const w = clear(x0, cy, "W");
  if (w !== null) qx = Math.max(qx, x0 + w);
  const e = clear(x1, cy, "E");
  if (e !== null) qx = Math.min(qx, x1 + 1 - e);
  const n = clear(cx, y0, "N");
  if (n !== null) qy = Math.max(qy, y0 + n);
  const s = clear(cx, y1, "S");
  if (s !== null) qy = Math.min(qy, y1 + 1 - s);
  return [qx, qy];
}

/**
 * Where the wall on side `s` of cell (x, y) ends along `along`: at its low end (toward -along) and its high end, the
 * wall does not go on into the next cell (that cell has no wall on its side `s`, or a wall or opening stands between
 * the two: a corner, a doorway, a window).
 */
function wallEnds(
  room: Room,
  x: number,
  y: number,
  s: Side,
  along: readonly [number, number],
): { lo: boolean; hi: boolean } {
  const g = room.grid;
  const goesOn = (sign: 1 | -1): boolean => {
    const [dx, dy] = [along[0] * sign, along[1] * sign];
    const across = SIDES.find((q) => SIDE_STEP[q][0] === dx && SIDE_STEP[q][1] === dy);
    return across !== undefined && g.edge(x, y, across) === 0 && g.edge(x + dx, y + dy, s) === EDGE_WALL;
  };
  return { lo: !goesOn(-1), hi: !goesOn(1) };
}

/** A shelf plank along one stretch of wall with small things on it (the reference's built-in shelving). */
export function addShelf(room: Room): void {
  const g = room.grid;
  if (!room.has("shelf_line") || !room.has("clutter", SHELF_FAMILY)) return;
  // wall cells where a plank may hang: a tall wall, nothing tall beneath it, off the door zones
  const tallBelow = (x: number, y: number): boolean =>
    room.placed.some(
      (q) =>
        q.height > ROOM_DRESS.tall &&
        x >= q.at[0] &&
        x < q.at[0] + q.size[0] &&
        y >= q.at[1] &&
        y < q.at[1] + q.size[1],
    );
  const mountable = (x: number, y: number, s: Side): boolean =>
    g.edge(x, y, s) === EDGE_WALL &&
    g.wallBuilt?.(x, y, s) !== false &&
    (g.wallHeight?.(x, y, s) ?? 2) >= ROOM_DRESS.shelfWall &&
    !isNaturalWallStyle(g.wallStyle?.(x, y, s)) &&
    !tallBelow(x, y) &&
    !room.hung.has(cellKey(x, y) * 4 + SIDES.indexOf(s));
  const runs: Array<Array<[number, number, Side]>> = [];
  for (const s of SIDES) {
    const along: readonly [number, number] = s === "N" || s === "S" ? [1, 0] : [0, 1];
    const cells = room.cells
      .filter(([x, y]) => mountable(x, y, s))
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const set = new Set(cells.map(([x, y]) => cellKey(x, y)));
    for (const [x, y] of cells) {
      if (set.has(cellKey(x - along[0], y - along[1]))) continue;
      const run: Array<[number, number, Side]> = [];
      for (let cx = x, cy = y; set.has(cellKey(cx, cy)); cx += along[0], cy += along[1])
        run.push([cx, cy, s]);
      if (run.length >= 3) runs.push(run);
    }
  }
  if (runs.length === 0) return;
  runs.sort((a, b) => b.length - a.length);
  const run = room.rng.pick(runs.slice(0, 2));
  const len = Math.min(run.length, 3 + room.rng.int(4));
  const start = room.rng.int(run.length - len + 1);
  // generator 5 (shelvesWithinWalls): a plank wider than its cell (the palette's widest, "wall rack 04" is 1.35) stands
  // inward where its wall ends (a corner, a doorway, a window), so it never reaches past the wall; where the wall is
  // shorter than the plank both ways it is left out
  const within = gridProfile(g).shelvesWithinWalls;
  const over = Math.max(0, ((room.piece("shelf_line")?.wMax ?? 1) - 1) / 2);
  for (const [x, y, s] of run.slice(start, start + len)) {
    const turn = SIDE_ROT[s];
    const plank: GeneratedPlacement = {
      type: "shelf_line",
      at: [x, y],
      size: [1, 1],
      rot: turn,
      rotFine: turn,
      wall: s,
    };
    if (within && over > 0) {
      const along: readonly [number, number] = s === "N" || s === "S" ? [1, 0] : [0, 1];
      const ends = wallEnds(room, x, y, s, along);
      if (ends.lo && ends.hi) continue;
      if (ends.lo || ends.hi) {
        const shift = ends.lo ? over : -over;
        plank.offset = [along[0] * shift, along[1] * shift];
      }
    }
    if (!room.push(plank)) return;
    room.hung.add(cellKey(x, y) * 4 + SIDES.indexOf(s));
    const hosted = g.wallHosted?.(x, y, s) ?? false;
    // the things stand against the wall on the plank (0.18 deep), 0.09 off its back face: over its middle
    const depth = (hosted ? 0.5 : 0) + 0.09;
    const toward = 0.5 - depth;
    const kinds = room.rng.chance(0.85) ? 1 + room.rng.int(2) : 0;
    for (let i = 0; i < kinds; i++) {
      const along = (room.rng.next() - 0.5) * 0.7;
      const [dx, dy] = SIDE_STEP[s];
      const ox = dx !== 0 ? dx * toward : along;
      const oy = dy !== 0 ? dy * toward : along;
      const thing: GeneratedPlacement = {
        type: "clutter",
        at: [x, y],
        size: [1, 1],
        rot: 0,
        rotFine:
          room.opts.order === undefined ? room.rng.int(24) * 15 : looseTurn(room, room.opts.order, turn),
        variant: SHELF_FAMILY,
        lift: SHELF_TOP,
        offset: [ox, oy],
      };
      // generator 5: nothing on the plank where it runs into a post (a corner, a wall meeting it from outside)
      if (room.postAt !== undefined && room.nearPost(x + 0.5 + ox, y + 0.5 + oy)) continue;
      if (room.underCeiling(thing) && !room.push(thing)) return;
    }
  }
}

/**
 * A rug on a free 2×2 near the middle of the room (it blocks nothing). `offStrips` (the room-kind furnisher, generator
 * 5): never over a wall strip standing half a cell into the room (a partition between two rooms).
 */
export function addRug(room: Room, offStrips = false): void {
  if (!room.has("rug")) return;
  let best: Array<[number, number]> = [];
  let bestD = Infinity;
  for (const [x, y] of room.cells) {
    const block = footprintCells([x, y], [2, 2]);
    if (!block.every(([cx, cy]) => room.free(cx, cy) && !room.zone.has(cellKey(cx, cy)))) continue;
    if (room.crossesWall([x, y], [2, 2]) || !room.oneHeight(block)) continue;
    if (offStrips && room.holdsStrip([x, y], [2, 2])) continue;
    const d = Math.hypot(x + 1 - room.centroid[0], y + 1 - room.centroid[1]) + room.rng.next() * 0.9;
    if (d < bestD) {
      bestD = d;
      best = block;
    }
  }
  if (best.length === 0) return;
  const at = best[0] as [number, number];
  if (!room.push({ type: "rug", at, size: [2, 2], rot: 0, rotFine: 0 })) return;
  for (const [x, y] of best) room.used.add(cellKey(x, y));
}
