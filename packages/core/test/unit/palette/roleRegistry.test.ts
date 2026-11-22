/**
 * The role registry (palette/roles.ts): the compiler and the review ask for palette roles through its builders and
 * constants, never by a role name typed in place, so a role cannot drift between the module that places a piece and the
 * one that checks or reviews it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundledPalettes } from "../../../src/palette";
import * as roles from "../../../src/palette/roles";

const SRC = fileURLToPath(new URL("../../../src/", import.meta.url));

/**
 * Files that still spell roles in place, each with its reason (docs/internal/code-review-senior-build.md):
 * - compile/calibration.ts: the calibration build of one palette (stone_dungeon), data about that palette.
 */
const NOT_YET: readonly string[] = ["compile/calibration.ts"];

/** The families of a building's parts (palette/roles.ts BuildingPart) and its light anchors. */
const BUILDING_FAMILIES =
  "footing|facade_post|over_door|wall_short|window|gable|gable_short|seam_ledge|crenel|parapet|corbel|chimney_top|porch_post|wall_light|sign_band|corner_pier|canopy|balcony|balcony_rail|fire_escape|wall_pipe|wall_unit|mast|finial|magic_beacon|roof_clutter|roof_terrace|gate|ruin_rubble|ruin_block|ruin_prop|ruin_growth|ruin_root|ruin_cap|ruin_tree|light";

/**
 * The role families to look for, gathered rather than listed: every family the bundled palettes use, every family a
 * builder or constant of the registry makes (a new builder's family is scanned the day it is added, `water.` too),
 * and the building parts.
 */
const PROBE = "probe";
const REGISTRY_FAMILIES = Object.values(roles as Record<string, unknown>).flatMap((v) => {
  const made = typeof v === "function" ? (v as (s: string) => unknown)(PROBE) : v;
  return typeof made === "string" && made.includes(".") ? [roles.roleFamily(made)] : [];
});
const FAMILIES = [
  ...new Set([
    ...Object.values(bundledPalettes().palettes).flatMap((p) => Object.keys(p.roles).map(roles.roleFamily)),
    ...REGISTRY_FAMILIES,
    ...BUILDING_FAMILIES.split("|"),
  ]),
]
  .filter((f) => f !== PROBE && /^[a-z_]+$/.test(f))
  .sort((a, b) => b.length - a.length);

/** A role name in a string or at the start of a template literal (`<family>.${...}`), of any family above. */
const ROLE_LITERAL = new RegExp(`["'\`](?:${FAMILIES.join("|")})\\.(?:[a-z_]+|\\$\\{)`, "g");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

describe("palette role registry", () => {
  it("compile/ and review/ name no role in place (they use palette/roles.ts)", () => {
    const found: string[] = [];
    for (const dir of ["compile", "review"])
      for (const file of sources(join(SRC, dir))) {
        const rel = relative(SRC, file).split("\\").join("/");
        if (NOT_YET.includes(rel)) continue;
        const text = readFileSync(file, "utf8")
          .split("\n")
          // comments may name a role
          .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
          .join("\n");
        for (const m of text.matchAll(ROLE_LITERAL)) found.push(`${rel}: ${m[0]}`);
      }
    expect(found).toEqual([]);
  });

  it("the scan sees a role spelled in a string or at the start of a template literal, of a builder's family", () => {
    expect(FAMILIES).toContain("water");
    const probe = (s: string): string[] => [...s.matchAll(ROLE_LITERAL)].map((m) => m[0]);
    expect(probe("lookup(t, [`water.${m}`])")).toEqual(["`water.${"]);
    expect(probe('lookup(t, ["kerb.stone"])')).toEqual(['"kerb.stone']);
    expect(probe("lookup(t, [waterRole(m)])")).toEqual([]);
  });

  it("each builder makes `<family>.<name>` and roleFamily reads the family back", () => {
    const built: Array<[string, string]> = [
      [roles.floorRole("rock"), "floor"],
      [roles.fillRole("rock"), "fill"],
      [roles.bedRole("water_deep"), "bed"],
      [roles.cliffRole("rock"), "cliff"],
      [roles.kerbRole("stone"), "kerb"],
      [roles.glowRole("lava"), "glow"],
      [roles.glowFeatureRole("lava"), "feature"],
      [roles.featureRole("chest"), "feature"],
      [roles.openingRole("door"), "opening"],
      [roles.linkRole("ladder"), "link"],
      [roles.lintelRole("wall"), "lintel"],
      [roles.postRole("wall"), "wall_post"],
      [roles.wallRole("cave_rock"), "wall"],
      [roles.stepRole("rock"), "step"],
      [roles.stairsRole("rock"), "link"],
    ];
    for (const [role, family] of built) expect(roles.roleFamily(role), role).toBe(family);
    expect(roles.isStairsRole(roles.STAIRS_ROLE)).toBe(true);
    expect(roles.isStairsRole(roles.NATURAL_STAIRS_ROLE)).toBe(true);
    expect(roles.isStairsRole(roles.stepRole("rock"))).toBe(false);
    // the names the released builds ask for
    expect([
      roles.THEME_LINTEL_ROLE,
      roles.THEME_POST_ROLE,
      roles.RUINED_WALL_ROLE,
      roles.MARKER_ROLE,
    ]).toEqual(["lintel.wall", "wall_post.wall", "wall.ruined", "marker.alignment"]);
  });
});
