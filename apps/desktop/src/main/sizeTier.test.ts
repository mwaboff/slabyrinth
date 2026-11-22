/**
 * The map size setting reaches core at each place a plan is checked: the plan port (edit and approve gates), the build
 * gate in the compile worker, the preview's plan check (shared/resolveCore.ts, which resolves once), and the setting
 * round-trips through the settings file. A saved map larger than the setting works at the size it needs.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MapPlan } from "@slabyrinth/core";
import { bundledPalettes } from "@slabyrinth/core/palette";
import { planRules, resolvePlan } from "@slabyrinth/core/resolve";
import { FIXTURE_PLAN } from "./fixturePlan";
import { nullLogger } from "./logger";
import { createCoreCompileBackend } from "./ports/compile";
import { createPlanCorePort } from "./ports/core";
import { SettingsStore } from "./services/settingsStore";
import { tempDir } from "./services/testing/helpers";
import { compute, planIssues } from "../shared/resolveCore";
import { activeSizeTier, tierAboveSetting } from "../shared/sizeTier";
import { settingsPatchSchema } from "../shared/schemas/settings";

/** FIXTURE_PLAN on a level wider than the standard 320 cells (cheap: few cells are used). */
const WIDE: MapPlan = {
  ...FIXTURE_PLAN,
  levels: FIXTURE_PLAN.levels.map((l, i) => (i === 0 ? { ...l, bounds: { ...l.bounds, w: 400 } } : l)),
};
const sizeError = (issues: ReadonlyArray<{ code: string }>): boolean =>
  issues.some((i) => i.code === "bounds_exceeded" || i.code === "limit_exceeded");

describe("the tier a project works at", () => {
  it("is the setting, raised to what the open plan needs", () => {
    expect(activeSizeTier(undefined, null)).toBe("standard");
    expect(activeSizeTier("large-768", FIXTURE_PLAN)).toBe("large-768");
    expect(activeSizeTier(undefined, WIDE)).toBe("large-512");
    expect(tierAboveSetting("standard", WIDE)).toBe("large-512");
    expect(tierAboveSetting("large-512", WIDE)).toBeNull();
  });
});

describe("the tier reaches core", () => {
  const palettes = bundledPalettes();

  it("plan port: the edit and approve gates hold the plan to the tier", () => {
    let tier: "standard" | "large-512" = "standard";
    const port = createPlanCorePort(() => planRules(palettes, { sizeTier: tier }));
    expect(sizeError(port.validatePlan(WIDE))).toBe(true);
    tier = "large-512";
    expect(sizeError(port.validatePlan(WIDE))).toBe(false);
    // a saved map larger than the setting: app.ts raises the tier to what the open plan needs
    const open = createPlanCorePort(() =>
      planRules(palettes, { sizeTier: activeSizeTier("standard", WIDE) }),
    );
    expect(sizeError(open.validatePlan(WIDE))).toBe(false);
  });

  it("compile port: the build gate refuses at the standard size, builds at the larger one", () => {
    const backend = createCoreCompileBackend();
    const input = {
      plan: WIDE,
      options: { alignment: "multi-chunk" as const },
      palettes: [],
      userPalettes: [],
      orientation: null,
      orientationOverride: null,
      availability: null,
    };
    const refused = backend.compile({ ...input, sizeTier: "standard" }, () => undefined);
    expect(refused.chunks).toEqual([]);
    expect(refused.diagnostics.map((d) => d.code)).toContain("plan_invalid");
    expect(
      backend.compile({ ...input, sizeTier: "large-512" }, () => undefined).chunks.length,
    ).toBeGreaterThan(0);
  });

  it("preview check: the tier holds, and resolving once gives the same issues", () => {
    expect(sizeError(planIssues(WIDE, palettes))).toBe(true);
    expect(sizeError(planIssues(WIDE, palettes, { sizeTier: "large-512" }))).toBe(false);
    const once = compute(
      {
        id: 1,
        plan: FIXTURE_PLAN,
        version: 1,
        options: {} as Parameters<typeof compute>[0]["options"],
        sizeTier: "standard",
      },
      palettes,
    );
    expect(once.issues).toEqual(planIssues(FIXTURE_PLAN, palettes));
    const resolved = resolvePlan(FIXTURE_PLAN, palettes);
    expect(planIssues(FIXTURE_PLAN, palettes, { resolved })).toEqual(once.issues);
    // that the check does not resolve again is counted in resolveReuse.test.ts
  });
});

describe("the setting", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
  });

  it("round-trips through the settings file; an unknown size is refused", async () => {
    const dir = await tempDir("settings-size-");
    dirs.push(dir);
    const file = path.join(dir, "settings.json");
    const make = () => new SettingsStore({ file, defaultProjectsFolder: dir, logger: nullLogger });
    const store = await make().load();
    expect(store.mapSize).toBeUndefined();
    const s = make();
    await s.load();
    await s.update({ mapSize: "large-768" });
    expect((await make().load()).mapSize).toBe("large-768");
    expect(settingsPatchSchema.safeParse({ mapSize: "large-2048" }).success).toBe(false);
  });
});
