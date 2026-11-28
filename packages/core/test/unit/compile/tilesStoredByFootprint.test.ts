/**
 * Generator 6's `tilesStoredByFootprint`: the game draws a tile at quarter turns only, with the turned footprint's
 * min corner at the stored point (the owner's paste test, 2026-11-26, docs/decisions.md). So generator 6 gives a tile
 * quarter turns only, and the switch stays one of its own: turned off alone, it changes only the cave wall's pieces,
 * and every other generator-6 change still holds.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { PaletteVariant, Placement } from "../../../src/contracts/compiler";
import { realize } from "../../../src/compile";
import { verifyBuild } from "../../../src/compile/verify/verify";
import { bundledPalettes } from "../../../src/palette";
import { NATURAL_WALL_ROLE } from "../../../src/palette/roles";
import { GENERATOR_PROFILES } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { loadPlan, STORED_PLANS, type StoredPlan } from "../../fixtures";

const pal = bundledPalettes();
const profile6 = GENERATOR_PROFILES[6] as { tilesStoredByFootprint: boolean };

afterEach(() => {
  profile6.tilesStoredByFootprint = true;
});

/** Each placement of a generator-6 build as a line, in the set's order. */
const build = (name: StoredPlan): { lines: string[]; placements: Placement[]; errors: string[] } => {
  const plan = { ...loadPlan(name), generator: 6 as const };
  const r = resolvePlan(plan, pal);
  const set = realize(r, pal);
  const placements = set.levels.flatMap((l) => l.placements);
  const errors = verifyBuild(r, set, pal, { plan })
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.code);
  return {
    lines: placements.map((p) => `${p.asset} ${String(p.x)},${String(p.y)},${String(p.z)} r${String(p.rot)}`),
    placements,
    errors,
  };
};

/** The cave wall's own pieces (its rock mass, caps, foot stones and wall columns). */
const CAVE_WALL_IDS: ReadonlySet<string> = new Set(["cave_mass", "cave_cap", "cave_foot", NATURAL_WALL_ROLE]);
const ofCaveWall = (p: Placement): boolean => CAVE_WALL_IDS.has(p.source.elementId ?? "");

describe("tilesStoredByFootprint is independent of every other generator-6 switch", () => {
  it.each(["sea-grotto", "inn-interior-v1", "market-street-v3"] as const)(
    "%s: turned off alone, only the cave wall's pieces change, and verify finds no error",
    (name) => {
      const on = build(name);
      profile6.tilesStoredByFootprint = false;
      const off = build(name);
      expect(off.errors).toEqual([]);
      const rest = (b: typeof on): string[] =>
        b.lines.filter((_, i) => !ofCaveWall(b.placements[i] as Placement));
      expect(rest(off)).toEqual(rest(on));
      if (name === "sea-grotto") expect(off.lines).not.toEqual(on.lines);
      else expect(off.lines).toEqual(on.lines);
    },
  );
});

describe("generator 6 turns a tile in quarter turns only (the game draws no other turn of a tile)", () => {
  const geoms = new Map<string, PaletteVariant["geom"]>();
  for (const p of Object.values(pal.palettes))
    for (const r of Object.values(p.roles))
      for (const v of r.variants) {
        if (!geoms.has(v.asset)) geoms.set(v.asset, v.geom);
        for (const [u, g] of Object.entries(v.alternateGeom ?? {})) if (!geoms.has(u)) geoms.set(u, g);
      }

  it.each(STORED_PLANS)("%s", (name) => {
    const { placements } = build(name);
    const offTurn = placements
      .filter((p) => geoms.get(p.asset)?.originAt === "minCorner" && p.rot % 90 !== 0)
      .map((p) => `${p.source.elementId ?? "?"} ${p.asset} r${String(p.rot)}`);
    expect([...new Set(offTurn)]).toEqual([]);
  });
});
