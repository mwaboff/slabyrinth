/**
 * Generator 4 built interiors: carved into a solid mass with a flat cap, a floor of its own for each room with a step
 * at the door, rough walls with uneven tops and rubble at the feet. Generators 1-3 keep their output (golden); these
 * tests pin the generator-4 rules.
 */
import { describe, expect, it } from "vitest";
import { compileResolved, realize } from "../../../src/compile";
import { SHELL, planShell, type Shell } from "../../../src/compile/shell";
import type { MapPlan } from "../../../src/contracts/plan";
import { CELL, EDGE, type ResolvedLevel, type ResolvedPlan } from "../../../src/contracts/resolved";
import { findWallFaces } from "../../../src/resolve/wallFaces";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { classifyRoom } from "../../../src/gen/roomPurpose";
import { accentTop, floorTone, purposeFloor } from "../../../src/resolve/interiorFloors";
import { LevelGrid, sideOrient } from "../../../src/resolve/levelGrid";
import { DEFAULT_INTERIOR, themeDefaults } from "../../../src/resolve/themes";
import { generatorProfile } from "../../../src/plan/generator";
import { createPaletteView } from "../../../src/palette/view";
import { resolveRole } from "../../../src/palette/resolve";
import { reviewDesign } from "../../../src/review";
import { slabCodec } from "../../../src/slab";
import { h32 } from "../../../src/util/hash";
import { loadPlan } from "../../fixtures";
import { dungeonPlan } from "../../fixtures/planBuilder";

const palettes = loadPalettes();
/** The shell of one level as the realizer plans it (no building claims any wall here). */
const shellOf = (R: ResolvedPlan, L: ResolvedLevel, theme: string): Shell | null =>
  planShell(R, L, h32(R.planId), findWallFaces(new LevelGrid(L, theme), { boardEdgeIsExit: true }), theme);
