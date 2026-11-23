/**
 * Dungeon layout defaults (generator 5, package WP-DG): dead ends that pay (switch deadEndVignettes) and doors by role
 * (switch doorsByRole). The generator and the review ask one question (resolve/layoutRooms.ts): a complex the
 * generator dresses is never faulted by `dead_end_empty`, over many seeds; the options vary, plain among them.
 */
import { describe, expect, it } from "vitest";
import type { Area, MapPlan, Opening } from "../../../src/contracts/plan";
import { COMPLEX, DEAD_END_OPTIONS } from "../../../src/gen/complexLayout";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { reviewDesign } from "../../../src/review";
import { emptyDeadEnds, mapLayout } from "../../../src/review/layout";
import { dungeonPlan } from "../../fixtures/planBuilder";

const pal = bundledPalettes();
const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);

const room = (id: string, x: number, y: number, w = 4, h = 4, name = `Chamber ${id}`): Area => ({
  id,
  kind: "room",
  name,
  shape: { type: "rect", x, y, w, h },
});
const door = (a: string, b: string): Opening => ({ id: `${a}-${b}`, kind: "door", between: [a, b] });

/** A hub with a loop through b, d and c, and four rooms with one door each (a, e, f, g), none with a purpose. */
const complex = (generator: 4 | 5, seed: number): MapPlan =>
  dungeonPlan({
    generator,
    seed,
    w: 24,
    h: 14,
    areas: [
      room("hub", 1, 1, 8, 4),
      room("a", 1, 5),
      room("b", 5, 5),
      room("c", 9, 1),
      room("d", 9, 5),
      room("e", 13, 1),
      room("f", 13, 5),
      room("g", 9, 9, 5, 3),
    ],
    openings: [
      door("hub", "a"),
      door("hub", "b"),
      door("b", "d"),
      door("d", "c"),
      door("c", "hub"),
      door("c", "e"),
      door("d", "f"),
      door("d", "g"),
    ],
  });

describe("dead ends that pay (deadEndVignettes)", () => {
  it("a complex the generator dresses keeps its bare dead ends within the review's allowance, seed after seed", () => {
    for (const seed of SEEDS) {
      const p = complex(5, seed);
      const r = resolvePlan(p, pal);
      expect(emptyDeadEnds(mapLayout(r)).length, `seed ${seed}`).toBeLessThanOrEqual(COMPLEX.emptyDeadEnds);
      expect(reviewDesign(p, r, pal, { limit: 999 }).map((n) => n.code)).not.toContain("dead_end_empty");
    }
  });

  it("without the switch (generator 4) the same complex leaves its dead ends bare", () => {
    const r = resolvePlan(complex(4, 1), pal);
    expect(emptyDeadEnds(mapLayout(r)).length).toBeGreaterThan(COMPLEX.emptyDeadEnds);
  });

  it("the sets vary from room to room and seed to seed, and the plain option is drawn too", () => {
    const anchors = new Set<string>();
    let plain = 0;
    for (const seed of SEEDS) {
      const r = resolvePlan(complex(5, seed), pal);
      const L = r.levels[0];
      if (!L) throw new Error("no level");
      for (const id of ["a", "e", "f", "g"]) {
        const set = L.features.filter((f) => f.generatedBy === `${id}~deadend`);
        const anchor = set.find((f) => DEAD_END_OPTIONS.some((o) => o.group?.anchor.type === f.type));
        if (anchor) anchors.add(anchor.type);
        else plain++;
      }
    }
    expect(anchors.size).toBeGreaterThanOrEqual(3);
    expect(plain).toBeGreaterThan(0);
  });
});

describe("doors by role (doorsByRole)", () => {
  /** A hall, a treasury and a plain chamber, each reached from a passage by a route that names no opening kind. */
  const routed = (seed: number, stated?: "open"): MapPlan =>
    dungeonPlan({
      generator: 5,
      seed,
      w: 30,
      h: 16,
      areas: [
        room("hall", 1, 1, 12, 9, "Great hall"),
        room("vault", 20, 1, 5, 4, "Treasury"),
        room("side", 20, 10, 5, 4, "Chamber"),
        { id: "pass", kind: "corridor", name: "Passage", shape: { type: "rect", x: 15, y: 5, w: 2, h: 8 } },
        ...(["hall", "vault", "side"] as const).map((to): Area => ({
          id: `to-${to}`,
          kind: "corridor",
          shape: { type: "route", from: "pass", to, ...(stated ? { openings: stated } : {}) },
        })),
      ],
    });
  const kindsOf = (p: MapPlan): Map<string, string> => {
    const L = resolvePlan(p, pal).levels[0];
    if (!L) throw new Error("no level");
    const out = new Map<string, string>();
    for (const o of L.openings) {
      const room = o.sides.find((s) => s === "hall" || s === "vault" || s === "side");
      if (room && o.id.startsWith("to-")) out.set(room, o.kind);
    }
    return out;
  };

  it("an unnamed route opening says what it opens into; some levels keep every one plain", () => {
    let byRole = 0;
    let plain = 0;
    for (const seed of SEEDS) {
      const k = kindsOf(routed(seed));
      if (k.get("vault") === "locked_door") {
        byRole++;
        expect(k.get("hall")).toBe("archway");
        expect(k.get("side")).toBe("open");
      } else {
        plain++;
        expect([...k.values()].every((v) => v === "open")).toBe(true);
      }
    }
    expect(byRole).toBeGreaterThan(plain);
    expect(plain).toBeGreaterThan(0);
  });

  it("a route that names its openings keeps them", () => {
    for (const seed of SEEDS.slice(0, 6))
      expect([...kindsOf(routed(seed, "open")).values()].every((v) => v === "open")).toBe(true);
  });
});
