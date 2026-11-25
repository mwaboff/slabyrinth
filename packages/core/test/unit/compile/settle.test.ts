/**
 * Things set on furniture stand on the part of its top under them (generator 6, `unevenTops`): the measured rest grid
 * (palette/restGrid.ts) is complete for the palettes' pieces, a point turns into a support's frame with its turn
 * (compile/restOn.ts), and realize settles every thing on a part that holds it (compile/realize/settle.ts).
 */
import { describe, expect, it } from "vitest";
import type { PlacementSet } from "../../../src/contracts/compiler";
import { realize } from "../../../src/compile";
import { worldTurn } from "../../../src/compile/geometry";
import { restSpotAt, type PlacedSupport } from "../../../src/compile/restOn";
import { loadPalettes, restGridOf, restPieces, restSpot } from "../../../src/palette";
import { loadOrientation } from "../../../src/palette/load";
import { resolvePlan } from "../../../src/resolve";
import { rotateXZ, turnedHalfExtents } from "../../../src/util/turn";
import { loadPlan, type StoredPlan } from "../../fixtures";

// (the measured grid table's coverage and guards: test/unit/palette/measuredTables.test.ts)

describe("a spot on a top (palette/restGrid.ts restSpot)", () => {
  // a 1 x 1 top in 2 x 2 cells: the front row holds things at 0.5, the back row is a slope (holds none)
  const grid = { nx: 2, nz: 2, heights: [0.5, 0.5, null, null] };

  it("a point over a part that holds things rests there", () => {
    expect(restSpot(grid, 1, 1, -0.2, -0.3)).toEqual({ lx: -0.2, lz: -0.3, rest: 0.5, moved: 0 });
  });

  it("a point over a part that does not, or past the edge, moves no further than well inside the nearest part that does", () => {
    const s = restSpot(grid, 1, 1, 0.3, 0.3);
    expect(s).toMatchObject({ lx: 0.3, lz: -0.125, rest: 0.5 });
    expect(s?.moved).toBeCloseTo(0.425, 9);
    expect(restSpot(grid, 1, 1, -0.9, -0.2)).toMatchObject({ lx: -0.375, lz: -0.2 });
  });

  it("a top no part of which holds a thing gives no spot", () => {
    expect(restSpot({ nx: 1, nz: 1, heights: [null] }, 1, 1, 0, 0)).toBeNull();
  });
});

describe("a point turns into the support's own frame (compile/restOn.ts)", () => {
  // a study desk: its writing top in front, a raised hutch behind
  const desk = restPieces(loadPalettes().palettes).find((p) => p.name === "desk_study_01");
  if (!desk) throw new Error("fixture: the bundled palettes have desk_study_01");
  if (!restGridOf(desk.asset, desk.geom)) throw new Error("fixture: desk_study_01 is measured");
  /** The desk standing centred on (10, 10), its bottom at 2, turned `cw`. */
  const at = (cw: number): PlacedSupport => {
    const e = turnedHalfExtents(desk.geom.size.x, desk.geom.size.z, cw);
    return {
      asset: desk.asset,
      geom: desk.geom,
      box: {
        min: { x: 10 - e.x, y: 2, z: 10 - e.z },
        max: { x: 10 + e.x, y: 2 + desk.geom.size.y, z: 10 + e.z },
      },
      cw,
    };
  };

  it("the same spot of the top is found at every turn", () => {
    // points over the desk in its own frame, turned with it: the same heights and spots at every turn
    const pts = [-0.4, 0, 0.4].flatMap((u) =>
      [-0.4, -0.1, 0.2, 0.4].map((v) => [u * desk.geom.size.x, v * desk.geom.size.z] as const),
    );
    const read = (cw: number): string[] =>
      pts.map(([lx, lz]) => {
        const r = rotateXZ(lx, lz, cw);
        const s = restSpotAt(at(cw), 10 + r.x, 10 + r.z);
        return s ? `${s.y.toFixed(3)} ${s.moved.toFixed(3)}` : "-";
      });
    const unturned = read(0);
    // the desk's top is not one height: the writing top and the hutch differ
    expect(new Set(unturned.map((s) => s.split(" ")[0])).size).toBeGreaterThan(1);
    for (const cw of [90, 180, 270, 45, 195]) expect(read(cw)).toEqual(unturned);
  });
});

describe("things set on furniture rest on the part of its top under them (generator 6, unevenTops)", () => {
  const palettes = loadPalettes();
  const { orientation } = loadOrientation();
  /** Things lifted onto a measured support whose base is not at its grid's height there (or the nearest part's). */
  const offTop = (name: StoredPlan, generator: 5 | 6): string[] => {
    const r = resolvePlan({ ...loadPlan(name), generator }, palettes);
    const set: PlacementSet = realize(r, palettes, {});
    const out: string[] = [];
    for (const L of r.levels) {
      const lv = set.levels.find((l) => l.levelId === L.id);
      if (!lv) continue;
      const lifted = new Set(
        L.features.filter((f) => f.baseHeight - (L.elevation + 0.5) > 0.3).map((f) => f.id),
      );
      const feats = lv.placements.filter((p) => p.role === "feature");
      for (const p of feats) {
        if (!lifted.has(p.source.elementId ?? "")) continue;
        const b = set.placed?.get(p)?.box;
        if (!b) continue;
        const cx = (b.min.x + b.max.x) / 2;
        const cz = (b.min.z + b.max.z) / 2;
        for (const q of feats) {
          const info = set.placed?.get(q);
          if (
            q === p ||
            !info ||
            !restGridOf(q.asset, info.geom) ||
            q.source.elementId === p.source.elementId
          )
            continue;
          const qb = info.box;
          if (cx < qb.min.x || cx > qb.max.x || cz < qb.min.z || cz > qb.max.z) continue;
          if (p.y < qb.min.y + 0.15 || p.y > qb.max.y + 0.06) continue;
          const spot = restSpotAt(
            { asset: q.asset, geom: info.geom, box: qb, cw: worldTurn(q.rot, orientation) },
            cx,
            cz,
          );
          if (spot && Math.abs(spot.y - p.y) > 0.02)
            out.push(`${set.placed?.get(p)?.name ?? p.asset} on ${info.name}`);
        }
      }
    }
    return out;
  };

  it("at generator 5 things on chests, altars and anvils stand off the part of the top under them", () => {
    expect(offTop("inn-interior-v1", 5).length).toBeGreaterThan(0);
  });

  it("at generator 6 every one stands on it", () => {
    expect(offTop("inn-interior-v1", 6)).toEqual([]);
    expect(offTop("purpose-lineup-v1", 6)).toEqual([]);
  });
});
