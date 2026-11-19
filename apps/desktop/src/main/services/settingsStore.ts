import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { AppSettings } from "../../shared/project";
import type { Cost, Usage } from "../agent/provider/types";
import type { Logger } from "../logger";
import {
  costSchema,
  emptyUsage,
  modelSelectionSchema,
  pathSchema,
  providerIdSchema,
  usageSchema,
} from "../schemas/common";
import { writeFileAtomic } from "../util/atomicWrite";

/**
 * SettingsStore: userData/settings.json, schema "slabyrinth/settings@1" (architecture §6.4).
 * Defaults follow docs/decisions.md: dark theme, Home on launch, Opus 5.5 at medium, spend warnings
 * $1 per action and $10 per project. Main-only feature flags live next to the settings under the
 * extension key "x-featureFlags" and never reach the renderer.
 */

/**
 * Providers whose server URL may be configured: keyless local servers only (LM Studio). A provider
 * that uses a stored API key (Anthropic) always talks to its SDK default host, so a settings change
 * can never redirect the key elsewhere. Other providers' baseUrl is rejected on update and dropped
 * when loading settings.json.
 */
export const BASE_URL_PROVIDERS: ReadonlySet<string> = new Set(["lmstudio"]);

function stripKeyedBaseUrls(s: AppSettings): AppSettings {
  for (const [id, p] of Object.entries(s.providers)) {
    if (!BASE_URL_PROVIDERS.has(id) && p.baseUrl !== undefined) delete p.baseUrl;
  }
  return s;
}

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
const defaultSystemSchema = z.strictObject({
  system: z.enum(["daggerheart", "dnd5e", "other"]),
  otherName: z.string().trim().min(1).max(60).optional(),
});
const warnUsd = z.number().min(0).max(100_000).nullable();

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
});

/**
 * What the renderer may change through `settings:update` (Partial<AppSettings>, nested objects
 * merged). Main-owned fields are not accepted: schema, spending.allTime, talespire.lastScanAt,
 * talespire.installPath (use talespire:setPath, which validates), projects.recent.
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
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const FEATURE_FLAGS = {
  /** Use the recorded-stream fake engine even when the real ConversationEngine exists. */
  fakeEngine: false,
  /** Use the fake compiler even when core's compilePlan exists. */
  fakeCompile: false,
  /** Watch the Taleweaver folder for game updates while the app runs. */
  watchTaleSpire: true,
  /** Debug logging (prompts are still never logged by WP5 code). */
  debugLogging: false,
} as const;
export type FeatureFlag = keyof typeof FEATURE_FLAGS;

