/**
 * Validation of every tool input before it runs (architecture §3.1 "Strict mode"). Streamed tool input
 * (eager input streaming) and JSON-protocol replies are not validated by the provider, so the executor checks each
 * input against Zod schemas that mirror the JSON Schemas in tools.ts. Plan content reuses WP1's plan schemas, so a
 * tool input is held to exactly the rules a stored plan is.
 */
import { z } from "zod";
import { FEATURE_TYPES } from "../contracts/plan";
import type { PlanOp } from "../contracts/ops";
import { PlanOpSchema } from "../plan/schema";
import { zodIssueToPlanIssue } from "../plan/zodIssues";
import type {
  AskQuestionsInput,
  CompilePreviewInput,
  ListCatalogInput,
  ToolName,
  UpdateBriefInput,
  ViewMapImageInput,
  ViewPlanInput,
} from "./tools";

/** One error line of a rejected tool call (§3.4). */
export interface ReportError {
  op?: number;
  code: string;
  path?: string;
  msg: string;
  hint?: string;
}

/**
 * Marker for a tool input that was not valid JSON (eager input streaming, JSON protocol). Providers wrap the raw
 * text as `{ [INVALID_JSON_KEY]: raw }`; the executor answers with the skill's INVALID_JSON error result.
 */
export const INVALID_JSON_KEY = "__invalid_json__";

export function invalidJsonInput(raw: string): Record<string, string> {
  return { [INVALID_JSON_KEY]: raw };
}

export function invalidJsonRaw(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const raw = (input as Record<string, unknown>)[INVALID_JSON_KEY];
  return typeof raw === "string" ? raw : null;
}

const text = (max: number) => z.string().max(max);
const rect = z.strictObject({ x: z.int(), y: z.int(), w: z.int().min(1), h: z.int().min(1) });

const BriefSetSchema = z.strictObject({
  mapType: z.string().min(1).max(80).optional(),
  system: z.enum(["daggerheart", "dnd5e", "other"]).optional(),
  party: z
    .strictObject({
      tier: z.int().min(1).max(10).optional(),
      level: z.int().min(1).max(30).optional(),
      size: z.int().min(1).max(12).optional(),
    })
    .optional(),
  footprint: z
    .strictObject({
      preset: z.enum(["small", "medium", "large", "custom"]),
      widthSq: z.int().min(1).max(512),
      heightSq: z.int().min(1).max(512),
    })
    .optional(),
  levels: z.strictObject({ count: z.int().min(1).max(8), names: z.array(text(80)).max(8) }).optional(),
  tone: text(80).optional(),
  mustInclude: z.array(text(200)).max(20).optional(),
  avoid: z.array(text(200)).max(20).optional(),
  theme: z.string().min(1).max(64).optional(),
});

const UpdateBriefSchema = z.strictObject({ set: BriefSetSchema });

const AskQuestionsSchema = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(40),
        text: z.string().min(1).max(300),
        default: z.string().min(1).max(200),
        options: z.array(z.string().min(1).max(80)).min(2).max(4),
      }),
    )
    .min(1)
    .max(3),
});

/** create_plan envelope; the plan itself is checked by validatePlan after the app fills schema/generator/id/seed. */
const CreatePlanEnvelopeSchema = z.strictObject({
  replace: z.boolean(),
  summary: z.string().min(1).max(80),
  changes: z.array(z.string().max(200)).max(6).optional(),
  plan: z.record(z.string(), z.unknown()),
});

const EditPlanSchema = z.strictObject({
  baseVersion: z.int().min(0),
  summary: z.string().min(1).max(80),
  changes: z.array(z.string().max(200)).max(6),
  ops: z.array(PlanOpSchema).min(1).max(100),
});

const ViewPlanSchema = z.strictObject({
  level: z.string().optional(),
  format: z.enum(["outline", "ascii", "json"]),
  region: rect.optional(),
  ids: z.array(z.string()).max(200).optional(),
});

const ViewMapImageSchema = z.strictObject({
  level: z.string().min(1),
  region: rect.optional(),
  showIds: z.boolean().optional(),
});

const CompilePreviewSchema = z.strictObject({ levels: z.array(z.string()).max(8).optional() });

const ListCatalogSchema = z.strictObject({
  what: z.enum(["themes", "features", "materials", "wall_styles", "presets"]),
  theme: z.string().optional(),
});

export interface CreatePlanEnvelope {
  replace: boolean;
  summary: string;
  changes?: string[];
  plan: Record<string, unknown>;
}

export interface EditPlanValidated {
  baseVersion: number;
  summary: string;
  changes: string[];
  ops: PlanOp[];
}

export interface ToolInputs {
  update_brief: UpdateBriefInput;
  ask_questions: AskQuestionsInput;
  create_plan: CreatePlanEnvelope;
  edit_plan: EditPlanValidated;
  view_plan: ViewPlanInput;
  view_map_image: ViewMapImageInput;
  compile_preview: CompilePreviewInput;
  list_catalog: ListCatalogInput;
}

const SCHEMAS: { [K in ToolName]: z.ZodType } = {
  update_brief: UpdateBriefSchema,
  ask_questions: AskQuestionsSchema,
  create_plan: CreatePlanEnvelopeSchema,
  edit_plan: EditPlanSchema,
  view_plan: ViewPlanSchema,
  view_map_image: ViewMapImageSchema,
  compile_preview: CompilePreviewSchema,
  list_catalog: ListCatalogSchema,
};

export type ValidatedInput<K extends ToolName> =
  { ok: true; value: ToolInputs[K] } | { ok: false; errors: ReportError[] };

/** Validates `input` for tool `name`. Never throws. Errors carry JSON-pointer paths and hints. */
export function validateToolInput<K extends ToolName>(name: K, input: unknown): ValidatedInput<K> {
  const raw = invalidJsonRaw(input);
  if (raw !== null) {
    return {
      ok: false,
      errors: [
        {
          code: "invalid_json",
          msg: "the tool input was not valid JSON (it may have been cut off)",
          hint: "send the complete input again as valid JSON; split very large changes into several calls",
        },
      ],
    };
  }
  const schema = SCHEMAS[name];
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data as ToolInputs[K] };
  const errors: ReportError[] = parsed.error.issues.map((issue) => {
    const pi = zodIssueToPlanIssue(issue, input, schema);
    const e: ReportError = { code: pi.code === "schema" ? "invalid_input" : pi.code, msg: pi.message };
    if (pi.path !== undefined && pi.path !== "") e.path = pi.path;
    if (pi.hint !== undefined) e.hint = pi.hint;
    const m = name === "edit_plan" ? /^\/ops\/(\d+)/.exec(pi.path ?? "") : null;
    if (m?.[1] !== undefined) e.op = Number(m[1]);
    if (name === "list_catalog" || name === "view_plan") addEnumHint(e, issue);
    return e;
  });
  return { ok: false, errors };
}

function addEnumHint(e: ReportError, issue: z.core.$ZodIssue): void {
  if (e.hint !== undefined || issue.code !== "invalid_value") return;
  e.hint = `use one of: ${issue.values.map(String).join(", ")}`;
}

/** Feature types accepted in plans (for list_catalog). */
export const FEATURE_TYPE_LIST: readonly string[] = FEATURE_TYPES;
