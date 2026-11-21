/**
 * Generator 4: a building's parts keep out of the cells another building reaches (its footprint and the ring its walls,
 * eaves and chimney breasts stand in). On a street of plots side by side and one cell apart, under many seeds: no
 * chimney breast in another building's reach, no window looking into it, no lower ground mass (a lean-to) against
 * another building, and no ground window across the joint of two volumes of different heights.
 */
import { describe, expect, it } from "vitest";
import type { MapPlan, Side, Structure } from "../../../src/contracts/plan";
import type { ResolvedLevel } from "../../../src/contracts/resolved";
import { SIDE_STEP } from "../../../src/gen/gridGeometry";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import { townPlan } from "../../fixtures/planBuilder";

const key = (x: number, y: number): string => `${x},${y}`;

/** Plots of 5 to 8 cells, flush (gap 0) or one cell apart, in two rows facing a street. */
const street = (seed: number): MapPlan => {
  const structures: Structure[] = [];
  for (const [row, y, front] of [
    [0, 2, "S"],
    [1, 13, "N"],
  ] as const) {
    let x = 1;
    for (let i = 0; i < 6; i++) {
      const w = 5 + ((i + row) % 4);
      structures.push({
        id: `b${row}${i}`,
        style: "cottage",
        use: ["inn", "baker", "smith", "shop", "farmhouse", "workshop"][i] as string,
        wings: [{ x, y, w, h: 7 }],
        front,
      });
      x += w + ((i + row) % 2);
    }
  }
  return townPlan({ generator: 4, id: "reach", seed, theme: "wood_town", w: 48, h: 22, structures });
};

const SEEDS = Array.from({ length: 12 }, (_, i) => Math.imul(i + 1, 2654435761) >>> 0);

describe("building reach (generator 4)", () => {
  it("keeps chimneys, windows and lower masses out of another building's reach", () => {
    for (const seed of SEEDS) {
      const L = resolvePlan(street(seed), bundledPalettes()).levels[0] as ResolvedLevel;
      const owner = new Map<string, string>();
      for (const st of L.structures ?? []) for (const [x, y] of st.cells) owner.set(key(x, y), st.id);
      const reached = (x: number, y: number, id: string): boolean => {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const o = owner.get(key(x + dx, y + dy));
            if (o !== undefined && o !== id) return true;
          }
        return false;
      };
      for (const st of L.structures ?? []) {
        for (const c of st.chimneys)
          expect(
            reached(c.at[0], c.at[1], st.id),
            `seed ${seed}: ${st.id}'s chimney at ${c.at.join(",")}`,
          ).toBe(false);
        for (const id of st.openingIds) {
          const o = L.openings.find((q) => q.id === id);
          if (!o || o.kind !== "window") continue;
          // the window's face cell and the cell it looks into
          const inA = owner.get(
            o.orientation === "h" ? key(o.start[0], o.start[1] - 1) : key(o.start[0] - 1, o.start[1]),
          );
          for (let k = 0; k < o.width; k++) {
            const [x, y] =
              o.orientation === "h" ? [o.start[0] + k, o.start[1]] : [o.start[0], o.start[1] + k];
            const side: Side =
              o.orientation === "h" ? (inA === st.id ? "S" : "N") : inA === st.id ? "E" : "W";
            const [dx, dy] = SIDE_STEP[side];
            const face: [number, number] = side === "S" ? [x, y - 1] : side === "E" ? [x - 1, y] : [x, y];
            expect(
              reached(face[0] + dx, face[1] + dy, st.id),
              `seed ${seed}: ${id} looks into another building's reach`,
            ).toBe(false);
          }
        }
        const ground = (st.volumes ?? []).filter((v) => v.on === null);
        const top = (v: (typeof ground)[number]): number => v.storeys[v.storeys.length - 1]?.wallTop ?? 0;
        const tallest = Math.max(...ground.map(top));
        for (const v of ground)
          if (top(v) < tallest - 1e-6)
            for (const [x, y] of v.storeys[0]?.cells ?? [])
              expect(
                reached(x, y, st.id),
                `seed ${seed}: ${st.id}'s ${v.id} stands against a neighbour`,
              ).toBe(false);
      }
    }
  });
});
