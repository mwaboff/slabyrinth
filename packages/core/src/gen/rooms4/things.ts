/**
 * Small things and soft things (gen/rooms4): what stands on a support's top, a shelf plank along one wall with things
 * on it, and a rug.
 */
import type { Side } from "../../contracts/plan";
import type { GeneratedPlacement } from "../placementGrid";
import { EDGE_WALL, SIDES, SIDE_ROT, SIDE_STEP, cellKey, footprintCells } from "../gridGeometry";
import { surfaceCount, type SurfaceLoad } from "../surfaces";
import { isNaturalWallStyle } from "../wallStyles";
import { ROOM_DRESS, SHELF_FAMILY, SHELF_TOP, type Family } from "./recipes";
import { type Placed, type Room, clampTo } from "./room";

/** Small things on the top of a support, spread along its length, at its real top height. */
export function addToppers(room: Room, p: Placed, family: Family, rule: SurfaceLoad, stacked: boolean): void {
  const ext = room.piece(p.type, p.variant);
  if (!ext || ext.mixed) return;
  // variants of very different height (a large and a small crate): a thing lifted to one sinks into, or floats over, another
  if (ext.hMax - ext.h > ROOM_DRESS.heightSpread) return;
  // a second crate on the first (things resting on things): the small variant again, at its top
  if (stacked && rule.stackVariant !== undefined && p.variant === rule.stackVariant) {
    const cx = clampTo(p.centre[0], p.at[0], p.size[0]);
    const cy = clampTo(p.centre[1], p.at[1], p.size[1]);
    if (room.grid.inBounds(cx, cy)) {
      const top: GeneratedPlacement = {
        type: p.type,
        at: [cx, cy],
        size: [1, 1],
        rot: 0,
        rotFine: room.rng.int(24) * 15,
        variant: rule.stackVariant,
        lift: ext.hMax,
        offset: [
          p.centre[0] - (cx + 0.5) + (room.rng.next() - 0.5) * 0.12,
          p.centre[1] - (cy + 0.5) + (room.rng.next() - 0.5) * 0.12,
        ],
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
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? (room.rng.next() - 0.5) * Math.min(avail, 0.5) : (i / (n - 1) - 0.5) * avail;
    const c = (room.rng.next() * 2 - 1) * spread * 0.6;
    let px = p.centre[0] + (alongX ? t : c);
    let py = p.centre[1] + (alongX ? c : t);
    // a thing stands 0.31 clear of the wall behind its support (it has a width of its own)
    const hosted = room.grid.wallHosted?.(p.at[0], p.at[1], p.side) === true;
    const clear = (hosted ? 0.5 : 0) + 0.31;
    // (generator 5: a piece standing free of the wall has nothing behind it to keep clear of)
    if (p.unbacked !== true) {
      if (p.side === "N") py = Math.max(py, p.at[1] + clear);
      else if (p.side === "S") py = Math.min(py, p.at[1] + p.size[1] - clear);
      else if (p.side === "W") px = Math.max(px, p.at[0] + clear);
      else px = Math.min(px, p.at[0] + p.size[0] - clear);
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
      rotFine: room.rng.int(24) * 15,
      variant: family,
      lift: ext.hMax,
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
  for (const [x, y, s] of run.slice(start, start + len)) {
    const turn = SIDE_ROT[s];
    if (!room.push({ type: "shelf_line", at: [x, y], size: [1, 1], rot: turn, rotFine: turn, wall: s }))
      return;
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
        rotFine: room.rng.int(24) * 15,
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

/** A rug on a free 2×2 near the middle of the room (it blocks nothing). */
export function addRug(room: Room): void {
  if (!room.has("rug")) return;
  let best: Array<[number, number]> = [];
  let bestD = Infinity;
  for (const [x, y] of room.cells) {
    const block = footprintCells([x, y], [2, 2]);
    if (!block.every(([cx, cy]) => room.free(cx, cy) && !room.zone.has(cellKey(cx, cy)))) continue;
    if (room.crossesWall([x, y], [2, 2]) || !room.oneHeight(block)) continue;
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
