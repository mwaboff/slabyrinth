/**
 * Integration over WP1's fixture plans with WP2's resolver (architecture §8.3 WP3 acceptance): compiling from the
 * bundled palettes alone (no catalog) gives no errors; output is deterministic; every chunk is ≤ 24.5 KB and all
 * chunks of a build share one bounding box. Property assertions rather than placement snapshots while the
 * resolver is still settling.
 */
import { describe, expect, it } from "vitest";
import { compileResolved, createCompilePlan } from "../../../src/compile";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { decodeDetailed, slabCodec } from "../../../src/slab";
import { VALID_PLAN_FIXTURES, loadPlan } from "../../fixtures";

const cat = loadPalettes();
const marker = cat.palettes["generic"]?.roles["marker.alignment"]?.variants[0]?.asset ?? "";

/**
 * Known build errors pending another engineer's fix, by fixture name. Empty: the cave_rock wall-gap case was
 * resolved by the resolver rule of 2026-11-18 (no wall between two open full-cell-rock-style cells).
 */
const KNOWN_ERRORS: Partial<Record<string, string[]>> = {};

describe.each(VALID_PLAN_FIXTURES)("compile fixture %s", (name) => {
  const plan = loadPlan(name);
  const resolved = resolvePlan(plan, bundledPalettes());
  const bundle = compileResolved(resolved, cat, slabCodec, { createdAt: "t", plan });

  it("compiles from bundled palettes with no errors (except known, routed ones)", () => {
    const known = KNOWN_ERRORS[name] ?? [];
    expect(bundle.diagnostics.filter((d) => d.severity === "error" && !known.includes(d.code))).toEqual([]);
    expect(bundle.chunks.length).toBeGreaterThan(0);
    expect(bundle.assetSource).toBe("builtin");
  });

  it("every chunk ≤ 24.5 KB, decodes, and all chunks share one bounding box", () => {
    const boxes = new Set<string>();
    for (const c of bundle.chunks) {
      expect(c.compressedBytes).toBeLessThanOrEqual(0.8 * 30720);
      const a = decodeDetailed(c.slab).assets;
      expect(a).toHaveLength(c.assetCount);
      if (c.hasAlignmentMarkers) expect(a.filter((x) => x.uuid === marker)).toHaveLength(2);
      boxes.add(
        JSON.stringify(
          ["sx", "sy", "sz"].map((k) => [
            Math.min(...a.map((x) => x[k as "sx"])),
            Math.max(...a.map((x) => x[k as "sx"])),
          ]),
        ),
      );
    }
    if (bundle.chunks.length > 1) expect(boxes.size).toBe(1);
  });

  it("is deterministic", () => {
    expect(compileResolved(resolvePlan(loadPlan(name), bundledPalettes()), cat, slabCodec, { createdAt: "t", plan })).toEqual(
      bundle,
    );
  });
});

describe("createCompilePlan (validate → resolve → realize → chunk → encode)", () => {
  it("compiles a plan end to end and refuses invalid plans with plan_invalid", () => {
    const compilePlan = createCompilePlan({
      resolvePlan,
      validatePlan: (p) =>
        p.title === "bad"
          ? { ok: false, issues: [{ severity: "error", code: "schema", message: "broken", levelId: "l1" }] }
          : { ok: true, issues: [] },
    });
    const ok = compilePlan(loadPlan("single-room"), cat, slabCodec);
    expect(ok.chunks).toHaveLength(1);
    const bad = compilePlan({ ...loadPlan("single-room"), title: "bad" }, cat, slabCodec);
    expect(bad.chunks).toEqual([]);
    expect(bad.diagnostics[0]).toMatchObject({ code: "plan_invalid", severity: "error", stage: "validate" });
  });
});
