/**
 * Composed set pieces (ritual_circle, overgrown, cavern, collapse, crystal_grotto, campsite): composition rules,
 * playability guards, determinism; clustered scatter for the natural types; and the flat "dressed cave" proof
 * plan end to end (resolve → validate → compile) within the slab size budget.
 */
import { describe, expect, it } from "vitest";
import type { FeatureType, Side } from "../../../src/contracts/plan";
import { loadPlan } from "../../fixtures";
import { DRESS_PRESETS, FEATURE_TYPES } from "../../../src/contracts/plan";
import {
  COMPOSED_PRESETS,
  FEATURE_INFO,
  LIGHT_FEATURES,
  SET_PIECES,
  type ComposedPreset,
  type GeneratedPlacement,
  type PlacementGrid,
  dressArea,
  glyphType,
  scatterFeatures,
} from "../../../src/gen/index";
import { compileResolved } from "../../../src/compile";
import { bundledPalettes, loadPalettes, resolveRole } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { slabCodec } from "../../../src/slab";
import { validatePlan } from "../../../src/plan";

const W = 24;
const H = 16;
/** Door: west wall, rows 7–8. */
const isDoor = (x: number, y: number, s: Side): boolean => x === 0 && (y === 7 || y === 8) && s === "W";

function room(w = W, h = H): PlacementGrid {
  return {
    inBounds: (x, y) => x >= 0 && y >= 0 && x < w && y < h,
    isFloor: (x, y) => x >= 0 && y >= 0 && x < w && y < h,
    flags: () => 0,
    area: () => 1,
    occupied: () => false,
    edge: (x, y, s) =>
      isDoor(x, y, s)
        ? 2
        : (s === "N" && y === 0) ||
            (s === "S" && y === h - 1) ||
            (s === "W" && x === 0) ||
            (s === "E" && x === w - 1)
          ? 1
          : 0,
  };
}

function cellsOf(w = W, h = H): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push([x, y]);
  return out;
}

function dress(preset: ComposedPreset, seed = 5, density = 0.6, w = W, h = H): GeneratedPlacement[] {
  return dressArea(room(w, h), {
    preset,
    areaIndex: 1,
    areaCells: cellsOf(w, h),
    density,
    seed,
    remaining: 6000,
  }).placements;
}

const blockingCells = (ps: GeneratedPlacement[]): Set<string> => {
  const s = new Set<string>();
  for (const p of ps) {
    const info = FEATURE_INFO[p.type];
    if (!info.blocking || info.wallMounted) continue;
    for (let y = p.at[1]; y < p.at[1] + p.size[1]; y++)
      for (let x = p.at[0]; x < p.at[0] + p.size[0]; x++) s.add(`${x},${y}`);
  }
  return s;
};

