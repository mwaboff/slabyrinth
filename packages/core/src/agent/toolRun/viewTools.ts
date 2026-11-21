/** The tools that show the plan: view_plan (outline, ascii or json) and view_map_image (a PNG the app renders). */
import type { ElementId, LevelId, MapPlan } from "../../contracts/plan";
import { planGate } from "../../plan/gate";
import { checksLine } from "../checks";
import { validateToolInput } from "../inputs";
import { clip } from "../report";
import type { ToolOutcome } from "../tools";
import type { ToolRunCtx } from "./context";
import type { AgentToolContext, AsciiPortOptions } from "./ports";
import { base64, fail, noPlan, textResult, unavailable, unknownLevel } from "./results";

/** The json view is cut at this many characters. */
const JSON_VIEW_BUDGET = 30000;

export function runViewPlan(r: ToolRunCtx, ctx: AgentToolContext, input: unknown): ToolOutcome {
  const v = validateToolInput("view_plan", input);
  if (!v.ok) return fail("view_plan", ctx.head, v.errors);
  const plan = ctx.plan;
  if (plan === null) return noPlan("view_plan");
  const { level, format, region, ids } = v.value;
  if (level !== undefined && !plan.levels.some((l) => l.id === level))
    return unknownLevel("view_plan", ctx.head, plan, "/level", `no level "${level}"`);
  const checks = planGate(r.issuesOf(plan, ctx), "edit").checks;
  const flagged = [...checks.errors, ...checks.warnings, ...checks.info];
  if (format === "outline") {
    const text = r.outlineOf(
      ctx.palettes,
      plan,
      ctx.head,
      level !== undefined ? [level] : undefined,
      flagged,
    );
    return textResult(text ? `${text}\n${checksLine(checks)}` : JSON.stringify(plan));
  }
  if (format === "ascii") {
    const resolved = r.resolve(ctx.palettes, plan, ctx.head);
    if (!resolved || !r.ports.ascii)
      return unavailable(
        "view_plan",
        ctx.head,
        "the ascii view is not available right now",
        'use format "outline" or "json"',
      );
    const levelId = level ?? plan.levels[0]?.id ?? "";
    const opts: AsciiPortOptions = { issues: flagged.filter((i) => i.severity !== "info") };
    if (region) opts.region = region;
    return textResult(
      `PLAN v${ctx.head} level ${levelId}\n${r.ports.ascii(resolved, levelId, opts)}\n${checksLine(checks)}`,
    );
  }
  return textResult(
    clip(
      jsonView(plan, ctx.head, level, region, ids),
      JSON_VIEW_BUDGET,
      "… (truncated; ask for fewer ids or a smaller region)",
    ),
  );
}

export async function runViewMapImage(ctx: AgentToolContext, input: unknown): Promise<ToolOutcome> {
  const v = validateToolInput("view_map_image", input);
  if (!v.ok) return fail("view_map_image", ctx.head, v.errors);
  if (ctx.renderImage === null)
    return unavailable(
      "view_map_image",
      ctx.head,
      "map images are unavailable on this model",
      'use view_plan with format "ascii" instead',
    );
  const plan = ctx.plan;
  if (plan === null) return noPlan("view_map_image");
  if (!plan.levels.some((l) => l.id === v.value.level))
    return unknownLevel("view_map_image", ctx.head, plan, "/level", `no level "${v.value.level}"`);
  const bytes = await ctx.renderImage(v.value.level, v.value.region, v.value.showIds ?? true);
  return {
    ok: true,
    content: [
      { type: "text", text: `Map image of level ${v.value.level}, plan v${ctx.head}.` },
      { type: "image", mediaType: "image/png", dataBase64: base64(bytes) },
    ],
  };
}

/** json format of view_plan: selected elements, one level, or the whole plan. */
function jsonView(
  plan: MapPlan,
  version: number,
  level: LevelId | undefined,
  region: { x: number; y: number; w: number; h: number } | undefined,
  ids: ElementId[] | undefined,
): string {
  if (ids && ids.length > 0) {
    const wanted = new Set(ids);
    const found: Record<string, unknown> = {};
    for (const l of plan.levels) {
      if (wanted.has(l.id))
        found[l.id] = {
          ...l,
          areas: undefined,
          openings: undefined,
          walls: undefined,
          features: undefined,
          terrain: undefined,
          labels: undefined,
        };
      for (const list of [l.areas, l.openings, l.walls, l.features, l.terrain, l.labels] as Array<
        Array<{ id: string }>
      >) {
        for (const e of list) if (wanted.has(e.id)) found[e.id] = { level: l.id, ...e };
      }
    }
    for (const link of plan.links) if (wanted.has(link.id)) found[link.id] = link;
    const missing = ids.filter((id) => !(id in found));
    return JSON.stringify({ version, elements: found, ...(missing.length > 0 ? { notFound: missing } : {}) });
  }
  const inRegion = (at: readonly [number, number]): boolean =>
    region === undefined ||
    (at[0] >= region.x && at[0] < region.x + region.w && at[1] >= region.y && at[1] < region.y + region.h);
  const levels = plan.levels
    .filter((l) => level === undefined || l.id === level)
    .map((l) =>
      region === undefined
        ? l
        : {
            ...l,
            features: l.features.filter((f) => inRegion(f.at)),
            labels: l.labels.filter((x) => inRegion(x.at)),
          },
    );
  if (level !== undefined) return JSON.stringify({ version, level: levels[0] });
  return JSON.stringify({ version, plan: { ...plan, levels } });
}
