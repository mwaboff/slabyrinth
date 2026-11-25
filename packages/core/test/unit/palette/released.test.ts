import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NULL_AVAILABILITY } from "../../../src/catalog/availability";
import { BUNDLED_PALETTES, createRoleResolver, mergePalettes, resolveRole } from "../../../src/palette";

/**
 * Released generators are frozen, so the bundled palettes must keep resolving for them exactly as they did in the
 * release. The fixture pins, per theme, role → first-choice piece (8-char uuid prefix) as resolved from the 0.1.2
 * palette files (git show v0.1.2:packages/core/data/palettes/*.json); a role missing from a theme did not resolve.
 * A role or piece added later must carry `minGenerator` (import-palette-draft.ts ROLE_MIN_GENERATOR) so that
 * generators 1 and 2 never see it. Never regenerate this fixture to make the test pass.
 */
const released = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../fixtures/released-palettes-0.1.2.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, Record<string, string>>;

const { palettes } = mergePalettes(BUNDLED_PALETTES);
const cat = { palettes, availability: NULL_AVAILABILITY };

describe("released palettes (generator 2 is frozen)", () => {
  it("every theme and role resolves for generators 1 and 2 as it did in 0.1.2", () => {
    expect(Object.keys(palettes).sort()).toEqual(Object.keys(released).sort());
    const roles = [
      ...new Set([
        ...Object.values(palettes).flatMap((p) => Object.keys(p.roles)),
        ...Object.values(released).flatMap((r) => Object.keys(r)),
      ]),
    ].sort();
    for (const generator of [1, 2]) {
      const resolve = createRoleResolver(cat, generator);
      for (const theme of Object.keys(released)) {
        const now: Record<string, string> = {};
        for (const role of roles) {
          const v = resolve(theme, role).resolution?.variants[0];
          if (v) now[role] = v.uuid.slice(0, 8);
        }
        expect(now, `${theme} @ generator ${generator}`).toEqual(released[theme]);
      }
    }
  });

  it("every theme and role resolves for generator 3 as it did in 0.2.0 (generator 3 is frozen)", () => {
    // test/fixtures/released-palettes-0.2.0.json: first-choice piece per role as generator 3 sees the palettes in
    // 0.2.0. A role or piece added later must carry `minGenerator: 4` (and generator 4 must be opened first).
    const released3 = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../fixtures/released-palettes-0.2.0.json", import.meta.url)),
        "utf8",
      ),
    ) as Record<string, Record<string, string>>;
    expect(Object.keys(palettes).sort()).toEqual(Object.keys(released3).sort());
    const roles = [
      ...new Set([
        ...Object.values(palettes).flatMap((p) => Object.keys(p.roles)),
        ...Object.values(released3).flatMap((r) => Object.keys(r)),
      ]),
    ].sort();
    const resolve = createRoleResolver(cat, 3);
    for (const theme of Object.keys(released3)) {
      const now: Record<string, string> = {};
      for (const role of roles) {
        const v = resolve(theme, role).resolution?.variants[0];
        if (v) now[role] = v.uuid.slice(0, 8);
      }
      expect(now, `${theme} @ generator 3`).toEqual(released3[theme]);
    }
  });

  it("every theme and role resolves for generator 4 as it did in 0.3.0 (generator 4 is frozen)", () => {
    // test/fixtures/released-palettes-0.3.0.json: first-choice piece per role as generator 4 sees the palettes in
    // 0.3.0. A role or piece added later must carry `minGenerator: 5`.
    const released4 = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../fixtures/released-palettes-0.3.0.json", import.meta.url)),
        "utf8",
      ),
    ) as Record<string, Record<string, string>>;
    expect(Object.keys(palettes).sort()).toEqual(Object.keys(released4).sort());
    const roles = [
      ...new Set([
        ...Object.values(palettes).flatMap((p) => Object.keys(p.roles)),
        ...Object.values(released4).flatMap((r) => Object.keys(r)),
      ]),
    ].sort();
    const resolve = createRoleResolver(cat, 4);
    for (const theme of Object.keys(released4)) {
      const now: Record<string, string> = {};
      for (const role of roles) {
        const v = resolve(theme, role).resolution?.variants[0];
        if (v) now[role] = v.uuid.slice(0, 8);
      }
      expect(now, `${theme} @ generator 4`).toEqual(released4[theme]);
    }
  });

  it("every theme and role resolves for generator 5 as it did in 0.4.0 (generator 5 is frozen)", () => {
    // test/fixtures/released-palettes-0.4.0.json: first-choice piece per role as generator 5 sees the palettes in
    // 0.4.0. A role or piece added later must carry `minGenerator: 6`.
    const released5 = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../fixtures/released-palettes-0.4.0.json", import.meta.url)),
        "utf8",
      ),
    ) as Record<string, Record<string, string>>;
    expect(Object.keys(palettes).sort()).toEqual(Object.keys(released5).sort());
    const roles = [
      ...new Set([
        ...Object.values(palettes).flatMap((p) => Object.keys(p.roles)),
        ...Object.values(released5).flatMap((r) => Object.keys(r)),
      ]),
    ].sort();
    const resolve = createRoleResolver(cat, 5);
    for (const theme of Object.keys(released5)) {
      const now: Record<string, string> = {};
      for (const role of roles) {
        const v = resolve(theme, role).resolution?.variants[0];
        if (v) now[role] = v.uuid.slice(0, 8);
      }
      expect(now, `${theme} @ generator 5`).toEqual(released5[theme]);
    }
  });

  it("minGenerator hides a role from older generators and lets newer ones use it", () => {
    for (const role of ["fill.rock", "cliff.rock_block"]) {
      expect(palettes["generic"]?.roles[role]?.minGenerator, role).toBe(3);
      expect(resolveRole(cat, "forest", role, undefined, 2).resolution, `${role} @2`).toBeNull();
      expect(resolveRole(cat, "forest", role, undefined, 3).resolution?.role, `${role} @3`).toBe(role);
      expect(resolveRole(cat, "forest", role).resolution?.role, `${role} unversioned`).toBe(role);
    }
  });
});
