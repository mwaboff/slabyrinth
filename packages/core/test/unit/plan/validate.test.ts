import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { MapPlan, PlanIssue, PlanIssueCode } from "../../../src/contracts/plan";
import type { PlanOp } from "../../../src/contracts/ops";
import {
  MapPlanSchema,
  PlanOpSchema,
  SCHEMA_TYPE_CHECKS,
  STRUCTURE_ONLY,
  parsePlan,
  validatePlan,
} from "../../../src/plan";
import { VALID_PLAN_FIXTURES, loadInvalidFixtures, loadPlan } from "../../fixtures";

const THEMES = ["stone_dungeon", "cave", "outdoor"];
/** This file tests validatePlan's own (structural) checks. */
const S = STRUCTURE_ONLY;

/** Codes validatePlan (WP1) emits itself; every one must have a failing fixture. */
const WP1_CODES: PlanIssueCode[] = [
  "schema",
  "id_format",
  "id_duplicate",
  "ref_unknown",
  "bounds_exceeded",
  "limit_exceeded",
  "height_step",
  "level_order",
  "shape_invalid",
  "opening_no_boundary",
  "link_mismatch",
  "area_empty",
  "theme_unknown",
  "key_duplicate",
  "stamp_unsupported",
];
/** Codes that need resolved geometry or palettes: emitted by checks registered by WP2/WP3. */
const DELEGATED_CODES: PlanIssueCode[] = [
  "opening_overlap",
  "link_blocked",
  "feature_blocked",
  "feature_overlap",
  "area_disconnected",
  "unreachable",
  "custom_unresolved",
];

describe("schema mirrors the contract", () => {
  it("inferred types are mutually assignable with the contract types", () => {
    expect(Object.values(SCHEMA_TYPE_CHECKS)).not.toContain(false);
    expectTypeOf<z.output<typeof MapPlanSchema>>().toEqualTypeOf<MapPlan>();
    // PlanOp's `set: Record<string, unknown>` is structurally (not nominally) equal: check both directions.
    expectTypeOf<z.output<typeof PlanOpSchema>>().toExtend<PlanOp>();
    expectTypeOf<PlanOp>().toExtend<z.output<typeof PlanOpSchema>>();
  });
});

