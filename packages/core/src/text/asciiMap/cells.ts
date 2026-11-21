/**
 * What each cell shows: a feature letter per feature type, link arrows, the cell's base character (rock, void,
 * links, holes, bridges, water, lava, paths, heights), and the "!" marks of the issues in view.
 */
import type { ResolvedPlan } from "../../contracts/resolved";
import { CELL, CELL_FLAG } from "../../contracts/resolved";
import type { Vec2 } from "../../contracts/plan";
import { featureInfo } from "../../gen/catalog";
import type { AsciiCtx, AsciiSeen } from "./context";

/** Letters a feature type may take (its own initials first); the ones the map uses for other things are left out. */
const FEATURE_POOL = "ABCEFGHIJKMNPQRTUVXYZbcefghijkmnoqrtuvxyz";
/** The highest raised floor (half tiles) still drawn as a digit; higher or odd quarter heights read "^". */
const MAX_DIGIT_HEIGHT = 18;

export interface CellView {
  base: string;
  feat: string | null;
  featId: string | null;
}

export interface FeatureChars {
  /** Feature letter and id over each covered cell (a blocking feature wins over a rug). */
  featAt: Map<number, { ch: string; id: string }>;
  /** Letter and name of each feature type in view, in first-seen order. */
  legend: Array<[string, string]>;
}

/** A letter per feature type in view and the cells each feature covers. */
export function featureChars(c: AsciiCtx): FeatureChars {
  const { rx0, ry0, rx1, ry1 } = c;
  const featChar = new Map<string, string>();
  const used = new Set<string>();
  const legend: Array<[string, string]> = [];
  const featAt = new Map<number, { ch: string; id: string }>();
  for (const f of c.lvl.features) {
    const inView = f.at[0] < rx1 && f.at[0] + f.size[0] > rx0 && f.at[1] < ry1 && f.at[1] + f.size[1] > ry0;
    if (!inView) continue;
    let ch = featChar.get(f.type);
    if (ch === undefined) {
      const name = f.type.replace(/_/g, "");
      const prefs = (name.toUpperCase() + FEATURE_POOL).split("");
      ch = prefs.find((p) => p !== "" && FEATURE_POOL.includes(p) && !used.has(p)) ?? "?";
      used.add(ch);
      featChar.set(f.type, ch);
      legend.push([ch, featureInfo(f.type).label.toLowerCase()]);
    }
    for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
      for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) {
        const i = c.cellI(x, y);
        if (i >= 0 && (!featAt.has(i) || f.blocking)) featAt.set(i, { ch, id: f.id });
      }
  }
  return { featAt, legend };
}

export interface LinkCells {
  /** Cells of links going up from this level, and of links arriving from below. */
  up: Set<number>;
  down: Set<number>;
  /** One line per link touching the level. */
  notes: string[];
}

/** Cells of the links touching the level, and a note for each. */
export function linkCells(c: AsciiCtx, resolved: Pick<ResolvedPlan, "links"> | null): LinkCells {
  const { lvl, opts } = c;
  const up = new Set<number>();
  const down = new Set<number>();
  const notes: string[] = [];
  for (const link of resolved?.links ?? []) {
    const label = (id: string): string => opts.levelLabels?.[id] ?? id;
    if (link.fromLevel === lvl.id) {
      for (const p of link.lowerCells) up.add(c.cellI(p[0], p[1]));
      notes.push(`${link.id}: ${link.kind} up to ${label(link.toLevel)} from ${fmtCells(link.lowerCells)}`);
    }
    if (link.toLevel === lvl.id) {
      for (const p of link.upperCells) down.add(c.cellI(p[0], p[1]));
      notes.push(
        `${link.id}: ${link.kind} down to ${label(link.fromLevel)}, arrive ${link.arrival[0]},${link.arrival[1]}`,
      );
    }
  }
  return { up, down, notes };
}

function fmtCells(cells: readonly Vec2[]): string {
  return cells.map((p) => `${p[0]},${p[1]}`).join(" ");
}

/**
 * The reader of a cell's view (outside the level: an empty base). Records the base characters and heights it shows in
 * `seen` (base characters only for cells inside the region, heights for every cell read).
 */
export function cellViewer(
  c: AsciiCtx,
  feats: FeatureChars,
  links: LinkCells,
  seen: AsciiSeen,
): (gx: number, gy: number) => CellView {
  const { lvl } = c;
  // the map draws deep water and lava with their own characters (a legend line each)
  const deepIdx = lvl.materials.indexOf("water_deep") + 1;
  const lavaIdx = lvl.materials.indexOf("lava") + 1;
  return (gx, gy) => {
    const i = c.cellI(gx, gy);
    if (i < 0) return { base: "", feat: null, featId: null };
    const st = lvl.cells.state[i];
    const fl = lvl.cells.flags[i] as number;
    let base: string;
    if (st === CELL.SOLID) base = "#";
    else if (st === CELL.VOID) base = " ";
    else if (links.up.has(i) || fl & CELL_FLAG.LINK) base = ">";
    else if (fl & CELL_FLAG.STAIRWELL || links.down.has(i)) base = "<";
    else if (fl & CELL_FLAG.NO_FLOOR) base = "O";
    else if (fl & CELL_FLAG.BRIDGE) base = "=";
    else if (fl & CELL_FLAG.WATER) base = deepIdx > 0 && lvl.cells.material[i] === deepIdx ? "W" : "~";
    else if (lavaIdx > 0 && lvl.cells.material[i] === lavaIdx) base = "%";
    else if (fl & CELL_FLAG.PATH) base = ",";
    else {
      const q = lvl.cells.height[i] as number;
      // raised floor in half tiles as a digit (tiers read at a glance), other raised heights "^", sunken "_"
      base = q < 0 ? "_" : q > 0 ? (q % 2 === 0 && q <= MAX_DIGIT_HEIGHT ? String(q / 2) : "^") : ".";
      if (q < 0) seen.low.add(q);
      if (q > 0 && base === "^") seen.high.add(q);
    }
    if (c.inView(gx, gy)) seen.base.add(base);
    const f = feats.featAt.get(i);
    return { base, feat: f && base !== ">" && base !== "<" ? f.ch : null, featId: f ? f.id : null };
  };
}

/** What a cell shows: its feature letter, else its base character. */
export const shown = (v: CellView): string => v.feat ?? v.base;

export interface IssueMarks {
  /** "x,y" of each marked cell. */
  marked: Set<string>;
  notes: string[];
}

/** Issue markers: "!" on the offending cells inside the view, one note each. */
export function issueMarks(c: AsciiCtx): IssueMarks {
  const marked = new Set<string>();
  const notes: string[] = [];
  for (const is of c.opts.issues ?? []) {
    if (is.levelId !== c.lvl.id || !is.cell) continue;
    const [mx, my] = is.cell;
    if (!c.inView(mx, my)) continue;
    marked.add(`${mx},${my}`);
    notes.push(`! ${mx},${my} ${is.severity} ${is.code}${is.elementId ? ` ${is.elementId}` : ""}`);
  }
  return { marked, notes };
}
