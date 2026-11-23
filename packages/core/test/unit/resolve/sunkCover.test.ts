/**
 * Ground cover sunk into the ground stays in a floor piece (resolve/recipes/ground.ts, util/sunk.ts): over stored plans
 * with layered ground on paving a quarter tile thick (keep-dungeon's hall), on soil (ground-and-walls' yard and hall)
 * and in a cave with outcrops (heartroot-rift's hollow), each under several seeds, every built cover piece whose base
 * lies below the top of the ground under its centre (floor, fill or an outcrop's rock column) is sunk into a floor or
 * fill piece and keeps some of it under its base, measured on the built pieces themselves. Two placements once passed
 * the recipe and failed verify (`verify_prop_no_floor`): a rock pile sunk the whole depth of a dungeon tile (its base on
 * the tile's underside), and pieces sunk into the top of an outcrop, which is a rock column with no floor piece.
 */
import { describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import type { Box3 } from "../../../src/contracts/compiler";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { maxOf } from "../../../src/util/lists";
import { SUNK_FLOOR_KEPT } from "../../../src/util/sunk";
import { sweepPlan, sweepSeeds } from "../../sweep/seeds";

const pal = bundledPalettes();
/** A base this close above the ground's top rests on it (verify's SUPPORT_SLACK). */
const RESTS = 0.06;
/** The slab stores a coordinate to this step: a base may move half of it. */
const STEP = 0.01;

const under = (b: Box3, x: number, z: number): boolean =>
  b.min.x < x && b.max.x > x && b.min.z < z && b.max.z > z;

describe("sunk ground cover keeps a floor piece under its base", () => {
  // (a piece sunk near the whole depth of its floor, or onto an outcrop, is a draw in some tens: more seeds there)
  for (const [name, seeds] of [
    ["keep-dungeon-v8", 60],
    ["heartroot-rift-v7", 30],
    ["ground-and-walls-v1", 8],
  ] as const)
    it(`on ${name} under ${String(seeds)} seeds`, () => {
      const faults: string[] = [];
      let sunk = 0;
      for (const seed of sweepSeeds(seeds)) {
        const set = realize(resolvePlan(sweepPlan(name, seed), pal), pal, {});
        for (const L of set.levels) {
          const ground = L.placements
            .filter((p) => p.role === "floor" || p.role === "fill" || p.role === "ledge")
            .flatMap((p) => {
              const box = set.placed.get(p)?.box;
              return box ? [{ floor: p.role !== "ledge", box }] : [];
            });
          for (const p of L.placements) {
            if (p.role !== "feature" || !(p.source.elementId ?? "").startsWith("layeredGround@")) continue;
            const box = set.placed.get(p)?.box;
            if (!box) continue;
            const cx = (box.min.x + box.max.x) / 2;
            const cz = (box.min.z + box.max.z) / 2;
            const below = ground.filter((q) => under(q.box, cx, cz) && q.box.min.y <= p.y + RESTS);
            if (below.length === 0 || p.y >= maxOf(below.map((q) => q.box.max.y)) - RESTS) continue;
            sunk++;
            // the floor kept under the base, less what storing the base may take from it
            const floors = below.filter((q) => q.floor);
            const kept = floors.length === 0 ? -1 : maxOf(floors.map((q) => p.y - q.box.min.y));
            if (kept < SUNK_FLOOR_KEPT - STEP / 2)
              faults.push(`${name}@${String(seed)} ${p.source.elementId ?? ""}: ${kept.toFixed(3)} kept`);
          }
        }
      }
      expect(sunk).toBeGreaterThan(20);
      expect(faults).toEqual([]);
    }, 120_000);
});
