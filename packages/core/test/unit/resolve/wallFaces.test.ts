/**
 * The wall faces of a level (resolve/wallFaces.ts), on small hand-built levels: which cell a wall's mass stands in, at
 * the board edge, between two rooms, behind rock and built walls, and the spans the readers merge.
 */
import { describe, expect, it } from "vitest";
import { EDGE, type ResolvedLevel } from "../../../src/contracts/resolved";
import { LevelGrid, sideEdgeIndex, sideOrient } from "../../../src/resolve/levelGrid";
import { findWallFaces, type WallFace, type WallFaces } from "../../../src/resolve/wallFaces";
import type { Side } from "../../../src/contracts/plan";
import { handLevel } from "../compile/handResolved";

const faces = (L: ResolvedLevel, boardEdgeIsExit = false, claimed?: ReadonlySet<string>): WallFaces =>
  findWallFaces(new LevelGrid(L), { boardEdgeIsExit, ...(claimed ? { claimed } : {}) });

/** The face on `side` of local cell (lx, ly). */
const faceOn = (F: WallFaces, L: ResolvedLevel, lx: number, ly: number, side: Side): WallFace | undefined =>
  F.at(sideOrient(side), sideEdgeIndex(L.bounds, lx, ly, side));

describe("wall faces", () => {
  it("a wall between a room and rock has its mass in the rock cell, whichever side hosts it", () => {
    const L = handLevel({ id: "a", rows: ["###", "#.#", "###"] });
    const F = faces(L);
    // the room's four walls
    for (const side of ["N", "E", "S", "W"] as const) {
      const f = faceOn(F, L, 1, 1, side);
      expect(f?.kind).toBe(EDGE.WALL);
      expect(f?.mass?.solid).toBe(true);
      expect(f?.mass?.open).toBe(false);
    }
    // hosted by the room instead: the mass still stands in the rock
    const e = sideEdgeIndex(L.bounds, 1, 1, "N");
    L.hEdges.host[e] = 1;
    const f = faceOn(faces(L), L, 1, 1, "N");
    expect(f?.host).toMatchObject({ x: 1, y: 1, open: true });
    expect(f?.mass).toMatchObject({ x: 1, y: 0, solid: true });
  });

  it("an edge on the board border has its mass outside the level, or none where the board edge is an exit", () => {
    const L = handLevel({ id: "a", rows: [".#"] });
    const west = faceOn(faces(L), L, 0, 0, "W");
    expect(west?.mass).toMatchObject({ x: -1, y: 0, index: -1, solid: false });
    expect(faceOn(faces(L, true), L, 0, 0, "W")?.mass).toBeNull();
    // the rock cell's own border edge is not a wall (both sides closed): no face
    expect(faceOn(faces(L), L, 1, 0, "E")).toBeUndefined();
  });

  it("a wall between two open cells has nowhere for its mass", () => {
    const L = handLevel({ id: "a", rows: ["#####", "#...#", "#####"] });
    const e = sideEdgeIndex(L.bounds, 2, 1, "W");
    L.vEdges.kind[e] = EDGE.WALL;
    L.vEdges.ref[e] = 0;
    const f = faceOn(faces(L), L, 2, 1, "W");
    expect(f?.host.open && f.other.open).toBe(true);
    expect(f?.mass).toBeNull();
  });

  it("rock and built walls differ by the wall style's natural trait", () => {
    const rock = handLevel({ id: "a", rows: ["###", "#.#", "###"], wallStyle: "cave_rock" });
    const built = handLevel({ id: "b", rows: ["###", "#.#", "###"], wallStyle: "stone" });
    expect(faceOn(faces(rock), rock, 1, 1, "N")).toMatchObject({ style: "cave_rock", natural: true });
    expect(faceOn(faces(built), built, 1, 1, "N")).toMatchObject({ style: "stone", natural: false });
  });

  it("an opening is a face in the style of the wall it is cut in", () => {
    const L = handLevel({
      id: "a",
      rows: ["###", "#.#", "###"],
      wallStyle: "brick",
      doors: [{ x: 1, y: 1, side: "E" }],
    });
    const f = faceOn(faces(L), L, 1, 1, "E");
    expect(f).toMatchObject({ kind: EDGE.OPENING, style: "brick" });
    expect(f?.mass).toMatchObject({ x: 2, y: 1, solid: true });
  });

  it("a face knows when a building builds its edge", () => {
    const L = handLevel({ id: "a", rows: ["###", "#.#", "###"] });
    const e = sideEdgeIndex(L.bounds, 1, 1, "S");
    const F = faces(L, false, new Set([`h${e}`]));
    expect(faceOn(F, L, 1, 1, "S")?.claimed).toBe(true);
    expect(faceOn(F, L, 1, 1, "N")?.claimed).toBe(false);
  });

  it("faces sharing a mass cell carry their own spans for the readers to merge", () => {
    // the rock cell (1, 1) closes a raised room to the west and a floor-level room to the south
    const L = handLevel({ id: "a", rows: ["####", "4##", "#.##", "####"], wallHeight: 2 });
    L.cells.area[2 * L.bounds.w + 1] = 2; // the low room is an area of its own (its own reference floor)
    const F = faces(L);
    const byMass = F.list.filter((f) => f.mass?.x === 1 && f.mass.y === 1);
    expect(byMass).toHaveLength(2);
    const west = byMass.find((f) => f.orient === "v");
    const south = byMass.find((f) => f.orient === "h");
    // floor tops: the raised room 1.5 (one tile up, + the slab), the low room 0.5; a wall is 2 tall above its floor
    expect(west).toMatchObject({ base: 1.5, top: 3.5 });
    expect(south).toMatchObject({ base: 0.5, top: 2.5 });
    // the envelope a rock column spans, the tallest the shell's cap sits flush with
    expect(Math.min(...byMass.map((f) => f.base))).toBe(0.5);
    expect(Math.max(...byMass.map((f) => f.top))).toBe(3.5);
  });

  it("lists faces line by line: rows of horizontal edges, then columns of vertical edges", () => {
    const L = handLevel({ id: "a", rows: ["#..", "#.#"] });
    const order = faces(L).list.map((f) => `${f.orient}${f.x},${f.y}`);
    expect(order).toEqual(["h1,0", "h2,0", "h2,1", "h1,2", "v1,0", "v1,1", "v2,1", "v3,0"]);
  });
});
