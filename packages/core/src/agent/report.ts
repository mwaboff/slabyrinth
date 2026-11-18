/**
 * Tool-result texts the model reads (architecture §3.3 item 1 and §3.4).
 *
 * A rejected call returns, as one text block:
 *   {"status":"rejected","version":7,"errors":[{"op":2,"code":"unknown_id","msg":"…","hint":"…"}, …]}
 *   REJECTED: nothing was applied; the plan is still v7. Fix all errors and call edit_plan again.
 * Errors are deduplicated and capped at 20; when capped, "total" gives the full count. Every error keeps its hint.
 */
import type { OpError } from "../contracts/ops";
import type { PlanIssue } from "../contracts/plan";
import type { ReportError } from "./inputs";
import type { PlanChangeReport, ToolResultContent } from "./tools";

export const MAX_REPORTED_ERRORS = 20;
/** Budget for the ASCII part of an edit result (§3.3 item 1). */
export const RESULT_VIEW_BUDGET = 4000;

export function fromOpError(e: OpError): ReportError {
  const r: ReportError = { op: e.opIndex, code: e.code, msg: e.message };
  if (e.path !== undefined) r.path = e.path;
  if (e.hint !== undefined) r.hint = e.hint;
  return r;
}

export function fromPlanIssue(i: PlanIssue, pathPrefix = ""): ReportError {
  const r: ReportError = { code: i.code, msg: i.message };
  if (i.path !== undefined) r.path = `${pathPrefix}${i.path}`;
  if (i.hint !== undefined) r.hint = i.hint;
  return r;
}

/** Removes exact duplicates (order kept) and caps the list. */
export function dedupeErrors(errors: readonly ReportError[]): { shown: ReportError[]; total: number } {
  const seen = new Set<string>();
  const unique: ReportError[] = [];
  for (const e of errors) {
    const key = JSON.stringify([e.op ?? null, e.code, e.path ?? null, e.msg, e.hint ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
  }
  return { shown: unique.slice(0, MAX_REPORTED_ERRORS), total: unique.length };
}

/** Orders keys of an error line the way §3.4 shows them. */
function orderedError(e: ReportError): ReportError {
  const o: ReportError = {} as ReportError;
  if (e.op !== undefined) o.op = e.op;
  o.code = e.code;
  if (e.path !== undefined) o.path = e.path;
  o.msg = e.msg;
  if (e.hint !== undefined) o.hint = e.hint;
  return o;
}

/**
 * The §3.4 rejection text. `version` is the unchanged head (0 = no plan yet); `tool` names the tool to call again.
 * `extra` lines (e.g. a fresh outline for stale_version) are appended after the REJECTED line.
 */
export function rejectionText(
  tool: string,
  version: number,
  errors: readonly ReportError[],
  extra?: string,
): string {
  const { shown, total } = dedupeErrors(errors);
  const header: Record<string, unknown> = { status: "rejected", version, errors: shown.map(orderedError) };
  if (total > shown.length) header["total"] = total;
  const where = version > 0 ? `the plan is still v${version}` : "there is still no plan";
  const lines = [
    JSON.stringify(header),
    `REJECTED: nothing was applied; ${where}. Fix all errors and call ${tool} again.`,
  ];
  if (extra !== undefined && extra.length > 0) lines.push(extra);
  return lines.join("\n");
}

export function rejection(
  tool: string,
  version: number,
  errors: readonly ReportError[],
  extra?: string,
): ToolResultContent[] {
  return [{ type: "text", text: rejectionText(tool, version, errors, extra) }];
}

/** Compact JSON of a PlanChangeReport with keys in the contract order. */
export function changeReportJson(r: PlanChangeReport): string {
  const o: Record<string, unknown> = { status: r.status, version: r.version };
  if (r.added && r.added.length > 0) o["added"] = r.added;
  if (r.updated && r.updated.length > 0) o["updated"] = r.updated;
  if (r.removed && r.removed.length > 0) o["removed"] = r.removed;
  if (r.warnings && r.warnings.length > 0) o["warnings"] = r.warnings;
  if (r.errors && r.errors.length > 0) o["errors"] = r.errors;
  if (r.estimate) o["estimate"] = r.estimate;
  return JSON.stringify(o);
}

/** Truncates text to `max` characters on a line boundary, with a note. */
export function clip(text: string, max: number, note = "… (truncated; use view_plan for the rest)"): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max - note.length - 1);
  return `${text.slice(0, cut > 0 ? cut : max - note.length - 1)}\n${note}`;
}
