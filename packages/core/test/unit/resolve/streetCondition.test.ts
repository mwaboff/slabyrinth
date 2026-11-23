/**
 * The street and condition round (generator 5) on the varied-street-v1 and condition-street-v1 fixtures, each a fault
 * the owner's screenshots showed, held by the switch that fixes it (the switch off rebuilds the fault):
 *   twinnedPairs   a guardian pair is one piece twinned, both standing or neither (resolve/recipes/threshold.ts).
 *   roofKitFacts   no hip in a kit whose corner is a spiked tip (resolve/roofKits.ts); with roofPatches, a roof patch
 *                  is a repair of the same roof or none (resolve/building/wear.ts, compile/realize/structures/roofPiece.ts).
 *   leanUnderMain  a lean-to stands under the house's ridge (resolve/structureVariety.ts, resolve/structure.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { planPointOf } from "../../../src/arrange";
import { realize } from "../../../src/compile";
import { CELL_FLAG } from "../../../src/contracts/resolved";
import { LevelAnchors, ZONE } from "../../../src/resolve/anchors";
import {
  COVER_RASTER,
  coverKind,
  coveredSamples,
  sampleCell,
  type CoverShape,
} from "../../../src/util/visibleCover";
import type { MapPlan } from "../../../src/contracts/plan";
import type { ResolvedLevel, ResolvedPlan, ResolvedStructure } from "../../../src/contracts/resolved";
import { wallStyleInfo } from "../../../src/gen/wallStyles";
import { bundledPalettes } from "../../../src/palette";
import { resolveView } from "../../../src/palette/view";
import {
  GENERATOR_PROFILES,
  generatorProfile,
  type GeneratorProfile,
  type SwitchName,
} from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { ArrangementRecords } from "../../../src/resolve/level/arrangements";
import { runRecipes } from "../../../src/resolve/recipes/engine";
import { leanToShelter } from "../../../src/resolve/recipes/condition";
import { approachLights, guardianPair } from "../../../src/resolve/recipes/threshold";
import { ROOF_KITS, roofTone } from "../../../src/resolve/roofKits";
import { roofInfo } from "../../../src/resolve/roofTypes";
import { loadPlan } from "../../fixtures";
import { sweepSeed } from "../../sweep/seeds";
import { forced } from "../../fixtures/treatments";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));
/** Generator 5 with one switch off, for the rest of the test (restored after it). */
const without = (name: SwitchName): void => {
  (P5 as Record<string, unknown>)[name] = false;
};

/** A fixture's first level, resolved, without its arrangements (a recipe run's input). */
function bareLevel(plan: MapPlan): ResolvedLevel {
  const L = resolvePlan(plan, pal).levels[0] as ResolvedLevel;
  const bare: ResolvedLevel = { ...L };
  delete bare.arrangements;
  return bare;
}

/** Piece names of an element's placements (element ids starting `prefix`). */
function namesOf(r: ResolvedPlan, prefix: string): string[] {
  const set = realize(r, pal, {});
  return (set.levels[0]?.placements ?? [])
    .filter((p) => (p.source.elementId ?? "").startsWith(prefix))
    .map((p) => set.placed.get(p)?.name ?? "");
}

/** The highest top of an element's placements. */
function topOf(r: ResolvedPlan, prefix: string): number {
  const set = realize(r, pal, {});
  return Math.max(
    ...(set.levels[0]?.placements ?? [])
      .filter((p) => (p.source.elementId ?? "").startsWith(prefix))
      .map((p) => set.placed.get(p)?.box.max.y ?? -Infinity),
  );
}

