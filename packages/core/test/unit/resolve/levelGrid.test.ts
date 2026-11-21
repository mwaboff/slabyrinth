/** The level grid (resolve/levelGrid.ts): the one index arithmetic for cells and edges, and the read-only view. */
import { describe, expect, it } from "vitest";
import type { Side } from "../../../src/contracts/plan";
import { EDGE } from "../../../src/contracts/resolved";
import { SIDES, stepSide } from "../../../src/gen/gridGeometry";
import {
  LevelGrid,
  cellIndex,
  edgeCol,
  edgeFirstCell,
  edgeLineLength,
  edgeLines,
  edgeOnLine,
  edgeRow,
  edgeSecondCell,
  hEdgeIndex,
  sideEdgeIndex,
  sideOrient,
  vEdgeIndex,
} from "../../../src/resolve/levelGrid";
import { handLevel } from "../compile/handResolved";

const G = { w: 5, h: 3 };

describe("level grid arithmetic", () => {
  it("indexes cells row by row and refuses cells outside", () => {
    expect(cellIndex(G, 0, 0)).toBe(0);
    expect(cellIndex(G, 4, 2)).toBe(14);
    for (const [x, y] of [
      [-1, 0],
      [5, 0],
      [0, -1],
      [0, 3],
    ] as const)
      expect(cellIndex(G, x, y)).toBe(-1);
  });

  it("lays the edges out as the resolved contract says (h: w x (h+1), v: (w+1) x h)", () => {
    expect(hEdgeIndex(G, 4, 3)).toBe(3 * 5 + 4); // the south border
    expect(hEdgeIndex(G, 5, 0)).toBe(-1);
    expect(hEdgeIndex(G, 0, 4)).toBe(-1);
    expect(vEdgeIndex(G, 5, 2)).toBe(2 * 6 + 5); // the east border
    expect(vEdgeIndex(G, 6, 0)).toBe(-1);
    expect(vEdgeIndex(G, 0, 3)).toBe(-1);
  });

  it("gives every edge index once, on lines, and finds its column, row and cells again", () => {
    for (const orient of ["h", "v"] as const) {
      const seen = new Set<number>();
      for (let line = 0; line < edgeLines(G, orient); line++)
        for (let pos = 0; pos < edgeLineLength(G, orient); pos++) {
          const i = edgeOnLine(G, orient, line, pos);
          expect(i).toBeGreaterThanOrEqual(0);
          seen.add(i);
          const lx = edgeCol(G, orient, i);
          const ly = edgeRow(G, orient, i);
          expect(orient === "h" ? [lx, ly] : [ly, lx]).toEqual([pos, line]);
          expect(edgeSecondCell(G, orient, i)).toBe(cellIndex(G, lx, ly));
          expect(edgeFirstCell(G, orient, i)).toBe(
            orient === "h" ? cellIndex(G, lx, ly - 1) : cellIndex(G, lx - 1, ly),
          );
        }
      expect(seen.size).toBe(orient === "h" ? 5 * 4 : 6 * 3);
    }
  });

  it("names the same edge from both cells beside it", () => {
    for (let ly = 0; ly < G.h; ly++)
      for (let lx = 0; lx < G.w; lx++)
        for (const s of SIDES) {
          const [nx, ny] = stepSide(lx, ly, s);
          const back: Record<Side, Side> = { N: "S", S: "N", E: "W", W: "E" };
          const i = sideEdgeIndex(G, lx, ly, s);
          expect(i).toBeGreaterThanOrEqual(0);
          // the neighbour outside the grid still names the border edge (it is the grid's)
          if (cellIndex(G, nx, ny) >= 0) expect(sideEdgeIndex(G, nx, ny, back[s])).toBe(i);
          expect(sideOrient(s)).toBe(s === "N" || s === "S" ? "h" : "v");
        }
  });
});

describe("LevelGrid", () => {
  // walls on every open/non-open edge, hosted by the non-open side; a door on the east side of (2,1)
  const L = handLevel({
    id: "l1",
    x0: 10,
    y0: 20,
    rows: ["#####", "#.2.#", "#####"],
    doors: [{ x: 12, y: 21, side: "E" }],
  });
  const g = new LevelGrid(L, "dungeon");

  it("reads cells in plan coordinates", () => {
    expect(g.inBounds(10, 20)).toBe(true);
    expect(g.inBounds(15, 20)).toBe(false);
    expect(g.index(11, 21)).toBe(6);
    const c = g.cell(12, 21);
    expect([c.inBounds, c.open, c.floor, c.height]).toEqual([true, true, true, 0.5]);
    const out = g.cell(9, 20);
    expect([out.inBounds, out.open, out.floor, out.theme]).toEqual([false, false, false, "dungeon"]);
    expect(g.top(12, 21)).toBe(L.elevation + 0.5 + 0.5);
  });

  it("answers the edge on a side of a cell: its kind, a wall, and which cell holds its strip", () => {
    expect(g.wallOn(11, 21, "N")).toBe(true);
    expect(g.wallOn(11, 21, "E")).toBe(false);
    expect(g.edgeKind(12, 21, "E")).toBe(EDGE.OPENING);
    expect(g.edgeKind(9, 21, "E")).toBe(EDGE.NONE);
    // the wall north of an open cell stands in the solid cell north of it
    expect(g.hostedOn(11, 21, "N")).toBe(false);
    expect(g.hostedOn(11, 20, "S")).toBe(true);
    expect(g.hostedOn(11, 21, "E")).toBe(false);
    expect(g.hEdge(11, 21)).toBe(g.edgeIndex(11, 21, "N"));
    expect(g.vEdge(12, 21)).toBe(g.edgeIndex(11, 21, "E"));
    expect(g.edges("h")).toBe(L.hEdges);
  });
});
