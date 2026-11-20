import { describe, expect, it } from "vitest";
import type { DisplayList } from "@slabyrinth/core/contracts/resolved";
import { answerImageRequest, cropToRegion, pxPerCellFor, type ImageResult } from "./imageRequests";

const list = (w: number, h: number): DisplayList => ({
  levelId: "l1",
  viewBox: { x: 0, y: 0, w, h },
  items: [],
});

describe("view_map_image responder", () => {
  it("fits the longer side into maxPx, between 8 and 48 px per square", () => {
    expect(pxPerCellFor(list(40, 30), 1024)).toBe(24);
    expect(pxPerCellFor(list(4, 3), 1024)).toBe(48);
    expect(pxPerCellFor(list(400, 10), 1024)).toBe(8);
  });

  it("crops to the requested region inside the level", () => {
    expect(cropToRegion(list(40, 30), { x: 30, y: -5, w: 20, h: 10 }).viewBox).toEqual({
      x: 30,
      y: 0,
      w: 10,
      h: 5,
    });
    expect(cropToRegion(list(40, 30), undefined).viewBox).toEqual({ x: 0, y: 0, w: 40, h: 30 });
  });

  it("replies with an error (never silence) when the level is missing or drawing fails", async () => {
    const sent: ImageResult[] = [];
    const base = {
      getPlan: () => Promise.reject(new Error("no such version")),
      resolve: () => Promise.resolve({ lists: {} }),
      render: () => Promise.resolve("x"),
      send: (r: ImageResult) => sent.push(r),
    };
    const req = { requestId: "r1", level: "l1", showIds: true, planVersion: 3, maxPx: 1024 };
    await answerImageRequest(req, base);
    await answerImageRequest(
      { ...req, requestId: "r2" },
      { ...base, getPlan: () => Promise.resolve({} as never) },
    );
    expect(sent).toEqual([
      { requestId: "r1", ok: false, error: "no such version" },
      { requestId: "r2", ok: false, error: 'no level "l1" in plan v3' },
    ]);
  });
});