describe.each(COMPOSED_PRESETS)("composed preset %s", (preset) => {
  const ps = dress(preset);

  it("is deterministic for a seed and changes with the seed", () => {
    expect(dress(preset)).toEqual(ps);
    expect(dress(preset, 6)).not.toEqual(ps);
  });

  it("only natural pieces overlap (never on the same anchor), all inside the area", () => {
    const owner = new Map<string, GeneratedPlacement>();
    const anchors = new Set<string>();
    for (const p of ps) {
      const a = `${p.at[0]},${p.at[1]}`;
      if (FEATURE_INFO[p.type].organic) {
        expect(anchors.has(a), `${p.type} at ${a}`).toBe(false);
        anchors.add(a);
      }
      for (let y = p.at[1]; y < p.at[1] + p.size[1]; y++)
        for (let x = p.at[0]; x < p.at[0] + p.size[0]; x++) {
          expect(x >= 0 && y >= 0 && x < W && y < H).toBe(true);
          const prev = owner.get(`${x},${y}`);
          if (prev)
            expect(
              FEATURE_INFO[prev.type].organic && FEATURE_INFO[p.type].organic,
              `${prev.type}/${p.type}`,
            ).toBe(true);
          owner.set(`${x},${y}`, p);
        }
    }
  });

  it("keeps two cells in front of the door clear of blocking pieces", () => {
    const b = blockingCells(ps);
    for (let y = 5; y <= 10; y++) for (let x = 0; x <= 2; x++) expect(b.has(`${x},${y}`)).toBe(false);
  });

  it("leaves every free floor cell reachable from the door", () => {
    const b = blockingCells(ps);
    const seen = new Set<string>(["0,7"]);
    const q: Array<[number, number]> = [[0, 7]];
    while (q.length) {
      const [x, y] = q.pop() as [number, number];
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        const k = `${nx},${ny}`;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || b.has(k) || seen.has(k)) continue;
        seen.add(k);
        q.push([nx, ny]);
      }
    }
    expect(seen.size).toBe(W * H - b.size);
  });

  it("lights the entrance and wall-mounts its wall pieces", () => {
    const lights = ps.filter((p) => LIGHT_FEATURES.has(p.type));
    expect(lights.some((p) => Math.abs(p.at[0]) <= 2 && Math.abs(p.at[1] - 7.5) <= 3)).toBe(true);
    for (const p of ps.filter((q) => FEATURE_INFO[q.type].wallMounted)) expect(p.wall).toBeDefined();
  });

  it("composes groups (pieces have neighbours) and leaves the middle open", () => {
    const occupied = new Set(ps.map((p) => `${p.at[0]},${p.at[1]}`));
    const withNeighbour = ps.filter((p) =>
      [-2, -1, 0, 1, 2].some((dx) =>
        [-2, -1, 0, 1, 2].some((dy) => (dx || dy) && occupied.has(`${p.at[0] + dx},${p.at[1] + dy}`)),
      ),
    );
    expect(withNeighbour.length / ps.length).toBeGreaterThan(0.8);
    // a 6×4 block in the middle is not filled up (the combat space stays readable)
    // the clearing holds no blocking pieces (ground cover may drift into it)
    const mid = ps.filter(
      (p) => p.at[0] >= 9 && p.at[0] < 15 && p.at[1] >= 6 && p.at[1] < 10 && FEATURE_INFO[p.type].blocking,
    );
    expect(mid.length).toBeLessThanOrEqual(SET_PIECES[preset].focal?.place === "center" ? 20 : 4);
  });

  it("varies: no group repeats more than the cap", () => {
    expect(ps.length).toBeGreaterThan(8);
    expect(new Set(ps.map((p) => p.type)).size).toBeGreaterThanOrEqual(4);
  });

  it("still dresses a small room", () => {
    expect(dress(preset, 3, 0.6, 7, 6).length).toBeGreaterThan(0);
  });
});

