/**
 * Detail anchors (resolve/anchors/): exact frames on a hand-made room with a door and a window, a building's faces,
 * corners and storey lines on the L-shaped and straight two-storey houses of wall-recipes-v1, floor zones on a resolved
 * room, bays phase-locked to openings, and determinism.
 */
import { describe, expect, it } from "vitest";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { LevelAnchors, ZONE, baysOf, framePoint, type FaceAnchor } from "../../../src/resolve/anchors";
import { loadPlan } from "../../fixtures";
import { handLevel } from "../compile/handResolved";

const pal = bundledPalettes();
const at5 = (name: Parameters<typeof loadPlan>[0]) => resolvePlan({ ...loadPlan(name), generator: 5 }, pal);

/** A 5 x 3 room in rock: a door in its south wall at x = 3, a window in its east wall at y = 2. */
const room = () =>
  handLevel({
    id: "r",
    rows: ["#######", "#.....#", "#.....#", "#.....#", "#######"],
    doors: [
      { x: 3, y: 3, side: "S" },
      { x: 5, y: 2, side: "E", kind: "window" },
    ],
  });

const faceOn = (faces: readonly FaceAnchor[], turn: number): FaceAnchor => {
  const f = faces.find((q) => q.frame.turn === turn);
  if (!f) throw new Error(`no face turned ${turn}`);
  return f;
};

describe("wall anchors on a hand-made room", () => {
  const a = new LevelAnchors(room());
  const faces = a.of("face");

  it("gives one face per wall seen from the room, framed on its surface with u along it and n into the room", () => {
    expect(faces).toHaveLength(4);
    // north wall seen from the south: u west, origin at its east end; the rock hosts it, so its surface is the edge
    expect(faceOn(faces, 180)).toMatchObject({
      frame: { at: [6, 1], turn: 180, base: 0.5 },
      length: 5,
      plane: 0,
    });
    expect(faceOn(faces, 0)).toMatchObject({ frame: { at: [1, 4], turn: 0 }, length: 5 });
    expect(faceOn(faces, 90)).toMatchObject({ frame: { at: [1, 1], turn: 90 }, length: 3 });
    expect(faceOn(faces, 270)).toMatchObject({ frame: { at: [6, 4], turn: 270 }, length: 3 });
    // the door is the third cell of the south wall, the window the second cell of the east wall walking north
    expect(faceOn(faces, 0).gaps).toEqual([{ id: "door0", kind: "door", from: 2, to: 3 }]);
    expect(faceOn(faces, 270).gaps).toEqual([{ id: "door1", kind: "window", from: 1, to: 2 }]);
    for (const f of faces) expect(f.ends).toEqual(["concave", "concave"]);
    // local +z is into the room
    expect(framePoint(faceOn(faces, 0).frame, 0, 1)).toEqual([1, 3]);
  });

  it("frames an opening at its centre with its jambs as a mirrored pair", () => {
    const door = a.of("opening").find((o) => o.id === "door0");
    expect(door).toMatchObject({
      frame: { at: [3.5, 4], turn: 0 },
      width: 1,
      clear: [2, 2],
      between: [false, false],
      jambs: [
        { at: [4, 4], turn: 0 },
        { at: [3, 4], turn: 0, mirror: true },
      ],
    });
    const win = a.of("opening").find((o) => o.id === "door1");
    expect(win).toMatchObject({ frame: { at: [6, 2.5], turn: 270 }, openingKind: "window" });
    // the left jamb's local +x points away from the opening too
    const left = door?.jambs[1];
    if (!left) throw new Error("no left jamb");
    expect(framePoint(left, 1, 0)).toEqual([2, 4]);
  });

  it("finds the four inner corners where the walls meet", () => {
    const corners = a.of("corner");
    expect(corners).toHaveLength(4);
    expect(corners.every((c) => !c.convex)).toBe(true);
    expect(corners.map((c) => c.frame.at).sort()).toEqual(
      [
        [1, 1],
        [1, 4],
        [6, 1],
        [6, 4],
      ].sort(),
    );
  });

  it("cuts a face into bays phase-locked to its openings, the far half mirrored", () => {
    const south = faceOn(faces, 0);
    const bays = baysOf(south, 1);
    // two blank stretches of 2 either side of the door: bay joints at the door's sides
    expect(bays.map((b) => b.x)).toEqual([0.5, 1.5, 3.5, 4.5]);
    expect(bays.map((b) => b.frame.mirror === true)).toEqual([false, true, false, true]);
  });
});

