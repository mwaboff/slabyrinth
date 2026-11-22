/**
 * The resolver's level state (resolve/level/state.ts): each record has one owner, and a stage that only reads a record
 * gets `ReadOnly<record>`, which the compiler keeps from being written. The type checks below run with `npm run
 * typecheck` (each `@ts-expect-error` fails the build if the write it marks ever compiles).
 */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import { bundledPalettes } from "../../../src/palette/load";
import { resolveView } from "../../../src/palette/view";
import type { BridgeRecords } from "../../../src/resolve/level/bridges";
import type { ChasmRecords } from "../../../src/resolve/level/chasms";
import type { FloorOpeningRecords } from "../../../src/resolve/level/floorOpenings";
import type { AreaInfo, ReadOnly } from "../../../src/resolve/level/grid";
import type { PathRecords } from "../../../src/resolve/level/paths";
import { ResolveLevelState } from "../../../src/resolve/level/state";
import { generatorProfile } from "../../../src/plan/generator";
import { themeDefaults } from "../../../src/resolve/themes";
import { loadPlan } from "../../fixtures";

/* eslint-disable @typescript-eslint/no-unsafe-call -- each write below is a compile error on purpose */
/** Never called: it only has to type-check. */
export function readersCannotWrite(
  paths: ReadOnly<PathRecords>,
  bridges: ReadOnly<BridgeRecords>,
  chasms: ReadOnly<ChasmRecords>,
  holes: ReadOnly<FloorOpeningRecords>,
  area: AreaInfo,
): void {
  // @ts-expect-error a reader cannot add a kerb
  paths.kerbs.push({ at: [0, 0], side: "N", material: "cobble" });
  // @ts-expect-error nor lay pavement on a queued road
  paths.pendingRoads[0]?.pave.push({ i: 0, h: 0 });
  // @ts-expect-error nor mark a cell as a deck
  bridges.deckOf[0] = 1;
  // @ts-expect-error nor move a cell into a river's upper reach
  chasms.upperReach.add(0);
  // @ts-expect-error nor count a hole's edge
  if (holes.holes[0]) holes.holes[0].edgeCells++;
  // @ts-expect-error an area is described once and never changed
  area.floorMat = 1;
}
/* eslint-enable @typescript-eslint/no-unsafe-call */

/** Never called: the owner is handed the record itself and writes it. */
export function ownersWrite(paths: PathRecords, bridges: BridgeRecords): void {
  paths.kerbs.push({ at: [0, 0], side: "N", material: "cobble" });
  bridges.deckOf[0] = 1;
}

describe("the level state", () => {
  const stateOf = (plan: MapPlan): ResolveLevelState => {
    const palette = resolveView(plan, bundledPalettes());
    return new ResolveLevelState({
      plan,
      levelIndex: 0,
      themeDefaults: (theme) => themeDefaults(theme, palette, generatorProfile(plan)),
      issues: [],
      palette,
    });
  };

  it("describes every area and the theme table when it is built, before any stage runs", () => {
    const plan = loadPlan("two-rooms-door");
    const s = stateOf(plan);
    const level = plan.levels[0] as MapPlan["levels"][number];
    expect(s.grid.areas.map((a) => a.area.id)).toEqual(level.areas.map((a) => a.id));
    expect(s.grid.themes[0]).toBe(level.theme ?? plan.theme);
    for (const a of s.grid.areas) expect(s.grid.areaIndexById.get(a.area.id)).toBe(a.index);
  });

  it("starts with every record empty", () => {
    const s = stateOf(loadPlan("two-rooms-door"));
    expect(s.paths.roads).toEqual([]);
    expect(s.bridges.decks).toEqual([]);
    expect(s.floorOpenings.holes).toEqual([]);
    expect(s.openings).toEqual([]);
    expect(s.features.all).toEqual([]);
    expect(s.features.generated).toBe(0);
    expect(s.grid.stairEdges.size).toBe(0);
  });
});
