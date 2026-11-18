/** Pure resolve + display-list + plan-check step shared by resolve.worker and the in-thread fallback. */
import type { DisplayList, DisplayOptions, MapPlan, PlanIssue, ResolvedPlan } from "@slabyrinth/core";
// The core root registers WP2's geometric + playability checks with validatePlan (core/resolve/autoregister).
import { validatePlan } from "@slabyrinth/core";
import { resolvePlan } from "@slabyrinth/core/resolve";
import { buildDisplayList, levelLabels } from "@slabyrinth/core/render";

export interface ResolveRequest {
  id: number;
  plan: MapPlan;
  version: number;
  options: DisplayOptions;
}

/** A plan issue as the UI may show it: the AI-facing `hint` is dropped here so it can never reach the screen. */
export type UiIssue = Omit<PlanIssue, "hint">;

export interface ResolveResult {
  resolved: ResolvedPlan;
  lists: Record<string, DisplayList>;
  labels: Record<string, string>;
  issues: UiIssue[];
}

export function planIssues(plan: MapPlan): UiIssue[] {
  try {
    return validatePlan(plan).issues.map((i) => {
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

export function compute(req: ResolveRequest): ResolveResult {
  const resolved = resolvePlan(req.plan);
  const labels = levelLabels(resolved, req.plan.entryLevel);
  const lists: Record<string, DisplayList> = {};
  for (const level of resolved.levels) {
    lists[level.id] = buildDisplayList(level, req.options, { links: resolved.links, levelLabels: labels });
  }
  return { resolved, lists, labels, issues: planIssues(req.plan) };
}
