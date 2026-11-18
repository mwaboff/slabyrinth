/**
 * Slabyrinth — agent tools (provider-neutral definitions + input/output types).
 * NORMATIVE CONTRACT. Copy verbatim into packages/core/src/agent/tools.ts.
 *
 * - Definitions are provider-neutral ({name, description, inputSchema}). The Anthropic adapter maps
 *   them to API tools (adding `eager_input_streaming: true`); a JSON-protocol provider embeds them in
 *   its instructions (§3.11). Same schemas, same executor, same validation either way.
 * - The tool list is FROZEN per conversation (byte-identical every request; order below) — required
 *   for prompt caching and preserved thinking.
 * - Inputs are validated by the core Zod schemas (the same ones that validate plans). These JSON
 *   Schemas are what the model sees; a unit test asserts every example in docs/architecture.md §3
 *   passes both.
 * - The executor is pure core code: executeTool(ctx, name, input) → ToolOutcome. The engine supplies
 *   ctx (current plan/head, resolver cache, palettes, image renderer callback).
 */
import type { MapPlan, LevelId, ElementId, PlanIssue, DesignBrief } from "../contracts/plan";
import type { PlanOp, OpError } from "../contracts/ops";
import type { CompileEstimate } from "../contracts/compiler";
import { MATERIALS, WALL_STYLES, OPENING_KINDS, LINK_KINDS, FEATURE_TYPES, DRESS_PRESETS } from "../contracts/plan";

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
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png"; dataBase64: string };

export type ToolName =
  | "update_brief" | "ask_questions"
  | "create_plan" | "edit_plan" | "view_plan" | "view_map_image" | "compile_preview" | "list_catalog";

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
    options: string[];   // 2..4 chips; the UI adds "You decide"
  }>;                    // 1..3
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
  ops: PlanOp[];   // 1..100
}

export interface ViewPlanInput {
  level?: LevelId;            // default: all levels (outline) / first level (ascii)
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
      newPlan?: { plan: MapPlan; summary: string; changes: string[]; cause: "create" | "ops"; ops?: PlanOp[] };
      newBrief?: DesignBrief;
      /** ask_questions: end the turn now; the tool_result is supplied later from the GM's answers. */
      awaitUser?: boolean;
    }
  | {
      ok: false;
      content: ToolResultContent[];   // rendered error report (§3.4)
      errors: Array<OpError | PlanIssue | { code: "stale_version" | "invalid_input" | "no_plan" | "plan_exists" | "unavailable"; message: string; hint?: string }>;
    };

/** Structured header of every edit/create result (serialized as the FIRST text block, compact JSON). */
export interface PlanChangeReport {
  status: "applied" | "rejected";
  version: number;                       // new head (applied) or unchanged head (rejected)
  added?: ElementId[];
  updated?: ElementId[];
  removed?: ElementId[];
  warnings?: Array<{ code: string; id?: string; msg: string; hint?: string }>;
  errors?: Array<{ op?: number; code: string; path?: string; msg: string; hint?: string }>;
  estimate?: Pick<CompileEstimate, "totalAssets" | "estimatedChunks">;
}

// ───────────────────────────── JSON Schemas (what the model sees) ─────────────────────────────

const int = { type: "integer" } as const;
const num = { type: "number" } as const;
const str = { type: "string" } as const;
const id = { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$", description: "Lowercase id, unique across the whole plan, e.g. \"r1\", \"crypt_hall\"." } as const;
const vec2 = { type: "array", items: int, minItems: 2, maxItems: 2, description: "[x, y] cell coordinates (x east, y south)." } as const;
const vertex = { type: "array", items: int, minItems: 2, maxItems: 2, description: "[x, y] grid VERTEX (corner) coordinates." } as const;
const height = { type: "number", description: "Tiles (1 = 5 ft), multiple of 0.25." } as const;
const side = { type: "string", enum: ["N", "E", "S", "W"] } as const;
const rect = {
  type: "object", required: ["x", "y", "w", "h"], additionalProperties: false,
  properties: { x: int, y: int, w: int, h: int },
} as const;

