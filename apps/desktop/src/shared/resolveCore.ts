/**
 * The 2D preview's resolve step: pure resolve + display-list + plan-check, run by the renderer's resolve.worker and
 * its in-thread fallback. Plans are resolved and checked against the palettes builds compile with (main sends them
 * as data: "palettes:resolveData"), so the preview shows the map the build produces. It lives in shared/ (core
 * imports only) so main's tests can hold it against the build and the agent (main/resolveParity.test.ts).
 */
import {
  canonicalJson,
  type DisplayList,
  type DisplayOptions,
  type MapPlan,
  type PlanIssue,
  type ResolvedPlan,
} from "@slabyrinth/core";
import { validatePlan, type SizeTierId } from "@slabyrinth/core/plan";
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
  /** The map size tier the plan is checked at (shared/sizeTier.ts activeSizeTier); standard when absent. */
  sizeTier?: SizeTierId;
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

/**
 * `resolved` for the plan the check is given. validatePlan hands its checks the schema's parsed copy of the plan, never
 * the object passed in, so the copy is matched by content (key order aside): a stored plan parses to the same content, and anything
 * else (a plan the schema filled in) is resolved again, as before.
 */
export function resolvedForPlan(
  plan: MapPlan,
  resolved: ResolvedPlan,
): (p: MapPlan) => ResolvedPlan | undefined {
  let json: string | null = null;
  return (p) => {
    if (p === plan) return resolved;
    json ??= canonicalJson(plan);
    return canonicalJson(p) === json ? resolved : undefined;
  };
}

/**
 * The plan check at `sizeTier`. `resolved`: this plan already resolved against these palettes, so the check does not
 * resolve it a second time (core planRules resolvedFor; same output).
 */
export function planIssues(
  plan: MapPlan,
  palettes: ResolvePalettes,
  opts: { sizeTier?: SizeTierId; resolved?: ResolvedPlan } = {},
): UiIssue[] {
  const { sizeTier, resolved } = opts;
  try {
    const rules = planRules(palettes, {
      ...(sizeTier !== undefined ? { sizeTier } : {}),
      ...(resolved !== undefined ? { resolvedFor: resolvedForPlan(plan, resolved) } : {}),
    });
    return validatePlan(plan, rules).issues.map((i) => {
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

/** The display list of every level for these options: cheap next to the resolve, so the preview builds it per toggle. */
export function displayLists(
  resolved: ResolvedPlan,
  labels: Record<string, string>,
  options: DisplayOptions,
): Record<string, DisplayList> {
  const lists: Record<string, DisplayList> = {};
  for (const level of resolved.levels) {
    lists[level.id] = buildDisplayList(level, options, { links: resolved.links, levelLabels: labels });
  }
  return lists;
}

export function compute(req: Omit<ResolveRequest, "palettesKey">, palettes: ResolvePalettes): ResolveResult {
  const resolved = resolvePlan(req.plan, palettes);
  const labels = levelLabels(resolved, req.plan.entryLevel);
  const lists = displayLists(resolved, labels, req.options);
  const issues = planIssues(req.plan, palettes, {
    resolved,
    ...(req.sizeTier !== undefined ? { sizeTier: req.sizeTier } : {}),
  });
  return { resolved, lists, labels, issues };
}
