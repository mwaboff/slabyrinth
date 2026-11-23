/**
 * Every bedroom gets its bed (generator 5, switches `anchorLandings` and `sleepingCorners`), measured on the street
 * fixture building-rooms-street-v1 in two themes:
 *   - the inn keeper's bedroom (4 × 3, its door on the long wall) got desk, chair, desk and no bed: the door's full
 *     clearance (three wide, two deep) took 7 of its 12 cells and left the bed only the corners, where the corner posts
 *     leave too little room. A room whose anchor finds no spot outside its doors' full clearance now keeps a landing only;
 *   - the tiny cottage's one room was a kitchen with nothing to sleep on: a one-room dwelling is a room with zones, its
 *     hearth zone and a sleeping corner.
 * Without the switches both faults come back.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import type { ResolvedLevel } from "../../../src/contracts/resolved";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { loadPlan } from "../../fixtures";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

const street = loadPlan("building-rooms-street-v1");
const level = (theme: MapPlan["theme"]): ResolvedLevel =>
  resolvePlan({ ...street, theme }, pal).levels[0] as ResolvedLevel;
const typesIn = (L: ResolvedLevel, areaId: string): string[] =>
  L.features.filter((f) => f.area === areaId).map((f) => f.type);
const room = (L: ResolvedLevel, name: string) => L.areas.find((a) => a.name === name);

describe("anchorLandings and sleepingCorners", () => {
  for (const theme of ["wood_town", "stone_dungeon"] as const)
    it(`gives every bedroom a bed, and the one-room cottage a bed beside its hearth (${theme})`, () => {
      const L = level(theme);
      const bedrooms = L.areas.filter((a) => a.building !== undefined && /bedroom/i.test(a.name ?? ""));
      expect(bedrooms.length).toBeGreaterThanOrEqual(2);
      for (const b of bedrooms) expect(typesIn(L, b.id), b.name).toContain("bed");
      const cottage = L.areas.filter((a) => a.building === "cottage");
      expect(cottage.length).toBe(1);
      const kit = typesIn(L, cottage[0]?.id ?? "");
      expect(kit).toContain("bed");
      expect(kit).toContain("counter");
    });

  it("without the switches the keeper's room and the cottage have no bed", () => {
    P5.anchorLandings = false;
    P5.sleepingCorners = false;
    const L = level("wood_town");
    expect(typesIn(L, room(L, "Keeper's bedroom")?.id ?? "")).not.toContain("bed");
    const cottage = L.areas.find((a) => a.building === "cottage");
    expect(typesIn(L, cottage?.id ?? "")).not.toContain("bed");
  });
});