const shapeSchema: JsonSchema = {
  description:
    "Cell-set shape. A cell is inside iff its center is inside. Prefer rect for rooms, route for corridors, cave/blob for organic spaces.",
  oneOf: [
    { type: "object", required: ["type", "x", "y", "w", "h"], additionalProperties: false,
      properties: { type: { const: "rect" }, x: int, y: int, w: int, h: int } },
    { type: "object", required: ["type", "points"], additionalProperties: false,
      properties: { type: { const: "polygon" }, points: { type: "array", items: vertex, minItems: 3, maxItems: 64 } } },
    { type: "object", required: ["type", "cx", "cy", "r"], additionalProperties: false,
      properties: { type: { const: "circle" }, cx: num, cy: num, r: num } },
    { type: "object", required: ["type", "cx", "cy", "rx", "ry"], additionalProperties: false,
      properties: { type: { const: "ellipse" }, cx: num, cy: num, rx: num, ry: num } },
    { type: "object", required: ["type", "cx", "cy", "r"], additionalProperties: false,
      properties: { type: { const: "blob" }, cx: num, cy: num, r: num, roughness: { type: "number", description: "0..1, default 0.35" }, seed: int } },
    { type: "object", required: ["type", "x", "y", "w", "h"], additionalProperties: false,
      properties: { type: { const: "cave" }, x: int, y: int, w: int, h: int, fill: { type: "number", description: "0.3..0.7, default 0.45" }, steps: { type: "integer", description: "0..8, default 4" }, seed: int } },
    { type: "object", required: ["type", "x", "y", "rows"], additionalProperties: false,
      properties: { type: { const: "cells" }, x: int, y: int, rows: { type: "array", items: str, maxItems: 64, description: "'#' = in, '.' = out; ≤ 64×64" } } },
    { type: "object", required: ["type", "points"], additionalProperties: false,
      properties: { type: { const: "path" }, points: { type: "array", items: vec2, minItems: 2 }, width: { type: "integer", description: "1..5, default 1" } },
      description: "Thick polyline through cell centers; consecutive points axis-aligned." },
    { type: "object", required: ["type", "from", "to"], additionalProperties: false,
      properties: {
        type: { const: "route" },
        from: { oneOf: [id, vec2] }, to: { oneOf: [id, vec2] },
        width: { type: "integer", enum: [1, 2, 3] }, bend: { type: "string", enum: ["hv", "vh"] },
        openings: { type: "string", enum: [...OPENING_KINDS] },
      },
      description: "L-shaped corridor between two areas (or cells); never overwrites other areas; auto-adds openings where it meets them." },
  ],
};

const areaSchema: JsonSchema = {
  type: "object", required: ["id", "kind", "shape"], additionalProperties: false,
  properties: {
    id,
    kind: { type: "string", enum: ["room", "corridor", "cave", "building", "courtyard", "zone"] },
    name: str, key: { type: "string", description: "Room-key label, e.g. \"1\" or \"A3\"." },
    shape: { $ref: "#/$defs/shape" },
    floor: { type: "string", enum: [...MATERIALS, "none"] },
    floorHeight: height,
    walls: { type: "string", enum: ["auto", "perimeter", "none"] },
    wallStyle: { type: "string", enum: [...WALL_STYLES] },
    wallHeight: height,
    labelAt: vec2, theme: str, notes: str,
    readAloud: { type: "string", description: "Boxed text read to players on entry." },
    encounter: { type: "string", description: "Encounter line(s) in the brief's game system." },
    tags: { type: "array", items: str },
  },
};

const openingSchema: JsonSchema = {
  type: "object", required: ["id", "kind"], additionalProperties: false,
  description: "Give EITHER between (preferred) OR at.",
  properties: {
    id, kind: { type: "string", enum: [...OPENING_KINDS] },
    between: { type: "array", items: str, minItems: 2, maxItems: 2, description: "[areaId, areaId|\"@outside\"]" },
    position: { type: "number", description: "0..1 along the shared boundary, default 0.5" },
    at: { type: "object", required: ["x", "y", "side"], additionalProperties: false, properties: { x: int, y: int, side } },
    width: { type: "integer", enum: [1, 2, 3] }, label: str, notes: str, gmOnly: { type: "boolean" },
  },
};

