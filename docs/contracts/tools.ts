/**
 * Slabyrinth — agent tools: the provider-neutral interface (tool types, names, inputs, outcomes, executor).
 * NORMATIVE CONTRACT. Copy verbatim into packages/core/src/agent/toolContract.ts.
 *
 * - Definitions are provider-neutral ({name, description, inputSchema}). The Anthropic adapter maps
 *   them to API tools (adding `eager_input_streaming: true`); a JSON-protocol provider embeds them in
 *   its instructions (§3.11). Same schemas, same executor, same validation either way.
 * - The tool list is FROZEN per conversation (byte-identical every request) — required for prompt
 *   caching and preserved thinking.
 * - The definitions themselves (descriptions and JSON Schemas, what the model sees) are model-facing
 *   text, not part of this contract: they live in code, versioned and hash-pinned like the system
 *   prompt (TOOL_DEFINITIONS in packages/core/src/agent/tools.ts is the working version; released
 *   versions are frozen copies, pinned in packages/core/test/unit/agent/tools.test.ts).
 * - Inputs are validated by the core Zod schemas (the same ones that validate plans), which mirror
 *   those JSON Schemas.
 * - The executor is pure core code: executeTool(ctx, name, input) → ToolOutcome. The engine supplies
 *   ctx (current plan/head, resolver cache, palettes, image renderer callback).
 */
import type { MapPlan, LevelId, ElementId, PlanIssue, DesignBrief } from "./plan";
import type { PlanOp, OpError } from "./ops";
import type { CompileEstimate } from "./compiler";

// ───────────────────────────── neutral tool types ─────────────────────────────

export type JsonSchema = { [k: string]: unknown };

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
  /** Large inputs (create_plan/edit_plan) benefit from streamed tool input where the provider supports it. */
  streamInput: boolean;
}

export type ToolResultContent =
  { type: "text"; text: string } | { type: "image"; mediaType: "image/png"; dataBase64: string };

/** The tools, in the order every tool list keeps (the order is part of the prompt-cache key). */
export type ToolName =
  | "update_brief"
  | "ask_questions"
  | "create_plan"
  | "edit_plan"
  | "view_plan"
  | "view_map_image"
  | "view_build_3d"
  | "compile_preview"
  | "list_catalog";

// ───────────────────────────── inputs ─────────────────────────────

/** Shallow patch of the brief; fields the USER set are not overwritten (the result says which were skipped). */
export interface UpdateBriefInput {
  set: { [K in keyof DesignBrief]?: NonNullable<DesignBrief[K]>["value"] };
}

/**
 * Shows ONE Question card (UX §5.3). The engine ends the turn right after this call WITHOUT sending a
 * tool_result; the GM's answers become this call's tool_result at the start of the next user message.
 */
export interface AskQuestionsInput {
  questions: Array<{
    id: string;
    text: string;
    /** The assumption used if the GM ignores the question ("I'll assume Tier 2"). */
    default: string;
    options: string[]; // 2..4 chips; the UI adds "You decide"
  }>; // 1..3
}

/** Answers as delivered in the tool_result (JSON text). */
export interface AskQuestionsAnswer {
  answers: Array<{ id: string; answer: string | "you_decide" | null }>;
  /** Free text the GM typed alongside (also present as the user message). */
  note?: string;
}

/** Plan as authored by the model: app fills schema/generator/id. */
export type AuthoredPlan = Omit<MapPlan, "schema" | "generator" | "id" | "seed"> & { seed?: number };

export interface CreatePlanInput {
  /** Must be true when a plan already exists (prevents accidental wipes). */
  replace: boolean;
  /** ≤ 80 chars; becomes the version label. */
  summary: string;
  /** ≤ 6 bullets for the Plan update card. */
  changes?: string[];
  plan: AuthoredPlan;
}

export interface EditPlanInput {
  /** The version the model believes is current (from the last tool result / context message). */
  baseVersion: number;
  /** ≤ 80 chars; becomes the version label ("Added secret door to crypt"). */
  summary: string;
  /** ≤ 6 bullets for the Plan update card ("Enlarged 4 Hall of Pillars 2 squares east"). */
  changes: string[];
  ops: PlanOp[]; // 1..100
}

