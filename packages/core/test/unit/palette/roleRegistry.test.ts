/**
 * The role registry (palette/roles.ts): the compiler and the review ask for palette roles through its builders and
 * constants, never by a role name typed in place, so a role cannot drift between the module that places a piece and the
 * one that checks or reviews it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as roles from "../../../src/palette/roles";

const SRC = fileURLToPath(new URL("../../../src/", import.meta.url));

/**
 * Files that still spell roles in place, each with its reason (docs/internal/code-review-senior-build.md):
 * - compile/structure.ts: the building realizer, to be split onto realize's primitives (finding M2);
 * - compile/calibration.ts: the calibration build of one palette (stone_dungeon), data about that palette.
 */
const NOT_YET: readonly string[] = ["compile/structure.ts", "compile/calibration.ts"];

/** A role name in a string or the start of a template: `<family>.<name>` of a role family the palettes use. */
const ROLE_LITERAL =
  /["'`](?:wall|wall_post|floor|fill|bed|opening|lintel|kerb|cliff|cap|roof|feature|marker|stall|link|ledge|facade|glow|step|ruin_climber)\.(?:[a-z_]+|\$\{)/g;

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
