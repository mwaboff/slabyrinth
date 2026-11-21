/**
 * The 2D map's look tables are complete against core's vocabulary: every material, wall style and feature type has
 * its look (or a declared plain one), so a kind added in core cannot silently draw as something else. The tables are
 * typed `Record<Material | WallStyle, …>` (a compile error when one is missing); this also catches a key that is no
 * longer in core, and that every theme colours every material.
 */
import { describe, expect, it } from "vitest";
import { FEATURE_TYPES, MATERIALS, WALL_STYLES } from "@slabyrinth/core/contracts/plan";
import { SYMBOLS } from "@slabyrinth/core/render";
import { MATERIAL_TEXTURE, WALL_LOOK } from "../src/draw/geometry";
import { MAP_THEMES, PAINTERS } from "../src/index";

describe("the map's look tables cover core's vocabulary", () => {
  it("every material has a texture entry (null = plain) and nothing else does", () => {
    expect(Object.keys(MATERIAL_TEXTURE).sort()).toEqual([...MATERIALS].sort());
  });

  it("every wall style has a look and nothing else does", () => {
    expect(Object.keys(WALL_LOOK).sort()).toEqual([...WALL_STYLES].sort());
  });

  it("every theme colours every material", () => {
    for (const theme of Object.values(MAP_THEMES))
      for (const m of MATERIALS) expect(theme.colors[`mat-${m}`], `${theme.id} mat-${m}`).toMatch(/^#|^rgb/);
  });

  it("every feature type has a symbol with a painter", () => {
    for (const t of FEATURE_TYPES) {
      expect(SYMBOLS[`feat-${t}`], t).toBeDefined();
      expect(Object.hasOwn(PAINTERS, `feat-${t}`) || Object.hasOwn(PAINTERS, t), t).toBe(true);
    }
  });
});