describe("twinnedPairs: a guardian pair is one piece twinned", () => {
  const plan = loadPlan("varied-street-v1");
  const bare = bareLevel(plan);
  const run = (profile: GeneratorProfile) =>
    runRecipes(bare, new ArrangementRecords(), {
      planSeed: plan.seed,
      profile,
      palette: resolveView(plan, pal),
      budget: 1e6,
      families: forced({ threshold: { guardianPair: "pair", approachLights: "pair" } }),
      recipes: [guardianPair, approachLights],
    }).attached;

  it("stands both of a pair, the same piece, or neither (never one half where the other side is in the way)", () => {
    const on = run(generatorProfile(5));
    expect(on.length).toBeGreaterThan(0);
    for (const a of on) {
      expect(a.pieces).toHaveLength(2);
      expect(a.pieces[0]?.asset).toBe(a.pieces[1]?.asset);
      expect(a.pieces[0]?.yaw).toBe(a.pieces[1]?.yaw);
      // mirrored about the door's axis
      expect((a.pieces[0]?.x ?? 0) + (a.pieces[1]?.x ?? 0)).toBeCloseTo(0, 6);
      expect(a.pieces[0]?.z).toBeCloseTo(a.pieces[1]?.z ?? NaN, 6);
    }
    // without the switch the manor's door (its way to the lane runs past one side) keeps a lone guardian
    const off = run({ ...generatorProfile(5), twinnedPairs: false });
    expect(off.some((a) => a.pieces.length === 1)).toBe(true);
  });
});

describe("the roof-kit facts", () => {
  const roles = pal.palettes.generic?.roles ?? {};
  const variants = (role: string) => roles[role]?.variants ?? [];
  it.each(Object.entries(ROOF_KITS))(
    "%s: its cap, slopes and worn pieces are what the palette has",
    (kit, f) => {
      expect(variants(`roof.${kit}.cap`).length + variants(`roof.${kit}.flat`).length > 0).toBe(f.ownCap);
      expect(variants(`roof.${kit}.slope`).length > 0).toBe(f.pitched);
      const worn = Object.entries(roles).some(
        ([role, r]) => role.startsWith(`roof.${kit}.`) && r.variants.some((v) => v.variant === "broken"),
      );
      expect(worn).toBe(f.weathered);
      if (f.cornerTip) expect(variants(`roof.${kit}.corner`).length).toBeGreaterThan(0);
    },
  );
});

describe("roofKitFacts: no spikes up a hip, patches that read as repairs", () => {
  it("builds the manor's hip in the tipped slate kit as a gable; without the switch its hips carry the tips", () => {
    const plan = loadPlan("varied-street-v1");
    const tips = (): number =>
      namesOf(resolvePlan(plan, pal), "manor~").filter((n) => /corner out tip/i.test(n)).length;
    expect(tips()).toBe(0);
    without("roofKitFacts");
    // (the manor drew a flat keep top before roofFormsFit; built as then, it drew its hip)
    without("roofFormsFit");
    expect(tips()).toBeGreaterThan(8);
  });

  const plan = loadPlan("condition-street-v1");
  /** The condition street with every house roofed in `kit`. */
  const inKit = (kit: string): MapPlan => ({
    ...plan,
    levels: plan.levels.map((L) => ({
      ...L,
      structures: (L.structures ?? []).map((s) =>
        s.kind === "enclosure" ? s : { ...s, roof: { type: "gable" as const, style: kit } },
      ),
    })),
  });

  // (roofPatches: a patch reads as a repair of the same roof; the earlier patch in another kit was folded into it)
  it("patches a slate roof in its own worn pieces, in small groups, never in orange village tiles", () => {
    const r = resolvePlan(inKit("slate"), pal);
    const shack = r.levels[0]?.structures?.find((s) => s.id === "shack");
    expect(shack?.roofPatch?.length ?? 0).toBeGreaterThan(4);
    const names = namesOf(r, "shack~");
    expect(names.some((n) => /broken/i.test(n))).toBe(true);
    expect(names.some((n) => /village/i.test(n))).toBe(false);
  });

  it("leaves a village roof unpatched (no kit reads like it) before closedWornRoofs (which patches it in another kit)", () => {
    without("closedWornRoofs");
    const shackOf = (r: ResolvedPlan) => r.levels[0]?.structures?.find((s) => s.id === "shack");
    expect(shackOf(resolvePlan(inKit("village"), pal))?.roofPatch).toBeUndefined();
  });

  it("patches only a worn or worse building (the kept house has none)", () => {
    const r = resolvePlan(inKit("slate"), pal);
    expect(r.levels[0]?.structures?.find((s) => s.id === "kept")?.roofPatch).toBeUndefined();
  });
});