describe("valid fixtures", () => {
  it.each(VALID_PLAN_FIXTURES)("%s validates with no issues", (name) => {
    const r = validatePlan(loadPlan(name), { ...S, themes: THEMES });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it("parsePlan returns an equal plan", () => {
    const plan = loadPlan("example-a");
    const r = parsePlan(plan);
    expect(r.ok && r.plan).toEqual(plan);
  });
});

describe("invalid fixtures (one per issue code, hint asserted)", () => {
  const fixtures = loadInvalidFixtures();
  it.each(fixtures.map((f) => [f.name, f] as const))("%s", (_name, fx) => {
    const r = validatePlan(fx.plan, { ...S, ...fx.context });
    for (const e of fx.expect) {
      const hit = r.issues.find((i) => i.code === e.code && i.path === e.path);
      expect(hit, `${e.code} at ${e.path} in ${JSON.stringify(r.issues)}`).toBeDefined();
      expect(hit?.severity).toBe(e.severity ?? "error");
      expect(hit?.hint).toContain(e.hintIncludes);
      expect(hit?.message.length).toBeGreaterThan(0);
    }
    if (fx.expect.every((e) => (e.severity ?? "error") === "error")) expect(r.ok).toBe(false);
    else expect(r.ok).toBe(true);
  });
  it("covers every WP1 issue code; the rest are delegated", () => {
    const covered = new Set(fixtures.flatMap((f) => f.expect.map((e) => e.code)));
    for (const c of WP1_CODES) expect(covered.has(c), c).toBe(true);
    const all: Record<PlanIssueCode, true> = Object.fromEntries(
      [...WP1_CODES, ...DELEGATED_CODES].map((c) => [c, true]),
    ) as Record<PlanIssueCode, true>;
    expect(Object.keys(all).length).toBe(WP1_CODES.length + DELEGATED_CODES.length);
  });
  it("every issue carries a hint and a JSON-pointer path", () => {
    for (const fx of fixtures) {
      for (const i of validatePlan(fx.plan, { ...S, ...fx.context }).issues) {
        expect(i.hint, `${fx.name}: ${i.message}`).toBeTruthy();
        expect(i.path === "" || i.path?.startsWith("/")).toBe(true);
      }
    }
  });
  it("issues carry element and level ids", () => {
    const fx = fixtures.find((f) => f.name === "ref-unknown-opening");
    const issue = validatePlan(fx?.plan, S).issues[0];
    expect(issue).toMatchObject({ elementId: "door1", levelId: "l1" });
  });
});

describe("other validation rules", () => {
  it("rejects non-objects and oversized plans without throwing", () => {
    expect(validatePlan(null, S).ok).toBe(false);
    expect(validatePlan(undefined, S).issues[0]?.code).toBe("schema");
    // 6000 features × ~120 bytes ≈ 700 KB > 512 KB: the size check fires before the per-level count limit.
    const big = loadPlan("single-room") as unknown as { levels: Array<{ features: unknown[] }> };
    (big.levels[0] as { features: unknown[] }).features = Array.from({ length: 6000 }, (_, k) => ({
      id: `f${k}`,
      type: "rug",
      at: [1, 1],
      notes: "q".repeat(80),
    }));
    const r = validatePlan(big, S);
    expect(r.ok).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ code: "limit_exceeded", path: "" });
    expect(r.issues[0]?.message).toMatch(/bytes; the limit is 524288/);
  });
  it("detects the diagonal path in the architecture's example B as written", () => {
    const fx = loadInvalidFixtures().find((f) => f.name === "shape-diagonal-path");
    expect(validatePlan(fx?.plan, S).ok).toBe(false);
  });
  it("route endpoints may not be routes; opening needs between or at", () => {
    const plan = loadPlan("l-corridor-route");
    plan.levels[0]?.areas.push({
      id: "spur",
      kind: "corridor",
      shape: { type: "route", from: "hall", to: [10, 2] },
    });
    plan.levels[0]?.openings.push({ id: "o1", kind: "door" });
    const codes = validatePlan(plan, S).issues.map((i) => [i.code, i.path]);
    expect(codes).toContainEqual(["shape_invalid", "/levels/0/areas/3/shape/from"]);
    expect(codes).toContainEqual(["schema", "/levels/0/openings/0"]);
  });
  it("link rules: pit_drop and ladder arrive above their start; same-level links are rejected", () => {
    const plan = loadPlan("multi-level-stairs");
    plan.links.push({
      id: "drop",
      kind: "pit_drop",
      from: { level: "ground", at: [3, 3] },
      to: { level: "study_lvl", at: [3, 3] },
    });
    expect(validatePlan(plan, S).ok).toBe(true);
    plan.links.push({
      id: "bad",
      kind: "ladder",
      from: { level: "ground", at: [3, 4] },
      to: { level: "ground" },
    });
    expect(validatePlan(plan, S).issues.find((i) => i.elementId === "bad")?.code).toBe("link_mismatch");
  });
});

describe("checks the caller passes in (the resolver's, from a higher layer)", () => {
  const geometric = (code: PlanIssueCode) => ({
    name: `test-${code}`,
    run: (plan: MapPlan): PlanIssue[] => [
      { severity: "error", code, message: `fake ${code} on ${plan.title}`, hint: "do something" },
    ],
  });

  it("runs the given checks on structurally valid plans only, in the given order", () => {
    const checks = [geometric("unreachable"), geometric("feature_blocked")];
    const r = validatePlan(loadPlan("single-room"), { checks });
    expect(r.issues.map((i) => i.code)).toEqual(["unreachable", "feature_blocked"]);
    const bad = loadPlan("single-room");
    (bad.levels[0]?.features[0] as { id: string }).id = "cellar";
    expect(validatePlan(bad, { checks }).issues.map((i) => i.code)).toEqual(["id_duplicate"]);
    expect(validatePlan(loadPlan("single-room"), S).issues).toEqual([]);
  });
  it("a check given to one call does not reach the next", () => {
    expect(validatePlan(loadPlan("single-room"), { checks: [geometric("custom_unresolved")] }).ok).toBe(
      false,
    );
    expect(validatePlan(loadPlan("single-room"), S).ok).toBe(true);
  });
});