describe("building anchors (wall-recipes-v1)", () => {
  const r = at5("wall-recipes-v1");
  const L = r.levels[0];
  if (!L) throw new Error("no level");
  const a = new LevelAnchors(L);

  it("gives each storey's outside faces 0.5 out from the footprint, the L's corners convex but one", () => {
    const out = a.of("face").filter((f) => f.structure === "lhouse" && f.outside && f.storey === 1);
    // six sides, the west one cut by the chimney breast the cottage style stands there
    expect(out).toHaveLength(7);
    expect(L.structures?.find((st) => st.id === "lhouse")?.chimneys).toEqual([{ at: [2, 8], side: "W" }]);
    expect(out.every((f) => f.plane === 0.5 && f.frame.base === 4 && f.height === 2)).toBe(true);
    const corners = a.of("corner").filter((c) => c.structure === "lhouse" && c.outside && c.storey === 1);
    expect(corners.filter((c) => c.convex)).toHaveLength(5);
    expect(corners.filter((c) => !c.convex)).toHaveLength(1);
    // the north-west outer corner stands half a tile out of both walls
    expect(corners.some((c) => c.convex && c.frame.at[0] === 2.5 && c.frame.at[1] === 3.5)).toBe(true);
  });

  it("gives a storey line at the ground and at the upper floor of both houses, ends known", () => {
    const lines = a.of("storeyLine");
    for (const id of ["lhouse", "straight"]) {
      const mine = lines.filter((l) => l.structure === id);
      expect(mine.some((l) => l.line === "base")).toBe(true);
      expect(mine.filter((l) => l.line === "floor").every((l) => l.frame.base === 4 && l.band === 0.5)).toBe(
        true,
      );
    }
    const lFloor = lines.filter((l) => l.structure === "lhouse" && l.line === "floor");
    // the perimeter less the chimney breast's cell
    expect(lFloor.reduce((s, l) => s + l.length, 0)).toBe(2 * (9 + 11) - 1);
    expect(lFloor.flatMap((l) => l.ends).filter((e) => e === "concave")).toHaveLength(2);
    // ground doors break the base line
    const base = lines.filter((l) => l.structure === "straight" && l.line === "base");
    expect(base.flatMap((l) => l.gaps).map((g) => g.id)).toContain("straight~door0");
  });

  it("is the same every time", () => {
    const again = new LevelAnchors(at5("wall-recipes-v1").levels[0] ?? L);
    for (const k of ["face", "opening", "corner", "storeyLine", "zone", "boundary"] as const)
      expect(again.of(k).map((x) => [x.key, x.frame])).toEqual(a.of(k).map((x) => [x.key, x.frame]));
  });
});

describe("floor zones", () => {
  const L = at5("two-rooms-door").levels[0];
  if (!L) throw new Error("no level");
  const zones = new LevelAnchors(L).of("zone");

  it("keeps a connected lane from each door to the focal point, the door's apron and the wall band marked", () => {
    const front = zones.find((z) => z.area === "front");
    if (!front) throw new Error("no front zone");
    const door = front.doors[0];
    expect(door?.cells).toEqual([[6, 3]]);
    expect(front.classAt(6, 3) & ZONE.DOOR).toBeTruthy();
    expect(front.classAt(5, 3) & ZONE.DOOR).toBeTruthy();
    const lane = front.cells.filter(([x, y]) => front.classAt(x, y) & ZONE.LANE);
    expect(lane).toContainEqual([6, 3]);
    // every lane cell has a lane neighbour (one path, no breaks)
    for (const [x, y] of lane)
      expect(lane.some(([u, v]) => Math.abs(u - x) + Math.abs(v - y) === 1)).toBe(true);
    const [fx, fy] = front.frame.at;
    expect(lane).toContainEqual([Math.floor(fx), Math.floor(fy)]);
    expect(front.classAt(1, 1) & ZONE.BAND1).toBeTruthy();
    expect(front.focalAt(6, 3)).toBe(1);
    expect(front.classAt(20, 20)).toBe(0);
  });
});