const wallRunSchema: JsonSchema = {
  type: "object", required: ["id", "op", "points"], additionalProperties: false,
  properties: {
    id, op: { type: "string", enum: ["add", "remove"] },
    points: { type: "array", items: vertex, minItems: 2, maxItems: 64 },
    style: { type: "string", enum: [...WALL_STYLES] }, height,
  },
};

const featureSchema: JsonSchema = {
  type: "object", required: ["id", "type", "at"], additionalProperties: false,
  properties: {
    id, type: { type: "string", enum: [...FEATURE_TYPES] }, at: vec2,
    rot: { type: "integer", enum: [0, 90, 180, 270] },
    size: { type: "array", items: int, minItems: 2, maxItems: 2 },
    wall: side, lift: height, variant: str,
    hint: { type: "string", description: "Required for type \"custom\"." },
    label: str, notes: str, gmOnly: { type: "boolean" },
  },
};

const layer = { type: "string", enum: ["under", "over"], description: "under (default) = before areas, which override it; over = after areas (water in a cave, a dais in a room)." } as const;

const terrainSchema: JsonSchema = {
  oneOf: [
    { type: "object", required: ["id", "op", "shape", "material"], additionalProperties: false,
      properties: { id, op: { const: "paint" }, shape: { $ref: "#/$defs/shape" }, material: { type: "string", enum: [...MATERIALS] }, layer } },
    { type: "object", required: ["id", "op", "shape"], additionalProperties: false,
      properties: { id, op: { const: "height" }, shape: { $ref: "#/$defs/shape" }, delta: height, set: height, smooth: int, layer } },
    { type: "object", required: ["id", "op", "shape", "material", "coverage"], additionalProperties: false,
      properties: { id, op: { const: "noise" }, shape: { $ref: "#/$defs/shape" }, material: { type: "string", enum: [...MATERIALS] }, coverage: num, scale: int, seed: int, layer } },
    { type: "object", required: ["id", "op", "points", "width", "material"], additionalProperties: false,
      properties: { id, op: { const: "path" }, points: { type: "array", items: vec2, minItems: 2 }, width: int, material: { type: "string", enum: [...MATERIALS] }, jitter: num, seed: int, layer } },
    { type: "object", required: ["id", "op", "feature", "density"], additionalProperties: false,
      properties: {
        id, op: { const: "scatter" }, feature: { type: "string", enum: [...FEATURE_TYPES] },
        shape: { $ref: "#/$defs/shape" }, exclude: { type: "array", items: { $ref: "#/$defs/shape" }, maxItems: 8 },
        density: { type: "number", description: "0..1" }, minSpacing: int,
        avoid: { type: "array", items: { type: "string", enum: ["water", "paths", "areas", "walls", "features", "links"] } },
        variants: { type: "array", items: str }, randomRotation: { type: "boolean" }, seed: int,
      } },
    { type: "object", required: ["id", "op", "area", "preset"], additionalProperties: false,
      properties: { id, op: { const: "dress" }, area: str, preset: { type: "string", enum: [...DRESS_PRESETS] }, density: num, seed: int } },
  ],
};

const labelSchema: JsonSchema = {
  type: "object", required: ["id", "text", "at"], additionalProperties: false,
  properties: { id, text: str, at: vec2, size: { type: "string", enum: ["s", "m", "l"] } },
};

const linkSchema: JsonSchema = {
  type: "object", required: ["id", "kind", "from", "to"], additionalProperties: false,
  properties: {
    id, kind: { type: "string", enum: [...LINK_KINDS] },
    from: { type: "object", required: ["level", "at"], additionalProperties: false, properties: { level: str, at: vec2 } },
    to: { type: "object", required: ["level"], additionalProperties: false, properties: { level: str, at: vec2 } },
    dir: side, width: { type: "integer", enum: [1, 2] }, label: str, notes: str,
  },
};