/** The varied street at sweep seed `i` (the buildings' own seeds dropped, so each draws anew), in a theme. */
function streetAt(i: number, theme: string): MapPlan {
  const plan = loadPlan("varied-street-v1");
  return {
    ...plan,
    theme,
    seed: sweepSeed(i),
    levels: plan.levels.map((L) => ({
      ...L,
      structures: (L.structures ?? []).map((s) => {
        const rest = { ...s } as typeof s & { seed?: number };
        delete rest.seed;
        return rest;
      }),
    })),
  };
}

/** What a built building shows the street, read off the resolved structure (not the draw). */
function builtLook(s: ResolvedStructure): { wall: string; roof: string; form: string; storeys: number } {
  const wall = (w: string | null): string => (wallStyleInfo(w)?.settingKit === true ? "theme" : (w ?? "-"));
  const flat = roofInfo(s.roof.type)?.pitched !== true;
  return {
    wall:
      s.storeys.length > 1
        ? `${wall(s.storeys[0]?.walls ?? null)}/${wall(s.storeys[s.storeys.length - 1]?.walls ?? null)}`
        : wall(s.storeys[0]?.walls ?? null),
    roof: flat ? `flat:${s.roof.style}` : roofTone(s.roof.style),
    form: s.roof.type,
    storeys: s.storeys.length,
  };
}

/**
 * Pairs of drawn buildings (of `ids` when given), neighbours (within twelve cells) or of one built wall, apart on
 * fewer than two axes.
 */