export interface ViewPlanInput {
  level?: LevelId; // default: all levels (outline) / first level (ascii)
  format: "outline" | "ascii" | "json";
  /** ascii/json: restrict to a cell rect. */
  region?: { x: number; y: number; w: number; h: number };
  /** json: only these elements. */
  ids?: ElementId[];
}

export interface ViewMapImageInput {
  level: LevelId;
  region?: { x: number; y: number; w: number; h: number };
  /** Overlay element ids on the image (default true). */
  showIds?: boolean;
}

export interface CompilePreviewInput {
  levels?: LevelId[];
}

export interface ListCatalogInput {
  what: "themes" | "features" | "materials" | "wall_styles" | "presets";
  /** For "features": report palette coverage for this theme. */
  theme?: string;
}

// ───────────────────────────── outcomes (engine-facing) ─────────────────────────────

export type ToolOutcome =
  | {
      ok: true;
      /** Content returned to the model. */
      content: ToolResultContent[];
      /** Set when the tool produced a new plan version. */
      newPlan?: {
        plan: MapPlan;
        summary: string;
        changes: string[];
        cause: "create" | "ops";
        ops?: PlanOp[];
      };
      newBrief?: DesignBrief;
      /** ask_questions: end the turn now; the tool_result is supplied later from the GM's answers. */
      awaitUser?: boolean;
    }
  | {
      ok: false;
      content: ToolResultContent[]; // rendered error report (§3.4)
      errors: Array<
        | OpError
        | PlanIssue
        | {
            code: "stale_version" | "invalid_input" | "no_plan" | "plan_exists" | "unavailable";
            message: string;
            hint?: string;
          }
      >;
    };

/** Structured header of every edit/create result (serialized as the FIRST text block, compact JSON). */
export interface PlanChangeReport {
  status: "applied" | "rejected";
  version: number; // new head (applied) or unchanged head (rejected)
  added?: ElementId[];
  updated?: ElementId[];
  removed?: ElementId[];
  warnings?: Array<{ code: string; id?: string; msg: string; hint?: string }>;
  errors?: Array<{ op?: number; code: string; path?: string; msg: string; hint?: string }>;
  estimate?: Pick<CompileEstimate, "totalAssets" | "estimatedChunks">;
}

// ───────────────────────────── 3D pictures (host-facing) ─────────────────────────────

/**
 * A named 3D view of the current build; the app chooses the camera. level:<id> = that level cut away from above,
 * front:<id> = a building's street front, interior:<id> = inside a room, flagged = where the last review pointed,
 * changed = what the last edit changed.
 */
export type Render3dShot =
  | "overview"
  | "flagged"
  | "changed"
  | `level:${LevelId}`
  | `front:${ElementId}`
  | `interior:${ElementId}`;

export interface Render3dRequest {
  /** Omitted = the app's own choice of views for the current version. */
  shots?: Render3dShot[];
  /** At most this many views in the picture (1..4). */
  max?: number;
}

export interface Render3dResult {
  /** One PNG (a contact sheet when there are several views). */
  png: Uint8Array;
  /** One plain caption per view, in the sheet's order (what it shows, pieces drawn as boxes). */
  captions: string[];
  /** Plain text: views worth looking at next. */
  suggestions: string;
}

// ───────────────────────────── executor ─────────────────────────────

/** Executor signature implemented in core. */
export interface ToolContext {
  plan: MapPlan | null;
  head: number;
  brief: DesignBrief;
  /** App-provided PNG renderer (renderer process); null in CLI/headless or when the model has no image input. */
  renderImage:
    ((level: LevelId, region?: ViewMapImageInput["region"], showIds?: boolean) => Promise<Uint8Array>) | null;
  /**
   * App-provided 3D pictures of the current build (the app's scene worker); absent or null in CLI/headless, when the
   * model has no image input, or when the GM turned 3D pictures off.
   */
  render3d?: ((req: Render3dRequest) => Promise<Render3dResult>) | null;
  /** Cheap compile estimate; null when the compiler is unavailable (the tool then says so). May be async (worker). */
  estimate: (plan: MapPlan, levels?: LevelId[]) => CompileEstimate | null | Promise<CompileEstimate | null>;
  catalog: {
    themes: Array<{ id: string; name: string; description?: string }>;
    featureCoverage: (theme: string) => Record<string, boolean>;
  };
  newSeed: () => number;
  newPlanId: () => string;
}

export type ExecuteTool = (ctx: ToolContext, name: string, input: unknown) => Promise<ToolOutcome>;
