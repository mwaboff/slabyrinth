import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MapPlan, PlanIssue } from "../../../src/contracts/plan";
import { applyChecked } from "../../../src/ops/gate";
import { PLAYABILITY_CODES, planGate } from "../../../src/plan/gate";
import { STRUCTURAL_RULES } from "../../fixtures/rules";

const issue = (severity: PlanIssue["severity"], code: PlanIssue["code"]): PlanIssue => ({
  severity,
  code,
  message: `${severity} ${code}`,
});

describe("planGate: one rule for edit, approve and build", () => {
  const structural = issue("error", "ref_unknown");
  const playError = issue("error", "opening_blocked");
  const unreachableWarning = issue("warning", "unreachable");
  const warning = issue("warning", "feature_overlap");
  const note = issue("info", "reachable_secret_only");
  const all = [structural, playError, unreachableWarning, warning, note];

  it("edit and build block structural errors only and report the rest by severity", () => {
    for (const purpose of ["edit", "build"] as const) {
      const g = planGate(all, purpose);
      expect(g.blocking).toEqual([structural]);
      expect(g.checks).toEqual({
        errors: [playError],
        warnings: [unreachableWarning, warning],
        info: [note],
      });
    }
  });

  it("approve also blocks playability errors and every unreachable finding", () => {
    const g = planGate(all, "approve");
    expect(g.blocking).toEqual([structural, playError, unreachableWarning]);
    expect(g.checks).toEqual({ errors: [], warnings: [warning], info: [note] });
  });

  it("approve is never more lenient than edit (every edit-blocking issue blocks approval)", () => {
    const codes: PlanIssue["code"][] = [...PLAYABILITY_CODES, "ref_unknown", "feature_overlap", "schema"];
    for (const code of codes)
      for (const severity of ["error", "warning", "info"] as const) {
        const i = issue(severity, code);
        if (planGate([i], "edit").blocking.length > 0) expect(planGate([i], "approve").blocking).toEqual([i]);
      }
  });
});

describe("applyChecked: the edit gate after an unvalidated apply", () => {
  const plan = JSON.parse(
    readFileSync(new URL("../../fixtures/plans/example-a.json", import.meta.url), "utf8"),
  ) as MapPlan;
  const level = plan.levels[0]?.id ?? "";

  it("op errors fail; a valid edit is applied", () => {
    const bad = applyChecked(plan, [{ op: "update", id: "nope", set: { name: "x" } }], STRUCTURAL_RULES);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.opErrors.length).toBeGreaterThan(0);
    const good = applyChecked(plan, [{ op: "update", id: level, set: { name: "Cellar" } }], STRUCTURAL_RULES);
    expect(good.ok).toBe(true);
  });
});