function unreadablePairs(r: ResolvedPlan, ids?: readonly string[]): number {
  const bs = (r.levels[0]?.structures ?? []).filter(
    (s) => s.kind === "building" && s.design && (!ids || ids.includes(s.id)),
  );
  const box = (s: ResolvedStructure) => {
    const xs = s.cells.map((c) => c[0]);
    const ys = s.cells.map((c) => c[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  let n = 0;
  for (let i = 0; i < bs.length; i++)
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i] as ResolvedStructure;
      const b = bs[j] as ResolvedStructure;
      const p = box(a);
      const q = box(b);
      const near = p.x0 - 12 <= q.x1 && q.x0 - 12 <= p.x1 && p.y0 - 12 <= q.y1 && q.y0 - 12 <= p.y1;
      const la = builtLook(a);
      const lb = builtLook(b);
      const apart =
        (la.wall !== lb.wall ? 1 : 0) +
        (la.roof !== lb.roof ? 1 : 0) +
        (la.form !== lb.form ? 1 : 0) +
        (la.storeys !== lb.storeys ? 1 : 0);
      if ((near || la.wall === lb.wall) && apart < 2) n++;
    }
  return n;
}

describe("readableNeighbours: neighbours and buildings of one wall differ on two readable axes", () => {
  const SEEDS = [0, 1, 2, 3, 4, 5];
  const total = (theme: string): number =>
    SEEDS.reduce((s, i) => s + unreadablePairs(resolvePlan(streetAt(i, theme), pal)), 0);
  it.each(["wood_town", "city"])(
    "%s: over seeds, far fewer look-alike pairs than without the switch",
    (theme) => {
      const on = total(theme);
      without("readableNeighbours");
      const off = total(theme);
      expect(off).toBeGreaterThan(6);
      // (roofFormsFit took the deep sheds and flat tops out of a timber village: the odd forms that were its roof-form
      // axis, so wood_town now has fewer ways to differ; 20 of 51 over these seeds, from about a quarter)
      expect(on).toBeLessThanOrEqual(off / (theme === "wood_town" ? 2.4 : 4));
    },
    30_000, // two streets per seed resolved: 3 to 3.5 s locally under a parallel run; Windows CI runs about twice that
  );
  it("draws the fixture's baker, tavern and corner house apart (they were one stone house with an orange roof)", () => {
    const three = ["baker", "tavern", "corner"];
    for (const theme of ["wood_town", "city"]) {
      const r = resolvePlan({ ...loadPlan("varied-street-v1"), theme }, pal);
      expect(unreadablePairs(r, three)).toBe(0);
    }
    without("readableNeighbours");
    expect(unreadablePairs(resolvePlan(loadPlan("varied-street-v1"), pal), three)).toBeGreaterThan(0);
  });
});

describe("themeOwnRange: a theme's own walls and roofs first", () => {
  const SEEDS = [0, 1, 2, 3, 4, 5];
  const count = (theme: string, test: (s: ResolvedStructure) => boolean): number =>
    SEEDS.reduce(
      (n, i) =>
        n +
        (resolvePlan(streetAt(i, theme), pal).levels[0]?.structures ?? []).filter(
          (s) => s.kind === "building" && s.design && test(s),
        ).length,
      0,
    );
  const cityFlat = (s: ResolvedStructure): boolean => s.roof.type === "flat" && s.roof.style === "city";
  const borrowedStone = (s: ResolvedStructure): boolean => s.storeys.some((q) => q.walls === "stone");
  it("roofs part of the city's houses flat in its own kit; wood_town (no flat kit of its own) none", () => {
    expect(count("city", cityFlat)).toBeGreaterThan(8);
    expect(count("wood_town", cityFlat)).toBe(0);
    without("themeOwnRange");
    expect(count("city", cityFlat)).toBe(0);
  }, 30_000); // 18 streets resolved: about 4.5 s locally under a parallel run; Windows CI runs about twice that
  it("builds fewer houses in the borrowed castle stone than without the switch", () => {
    const on = count("wood_town", borrowedStone);
    without("themeOwnRange");
    expect(on).toBeLessThan(count("wood_town", borrowedStone));
  }, 30_000); // 12 streets resolved: about 2.8 s locally under a parallel run
});

describe("chimneyScale: a chimney's foot fits its face", () => {
  it("stands a one-wide stack on a face under nine cells; without the switch a three-wide foot", () => {
    const plan = loadPlan("varied-street-v1");
    /** Chimneys of buildings whose chimney face is under nine cells, by the columns their pieces stand in. */
    const widest = (): number => {
      const r = resolvePlan(plan, pal);
      const set = realize(r, pal, {});
      let most = 0;
      for (const s of r.levels[0]?.structures ?? []) {
        for (const c of s.chimneys) {
          const line = c.side === "N" || c.side === "S" ? 1 : 0;
          const on = s.cells.filter((q) => q[line] === c.at[line]).map((q) => q[1 - line] ?? 0);
          if (Math.max(...on) - Math.min(...on) + 1 >= 9) continue;
          const cols = new Set(
            (set.levels[0]?.placements ?? [])
              .filter((p) => p.source.elementId === `${s.id}~chimney`)
              .map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`),
          );
          most = Math.max(most, cols.size);
        }
      }
      return most;
    };
    expect(widest()).toBe(1);
    without("chimneyScale");
    expect(widest()).toBe(3);
  });
});

describe("layeredGround: cover gathered where ground meets something, litter only near use", () => {
  /** The green's cover, by what is seen: in its edge band (a step from an edge) and its open middle. */
  function cover(theme: string): { edge: number; middle: number; farLitter: number } {
    const plan = { ...loadPlan("varied-street-v1"), theme };
    const r = resolvePlan(plan, pal);
    const L = r.levels[0] as ResolvedLevel;
    const view = resolveView(plan, pal);
    const zone = new LevelAnchors(L).of("zone").find((z) => z.area === "green");
    if (!zone) throw new Error("no green");
    const g = new LevelAnchors(L).grid;
    const open = new Set(
      zone.cells
        .filter(([x, y]) => {
          const f = L.cells.flags[g.index(x, y)] ?? 0;
          return (f & CELL_FLAG.PATH) === 0 && (zone.classAt(x, y) & (ZONE.LANE | ZONE.DOOR)) === 0;
        })
        .map(([x, y]) => `${x},${y}`),
    );
    const used = zone.cells.filter(
      ([x, y]) =>
        ((L.cells.flags[g.index(x, y)] ?? 0) & CELL_FLAG.PATH) !== 0 ||
        (zone.classAt(x, y) & (ZONE.LANE | ZONE.DOOR)) !== 0,
    );
    const shapes: CoverShape[] = [];
    let farLitter = 0;
    for (const a of L.arrangements ?? []) {
      if (a.recipe !== "layeredGround" || a.host !== "green") continue;
      for (const p of a.pieces) {
        const v = view.roles
          .resolve(view.roles.paletteTheme(p.palette), p.role)
          .resolution?.variants.find((q) => q.wanted === p.asset);
        if (!v) continue;
        const [x, y] = planPointOf(a.at, a.turn, p.x, p.z);
        shapes.push({
          x,
          y,
          sx: v.geom.size.x,
          sz: v.geom.size.z,
          yaw: a.turn + p.yaw,
          kind: coverKind(p.role, v.geom.size.y),
        });
        // a flat piece more than four cells (two of reach, a cluster's spread) from any door's apron, lane or path
        if (
          v.geom.size.y <= 0.17 &&
          !used.some(([ux, uy]) => Math.max(Math.abs(ux + 0.5 - x), Math.abs(uy + 0.5 - y)) <= 4)
        )
          farLitter++;
      }
    }
    let edge = 0;
    let middle = 0;
    for (const s of coveredSamples(shapes, (cx, cy) => open.has(`${cx},${cy}`))) {
      const [cx, cy] = sampleCell(s);
      if (zone.edgeAt(cx, cy) <= 1) edge++;
      else middle++;
    }
    const cells = [...open].map((k) => k.split(",").map(Number) as [number, number]);
    const edgeCells = cells.filter(([x, y]) => zone.edgeAt(x, y) <= 1).length;
    const per = COVER_RASTER * COVER_RASTER;
    return { edge: edge / (per * edgeCells), middle: middle / (per * (cells.length - edgeCells)), farLitter };
  }

  it("covers the edge band several times as thickly as the open middle", () => {
    const on = cover("wood_town");
    expect(on.edge).toBeGreaterThan(0.25);
    expect(on.middle).toBeLessThan(0.1);
    expect(on.edge / on.middle).toBeGreaterThan(3.5);
  });

  it("lays the city's litter only near its doors, lanes and paths", () => {
    expect(cover("city").farLitter).toBe(0);
  });
});

describe("raggedRuins: a breach that reads as decay, not a slot", () => {
  const plan = loadPlan("condition-street-v1");
  const ruinOf = (id: string) => resolvePlan(plan, pal).levels[0]?.structures?.find((s) => s.id === id);

  it("opens the roof right across over the breach only, partway over its tapers; without the switch the whole span", () => {
    const on = ruinOf("ruin");
    const bay = on?.ruin?.bays?.[0];
    expect(bay).toBeDefined();
    const depth = 6;
    const holes = on?.ruin?.roofHoles?.length ?? 0;
    expect(holes).toBeGreaterThanOrEqual((bay?.width ?? 0) * depth);
    without("raggedRuins");
    const off = ruinOf("ruin")?.ruin?.roofHoles?.length ?? 0;
    expect(holes).toBeLessThan(off);
    // (without it a two-cell breach took six of the house's nine columns of roof)
    expect(off).toBeGreaterThanOrEqual(5 * depth);
  });

  it("steps the breach's sides down over two cells each side", () => {
    const st = ruinOf("ruin");
    const bay = st?.ruin?.bays?.[0];
    if (!st?.ruin || !bay) throw new Error("no bay");
    const lowered = st.ruin.columns.filter((c) => c.side === bay.side && c.top < c.full - 1e-6).length;
    expect(lowered).toBeGreaterThanOrEqual(bay.width + 4);
  });

  it("piles more rubble at a wide breach, and leaves no porch post on a house whose roof is gone", () => {
    const rubble = (): number =>
      (resolvePlan(plan, pal).levels[0]?.arrangements ?? [])
        .filter((a) => a.recipe === "breachRubble" && a.host === "fallen")
        .reduce((n, a) => n + a.pieces.length, 0);
    const posts = (): number => namesOf(resolvePlan(plan, pal), "fallen~porch").length;
    const on = { rubble: rubble(), posts: posts() };
    expect(on.posts).toBe(0);
    without("raggedRuins");
    expect(posts()).toBeGreaterThan(0);
    expect(on.rubble).toBeGreaterThan(rubble());
  });
});

describe("ramshackleSigns: worn and ramshackle read apart", () => {
  const plan = loadPlan("condition-street-v1");
  const shelters = (profile: GeneratorProfile) =>
    runRecipes(bareLevel(plan), new ArrangementRecords(), {
      planSeed: plan.seed,
      profile,
      palette: resolveView(plan, pal),
      budget: 1e6,
      families: forced({ addition: { leanToShelter: "one" } }),
      recipes: [leanToShelter],
    }).attached;

  it("builds one lean-to shelter per building, a roof of its own kit over head height on posts, off the street face", () => {
    const on = shelters(generatorProfile(5));
    const hosts = on.map((a) => a.host);
    expect(new Set(hosts).size).toBe(hosts.length);
    expect(on.length).toBeGreaterThan(3);
    for (const a of on) {
      const roof = a.pieces.filter((p) => p.role.startsWith("roof."));
      expect(roof.length).toBeGreaterThan(0);
      const st = resolvePlan(plan, pal).levels[0]?.structures?.find((s) => s.id === a.host);
      for (const p of roof) expect(p.role).toBe(`roof.${st?.roof.style}.slope`);
      // square: quarter turns only
      for (const p of a.pieces) expect(p.yaw % 90).toBe(0);
      expect(a.mount).toBe("wall");
    }
    expect(shelters({ ...generatorProfile(5), ramshackleSigns: false })).toHaveLength(0);
  });

  it("draws the shelter for a ramshackle building only, never a worn or kept one", () => {
    const r = resolvePlan(plan, pal);
    const states = new Map(
      (r.levels[0]?.arrangements ?? []).filter((a) => a.recipe === "leanToShelter").map((a) => [a.host, 1]),
    );
    expect(states.has("worn")).toBe(false);
    expect(states.has("kept")).toBe(false);
  });

  it("boards up most of a ramshackle house's windows and few of a worn one's; without the switch a third of each", () => {
    const boarded = (id: string): number =>
      resolvePlan(plan, pal).levels[0]?.structures?.find((s) => s.id === id)?.ruin?.weather?.boarded.length ??
      0;
    const on = { worn: boarded("worn"), shack: boarded("shack") };
    expect(on.shack).toBeGreaterThanOrEqual(on.worn * 2);
    without("ramshackleSigns");
    expect(boarded("shack")).toBe(boarded("worn"));
  });
});

describe("sacredReads: a shrine reads as a shrine", () => {
  const plan = loadPlan("condition-street-v1");
  it("raises the shrine on a base with steps, centres its door and leaves out its chimney; without the switch a cottage", () => {
    const shrine = () => resolvePlan(plan, pal).levels[0]?.structures?.find((s) => s.id === "shrine");
    const on = shrine();
    expect(on?.plinth).toBeDefined();
    expect(on?.chimneys).toHaveLength(0);
    without("sacredReads");
    const off = shrine();
    expect(off?.plinth).toBeUndefined();
    expect(off?.chimneys.length).toBeGreaterThan(0);
  });
});

describe("leanUnderMain: a lean-to stands under the house's ridge", () => {
  it("keeps the workshop's lean-to a tile under the main roof; without the switch it rises over it", () => {
    const plan = loadPlan("varied-street-v1");
    const gap = (): number => {
      const r = resolvePlan(plan, pal);
      return topOf(r, "workshop~roof") - topOf(r, "workshop~lean~roof");
    };
    expect(gap()).toBeGreaterThanOrEqual(1);
    without("leanUnderMain");
    expect(gap()).toBeLessThan(0);
  });
});
