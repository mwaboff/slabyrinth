import { describe, expect, it } from "vitest";
import {
  guideSteps,
  initPaste,
  nextSlab,
  pasteReducer,
  type PasteEvent,
  type PasteState,
} from "./pasteMachine";
import { buildModel } from "./model";
import type { BuildRecord } from "../../../shared/project";

const at = "2026-11-18T21:40:00Z";
const slabs = (pasted: boolean[] = [false, false, false]) =>
  pasted.map((p, i) => ({ id: `part-0${i + 1}`, pasted: p, copiedAt: null }));

function apply(
  s: PasteState,
  events: PasteEvent[],
): { state: PasteState; effects: ReturnType<typeof pasteReducer>["effects"] } {
  let state = s;
  const effects: ReturnType<typeof pasteReducer>["effects"] = [];
  for (const e of events) {
    const r = pasteReducer(state, e);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

describe("paste checklist state machine", () => {
  it("has no guide for the single-slab default", () => {
    expect(guideSteps(["map"])).toEqual([]);
    expect(initPaste(slabs([false]).slice(0, 1)).steps).toEqual([]);
  });

  it("walks Prepare → parts → Tidy; Next copies the following part and ticks the current one", () => {
    const s0 = initPaste(slabs());
    expect(s0.steps.map((s) => s.kind)).toEqual(["prepare", "slab", "slab", "slab", "tidy"]);
    expect(s0.current).toBe(0);
    const r1 = pasteReducer(s0, { type: "next", at });
    expect(r1.state.current).toBe(1);
    expect(r1.effects).toEqual([
      { type: "copy", slabId: "part-01" },
      { type: "save_step", step: 1 },
    ]);
    expect(r1.state.copied["part-01"]).toBe(at);
    const r2 = pasteReducer(r1.state, { type: "next", at });
    expect(r2.effects).toEqual([
      { type: "set_pasted", slabId: "part-01", pasted: true },
      { type: "copy", slabId: "part-02" },
      { type: "save_step", step: 2 },
    ]);
    expect(r2.state.pasted["part-01"]).toBe(true);
  });

  it("Back never unticks", () => {
    const { state } = apply(initPaste(slabs()), [
      { type: "next", at },
      { type: "next", at },
      { type: "back" },
    ]);
    expect(state.current).toBe(1);
    expect(state.pasted["part-01"]).toBe(true);
  });

  it("ticking Pasted marks the part copied, and next unpasted part follows the ticks", () => {
    const s0 = initPaste(slabs());
    const { state, effects } = apply(s0, [{ type: "tick", slabId: "part-02", pasted: true, at }]);
    expect(effects).toEqual([{ type: "set_pasted", slabId: "part-02", pasted: true }]);
    expect(state.copied["part-02"]).toBe(at);
    expect(nextSlab(state, ["part-01", "part-02", "part-03"])).toBe("part-01");
  });

  it("resumes at the saved step, or at the first unpasted part", () => {
    expect(initPaste(slabs([true, false, false]), 2).current).toBe(2);
    expect(initPaste(slabs([true, false, false])).current).toBe(2);
    expect(initPaste(slabs([true, true, true])).current).toBe(4);
  });

  it("Copy again re-copies the current part only on a part step", () => {
    const s0 = initPaste(slabs());
    expect(pasteReducer(s0, { type: "copy_again", at }).effects).toEqual([]);
    const { state } = apply(s0, [{ type: "next", at }]);
    expect(pasteReducer(state, { type: "copy_again", at }).effects).toEqual([
      { type: "copy", slabId: "part-01" },
    ]);
  });

  it("does not advance past Tidy", () => {
    const { state } = apply(
      initPaste(slabs()),
      Array.from({ length: 8 }, () => ({ type: "next" as const, at })),
    );
    expect(state.current).toBe(4);
    expect(Object.values(state.pasted).every(Boolean)).toBe(true);
  });
});

describe("build model", () => {
  const rec = (chunks: number): BuildRecord => ({
    id: "b1",
    versionNumber: 7,
    createdAt: at,
    catalogVersion: "x",
    assetSource: "install",
    settings: {
      stacking: "stacked",
      gapSq: 10,
      markers: "multi-chunk",
      copyFormat: "plain",
      orientationHash: "o",
      paletteHash: "p",
    },
    levels: [
      {
        levelId: "l2",
        pasteOrder: 1,
        placement: { kind: "ground" },
        chunks: Array.from({ length: chunks }, (_, i) => ({
          id: `c${i}`,
          index: i + 1,
          globalStep: i + 1,
          label: "x",
          region: { x0: i * 10, y0: 0, x1: i * 10 + 9, y1: 9 },
          sizeBytes: 1000,
          limitBytes: 30720,
          contentHash: "h",
          offset: { x: 0, y: 0, z: 0 },
          pasted: false,
        })),
      },
      { levelId: "l1", pasteOrder: 2, placement: { kind: "storeys-up", storeys: 1 }, chunks: [] },
    ],
    substitutions: [],
    unmatchedAssets: [],
    diagnosticsSummary: { errors: 0, warnings: 0 },
  });
  it("treats a one-chunk build as the whole map in one slab, labelled with every level", () => {
    const m = buildModel(rec(1), null);
    expect(m.single).toBe(true);
    expect(m.slabs[0]?.levelIds).toEqual(["l2", "l1"]);
  });
  it("numbers chunks in paste order", () => {
    const m = buildModel(rec(3), null);
    expect(m.single).toBe(false);
    expect(m.slabs.map((s) => s.step)).toEqual([1, 2, 3]);
  });
  it("reads the paste anchor from the record, so the steps survive a restart (no bundle in memory)", () => {
    const anchor = { side: "south" as const, clearanceCells: 5, farMarkerCells: 37 };
    expect(buildModel({ ...rec(3), pasteAnchor: anchor }, null).pasteAnchor).toEqual(anchor);
    // a build saved before the field: plain steps until the bundle is in memory
    expect(buildModel(rec(3), null).pasteAnchor).toBeNull();
  });
});
