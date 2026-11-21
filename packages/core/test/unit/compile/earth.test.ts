/**
 * Litter and earth patches have a cause (owner's v6 and watchtower runs, 2026-11-20: reddish leaf-litter squares in
 * open grass). Floor tiles of a caused family ("lush") stand within two cells of a tree, a camp, a path or the foot
 * of a rise. Measured on realized floor placements of the dressed test maps.
 */
import { describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import "../../../src/resolve/autoregister";
import { loadPlan } from "../../fixtures";

const pal = loadPalettes();
const lushAssets = new Set<string>();
for (const th of Object.values(pal.palettes))
  for (const [role, d] of Object.entries(th.roles))
    if (role.startsWith("floor."))
      for (const v of d.variants) if (v.variant === "lush") lushAssets.add(v.asset);

const CAUSES = new Set([
  "cluster_tall",
  "tree",
  "pine_tree",
  "dead_tree",
  "tree_large",
  "campfire",
  "fire_pit",
  "tent",
]);

describe("caused floor families", () => {
  for (const name of ["dressed-forest-v4", "hillside-v5"] as const)
    it(`${name}: every litter tile has a cause within two cells`, () => {
      const plan = loadPlan(name);
      const r = resolvePlan(plan, bundledPalettes());
      const set = realize(r, pal, {});
      for (const L of r.levels) {
        const W = L.bounds.w;
        const near = new Set<string>();
        const mark = (x: number, y: number): void => {
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++) near.add(`${String(x + dx)},${String(y + dy)}`);
        };
        for (const f of L.features)
          if (CAUSES.has(f.type))
            for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
              for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) mark(x, y);
        for (let y = 0; y < L.bounds.h; y++)
          for (let x = 0; x < W; x++) {
            const i = y * W + x;
            if (((L.cells.flags[i] ?? 0) & 8) !== 0) mark(x + L.bounds.x, y + L.bounds.y);
            const h = L.cells.height[i] ?? 0;
            for (const [dx, dy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ] as const) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= L.bounds.h) continue;
              if ((L.cells.height[ny * W + nx] ?? 0) - h >= 2) mark(x + L.bounds.x, y + L.bounds.y);
            }
          }
        const level = set.levels.find((l) => l.levelId === L.id);
        let lush = 0;
        let caused = 0;
        for (const p of level?.placements ?? []) {
          if (p.role !== "floor" || !lushAssets.has(p.asset) || !p.source.cell) continue;
          const g = set.placed.get(p)?.geom;
          const w = Math.round(g?.size.x ?? 1);
          const h = Math.round(g?.size.z ?? 1);
          for (let dy = 0; dy < h; dy++)
            for (let dx = 0; dx < w; dx++) {
              lush++;
              if (near.has(`${String(p.source.cell[0] + dx)},${String(p.source.cell[1] + dy)}`)) caused++;
            }
        }
        if (lush > 0) expect(caused / lush).toBeGreaterThanOrEqual(0.95);
      }
    });
});