describe("focal groups", () => {
  it("ritual_circle: glowing centre, boss spawn point, a ring of standing stones with candles", () => {
    const ps = dress("ritual_circle");
    const fire = ps.find((p) => p.type === "magic_fire");
    expect(fire).toBeDefined();
    expect(ps.find((p) => p.type === "spawn_point")?.variant).toBe("boss");
    const ring = ps.filter(
      (p) =>
        (p.type === "monolith" || p.type === "standing_stone" || p.type === "rubble") &&
        Math.max(Math.abs(p.at[0] - (fire?.at[0] ?? 0)), Math.abs(p.at[1] - (fire?.at[1] ?? 0))) <= 4,
    );
    expect(ring.length).toBeGreaterThanOrEqual(6);
    expect(ps.filter((p) => p.type === "candles").length).toBeGreaterThanOrEqual(4);
  });

  it("overgrown: a great tree against the wall farthest from the door, roots and a spawn point in front", () => {
    const ps = dress("overgrown");
    const tree = ps.find((p) => p.type === "tree_large");
    expect(tree).toBeDefined();
    expect(tree?.at[0]).toBeGreaterThan(W / 2); // the door is on the west wall
    expect(ps.filter((p) => p.type === "root").length).toBeGreaterThanOrEqual(4);
    expect(ps.some((p) => p.type === "spawn_point")).toBe(true);
    expect(ps.some((p) => p.type === "roots_wall")).toBe(true);
  });

  it("collapse, campsite and crystal_grotto have their focal piece", () => {
    expect(dress("collapse").some((p) => p.type === "cave_in")).toBe(true);
    expect(dress("campsite").some((p) => p.type === "fire_pit")).toBe(true);
    expect(dress("crystal_grotto").filter((p) => p.type === "accent_light").length).toBeGreaterThan(3);
  });

  it("shrine, bone pit, mine works, grove and barricade compose their pieces; tall pieces give a skyline", () => {
    const shrine = dress("shrine_ruin");
    expect(shrine.some((p) => p.type === "statue_large")).toBe(true);
    expect(shrine.some((p) => p.type === "tall_marker" || p.type === "pillar")).toBe(true);
    expect(dress("bone_pit").some((p) => p.type === "statue_large" && p.variant === "bones")).toBe(true);
    const mine = dress("mine_works");
    expect(mine.some((p) => p.type === "mine_support")).toBe(true);
    expect(mine.some((p) => p.type === "mine_cart" || p.type === "rails")).toBe(true);
    expect(dress("mushroom_grove").filter((p) => p.type === "undergrowth").length).toBeGreaterThan(2);
    expect(
      dress("barricade").filter((p) => ["crate", "barrel", "log", "sack"].includes(p.type)).length,
    ).toBeGreaterThan(3);
    const tall: FeatureType[] = [
      "monolith",
      "tall_marker",
      "cluster_tall",
      "landmark",
      "statue_large",
      "tree_large",
    ];
    for (const preset of ["ritual_circle", "overgrown", "cavern", "shrine_ruin"] as const)
      expect(
        dress(preset).some((p) => tall.includes(p.type)),
        preset,
      ).toBe(true);
  });

  it("cold-lit presets add no warm wall torches away from the entrance", () => {
    for (const preset of ["crystal_grotto", "mushroom_grove"] as const) {
      const torches = dress(preset).filter((p) => p.type === "torch_wall");
      expect(torches.length, preset).toBeLessThanOrEqual(2);
    }
  });
});

describe("height-aware placement", () => {
  /** 20×14 room; the east half (x ≥ 12) is a dais 1 tile higher, with a ledge along x = 12. */
  function terraced(): PlacementGrid {
    const g = room(20, 14);
    return {
      ...g,
      height: (x) => (x >= 12 ? 1 : 0),
      edge: (x, y, s) => {
        const base = g.edge(x, y, s);
        if (base !== 0) return base;
        if ((s === "E" && x === 11) || (s === "W" && x === 12)) return 3; // LEDGE
        return 0;
      },
    };
  }
  const run = (preset: ComposedPreset): GeneratedPlacement[] =>
    dressArea(terraced(), {
      preset,
      areaIndex: 1,
      areaCells: cellsOf(20, 14),
      density: 0.7,
      seed: 4,
      remaining: 6000,
    }).placements;

  it("never puts a multi-cell piece across the ledge (the cliff band's rocks lean against it by design)", () => {
    for (const preset of COMPOSED_PRESETS)
      for (const p of run(preset))
        if (p.size[0] * p.size[1] > 1 && p.type !== "cliff_face" && p.type !== "cliff_crest")
          expect(p.at[0] < 12 && p.at[0] + p.size[0] > 12, `${preset} ${p.type}`).toBe(false);
  });

  it("puts the centre focal piece on the high ground", () => {
    expect(run("ritual_circle").find((p) => p.type === "magic_fire")?.at[0]).toBeGreaterThanOrEqual(12);
  });

  it("gathers scree at the foot of the ledge and lights the lip", () => {
    const cav = run("collapse");
    expect(
      cav.some((p) => (p.type === "rubble" || p.type === "debris") && p.at[0] >= 9 && p.at[0] <= 11),
    ).toBe(true);
    // every cell on the lip has a light within the preset spacing (upper level lit as well as the lower one)
    const lights = run("cavern").filter((p) => LIGHT_FEATURES.has(p.type));
    for (let y = 0; y < 14; y++)
      expect(
        lights.some((l) => Math.max(Math.abs(l.at[0] - 12), Math.abs(l.at[1] - y)) < 8),
        `lip 12,${y}`,
      ).toBe(true);
  });
});

