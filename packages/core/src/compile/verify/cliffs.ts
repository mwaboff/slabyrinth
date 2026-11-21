/**
 * Rock-band cliffs (generator 2 on, switch `cliffRockBand`): a natural edge of 2 tiles or more whose face realize left
 * to the band (no rock block on it, no fill behind it) must be covered by band rock, or the void behind it shows.
 *
 * Emits `verify_cliff_gap` (warning), one per level with the first edge and the count.
 */
import { SIDE_STEP } from "../../gen/gridGeometry";
import { isBandRock } from "../../gen/catalog";
import { CLIFF_FACE_ROLE } from "../../palette/roles";
import type { VerifyCtx } from "./context";
import { CLIFF_COVER_MARGIN, CLIFF_GAP_RISE_Q } from "./limits";

export function checkCliffBand(ctx: VerifyCtx): void {
  if (!ctx.profile.cliffRockBand) return;
  for (const L of ctx.levels) {
    const runs = L.cliffs ?? [];
    const g = ctx.grids.get(L.id);
    if (runs.length === 0 || !g) continue;
    const rocks = L.features.filter((f) => isBandRock(f.type));
    const placed = ctx.set.levels.find((s) => s.levelId === L.id)?.placements ?? [];
    // cells realize stood a rock block (a ledge piece) in
    const blocks = new Set(
      placed
        .filter((p) => p.role === "ledge" && p.source.cell)
        .map((p) => `${p.source.cell?.[0] ?? ""},${p.source.cell?.[1] ?? ""}`),
    );
    let holes = 0;
    let firstHole: [number, number] | null = null;
    for (const run of runs)
      for (const e of run.edges) {
        if (e.high - e.low < CLIFF_GAP_RISE_Q) continue;
        // edges on the level's border are the board's edge: slabs are tiled beside other slabs
        const lx = e.at[0] - L.bounds.x;
        const ly = e.at[1] - L.bounds.y;
        if (lx <= 0 || ly <= 0 || lx >= L.bounds.w - 1 || ly >= L.bounds.h - 1) continue;
        if (!ctx.resolveRole(g.cell(e.at[0], e.at[1]).theme, CLIFF_FACE_ROLE).resolution) continue;
        if (blocks.has(`${e.at[0]},${e.at[1]}`)) continue;
        const [dx, dy] = SIDE_STEP[e.side];
        const mx = e.at[0] + 0.5 + dx * 0.5;
        const my = e.at[1] + 0.5 + dy * 0.5;
        const covered = rocks.some(
          (f) =>
            mx >= f.at[0] - CLIFF_COVER_MARGIN &&
            mx <= f.at[0] + f.size[0] + CLIFF_COVER_MARGIN &&
            my >= f.at[1] - CLIFF_COVER_MARGIN &&
            my <= f.at[1] + f.size[1] + CLIFF_COVER_MARGIN,
        );
        if (covered) continue;
        holes++;
        firstHole ??= [e.at[0], e.at[1]];
      }
    if (holes > 0 && firstHole)
      ctx.report.add({
        severity: "warning",
        code: "verify_cliff_gap",
        levelId: L.id,
        cell: firstHole,
        count: holes,
        message: `${holes} cliff edge${holes === 1 ? "" : "s"} on level ${L.id} rise 2 tiles or more with no rock in front and no face behind (first at (${firstHole[0]},${firstHole[1]})): the void under the upper ground shows.`,
        hint: "dress the cliff with its rock band (a dress op over the level), or move what keeps the band off that edge",
      });
  }
}
