/**
 * Realize, rock band pass (generators 2 and 3): where the theme has the formation roles, natural cliff runs are faced
 * by the dressing's rock band. This pass decides, before any floor is laid, which cells the band changes; it places
 * nothing. Also the band's tone helpers, which the feature pass uses too.
 * Reads: the level's cliffs and cliff features, the palette's formation roles. Writes: `bandLow`, `bandBack`,
 * `bandBare`; the tone helpers fill the memos `kindMemo` and `cliffCells`.
 */
import type { ThemeId } from "../../contracts/plan";
import { cliffRockKinds, edgeHidden, type RockShape } from "../../gen/cover";
import type { ResolvedVariant } from "../../palette/resolve";
import type { LevelWork } from "./work";

/** Rock band (generator 2, themes with cliff.formation_face): rise that gets a band, and how far it reaches. */
export const BAND = { minRiseQ: 8, out: 2, back: 2 } as const;

// generator 3: one rock tone per cliff (gen/cover.ts cliffRockKinds): a kind of rock with no piece in the cliff's
// tone is not built (its drops get the plain block face), and the dressing rock near a cliff follows the tone
export function cliffKinds(w: LevelWork, theme: ThemeId): ReturnType<typeof cliffRockKinds> {
  const { L, kindMemo } = w;
  const { gen, lookup } = w.ctx;
  if (!gen.cliffToneRule) return { face: true, crest: true };
  let k = kindMemo.get(theme);
  if (k === undefined) {
    const vs = (role: string): readonly ResolvedVariant[] =>
      lookup(L.id, theme, [role], undefined, true)?.variants ?? [];
    k = cliffRockKinds(vs("cliff.formation_face"), vs("cliff.formation_crest"));
    kindMemo.set(theme, k);
  }
  return k;
}

/** Boulders of a tone the theme's boulder role lacks (role cliff.formation_crest_<tone>), for cliffs and rock beside them. */
export function toneBoulders(w: LevelWork, theme: ThemeId, tone: string): readonly ResolvedVariant[] {
  const { L } = w;
  const { lookup } = w.ctx;
  return (lookup(L.id, theme, [`cliff.formation_crest_${tone}`], undefined, true)?.variants ?? []).filter(
    (u) => u.weight > 0,
  );
}

/** Is the cell within 3 cells of a band rock (generator 3)? */
export function nearCliff(w: LevelWork, x: number, y: number): boolean {
  const { L } = w;
  let cliffCells = w.cliffCells;
  if (cliffCells === undefined) {
    cliffCells = new Set();
    for (const q of L.features) {
      if (q.type !== "cliff_face" && q.type !== "cliff_crest") continue;
      for (let dy = -3; dy < q.size[1] + 3; dy++)
        for (let dx = -3; dx < q.size[0] + 3; dx++) cliffCells.add(`${q.at[0] + dx},${q.at[1] + dy}`);
    }
    w.cliffCells = cliffCells;
  }
  return cliffCells.has(`${x},${y}`);
}

// rock band (generator 2): where the theme has the formation roles, natural cliff runs of 2 tiles or more are
// faced by the dressing's rock band. Under the band the low ground is rock floor (about 2 cells out), the face has
// no 1×1 blocks and the cells behind the edge (about 2 back) no hidden fill.
export function planRockBand(w: LevelWork): void {
  const { L, V, bandLow, bandBack, bandBare } = w;
  const { gen, lookup } = w.ctx;
  const bandThemes = new Map<string, boolean>();
  const hasBand = (theme: ThemeId): boolean => {
    let b = bandThemes.get(theme);
    if (b === undefined) {
      b = Boolean(lookup(L.id, theme, ["cliff.formation_face"], undefined, true));
      bandThemes.set(theme, b);
    }
    return b;
  };
  // generator 3: the rocks as they stand (real outline, turn, slide, vertical span), to test what hides a face
  const restingBand = gen.restingCliffBand;
  const rockShapes: RockShape[] = [];
  if (restingBand) {
    const extent = (
      theme: ThemeId,
      role: string,
      tall: boolean,
    ): { w: number; d: number; h: number } | undefined => {
      const r = lookup(L.id, theme, [role], undefined, true);
      const vs = (r?.variants ?? []).filter((q) => q.weight > 0 && (!tall || q.geom.size.y >= 1.2));
      const v = [...vs].sort((a, b) => b.weight - a.weight)[0];
      return v ? { w: v.geom.size.x, d: v.geom.size.z, h: v.geom.size.y } : undefined;
    };
    for (const f of L.features) {
      if (f.type !== "cliff_face" && f.type !== "cliff_crest") continue;
      if (!cliffKinds(w, f.theme)[f.type === "cliff_face" ? "face" : "crest"]) continue;
      const ext =
        f.type === "cliff_face"
          ? extent(f.theme, "cliff.formation_face", false)
          : extent(f.theme, "cliff.formation_crest", true);
      if (!ext) continue;
      rockShapes.push({
        cx: f.at[0] + f.size[0] / 2 + (f.offset?.[0] ?? 0),
        cy: f.at[1] + f.size[1] / 2 + (f.offset?.[1] ?? 0),
        rot: f.rotFine,
        w: ext.w,
        d: ext.d,
        base: f.baseHeight,
        top: f.baseHeight + ext.h,
      });
    }
  }
  if (gen.cliffRockBand)
    for (const run of L.cliffs ?? [])
      for (const e of run.edges) {
        if (e.high - e.low < (restingBand ? 4 : BAND.minRiseQ)) continue;
        const c0 = V.cell(e.at[0], e.at[1]);
        if (!hasBand(c0.theme)) continue;
        const [dx, dy] =
          e.side === "N" ? [0, -1] : e.side === "S" ? [0, 1] : e.side === "E" ? [1, 0] : [-1, 0];
        const tallEdge = e.high - e.low >= BAND.minRiseQ;
        if (tallEdge) {
          for (let k = 1; k <= BAND.out; k++) bandLow.add(`${e.at[0] + dx * k},${e.at[1] + dy * k}`);
          for (let k = 0; k < BAND.back; k++) bandBack.add(`${e.at[0] - dx * k},${e.at[1] - dy * k}`);
        }
        // what the band actually placed: an edge with no rock over its midpoint keeps a face behind it (no hole)
        const mx = e.at[0] + 0.5 + dx * 0.5;
        const my = e.at[1] + 0.5 + dy * 0.5;
        const base = L.elevation + 0.5;
        const covered = restingBand
          ? edgeHidden(
              rockShapes,
              mx,
              my,
              dy !== 0 ? 1 : 0,
              dx !== 0 ? 1 : 0,
              base + e.low / 4,
              base + e.high / 4,
            )
          : L.features.some(
              (f) =>
                (f.type === "cliff_face" || f.type === "cliff_crest") &&
                cliffKinds(w, f.theme)[f.type === "cliff_face" ? "face" : "crest"] &&
                mx >= f.at[0] - 0.3 &&
                mx <= f.at[0] + f.size[0] + 0.3 &&
                my >= f.at[1] - 0.3 &&
                my <= f.at[1] + f.size[1] + 0.3,
            );
        if (!covered) bandBare.add(`${e.at[0]},${e.at[1]}`);
      }
}
