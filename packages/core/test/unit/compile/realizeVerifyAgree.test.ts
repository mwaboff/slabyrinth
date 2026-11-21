/**
 * Realize and verify agree: verify of an untouched realize finds nothing wrong with what realize built. They ask the
 * palette the same question (palette/planRoles.ts: the plan's generator, theme fallback, default theme) and read the
 * same per-level facts (compile/buildFacts.ts), so a wall realize builds is judged by the piece it was built from.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CompileDiagnosticCode } from "../../../src/contracts/compiler";
import { GENERATOR_VERSIONS, type GeneratorVersion } from "../../../src/contracts/plan";
import { realize } from "../../../src/compile";
import { verifyBuild } from "../../../src/compile/verify/verify";
import { createVerifyCtx } from "../../../src/compile/verify/context";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { createPlanRoles, defaultThemeOf } from "../../../src/palette/planRoles";
import { resolvePlan } from "../../../src/resolve";
import { loadPlan, STORED_PLANS } from "../../fixtures";
import { handLevel, handPlan } from "./handResolved";

/** What realize alone decides: a floor under every floor top, wall pieces along every wall edge. */
const BUILT: readonly CompileDiagnosticCode[] = ["verify_floor_missing", "verify_wall_gap"];

const cat = loadPalettes();

describe("realize and verify agree", () => {
  it("every stored plan, at its own generator: verify of an untouched realize has no error", () => {
    const pal = bundledPalettes();
    for (const name of STORED_PLANS) {
      const plan = loadPlan(name);
      const r = resolvePlan(plan, pal);
      const set = realize(r, pal);
      const errors = verifyBuild(r, set, pal, { plan }).diagnostics.filter((d) => d.severity === "error");
      expect(
        errors.map((d) => `${d.code} ${d.message}`),
        name,
      ).toEqual([]);
    }
  });

  it("random hand levels, every generator and theme (one with no palette): no wall or floor the build left open", () => {
    const themes = [...Object.keys(cat.palettes), "no_such_theme"];
    const row = fc
      .array(fc.constantFrom("#", "#", ".", ".", ".", "1", "2", "4"), { minLength: 6, maxLength: 9 })
      .map((cells) => cells.join(""));
    fc.assert(
      fc.property(
        fc.array(row, { minLength: 4, maxLength: 7 }),
        fc.constantFrom(...themes),
        fc.constantFrom(...GENERATOR_VERSIONS),
        (rows, theme, generator: GeneratorVersion) => {
          // a solid frame around the random interior, so every open cell has a wall cell to stand a block in
          const w = Math.max(...rows.map((r) => r.length));
          const framed = ["#".repeat(w + 2), ...rows.map((r) => `#${r.padEnd(w, "#")}#`), "#".repeat(w + 2)];
          const r = { ...handPlan([handLevel({ id: "l1", rows: framed, theme })]), generator };
          const set = realize(r, cat);
          const found = verifyBuild(r, set, cat).diagnostics.filter(
            (d) => d.severity === "error" && BUILT.includes(d.code),
          );
          expect(found.map((d) => `${d.code} ${d.message}`)).toEqual([]);
        },
      ),
      { numRuns: 60, seed: 4242 },
    );
  });

  it("verify judges by the facts realize built from: the set's own role answers, grids and faces", () => {
    const r = handPlan([handLevel({ id: "l1", rows: ["####", "#..#", "####"] })]);
    const set = realize(r, cat);
    const ctx = createVerifyCtx(r, set, cat, {});
    expect(ctx.facts).toBe(set.facts);
    expect(ctx.grids.get("l1")).toBe(set.facts.of(r.levels[0] as never).grid);
    // a set realized for another resolved plan does not lend its facts
    const other = { ...r, levels: r.levels.map((l) => ({ ...l })) };
    expect(createVerifyCtx(other, set, cat, {}).facts).not.toBe(set.facts);
  });

  it("verify hides the roles the plan's generator does not have, as realize does", () => {
    const g3 = {
      ...handPlan([handLevel({ id: "l1", rows: ["####", "#..#", "####"] })]),
      generator: 3 as const,
    };
    const ctx = createVerifyCtx(g3, realize(g3, cat), cat, {});
    // the default roof cap is a generator-4 role (palette minGenerator)
    expect(ctx.resolveRole("generic", "roof.default.cap").resolution).toBeNull();
    expect(createPlanRoles(cat, 4).resolve("generic", "roof.default.cap").resolution).not.toBeNull();
  });

  it("a theme with no palette is asked as the default theme, by realize and verify alike", () => {
    const roles = createPlanRoles(cat, 4);
    expect(roles.defaultTheme).toBe(defaultThemeOf(cat));
    expect(roles.paletteTheme("no_such_theme")).toBe(roles.defaultTheme);
    expect(roles.resolve("no_such_theme", "wall.wall")).toBe(roles.resolve(roles.defaultTheme, "wall.wall"));
    // a catalog without `generic` falls back to its first palette
    const first = Object.keys(cat.palettes).find((id) => id !== "generic") ?? "";
    const noGeneric = {
      ...cat,
      palettes: Object.fromEntries(Object.entries(cat.palettes).filter(([id]) => id !== "generic")),
    };
    expect(defaultThemeOf(noGeneric)).toBe(first);
  });
});
