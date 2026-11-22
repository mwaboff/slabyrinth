import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AssetAvailability, PaletteCatalog } from "../../../src/contracts/compiler";
import {
  BUNDLED_ORIENTATION,
  BUNDLED_PALETTES,
  loadOrientation,
  loadPalettes,
  mergePalettes,
  resolveRole,
  themeChain,
} from "../../../src/palette";

const dataDir = fileURLToPath(new URL("../../../data/", import.meta.url));
const ids = {
  wall1: "63270c8a-9484-4ae8-926e-22e3de9048a1", // Dungeon Wall 01
};

function availability(missing: string[], deprecated: string[] = []): AssetAvailability {
  return {
    status: (u) =>
      missing.includes(u.toLowerCase())
        ? "missing"
        : deprecated.includes(u.toLowerCase())
          ? "deprecated"
          : "present",
    name: () => null,
    search: () => [],
  };
}

describe("bundled palette data", () => {
  it("bundled.ts is an exact copy of data/palettes/*.json and data/orientation.json", () => {
    const files = readdirSync(`${dataDir}palettes`)
      .filter((f) => f.endsWith(".json"))
      .sort();
    expect(files).toEqual([
      "cave.json",
      "city.json",
      "forest.json",
      "generic.json",
      "outdoor.json",
      "stone_dungeon.json",
      "wood_town.json",
    ]);
    const fromFiles = files.map(
      (f) => JSON.parse(readFileSync(`${dataDir}palettes/${f}`, "utf8")) as { id: string },
    );
    const byId = (a: readonly unknown[]): unknown[] =>
      [...a].sort((x, y) => ((x as { id: string }).id < (y as { id: string }).id ? -1 : 1));
    expect(byId(BUNDLED_PALETTES)).toEqual(byId(fromFiles));
    expect(BUNDLED_ORIENTATION).toEqual(JSON.parse(readFileSync(`${dataDir}orientation.json`, "utf8")));
  });

  it("all bundled palettes validate, extend generic, and only reference geometry they carry", () => {
    const { palettes, issues } = mergePalettes(BUNDLED_PALETTES);
    expect(issues).toEqual([]);
    expect(Object.keys(palettes).sort()).toEqual([
      "cave",
      "city",
      "forest",
      "generic",
      "outdoor",
      "stone_dungeon",
      "wood_town",
    ]);
    let uuids = 0;
    for (const p of Object.values(palettes)) {
      // every theme reaches generic (forest extends outdoor, which extends generic)
      if (p.id !== "generic")
        expect(p.extends === "generic" || palettes[p.extends ?? ""]?.extends === "generic").toBe(true);
      for (const [role, def] of Object.entries(p.roles)) {
        if (def.variants.length === 0) expect(def.fallback, role).toBeTruthy();
        for (const v of def.variants) {
          uuids++;
          for (const a of v.alternates ?? [])
            expect(v.alternateGeom?.[a], `${role} alternate ${a}`).toBeDefined();
        }
      }
    }
    expect(uuids).toBeGreaterThan(100);
  });

  it("orientation.json pins the conventions verified in game", () => {
    const { orientation } = loadOrientation();
    expect(orientation.flipZ).toBe(true);
    expect(orientation.rotSense).toBe(1);
    expect(orientation.edgePlacement).toEqual({
      N: { rotSteps: [0, 12], offset: { x: 0, z: 0.5 } },
      E: { rotSteps: [6, 18], offset: { x: 0.5, z: 0 } },
      S: { rotSteps: [0, 12], offset: { x: 0, z: 0 } },
      W: { rotSteps: [6, 18], offset: { x: 0, z: 0 } },
    });
    expect(orientation.defaultFacing["feature"]?.front).toBe("N");
    expect(orientation.verified.length).toBeGreaterThanOrEqual(6);
    expect(loadOrientation({ schema: "nope" }).issues).toHaveLength(1);
  });
});

