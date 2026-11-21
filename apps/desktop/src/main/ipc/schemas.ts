import { z } from "zod";
import type { IpcRequests, IpcSends } from "../../shared/ipc";
import {
  effortSchema,
  levelIdSchema,
  mapSelectionSchema,
  modelSelectionSchema,
  pathSchema,
  providerIdSchema,
} from "../schemas/common";
import { settingsPatchSchema } from "../services/settingsStore";

/**
 * Zod schema for every request channel of the IPC contract. Payloads that do not match are
 * rejected with code "validation" before any handler runs. Objects are strict (unknown keys are
 * rejected). Plan ops are checked structurally here; their semantics are validated by core
 * applyOps (same rule as for the model's edit_plan).
 */
const voidReq = z.union([z.undefined(), z.null()]);
const id = z.string().min(1).max(64);
const version = z.number().int().min(0).max(1_000_000);
const shortText = z.string().max(200);

const planOpSchema = z.looseObject({
  op: z.enum([
    "add",
    "add_features",
    "update",
    "remove",
    "move",
    "duplicate",
    "reorder",
    "materialize",
    "set_meta",
    "reshape",
    "renumber",
  ]),
});

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
  ghostLevel: z.unknown().optional(),
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

const briefKeys = z.enum([
  "mapType",
  "system",
  "party",
  "footprint",
  "levels",
  "tone",
  "mustInclude",
  "avoid",
  "theme",
]);

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

/** Every request channel → its payload schema. The mapped type makes a missing channel a compile error. */
export const requestSchemas: { [C in keyof IpcRequests]: z.ZodType } = {
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
    ops: z.array(planOpSchema).min(1).max(500),
  }),
  "plan:undo": voidReq,
  "plan:redo": voidReq,
  "plan:restore": z.strictObject({ version: version.min(1) }),
  "plan:getVersion": z.strictObject({ version: version.min(1) }),
  "plan:diff": z.strictObject({ from: version, to: version.min(1) }),
  "plan:approve": z.strictObject({ version: version.min(1) }),
  "plan:editText": z.strictObject({ id, set: z.record(z.string().max(32), z.string().max(4000).nullable()) }),

  "brief:update": z.strictObject({ set: z.partialRecord(briefKeys, z.unknown()) }),

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
  "chat:continue": voidReq,
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
};

export const sendSchemas: { [C in keyof IpcSends]: z.ZodType } = {
  "render:imageResult": z.union([
    z.strictObject({ requestId: z.string().min(1).max(64), ok: z.literal(true), pngBase64 }),
    z.strictObject({
      requestId: z.string().min(1).max(64),
      ok: z.literal(false),
      error: z.string().max(2000),
    }),
  ]),
};
