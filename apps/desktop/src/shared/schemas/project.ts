import { z } from "zod";
import { StoredBriefSchema } from "@slabyrinth/core/agent";
import { PROJECT_FORMAT } from "../project";

/**
 * What a `.slabyrinth` file must hold for the app to read it as typed data (shared/project.ts ProjectFile). Main checks
 * every file it opens with this before any view, the engine or the model reads it; the head plan is checked again
 * with core's plan schema (projectFile.ts).
 *
 * Leniency, on purpose (users have saved projects; a file from an older build must still open):
 *  - objects are loose: unknown and extension keys survive a round trip;
 *  - optional fields may be missing; limits are not checked (only the types the code relies on);
 *  - the brief is checked with core's stored-brief schema (types without today's limits);
 *  - resume state (`ui`) that does not fit is reset rather than refused (it is view state, not the GM's content).
 * A file that fails is refused with a message naming the first thing that is wrong; nothing is dropped silently.
 */
const str = z.string();
const int = z.number().int();

const chatItemSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("user"), id: str, text: str, createdAt: str }),
  z.looseObject({ type: z.literal("context"), id: str, reason: str, text: str, createdAt: str }),
  z.looseObject({
    type: z.literal("assistant"),
    id: str,
    turnId: str,
    parts: z.array(z.looseObject({ type: str })),
    stopReason: str,
    createdAt: str,
  }),
  z.looseObject({ type: z.literal("marker"), id: str, kind: str, createdAt: str }),
  z.looseObject({
    type: z.literal("tool_results"),
    id: str,
    turnId: str,
    results: z.array(
      z.looseObject({
        callId: str,
        name: str,
        isError: z.boolean(),
        content: z.array(z.looseObject({ type: str })),
      }),
    ),
    createdAt: str,
  }),
]);

const usageSchema = z.looseObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
});

const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Missing bookkeeping (what the app derives, not what the GM wrote) gets its starting value. */
const conversationSchema = z.looseObject({
  id: str,
  createdAt: str,
  selection: z.looseObject({ providerId: str, modelId: str }),
  systemPromptVersion: str.optional(),
  toolsVersion: str.optional(),
  items: z.array(chatItemSchema),
  meta: z.record(str, z.unknown()).default({}),
  modelSeen: z.looseObject({ head: int, briefHash: str }).default({ head: 0, briefHash: "" }),
  totals: z
    .looseObject({ usage: usageSchema, turns: z.number() })
    .default({ usage: zeroUsage, turns: 0, cost: null }),
  archived: z.boolean().default(false),
});

/** A plan stored in a file: an object with levels (the full plan schema checks the head plan). */
const storedPlanSchema = z.looseObject({ id: str, levels: z.array(z.looseObject({ id: str })) });

// ops are checked when they are replayed (core applyOps), so an op an older build wrote never blocks opening the file
const causeSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("create") }),
  z.looseObject({ type: z.literal("ops"), ops: z.array(z.looseObject({ op: str })) }),
  z.looseObject({ type: z.literal("restore"), from: int }),
  z.looseObject({ type: z.literal("migrate"), fromSchema: str }),
]);

const versionSchema = z.looseObject({
  number: int.positive(),
  parentNumber: int.nonnegative(),
  author: z.enum(["ai", "user", "restore"]),
  createdAt: str,
  summary: str,
  changeSummary: z.array(str).default([]),
  cause: causeSchema,
  snapshot: storedPlanSchema.optional(),
});

const buildSchema = z.looseObject({
  id: str,
  versionNumber: int,
  createdAt: str,
  levels: z.array(
    z.looseObject({
      levelId: str,
      pasteOrder: z.number(),
      chunks: z.array(z.looseObject({ id: str, pasted: z.boolean() })),
    }),
  ),
  // absent in builds saved before 2026-11-22 and in builds pasted the plain way
  pasteAnchor: z
    .looseObject({
      side: z.enum(["north", "east", "south", "west"]),
      clearanceCells: int.nonnegative(),
      farMarkerCells: int.nonnegative(),
    })
    .optional(),
});

/** The resume state the renderer reads (ProjectFile.ui). */
export const storedUiSchema = z.looseObject({
  tab: z.enum(["map", "build"]),
  levelId: str.optional(),
  zoom: z.number().optional(),
  pan: z.tuple([z.number(), z.number()]).optional(),
  roomKeyScroll: z.number().optional(),
  briefExpanded: z.boolean().optional(),
  layers: z.record(str, z.boolean()).optional(),
  chatWidth: z.number().optional(),
  composerDraft: z
    .looseObject({ text: str, references: z.array(z.looseObject({ type: str, id: str, levelId: str })) })
    .optional(),
  lastActivityAt: str.optional(),
});

export const storedProjectSchema = z.looseObject({
  format: z.literal(PROJECT_FORMAT),
  formatVersion: int.positive(),
  appVersion: str,
  id: str.min(1),
  name: str,
  createdAt: str,
  updatedAt: str,
  brief: StoredBriefSchema,
  plan: storedPlanSchema.nullable(),
  history: z.looseObject({
    head: int.nonnegative(),
    versions: z.array(versionSchema),
    undone: z.array(int),
    approvedVersion: int.nullable(),
  }),
  conversations: z.array(conversationSchema).min(1),
  activeConversationId: str,
  builds: z.array(buildSchema).default([]),
  spend: z.looseObject({ usage: usageSchema }).default({ usage: zeroUsage, cost: null }),
  blobs: z.record(str, z.unknown()).default({}),
  stamps: z.record(str, z.unknown()).default({}),
  // checked on its own (storedUiSchema): resume state that does not fit is reset, never a reason to refuse the file
  ui: z.unknown(),
  thumbnail: z.looseObject({ levelId: str, version: int, pngBase64: str }).optional(),
});

/** "at conversations.0.items.3.text" for the first issue of a refused file. */
export function describeStoredIssue(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return "";
  return first.path.length > 0 ? `${first.path.join(".")}: ${first.message}` : first.message;
}
