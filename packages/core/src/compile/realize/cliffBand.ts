/**
 * Realize, rock band pass (generators 2 and 3): where the theme has the formation roles, natural cliff runs are faced
 * by the dressing's rock band. This pass decides, before any floor is laid, which cells the band changes; it places
 * nothing. Also the band's tones (`CliffTones`), which the feature pass reads too.
 * Reads: the level's cliffs and cliff features, the palette's formation roles. Writes: the `RockBand` it returns (read
 * by the floor and fill passes); the memos inside `CliffTones`.
 */
import type { ThemeId } from "../../contracts/plan";
import { cliffRockKinds, edgeHidden, type RockShape } from "../../gen/cover";
import { SIDE_STEP } from "../../gen/gridGeometry";
import { isBandRock } from "../../gen/catalog";
import type { ResolvedVariant } from "../../palette/resolve";
import { CLIFF_CREST_ROLE, CLIFF_FACE_ROLE } from "../../palette/roles";
import type { RealizeLevel } from "./level";

/** Rock band (generator 2, themes with cliff.formation_face): rise that gets a band, and how far it reaches. */
export const BAND = { minRiseQ: 8, out: 2, back: 2 } as const;

/** The cells of the level the rock band changes (all cell indices, `V.index`). */
export interface RockBand {
  /** Low ground in front of a tall band edge: natural ground there is laid as rock (floors.ts). */
  readonly low: ReadonlySet<number>;
  /** Cells just behind a tall band edge: no face blocks and no hidden fill (fill.ts). */
  readonly back: ReadonlySet<number>;
  /** Upper cells of a band edge the band left bare: they get a face block of one family (fill.ts). */
  readonly bare: ReadonlySet<number>;
}

const NO_BAND: RockBand = { low: new Set(), back: new Set(), bare: new Set() };

/**
 * The rock tones of a level's cliffs (generator 3, `cliffToneRule`): one rock tone per cliff (gen/cover.ts
 * cliffRockKinds), a kind of rock with no piece in the cliff's tone is not built (its drops get the plain block face),
 * and the dressing rock near a cliff follows the tone. Memoised per level: the band pass and the feature pass share one.
 */
export class CliffTones {
  private readonly kindMemo = new Map<ThemeId, ReturnType<typeof cliffRockKinds>>();
  /** Cells within 3 of a band rock ("x,y"), built on first use. */
  private nearCells: Set<string> | undefined = undefined;

  constructor(private readonly lv: RealizeLevel) {}

  /** Which kinds of band rock (face, crest) the theme can build in its cliff tone. */
  kinds(theme: ThemeId): ReturnType<typeof cliffRockKinds> {
    const { L } = this.lv;
    const { profile, lookup } = this.lv.ctx;
    if (!profile.cliffToneRule) return { face: true, crest: true };
    let k = this.kindMemo.get(theme);
    if (k === undefined) {
      const vs = (role: string): readonly ResolvedVariant[] =>
        lookup(L.id, theme, [role], undefined, true)?.variants ?? [];
      k = cliffRockKinds(vs(CLIFF_FACE_ROLE), vs(CLIFF_CREST_ROLE));
      this.kindMemo.set(theme, k);
    }
    return k;
  }

  /** Boulders of a tone the theme's boulder role lacks (role cliff.formation_crest_<tone>), for cliffs and rock beside them. */
  boulders(theme: ThemeId, tone: string): readonly ResolvedVariant[] {
    const { L } = this.lv;
    const { lookup } = this.lv.ctx;
    return (lookup(L.id, theme, [`cliff.formation_crest_${tone}`], undefined, true)?.variants ?? []).filter(
      (u) => u.weight > 0,
    );
  }

  /** Is the cell within 3 cells of a band rock (generator 3)? */
  near(x: number, y: number): boolean {
    if (this.nearCells === undefined) {
      const cells = new Set<string>();
      for (const q of this.lv.L.features) {
        if (!isBandRock(q.type)) continue;
        for (let dy = -3; dy < q.size[1] + 3; dy++)
          for (let dx = -3; dx < q.size[0] + 3; dx++) cells.add(`${q.at[0] + dx},${q.at[1] + dy}`);
      }
      this.nearCells = cells;
    }
    return this.nearCells.has(`${x},${y}`);
  }
}

/**
 * Rock band (generator 2, `cliffRockBand`): where the theme has the formation roles, natural cliff runs of 2 tiles or
 * more are faced by the dressing's rock band. Under the band the low ground is rock floor (about 2 cells out), the face
 * has no 1×1 blocks and the cells behind the edge (about 2 back) no hidden fill. Generator 3 (`restingCliffBand`) tests
 * what the rocks as they stand hide.
 */
export function planRockBand(lv: RealizeLevel, tones: CliffTones): RockBand {
  const { L, V } = lv;
  const { profile, lookup } = lv.ctx;
  if (!profile.cliffRockBand) return NO_BAND;
  const low = new Set<number>();
  const back = new Set<number>();
  const bare = new Set<number>();
  /** Adds a cell of the level (cells outside it are never asked about). */
  const mark = (set: Set<number>, x: number, y: number): void => {
    const i = V.index(x, y);
    if (i >= 0) set.add(i);
  };
  const bandThemes = new Map<string, boolean>();
  const hasBand = (theme: ThemeId): boolean => {
    let b = bandThemes.get(theme);
    if (b === undefined) {
      b = Boolean(lookup(L.id, theme, [CLIFF_FACE_ROLE], undefined, true));
      bandThemes.set(theme, b);
    }
    return b;
  };
  const restingBand = profile.restingCliffBand;
  const rockShapes = restingBand ? restingRocks(lv, tones) : [];
  for (const run of L.cliffs ?? [])
    for (const e of run.edges) {
      if (e.high - e.low < (restingBand ? 4 : BAND.minRiseQ)) continue;
      const c0 = V.cell(e.at[0], e.at[1]);
      if (!hasBand(c0.theme)) continue;
      const [dx, dy] = SIDE_STEP[e.side];
      const tallEdge = e.high - e.low >= BAND.minRiseQ;
      if (tallEdge) {
        for (let k = 1; k <= BAND.out; k++) mark(low, e.at[0] + dx * k, e.at[1] + dy * k);
        for (let k = 0; k < BAND.back; k++) mark(back, e.at[0] - dx * k, e.at[1] - dy * k);
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
              isBandRock(f.type) &&
              tones.kinds(f.theme)[f.type === "cliff_face" ? "face" : "crest"] &&
              mx >= f.at[0] - 0.3 &&
              mx <= f.at[0] + f.size[0] + 0.3 &&
              my >= f.at[1] - 0.3 &&
              my <= f.at[1] + f.size[1] + 0.3,
          );
      if (!covered) mark(bare, e.at[0], e.at[1]);
    }
  return { low, back, bare };
}

/** Generator 3: the band's rocks as they stand (real outline, turn, slide, vertical span), to test what hides a face. */
function restingRocks(lv: RealizeLevel, tones: CliffTones): RockShape[] {
  const { L } = lv;
  const { lookup } = lv.ctx;
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
  const rockShapes: RockShape[] = [];
  for (const f of L.features) {
    if (!isBandRock(f.type)) continue;
    if (!tones.kinds(f.theme)[f.type === "cliff_face" ? "face" : "crest"]) continue;
    const ext =
      f.type === "cliff_face"
        ? extent(f.theme, CLIFF_FACE_ROLE, false)
        : extent(f.theme, CLIFF_CREST_ROLE, true);
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
  return rockShapes;
}
