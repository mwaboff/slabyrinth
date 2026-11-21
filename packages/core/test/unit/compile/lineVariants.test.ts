/**
 * Upright pieces in a line mix their assets (a bank row of cypress after cypress reads as wallpaper). Along any row
 * or column, a run of four or more upright pieces of one role (each within three cells of the next) must not be
 * more than three quarters one asset. Measured on realized placements of the dressed test maps.
 */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import { realize } from "../../../src/compile";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import "../../../src/resolve/autoregister";
import { loadPlan } from "../../fixtures";

const UPRIGHT =
  /^feature\.(cluster_tall|formation|boulder|tree|pine_tree|dead_tree|stalagmite|standing_stone|monolith)$/;
const palettes = loadPalettes();

function runFaults(plan: MapPlan): string[] {
  const r = resolvePlan(plan, bundledPalettes());
  const set = realize(r, palettes, {});
  // one entry per feature (assemblies emit several pieces: the first is the feature's own asset)
  const byFeature = new Map<string, { role: string; x: number; y: number; asset: string }>();
  for (const L of r.levels) {
    const roleOf = new Map(L.features.map((f) => [f.id, `feature.${f.type}`]));
    const level = set.levels.find((l) => l.levelId === L.id);
    for (const p of level?.placements ?? []) {
      const id = p.source.elementId ?? "";
      const role = roleOf.get(id);
      if (!role || !UPRIGHT.test(role) || byFeature.has(id) || !p.source.cell) continue;
      byFeature.set(id, { role, x: p.source.cell[0], y: p.source.cell[1], asset: p.asset });
    }
  }
  const out: string[] = [];
  const pieces = [...byFeature.values()];
  for (const horiz of [true, false]) {
    const lines = new Map<string, typeof pieces>();
    for (const q of pieces) {
      const k = `${q.role}|${String(horiz ? q.y : q.x)}`;
      lines.set(k, [...(lines.get(k) ?? []), q]);
    }
    for (const [k, l] of lines) {
      l.sort((a, b) => (horiz ? a.x - b.x : a.y - b.y));
      let run: typeof pieces = [];
      const flush = (): void => {
        if (run.length >= 4) {
          const n = new Map<string, number>();
          for (const q of run) n.set(q.asset, (n.get(q.asset) ?? 0) + 1);
          const top = Math.max(...n.values());
          if (top * 4 > run.length * 3)
            out.push(`${k} (${horiz ? "row" : "column"}): ${String(top)}/${String(run.length)} one asset`);
        }
        run = [];
      };
      for (const q of l) {
        const last = run[run.length - 1];
        if (last && (horiz ? q.x - last.x : q.y - last.y) > 3) flush();
        run.push(q);
      }
      flush();
    }
  }
  return out;
}

describe("runs of upright pieces mix their assets", () => {
  for (const name of ["dressed-forest-v4", "hillside-v5"] as const)
    it(`${name}: no run of upright pieces is more than three quarters one asset`, () => {
      expect(runFaults(loadPlan(name))).toEqual([]);
    });
});
