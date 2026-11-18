import { z } from "zod";
import { EFFORT_LEVELS, type Usage } from "../agent/provider/types";

/** Shared Zod building blocks for IPC payloads and persisted files. */

export const providerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/);
export const effortSchema = z.enum(EFFORT_LEVELS);
export const levelIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_]{0,31}$/);
export const elementIdSchema = z.string().min(1).max(64);

export const modelSelectionSchema = z.strictObject({
  providerId: providerIdSchema,
  modelId: z.string().min(1).max(128),
  effort: effortSchema.nullable(),
});

export const usageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
  attempts: z
    .array(
      z.object({
        modelId: z.string(),
        inputTokens: z.number(),
        outputTokens: z.number(),
        cacheReadTokens: z.number(),
        cacheWriteTokens: z.number(),
      }),
    )
    .optional(),
});

export const costSchema = z.object({
  currency: z.literal("USD"),
  amount: z.number(),
  estimated: z.boolean(),
});

export const vec2Schema = z.tuple([z.number().int(), z.number().int()]);

export const mapSelectionSchema = z.strictObject({
  levelId: levelIdSchema,
  areaIds: z.array(elementIdSchema).max(500),
  featureIds: z.array(z.string().min(1).max(80)).max(2000),
  openingIds: z.array(elementIdSchema).max(500),
  linkIds: z.array(elementIdSchema).max(100),
  rect: z
    .strictObject({
      x: z.number().int(),
      y: z.number().int(),
      w: z.number().int().positive(),
      h: z.number().int().positive(),
    })
    .optional(),
});

/** Absolute local path coming from the renderer (it may only pick among paths main already gave it). */
export const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes("\0"), "invalid path");

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
