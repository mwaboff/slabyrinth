/**
 * A lived-in room keeps a light at every light level (generator 5, switches roomsKeepALight and topLightFallback).
 * Measured: a kitchen drawn moderate (the ship's galley of the harbour fixture, and about one building kitchen in two
 * on the street plans) is furnished with counters and a cauldron along every wall cell beside its cooking group, its
 * door landings take the rest, so its regime finds no free wall cell for a standing fire; a counter is no seat, so the
 * surfaces step passes it; and below dim no step kept a light, so the room stayed dark (`room_unlit`). The ship's theme
 * has no lantern for a counter's top either. With the switches the room keeps one: a single candle on a main piece's
 * top where the theme has no lantern, else a wall light. The review asks the right question: a cauldron is no fire
 * piece, and nothing in those rooms gave light.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LIGHT_FEATURES } from "../../../src/gen/catalog";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { resolveWithObjects } from "../../../src/resolve/objectSite";
import { interiorNotes } from "../../../src/review/interiors";
import type { StoredPlan } from "../../fixtures";
import { HARBOUR_SPECS, harbourPlan } from "../../fixtures/harbour";
import { sweepPlan, sweepSeeds } from "../../sweep/seeds";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

const off = (): void => {
  P5.roomsKeepALight = false;
  P5.topLightFallback = false;
};

/** The galley's light features and the review's unlit note. */
function galley(): { lights: string[]; unlit: string[] } {
  const h = resolveWithObjects(harbourPlan(), HARBOUR_SPECS, loadPalettes());
  const L = h.resolved.levels
    .flatMap((l) => l.areas.map((a) => ({ l, a })))
    .find((x) => x.a.name === "Galley");
  if (!L) throw new Error("no galley");
  const lights = L.l.features
    .filter((f) => f.area === L.a.id && LIGHT_FEATURES.has(f.type))
    .map((f) => `${f.type}${f.variant !== undefined ? `:${f.variant}` : ""}`);
  const unlit = interiorNotes(harbourPlan(), h.resolved)
    .filter((n) => n.code === "room_unlit")
    .flatMap((n) => n.elementIds ?? []);
  return { lights, unlit };
}

/** Lived-in rooms drawn moderate or brighter that have no light, over building plans and seeds. */
function darkRooms(): string[] {
  const plans: StoredPlan[] = ["ground-and-walls-v1", "varied-street-v1", "building-rooms-street-v1"];
  const out: string[] = [];
  for (const name of plans)
    for (const seed of sweepSeeds(3)) {
      const r = resolvePlan(sweepPlan(name, seed), pal);
      for (const L of r.levels)
        for (const a of L.areas)
          if (
            a.kind === "room" &&
            a.purpose !== undefined &&
            a.abandoned !== true &&
            (a.lightLevel ?? 0) >= 2 &&
            !L.features.some((f) => f.area === a.id && LIGHT_FEATURES.has(f.type))
          )
            out.push(`${name}@${String(seed)} ${a.id} ${a.purpose}`);
    }
  return out;
}

describe("roomsKeepALight", () => {
  // (the ship kit's hull gave the galley free wall cells, so its regime lights it with wall lights; the case without
  // the switches is the street plans' kitchens, below)
  it("keeps the ship's galley lit", () => {
    const on = galley();
    expect(on.lights.length).toBeGreaterThan(0);
    expect(on.unlit.some((id) => id.includes("hold-2"))).toBe(false);
  }, 60_000);

  it("leaves no lived-in room drawn moderate or brighter without a light; without the switches kitchens are", () => {
    expect(darkRooms()).toEqual([]);
    off();
    const dark = darkRooms();
    expect(dark.filter((s) => s.endsWith(" kitchen")).length).toBeGreaterThan(5);
  }, 120_000);
});
