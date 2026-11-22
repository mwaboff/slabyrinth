/** The fake main's app-level channels: app info, settings, the API key, providers and models, dialogs, updates. */
import { FAKE_MODELS, FAKE_PROVIDERS } from "../models";
import type { FakeState, HandlerGroup } from "../state";
import { fail } from "../state";

type AppChannels =
  | "app:getInfo"
  | "settings:get"
  | "settings:update"
  | "secrets:setApiKey"
  | "secrets:storeWeak"
  | "secrets:clearApiKey"
  | "secrets:status"
  | "providers:list"
  | "dialog:pickFolder"
  | "providers:check"
  | "models:list"
  | "shell:openExternal"
  | "updates:status"
  | "updates:check"
  | "updates:skip";

export function appHandlers(s: FakeState): HandlerGroup<AppChannels> {
  return {
    "app:getInfo": () => ({
      version: "0.1.0-fake",
      platform: s.scenario.win === true ? "win32" : "linux",
      userDataPath: "C:\\Users\\GM\\AppData\\Roaming\\Slabyrinth",
    }),
    "settings:get": () => structuredClone(s.settings),
    "settings:update": (patch) => {
      s.settings = { ...s.settings, ...structuredClone(patch) };
      s.emit("settings:changed", structuredClone(s.settings));
      return structuredClone(s.settings);
    },
    "secrets:setApiKey": async ({ apiKey, verify }) => {
      await s.sleep(400);
      if (!apiKey.startsWith("sk-ant-"))
        return fail("validation", "That doesn't look like an Anthropic key.");
      s.hasKey = true;
      s.keyHint = `sk-ant-…${apiKey.slice(-4)}`;
      return verify === true
        ? { stored: true, backend: "os", check: { ok: true } }
        : { stored: true, backend: "os" };
    },
    "secrets:storeWeak": () => ({ stored: s.hasKey, backend: s.hasKey ? "os" : "memory_only" }),
    "secrets:clearApiKey": () => {
      s.hasKey = false;
    },
    "secrets:status": () => ({
      anthropic: { hasKey: s.hasKey, backend: s.hasKey ? "os" : null, hint: s.hasKey ? s.keyHint : null },
      lmstudio: { hasKey: false, backend: null, hint: null },
    }),
    // v1 main lists only Anthropic; the UI draws LM Studio as a static "Later" card.
    "providers:list": () => structuredClone(FAKE_PROVIDERS.filter((p) => p.id === "anthropic")),
    "dialog:pickFolder": async ({ purpose }) => {
      await s.sleep(300);
      if (purpose === "projects") return { path: "D:\\Maps\\Slabyrinth", valid: true };
      return { path: "D:\\SteamLibrary\\steamapps\\common\\TaleSpire", valid: true };
    },
    "providers:check": async () => {
      await s.sleep(700);
      if (!s.hasKey)
        return {
          ok: false,
          error: { kind: "auth", retryable: false, httpStatus: 401, message: "Anthropic rejected that key." },
        };
      return { ok: true };
    },
    "models:list": () => structuredClone(FAKE_MODELS),
    "shell:openExternal": () => ({ opened: true }),
    "updates:status": () => s.updateStatus(),
    "updates:check": async () => {
      await s.sleep(600);
      s.lastCheckedAt = new Date().toISOString();
      return s.updateStatus();
    },
    "updates:skip": ({ version }) => {
      s.settings = { ...s.settings, updates: { ...s.settings.updates, skippedVersion: version } };
      return s.updateStatus();
    },
  };
}
