/**
 * Market stall notes (generator 4: the review runs them where the generator builds covered stalls, `coveredStalls`).
 * The owner's market proof had bare tables in a tidy grid: no canopy, no cloth, every
 * stall the same. A market reads as a market when its stalls are covered and differ, so the review says so.
 *
 *   stalls_uncovered  a map whose theme has canopy pieces but whose stalls are bare tables (plan-placed stall features or
 *                     a palette fallback), with nothing over them
 *   stalls_grid       four or more stalls of one size standing in one line at one gap, or every stall the same size
 */
import type { ResolvedLevel } from "../contracts/resolved";
import { cellIndex, cellTheme, elementTheme } from "../resolve/levelGrid";
import type { DesignNote } from "./review";

const SCORE = { uncovered: 3.6, grid: 3.2 } as const;

export interface StallNoteInput {
  levelId: string;
  level: ResolvedLevel;
  /** Can a theme build a covered stall (palette/stallParts.ts, the resolver's and compiler's question)? Absent: assume yes. */
  canCoverStall?: (theme: string) => boolean;
  /** The theme a cell with no theme reads as (the build's default theme). */
  defaultTheme: string;
}

export function stallNotes(input: StallNoteInput): DesignNote[] {
  const stalls = input.level.features.filter((f) => f.type === "stall");
  if (stalls.length < 3) return [];
  const out: DesignNote[] = [];
  // a bare table counts where its own theme (its own, else its cell's) could have covered it
  const L = input.level;
  const themeOf = (f: (typeof stalls)[number]): string =>
    elementTheme(
      f.theme,
      cellTheme(L, cellIndex(L.bounds, f.at[0] - L.bounds.x, f.at[1] - L.bounds.y), input.defaultTheme),
    );
  const bare = stalls.filter(
    (f) => f.stall === undefined && (input.canCoverStall ? input.canCoverStall(themeOf(f)) : true),
  );
  if (bare.length >= 2 && bare.length * 2 >= stalls.length) {
    out.push({
      code: "stalls_uncovered",
      levelId: input.levelId,
      score: SCORE.uncovered,
      cell: [bare[0]?.at[0] ?? 0, bare[0]?.at[1] ?? 0],
      elementIds: bare.slice(0, 4).map((f) => f.id),
      message: `${bare.length} of ${stalls.length} market stalls are bare tables with no canopy, though the theme has canopy pieces`,
      action:
        "lay the stalls out with Level.stalls (a stall row) so each is built with a base, skirted counters, posts and a cloth canopy; keep a plan-placed table only for the odd open stall",
    });
  }
  // a tidy grid: neighbours of one size in one line at one gap, or no variety of size at all
  const size = (f: (typeof stalls)[number]): string => `${f.size[0]}x${f.size[1]}`;
  const lineKey = (f: (typeof stalls)[number]): string => {
    const front = f.stall?.front ?? (f.rot === 0 ? "S" : f.rot === 90 ? "W" : f.rot === 180 ? "N" : "E");
    const across = front === "S" || front === "N";
    const edge =
      front === "S"
        ? f.at[1] + f.size[1]
        : front === "N"
          ? f.at[1]
          : front === "E"
            ? f.at[0] + f.size[0]
            : f.at[0];
    return `${front}${across ? "y" : "x"}${edge}`;
  };
  const lines = new Map<string, Array<(typeof stalls)[number]>>();
  for (const f of stalls) lines.set(lineKey(f), [...(lines.get(lineKey(f)) ?? []), f]);
  let regular: Array<(typeof stalls)[number]> | undefined;
  for (const row of lines.values()) {
    if (row.length < 4 || new Set(row.map(size)).size > 1) continue;
    const across = row[0]?.stall
      ? row[0].stall.front === "S" || row[0].stall.front === "N"
      : row[0]?.rot === 0 || row[0]?.rot === 180;
    const sorted = [...row].sort((a, b) => (across ? a.at[0] - b.at[0] : a.at[1] - b.at[1]));
    const gaps = sorted.slice(1).map((f, i) => {
      const p = sorted[i] as (typeof sorted)[number];
      return across ? f.at[0] - (p.at[0] + p.size[0]) : f.at[1] - (p.at[1] + p.size[1]);
    });
    if (new Set(gaps).size === 1) regular = sorted;
  }
  const sameSize = stalls.length >= 4 && new Set(stalls.map(size)).size === 1;
  if (regular || sameSize) {
    const group = regular ?? stalls;
    out.push({
      code: "stalls_grid",
      levelId: input.levelId,
      score: SCORE.grid,
      cell: [group[0]?.at[0] ?? 0, group[0]?.at[1] ?? 0],
      elementIds: group.slice(0, 4).map((f) => f.id),
      message: regular
        ? `${regular.length} stalls of one size stand in one line at an even gap: a grid, not a market`
        : `all ${stalls.length} stalls are the same size`,
      action:
        "mix sizes (small, medium, large), kinds of goods and gaps; Level.stalls does this by itself, so use it rather than placing stalls one by one",
    });
  }
  return out;
}
