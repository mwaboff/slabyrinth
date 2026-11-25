/**
 * Character (resolve/character.ts, switch characterCascade): precedence (a stated value over the subject's words over
 * its parent over the default), the spread draw round a parent (its shares, never two steps, ruins never invented, a
 * next-door twin redrawn), districts that read as themselves without every house alike, a room's own words over its
 * building, determinism, and every consumer moving with the character it reads.
 */
import { describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import type { Area, Building, MapPlan } from "../../../src/contracts/plan";
import type { ResolvedCharacter } from "../../../src/contracts/resolved";
import { characterOrder, propsPer10 } from "../../../src/gen/rooms4/furnish";
import { ROOM_TRAITS } from "../../../src/gen/roomTraits";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import {
  CHARACTER_CONDITIONS,
  CHARACTER_LIGHTS,
  CHARACTER_WEALTHS,
  elementCharacter,
  resolveCharacters,
} from "../../../src/resolve/character";
import { loadPlan } from "../../fixtures";

const pal = bundledPalettes();

const house = (id: string, x: number, y: number, more: Partial<Building> = {}): Building => ({
  id,
  name: "House",
  style: "cottage",
  wings: [{ x, y, w: 5, h: 5 }],
  ...more,
});
const zone = (id: string, x: number, w: number, notes: string): Area => ({
  id,
  kind: "zone",
  name: id,
  notes,
  shape: { type: "rect", x, y: 0, w, h: 40 },
});

/** A plan of one level: zones and houses (a row of houses 7 apart along y 2 in each zone given). */
function planOf(p: {
  seed?: number;
  zones?: Area[];
  structures?: Building[];
  areas?: Area[];
  title?: string;
  theme?: string;
}): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator: 5,
    id: "00000000-0000-4000-8000-000000000001",
    title: p.title ?? "test",
    kind: "outdoor",
    seed: p.seed ?? 1,
    theme: p.theme ?? "wood_town",
    levels: [
      {
        id: "g",
        name: "Ground",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 120, h: 40 },
        base: { type: "ground", material: "grass" },
        areas: [...(p.zones ?? []), ...(p.areas ?? [])],
        openings: [],
        walls: [],
        features: [],
        labels: [],
        terrain: [],
        structures: p.structures ?? [],
      },
    ],
    links: [],
  };
}

const chars = (plan: MapPlan) => {
  const m = resolveCharacters(plan, 0);
  if (!m) throw new Error("characterCascade off");
  return m;
};
const at = (plan: MapPlan, id: string): ResolvedCharacter => {
  const c = chars(plan).get(id);
  if (!c) throw new Error(id);
  return c;
};
const step = <T extends string>(scale: readonly T[], a: T, b: T): number =>
  Math.abs(scale.indexOf(a) - scale.indexOf(b));

/** Houses in a row inside a zone, spaced so none is next door to another (no redraw). */
const row = (prefix: string, x0: number, n: number, gap = 9): Building[] =>
  Array.from({ length: n }, (_, i) => house(`${prefix}${i}`, x0 + (i % 6) * gap, 2 + Math.floor(i / 6) * 9));

describe("character: precedence", () => {
  it("a stated value beats the subject's words, its words beat the parent, the parent beats the default", () => {
    const plan = planOf({
      zones: [zone("slum", 0, 60, "poor, run-down and gloomy")],
      structures: [
        house("stated", 2, 2, { condition: "intact" }),
        house("worded", 12, 2, { notes: "a bright, prosperous, well-kept inn" }),
        house("plain", 22, 2),
        house("outside", 80, 2),
      ],
    });
    const slum = at(plan, "slum");
    expect([slum.light, slum.condition, slum.wealth]).toEqual(["dim", "ramshackle", "poor"]);
    expect(slum.sources).toEqual({ light: "words", condition: "words", wealth: "words" });
    expect(at(plan, "stated").condition).toBe("intact");
    expect(at(plan, "stated").sources.condition).toBe("stated");
    const w = at(plan, "worded");
    expect([w.light, w.condition, w.wealth]).toEqual(["bright", "intact", "wealthy"]);
    expect(w.sources).toEqual({ light: "words", condition: "words", wealth: "words" });
    const p = at(plan, "plain");
    expect(p.parent).toBe("slum");
    expect(p.sources).toEqual({ light: "inherited", condition: "inherited", wealth: "inherited" });
    // outside every zone, under a scene that says nothing: the defaults, undrawn
    const o = at(plan, "outside");
    expect(o.parent).toBe("g");
    expect([o.light, o.condition, o.wealth]).toEqual(["moderate", "intact", "modest"]);
    expect(o.sources).toEqual({ light: "default", condition: "default", wealth: "default" });
  });

  it("a room's own words beat its building: a dim taproom in a bright inn stays dim", () => {
    const plan = planOf({
      structures: [
        house("inn", 2, 2, { notes: "a bright, festive inn", wings: [{ x: 2, y: 2, w: 12, h: 10 }] }),
      ],
      areas: [
        { id: "tap", kind: "room", name: "Dim taproom", shape: { type: "rect", x: 3, y: 3, w: 6, h: 5 } },
        { id: "hall", kind: "room", name: "Hall", shape: { type: "rect", x: 9, y: 3, w: 4, h: 5 } },
      ],
    });
    expect(at(plan, "inn").light).toBe("bright");
    expect(at(plan, "tap").parent).toBe("inn");
    expect(at(plan, "tap").light).toBe("dim");
    expect(at(plan, "tap").sources.light).toBe("words");
    expect(at(plan, "hall").sources.light).toBe("inherited");
  });

  it("is deterministic", () => {
    const plan = loadPlan("two-quarters-v1");
    expect([...chars(plan)]).toEqual([...chars(structuredClone(plan))]);
  });
});

