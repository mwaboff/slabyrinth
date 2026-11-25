/**
 * Findings of two builds compared (the generator loop: before and after a change): a finding is the same one in both
 * when its code, level and place match (its box's centre to the nearest tile; its plan cells when it has some).
 */
import type { Finding } from "./types";

export function findingKey(f: Finding): string {
  const b = f.where.box;
  const c = (lo: number, hi: number): number => Math.round((lo + hi) / 2);
  const place =
    f.where.cells.length > 0
      ? f.where.cells
          .map(([x, y]) => `${String(x)},${String(y)}`)
          .sort()
          .join(";")
      : `${String(c(b.min.x, b.max.x))},${String(c(b.min.y, b.max.y))},${String(c(b.min.z, b.max.z))}`;
  return `${f.code}|${f.where.levelId}|${place}`;
}

export interface FindingsDiff {
  added: Finding[];
  fixed: Finding[];
  unchanged: number;
}

export function compareFindings(before: readonly Finding[], after: readonly Finding[]): FindingsDiff {
  const count = new Map<string, number>();
  for (const f of before) count.set(findingKey(f), (count.get(findingKey(f)) ?? 0) + 1);
  const added: Finding[] = [];
  let unchanged = 0;
  for (const f of after) {
    const k = findingKey(f);
    const n = count.get(k) ?? 0;
    if (n > 0) {
      count.set(k, n - 1);
      unchanged++;
    } else added.push(f);
  }
  const fixed: Finding[] = [];
  for (const f of before) {
    const k = findingKey(f);
    const n = count.get(k) ?? 0;
    if (n > 0) {
      count.set(k, n - 1);
      fixed.push(f);
    }
  }
  return { added, fixed, unchanged };
}
