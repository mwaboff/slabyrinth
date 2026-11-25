import { z } from "zod";
import { BriefPatchSchema } from "@slabyrinth/core/agent";
import { PlanOpSchema } from "@slabyrinth/core/plan";
import { REVISION_LIMIT_RANGE } from "../agentSettings";
import type { IpcRequests, IpcSends } from "../ipc";
import {
  effortSchema,
  levelIdSchema,
  mapSelectionSchema,
  modelSelectionSchema,
  pathSchema,
  providerIdSchema,
} from "./common";
import { settingsPatchSchema, type SettingsPatch } from "./settings";

/**
 * Zod schema for every request channel of the IPC contract. Main's router validates every request with these before
 * any handler runs (mismatch → code "validation"); the renderer's fake bridge validates with the same ones, so a
 * renderer test cannot send what main would refuse. Objects are strict (unknown keys are rejected). Plan ops use
 * core's op schema (the one the model's edit_plan is held to); their semantics are checked by core applyOps.
 *
 * Each schema's output is typed against its contract request (`RequestSchemas` below), so a schema that accepts a
 * different shape from shared/ipc.ts fails to compile.
 */
const voidReq = z.union([z.undefined(), z.null()]).transform(() => undefined);
const id = z.string().min(1).max(64);
const version = z.number().int().min(0).max(1_000_000);
const shortText = z.string().max(200);

const chunkOptionsSchema = z.strictObject({
  fill: z.number().min(0.1).max(1).optional(),
  tileCells: z.number().int().min(4).max(160).optional(),
  alignment: z.enum(["multi-chunk", "always", "none"]).optional(),
  levels: z.array(levelIdSchema).max(8).optional(),
  levelLayout: z.enum(["stacked", "side_by_side"]).optional(),
  sideBySideGap: z.number().int().min(0).max(100).optional(),
  grouping: z.enum(["fewest", "per-level"]).optional(),
});

const displayOptionsSchema = z.strictObject({
  grid: z.boolean(),
  roomNumbers: z.boolean(),
  roomNames: z.boolean(),
  furniture: z.boolean(),
  gmLayer: z.boolean(),
  legend: z.boolean(),
  // no ghostLevel: the export never draws one, and the renderer never sends it
});

const pngExportOptionsSchema = z.strictObject({
  levels: z.union([z.array(levelIdSchema).max(8), z.literal("all")]),
  pxPerCell: z.number().min(4).max(400),
  version: version.optional(),
  display: displayOptionsSchema,
  mapThemeId: z.string().min(1).max(64),
  keyPanel: z.boolean(),
  background: z.enum(["theme", "transparent"]),
});

// 16384² px PNGs can be large; base64 grows by 4/3.
const pngBase64 = z
  .string()
  .min(12)
  .max(300 * 1024 * 1024)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);

const chunkRefSchema = z.strictObject({
  buildId: z.string().min(1).max(64),
  chunkId: z.string().min(1).max(64),
});

/** ProjectFile["ui"] (resume state), all fields optional (shallow merge). */
const uiStateSchema = z.strictObject({
  tab: z.enum(["map", "build"]).optional(),
  levelId: levelIdSchema.optional(),
  zoom: z.number().min(0.01).max(100).optional(),
  pan: z.tuple([z.number(), z.number()]).optional(),
  roomKeyScroll: z.number().min(0).optional(),
  briefExpanded: z.boolean().optional(),
  layers: z.record(z.string().max(32), z.boolean()).optional(),
  chatWidth: z.number().min(0).max(10_000).optional(),
  composerDraft: z
    .strictObject({
      text: z.string().max(100_000),
      references: z
        .array(
          z.strictObject({
            type: z.enum(["room", "feature", "area", "level", "opening", "link"]),
            id: z.string().min(1).max(80),
            levelId: levelIdSchema,
          }),
        )
        .max(200),
    })
    .optional(),
});

/**
 * A schema per channel whose parsed output is assignable to the contract's request type: a missing channel, or a
 * schema that lets through a shape the handler is not typed for, is a compile error.
 */
export type RequestSchemas = {
  [C in Exclude<keyof IpcRequests, "settings:update">]: z.ZodType<
    OptionalMayBeUndefined<IpcRequests[C]["req"]>
  >;
} & {
  /**
   * The one declared difference: the contract types `settings:update` as `Partial<AppSettings>` (shallow), while main
   * merges nested objects and accepts only the fields the renderer may change (SettingsPatch, a nested partial; the
   * contract's own comment sends `{ projects: { folder } }`). The schema is typed against what main applies.
   */
  "settings:update": z.ZodType<SettingsPatch>;
};
export type SendSchemas = { [C in keyof IpcSends]: z.ZodType<OptionalMayBeUndefined<IpcSends[C]>> };

