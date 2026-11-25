/**
 * Settle finds what a thing stands on by the support relation the resolver made (generator 6, `unevenTops`,
 * compile/realize/settle.ts), not by its base matching a height: a thing lifted for a taller variant of its support is
 * still set on the variant that was built, and a thing on a piece never measured moves with that piece.
 */
import { describe, expect, it } from "vitest";
import type { Box3, PlacedAsset, Placement } from "../../../src/contracts/compiler";
import type { ResolvedFeature, ResolvedLevel } from "../../../src/contracts/resolved";
import { realize } from "../../../src/compile";
import { placementBox } from "../../../src/compile/geometry";
import { settleOnSupports } from "../../../src/compile/realize/settle";
import type { RealizeLevel } from "../../../src/compile/realize/level";
import { restSpotAt } from "../../../src/compile/restOn";
import { verifyBuild } from "../../../src/compile/verify/verify";
import { bundledPalettes, loadPalettes, measuredRest, restGridOf, restPieces } from "../../../src/palette";
import { generatorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { loadPlan } from "../../fixtures";

const FLOOR = 0.5;

/**
 * A level with a measured workbench centred on (5.5, 5.5), a crate (never measured) set `lift` over its rest height
 * with its centre at x `crateX`, and a cup set on the crate.
 */
function scene(
  lift: number,
  crateX: (bench: Box3) => number,
): {
  lv: RealizeLevel;
  bench: Placement;
  crate: Placement;
  cup: Placement;
  placed: Map<Placement, PlacedAsset>;
} {
  const bench = restPieces(loadPalettes().palettes).find((p) => p.name === "Workbench");
  if (!bench) throw new Error("fixture: the bundled palettes have a Workbench");
  const rest = measuredRest(bench.asset, bench.geom);
  if (rest === undefined || !restGridOf(bench.asset, bench.geom))
    throw new Error("fixture: the Workbench is measured");
  const placed = new Map<Placement, PlacedAsset>();
  const turns = new Map<Placement, number>();
  const feature = (id: string, baseHeight: number): ResolvedFeature => ({
    id,
    type: "clutter",
    at: [5, 5],
    size: [1, 1],
    rot: 0,
    rotFine: 0,
    baseHeight,
    theme: "t",
    blocking: false,
  });
  const put = (
    id: string,
    asset: string,
    geom: PlacedAsset["geom"],
    box: Box3,
    x: number,
    y: number,
    z: number,
  ): Placement => {
    const p: Placement = {
      asset,
      x,
      y,
      z,
      rot: 0,
      role: "feature",
      levelId: "L",
      source: { elementId: id, cell: [5, 5] },
    };
    placed.set(p, { name: id, geom, box });
    turns.set(p, 0);
    return p;
  };
  // the bench centred on (5.5, 5.5), its bottom on the floor
  const b = placementBox(
    bench.geom,
    5.5 - bench.geom.boundsCenter.x,
    FLOOR,
    5.5 - bench.geom.boundsCenter.z,
    0,
  );
  const shift = (bb: Box3, dy: number): Box3 => ({
    min: { ...bb.min, y: bb.min.y + dy },
    max: { ...bb.max, y: bb.max.y + dy },
  });
  const benchP = put(
    "bench",
    bench.asset,
    bench.geom,
    shift(b, FLOOR - b.min.y),
    5.5 - bench.geom.boundsCenter.x,
    FLOOR,
    5.5 - bench.geom.boundsCenter.z,
  );
  // the crate, 0.3 tall (a taller variant's top would be `lift` over the built one's)
  const crateGeom = {
    size: { x: 0.4, y: 0.3, z: 0.4 },
    originAt: "center" as const,
    boundsCenter: { x: 0, y: 0.15, z: 0 },
    lengthAxis: "square" as const,
  };
  const crateY = FLOOR + rest + lift;
  const x = crateX(shift(b, FLOOR - b.min.y));
  const crateBox: Box3 = {
    min: { x: x - 0.2, y: crateY, z: 5.3 },
    max: { x: x + 0.2, y: crateY + 0.3, z: 5.7 },
  };
  const crateP = put("crate", "00000000-0000-0000-0000-00000000c4a7", crateGeom, crateBox, x, crateY, 5.5);
  const cupGeom = {
    size: { x: 0.1, y: 0.1, z: 0.1 },
    originAt: "center" as const,
    boundsCenter: { x: 0, y: 0.05, z: 0 },
    lengthAxis: "square" as const,
  };
  const cupY = crateY + 0.3;
  const cupBox: Box3 = {
    min: { x: x - 0.05, y: cupY, z: 5.45 },
    max: { x: x + 0.05, y: cupY + 0.1, z: 5.55 },
  };
  const cupP = put("cup", "00000000-0000-0000-0000-0000000000c9", cupGeom, cupBox, x, cupY, 5.5);
  const L = {
    id: "L",
    features: [
      { ...feature("bench", FLOOR), type: "counter", blocking: true },
      feature("crate", crateY),
      feature("cup", cupY),
    ],
    lines: [],
  } as unknown as ResolvedLevel;
  const lv = {
    ctx: { profile: generatorProfile(6), placed, turns },
    placements: [benchP, crateP, cupP],
    rebox: (p: Placement, box: Box3) => {
      const k = placed.get(p);
      if (k) k.box = box;
    },
    L,
    topOf: () => FLOOR,
    V: { cell: () => ({}) },
  } as unknown as RealizeLevel;
  return { lv, bench: benchP, crate: crateP, cup: cupP, placed };
}

describe("settle by what a thing stands on (generator 6, unevenTops)", () => {
  it("a thing lifted for a taller variant of its support is set on the part of the built one under it", () => {
    const { lv, bench, crate, placed } = scene(0.1, () => 5.5);
    const before = crate.y;
    settleOnSupports(lv);
    const info = placed.get(bench);
    const box = placed.get(crate)?.box;
    if (!info || !box) throw new Error("placed");
    const spot = restSpotAt(
      { asset: bench.asset, geom: info.geom, box: info.box, cw: 0 },
      (box.min.x + box.max.x) / 2,
      (box.min.z + box.max.z) / 2,
    );
    expect(crate.y).toBeLessThan(before - 0.05);
    expect(crate.y).toBeCloseTo(spot?.y ?? NaN, 4);
  });

  it("a thing on a piece never measured moves with it and stands on its top", () => {
    // the crate set at its rest height but past the bench's end: it is moved in onto the top
    const { lv, crate, cup, placed } = scene(0, (b) => b.max.x + 0.1);
    const [x0, z0] = [crate.x, crate.z];
    const [cx0, cz0] = [cup.x, cup.z];
    settleOnSupports(lv);
    const crateBox = placed.get(crate)?.box;
    expect(crate.x - x0).toBeLessThan(-0.05);
    expect(cup.x - cx0).toBeCloseTo(crate.x - x0, 4);
    expect(cup.z - cz0).toBeCloseTo(crate.z - z0, 4);
    expect(cup.y).toBeCloseTo(crateBox?.max.y ?? NaN, 4);
  });
});

describe("things lifted for another variant of a stored plan's furniture", () => {
  it("are set on the built variant's top: none is left over it (inn-interior-v1, every lifted thing 0.1 higher)", () => {
    const pal = bundledPalettes();
    const r = resolvePlan({ ...loadPlan("inn-interior-v1"), generator: 6 }, pal);
    const lifted = new Set<string>();
    for (const L of r.levels)
      for (const f of L.features)
        if (f.type === "clutter" && f.baseHeight - (L.elevation + FLOOR) > 0.3) {
          f.baseHeight += 0.1;
          lifted.add(f.id);
        }
    expect(lifted.size).toBeGreaterThan(5);
    const set = realize(r, pal);
    const high = set.levels
      .flatMap((l) => l.placements)
      .filter((p) => lifted.has(p.source.elementId ?? ""))
      .filter((p) => {
        // the lifted thing still stands 0.1 over the top of the furniture under its centre
        const b = set.placed.get(p)?.box;
        if (!b) return false;
        const cx = (b.min.x + b.max.x) / 2;
        const cz = (b.min.z + b.max.z) / 2;
        return set.levels
          .flatMap((l) => l.placements)
          .some((q) => {
            const qi = set.placed.get(q);
            if (q === p || !qi || q.role !== "feature" || q.source.elementId === p.source.elementId)
              return false;
            if (cx < qi.box.min.x || cx > qi.box.max.x || cz < qi.box.min.z || cz > qi.box.max.z)
              return false;
            const s = restSpotAt(
              { asset: q.asset, geom: qi.geom, box: qi.box, cw: set.turns.get(q) ?? 0 },
              cx,
              cz,
            );
            return s !== undefined && Math.abs(p.y - s.y - 0.1) < 0.005;
          });
      });
    expect(high.map((p) => p.source.elementId)).toEqual([]);
  });
});

describe("verify holds a thing to a part of the top its outline reaches (generator 6, unevenTops)", () => {
  it("a thing over a part that holds nothing, far from any part that does, is not supported by that top", () => {
    const pal = bundledPalettes();
    const plan = { ...loadPlan("inn-interior-v1"), generator: 6 as const };
    const r = resolvePlan(plan, pal);
    const set = realize(r, pal);
    const all = set.levels.flatMap((l) => l.placements);
    // a thing standing on a measured top, and a point over that top whose nearest holding part is out of its reach
    for (const p of all) {
      const pb = set.placed.get(p)?.box;
      if (!pb || p.role !== "feature") continue;
      const hx = (pb.max.x - pb.min.x) / 2;
      const hz = (pb.max.z - pb.min.z) / 2;
      for (const q of all) {
        const qi = set.placed.get(q);
        if (q === p || !qi || q.role !== "feature" || q.source.elementId === p.source.elementId) continue;
        const sup = { asset: q.asset, geom: qi.geom, box: qi.box, cw: set.turns.get(q) ?? 0 };
        const here = restSpotAt(sup, pb.min.x + hx, pb.min.z + hz);
        if (!here || here.moved !== 0 || Math.abs(here.y - p.y) > 0.005) continue;
        for (let x = qi.box.min.x + 0.05; x < qi.box.max.x - 0.05; x += 0.05)
          for (let z = qi.box.min.z + 0.05; z < qi.box.max.z - 0.05; z += 0.05) {
            const s = restSpotAt(sup, x, z);
            if (!s || s.moved < Math.hypot(hx, hz) + 0.05 || Math.abs(s.y - p.y) > 0.005) continue;
            // moved there, at the height of that nearest part (verify before generator 6's fix called it held)
            const dx = x - (pb.min.x + hx);
            const dz = z - (pb.min.z + hz);
            p.x += dx;
            p.z += dz;
            const info = set.placed.get(p);
            if (info)
              info.box = {
                min: { ...pb.min, x: pb.min.x + dx, z: pb.min.z + dz },
                max: { ...pb.max, x: pb.max.x + dx, z: pb.max.z + dz },
              };
            const floating = verifyBuild(r, set, pal, { plan, repair: false }).diagnostics.filter(
              (d) => d.code === "verify_prop_floating" && d.elementId === p.source.elementId,
            );
            expect(floating, `${info?.name ?? p.asset} on ${qi.name}`).toHaveLength(1);
            return;
          }
      }
    }
    throw new Error("fixture: inn-interior-v1 has a thing on a top with a part that holds nothing");
  });
});
