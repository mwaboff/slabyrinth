/** Hit-test integration: real fixture plan → core resolvePlan → view transform → core hitTest (architecture §5.4). */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "@slabyrinth/core";
import exampleA from "../../../../../packages/core/test/fixtures/plans/example-a.json?raw";
import { compute } from "./resolveCore";
import { hitAt, toCell } from "./render";
import { roomExits } from "./exits";

const plan = JSON.parse(exampleA) as MapPlan;
const r = compute({
  id: 1,
  plan,
  version: 1,
  options: { grid: true, roomNumbers: true, roomNames: true, furniture: true, gmLayer: true, legend: false },
});
const l1 = r.resolved.levels.find((l) => l.id === "l1");
if (!l1) throw new Error("fixture changed: no l1");
// 24 px per cell at 150 % zoom, map origin offset by (100, 50) px
const view = { scale: 36, ox: 100, oy: 50 };
const px = (cx: number, cy: number): [number, number] => [
  view.ox + cx * view.scale,
  view.oy + cy * view.scale,
];

describe("map hit-testing", () => {
  it("converts canvas pixels to global cells", () => {
    expect(toCell(view, 100 + 36 * 3.5, 50 + 36 * 2.25)).toEqual([3.5, 2.25]);
  });

  it("hits the room under the pointer", () => {
    // Hall of Pillars is rect x 8..23, y 6..13; (11.5, 12.5) is open floor between pillars
    expect(hitAt(l1, r.resolved.links, view, ...px(11.5, 12.5))).toEqual({ kind: "area", id: "hall" });
    expect(hitAt(l1, r.resolved.links, view, ...px(3.5, 9.5))).toEqual({ kind: "area", id: "guard" });
  });

  it("prefers a feature over its room", () => {
    // pillar p1 sits at cell (10, 8)
    expect(hitAt(l1, r.resolved.links, view, ...px(10.5, 8.5))).toMatchObject({
      kind: "feature",
      id: "p1",
      area: "hall",
    });
  });

  it("returns a plain cell in solid rock and null outside the level", () => {
    expect(hitAt(l1, r.resolved.links, view, ...px(0.5, 0.5))).toEqual({ kind: "cell", cell: [0, 0] });
    expect(hitAt(l1, r.resolved.links, view, ...px(-3, -3))).toBeNull();
  });

  it("builds exits from resolved openings, following corridors to numbered rooms", () => {
    const exits = roomExits(l1, r.resolved.links, "hall");
    expect(exits.some((e) => e.kind === "secret door" && e.toKey === "4" && e.side === "E")).toBe(true);
    expect(exits.some((e) => e.toKey === "1")).toBe(true);
  });

  it("produces a display list for every level", () => {
    expect(Object.keys(r.lists).sort()).toEqual(["l1", "l2"]);
    expect(r.labels).toMatchObject({ l1: "L1", l2: "L2" });
  });
});
