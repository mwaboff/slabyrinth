/**
 * The paste sentences (pasteSteps.ts) against core's own instruction text (compile/chunk.ts pasteInstructions): the
 * facts are read out of core's words, so a change on either side that makes them disagree fails here.
 */
import { describe, expect, it } from "vitest";
import { pasteInstructions, type SlabChunk } from "@slabyrinth/core";
import { pasteSteps, type PasteAnchor, type PasteWords } from "./pasteSteps";

const chunk = (id: string): SlabChunk =>
  ({ id, label: id, levelId: "l1", levelIds: ["l1"], assetCount: 10 }) as unknown as SlabChunk;
const CHUNKS = [chunk("l1-01"), chunk("l1-02")];

/** Every sentence of a row, for the words a row must never use. */
const all = (w: PasteWords): string =>
  [
    w.plane,
    w.ground,
    w.spot,
    w.first,
    w.firstNote,
    w.later,
    w.steady,
    w.pillars,
    w.changed,
    w.foot(4),
    ...w.list,
  ].join("\n");

const num = (text: string, re: RegExp): number => {
  const m = re.exec(text);
  if (!m?.[1]) throw new Error(`core's paste text no longer says ${String(re)}:\n${text}`);
  return Number(m[1]);
};

describe("beside-the-map paste words carry core's facts", () => {
  it.each<PasteAnchor>([
    { side: "south", clearanceCells: 4, farMarkerCells: 37, nearMarkerCells: { north: 1, east: 2 } },
    { side: "south", clearanceCells: 4, farMarkerCells: 1, nearMarkerCells: { north: 1, east: 1 } },
    // a bundle from before core counted the near pillar: core's default, 1 and 1
    { side: "south", clearanceCells: 5, farMarkerCells: 12 },
  ])("%o", (anchor) => {
    const core = pasteInstructions(CHUNKS, true, "stacked", anchor);
    const w = pasteSteps(anchor);
    const e = (n: number): string => `${String(n)} empty ${n === 1 ? "cell" : "cells"}`;
    // every count is of empty cells in between, read out of core's own sentence
    const gap = num(
      core,
      /bare cell south of the middle of the map.s south edge, with (\d+) empty cells? between it and the map/,
    );
    const north = num(
      core,
      /north-east corner, raised to the top, with (\d+) empty cells? between it and the map northward/,
    );
    const east = num(core, /northward and (\d+) empty cells? eastward/);
    const far = num(
      core,
      /ground level beyond the south-west corner, with (\d+) empty cells? between it and the map southward/,
    );
    const west = num(core, /southward and (\d+) empty cells? westward/);
    expect(w.spot).toContain(
      `one bare cell just south of the middle of where the map's south edge will be, with ${e(gap)} between it and the map`,
    );
    expect(w.spot).toMatch(/same spot for every slab/);
    for (const s of [w.pillars, w.firstNote]) {
      expect(s).toContain(
        `one beyond the map's north-east corner, raised to the top, with ${e(north)} between it and the map northward and ${e(east)} eastward`,
      );
      expect(s).toContain(
        `one at ground level beyond the map's south-west corner, with ${e(far)} between it and the map southward and ${e(west)} westward`,
      );
    }
    // the clear ground: the map, and the far pillar's gap and cell beyond it
    expect(w.ground).toContain(`about ${String(far + 1)} cells more to its south`);
    expect(w.ground).toMatch(/twice the map's depth/);
    expect(w.plane).toMatch(/press G first/);
    expect(w.list).toEqual([w.plane, w.ground, w.spot, w.pillars]);
  });

  it("never sends the cursor to a marker, a corner or gravel", () => {
    const w = pasteSteps({ side: "south", clearanceCells: 5, farMarkerCells: 37 });
    const text = all(w);
    expect(text).not.toMatch(/marker|gravel/i);
    for (const s of [w.spot, w.first, w.later, w.steady]) expect(s).not.toMatch(/corner/);
    expect(text).not.toMatch(/\bparts?\b|\bchunks?\b/i);
  });
});

describe("plain paste words (no anchor)", () => {
  it("keep the same-spot steps and say slab, never part, chunk or gravel", () => {
    const w = pasteSteps(null);
    expect(w.beside).toBe(false);
    expect(w.spot).toMatch(/same spot for every slab/);
    expect(w.list).toEqual([w.plane, w.spot, w.pillars]);
    expect(all(w)).not.toMatch(/gravel|marker|\bparts?\b|\bchunks?\b/i);
  });
});
