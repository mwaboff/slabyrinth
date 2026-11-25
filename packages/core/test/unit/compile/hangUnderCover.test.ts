/**
 * A market stall's lantern hangs from the underside of the canopy over it (generator 6, `hangUnderCover`): the
 * canopy's measured underside over the lantern's point (palette/hangGrids.ts, read from below: a sloping cloth's low
 * side there, a thick canopy's underside), not its top surface (the lantern's top inside the cloth) nor its box's
 * underside (air under a sloping awning).
 */
import { describe, expect, it } from "vitest";
import type { Placement } from "../../../src/contracts/compiler";
import { realize } from "../../../src/compile";
import { undersideAt } from "../../../src/compile/restOn";
import { bundledPalettes, hangPieces, loadPalettes } from "../../../src/palette";
import { STALL_ROLES } from "../../../src/palette/roles";
import { resolvePlan } from "../../../src/resolve";
import { loadPlan, type StoredPlan } from "../../fixtures";

const pal = bundledPalettes();
const { palettes } = loadPalettes();
const canopies = new Set(hangPieces(palettes).map((p) => p.asset));
const lights = new Set(
  Object.values(palettes).flatMap((p) =>
    (p.roles[STALL_ROLES.light]?.variants ?? []).map((v) => v.asset.toLowerCase()),
  ),
);

/** Each stall lantern's top less the lowest measured canopy underside over its centre (tiles), at a generator. */
const gaps = (name: StoredPlan, generator: 5 | 6): number[] => {
  const r = resolvePlan({ ...loadPlan(name), generator }, pal);
  const set = realize(r, pal);
  const out: number[] = [];
  for (const l of set.levels) {
    const canopy = l.placements.filter((p) => canopies.has(p.asset.toLowerCase()));
    for (const p of l.placements) {
      if (!lights.has(p.asset.toLowerCase())) continue;
      const b = set.placed.get(p)?.box;
      if (!b) continue;
      const cx = (b.min.x + b.max.x) / 2;
      const cz = (b.min.z + b.max.z) / 2;
      const under = lowestUnder(set, canopy, cx, cz);
      if (under !== undefined) out.push(b.max.y - under);
    }
  }
  return out;
};

function lowestUnder(
  set: ReturnType<typeof realize>,
  canopy: readonly Placement[],
  x: number,
  z: number,
): number | undefined {
  let best: number | undefined;
  for (const q of canopy) {
    const info = set.placed.get(q);
    const cw = set.turns.get(q);
    if (!info || cw === undefined) continue;
    const u = undersideAt({ asset: q.asset, geom: info.geom, box: info.box, cw }, x, z);
    if (u !== undefined && (best === undefined || u < best)) best = u;
  }
  return best;
}

describe("a stall's lantern hangs from the canopy's underside (generator 6, hangUnderCover)", () => {
  it.each(["stall-lineup-v1", "market-street-v3", "night-market-v1"] as const)(
    "%s: at generator 6 every lantern under a measured canopy touches its underside",
    (name) => {
      const g6 = gaps(name, 6);
      expect(g6.length).toBeGreaterThan(0);
      for (const g of g6) expect(Math.abs(g)).toBeLessThan(0.02);
    },
  );

  it("at generator 5 they hang from the box's underside: some lanterns stand clear of the cloth over them", () => {
    const g5 = ["stall-lineup-v1", "market-street-v3", "night-market-v1"].flatMap((n) =>
      gaps(n as StoredPlan, 5),
    );
    expect(g5.some((g) => Math.abs(g) >= 0.02)).toBe(true);
  });
});