describe("character: the draw round a parent", () => {
  const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
  const drawn = (notes: string): ResolvedCharacter[] =>
    SEEDS.flatMap((seed) => {
      const plan = planOf({ seed, zones: [zone("z", 0, 120, notes)], structures: row("h", 1, 12) });
      return Array.from({ length: 12 }, (_, i) => at(plan, `h${i}`));
    });

  it("draws about 60 % the parent's value and about 20 % a step either way, never two steps", () => {
    const all = drawn("bright, weathered, modest");
    const n = all.length;
    const share = (f: (c: ResolvedCharacter) => boolean) => all.filter(f).length / n;
    expect(share((c) => c.light === "bright")).toBeGreaterThan(0.52);
    expect(share((c) => c.light === "bright")).toBeLessThan(0.68);
    expect(share((c) => c.light === "moderate")).toBeGreaterThan(0.14);
    expect(share((c) => c.light === "flooded")).toBeGreaterThan(0.14);
    expect(share((c) => c.condition === "intact")).toBeGreaterThan(0.1);
    expect(share((c) => c.condition === "ramshackle")).toBeGreaterThan(0.18);
    expect(share((c) => c.wealth === "modest")).toBeGreaterThan(0.57);
    for (const c of all) {
      expect(step(CHARACTER_LIGHTS, c.light, "bright")).toBeLessThanOrEqual(1);
      expect(step(CHARACTER_CONDITIONS, c.condition, "weathered")).toBeLessThanOrEqual(1);
      expect(step(CHARACTER_WEALTHS, c.wealth, "modest")).toBeLessThanOrEqual(1);
    }
  });

  it("never invents a ruin, and clamps at the ends of a scale onto the parent's value", () => {
    const worn = drawn("ramshackle shanties, flooded with light, lavish");
    expect(worn.some((c) => c.condition === "ruined")).toBe(false);
    expect(worn.every((c) => c.light === "flooded" || c.light === "bright")).toBe(true);
    expect(worn.filter((c) => c.light === "flooded").length / worn.length).toBeGreaterThan(0.7);
    const ruins = drawn("the ruined quarter");
    expect(ruins.every((c) => c.condition === "ruined" || c.condition === "ramshackle")).toBe(true);
  });

  it("redraws a building that drew its next-door neighbour's exact triple once", () => {
    let twins = 0;
    let pairs = 0;
    for (const seed of SEEDS) {
      // twelve houses wall to wall (gap 0)
      const plan = planOf({
        seed,
        zones: [zone("z", 0, 120, "dim, weathered, poor")],
        structures: row("h", 1, 12, 5),
      });
      for (let i = 1; i < 6; i++) {
        const a = at(plan, `h${i - 1}`);
        const b = at(plan, `h${i}`);
        pairs++;
        if (a.light === b.light && a.condition === b.condition && a.wealth === b.wealth) twins++;
      }
    }
    // undrawn, a pair is alike 0.6 x 0.6 x 0.65 (about 0.23) of the time; one redraw brings it near 0.23²
    expect(twins / pairs).toBeLessThan(0.15);
  });
});

describe("character: two districts", () => {
  const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);
  const quarters = SEEDS.map((seed) =>
    planOf({
      seed,
      zones: [
        zone("poor", 0, 60, "poor and run-down, gloomy"),
        zone("rich", 60, 60, "rich, well-kept and bright"),
      ],
      structures: [...row("p", 1, 6), ...row("r", 61, 6)],
    }),
  );
  const of = (prefix: string) =>
    quarters.flatMap((plan) => Array.from({ length: 6 }, (_, i) => at(plan, `${prefix}${i}`)));
  const mean = <T extends string>(
    cs: readonly ResolvedCharacter[],
    scale: readonly T[],
    axis: (c: ResolvedCharacter) => T,
  ) => cs.reduce((s, c) => s + scale.indexOf(axis(c)), 0) / cs.length;

  it("a poor run-down quarter is mostly weathered or ramshackle and dim, but its houses are not all alike", () => {
    const poor = of("p");
    const worn = poor.filter((c) => c.condition === "weathered" || c.condition === "ramshackle").length;
    expect(worn / poor.length).toBeGreaterThan(0.9);
    expect(poor.filter((c) => c.light === "dim" || c.light === "dark").length / poor.length).toBeGreaterThan(
      0.75,
    );
    // the variety guarantee: in every quarter of six at least one house differs from the quarter on some axis
    for (const plan of quarters) {
      const z = at(plan, "poor");
      const houses = Array.from({ length: 6 }, (_, i) => at(plan, `p${i}`));
      expect(
        houses.some((c) => c.light !== z.light || c.condition !== z.condition || c.wealth !== z.wealth),
      ).toBe(true);
    }
  });

  it("a rich bright quarter beside it differs on all three axes on average", () => {
    const poor = of("p");
    const rich = of("r");
    expect(
      mean(rich, CHARACTER_LIGHTS, (c) => c.light) - mean(poor, CHARACTER_LIGHTS, (c) => c.light),
    ).toBeGreaterThan(1.5);
    expect(
      mean(poor, CHARACTER_CONDITIONS, (c) => c.condition) -
        mean(rich, CHARACTER_CONDITIONS, (c) => c.condition),
    ).toBeGreaterThan(1.5);
    expect(
      mean(rich, CHARACTER_WEALTHS, (c) => c.wealth) - mean(poor, CHARACTER_WEALTHS, (c) => c.wealth),
    ).toBeGreaterThan(1.5);
  });
});