/**
 * The contract type as a Zod schema's output can match it: under exactOptionalPropertyTypes an optional key of a
 * parsed object may hold `undefined`, which the contract's `key?: T` does not say. Everything else must match.
 */
type OptionalMayBeUndefined<T> = T extends readonly unknown[]
  ? { [K in keyof T]: OptionalMayBeUndefined<T[K]> }
  : T extends object
    ? {
        [K in keyof T]: undefined extends T[K]
          ? OptionalMayBeUndefined<T[K]> | undefined
          : OptionalMayBeUndefined<T[K]>;
      }
    : T;

/** The "validation" message for a request its schema refused (main's router and the fake bridge). */
export function describeRequestError(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return "Invalid request.";
  const where = first.path.length > 0 ? ` at ${first.path.join(".")}` : "";
  return `Invalid request${where}: ${first.message}`;
}

/** Every request channel → its payload schema. */
export const requestSchemas: RequestSchemas = {
  "app:getInfo": voidReq,
  "settings:get": voidReq,
  "settings:update": settingsPatchSchema,

  "secrets:setApiKey": z.strictObject({
    providerId: providerIdSchema,
    apiKey: z.string().min(1).max(1024),
    storage: z.enum(["auto", "allow_weak", "memory_only"]).optional(),
    verify: z.boolean().optional(),
  }),
  "secrets:storeWeak": z.strictObject({ providerId: providerIdSchema }),
  "secrets:clearApiKey": z.strictObject({ providerId: providerIdSchema }),
  "secrets:status": voidReq,

  "providers:list": voidReq,
  "providers:check": z.strictObject({ providerId: providerIdSchema }),
  "models:list": z.strictObject({ providerId: providerIdSchema, refresh: z.boolean().optional() }),

  "project:new": z.strictObject({
    name: z.string().max(120).optional(),
    selection: modelSelectionSchema.optional(),
  }),
  "project:open": z.strictObject({ path: pathSchema.optional() }),
  "project:saveCopyAs": voidReq,
  "project:rename": z.strictObject({ name: z.string().min(1).max(120) }),
  "project:duplicate": z.strictObject({ path: pathSchema }),
  "project:trash": z.strictObject({ path: pathSchema }),
  "project:revealInFolder": z.strictObject({ path: pathSchema }),
  "project:close": z.strictObject({ discardUnsaved: z.boolean().optional() }),
  "project:snapshot": voidReq,
  "project:setUiState": z.strictObject({
    ui: uiStateSchema.optional(),
    pasteGuide: z
      .strictObject({ buildId: z.string().min(1).max(64), currentStep: z.number().int().min(0).max(10_000) })
      .nullable()
      .optional(),
    pngExport: z
      .strictObject({
        scope: z.enum(["level", "all"]),
        version: version.optional(),
        style: z.string().min(1).max(64),
        pxPerSquare: z.number().min(4).max(400),
        grid: z.boolean(),
        numbers: z.boolean(),
        names: z.boolean(),
        gmLayer: z.boolean(),
        keyPanel: z.boolean().optional(),
      })
      .optional(),
  }),
  "project:list": voidReq,
  "project:importPlan": voidReq,
  "project:exportPlan": voidReq,

  "plan:applyOps": z.strictObject({
    baseVersion: version,
    label: shortText.min(1),
    ops: z.array(PlanOpSchema).min(1).max(500),
  }),
  "plan:undo": voidReq,
  "plan:redo": voidReq,
  "plan:restore": z.strictObject({ version: version.min(1) }),
  "plan:getVersion": z.strictObject({ version: version.min(1) }),
  "plan:diff": z.strictObject({ from: version, to: version.min(1) }),
  "plan:approve": z.strictObject({ version: version.min(1) }),
  "plan:editText": z.strictObject({ id, set: z.record(z.string().max(32), z.string().max(4000).nullable()) }),

  // the values update_brief accepts, or null to clear (core BriefPatchSchema; main checks again in the service)
  "brief:update": z.strictObject({ set: BriefPatchSchema }),

  "chat:send": z.strictObject({
    text: z.string().max(100_000),
    selection: mapSelectionSchema.optional(),
    imageBlobs: z.array(pngBase64).max(8).optional(),
    answers: z
      .strictObject({
        callId: z.string().min(1).max(128),
        answers: z
          .array(z.strictObject({ id: z.string().min(1).max(64), answer: z.string().max(4000).nullable() }))
          .max(20),
      })
      .optional(),
    intent: z.enum(["chat", "plan", "auto"]).optional(),
  }),
  "chat:estimate": z.strictObject({
    text: z.string().max(100_000),
    selection: modelSelectionSchema.optional(),
    intent: z.enum(["chat", "plan", "auto"]).optional(),
  }),
  "chat:cancel": z.strictObject({ turnId: z.string().min(1).max(64) }),
  "chat:retry": z.strictObject({ selection: modelSelectionSchema.optional() }),
  "chat:selectAlternative": z.strictObject({
    messageId: z.string().min(1).max(64),
    index: z.number().int().min(0).max(100),
  }),
  "chat:continue": z.union([
    voidReq,
    z.strictObject({
      allowance: z.number().int().min(REVISION_LIMIT_RANGE.min).max(REVISION_LIMIT_RANGE.max).optional(),
    }),
  ]),
  "chat:previewSwitch": z.strictObject({ selection: modelSelectionSchema }),
  "chat:setSelection": z.strictObject({ selection: modelSelectionSchema }),
  "chat:setEffort": z.strictObject({ effort: effortSchema.nullable() }),
  "chat:newConversation": z.strictObject({ selection: modelSelectionSchema.optional() }),

  "compile:estimate": z.strictObject({ levels: z.array(levelIdSchema).max(8).optional() }),
  "compile:run": z.strictObject({
    version: version.min(1).optional(),
    options: chunkOptionsSchema.optional(),
  }),
  "compile:cancel": voidReq,
  "build:setPasted": z.strictObject({
    buildId: z.string().min(1).max(64),
    chunkId: z.string().min(1).max(64),
    pasted: z.boolean(),
  }),
  "build:saveChunk": z.strictObject({
    buildId: z.string().min(1).max(64),
    chunkId: z.string().min(1).max(64),
  }),

  "export:savePng": z.strictObject({
    suggestedName: z.string().min(1).max(200),
    files: z
      .array(z.strictObject({ levelId: levelIdSchema, pngBase64 }))
      .min(1)
      .max(8),
    options: pngExportOptionsSchema,
  }),
  "export:roomKeyMarkdown": z.strictObject({ copyToClipboard: z.boolean() }),

  "clipboard:writeText": z.strictObject({
    text: z.string().max(8 * 1024 * 1024),
    chunk: chunkRefSchema.optional(),
  }),

  "dialog:pickFolder": z.strictObject({ purpose: z.enum(["talespire", "projects"]) }),
  "talespire:locate": voidReq,
  "talespire:setPath": z.strictObject({ path: pathSchema.nullable() }),
  "catalog:status": voidReq,
  "catalog:refresh": z.strictObject({ force: z.boolean().optional() }),
  "talespire:copyAndOpen": z.strictObject({
    text: z
      .string()
      .min(1)
      .max(1024 * 1024),
    chunk: chunkRefSchema.optional(),
  }),
  "talespire:isRunning": voidReq,
  "talespire:openUrl": z.strictObject({ url: z.string().min(1).max(200) }),

  "palettes:list": voidReq,
  "palettes:reload": voidReq,
  "palettes:openFolder": voidReq,
  "palettes:resolveData": voidReq,

  "shell:openExternal": z.strictObject({ url: z.string().min(1).max(2048) }),

  "updates:status": voidReq,
  "updates:check": z.strictObject({ manual: z.boolean() }),
  "updates:skip": z.strictObject({
    version: z
      .string()
      .min(5)
      .max(64)
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  }),

  "addon:status": voidReq,
  "addon:install": voidReq,
  "addon:chooseFolder": z.strictObject({ reset: z.boolean().optional() }),
  "addon:uninstall": z.strictObject({ elsewhere: z.boolean().optional() }),
  "addon:openFolder": z.strictObject({ which: z.enum(["installed", "package"]) }),
  "addon:dismissPrompt": z.strictObject({
    version: z
      .string()
      .min(1)
      .max(32)
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  }),
  "link:status": voidReq,
  "link:send": z.strictObject({ buildId: id }),
  "link:stop": voidReq,
};

export const sendSchemas: SendSchemas = {
  "render:imageResult": z.union([
    z.strictObject({ requestId: z.string().min(1).max(64), ok: z.literal(true), pngBase64 }),
    z.strictObject({
      requestId: z.string().min(1).max(64),
      ok: z.literal(false),
      error: z.string().max(2000),
    }),
  ]),
};
