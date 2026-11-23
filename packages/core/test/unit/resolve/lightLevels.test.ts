/**
 * Light levels read in the build (generator 5, characterCascade + lightRegimes): one taproom at dark, dim, moderate,
 * bright and flooded (its own words set its light) lights strictly more of its floor at each step, measured by the
 * reach of the pieces the build chose (gen/lightReach.ts), in both proof themes.
 */
import { describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { elementCharacter } from "../../../src/resolve/character";
import { loadPlan } from "../../fixtures";
import { LIGHT_LINEUP_LEVELS, lightLineupPlan, litCells } from "../../fixtures/lightLevels";

const pal = bundledPalettes();

describe.each(["wood_town", "stone_dungeon"])("the sick ward in %s", (theme) => {
  it("is bright or flooded (its kind's range starts at bright)", () => {
    const resolved = resolvePlan({ ...loadPlan("interiors-lineup-v1"), theme }, pal);
    const L = resolved.levels.find((l) => l.areas.some((a) => a.id === "ward"));
    if (!L) throw new Error("no ward");
    expect(L.areas.find((a) => a.id === "ward")?.lightLevel ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe.each(["wood_town", "stone_dungeon"])("light levels in %s", (theme) => {
  const resolved = resolvePlan(lightLineupPlan(theme), pal);
  const L = resolved.levels[0];
  if (!L) throw new Error("no level");
  const set = realize(resolved, pal);
  const rooms = LIGHT_LINEUP_LEVELS.map((_, i) => `tap${i + 1}`);

  it("each room takes the level its words name", () => {
    expect(rooms.map((id) => elementCharacter(L, id)?.light)).toEqual([
      "dark",
      "dim",
      "moderate",
      "bright",
      "flooded",
    ]);
    expect(rooms.map((id) => L.areas.find((a) => a.id === id)?.lightLevel)).toEqual([0, 1, 2, 3, 4]);
  });

  it("lights strictly more of the same room's floor at each level", () => {
    const lit = rooms.map((id) => litCells(L, set, id));
    const what = rooms
      .map((id) =>
        L.features
          .filter(
            (f) => f.area === id && /torch|candle|candel|brazier|lantern|fire|chandelier|light/.test(f.type),
          )
          .map((f) => `${f.type}@${f.at.join(",")}`)
          .join(" "),
      )
      .join(" | ");
    for (let i = 1; i < lit.length; i++)
      expect(lit[i], `${rooms[i]} ${lit.join(",")} :: ${what}`).toBeGreaterThan(lit[i - 1] ?? 0);
  });
});