const keep = (generator: 3 | 4 = 4): MapPlan => loadPlan("keep-dungeon-v8", { generator });
/** The inn interior, optionally in another theme. */
const inn = (theme?: string): MapPlan => {
  const p = loadPlan("inn-interior-v1");
  if (theme !== undefined) p.theme = theme;
  return p;
};
const lvl = (plan: MapPlan, id: string): ResolvedLevel => {
  const L = resolvePlan(plan, bundledPalettes()).levels.find((l) => l.id === id);
  if (!L) throw new Error(`no level ${id}`);
  return L;
};
const areaMat = (L: ResolvedLevel, id: string): string => {
  const a = L.areaIds.indexOf(id) + 1;
  const counts = new Map<string, number>();
  for (let i = 0; i < L.cells.area.length; i++)
    if (L.cells.area[i] === a && L.cells.state[i] === CELL.OPEN) {
      const m = L.materials[(L.cells.material[i] ?? 1) - 1] ?? "none";
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
  return [...counts].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "none";
};
const areaHeight = (L: ResolvedLevel, id: string): number => {
  const a = L.areaIds.indexOf(id) + 1;
  const hs = new Set<number>();
  for (let i = 0; i < L.cells.area.length; i++)
    if (L.cells.area[i] === a && L.cells.state[i] === CELL.OPEN) hs.add(L.cells.height[i] ?? 0);
  return Math.max(...hs) / 4;
};

describe("interior floors (helpers)", () => {
  it("a room's floor comes from its one classification, in the theme's floor family", () => {
    const floor = (name: string, family: "stone" | "timber", tags?: string[]) =>
      purposeFloor(classifyRoom({ name, tags }).purpose, family);
    expect(floor("Guard room", "stone")).toBe("stone_tile");
    expect(floor("Guard room", "timber")).toBe("wood_plank");
    expect(floor("Great hall", "stone")).toBe("stone_tile");
    expect(floor("Crypt", "stone")).toBe("cobble");
    expect(floor("Stair landing", "stone")).toBe("keep");
    expect(floor("Shrine antechamber", "stone")).toBe("keep");
    expect(floor("Cell A", "stone")).toBe("stone_tile");
    expect(floor("Cellar", "stone")).toBe("cobble");
    expect(floor("Kitchen", "timber")).toBe("stone_tile");
    expect(floor("Washroom", "timber")).toBe("stone_tile");
    expect(floor("Store room", "timber")).toBe("cobble");
    expect(floor("Room 7", "stone")).toBeNull();
    expect(floor("The inner ward", "timber", ["tavern"])).toBe("wood_plank");
  });
  it("tones a pale top down to the room, never up", () => {
    // no piece carries a tone: the materials' guess
    const guess = floorTone({ floorTone: () => undefined }, "any");
    expect(accentTop("marble", "flagstone", "stone_tile", guess)).toBe("flagstone");
    expect(accentTop("marble", "stone_tile", "stone_tile", guess)).toBe("stone_tile");
    expect(accentTop("marble", "marble", undefined, guess)).toBe("marble");
    expect(accentTop("flagstone", "marble", undefined, guess)).toBe("flagstone");
  });
  it("asks the palette's pieces first: a theme whose flagstone is pale keeps a marble top on it", () => {
    const generic = palettes.palettes.generic;
    const flag = generic?.roles["floor.flagstone"];
    if (!flag) throw new Error("generic has no floor.flagstone");
    const user = {
      schema: "slabyrinth/palette@1",
      id: "pale_hall",
      name: "Pale hall",
      extends: "generic",
      defaults: { floor: "flagstone", wallStyle: "wall" },
      roles: {
        "floor.flagstone": { ...flag, variants: flag.variants.map((v) => ({ ...v, tone: "light" })) },
      },
    };
    const view = createPaletteView(loadPalettes({ user: [{ source: "pale_hall.json", data: user }] }));
    expect(view.floorTone("pale_hall", "flagstone")).toBe("light");
    const pale = floorTone(view, "pale_hall");
    expect(pale("flagstone")).toBe(2);
    expect(accentTop("marble", "flagstone", "stone_tile", pale)).toBe("marble");
    // the bundled theme keeps the guess where its pieces say nothing
    expect(accentTop("marble", "flagstone", "stone_tile", floorTone(view, "generic"))).toBe("flagstone");
  });
});

describe("generator 4 room floors", () => {
  it("rooms on the default floor take their purpose's floor; chosen floors and corridors keep theirs", () => {
    const L1 = lvl(keep(), "l1");
    // a stone dungeon varies among stone and earth floors, never wood (the plan's own floor always wins)
    expect(["stone_tile", "cobble", "flagstone"]).toContain(areaMat(L1, "guard"));
    // the hall is big: stone_tile only comes in 1x1 pieces, so it takes a floor that comes in 2x2
    expect(["cobble", "flagstone"]).toContain(areaMat(L1, "hall"));
    expect(areaMat(L1, "landing")).toBe("flagstone"); // corridor-like: keeps the corridor floor
    expect(areaMat(L1, "c_gh")).toBe("flagstone");
    const L2 = lvl(keep(), "l2");
    expect(areaMat(L2, "crypt")).toBe("flagstone"); // abandoned: keeps the level's default floor
    expect(areaMat(L2, "cell_w1")).toBe("stone_tile"); // named on purpose
    expect(areaMat(L2, "cb_hall")).toBe("flagstone");
    expect(areaMat(lvl(keep(), "l3"), "shrine")).toBe("marble");
  });
  it("no room of a stone level takes a wood floor, and the dais stays stone", () => {
    const R = resolvePlan(keep(), bundledPalettes());
    for (const L of R.levels) {
      expect(L.materials).not.toContain("wood_plank");
      expect(L.materials).not.toContain("carpet");
    }
  });
  it("an inhabited timber inn takes wood for bedrooms and common rooms, tile or stone for kitchen, wash and store", () => {
    const p = inn();
    for (const a of p.levels[0]?.areas ?? []) if (a.kind === "room") delete a.floor; // every room on the default floor
    const L = lvl(p, "l1");
    for (const a of L.areas) {
      const name = (a.name ?? "").toLowerCase();
      if (/bed|tavern|study|library|guard/.test(name)) expect(areaMat(L, a.id)).toBe("wood_plank");
      if (/kitchen|wash/.test(name)) expect(["stone_tile", "cobble"]).toContain(areaMat(L, a.id));
      if (/store/.test(name)) expect(["cobble", "stone_tile"]).toContain(areaMat(L, a.id));
      expect(areaMat(L, a.id)).not.toBe("flagstone");
    }
  });
  it("an abandoned room keeps the level's default floor", () => {
    const p = keep();
    const guard = p.levels[0]?.areas.find((a) => a.id === "guard");
    if (guard) guard.name = "Abandoned guard room";
    expect(areaMat(lvl(p, "l1"), "guard")).toBe("flagstone");
  });
  it("generator 3 keeps every room on the floor the plan names", () => {
    const L1 = lvl(keep(3), "l1");
    expect(areaMat(L1, "guard")).toBe("flagstone");
    expect(areaHeight(L1, "guard")).toBe(0);
  });
  it("the dais top takes the hall's own tone, not a stark pale slab", () => {
    const L1 = lvl(keep(), "l1");
    const dais = L1.cells.height.findIndex((h, i) => h > 0 && L1.cells.state[i] === CELL.OPEN);
    expect(L1.materials[(L1.cells.material[dais] ?? 1) - 1]).not.toBe("marble");
    expect(lvl(keep(3), "l1").materials).toContain("marble");
  });
});

describe("generator 4 room steps", () => {
  it("a room off a corridor is a quarter tile above it; link ends, daises and holes keep their height", () => {
    const plan = keep();
    const L2 = lvl(plan, "l2");
    for (const id of ["cell_w1", "cell_w2", "cell_e1"]) expect(areaHeight(L2, id)).toBe(0.25);
    expect(areaHeight(L2, "cell_e2")).toBe(0); // the ladder lands here
    expect(areaHeight(L2, "cb_hall")).toBe(0); // the stair run starts in the corridor
    expect(areaHeight(lvl(plan, "l1"), "landing")).toBe(0); // the stairs arrive here
    expect(areaHeight(lvl(plan, "l1"), "guard")).toBe(0.25);
  });
  it("the plan's own floorHeight wins", () => {
    const plan = keep();
    const a = plan.levels.find((l) => l.id === "l2")?.areas.find((q) => q.id === "cell_w1");
    if (a) a.floorHeight = 0.5;
    expect(areaHeight(lvl(plan, "l2"), "cell_w1")).toBe(0.5);
  });
  it("stairs still land: no verify error about arrival or reachability", () => {
    const plan = keep();
    const r = compileResolved(resolvePlan(plan, bundledPalettes()), palettes, slabCodec, { plan });
    const codes = r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
    expect(codes).not.toContain("verify_stairs_no_arrival");
    expect(codes).not.toContain("verify_area_unreachable");
    expect(codes).not.toContain("verify_door_blocked");
  });
});

describe("generator 4 rough walls", () => {
  const tops = (L: ResolvedLevel): Map<number, number> => {
    const m = new Map<number, number>();
    for (const g of [L.hEdges, L.vEdges])
      g.kind.forEach((k, i) => {
        if (k !== EDGE.WALL) return;
        const h = g.height[i] ?? 0;
        m.set(h, (m.get(h) ?? 0) + 1);
      });
    return m;
  };
  it("wall heights vary along the runs, most at the full height", () => {
    const m = new Map<number, number>();
    for (const id of ["l1", "l2", "l3"])
      for (const [h, c] of tops(lvl(keep(), id))) m.set(h, (m.get(h) ?? 0) + c);
    const total = [...m.values()].reduce((s, c) => s + c, 0);
    expect(m.size).toBeGreaterThanOrEqual(3);
    expect(Math.max(...m.values()) / total).toBeLessThanOrEqual(0.7);
    expect(Math.min(...m.keys())).toBeGreaterThanOrEqual(1.25);
    // generator 3: the plan's own heights only (2, plus the odd rim wall), nothing lowered
    const m3 = new Map<number, number>();
    for (const id of ["l1", "l2", "l3"])
      for (const [h, c] of tops(lvl(keep(3), id))) m3.set(h, (m3.get(h) ?? 0) + c);
    expect((m3.get(2) ?? 0) / [...m3.values()].reduce((s, c) => s + c, 0)).toBeGreaterThan(0.9);
  });
  it("walls beside a doorway keep their full height", () => {
    const L = lvl(keep(), "l2");
    const grid = new LevelGrid(L);
    for (const op of L.openings) {
      const [x, y] = op.start;
      for (const k of [-1, op.width]) {
        const i = op.orientation === "h" ? grid.hEdge(x + k, y) : grid.vEdge(x, y + k);
        const g = grid.edges(op.orientation);
        // full height, or a quarter less where the room is raised a quarter tile over the corridor (the top stays at base + 2)
        if (g.kind[i] === EDGE.WALL) expect(g.height[i]).toBeGreaterThanOrEqual(1.75);
      }
    }
  });
  it("a wall that carries a wall-mounted feature keeps its height", () => {
    const L = lvl(keep(), "l1");
    const grid = new LevelGrid(L);
    const torches = L.features.filter((f) => f.wall !== undefined);
    expect(torches.length).toBeGreaterThan(3);
    for (const f of torches) {
      if (f.wall === undefined) continue;
      const i = grid.edgeIndex(f.at[0], f.at[1], f.wall);
      expect(grid.edges(sideOrient(f.wall)).height[i]).toBeGreaterThanOrEqual(1.75);
    }
  });
  it("wall-foot rubble: about one pile per 10 floor tiles, never on a link, steps or a doorway cell", () => {
    const L = lvl(keep(), "l1");
    const piles = L.features.filter((f) => f.generatedBy === "walls");
    expect(piles.length).toBeGreaterThan(10);
    const doorway = new Set<string>();
    for (const op of L.openings)
      for (let k = 0; k < op.width; k++)
        for (const d of [0, -1]) {
          const x = op.orientation === "h" ? op.start[0] + k : op.start[0] + d;
          const y = op.orientation === "h" ? op.start[1] + d : op.start[1] + k;
          doorway.add(`${x},${y}`);
        }
    for (const f of piles) {
      const i = (f.at[1] - L.bounds.y) * L.bounds.w + (f.at[0] - L.bounds.x);
      expect(L.cells.state[i]).toBe(CELL.OPEN);
      expect(doorway.has(`${f.at[0]},${f.at[1]}`)).toBe(false);
    }
  });
  it("generator 3 builds no wall-foot rubble", () => {
    expect(lvl(keep(3), "l1").features.filter((f) => f.generatedBy === "walls")).toHaveLength(0);
  });
  describe("a tidy timber interior keeps clean walls", () => {
    const innRenamed = (theme: string, rename?: string): MapPlan => {
      const p = inn(theme);
      if (rename) {
        const guard = p.levels[0]?.areas.find((a) => a.id === "guard");
        if (guard) guard.name = rename;
      }
      return p;
    };
    const distinctTops = (L: ResolvedLevel): Set<number> => {
      const s = new Set<number>();
      for (const g of [L.hEdges, L.vEdges])
        for (let i = 0; i < g.kind.length; i++) if (g.kind[i] === EDGE.WALL) s.add(g.height[i] ?? 0);
      return s;
    };
    // (a room raised a step above the passage settles its wall to one more height in either theme; the rough drops add more)
    it("no wall-foot rubble and no uneven tops in an inhabited timber inn", () => {
      const L = lvl(inn("wood_town"), "l1");
      expect(L.features.filter((f) => f.generatedBy === "walls")).toHaveLength(0);
      const stone = distinctTops(lvl(inn("stone_dungeon"), "l1"));
      const tidy = distinctTops(L);
      expect(tidy.size).toBeLessThan(stone.size);
      expect(tidy.has(1.5)).toBe(false);
    });
    it("the same plan in a stone dungeon gets rubble and uneven tops", () => {
      const L = lvl(inn("stone_dungeon"), "l1");
      expect(L.features.filter((f) => f.generatedBy === "walls").length).toBeGreaterThan(3);
      expect(distinctTops(L).has(1.5)).toBe(true);
    });
    it("an abandoned room in the timber inn is rough, the rest stays clean", () => {
      const L = lvl(innRenamed("wood_town", "Ruined guard room"), "l1");
      const piles = L.features.filter((f) => f.generatedBy === "walls");
      expect(piles.length).toBeGreaterThan(0);
      for (const f of piles) expect(f.area).toBe("guard");
    });
    it("generator 3 is untouched by the gate", () => {
      const p = inn("wood_town");
      p.generator = 3;
      expect(lvl(p, "l1").features.filter((f) => f.generatedBy === "walls")).toHaveLength(0);
    });
  });

  it("only a room a corridor opens on is raised, not one that touches it across a wall", () => {
    const plan = dungeonPlan({
      generator: 4,
      id: "0b7c2d4e-1f3a-4c5b-8d6e-9f0a1b2c3d4e",
      seed: 77,
      levelId: "l1",
      w: 16,
      h: 13,
      areas: [
        { id: "pass", kind: "corridor", name: "Passage", shape: { type: "rect", x: 1, y: 8, w: 13, h: 3 } },
        { id: "a", kind: "room", name: "Study", shape: { type: "rect", x: 1, y: 2, w: 6, h: 6 } },
        { id: "b", kind: "room", name: "Library", shape: { type: "rect", x: 7, y: 2, w: 6, h: 6 } },
      ],
      openings: [
        { id: "d1", kind: "door", between: ["a", "pass"] },
        { id: "d2", kind: "door", between: ["a", "b"] },
      ],
    });
    const L = lvl(plan, "l1");
    expect(areaHeight(L, "a")).toBe(0.25);
    expect(areaHeight(L, "b")).toBe(0);
  });

  describe("interior character is data on the theme, not a list of theme names", () => {
    const finishes = (L: ResolvedLevel): Set<string | undefined> => new Set(L.areas.map((a) => a.finish));
    it("the built-in timber themes (tavern, town, wood_town, city) are tidy and floored in timber: no rubble", () => {
      for (const theme of ["tavern", "town", "wood_town", "city"]) {
        const L = lvl(inn(theme), "l1");
        expect(finishes(L), theme).toEqual(new Set(["tidy"]));
        expect(
          L.features.filter((f) => f.generatedBy === "walls"),
          theme,
        ).toHaveLength(0);
      }
    });
    it("a theme that declares nothing is rough stone", () => {
      const L = lvl(inn("my_crypt_theme"), "l1");
      expect(finishes(L)).toEqual(new Set(["rough"]));
    });
    it("a user theme declares its character in its palette file", () => {
      const user = {
        schema: "slabyrinth/palette@1",
        id: "elf_hall",
        name: "Elf hall",
        extends: "generic",
        defaults: {
          floor: "wood_plank",
          wallStyle: "wall",
          interior: { finish: "tidy", floorFamily: "timber" },
        },
        roles: {},
      };
      const catalog = loadPalettes({ user: [{ source: "elf_hall.json", data: user }] });
      const R = resolvePlan(inn("elf_hall"), catalog);
      const L = R.levels.find((l) => l.id === "l1") as ResolvedLevel;
      expect(finishes(L)).toEqual(new Set(["tidy"]));
      expect(L.features.filter((f) => f.generatedBy === "walls")).toHaveLength(0);
      // without its palette the same theme name is an unknown theme: rough stone
      expect(finishes(lvl(inn("elf_hall"), "l1"))).toEqual(new Set(["rough"]));
    });
    it("generator 4 resolves a theme with what its palette declares, every field, a user theme's included", () => {
      const user = {
        schema: "slabyrinth/palette@1",
        id: "moss_hall",
        name: "Moss hall",
        extends: "cave",
        defaults: { floor: "mud", wallStyle: "hedge" },
        roles: {},
      };
      const catalog = loadPalettes({ user: [{ source: "moss_hall.json", data: user }] });
      const view = createPaletteView(catalog);
      const gen4 = generatorProfile(4);
      for (const [theme, p] of Object.entries(catalog.palettes)) {
        const td = themeDefaults(theme, view, gen4);
        const declared = view.themeDefaults(theme);
        expect(declared?.floor, theme).toBe(p.defaults.floor);
        expect(td.floor, theme).toBe(p.defaults.floor);
        expect(td.wallStyle, theme).toBe(p.defaults.wallStyle);
        if (declared?.caveFloor !== undefined) expect(td.caveFloor, theme).toBe(declared.caveFloor);
        expect(td.interior, theme).toEqual(declared?.interior ?? DEFAULT_INTERIOR);
      }
      // the user theme inherits its cave floor and its interior along `extends`
      expect(themeDefaults("moss_hall", view, gen4)).toMatchObject({ floor: "mud", caveFloor: "rock" });
    });
    it("the released generators keep the frozen table (generator 3 floors wood_town in flagstone)", () => {
      const view = createPaletteView(palettes);
      expect(themeDefaults("wood_town", view, generatorProfile(3)).floor).toBe("flagstone");
      expect(themeDefaults("wood_town", view, generatorProfile(4)).floor).toBe("wood_plank");
    });
  });
});

describe("generator 4 solid shell", () => {
  it("caps the solid cells round the rooms, flush with the wall tops, and closes the edge with a skirt", () => {
    const plan = keep();
    const R = resolvePlan(plan, bundledPalettes());
    const L = R.levels.find((l) => l.id === "l1") as ResolvedLevel;
    const shell = shellOf(R, L, "generic");
    expect(shell).not.toBeNull();
    if (!shell) return;
    expect(shell.cells.size).toBeGreaterThan(100);
    // flush with the wall tops, a hair above them (no shared top face with the wall piece in the same cell)
    expect(shell.top).toBeCloseTo(L.elevation + 0.5 + 2 + SHELL.lift, 6);
    // never on an open cell, always inside the bounds
    for (const c of shell.cells.values()) {
      const i = (c.y - L.bounds.y) * L.bounds.w + (c.x - L.bounds.x);
      expect(L.cells.state[i]).toBe(CELL.SOLID);
    }
    const set = realize(R, palettes, {});
    const l1 = set.levels.find((l) => l.levelId === "l1");
    const cap = (l1?.placements ?? []).filter((p) => p.source.elementId === "shell");
    expect(cap.length).toBeGreaterThan(20);
    // flat: most tiles have their top at the cap height; the ring against a lowered wall steps down with it, never up
    // past the level's tallest wall top
    const flat = cap.filter((p) => Math.abs(p.y + 0.5 - shell.top) < 1e-6);
    expect(flat.length / cap.length).toBeGreaterThan(0.4);
    for (const p of cap) expect(p.y + 0.5).toBeLessThanOrEqual(shell.top + 0.3);
  });
  it("a cap cell over an open cell of a level below is left out, so the lower level stays visible", () => {
    const R = resolvePlan(keep(), bundledPalettes());
    const upper = R.levels.find((l) => l.id === "l1") as ResolvedLevel;
    const lower = R.levels.find((l) => l.id === "l2") as ResolvedLevel;
    const shell = shellOf(R, upper, "generic");
    for (const c of shell?.cells.values() ?? []) {
      const lx = c.x - lower.bounds.x;
      const ly = c.y - lower.bounds.y;
      if (lx < 0 || ly < 0 || lx >= lower.bounds.w || ly >= lower.bounds.h) continue;
      expect(lower.cells.state[ly * lower.bounds.w + lx]).not.toBe(CELL.OPEN);
    }
  });
  it("generators 1-3 build no shell", () => {
    const plan = keep(3);
    const set = realize(resolvePlan(plan, bundledPalettes()), palettes, {});
    for (const lv of set.levels)
      expect(lv.placements.filter((p) => p.source.elementId === "shell")).toHaveLength(0);
  });
  it("the shell stays within its budget: under 260 cap tiles on each level", () => {
    const set = realize(resolvePlan(keep(), bundledPalettes()), palettes, {});
    for (const lv of set.levels) {
      const cap = lv.placements.filter((p) => p.source.elementId === "shell").length;
      expect(cap).toBeLessThan(260);
    }
    const total = set.levels.reduce(
      (s, l) => s + l.placements.filter((p) => p.source.elementId === "shell").length,
      0,
    );
    expect(total).toBeGreaterThan(100);
  });
});

describe("generator 4 shell: tidy buildings, outline", () => {
  it("a tidy timber inn gets no cap and no skirt, only flush strips between its rooms", () => {
    const R = resolvePlan(inn("wood_town"), bundledPalettes());
    const L = R.levels[0] as ResolvedLevel;
    const shell = shellOf(R, L, "wood_town");
    expect(shell?.cells.size ?? 0).toBe(0);
    expect(shell?.edges.length ?? 0).toBe(0);
    expect(shell?.strips.length ?? 0).toBeGreaterThan(10);
    for (const s of shell?.strips ?? []) {
      const i = (s.y - L.bounds.y) * L.bounds.w + (s.x - L.bounds.x);
      expect(L.cells.state[i]).toBe(CELL.SOLID);
    }
    const set = realize(R, palettes, {});
    const shellPieces = set.levels[0]?.placements.filter((p) => p.source.elementId === "shell") ?? [];
    // one tile per strip cell, no pale earth cap
    expect(shellPieces.length).toBeGreaterThan(10);
    expect(shellPieces.length).toBeLessThanOrEqual(shell?.strips.length ?? 0);
  });
  describe("a strip is the top of the wall it closes, not a floor of a room beside it", () => {
    /** The asset uuids a theme's floor role of `material` resolves to. */
    const floorAssets = (theme: string, material: string): Set<string> =>
      new Set(
        (resolveRole(palettes, theme, `floor.${material}`).resolution?.variants ?? []).map((v) => v.uuid),
      );
    /** Each strip's cap asset with the floor materials of the rooms on its two sides. */
    const caps = (plan: MapPlan): Array<{ x: number; y: number; asset: string; floors: string[] }> => {
      const R = resolvePlan(plan, palettes);
      const L = R.levels[0] as ResolvedLevel;
      const G = new LevelGrid(L, "generic");
      const pieces = realize(R, palettes, {}).levels[0]?.placements ?? [];
      const out: Array<{ x: number; y: number; asset: string; floors: string[] }> = [];
      for (const s of shellOf(R, L, "generic")?.strips ?? []) {
        const p = pieces.find(
          (q) => q.source.elementId === "shell" && q.source.cell?.[0] === s.x && q.source.cell[1] === s.y,
        );
        if (!p) continue;
        const floors = [
          [s.x - 1, s.y],
          [s.x + 1, s.y],
          [s.x, s.y - 1],
          [s.x, s.y + 1],
        ]
          .map(([x, y]) => G.cell(x as number, y as number))
          .filter((c) => c.open && c.material !== null)
          .map((c) => c.material as string);
        out.push({ x: s.x, y: s.y, asset: p.asset, floors });
      }
      return out;
    };

    it("a timber building caps the wall between a stone-floored and a wood-floored room in timber", () => {
      const found = caps(inn());
      const plank = floorAssets("wood_town", "wood_plank");
      // the inn has rooms of stone tile and cobble beside rooms of plank; the strips between them are the test
      const mixed = found.filter(
        (c) => c.floors.includes("wood_plank") && c.floors.some((f) => f !== "wood_plank"),
      );
      expect(mixed.length).toBeGreaterThan(5);
      for (const c of found) expect(plank.has(c.asset)).toBe(true);
      for (const c of mixed)
        for (const f of c.floors.filter((m) => m !== "wood_plank"))
          expect(floorAssets("wood_town", f).has(c.asset), `cap on a ${f} room's floor`).toBe(false);
    });

    it("the cap follows the wall's material when the walls change, whatever the floors", () => {
      const plan = inn();
      for (const lv of plan.levels) for (const a of lv.areas) a.wallStyle = "stone";
      const found = caps(plan);
      expect(found.length).toBeGreaterThan(10);
      const stone = floorAssets("wood_town", "flagstone");
      for (const c of found) expect(stone.has(c.asset)).toBe(true);
    });

    it("an abandoned room beside a kept-up one shares a wall top with it, not the earth cap", () => {
      const R = resolvePlan(loadPlan("purpose-lineup-v1"), palettes);
      const L = R.levels[0] as ResolvedLevel;
      const G = new LevelGrid(L, "generic");
      const shell = shellOf(R, L, "generic");
      const kept = (x: number, y: number): string | undefined => {
        const c = G.cell(x, y);
        if (!c.open) return undefined;
        return L.areas.find((a) => a.id === L.areaIds[c.area - 1])?.abandoned === true ? "abandoned" : "kept";
      };
      // the gap between the kept-up kitchen and the ruined cellar
      const between = (shell?.strips ?? []).filter((s) => {
        const sides = [kept(s.x - 1, s.y), kept(s.x + 1, s.y)];
        return sides.includes("kept") && sides.includes("abandoned");
      });
      expect(between.length).toBeGreaterThan(3);
      for (const s of between) expect(shell?.cells.has(G.index(s.x, s.y))).toBe(false);
      const plank = floorAssets("wood_town", "wood_plank");
      const capped = caps(loadPlan("purpose-lineup-v1"));
      for (const s of between)
        expect(plank.has(capped.find((c) => c.x === s.x && c.y === s.y)?.asset ?? "")).toBe(true);
    });
  });
  describe("a room's condition does not decide what its walls are made of", () => {
    /** The inn with every room abandoned (a ruin word on each), in a theme. */
    const ruinedInn = (theme: string): MapPlan => {
      const plan = inn(theme);
      for (const lv of plan.levels)
        for (const a of lv.areas) if (a.kind === "room") a.tags = [...(a.tags ?? []), "ruined"];
      return plan;
    };
    it("abandoned rooms of a timber building get their walls' tops between them, no earth cap and no skirt", () => {
      const R = resolvePlan(ruinedInn("wood_town"), bundledPalettes());
      const L = R.levels[0] as ResolvedLevel;
      expect(L.areas.filter((a) => a.abandoned === true).length).toBeGreaterThan(3);
      for (const a of L.areas) expect(a.finish).toBe("tidy");
      const shell = shellOf(R, L, "wood_town");
      expect(shell?.cells.size ?? 0).toBe(0);
      expect(shell?.edges.length ?? 0).toBe(0);
      expect(shell?.strips.length ?? 0).toBeGreaterThan(10);
      // still dressed as abandoned: rubble at the wall foot
      expect(L.features.filter((f) => f.generatedBy === "walls").length).toBeGreaterThan(0);
    });
    it("abandoned rooms of a stone dungeon keep the cap and skirt of the rock they are cut into", () => {
      const R = resolvePlan(ruinedInn("stone_dungeon"), bundledPalettes());
      const L = R.levels[0] as ResolvedLevel;
      for (const a of L.areas) expect(a.finish).toBe("rough");
      const shell = shellOf(R, L, "stone_dungeon");
      expect(shell?.cells.size ?? 0).toBeGreaterThan(50);
      expect(shell?.edges.length ?? 0).toBeGreaterThan(0);
      expect(shell?.strips.length ?? 0).toBe(0);
    });
    it("the ruined cellar of the purpose line-up has no cap and no skirt on its outer sides", () => {
      const R = resolvePlan(loadPlan("purpose-lineup-v1"), palettes);
      const L = R.levels[0] as ResolvedLevel;
      const shell = shellOf(R, L, "generic");
      expect(shell?.cells.size ?? 0).toBe(0);
      expect(shell?.edges.length ?? 0).toBe(0);
    });
  });
  it("the same plan in a stone dungeon keeps the cap and skirt", () => {
    const R = resolvePlan(inn("stone_dungeon"), bundledPalettes());
    const shell = shellOf(R, R.levels[0] as ResolvedLevel, "stone_dungeon");
    expect(shell?.cells.size ?? 0).toBeGreaterThan(50);
    expect(shell?.strips.length ?? 0).toBe(0);
  });
  it("the outline has no one-cell notches or holes, no lumps and no cell floating away from its rooms", () => {
    const R = resolvePlan(keep(), bundledPalettes());
    for (const L of R.levels) {
      const shell = shellOf(R, L, "stone_dungeon");
      if (!shell) continue;
      // capped cells by plan coordinates ("x,y")
      const capped = new Set([...shell.cells.values()].map((c) => `${c.x},${c.y}`));
      const has = (x: number, y: number): boolean => capped.has(`${x},${y}`);
      const solid = (x: number, y: number): boolean => {
        const lx = x - L.bounds.x;
        const ly = y - L.bounds.y;
        return (
          lx >= 0 &&
          ly >= 0 &&
          lx < L.bounds.w &&
          ly < L.bounds.h &&
          L.cells.state[ly * L.bounds.w + lx] === CELL.SOLID
        );
      };
      const higher = (x: number, y: number): boolean =>
        R.levels.some((o) => {
          if (o.id === L.id) return false;
          const lx = x - o.bounds.x;
          const ly = y - o.bounds.y;
          return (
            lx >= 0 &&
            ly >= 0 &&
            lx < o.bounds.w &&
            ly < o.bounds.h &&
            o.cells.state[ly * o.bounds.w + lx] === CELL.OPEN
          );
        });
      for (const c of shell.cells.values()) {
        // a thin shell: the cap stands at most three cells from a room
        expect(c.ring).toBeLessThanOrEqual(3);
      }
      // a notch: an uncapped solid cell (not hidden by another level) between capped cells on opposite sides
      for (let y = L.bounds.y; y < L.bounds.y + L.bounds.h; y++)
        for (let x = L.bounds.x; x < L.bounds.x + L.bounds.w; x++) {
          if (has(x, y) || !solid(x, y) || higher(x, y)) continue;
          const bad = (has(x - 1, y) && has(x + 1, y)) || (has(x, y - 1) && has(x, y + 1));
          // (rock-wall clear zones and bare cells are the only legitimate holes; this plan has none)
          expect(bad).toBe(false);
        }
      // no component of fewer than SHELL.minComponent cells
      const seen = new Set<string>();
      for (const k of capped) {
        if (seen.has(k)) continue;
        let n = 0;
        const stack = [k];
        seen.add(k);
        while (stack.length) {
          const q = stack.pop() as string;
          n++;
          const [x, y] = q.split(",").map(Number) as [number, number];
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const t = `${x + dx},${y + dy}`;
              if (capped.has(t) && !seen.has(t)) {
                seen.add(t);
                stack.push(t);
              }
            }
        }
        expect(n).toBeGreaterThanOrEqual(SHELL.minComponent);
      }
    }
  });
});

