/**
 * The content of an applied create/edit, in this order: the change report with the CHECKS line, the changed-region
 * view, the design review (generators with one), the issue maps.
 */
import type { DesignBrief, LevelId, MapPlan, PlanIssue } from "../../contracts/plan";
import type { PaletteCatalog } from "../../contracts/compiler";
import { generatorProfile } from "../../plan/generator";
import { briefCheckLine, designReviewDelta, reviewDesign } from "../../review";
import { checksLine, issueWhere, type CheckResults } from "../checks";
import { RESULT_VIEW_BUDGET, changeReportJson, clip } from "../report";
import type { PlanChangeReport, ToolResultContent } from "../tools";
import type { ToolRunCtx } from "./context";
import { maxOf, minOf } from "../../util/lists";

type ReportErr = NonNullable<PlanChangeReport["errors"]>[number];
type ReportWarning = NonNullable<PlanChangeReport["warnings"]>[number];

/** Budget for the issue-map block of a create/edit result. */
const ISSUE_VIEW_BUDGET = 3000;
/** The change report lists at most this many playability errors and warnings each. */
const REPORT_FINDINGS_CAP = 50;
/** Cells of margin around the flagged cells in an issue map (before, and after the last flagged cell). */
const ISSUE_MAP_MARGIN = 3;

/** One applied change: what the report, the views and the review are built from. */
export interface AppliedChange {
  palettes: PaletteCatalog;
  report: PlanChangeReport;
  checks: CheckResults;
  before: MapPlan | null;
  after: MapPlan;
  dirtyLevels: LevelId[];
  brief?: DesignBrief;
}

export function appliedContent(r: ToolRunCtx, change: AppliedChange): ToolResultContent[] {
  const { report, checks } = change;
  const entries = checkEntries(checks);
  const full: PlanChangeReport = { ...report, errors: entries.errors, warnings: entries.warnings };
  const content: ToolResultContent[] = [
    { type: "text", text: `${changeReportJson(full)}\n${checksLine(checks)}` },
  ];
  const view = changeView(r, change);
  if (view) content.push({ type: "text", text: view });
  const review = designReview(r, change);
  if (review) content.push({ type: "text", text: review });
  const maps = issueMaps(r, change.palettes, change.after, report.version, checks);
  if (maps) content.push({ type: "text", text: maps });
  return content;
}

/** The second block of a create/edit result: changed-region ASCII, degrading to an outline (§3.3 item 1). */
function changeView(r: ToolRunCtx, change: AppliedChange): string {
  const { palettes, before, after, dirtyLevels } = change;
  const version = change.report.version;
  const prevResolved = before ? r.resolve(palettes, before, version - 1) : null;
  const nextResolved = r.resolve(palettes, after, version);
  if (nextResolved && r.ports.changedViews) {
    const v = r.ports.changedViews(prevResolved, nextResolved, { maxChars: RESULT_VIEW_BUDGET });
    if (v.fits && v.views.length > 0) return v.views.map((x) => x.text).join("\n");
  }
  if (r.ports.outline) {
    const levels = dirtyLevels.length > 0 ? dirtyLevels : after.levels.map((l) => l.id);
    return clip(r.ports.outline(after, nextResolved, { version, levels }), RESULT_VIEW_BUDGET);
  }
  return "";
}

/**
 * The design review (review/): measured advice, never an error, for generators that have one. A later result for the
 * same plan shows what changed: new notes in full, open ones short, cleared ones. "" when there is nothing to say.
 */
function designReview(r: ToolRunCtx, change: AppliedChange): string {
  const { palettes, before, after, brief = {} } = change;
  if (!generatorProfile(after).designReview) return "";
  try {
    const resolved = r.resolve(palettes, after, change.report.version);
    const notes = resolved ? reviewDesign(after, resolved, palettes, { brief }) : null;
    const previous = before === null ? undefined : r.lastReview.get(after.id);
    const text = notes ? designReviewDelta(notes, previous, briefCheckLine(brief, after)) : "";
    if (notes) r.lastReview.set(after.id, notes);
    return text;
  } catch (e) {
    // advice only: a failing review never costs the model its result, but it leaves a trace
    const why = e instanceof Error ? e.message : String(e);
    return `DESIGN REVIEW unavailable (internal error: ${why.slice(0, 120)})`;
  }
}

/** ASCII crops around the cells of error/warning findings, marked with "!" (last block of a create/edit result). */
function issueMaps(
  r: ToolRunCtx,
  palettes: PaletteCatalog,
  plan: MapPlan,
  version: number,
  c: CheckResults,
): string {
  const flagged = [...c.errors, ...c.warnings].filter((i) => i.cell !== undefined && i.levelId !== undefined);
  if (flagged.length === 0 || !r.ports.ascii) return "";
  const resolved = r.resolve(palettes, plan, version);
  if (!resolved) return "";
  const out: string[] = [];
  let used = 0;
  for (const level of plan.levels) {
    const here = flagged.filter((i) => i.levelId === level.id);
    if (here.length === 0) continue;
    const xs = here.map((i) => i.cell?.[0] ?? 0);
    const ys = here.map((i) => i.cell?.[1] ?? 0);
    const b = level.bounds;
    const x0 = Math.max(b.x, minOf(xs) - ISSUE_MAP_MARGIN);
    const y0 = Math.max(b.y, minOf(ys) - ISSUE_MAP_MARGIN);
    const x1 = Math.min(b.x + b.w, maxOf(xs) + ISSUE_MAP_MARGIN + 1);
    const y1 = Math.min(b.y + b.h, maxOf(ys) + ISSUE_MAP_MARGIN + 1);
    const text = `ISSUES ON ${level.id} ("!" marks the cell):\n${r.ports.ascii(resolved, level.id, {
      region: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      issues: here,
    })}`;
    if (used + text.length > ISSUE_VIEW_BUDGET) break;
    used += text.length;
    out.push(text);
  }
  return out.join("\n");
}

/** The playability findings, in full with hints (capped at 50 each), for the change report. */
function checkEntries(c: CheckResults): { errors: ReportErr[]; warnings: ReportWarning[] } {
  const msg = (i: PlanIssue): string => {
    const where = issueWhere(i);
    return where ? `${i.message} [${where}]` : i.message;
  };
  const errors = c.errors.slice(0, REPORT_FINDINGS_CAP).map((i): ReportErr => {
    const e: ReportErr = { code: i.code, msg: msg(i) };
    if (i.path !== undefined) e.path = i.path;
    if (i.hint !== undefined) e.hint = i.hint;
    return e;
  });
  const warnings = c.warnings.slice(0, REPORT_FINDINGS_CAP).map((i): ReportWarning => {
    const w: ReportWarning = { code: i.code, msg: msg(i) };
    if (i.elementId !== undefined) w.id = i.elementId;
    if (i.hint !== undefined) w.hint = i.hint;
    return w;
  });
  return { errors, warnings };
}

/** The same finding listed twice (same code, message, element and cell) is shown once. */
export function dedupeIssues(c: CheckResults): CheckResults {
  const uniq = (xs: PlanIssue[]): PlanIssue[] => {
    const seen = new Set<string>();
    return xs.filter((i) => {
      const k = JSON.stringify([i.code, i.message, i.elementId ?? null, i.cell ?? null]);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  return { errors: uniq(c.errors), warnings: uniq(c.warnings), info: uniq(c.info) };
}