describe("role resolution and the fallback chain", () => {
  const cat = loadPalettes();

  it("direct roles come from the theme palette", () => {
    const r = resolveRole(cat, "stone_dungeon", "wall.wall").resolution;
    expect(r?.paletteId).toBe("stone_dungeon");
    expect(r?.variants.map((v) => v.name)).toEqual(["Dungeon Wall 01", "Dungeon Wall 02"]);
    expect(themeChain(cat.palettes, "cave")).toEqual(["cave", "generic"]);
  });

  it("alias roles resolve from the area's theme (floor.brick → flagstone)", () => {
    const r = resolveRole(cat, "stone_dungeon", "floor.brick").resolution;
    expect(r?.role).toBe("floor.flagstone");
    expect(r?.paletteId).toBe("stone_dungeon");
    expect(r?.path).toEqual(["floor.brick", "floor.flagstone"]);
    // marble and stone tile have their own assets since the 2026-11-19 palette expansion
    expect(resolveRole(cat, "stone_dungeon", "floor.marble").resolution?.role).toBe("floor.marble");
    const w = resolveRole(cat, "wood_town", "wall.wood").resolution;
    expect(w?.paletteId).toBe("wood_town"); // wall.wood → wall.wall in the wooden kit
    expect(resolveRole(cat, "wood_town", "wall.stone").resolution?.role).toBe("wall.stone"); // real stone wall
  });

  it("roles a theme lacks come from generic", () => {
    const r = resolveRole(cat, "cave", "feature.chest").resolution;
    expect(r?.paletteId).toBe("generic");
  });

  it("unknown theme falls back to generic", () => {
    const o = resolveRole(cat, "castle", "floor.flagstone");
    expect(o.themeMissing).toBe(true);
    expect(o.resolution?.paletteId).toBe("generic");
  });

  it("missing asset → alternate (recorded as substitution)", () => {
    const c: PaletteCatalog = { ...cat, availability: availability([ids.wall1]) };
    const o = resolveRole(c, "stone_dungeon", "wall.wall");
    const v = o.resolution?.variants.find((x) => x.wanted === ids.wall1);
    expect(v?.substituted).toBe(true);
    const alt = cat.palettes["stone_dungeon"]?.roles["wall.wall"]?.variants[0]?.alternates?.[0]; // md_wall_1x1_01
    expect(alt).toBeDefined();
    expect(v?.uuid).toBe(alt);
    expect(o.substitutions).toEqual([
      { role: "wall.wall", wanted: { uuid: ids.wall1, name: "Dungeon Wall 01" }, used: { uuid: v?.uuid } },
    ]);
  });

  it("no usable variant → role fallback (wall.ruined → wall.wall), then generic, then drop", () => {
    const ruined = cat.palettes["stone_dungeon"]?.roles["wall.ruined"]?.variants[0]?.asset ?? "";
    const c: PaletteCatalog = { ...cat, availability: availability([ruined]) };
    const o = resolveRole(c, "stone_dungeon", "wall.ruined");
    expect(o.resolution?.role).toBe("wall.wall");
    expect(o.substitutions[0]?.used).not.toBeNull();
    // everything missing → dropped
    const all = Object.values(cat.palettes).flatMap((p) =>
      Object.values(p.roles).flatMap((r) => r.variants.flatMap((v) => [v.asset, ...(v.alternates ?? [])])),
    );
    const none: PaletteCatalog = { ...cat, availability: availability(all) };
    const d = resolveRole(none, "stone_dungeon", "wall.wall");
    expect(d.resolution).toBeNull();
    expect(d.substitutions.some((s) => s.used === null)).toBe(true);
  });

  it("filters continue down the chain (a length-1 piece for ruined walls comes from wall.wall)", () => {
    const o = resolveRole(cat, "stone_dungeon", "wall.ruined", {
      key: "len1",
      test: (v) => Math.round(Math.max(v.geom.size.x, v.geom.size.z)) === 1,
    });
    expect(o.resolution?.role).toBe("wall.wall");
    expect(o.resolution?.variants.map((v) => v.name)).toEqual(["Dungeon Wall 01"]);
  });

  it("vocabulary without its own asset falls back to a stand-in; unknown roles are missing", () => {
    expect(resolveRole(cat, "outdoor", "feature.pool").resolution?.role).toBe("feature.fountain");
    expect(resolveRole(cat, "stone_dungeon", "feature.chandelier").resolution?.role).toBe(
      "feature.candelabra",
    );
    expect(resolveRole(cat, "stone_dungeon", "feature.no_such_thing").resolution).toBeNull();
    expect(resolveRole(cat, "stone_dungeon", "link.spiral_stairs").resolution?.role).toBe("link.ladder");
  });
});

