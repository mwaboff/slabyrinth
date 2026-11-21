/**
 * Floor accent tone (generator 4). A pale accent reads as a spotlit slab: a marble dais top in a flagstone hall looked
 * like "a stark white rectangle", the palest thing on the board. The resolver now tones such a platform top down
 * (resolve/interiorFloors.ts accentTop), so this note catches what remains: a patch of floor of a much paler material
 * than the room round it (a pale painted patch, a pale raised floor), which reads as a spotlit slab.
 *
 *   floor_accent_tone   a patch of 6 or more cells, under 45% of its area, whose floor material is paler (by a tone
 *                       step) than the area's main floor, in an interior (a level with solid base cells)
 */
import { CELL } from "../contracts/resolved";
import type { ResolvedLevel } from "../contracts/resolved";
import { toneOf } from "../resolve/interiorFloors";
import type { DesignNote } from "./review";

const SCORE = 3.4;
const MIN_CELLS = 6;
const MAX_SHARE = 0.45;

/** The review runs it where the generator tones accents itself (`floorAccentReview`, plan/generator.ts). */
export function floorAccentNotes(levelId: string, L: ResolvedLevel): DesignNote[] {
  if (!L.cells.state.some((s) => s === CELL.SOLID)) return [];
  const byArea = new Map<number, Map<number, number[]>>();
  const n = L.bounds.w * L.bounds.h;
  for (let i = 0; i < n; i++) {
    const a = L.cells.area[i] ?? 0;
    const m = L.cells.material[i] ?? 0;
    if (a === 0 || m === 0 || L.cells.state[i] !== CELL.OPEN) continue;
    const mats = byArea.get(a) ?? new Map<number, number[]>();
    const cells = mats.get(m) ?? [];
    cells.push(i);
    mats.set(m, cells);
    byArea.set(a, mats);
  }
  const out: DesignNote[] = [];
  for (const [a, mats] of [...byArea].sort((x, y) => x[0] - y[0])) {
    const total = [...mats.values()].reduce((s, c) => s + c.length, 0);
    if (total < 12) continue;
    const main = [...mats].sort((x, y) => y[1].length - x[1].length || x[0] - y[0])[0];
    if (!main) continue;
    const mainMat = L.materials[main[0] - 1];
    const mainTone = toneOf(mainMat);
    if (mainTone === undefined) continue;
    for (const [m, cells] of [...mats].sort((x, y) => x[0] - y[0])) {
      if (m === main[0] || cells.length < MIN_CELLS || cells.length > total * MAX_SHARE) continue;
      const mat = L.materials[m - 1];
      const tone = toneOf(mat);
      if (tone === undefined || tone < mainTone + 1) continue;
      const first = cells[0] as number;
      const areaId = L.areaIds[a - 1] ?? "";
      out.push({
        code: "floor_accent_tone",
        levelId,
        score: SCORE,
        cell: [L.bounds.x + (first % L.bounds.w), L.bounds.y + Math.floor(first / L.bounds.w)],
        elementIds: areaId ? [areaId] : [],
        message: `a ${cells.length}-cell patch of ${mat} floor is much paler than the ${mainMat} round it in area ${areaId || a}: it reads as a stark pale slab`,
        action: `lay it in a stone of the room's own family or a darker one (or carpet), so the raised or accent floor is the room's tone`,
      });
    }
  }
  return out.slice(0, 2);
}
