/**
 * The checks' plan facts read the build through core's own walks (the world frame and its inverse, the side steps,
 * resolvedLinkCells), so they agree with core under either row convention.
 */
import { WorldFrame, loadOrientation, loadPalettes, resolvedLinkCells } from "@slabyrinth/core";
import { describe, expect, it } from "vitest";
import { boxMeshSource, pieceLookup, planFacts, sceneFromBuild } from "../src/index";
import { buildPlan, fixturePlan } from "./helpers";

describe("plan facts", () => {
  it.each([true, false])(
    "find each planned cell at its own square and its links' cells (flipZ %s)",
    async (flipZ) => {
      const orientation = { ...loadOrientation().orientation, flipZ };
      const b = buildPlan(fixturePlan("multi-level-stairs"));
      const scene = await sceneFromBuild(
        b.resolved,
        b.set,
        pieceLookup(loadPalettes().palettes, null),
        boxMeshSource(),
      );
      const plan = planFacts(b.resolved, scene, {
        orientation,
        objects: [{ id: "o", heading: 90 }],
      });
      expect(plan.cells.length).toBeGreaterThan(0);
      for (const c of plan.cells) expect(plan.cellAt(c.levelIndex, c.x0 + 0.5, c.z0 + 0.5)).toBe(c);
      // a link's cells, as core lays them out, are link cells here
      for (const level of b.resolved.levels) {
        const li = scene.levels.find((l) => l.id === level.id)?.index ?? -1;
        for (const link of b.resolved.links)
          for (const [x, y] of resolvedLinkCells(link, level.id)) {
            const c = plan.cells.find((p) => p.levelIndex === li && p.cell[0] === x && p.cell[1] === y);
            if (c) expect(c.link).toBe(true);
          }
      }
      // a heading of 90 (clockwise from plan north) is plan east, which is world +x either way
      expect(plan.objects[0]?.heading.x).toBeCloseTo(1);
      expect(plan.objects[0]?.heading.z).toBeCloseTo(0);
      // and plan north is world +z only when rows flip
      const north = planFacts(b.resolved, scene, { orientation, objects: [{ id: "o", heading: 0 }] })
        .objects[0];
      expect(north?.heading.z).toBeCloseTo(flipZ ? 1 : -1);
    },
  );

  it("core's frame turns a world point back into its plan cell", () => {
    for (const flipZ of [true, false]) {
      const f = new WorldFrame({ ...loadOrientation().orientation, flipZ }, 12);
      for (let y = 0; y < 12; y++) {
        const m = f.rectMin(3, y, 1, 1);
        expect(f.cellAt(m.x + 0.5, m.z + 0.5)).toEqual([3, y]);
      }
    }
  });
});