describe("user overrides", () => {
  it("replaces and deletes roles, adds themes, reports invalid files and cycles", () => {
    const wall = loadPalettes().palettes["stone_dungeon"]?.roles["wall.wall"];
    const { palettes, issues } = mergePalettes(BUNDLED_PALETTES, [
      {
        source: "stone_dungeon.json",
        data: {
          schema: "slabyrinth/palette@1",
          id: "stone_dungeon",
          overrides: true,
          roles: { "wall.ruined": null, "wall.brick": wall },
          defaults: { floor: "stone_tile" },
        },
      },
      {
        source: "castle.json",
        data: {
          schema: "slabyrinth/palette@1",
          id: "castle",
          name: "Castle",
          extends: "stone_dungeon",
          defaults: { floor: "stone_tile", wallStyle: "stone" },
          roles: {},
        },
      },
      { source: "broken.json", data: { schema: "slabyrinth/palette@1", id: "Bad Id" } },
      {
        source: "loop_a.json",
        data: {
          schema: "slabyrinth/palette@1",
          id: "loop_a",
          name: "a",
          extends: "loop_b",
          defaults: { floor: "rock", wallStyle: "wall" },
          roles: {},
        },
      },
      {
        source: "loop_b.json",
        data: {
          schema: "slabyrinth/palette@1",
          id: "loop_b",
          name: "b",
          extends: "loop_a",
          defaults: { floor: "rock", wallStyle: "wall" },
          roles: {},
        },
      },
    ]);
    const sd = palettes["stone_dungeon"];
    expect(sd?.roles["wall.ruined"]).toBeUndefined();
    expect(sd?.roles["wall.brick"]).toBeDefined();
    expect(sd?.defaults.floor).toBe("stone_tile");
    expect(sd?.source?.editedByUser).toBe(true);
    expect(palettes["castle"]?.extends).toBe("stone_dungeon");
    expect(issues.map((i) => i.source)).toContain("broken.json");
    expect(issues.some((i) => /cycle/.test(i.message))).toBe(true);
  });
});

describe("prototype-named keys never throw", () => {
  const PROTO = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];
  const cat = loadPalettes();

  it("as theme id: unknown theme → generic", () => {
    for (const t of PROTO) {
      const o = resolveRole(cat, t, "floor.flagstone");
      expect(o.themeMissing).toBe(true);
      expect(o.resolution?.paletteId).toBe("generic");
      expect(themeChain(cat.palettes, t)).toEqual(["generic"]);
    }
  });

  it("as role name: missing role, no throw", () => {
    for (const r of PROTO) {
      expect(resolveRole(cat, "stone_dungeon", r).resolution).toBeNull();
      expect(resolveRole(cat, "constructor", r).resolution).toBeNull();
    }
  });

  it("as variant key and alternate uuid key: ignored", () => {
    const wall = cat.palettes["stone_dungeon"]?.roles["wall.wall"]?.variants[0];
    if (!wall) throw new Error("fixture");
    const { palettes, issues } = mergePalettes(BUNDLED_PALETTES, [
      {
        source: "x.json",
        data: {
          schema: "slabyrinth/palette@1",
          id: "stone_dungeon",
          overrides: true,
          roles: {
            "feature.statue": {
              variants: [{ ...wall, variant: "constructor", alternates: [], alternateGeom: {} }],
            },
          },
        },
      },
    ]);
    expect(issues).toEqual([]);
    const c = { palettes, availability: cat.availability };
    expect(resolveRole(c, "stone_dungeon", "feature.statue").resolution?.variants[0]?.variant).toBe(
      "constructor",
    );
  });

  it("as user palette id (override and full palette) and as role keys in a user file: loads, never throws", () => {
    for (const id of PROTO) {
      const run = () =>
        mergePalettes(BUNDLED_PALETTES, [
          { source: `${id}.json`, data: { schema: "slabyrinth/palette@1", id, overrides: true, roles: {} } },
          {
            source: `${id}-full.json`,
            data: {
              schema: "slabyrinth/palette@1",
              id,
              name: id,
              defaults: { floor: "rock", wallStyle: "wall" },
              roles: {},
            },
          },
          {
            source: "roles.json",
            data: JSON.parse(
              `{"schema":"slabyrinth/palette@1","id":"stone_dungeon","overrides":true,"roles":{"${id}":null}}`,
            ) as unknown,
          },
        ]);
      expect(run).not.toThrow();
      const { palettes, issues } = run();
      expect(Object.getPrototypeOf(palettes)).toBeNull(); // a "__proto__" id cannot re-parent the dictionary
      expect(palettes["generic"]).toBeDefined();
      expect(issues.every((i) => typeof i.message === "string")).toBe(true);
    }
  });

  it("loadPalettes with such user files starts normally", () => {
    const c = loadPalettes({
      user: [
        {
          source: "c.json",
          data: { schema: "slabyrinth/palette@1", id: "constructor", overrides: true, roles: {} },
        },
      ],
    });
    expect(c.issues.some((i) => /unknown palette "constructor"/.test(i.message))).toBe(true);
    expect(resolveRole(c, "stone_dungeon", "wall.wall").resolution).not.toBeNull();
  });
});