describe("clustered scatter", () => {
  it("stalagmites scatter in clumps; legacy types keep their single-cell stream", () => {
    const grid = room(30, 30);
    const cands = cellsOf(30, 30);
    const base = {
      candidates: cands,
      density: 0.06,
      minSpacing: 3,
      avoid: new Set<never>(),
      randomRotation: true,
      seed: 9,
      remaining: 999,
    };
    const st = scatterFeatures(grid, { ...base, feature: "stalagmite" }).placements;
    const near = (p: GeneratedPlacement, all: GeneratedPlacement[]): boolean =>
      all.some((q) => q !== p && Math.max(Math.abs(q.at[0] - p.at[0]), Math.abs(q.at[1] - p.at[1])) <= 2);
    expect(st.filter((p) => near(p, st)).length / st.length).toBeGreaterThan(0.6);
    const rocks = scatterFeatures(grid, { ...base, feature: "rock" }).placements;
    expect(rocks.some((p) => near(p, rocks))).toBe(false); // minSpacing 3 still holds for old types
  });
});

describe("vocabulary coverage", () => {
  const cat = loadPalettes();
  const themes = Object.keys(cat.palettes);

  // the cliff band's rocks exist only in themes with natural rock: a city or a dungeon keeps its built face
  const NATURAL_ONLY = new Set<string>(["cliff_face", "cliff_crest"]);
  const BUILT_FACE = new Set(["city", "stone_dungeon", "generic"]);

  it("every feature type has an asset in every bundled theme (nothing the model asks for is dropped)", () => {
    const missing: string[] = [];
    for (const t of FEATURE_TYPES.filter((f) => f !== "custom"))
      for (const th of themes)
        if (!(NATURAL_ONLY.has(t) && BUILT_FACE.has(th)) && !resolveRole(cat, th, `feature.${t}`).resolution)
          missing.push(`${th}/feature.${t}`);
    expect(missing).toEqual([]);
  });

  it("every feature type added for set dressing names a stand-in glyph", () => {
    const added: FeatureType[] = FEATURE_TYPES.slice(
      FEATURE_TYPES.indexOf("stalagmite"),
      FEATURE_TYPES.indexOf("custom"),
    );
    expect(added.length).toBe(49); // + vehicle, seating, signage (built places), cliff_face, cliff_crest, clutter, shelf_line (2026-11-20)
    for (const t of added) {
      expect(FEATURE_INFO[t].glyph).toBeDefined();
      expect(FEATURE_INFO[glyphType(t)].glyph).toBeUndefined(); // the stand-in has its own painter
    }
  });

  it("the composed presets are dress presets", () => {
    for (const p of COMPOSED_PRESETS) expect(DRESS_PRESETS).toContain(p);
  });

  it("terrain roles for ledges, cliffs, bridges, railings, lava and thin rock walls resolve in the cave theme", () => {
    for (const role of [
      "wall.rock",
      "wall_post.rock",
      "ledge.rock",
      "ledge.lava",
      "cliff.rock",
      "cliff.formation_face",
      "cliff.formation_crest",
      "floor.bridge_wood",
      "floor.bridge_stone",
      "wall.railing",
      "wall.railing_stone",
      "floor.lava",
      "bed.default",
      "feature.lava_glow",
    ])
      expect(resolveRole(cat, "cave", role).resolution?.role).toBe(role);
  });
});

describe.each(["dressed-cave", "dressed-cave-v2", "dressed-forest"] as const)(
  "dressed cave proof plan %s (flat)",
  (name) => {
    const plan = loadPlan(name);
    const resolved = resolvePlan(plan, bundledPalettes());
    const bundle = compileResolved(resolved, loadPalettes(), slabCodec, { createdAt: "t", plan });

    it("validates with no errors and composes a dense room", () => {
      const v = validatePlan(plan);
      expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
      const level = resolved.levels[0];
      expect(level?.features.length ?? 0).toBeGreaterThan(120);
    });

    it("compiles into one slab well inside the size budget, with no build errors", () => {
      expect(bundle.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(bundle.chunks).toHaveLength(1);
      // dense dressing of a 46×34 cavern: measured ~3.7 KB of the 24.5 KB per-slab budget
      expect(bundle.chunks[0]?.compressedBytes ?? Infinity).toBeLessThan(0.8 * 30720);
    });
  },
);