const levelSchema: JsonSchema = {
  type: "object", required: ["id", "name", "elevation", "bounds", "base"], additionalProperties: false,
  properties: {
    id, name: str, elevation: height, wallHeight: height, bounds: rect,
    base: {
      oneOf: [
        { type: "object", required: ["type"], additionalProperties: false, properties: { type: { const: "solid" } } },
        { type: "object", required: ["type"], additionalProperties: false, properties: { type: { const: "void" } } },
        { type: "object", required: ["type", "material"], additionalProperties: false, properties: { type: { const: "ground" }, material: { type: "string", enum: [...MATERIALS] }, layer } },
      ],
    },
    theme: str,
    areas: { type: "array", items: { $ref: "#/$defs/area" } },
    openings: { type: "array", items: { $ref: "#/$defs/opening" } },
    walls: { type: "array", items: { $ref: "#/$defs/wallRun" } },
    features: { type: "array", items: { $ref: "#/$defs/feature" } },
    terrain: { type: "array", items: { $ref: "#/$defs/terrain" } },
    labels: { type: "array", items: { $ref: "#/$defs/label" } },
    notes: str,
  },
};

const defs = {
  shape: shapeSchema, area: areaSchema, opening: openingSchema, wallRun: wallRunSchema,
  feature: featureSchema, terrain: terrainSchema, label: labelSchema, link: linkSchema, level: levelSchema,
};

const planOpSchema: JsonSchema = {
  oneOf: [
    { type: "object", required: ["op", "element"], additionalProperties: false,
      properties: { op: { const: "add" }, element: { oneOf: [
        { type: "object", required: ["kind", "level", "value"], additionalProperties: false, properties: { kind: { const: "area" }, level: str, value: { $ref: "#/$defs/area" }, index: int } },
        { type: "object", required: ["kind", "level", "value"], additionalProperties: false, properties: { kind: { const: "opening" }, level: str, value: { $ref: "#/$defs/opening" } } },
        { type: "object", required: ["kind", "level", "value"], additionalProperties: false, properties: { kind: { const: "wall_run" }, level: str, value: { $ref: "#/$defs/wallRun" } } },
        { type: "object", required: ["kind", "level", "value"], additionalProperties: false, properties: { kind: { const: "feature" }, level: str, value: { $ref: "#/$defs/feature" } } },
        { type: "object", required: ["kind", "level", "value"], additionalProperties: false, properties: { kind: { const: "terrain" }, level: str, value: { $ref: "#/$defs/terrain" }, index: int } },
        { type: "object", required: ["kind", "level", "value"], additionalProperties: false, properties: { kind: { const: "label" }, level: str, value: { $ref: "#/$defs/label" } } },
        { type: "object", required: ["kind", "value"], additionalProperties: false, properties: { kind: { const: "link" }, value: { $ref: "#/$defs/link" } } },
        { type: "object", required: ["kind", "value"], additionalProperties: false, properties: { kind: { const: "level" }, value: { $ref: "#/$defs/level" } } },
      ] } } },
    { type: "object", required: ["op", "level", "features"], additionalProperties: false,
      properties: { op: { const: "add_features" }, level: str, features: { type: "array", items: { $ref: "#/$defs/feature" }, maxItems: 500 } } },
    { type: "object", required: ["op", "id", "set"], additionalProperties: false,
      properties: { op: { const: "update" }, id: str, set: { type: "object", description: "Fields to overwrite on that element (same field names as when adding it). null deletes an optional field. Nested objects (shape, bounds, from/to, base) are replaced whole." } } },
    { type: "object", required: ["op", "ids"], additionalProperties: false,
      properties: { op: { const: "remove" }, ids: { type: "array", items: str, minItems: 1 }, keepDependents: { type: "boolean" } } },
    { type: "object", required: ["op", "ids", "dx", "dy"], additionalProperties: false,
      properties: { op: { const: "move" }, ids: { type: "array", items: str, minItems: 1 }, dx: int, dy: int, withContents: { type: "boolean" }, toLevel: str } },
    { type: "object", required: ["op", "ids", "dx", "dy", "idSuffix"], additionalProperties: false,
      properties: { op: { const: "duplicate" }, ids: { type: "array", items: str, minItems: 1 }, dx: int, dy: int, idSuffix: str, toLevel: str } },
    { type: "object", required: ["op", "id", "index"], additionalProperties: false,
      properties: { op: { const: "reorder" }, id: str, index: int } },
    { type: "object", required: ["op", "id"], additionalProperties: false,
      properties: { op: { const: "materialize" }, id: str, keepOp: { type: "boolean" } } },
    { type: "object", required: ["op"], additionalProperties: false,
      properties: { op: { const: "set_meta" }, title: str, summary: { type: ["string", "null"] }, kind: { type: "string", enum: ["dungeon", "cave", "building", "tower", "town", "outdoor", "mixed"] }, seed: int, theme: str, notes: { type: ["string", "null"] } } },
    { type: "object", required: ["op", "id", "shape"], additionalProperties: false,
      properties: { op: { const: "reshape" }, id: str, shape: { $ref: "#/$defs/shape" } } },
    { type: "object", required: ["op"], additionalProperties: false,
      properties: { op: { const: "renumber" } } },
  ],
};