describe("generator 4 secret door plug", () => {
  const fixture = (): MapPlan => keep();
  it("is one removable wall piece in the wall line, with a GM note naming it", () => {
    const R = resolvePlan(fixture(), bundledPalettes());
    const set = realize(R, palettes, {});
    const mine = set.levels.flatMap((l) => l.placements).filter((p) => p.source.elementId === "o_secret");
    expect(mine).toHaveLength(1);
    const diag = set.diagnostics.filter((d) => d.code === "secret_door_plug");
    expect(diag).toHaveLength(1);
    expect(diag[0]?.message).toContain("between ante and shrine");
    expect(diag[0]?.message).toContain("delete the");
    // generator 3: no note
    const p3 = fixture();
    p3.generator = 3;
    const s3 = realize(resolvePlan(p3, bundledPalettes()), palettes, {});
    expect(s3.diagnostics.filter((d) => d.code === "secret_door_plug")).toHaveLength(0);
  });
  it("verify treats the two rooms as connected through it", () => {
    const plan = fixture();
    const res = compileResolved(resolvePlan(plan, bundledPalettes()), palettes, slabCodec, { plan });
    const errors = res.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
    expect(res.diagnostics.some((d) => d.code === "verify_area_unreachable")).toBe(false);
  });
});

describe("generator 4 review", () => {
  it("floor_accent_tone fires for a pale patch in a dark room, silent once the dais is toned", () => {
    const plan = keep();
    const l1 = plan.levels.find((l) => l.id === "l1");
    l1?.terrain.push({
      id: "pale",
      op: "paint",
      shape: { type: "rect", x: 20, y: 14, w: 4, h: 3 },
      material: "marble",
      layer: "over",
    } as never);
    const codes = reviewDesign(plan, resolvePlan(plan, bundledPalettes()), bundledPalettes()).map(
      (n) => n.code,
    );
    expect(codes).toContain("floor_accent_tone");
    expect(
      reviewDesign(keep(), resolvePlan(keep(), bundledPalettes()), bundledPalettes()).map((n) => n.code),
    ).not.toContain("floor_accent_tone");
  });
});