describe("character: the consumers read it", () => {
  const plan = loadPlan("two-quarters-v1");
  const resolved = resolvePlan(plan, pal);
  const L = resolved.levels[0];
  if (!L) throw new Error("no level");
  const west = ["swan", "goldsmith", "town1", "town2", "town3"];
  const east = ["bucket", "pawn", "hovel1", "hovel2", "hovel3"];
  const sts = (ids: readonly string[]) => (L.structures ?? []).filter((s) => ids.includes(s.id));

  it("records every subject's character on the resolved level", () => {
    for (const id of ["g", "uptown", "rookery", "square", "yard", ...west, ...east])
      expect(elementCharacter(L, id), id).not.toBeNull();
    expect(elementCharacter(L, "uptown")?.wealth).toBe("wealthy");
    expect(elementCharacter(L, "rookery")?.wealth).toBe("poor");
  });

  it("buildings: decay, lit windows and door lights follow condition and light", () => {
    const lit = (ids: readonly string[]) =>
      sts(ids).reduce((s, b) => s + (b.lighting?.lit ?? 0), 0) / ids.length;
    expect(lit(west)).toBeGreaterThan(lit(east) * 2);
    expect(sts(west).filter((s) => (s.condition ?? "intact") === "intact").length).toBeGreaterThanOrEqual(3);
    expect(sts(east).every((s) => s.condition === "weathered")).toBe(true);
    expect(sts(west).filter((s) => s.lighting?.doors === true).length).toBeGreaterThan(
      sts(east).filter((s) => s.lighting?.doors === true).length,
    );
  });

  it("worn is not dark: one house kept or weathered at one light level lights as many windows", () => {
    const one = (condition: "intact" | "weathered") => {
      const p = planOf({ structures: [house("h", 2, 2, { condition, seed: 5, notes: "bright" })] });
      return resolvePlan(p, pal).levels[0]?.structures?.find((s) => s.id === "h")?.lighting?.lit;
    };
    expect(one("weathered")).toBe(one("intact"));
    expect(one("intact")).toBeGreaterThan(0);
  });

  it("treatments: the rich quarter draws more trims and fewer plain walls than the poor", () => {
    const treatOf = (ids: readonly string[]) =>
      (L.arrangements ?? [])
        .filter((a) => a.host !== undefined && ids.includes(a.host))
        .map((a) => a.treatment ?? "");
    const plain = (ids: readonly string[]) =>
      [...new Set(treatOf(ids))].filter((t) => /frame:plain/.test(t)).length;
    const pieces = (ids: readonly string[]) =>
      (L.arrangements ?? [])
        .filter((a) => a.host !== undefined && ids.includes(a.host))
        .reduce((s, a) => s + a.pieces.length, 0);
    expect(pieces(west)).toBeGreaterThan(pieces(east));
    expect(plain(west)).toBeLessThanOrEqual(plain(east));
  });

  it("ground: the rookery's yard is worn, the merchants' square is not", () => {
    const set = realize(resolved, pal);
    const count = (area: string) =>
      (set.levels[0]?.placements ?? []).filter(
        (p) => (p.source.elementId ?? "").includes(area) && /rubble|debris/.test(p.role),
      ).length;
    expect(count("yard")).toBeGreaterThanOrEqual(count("square"));
  });

  it("rooms: the same kind is fuller and messier poor and run down, tidier rich (props, order)", () => {
    const t = ROOM_TRAITS.tavern;
    const c = (
      wealth: ResolvedCharacter["wealth"],
      condition: ResolvedCharacter["condition"],
    ): ResolvedCharacter => ({
      light: "moderate",
      condition,
      wealth,
      tone: "warm",
      sources: { light: "default", condition: "default", wealth: "default" },
    });
    expect(propsPer10(t, c("poor", "weathered"))).toBeLessThan(propsPer10(t, c("lavish", "intact")));
    expect(characterOrder("lived", c("poor", "ramshackle"))).toBe("working");
    expect(characterOrder("lived", c("lavish", "intact"))).toBe("tidy");
    expect(characterOrder("lived", c("modest", "intact"))).toBe("lived");
  });
});
