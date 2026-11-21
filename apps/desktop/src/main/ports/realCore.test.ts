import { describe, expect, it } from "vitest";
import { slabCodec } from "@slabyrinth/core/slab";
import { FIXTURE_PLAN } from "../fixturePlan";
import { doorPlan } from "../services/testing/fixtures";
import { BUNDLED_RULES } from "../services/testing/helpers";
import { createCoreCatalogReader } from "./catalog";
import { createCoreCompileBackend, type CompileInput } from "./compile";
import { createPlanCorePort } from "./core";

/**
 * Integration with the REAL @slabyrinth/core (plan, compiler, catalog) through the shell's ports.
 */
describe("real core wiring", () => {
  it("plan port uses core applyOps / validatePlan / diffPlans / migrateProject", () => {
    const port = createPlanCorePort(() => BUNDLED_RULES);
    const issues = port.validatePlan(FIXTURE_PLAN);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const r = port.applyOps(FIXTURE_PLAN, [{ op: "update", id: "tomb", set: { notes: "Real core" } }]);
    expect(r.ok).toBe(true);
    const migrated = port.migrateProject({
      format: "slabyrinth/project@1",
      formatVersion: 1,
      plan: null,
      history: { versions: [] },
    });
    expect(migrated).toMatchObject({ formatVersion: 1 });
  });

  it("compile backend: FIXTURE_PLAN compiles to slabs that decode", () => {
    const backend = createCoreCompileBackend();
    expect(backend.kind).toBe("core");
    const input: CompileInput = {
      plan: FIXTURE_PLAN,
      options: { alignment: "multi-chunk" },
      palettes: [],
      userPalettes: [],
      orientation: null,
      orientationOverride: null,
      availability: null,
    };
    const stages: string[] = [];
    const bundle = backend.compile(input, (s) => stages.push(s));
    expect(bundle.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(bundle.chunks.length).toBeGreaterThanOrEqual(1);
    const first = bundle.chunks[0];
    expect(first && slabCodec.decode(first.slab).assets.length).toBeGreaterThan(0);
    expect(stages[0]).toBe("resolve");
    const est = backend.estimate(input);
    expect(est.totalAssets).toBeGreaterThan(0);
  });

  it("catalog reader uses core's binary index (primary) and index.json sources", () => {
    const reader = createCoreCatalogReader();
    expect(reader.kind).toBe("core");
    const json = new TextEncoder().encode(
      JSON.stringify({
        Name: "Pack",
        Tiles: [
          {
            Id: "11111111-1111-4111-8111-111111111111",
            Name: "Wall",
            IsDeprecated: false,
            GroupTag: "wall",
            Tags: [],
            Folder: "Dungeon",
            Assets: [],
            IsInteractable: false,
            ColliderBoundsBound: { m_Center: { x: 0.5, y: 1, z: 0.25 }, m_Extent: { x: 0.5, y: 1, z: 0.25 } },
          },
        ],
        Props: [],
        Creatures: [],
      }),
    );
    const r = reader.readPack({ packId: "p", dirName: "p" }, [{ name: "index.json", bytes: json }]);
    expect(r.source).toBe("index-json");
    expect(r.assets.map((a) => a.name)).toEqual(["Wall"]);
  });

  it("a plan-level playability error does not refuse the build, and verify does not repeat it", () => {
    const backend = createCoreCompileBackend();
    const input: CompileInput = {
      plan: doorPlan([7, 3]), // opening_blocked (playability, error severity)
      options: {},
      palettes: [],
      userPalettes: [],
      orientation: null,
      orientationOverride: null,
      availability: null,
    };
    const bundle = backend.compile(input, () => undefined);
    expect(bundle.diagnostics.filter((d) => d.stage === "validate")).toEqual([]);
    expect(bundle.chunks.length).toBeGreaterThanOrEqual(1);
    const repeated = (ds: Array<{ code: string; elementId?: string }>): unknown[] =>
      ds.filter(
        (d) =>
          (d.code === "verify_door_blocked" || d.code === "verify_door_leads_nowhere") &&
          d.elementId === "d1",
      );
    expect(repeated(bundle.diagnostics)).toEqual([]);
    expect(repeated(backend.estimate(input).diagnostics)).toEqual([]);
  });

  it("a blocking plan error still refuses the build", () => {
    const plan = doorPlan([7, 2]);
    const level = plan.levels[0];
    if (level) level.openings.push({ id: "d2", kind: "door", between: ["entry", "ghost"] });
    const bundle = createCoreCompileBackend().compile(
      {
        plan,
        options: {},
        palettes: [],
        userPalettes: [],
        orientation: null,
        orientationOverride: null,
        availability: null,
      },
      () => undefined,
    );
    expect(bundle.chunks).toEqual([]);
    expect(bundle.diagnostics.some((d) => d.stage === "validate" && d.severity === "error")).toBe(true);
  });
});
