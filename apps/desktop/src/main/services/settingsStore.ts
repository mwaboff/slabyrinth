import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { AGENT_DEFAULTS } from "../../shared/agentSettings";
import type { AppSettings } from "../../shared/project";
import { emptyUsage } from "../../shared/schemas/common";
import { BASE_URL_PROVIDERS, settingsSchema, type SettingsPatch } from "../../shared/schemas/settings";
import { applySettingsPatch, deepMerge } from "../../shared/settingsPatch";
import type { Cost, Usage } from "../agent/provider/types";
import type { Logger } from "../logger";
import { writeFileAtomic } from "../util/atomicWrite";

/**
 * SettingsStore: userData/settings.json, schema "slabyrinth/settings@1" (architecture §6.4).
 * Defaults follow docs/decisions.md: dark theme, Home on launch, Opus 5.5 at medium, spend warnings
 * $1 per action and $10 per project. Main-only feature flags live next to the settings under the
 * extension key "x-featureFlags" and never reach the renderer.
 */

/** Drops a server URL from providers that use a stored key (shared/schemas/settings.ts BASE_URL_PROVIDERS). */
function stripKeyedBaseUrls(s: AppSettings): AppSettings {
  for (const [id, p] of Object.entries(s.providers)) {
    if (!BASE_URL_PROVIDERS.has(id) && p.baseUrl !== undefined) delete p.baseUrl;
  }
  return s;
}

export const FEATURE_FLAGS = {
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
    ui: { theme: "system", mapThemeId: "auto", gridVisible: true, onLaunch: "home" },
    suppressAssetWarning: false,
    defaultSystem: null,
    setupCompleted: false,
    updates: { autoCheck: true },
    agent: { ...AGENT_DEFAULTS },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
    return this.updateInternal((s) => applySettingsPatch(s, patch));
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
