/** settingsStore + catalogStore (architecture §6.3): settings, providers, models, key status, asset library. */
import { create } from "zustand";
import type { IpcRequests } from "../../shared/ipc";
import type { AppSettings } from "../../shared/project";
import type { ModelDescriptor, ProviderInfo } from "../../main/agent/provider/types";
import { call } from "../bridge/client";

export type CatalogStatus = IpcRequests["catalog:status"]["res"];
type SecretRow = IpcRequests["secrets:status"]["res"][string] & { hint?: string | null };

interface SettingsState {
  settings: AppSettings | null;
  providers: Array<ProviderInfo & { enabled: boolean }>;
  models: ModelDescriptor[];
  secrets: Record<string, SecretRow>;
  catalog: CatalogStatus | null;
  catalogBusy: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  apply: (s: AppSettings) => void;
  refreshSecrets: () => Promise<void>;
  refreshCatalog: () => Promise<void>;
  setCatalogBusy: (b: boolean) => void;
  refreshModels: (refresh?: boolean) => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: null,
  providers: [],
  models: [],
  secrets: {},
  catalog: null,
  catalogBusy: false,
  load: async () => {
    const [settings, providers, secrets, catalog] = await Promise.all([
      call("settings:get", undefined),
      call("providers:list", undefined),
      call("secrets:status", undefined),
      call("catalog:status", undefined),
    ]);
    set({ settings, providers, secrets, catalog });
    await get().refreshModels();
  },
  refreshModels: async (refresh) => {
    const providerId = get().settings?.defaultSelection.providerId ?? "anthropic";
    const models = await call("models:list", refresh === true ? { providerId, refresh } : { providerId });
    set({ models });
  },
  update: async (patch) => {
    const cur = get().settings;
    if (cur) set({ settings: { ...cur, ...patch } }); // optimistic
    const settings = await call("settings:update", patch);
    set({ settings });
  },
  apply: (settings) => {
    set({ settings });
  },
  refreshSecrets: async () => {
    set({ secrets: await call("secrets:status", undefined) });
  },
  refreshCatalog: async () => {
    set({ catalog: await call("catalog:status", undefined) });
  },
  setCatalogBusy: (catalogBusy) => {
    set({ catalogBusy });
  },
}));

/** Short model name for pills and meta lines: "Opus 5.5" → "Opus". */
export function shortModelName(modelId: string, models: readonly ModelDescriptor[]): string {
  const d = models.find((m) => m.modelId === modelId);
  const name = d?.displayName ?? modelId.replace(/^claude-/, "");
  return name
    .replace(/^Claude\s+/i, "")
    .replace(/\s+[\d.]+$/, "")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export const EFFORT_LABEL: Record<string, string> = {
  low: "Quick",
  medium: "Balanced",
  high: "Thorough",
  xhigh: "Extra",
  max: "Max",
};

export const EFFORT_NOTE: Record<string, string> = {
  low: "Fastest and cheapest. Fine for small tweaks and chat.",
  medium: "Good for most edits.",
  high: "Worth it for a first plan or a big multi-level change.",
  xhigh: "Slower. For large, intricate maps.",
  max: "Slowest and most expensive. Use when nothing else gets it right.",
};
