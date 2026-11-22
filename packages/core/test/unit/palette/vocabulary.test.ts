/**
 * Vocabulary completeness where a type cannot say it. Tables keyed by a contract list are typed over every key
 * (`Record<Material, …>`, `Record<OpeningKind, …>`: MATERIAL_INFO, WALL_STYLE_INFO, FEATURE_INFO, OPENING_KIND_INFO,
 * LINK_KIND_INFO, ROOF_TYPE_INFO, ROOM_PURPOSE_INFO, STALL_KIND_INFO, the render look tables), so a new word without
 * a row is a compile error that names the table. Palette data is JSON, so its words are checked here: each bundled
 * theme's defaults name a material and a wall style the contract knows.
 */
import { describe, expect, it } from "vitest";
import { MATERIALS, WALL_STYLES } from "../../../src/contracts/plan";
import { bundledPalettes } from "../../../src/palette";

const known = (list: readonly string[], word: string | undefined): boolean =>
  word === undefined || list.includes(word);

describe("palette data speaks the contract's vocabulary", () => {
  it("every bundled theme's defaults name a known material and wall style", () => {
    for (const [id, p] of Object.entries(bundledPalettes().palettes)) {
      const where = `data/palettes/${id}.json defaults`;
      expect(
        known(MATERIALS, p.defaults.floor),
        `${where}.floor "${p.defaults.floor}" is not in MATERIALS`,
      ).toBe(true);
      expect(
        known(MATERIALS, p.defaults.caveFloor),
        `${where}.caveFloor "${p.defaults.caveFloor ?? ""}" is not in MATERIALS`,
      ).toBe(true);
      expect(
        known(WALL_STYLES, p.defaults.wallStyle),
        `${where}.wallStyle "${p.defaults.wallStyle}" is not in WALL_STYLES`,
      ).toBe(true);
    }
  });
});
