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
    { side: "south", clearanceCells: 5, farMarkerCells: 37 },
    { side: "south", clearanceCells: 4, farMarkerCells: 1 },
  ])("%o", (anchor) => {
    const core = pasteInstructions(CHUNKS, true, "stacked", anchor);
    const w = pasteSteps(anchor);
    // the cursor cell: N cells south of the middle of the south edge, N - 1 empty cells between
    const cursor = num(core, /bare cell (\d+) cells south of the middle of the map.s south edge/);
    const gap = num(core, /\((\d+) empty cells between it and the map\)/);
    expect(w.spot).toContain(`${String(cursor)} cells south of it`);
    expect(w.spot).toContain(`${String(gap)} empty ${gap === 1 ? "cell" : "cells"} between it and the map`);
    expect(w.spot).toMatch(/middle of where the map's south edge will be/);
    expect(w.spot).toMatch(/same spot for every slab/);
    // the two pillars: one beyond the north-east corner, one far south, beyond the west edge
    expect(core).toMatch(/one clear cell beyond the north-east corner/);
    const far = num(core, /at ground level (\d+) cells? south of the map, one cell beyond its west edge/);
    for (const s of [w.pillars, w.firstNote]) {
      expect(s).toMatch(/just past the map's north-east corner/);
      expect(s).toContain(
        `about ${String(far)} ${far === 1 ? "cell" : "cells"} south of the map, one cell beyond its west edge`,
      );
    }
    // the clear ground: the map and the far pillar's distance beyond it
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
