import { z } from "zod";
import { GAME_SYSTEM_IDS, SIZE_TIER_ORDER, type GameSystemId, type SizeTierId } from "@slabyrinth/core/plan";
import { AGENT_DEFAULTS, PICTURES_RANGE, REVISION_LIMIT_RANGE } from "../agentSettings";
import type { AppSettings } from "../project";
import { costSchema, modelSelectionSchema, pathSchema, providerIdSchema, usageSchema } from "./common";

/**
 * The settings file (settings@1) and what the renderer may change of it (`settings:update`). Main's SettingsStore
 * reads and writes the file with these; the IPC request schemas and the fake bridge use the patch schema.
 */

/**
 * Providers whose server URL may be configured: keyless local servers only (LM Studio). A provider
 * that uses a stored API key (Anthropic) always talks to its SDK default host, so a settings change
 * can never redirect the key elsewhere. Other providers' baseUrl is rejected on update and dropped
 * when loading settings.json.
 */
export const BASE_URL_PROVIDERS: ReadonlySet<string> = new Set(["lmstudio"]);

const providerSettingsSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .max(512)
    .optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  defaultSelection: modelSelectionSchema.optional(),
});

const themeSchema = z.enum(["dark", "light", "system"]);
/**
 * The settings contract (shared/project.ts, a verbatim copy of docs/contracts/project.ts) spells the game systems out;
 * the schema and every picker use core's GAME_SYSTEM_IDS. This fails to compile the day the two lists differ (a
 * system added to the brief contract and not to the settings one, or the other way round): the owner then updates the
 * contract.
 */
type SettingsSystem = NonNullable<AppSettings["defaultSystem"]>["system"];
export const SETTINGS_SYSTEMS_ARE_CORES: [SettingsSystem] extends [GameSystemId]
  ? [GameSystemId] extends [SettingsSystem]
    ? true
    : never
  : never = true;
const defaultSystemSchema = z.strictObject({
  system: z.enum(GAME_SYSTEM_IDS),
  otherName: z.string().trim().min(1).max(60).optional(),
});
const warnUsd = z.number().min(0).max(100_000).nullable();
/** The map size setting: core's tiers (a contract list checked against core's below). */
const mapSizeSchema = z.enum(SIZE_TIER_ORDER as [SizeTierId, ...SizeTierId[]]);
type SettingsMapSize = NonNullable<AppSettings["mapSize"]>;
export const SETTINGS_SIZES_ARE_CORES: [SettingsMapSize] extends [SizeTierId]
  ? [SizeTierId] extends [SettingsMapSize]
    ? true
    : never
  : never = true;

const revisionLimit = z.number().int().min(REVISION_LIMIT_RANGE.min).max(REVISION_LIMIT_RANGE.max);
const picturesLimit = z.number().int().min(PICTURES_RANGE.min).max(PICTURES_RANGE.max);
/** The stored agent group: a field missing from the file (an older or partial group) reads as its default. */
const agentSchema = z.object({
  maxRevisionsPerTurn: revisionLimit.default(AGENT_DEFAULTS.maxRevisionsPerTurn),
  view3d: z.boolean().default(AGENT_DEFAULTS.view3d),
  maxPicturesPerTurn: picturesLimit.default(AGENT_DEFAULTS.maxPicturesPerTurn),
});

export const settingsSchema = z.object({
  schema: z.literal("slabyrinth/settings@1"),
  defaultSelection: modelSelectionSchema,
  providers: z.record(providerIdSchema, providerSettingsSchema),
  smartEffort: z.boolean(),
  showReasoning: z.boolean(),
  spending: z.object({
    perActionWarnUsd: warnUsd,
    perProjectWarnUsd: warnUsd,
    allTime: z.object({ usage: usageSchema, cost: costSchema.nullable() }),
  }),
  talespire: z.object({
    installPath: pathSchema.nullable(),
    lastScanAt: z.string().nullable(),
    levelLayout: z.enum(["stacked", "side_by_side"]),
    alignmentMarkers: z.boolean(),
    symbiotesFolder: pathSchema.nullable().optional(),
    addonPromptDismissed: z.string().min(1).max(32).optional(),
  }),
  projects: z.object({ folder: pathSchema, recent: z.array(pathSchema).max(10) }),
  ui: z.object({
    theme: themeSchema,
    mapThemeId: z.string().min(1).max(64),
    gridVisible: z.boolean(),
    onLaunch: z.enum(["home", "last_project"]),
  }),
  suppressAssetWarning: z.boolean(),
  defaultSystem: defaultSystemSchema.nullable(),
  setupCompleted: z.boolean(),
  updates: z.object({
    autoCheck: z.boolean(),
    skippedVersion: z.string().min(1).max(64).optional(),
    lastCheckedAt: z.string().min(1).max(64).optional(),
  }),
  mapSize: mapSizeSchema.optional(),
  agent: agentSchema.optional(),
});

/**
 * What the renderer may change through `settings:update` (Partial<AppSettings>, nested objects
 * merged). Main-owned fields are not accepted: schema, spending.allTime, talespire.lastScanAt,
 * talespire.installPath (use talespire:setPath, which validates), talespire.symbiotesFolder (addon:chooseFolder),
 * talespire.addonPromptDismissed (addon:dismissPrompt), projects.recent.
 */
export const settingsPatchSchema = z.strictObject({
  defaultSelection: modelSelectionSchema.optional(),
  providers: z
    .record(providerIdSchema, providerSettingsSchema.partial())
    .superRefine((providers, ctx) => {
      for (const [id, p] of Object.entries(providers)) {
        if (p.baseUrl !== undefined && !BASE_URL_PROVIDERS.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: [id, "baseUrl"],
            message: "a server URL can only be set for local providers that use no API key",
          });
        }
      }
    })
    .optional(),
  smartEffort: z.boolean().optional(),
  showReasoning: z.boolean().optional(),
  spending: z
    .strictObject({ perActionWarnUsd: warnUsd.optional(), perProjectWarnUsd: warnUsd.optional() })
    .optional(),
  talespire: z
    .strictObject({
      levelLayout: z.enum(["stacked", "side_by_side"]).optional(),
      alignmentMarkers: z.boolean().optional(),
    })
    .optional(),
  projects: z.strictObject({ folder: pathSchema.optional() }).optional(),
  ui: z
    .strictObject({
      theme: themeSchema.optional(),
      mapThemeId: z.string().min(1).max(64).optional(),
      gridVisible: z.boolean().optional(),
      onLaunch: z.enum(["home", "last_project"]).optional(),
    })
    .optional(),
  suppressAssetWarning: z.boolean().optional(),
  defaultSystem: defaultSystemSchema.nullable().optional(),
  setupCompleted: z.boolean().optional(),
  /** skippedVersion (updates:skip) and lastCheckedAt are main-owned. */
  updates: z.strictObject({ autoCheck: z.boolean().optional() }).optional(),
  mapSize: mapSizeSchema.optional(),
  /** Every field is the GM's (none main-owned), so a patch spread from the stored group is accepted too. */
  agent: z
    .strictObject({
      maxRevisionsPerTurn: revisionLimit.optional(),
      view3d: z.boolean().optional(),
      maxPicturesPerTurn: picturesLimit.optional(),
    })
    .optional(),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
