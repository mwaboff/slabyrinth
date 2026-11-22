/**
 * ASCII view of a resolved level for the model (architecture §3.3 item 3).
 * Double resolution: a (2w+1)×(2h+1) character grid; odd/odd positions are cells, even positions are edges and
 * vertices. Levels (or crops) wider than 60 cells switch to 1 character per cell (no walls) with a hint.
 *
 * The steps live in text/asciiMap/: context.ts (the crop, AsciiSeen), cells.ts (what a cell shows), grid.ts (the
 * rows), legend.ts (opening characters, the legend). The legend lists only what the drawn rows showed, so it is
 * written after them.
 */
import type { LevelId } from "../contracts/plan";
import type { ResolvedLevel, ResolvedPlan } from "../contracts/resolved";
import { cellViewer, featureChars, issueMarks, linkCells } from "./asciiMap/cells";
import { type AsciiOptions, createAsciiCtx, newSeen } from "./asciiMap/context";
import { doubleCharRows, overviewRows, singleCharRows } from "./asciiMap/grid";
import { legendLines } from "./asciiMap/legend";

export type { AsciiOptions } from "./asciiMap/context";
export { OPENING_CHAR } from "./asciiMap/legend";

/** Crops wider than this many cells are drawn one character per cell (no walls) unless the caller says otherwise. */
const MAX_DOUBLE_WIDTH = 60;

/**
 * The most cells one view draws one by one: 160 × 160, the largest level before the size limit rose to 320
 * (decisions.md 2026-11-21), so a view never costs the model more than it did then. A larger crop is drawn as an
 * overview, one character per block of cells, with a line saying how to ask for a region in full.
 */
export const MAX_VIEW_CELLS = 160 * 160;

export function asciiView(resolved: ResolvedPlan, levelId: LevelId, opts: AsciiOptions = {}): string {
  const lvl = resolved.levels.find((l) => l.id === levelId);
  if (!lvl) return `(no level "${levelId}")`;
  return asciiLevel(lvl, resolved, opts);
}

export function asciiLevel(
  lvl: ResolvedLevel,
  resolved: Pick<ResolvedPlan, "links"> | null,
  opts: AsciiOptions = {},
): string {
  const c = createAsciiCtx(lvl, opts);
  if (!c) return "(empty region)";
  const feats = featureChars(c);
  const links = linkCells(c, resolved);
  const seen = newSeen();
  const view = cellViewer(c, feats, links, seen);
  const marks = issueMarks(c);
  const maxW = opts.maxDoubleWidth ?? MAX_DOUBLE_WIDTH;
  const maxCells = opts.maxCells ?? MAX_VIEW_CELLS;
  const lines =
    c.rw * c.rh > maxCells
      ? overviewRows(c, view, marks.marked, maxCells, maxW)
      : c.rw > maxW
        ? singleCharRows(c, view, marks.marked, maxW)
        : doubleCharRows(c, view, seen, marks.marked);
  if (opts.legend ?? true) lines.push(...legendLines(seen, feats.legend, links.notes, marks.notes));
  return lines.join("\n");
}
