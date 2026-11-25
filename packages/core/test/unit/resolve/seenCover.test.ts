/**
 * Cover is laid where it is seen and hung where it holds (generator 6): no ground cover on a bed deep under the
 * level's water (`seenCover`, resolve/recipes/ground.ts), and a stall's lantern hangs from its canopy's measured surface
 * (`hangUnderCover`, compile/stalls.ts).
 */
import { describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import { worldTurn } from "../../../src/compile/geometry";
import { restSpotAt } from "../../../src/compile/restOn";
import { loadPalettes } from "../../../src/palette";
import { loadOrientation } from "../../../src/palette/load";
import { resolvePlan } from "../../../src/resolve";
import { resolveWithObjects } from "../../../src/resolve/objectSite";
import { loadPlan } from "../../fixtures";
import { HARBOUR_SPECS, harbourPlan } from "../../fixtures/harbour";

describe("no ground cover where the water hides it (generator 6, seenCover)", () => {
  /** Pieces of ground cover on the harbour basin's bed, 5 tiles under the vessels' waterline. */
  const bedCover = (generator: 5 | 6): number =>
    resolveWithObjects({ ...harbourPlan(), generator }, HARBOUR_SPECS, loadPalettes())
      .resolved.levels.filter((l) => l.id === "harbour")
      .flatMap((l) => l.arrangements ?? [])
      .filter((a) => a.recipe === "layeredGround")
      .reduce((n, a) => n + a.pieces.length, 0);

  it("generator 5 strews rocks over the deep bed; generator 6 lays none", () => {
    expect(bedCover(5)).toBeGreaterThan(100);
    expect(bedCover(6)).toBe(0);
  });
});

describe("a stall's lantern hangs from its canopy's real surface (generator 6, hangUnderCover)", () => {
  const palettes = loadPalettes();
  const { orientation } = loadOrientation();
  /** For each stall lantern: how far its top is under the canopy surface over it (0: it hangs from it). */
  const gaps = (generator: 5 | 6): number[] => {
    const r = resolvePlan({ ...loadPlan("stall-lineup-v1"), generator }, palettes);
    const set = realize(r, palettes, {});
    const out: number[] = [];
    for (const lv of set.levels) {
      const placed = lv.placements.map((p) => ({ p, info: set.placed.get(p) }));
      for (const { p, info } of placed) {
        if (!info || !/lantern/i.test(info.name)) continue;
        const b = info.box;
        const cx = (b.min.x + b.max.x) / 2;
        const cz = (b.min.z + b.max.z) / 2;
        // the canopy pieces of the same stall over the lantern
        const over = placed.flatMap(({ p: q, info: qi }) => {
          // (a piece over the lantern: its box reaching over the lantern's top, not standing from below it as a post)
          if (
            !qi ||
            q === p ||
            q.source.elementId !== p.source.elementId ||
            qi.box.min.y < b.min.y - 0.5 ||
            qi.box.max.y < b.max.y - 0.01
          )
            return [];
          if (cx < qi.box.min.x || cx > qi.box.max.x || cz < qi.box.min.z || cz > qi.box.max.z) return [];
          const s = restSpotAt(
            { asset: q.asset, geom: qi.geom, box: qi.box, cw: worldTurn(q.rot, orientation) },
            cx,
            cz,
          );
          return s && s.moved === 0 ? [s.y] : [];
        });
        if (over.length > 0) out.push(Math.min(...over) - b.max.y);
      }
    }
    return out;
  };

  it("generator 5 hangs it from the canopy's box, well under the cloth", () => {
    const g = gaps(5);
    expect(g.length).toBeGreaterThan(0);
    expect(Math.max(...g)).toBeGreaterThan(0.3);
  });

  it("generator 6 hangs it from the cloth", () => {
    const g = gaps(6);
    expect(g.length).toBeGreaterThan(0);
    for (const d of g) expect(Math.abs(d)).toBeLessThan(0.01);
  });
});
