import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nullLogger } from "../logger";
import { settingsPatchSchema } from "../../shared/schemas/settings";
import { AGENT_DEFAULTS } from "../../shared/agentSettings";
import { SettingsStore, defaultSettings } from "./settingsStore";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "slab-settings-"));
  file = path.join(dir, "settings.json");
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const make = (): SettingsStore =>
  new SettingsStore({ file, defaultProjectsFolder: path.join(dir, "Projects"), logger: nullLogger });

describe("SettingsStore", () => {
  it("defaults follow docs/decisions.md", async () => {
    const s = await make().load();
    expect(s.ui.theme).toBe("system");
    expect(s.ui.onLaunch).toBe("home");
    expect(s.defaultSelection).toEqual({
      providerId: "anthropic",
      modelId: "claude-opus-5-5",
      effort: "medium",
    });
    expect(s.spending.perActionWarnUsd).toBe(1);
    expect(s.spending.perProjectWarnUsd).toBe(10);
    expect(s.projects.folder).toBe(path.join(dir, "Projects"));
  });

  it("merges nested patches, persists, and notifies", async () => {
    const store = make();
    await store.load();
    const seen: string[] = [];
    store.onChange((s) => seen.push(s.ui.theme));
    await store.update(
      settingsPatchSchema.parse({ ui: { theme: "light" }, spending: { perActionWarnUsd: 0.25 } }),
    );
    expect(store.get().ui.onLaunch).toBe("home");
    expect(store.get().ui.theme).toBe("light");
    expect(seen).toEqual(["light"]);
    const reloaded = await make().load();
    expect(reloaded.ui.theme).toBe("light");
    expect(reloaded.spending.perActionWarnUsd).toBe(0.25);
  });

  it("rejects renderer writes to main-owned fields", () => {
    expect(settingsPatchSchema.safeParse({ schema: "x" }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ spending: { allTime: {} } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ talespire: { installPath: "C:/x" } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ projects: { recent: [] } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ ui: { theme: "neon" } }).success).toBe(false);
  });

  it("migrates settings files written before the update notice existed", async () => {
    const store = make();
    const old = await store.load();
    const withoutUpdates: Partial<typeof old> = { ...old };
    delete withoutUpdates.updates;
    await fsp.writeFile(
      file,
      JSON.stringify({ ...withoutUpdates, smartEffort: false, setupCompleted: true }),
    );
    const s = await make().load();
    expect(s.updates).toEqual({ autoCheck: true });
    expect(s.smartEffort).toBe(false);
    expect(s.setupCompleted).toBe(true);
    // An invalid updates block falls back to the default; the rest is kept.
    await fsp.writeFile(
      file,
      JSON.stringify({ ...withoutUpdates, setupCompleted: true, updates: { autoCheck: "sometimes" } }),
    );
    const s2 = await make().load();
    expect(s2.updates).toEqual({ autoCheck: true });
    expect(s2.setupCompleted).toBe(true);
    // Valid values survive a round trip; the renderer may change only autoCheck.
    await fsp.writeFile(
      file,
      JSON.stringify({
        ...withoutUpdates,
        updates: { autoCheck: false, skippedVersion: "0.2.0", lastCheckedAt: "2026-11-30T09:00:00.000Z" },
      }),
    );
    const s3 = make();
    expect((await s3.load()).updates).toEqual({
      autoCheck: false,
      skippedVersion: "0.2.0",
      lastCheckedAt: "2026-11-30T09:00:00.000Z",
    });
    expect((await s3.update({ updates: { autoCheck: true } })).updates).toEqual({
      autoCheck: true,
      skippedVersion: "0.2.0",
      lastCheckedAt: "2026-11-30T09:00:00.000Z",
    });
    expect(settingsPatchSchema.safeParse({ updates: { skippedVersion: "9.9.9" } }).success).toBe(false);
  });

  it("repairs invalid fields and survives a corrupt file", async () => {
    await fsp.writeFile(file, JSON.stringify({ ui: { theme: "neon" }, smartEffort: false }));
    const s = await make().load();
    expect(s.ui.theme).toBe("system");
    expect(s.smartEffort).toBe(false);
    await fsp.writeFile(file, "{not json");
    const s2 = await make().load();
    expect(s2.ui.theme).toBe("system");
    expect((await fsp.readdir(dir)).some((n) => n.endsWith(".corrupt"))).toBe(true);
  });

  it("keeps a ≤ 10 recent list, most recent first, and main-only feature flags", async () => {
    const store = make();
    await store.load();
    for (let i = 0; i < 12; i++) await store.touchRecent(path.join(dir, `${String(i)}.slabyrinth`));
    await store.touchRecent(path.join(dir, "5.slabyrinth"));
    const recent = store.get().projects.recent;
    expect(recent).toHaveLength(10);
    expect(recent[0]).toBe(path.join(dir, "5.slabyrinth"));
    expect(store.flag("debugLogging")).toBe(false);
    await store.setFlag("debugLogging", true);
    const again = make();
    await again.load();
    expect(again.flag("debugLogging")).toBe(true);
    expect(JSON.stringify(again.get())).not.toContain("x-featureFlags");
  });

  describe("the agent group (Changes per message, 3D pictures)", () => {
    it("a settings file from before the group loads unchanged, with the defaults filled in", async () => {
      const old = { ...defaultSettings(path.join(dir, "Projects")) } as Record<string, unknown>;
      delete old["agent"];
      old["ui"] = { theme: "light", mapThemeId: "auto", gridVisible: false, onLaunch: "home" };
      await fsp.writeFile(file, JSON.stringify(old));
      const s = await make().load();
      expect(s.agent).toEqual({ maxRevisionsPerTurn: 4, view3d: true, maxPicturesPerTurn: 6 });
      expect(s.agent).toEqual(AGENT_DEFAULTS);
      expect(s.ui.theme).toBe("light");
      expect(s.ui.gridVisible).toBe(false);
    });

    it("a partial or out-of-range group is repaired to the defaults, field by field where it can", async () => {
      const base = defaultSettings(path.join(dir, "Projects"));
      await fsp.writeFile(file, JSON.stringify({ ...base, agent: { maxRevisionsPerTurn: 7 } }));
      expect((await make().load()).agent).toEqual({
        maxRevisionsPerTurn: 7,
        view3d: true,
        maxPicturesPerTurn: 6,
      });
      await fsp.writeFile(
        file,
        JSON.stringify({ ...base, agent: { maxRevisionsPerTurn: 99, view3d: false } }),
      );
      const repaired = await make().load();
      expect(repaired.agent).toEqual(AGENT_DEFAULTS);
      expect(repaired.ui).toEqual(base.ui);
    });

    it("saves a patch of one field, keeps the others, and refuses out-of-range values", async () => {
      const store = make();
      await store.load();
      await store.update(settingsPatchSchema.parse({ agent: { maxRevisionsPerTurn: 9 } }));
      expect(store.get().agent).toEqual({ ...AGENT_DEFAULTS, maxRevisionsPerTurn: 9 });
      expect((await make().load()).agent?.maxRevisionsPerTurn).toBe(9);
      for (const bad of [0, 21, 2.5, "4"])
        expect(settingsPatchSchema.safeParse({ agent: { maxRevisionsPerTurn: bad } }).success).toBe(false);
      expect(settingsPatchSchema.safeParse({ agent: { maxPicturesPerTurn: 13 } }).success).toBe(false);
      expect(settingsPatchSchema.safeParse({ agent: { other: 1 } }).success).toBe(false);
      // every field is the GM's: the whole stored group spread into a patch is accepted (the 0.3.0 failure cannot happen)
      expect(settingsPatchSchema.safeParse({ agent: { ...store.get().agent, view3d: false } }).success).toBe(
        true,
      );
    });
  });

  it("accumulates all-time spend", async () => {
    const store = make();
    await store.load();
    await store.addSpend(
      { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0 },
      { currency: "USD", amount: 0.5, estimated: true },
    );
    await store.addSpend({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0 }, null);
    expect(store.get().spending.allTime.usage.inputTokens).toBe(20);
    expect(store.get().spending.allTime.cost?.amount).toBe(0.5);
  });
});