/** Tool order is part of the cache key — never reorder. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "update_brief",
    streamInput: false,
    description:
      "Record what you and the GM have agreed in the design brief card (map type, game system, party, footprint, levels, tone, " +
      "must-include, avoid, theme). Call it whenever the conversation settles or changes one of these, in the same turn. " +
      "Fields the GM set by hand are kept; the result tells you which were skipped.",
    inputSchema: {
      type: "object", required: ["set"], additionalProperties: false,
      properties: {
        set: {
          type: "object", additionalProperties: false,
          properties: {
            mapType: str,
            system: { type: "string", enum: ["daggerheart", "dnd5e", "other"] },
            party: { type: "object", additionalProperties: false, properties: { tier: int, level: int, size: int } },
            footprint: { type: "object", required: ["preset", "widthSq", "heightSq"], additionalProperties: false,
              properties: { preset: { type: "string", enum: ["small", "medium", "large", "custom"] }, widthSq: int, heightSq: int } },
            levels: { type: "object", required: ["count", "names"], additionalProperties: false, properties: { count: int, names: { type: "array", items: str } } },
            tone: str,
            mustInclude: { type: "array", items: str },
            avoid: { type: "array", items: str },
            theme: str,
          },
        },
      },
    },
  },
  {
    name: "ask_questions",
    streamInput: false,
    description:
      "Ask the GM up to 3 clarifying questions as a card with answer chips. Use at most once per turn and normally only once " +
      "before the first draft; every question must state the default you will use if it is ignored. Your turn ends with this " +
      "call — the answers arrive as its result together with the GM's next message. Do not repeat the questions in text.",
    inputSchema: {
      type: "object", required: ["questions"], additionalProperties: false,
      properties: {
        questions: {
          type: "array", minItems: 1, maxItems: 3,
          items: {
            type: "object", required: ["id", "text", "default", "options"], additionalProperties: false,
            properties: { id: str, text: str, default: str, options: { type: "array", items: str, minItems: 2, maxItems: 4 } },
          },
        },
      },
    },
  },
  {
    name: "create_plan",
    streamInput: true,
    description:
      "Create the map plan from scratch (or replace it wholesale with replace=true). Call this once the GM has agreed on the brief, " +
      "to produce the FIRST complete draft. For any later change use edit_plan instead — never re-send the whole plan to change a part of it. " +
      "The app validates the plan; if it is rejected nothing changes and the result lists every problem with hints.",
    inputSchema: {
      type: "object", required: ["replace", "summary", "plan"], additionalProperties: false,
      properties: {
        replace: { type: "boolean" },
        summary: { type: "string", description: "≤ 80 chars, becomes the version label." },
        changes: { type: "array", items: str, maxItems: 6 },
        plan: {
          type: "object", required: ["title", "kind", "theme", "levels", "links"], additionalProperties: false,
          properties: {
            title: str, summary: str,
            kind: { type: "string", enum: ["dungeon", "cave", "building", "tower", "town", "outdoor", "mixed"] },
            seed: { type: "integer", description: "Optional root seed; omitted = app picks one." },
            theme: str,
            levels: { type: "array", items: { $ref: "#/$defs/level" }, minItems: 1, maxItems: 8 },
            entryLevel: str,
            links: { type: "array", items: { $ref: "#/$defs/link" } },
            notes: str,
          },
        },
      },
      $defs: defs,
    },
  },
  {
    name: "edit_plan",
    streamInput: true,
    description:
      "Change the existing plan with a batch of operations applied in order as ONE transaction: if any op or the resulting plan is invalid, " +
      "nothing is applied and you get every problem with hints — fix them and call edit_plan again. Use for every change after the first draft: " +
      "add/update/remove/move/duplicate elements by id, reshape areas, materialize generated features. Group related changes into one call. " +
      "baseVersion must be the current plan version.",
    inputSchema: {
      type: "object", required: ["baseVersion", "summary", "changes", "ops"], additionalProperties: false,
      properties: {
        baseVersion: { type: "integer" },
        summary: { type: "string", description: "≤ 80 chars, becomes the version label." },
        changes: { type: "array", items: str, maxItems: 6, description: "≤ 6 short bullets describing what changed, naming rooms by key." },
        ops: { type: "array", items: { $ref: "#/$defs/op" }, minItems: 1, maxItems: 100 },
      },
      $defs: { ...defs, op: planOpSchema },
    },
  },
  {
    name: "view_plan",
    streamInput: false,
    description:
      "Look at the current plan. outline = every element with its key parameters (authoritative ids, compact); ascii = resolved map of one level " +
      "(walls, doors, features, heights) optionally cropped to a region; json = exact JSON of selected elements. Call this before editing " +
      "something you have not seen since the last change, or when the GM refers to a part of the map you need to inspect.",
    inputSchema: {
      type: "object", required: ["format"], additionalProperties: false,
      properties: {
        level: str, format: { type: "string", enum: ["outline", "ascii", "json"] },
        region: rect, ids: { type: "array", items: str },
      },
    },
  },
  {
    name: "view_map_image",
    streamInput: false,
    description:
      "Render one level of the current plan as a PNG exactly as the GM sees it in the app. Use it sparingly — after creating a level or a large " +
      "generated change — to check layout, proportions and overlaps that are hard to judge from ASCII.",
    inputSchema: {
      type: "object", required: ["level"], additionalProperties: false,
      properties: { level: str, region: rect, showIds: { type: "boolean" } },
    },
  },
  {
    name: "compile_preview",
    streamInput: false,
    description:
      "Estimate the TaleSpire build without exporting: asset count and slab chunk count per level, and anything that cannot be built with " +
      "the current themes (missing assets, unsupported features). Call before telling the GM the map is ready to build, or when asked about size.",
    inputSchema: {
      type: "object", required: [], additionalProperties: false,
      properties: { levels: { type: "array", items: str } },
    },
  },
  {
    name: "list_catalog",
    streamInput: false,
    description:
      "List what can be built: installed themes, materials, wall styles, dress presets, or feature types (with which ones the given theme " +
      "has real TaleSpire assets for). Call when choosing a theme or before using a feature you are unsure the theme supports.",
    inputSchema: {
      type: "object", required: ["what"], additionalProperties: false,
      properties: { what: { type: "string", enum: ["themes", "features", "materials", "wall_styles", "presets"] }, theme: str },
    },
  },
];

/** Executor signature implemented in core. */
export interface ToolContext {
  plan: MapPlan | null;
  head: number;
  brief: DesignBrief;
  /** App-provided PNG renderer (renderer process); null in CLI/headless or when the model has no image input. */
  renderImage: ((level: LevelId, region?: ViewMapImageInput["region"], showIds?: boolean) => Promise<Uint8Array>) | null;
  /** Cheap compile estimate; null when the compiler is unavailable (the tool then says so). May be async (worker). */
  estimate: (plan: MapPlan, levels?: LevelId[]) => CompileEstimate | null | Promise<CompileEstimate | null>;
  catalog: { themes: Array<{ id: string; name: string; description?: string }>; featureCoverage: (theme: string) => Record<string, boolean> };
  newSeed: () => number;
  newPlanId: () => string;
}

export type ExecuteTool = (ctx: ToolContext, name: string, input: unknown) => Promise<ToolOutcome>;