export function defaultSettings(projectsFolder: string): AppSettings {
  return {
    schema: "slabyrinth/settings@1",
    defaultSelection: { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "medium" },
    providers: {
      anthropic: { enabled: true },
      lmstudio: { enabled: false, baseUrl: "http://localhost:1234/v1" },
    },
    smartEffort: true,
    showReasoning: false,
    spending: { perActionWarnUsd: 1, perProjectWarnUsd: 10, allTime: { usage: emptyUsage(), cost: null } },
    talespire: { installPath: null, lastScanAt: null, levelLayout: "stacked", alignmentMarkers: false },
    projects: { folder: projectsFolder, recent: [] },
    ui: { theme: "dark", mapThemeId: "auto", gridVisible: true, onLaunch: "home" },
    suppressAssetWarning: false,
    defaultSystem: null,
    setupCompleted: false,
    updates: { autoCheck: true },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge of plain objects; arrays and scalars replace; `undefined` is skipped. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isRecord(base) || !isRecord(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isRecord(out[k]) && isRecord(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export interface SettingsStoreOptions {
  file: string;
  defaultProjectsFolder: string;
  logger: Logger;
}

type Listener = (s: AppSettings) => void;

export class SettingsStore {
  private settings: AppSettings;
  private flags: Record<string, boolean> = {};
  private readonly listeners = new Set<Listener>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: SettingsStoreOptions) {
    this.settings = defaultSettings(opts.defaultProjectsFolder);
  }

  /** Loads settings.json. A missing or unreadable file falls back to defaults (the bad file is kept as .corrupt). */
  async load(): Promise<AppSettings> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fsp.readFile(this.opts.file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.opts.logger.warn("settings unreadable; using defaults", { error: err });
        await fsp.copyFile(this.opts.file, `${this.opts.file}.corrupt`).catch(() => undefined);
      }
      raw = undefined;
    }
    this.settings = this.migrate(raw);
    if (isRecord(raw) && isRecord(raw["x-featureFlags"])) {
      for (const [k, v] of Object.entries(raw["x-featureFlags"]))
        if (typeof v === "boolean") this.flags[k] = v;
    }
    return this.settings;
  }

  /** settings@1 is the only version: merge what is valid onto defaults, field by field. */
  private migrate(raw: unknown): AppSettings {
    const defaults = defaultSettings(this.opts.defaultProjectsFolder);
    if (!isRecord(raw)) return defaults;
    const merged = deepMerge(defaults, raw);
    const parsed = settingsSchema.safeParse(merged);
    if (parsed.success) return stripKeyedBaseUrls(parsed.data as AppSettings);
    // Drop invalid top-level fields one by one.
    const repaired: Record<string, unknown> = { ...merged };
    for (const issue of parsed.error.issues) {
      const top = issue.path[0];
      if (typeof top === "string" && top in defaults)
        repaired[top] = (defaults as unknown as Record<string, unknown>)[top];
    }
    repaired["schema"] = "slabyrinth/settings@1";
    const second = settingsSchema.safeParse(repaired);
    this.opts.logger.warn("settings repaired", { issues: parsed.error.issues.length });
    return second.success ? stripKeyedBaseUrls(second.data as AppSettings) : defaults;
  }

  get(): AppSettings {
    return structuredClone(this.settings);
  }

  /** Renderer-facing update (already validated with settingsPatchSchema). */
  async update(patch: SettingsPatch): Promise<AppSettings> {
    return this.updateInternal((s) => {
      const { defaultSystem, ...rest } = patch;
      const next = deepMerge(s, rest);
      // Replaced whole, never merged (a stale otherName must not survive a switch to another system).
      if (defaultSystem !== undefined)
        next.defaultSystem =
          defaultSystem === null
            ? null
            : defaultSystem.otherName === undefined
              ? { system: defaultSystem.system }
              : { system: defaultSystem.system, otherName: defaultSystem.otherName };
      return next;
    });
  }

  /** Main-side update of any field (recent projects, lastScanAt, spend totals, installPath). */
  async updateInternal(mutate: (s: AppSettings) => AppSettings): Promise<AppSettings> {
    const next = mutate(structuredClone(this.settings));
    const parsed = stripKeyedBaseUrls(settingsSchema.parse(next) as AppSettings);
    this.settings = parsed;
    await this.persist();
    for (const l of this.listeners) l(this.get());
    return this.get();
  }

  async addSpend(usage: Usage, cost: Cost | null): Promise<void> {
    await this.updateInternal((s) => {
      const t = s.spending.allTime;
      t.usage = {
        inputTokens: t.usage.inputTokens + usage.inputTokens,
        outputTokens: t.usage.outputTokens + usage.outputTokens,
        cacheReadTokens: t.usage.cacheReadTokens + usage.cacheReadTokens,
        cacheWriteTokens: t.usage.cacheWriteTokens + usage.cacheWriteTokens,
      };
      if (cost) t.cost = { currency: "USD", amount: (t.cost?.amount ?? 0) + cost.amount, estimated: true };
      return s;
    });
  }

  async touchRecent(file: string): Promise<void> {
    await this.updateInternal((s) => {
      const norm = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
      s.projects.recent = [file, ...s.projects.recent.filter((p) => norm(p) !== norm(file))].slice(0, 10);
      return s;
    });
  }

  async removeRecent(file: string): Promise<void> {
    await this.updateInternal((s) => {
      s.projects.recent = s.projects.recent.filter((p) => p !== file);
      return s;
    });
  }

  flag(name: FeatureFlag): boolean {
    return this.flags[name] ?? FEATURE_FLAGS[name];
  }

  async setFlag(name: FeatureFlag, value: boolean): Promise<void> {
    this.flags[name] = value;
    await this.persist();
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(): Promise<void> {
    const body = JSON.stringify({ ...this.settings, "x-featureFlags": this.flags }, null, 2);
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await fsp.mkdir(path.dirname(this.opts.file), { recursive: true });
        await writeFileAtomic(this.opts.file, body);
      })
      .catch((err: unknown) => {
        this.opts.logger.error("settings write failed", { error: err });
        throw err;
      });
    return this.writeChain;
  }
}
