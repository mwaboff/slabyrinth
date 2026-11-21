/**
 * The 2D preview's resolve step: pure resolve + display-list + plan-check, run by the renderer's resolve.worker and
 * its in-thread fallback. Plans are resolved and checked against the palettes builds compile with (main sends them
 * as data: "palettes:resolveData"), so the preview shows the map the build produces. It lives in shared/ (core
 * imports only) so main's tests can hold it against the build and the agent (main/resolveParity.test.ts).
 */
import type { DisplayList, DisplayOptions, MapPlan, PlanIssue, ResolvedPlan } from "@slabyrinth/core";
import { validatePlan } from "@slabyrinth/core/plan";
import {
  resolvePalettesFromData,
  type ResolvePalettes,
  type ResolvePalettesData,
} from "@slabyrinth/core/palette";
import { planRules, resolvePlan } from "@slabyrinth/core/resolve";
import { buildDisplayList, levelLabels } from "@slabyrinth/core/render";

export interface ResolveRequest {
  id: number;
  plan: MapPlan;
  version: number;
  options: DisplayOptions;
  /** `key` of the palettes data to resolve against (sent to the worker once, see resolveClient.ts). */
  palettesKey: string;
}

/** A plan issue as the UI may show it: the AI-facing `hint` is dropped here so it can never reach the screen. */
export type UiIssue = Omit<PlanIssue, "hint">;

export interface ResolveResult {
  resolved: ResolvedPlan;
  lists: Record<string, DisplayList>;
  labels: Record<string, string>;
  issues: UiIssue[];
}

let last: { key: string; palettes: ResolvePalettes } | null = null;

/**
 * The palettes of `data`, kept while its key stays the same: one object per palettes, so core's memoized palette
 * view (one per palettes object) is built once, not on every resolve.
 */
export function palettesFromData(data: ResolvePalettesData): ResolvePalettes {
  if (last?.key !== data.key) last = { key: data.key, palettes: resolvePalettesFromData(data) };
  return last.palettes;
}

export function planIssues(plan: MapPlan, palettes: ResolvePalettes): UiIssue[] {
  try {
    return validatePlan(plan, planRules(palettes)).issues.map((i) => {
      const out: UiIssue = { severity: i.severity, code: i.code, message: i.message };
      if (i.path !== undefined) out.path = i.path;
      if (i.elementId !== undefined) out.elementId = i.elementId;
      if (i.levelId !== undefined) out.levelId = i.levelId;
      if (i.cell !== undefined) out.cell = i.cell;
      return out;
    });
  } catch {
    return [];
  }
}

export function compute(req: Omit<ResolveRequest, "palettesKey">, palettes: ResolvePalettes): ResolveResult {
  const resolved = resolvePlan(req.plan, palettes);
  const labels = levelLabels(resolved, req.plan.entryLevel);
  const lists: Record<string, DisplayList> = {};
  for (const level of resolved.levels) {
    lists[level.id] = buildDisplayList(level, req.options, { links: resolved.links, levelLabels: labels });
  }
  return { resolved, lists, labels, issues: planIssues(req.plan, palettes) };
}
