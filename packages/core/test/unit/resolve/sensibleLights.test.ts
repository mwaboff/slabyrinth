/**
 * Lights that make sense where they stand (generator 5, switch `sensibleLights`; the owner: "Id rather there be a
 * little less light than being goofy with certain props that don't make much sense"): no furnished room holds an
 * outdoor piece (gen/pieceFacts.ts `setting`: the street lantern the bright levels stood in the middle of rooms), an
 * open fire (a brazier, a floor torch) stands only in a room whose kind takes fire, and the sick ward is lit by its
 * nightstands' candles and its walls. Without the switch the street lanterns come back.
 */
import { afterEach, describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import type { MapPlan } from "../../../src/contracts/plan";
import type { ResolvedPlan } from "../../../src/contracts/resolved";
import { typesWith } from "../../../src/gen/catalog";
import { outdoorPiece } from "../../../src/gen/pieceFacts";
import { roomTakesFire } from "../../../src/gen/roomTraits";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { loadPlan } from "../../fixtures";
import { lightLineupPlan } from "../../fixtures/lightLevels";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

/** Every palette asset's name, by lower-case uuid. */
const NAMES = new Map<string, string>();
for (const p of Object.values(pal.palettes))
  for (const role of Object.values(p.roles))
    for (const v of role.variants) if (v.name !== undefined) NAMES.set(v.asset.toLowerCase(), v.name);

const FIRE = new Set(typesWith((i) => i.openFire === true));

/** What stands in a furnished room that does not belong there: "<room> <feature> <piece>". */
function misplaced(resolved: ResolvedPlan): string[] {
  const out: string[] = [];
  const placed = realize(resolved, pal).levels.flatMap((l) => l.placements);
  for (const L of resolved.levels) {
    const features = new Map(L.features.map((f) => [f.id, f]));
    const rooms = new Map(
      L.areas
        .filter(
          (a) =>
            a.kind === "room" && a.purpose !== undefined && a.purpose !== "passage" && a.purpose !== "ruin",
        )
        .map((a) => [a.id, a]),
    );
    for (const p of placed) {
      const f = features.get(p.source.elementId ?? "");
      const room = f?.area !== undefined ? rooms.get(f.area) : undefined;
      if (f === undefined || room === undefined || room.abandoned === true) continue;
      const name = NAMES.get(p.asset.toLowerCase());
      const kind = room.roomKind ?? room.purpose ?? "";
      if (outdoorPiece(name) || (FIRE.has(f.type) && !roomTakesFire(kind)))
        out.push(`${room.id} (${kind}) ${f.type} ${name ?? p.asset}`);
    }
  }
  return out;
}

const PLANS: Array<[string, MapPlan]> = [
  ["interiors wood_town", { ...loadPlan("interiors-lineup-v1"), theme: "wood_town" }],
  ["interiors stone_dungeon", { ...loadPlan("interiors-lineup-v1"), theme: "stone_dungeon" }],
  ["building rooms", loadPlan("building-rooms-street-v1")],
  ["two quarters", loadPlan("two-quarters-v1")],
  ["light levels wood_town", lightLineupPlan("wood_town")],
  ["light levels stone_dungeon", lightLineupPlan("stone_dungeon")],
];

describe("sensibleLights", () => {
  for (const [label, plan] of PLANS)
    it(`puts no outdoor piece and no out-of-place fire in a furnished room (${label})`, () => {
      expect(misplaced(resolvePlan(plan, pal))).toEqual([]);
    });

  it("lights the ward from its nightstands and walls, with nothing standing on its floor", () => {
    for (const theme of ["wood_town", "stone_dungeon"]) {
      const L = resolvePlan({ ...loadPlan("interiors-lineup-v1"), theme }, pal).levels[0];
      const ward = L?.features.filter((f) => f.area === "ward") ?? [];
      expect(ward.filter((f) => FIRE.has(f.type) || f.type === "lantern")).toEqual([]);
      expect(ward.some((f) => f.type === "candelabra" || f.type === "candles")).toBe(true);
      expect(ward.some((f) => f.type === "torch_wall")).toBe(true);
    }
  });

  it("without the switch the bright rooms stand street lanterns on their floors", () => {
    P5.sensibleLights = false;
    const all = PLANS.flatMap(([, plan]) => misplaced(resolvePlan(plan, pal)));
    expect(all.some((m) => m.includes("Street Lantern"))).toBe(true);
  });
});
