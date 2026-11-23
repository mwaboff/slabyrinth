/**
 * Lights by occupancy (generator 5, switch `occupancyLights`): a room is lit by who uses it and what they do there,
 * from its row of the room-kind table (gen/roomTraits.ts `lights`), not by one density for every room:
 *   1. a light on every seat-bearing surface the room's kind lights (each table, desk and nightstand, a bar every two
 *      tiles: the pieces the furnisher marked `wantsLight`, and any table or desk the theme put there);
 *   2. a light either side of the main door of a shared room (a taproom, a shop, a hall);
 *   3. no floor farther than 3.6 from a light: a floor light (a brazier, candles where fire does not belong) only in
 *      the middle of a big room where no wall is near; at least one light in every lived-in room whatever its size;
 *   4. wall lights, darkest wall first and at least 1.5 tiles from any other light (the walls' rhythm), up to the kind's
 *      lights per 10 floor tiles, never more than its high end.
 * A place nobody keeps (a crypt, cells, a looted room: `abandoned`) keeps generator 4's dark rule: one light per 50
 * tiles at most, none under 8. A level with `roomDress: false` gets no room lights at all (resolve/level/rooms.ts).
 */
import { featureInfo } from "../catalog";
import { SIDES, cellKey } from "../gridGeometry";
import type { RoomTraits } from "../roomTraits";
import { lightOn } from "./groups";
import { OCCUPANCY, light, lightTarget, torchFits, wallTorch } from "./lights";
import { ROOM_DRESS } from "./recipes";
import type { Room } from "./room";

export function lightByOccupancy(
  room: Room,
  t: RoomTraits,
  opts: { abandoned: boolean; noFire: boolean },
): void {
  const n = room.cells.length;
  if (opts.abandoned) {
    light(room, { target: lightTarget(n, true), radius: Infinity, torchOnly: true, floor: null });
    return;
  }
  const [lo, hi] = t.lights.per10;
  const most = Math.max(1, Math.floor((hi * n) / 10));
  // 1. the surfaces
  if (t.lights.onSurfaces)
    for (const q of room.placed.slice()) {
      if (room.lights.length >= most) break;
      if (!q.light && (q.wantsLight === true || featureInfo(q.type).surfaceLight === true)) lightOn(room, q);
    }
  // 2. either side of the main door
  if (t.lights.doorPair) doorPair(room);
  // 3. no floor far from a light (a floor light only where no wall is near), at least one light
  light(room, {
    target: 1,
    radius: ROOM_DRESS.roomLightRadius,
    torchOnly: false,
    floor: n >= ROOM_DRESS.roomFloorLightCells ? (opts.noFire ? "candles" : "brazier") : null,
    max: most,
  });
  // 4. the room's share on its walls, darkest first (the wall lights' rhythm)
  const target = Math.min(most, Math.max(1, Math.round((((lo + hi) / 2) * n) / 10)));
  light(room, {
    target,
    radius: Infinity,
    torchOnly: true,
    floor: null,
    max: most,
    spacing: OCCUPANCY.wallPitch,
  });
}

/**
 * A wall light either side of the room's main door (the doorway nearest the room's way in): on the wall cells beside
 * the doorway's ends, inside the room, where a torch fits.
 */
export function doorPair(room: Room, most = 2): void {
  if (room.doorPairs.length === 0) return;
  const near = (p: readonly [number, number, string]): number =>
    Math.hypot(p[0] + 0.5 - room.entry[0], p[1] + 0.5 - room.entry[1]);
  const main = room.doorPairs.reduce((a, b) => (near(b) < near(a) ? b : a));
  const s = main[2];
  const along: readonly [number, number] = s === "N" || s === "S" ? [1, 0] : [0, 1];
  const door = new Set(room.doorPairs.filter((p) => p[2] === s).map((p) => cellKey(p[0], p[1])));
  // the doorway's two ends along its wall
  let [x0, y0] = [main[0], main[1]];
  while (door.has(cellKey(x0 - along[0], y0 - along[1]))) [x0, y0] = [x0 - along[0], y0 - along[1]];
  let [x1, y1] = [main[0], main[1]];
  while (door.has(cellKey(x1 + along[0], y1 + along[1]))) [x1, y1] = [x1 + along[0], y1 + along[1]];
  let hung = 0;
  for (const [x, y] of [
    [x0 - along[0], y0 - along[1]],
    [x1 + along[0], y1 + along[1]],
  ] as const) {
    // (generator 5, a dim store: one side only)
    if (hung >= most) return;
    if (!room.inRoom.has(cellKey(x, y))) continue;
    // the torch on the door's own wall; where none stands there (a corner), on the wall the cell has beside it
    const side = [s, ...SIDES.filter((q) => q !== s)].find((q) => torchFits(room, x, y, q));
    if (side !== undefined && wallTorch(room, [x, y, side]) === "lit") hung++;
  }
}
