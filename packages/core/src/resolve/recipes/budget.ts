/**
 * The detail budget (plan §5), in one place. Each level gets `B = d × T`: its footprint tiles `T` counted by what they
 * are (`d` from TUNINGS `detailBudget`: rooms and corridors, built exteriors, natural ground). A map whose levels
 * together ask more than the map ceiling has every level's B scaled down by the same share (big maps get less detail
 * per tile, not less on some levels), and no level gets more than its own ceiling (ARRANGE_LIMITS.piecesPerLevel).
 *
 * When a level's recipes project more pieces than its budget (`spend`):
 *   1. thinnable recipes are spread (their repeats at half density), calm anchors first;
 *   2. tier 3, then tier 2 instances are dropped, calm anchors first (focus ascending, then anchor key), so the focal
 *      places keep their detail and the contrast survives the cut;
 *   3. tiers 0 and 1 are never dropped (what makes a map read at any budget); past the level's ceiling the attach
 *      itself thins the finest pieces (resolve/level/arrangements.ts).
 * The order is deterministic.
 */
import { ARRANGE_LIMITS } from "../../arrange";
import type { ResolvedLevel } from "../../contracts/resolved";
import { CELL } from "../../contracts/resolved";
import type { DetailBudgetTuning } from "../../plan/generator";

/** Footprint tiles of a level by what they are. */
export interface LevelTiles {
  readonly interior: number;
  readonly builtExterior: number;
  readonly natural: number;
}

export function levelTiles(L: ResolvedLevel): LevelTiles {
  const built = new Set<number>();
  for (const st of L.structures ?? [])
    if (st.kind === "building")
      for (const [x, y] of st.cells) {
        const lx = x - L.bounds.x;
        const ly = y - L.bounds.y;
        if (lx >= 0 && ly >= 0 && lx < L.bounds.w && ly < L.bounds.h) built.add(ly * L.bounds.w + lx);
      }
  let interior = 0;
  let builtExterior = built.size;
  let natural = 0;
  const n = L.bounds.w * L.bounds.h;
  for (let i = 0; i < n; i++) {
    if (built.has(i) || (L.cells.state[i] ?? CELL.VOID) !== CELL.OPEN) continue;
    const kind = L.areas[(L.cells.area[i] ?? 0) - 1]?.kind;
    if (kind === "room" || kind === "corridor") interior++;
    else if (kind === "building" || kind === "courtyard" || kind === "bridge") builtExterior++;
    else natural++;
  }
  return { interior, builtExterior, natural };
}

/** Each level's detail budget, by level id (see the file header). */
export function detailBudgets(levels: readonly ResolvedLevel[], t: DetailBudgetTuning): Map<string, number> {
  const asked = levels.map((L) => {
    const k = levelTiles(L);
    return k.interior * t.interior + k.builtExterior * t.builtExterior + k.natural * t.natural;
  });
  const total = asked.reduce((s, b) => s + b, 0);
  const share = total > t.perMap ? t.perMap / total : 1;
  return new Map(
    levels.map((L, i) => [
      L.id,
      Math.min(ARRANGE_LIMITS.piecesPerLevel, Math.floor((asked[i] ?? 0) * share)),
    ]),
  );
}

/** One recipe instance the engine proposes, before the budget. */
export interface Proposal {
  readonly key: string;
  readonly tier: 0 | 1 | 2 | 3;
  /** Focal score of its anchor, 0 (calm) .. 1 (a door, the focal point). */
  readonly focus: number;
  readonly count: number;
  /** Its thinned form, when the recipe is thinnable: pieces at half density (count), or null when it cannot. */
  readonly thinned: (() => Proposal | null) | null;
}

export interface Spending<P extends Proposal> {
  readonly kept: P[];
  readonly dropped: P[];
  readonly thinned: number;
  readonly projected: number;
  readonly spent: number;
}

const calmFirst = (a: Proposal, b: Proposal): number =>
  a.focus - b.focus || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** The proposals a budget keeps (in their original order), by the rule in the file header. */
export function spend<P extends Proposal>(proposals: readonly P[], budget: number): Spending<P> {
  const projected = proposals.reduce((s, p) => s + p.count, 0);
  let total = projected;
  const list: P[] = [...proposals];
  let thinned = 0;
  if (total > budget)
    for (const p of [...list].filter((q) => q.thinned !== null).sort(calmFirst)) {
      if (total <= budget) break;
      const t = p.thinned?.() as P | null | undefined;
      if (!t || t.count >= p.count) continue;
      list[list.indexOf(p)] = t;
      total -= p.count - t.count;
      thinned++;
    }
  const dropped: P[] = [];
  for (const tier of [3, 2] as const) {
    if (total <= budget) break;
    for (const p of list.filter((q) => q.tier === tier).sort(calmFirst)) {
      if (total <= budget) break;
      dropped.push(p);
      total -= p.count;
    }
  }
  const out = new Set(dropped);
  return { kept: list.filter((p) => !out.has(p)), dropped, thinned, projected, spent: total };
}
