/**
 * A place's stated character (plan fields `light`, `condition`, `wealth` on a level, an area and a building; generator
 * 5, switch `statedCharacter`, resolve/character.ts): a stated value wins over the words at every scope and is the value
 * what is inside varies from; a child's own stated value beats its parent's; a stated ruined room or level goes the way
 * the word "ruined" does; a dim room the plan states is not faulted for its darkness; the resolver's scales are the
 * contract's; generators 1 to 4 ignore the fields byte for byte and build a ramshackle building as weathered.
 */
import { describe, expect, it } from "vitest";
import type {
  Area,
  Building,
  Level,
  MapPlan,
  PlaceCondition,
  PlaceLight,
  PlaceWealth,
} from "../../../src/contracts/plan";
import type {
  CharacterCondition,
  CharacterLight,
  CharacterWealth,
  ResolvedCharacter,
  ResolvedPlan,
} from "../../../src/contracts/resolved";
import { classifyRoom } from "../../../src/gen/roomPurpose";
import { bundledPalettes } from "../../../src/palette";
import { STRUCTURE_ONLY, validatePlan } from "../../../src/plan";
import { resolvePlan } from "../../../src/resolve";
import { CHARACTER_LIGHTS, elementCharacter, resolveCharacters } from "../../../src/resolve/character";
import { reviewDesign } from "../../../src/review";
import { outlineView } from "../../../src/text";
import { goldenRecord } from "../../golden/goldenRecord";
import { loadPlan, type StoredPlan } from "../../fixtures";
import { dungeonPlan } from "../../fixtures/planBuilder";

const pal = bundledPalettes();
const SLOW = 30_000;

const house = (id: string, x: number, y: number, more: Partial<Building> = {}): Building => ({
  id,
  name: "House",
  style: "cottage",
  wings: [{ x, y, w: 5, h: 5 }],
  ...more,
});
const rect = (x: number, y: number, w: number, h: number): Area["shape"] => ({ type: "rect", x, y, w, h });

/** One outdoor level of zones, areas and houses (generator 5 unless asked). */
function planOf(p: {
  title?: string;
  level?: Partial<Level>;
  areas?: Area[];
  structures?: Building[];
  generator?: MapPlan["generator"];
}): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator: p.generator ?? 5,
    id: "00000000-0000-4000-8000-000000000001",
    title: p.title ?? "test",
    kind: "outdoor",
    seed: 1,
    theme: "wood_town",
    levels: [
      {
        id: "g",
        name: "Ground",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 120, h: 40 },
        base: { type: "ground", material: "grass" },
        areas: p.areas ?? [],
        openings: [],
        walls: [],
        features: [],
        labels: [],
        terrain: [],
        structures: p.structures ?? [],
        ...p.level,
      },
    ],
    links: [],
  };
}

const charsOf = (plan: MapPlan, li = 0) => {
  const m = resolveCharacters(plan, li);
  if (!m) throw new Error("characterCascade off");
  return m;
};
const at = (plan: MapPlan, id: string, li = 0): ResolvedCharacter => {
  const c = charsOf(plan, li).get(id);
  if (!c) throw new Error(id);
  return c;
};
const triple = (c: ResolvedCharacter) => [c.light, c.condition, c.wealth];

describe("stated character: the contract's scales are the resolver's", () => {
  it("the plan's lists and the resolved character's types are one scale, both ways", () => {
    type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const light: Same<PlaceLight, CharacterLight> = true;
    const condition: Same<PlaceCondition, CharacterCondition> = true;
    const wealth: Same<PlaceWealth, CharacterWealth> = true;
    expect([light, condition, wealth]).toEqual([true, true, true]);
  });

  it("an unknown value is refused, the message listing the allowed ones", () => {
    for (const generator of [1, 4, 5] as const) {
      const plan = planOf({ generator, areas: [{ id: "r", kind: "zone", shape: rect(0, 0, 9, 9) }] });
      (plan.levels[0]?.areas[0] as unknown as Record<string, unknown>)["light"] = "gloomy";
      const issue = validatePlan(plan, STRUCTURE_ONLY).issues.find(
        (i) => i.path === "/levels/0/areas/0/light",
      );
      expect(issue?.code).toBe("schema");
      expect(issue?.hint).toContain(`valid: ${CHARACTER_LIGHTS.join(", ")}`);
    }
  });
});

describe("stated character: the fixture where every scope's words say otherwise (stated-character-v1)", () => {
  const plan = loadPlan("stated-character-v1");
  const li = (id: string) => plan.levels.findIndex((l) => l.id === id);
  const g = li("g");
  const w = li("workings");

  it("the stated value wins at every scope, recorded as stated", () => {
    // a dark title and level name, stated bright
    expect([at(plan, "g", g).light, at(plan, "g", g).sources.light]).toEqual(["bright", "stated"]);
    expect([at(plan, "workings", w).light, at(plan, "workings", w).sources.light]).toEqual([
      "bright",
      "stated",
    ]);
    // a poor quarter (its words) with one house stated lavish
    expect(at(plan, "slums", g).wealth).toBe("poor");
    expect([at(plan, "gilded", g).wealth, at(plan, "gilded", g).sources.wealth]).toEqual([
      "lavish",
      "stated",
    ]);
    // a ramshackle house: its character, and a shell built as weathered
    expect([at(plan, "shack", g).condition, at(plan, "shack", g).sources.condition]).toEqual([
      "ramshackle",
      "stated",
    ]);
    // a hall its notes call dark and grimy, stated bright and intact
    expect(triple(at(plan, "hall", g)).slice(0, 2)).toEqual(["bright", "intact"]);
    // a dark office and a weathered bunkroom in bright, intact workings
    expect([at(plan, "office", w).light, at(plan, "office", w).sources.light]).toEqual(["dark", "stated"]);
    expect([at(plan, "bunks", w).condition, at(plan, "bunks", w).sources.condition]).toEqual([
      "weathered",
      "stated",
    ]);
  });

  it("without the fields the words decide (the same plan, every field taken out)", () => {
    const bare = structuredClone(plan);
    for (const L of bare.levels) {
      delete L.light;
      delete L.condition;
      for (const a of L.areas) {
        delete a.light;
        delete a.condition;
      }
      for (const st of L.structures ?? [])
        if (st.kind !== "enclosure") {
          delete st.light;
          delete st.wealth;
        }
    }
    expect(at(bare, "g", g).light).toBe("dark"); // "The Lost Mine", "Forgotten Row"
    expect(at(bare, "hall", g).sources.light).not.toBe("stated");
  });

  it(
    "builds: the ramshackle house stands whole, as weathered, and the dark office is drawn dark",
    { timeout: SLOW },
    () => {
      const r = resolvePlan(plan, pal);
      const shack = r.levels[g]?.structures?.find((s) => s.id === "shack");
      expect(shack?.condition).toBe("weathered");
      expect(r.levels[w]?.areas.find((a) => a.id === "office")?.lightLevel).toBe(0);
    },
  );
});

describe("stated character: inheritance and precedence", () => {
  const zone = (id: string, x: number, more: Partial<Area> = {}): Area => ({
    id,
    kind: "zone",
    name: "Quarter",
    shape: rect(x, 0, 60, 40),
    ...more,
  });
  const row = (prefix: string, x0: number, n: number): Building[] =>
    Array.from({ length: n }, (_, i) => house(`${prefix}${i}`, x0 + (i % 6) * 9, 2 + Math.floor(i / 6) * 9));

  it("what is inside a stated place takes it as its parent value and varies a step at most", () => {
    const plan = planOf({
      areas: [zone("q", 0, { light: "dim", condition: "weathered", wealth: "wealthy" })],
      structures: row("h", 1, 24),
    });
    const q = at(plan, "q");
    expect(q.sources).toEqual({ light: "stated", condition: "stated", wealth: "stated" });
    const houses = row("h", 1, 24).map((h) => at(plan, h.id));
    for (const c of houses) {
      expect(c.parent).toBe("q");
      expect(c.sources).toEqual({ light: "inherited", condition: "inherited", wealth: "inherited" });
    }
    const near = (scale: readonly string[], a: string, b: string) =>
      Math.abs(scale.indexOf(a) - scale.indexOf(b)) <= 1;
    expect(houses.every((c) => near(CHARACTER_LIGHTS, c.light, "dim"))).toBe(true);
    // the stated value is the commonest among them (the spread's middle share)
    const commonest = (vs: string[]): string =>
      [...new Set(vs)].sort(
        (a, b) => vs.filter((v) => v === b).length - vs.filter((v) => v === a).length,
      )[0] ?? "";
    expect(commonest(houses.map((c) => c.wealth))).toBe("wealthy");
    expect(commonest(houses.map((c) => c.light))).toBe("dim");
    expect(commonest(houses.map((c) => c.condition))).toBe("weathered");
  });

  it("a stated level is the scene its zones and houses draw from", () => {
    const plan = planOf({ level: { wealth: "lavish" }, structures: row("h", 1, 6) });
    expect([at(plan, "g").wealth, at(plan, "g").sources.wealth]).toEqual(["lavish", "stated"]);
    for (const h of row("h", 1, 6)) expect(at(plan, h.id).sources.wealth).toBe("inherited");
  });

  it("a child's own stated value beats its parent's, at each scope", () => {
    const plan = planOf({
      level: { light: "bright" },
      areas: [
        zone("q", 0, { light: "dark", wealth: "poor" }),
        // rooms in the hall's plot: their parent is the hall
        { id: "dark_room", kind: "room", name: "Kitchen", light: "dark", shape: rect(31, 3, 3, 3) },
        { id: "worn_room", kind: "room", name: "Bedroom", condition: "weathered", shape: rect(34, 3, 3, 3) },
      ],
      structures: [
        house("lavish", 2, 2, { wealth: "lavish", light: "bright" }),
        house("hall", 31, 2, {
          light: "bright",
          condition: "intact",
          wings: [{ x: 31, y: 2, w: 7, h: 5 }],
        }),
      ],
    });
    expect(at(plan, "q").light).toBe("dark");
    expect(triple(at(plan, "lavish"))).toEqual(["bright", at(plan, "lavish").condition, "lavish"]);
    expect(at(plan, "lavish").sources.light).toBe("stated");
    expect(at(plan, "dark_room").parent).toBe("hall");
    expect([at(plan, "dark_room").light, at(plan, "dark_room").sources.light]).toEqual(["dark", "stated"]);
    expect([at(plan, "worn_room").condition, at(plan, "worn_room").sources.condition]).toEqual([
      "weathered",
      "stated",
    ]);
  });

  it("a stated value beats the words; a building's intact or weathered keeps its released meaning", () => {
    const plan = planOf({
      areas: [
        {
          id: "yard",
          kind: "courtyard",
          name: "Ramshackle yard",
          condition: "intact",
          shape: rect(60, 2, 6, 6),
        },
        { id: "lit", kind: "room", name: "Gloomy cellar", light: "bright", shape: rect(70, 2, 4, 4) },
      ],
      structures: [house("shed", 2, 2, { name: "Ramshackle shed", condition: "intact" })],
    });
    expect(at(plan, "yard").condition).toBe("intact");
    expect(at(plan, "lit").light).toBe("bright");
    // Building.condition intact with ramshackle words: ramshackle, as gen/buildingCondition.ts always read it
    expect(at(plan, "shed").condition).toBe("ramshackle");
  });
});

describe("stated character: a stated ruin goes the words' way", () => {
  it("a room stated ruined is wreckage as 'Ruined kitchen' is; stated short of it, it is not", () => {
    const words = classifyRoom({ name: "Ruined kitchen" }, { kinds: true });
    const stated = classifyRoom({ name: "Kitchen", condition: "ruined" }, { kinds: true, stated: true });
    expect(stated).toEqual(words);
    expect(words.purpose).toBe("ruin");
    expect(
      classifyRoom({ name: "Collapsed hall", condition: "intact" }, { kinds: true, stated: true }).purpose,
    ).toBe("dining");
    // without the switch the field is not read
    expect(classifyRoom({ name: "Kitchen", condition: "ruined" }, { kinds: true }).purpose).toBe("kitchen");
  });

  it("resolved: the stated ruined room is a ruin at generator 5 and a kitchen at generator 4", () => {
    const plan = (generator: 4 | 5) =>
      dungeonPlan({
        generator,
        w: 12,
        h: 10,
        areas: [{ id: "k", kind: "room", name: "Kitchen", condition: "ruined", shape: rect(1, 1, 7, 6) }],
      });
    const k5 = resolvePlan(plan(5), pal).levels[0]?.areas.find((a) => a.id === "k");
    expect([k5?.purpose, k5?.abandoned]).toEqual(["ruin", true]);
    expect(resolvePlan(plan(4), pal).levels[0]?.areas.find((a) => a.id === "k")?.purpose).toBe("kitchen");
  });

  it("a level stated ruined is the scene the word makes: everything inside resolves the same", () => {
    const structures = Array.from({ length: 8 }, (_, i) => house(`h${i}`, 2 + i * 9, 2));
    const areas: Area[] = [{ id: "q", kind: "zone", name: "Quarter", shape: rect(0, 0, 40, 40) }];
    const worded = charsOf(planOf({ title: "Ruined keep", areas, structures }));
    const stated = charsOf(planOf({ title: "Keep", level: { condition: "ruined" }, areas, structures }));
    expect(stated.get("g")?.condition).toBe("ruined");
    const strip = (c: ResolvedCharacter | undefined) => ({ ...c, sources: undefined });
    for (const id of ["q", ...structures.map((s) => s.id)])
      expect(strip(stated.get(id))).toEqual(strip(worded.get(id)));
  });
});

describe("stated character: the outline the model reads shows what the plan states", () => {
  it("a level's and an area's three fields, a building's light and wealth", () => {
    const plan = loadPlan("stated-character-v1");
    const text = outlineView(plan, null);
    expect(text).toMatch(/LEVEL workings .* light=bright condition=intact/);
    expect(text).toMatch(/AREA office room .* light=dark/);
    expect(text).toMatch(/AREA bunks room .* condition=weathered/);
    expect(text).toMatch(/STRUCT gilded building .* wealth=lavish/);
    expect(text).toMatch(/STRUCT hall building .* light=bright/);
  });
});

describe("stated character: the review reads the stated light", () => {
  it(
    "a room stated dark keeps no light and is not unlit; the same room unstated is",
    { timeout: SLOW },
    () => {
      const plan = (light?: PlaceLight) =>
        dungeonPlan({
          generator: 5,
          w: 18,
          h: 10,
          areas: [
            {
              id: "a",
              kind: "room",
              name: "Study",
              ...(light !== undefined ? { light } : {}),
              shape: rect(1, 1, 6, 6),
            },
            { id: "b", kind: "room", name: "Bedroom", shape: rect(7, 1, 6, 6) },
          ],
          openings: [{ id: "d", kind: "door", between: ["a", "b"] }],
        });
      const unlit = (p: MapPlan): boolean => {
        const r: ResolvedPlan = resolvePlan(p, pal);
        for (const L of r.levels)
          L.features = L.features.filter(
            (f) =>
              !(
                f.area === "a" &&
                ["torch_wall", "candles", "candelabra", "brazier", "lantern"].includes(f.type)
              ),
          );
        return reviewDesign(p, r, pal, { limit: 999 }).some(
          (n) => n.code === "room_unlit" && (n.elementIds ?? []).includes("a"),
        );
      };
      const dark = plan("dark");
      const L = resolvePlan(dark, pal).levels[0];
      expect(L && elementCharacter(L, "a")?.light).toBe("dark");
      expect(L?.areas.find((a) => a.id === "a")?.lightLevel).toBe(0);
      expect(unlit(dark)).toBe(false);
      expect(unlit(plan("bright"))).toBe(true);
    },
  );
});

describe("stated character: released generators ignore the fields", () => {
  /** Every level, area and building of the plan given each field (a building's condition is its own field). */
  function withFields(plan: MapPlan): MapPlan {
    const p = structuredClone(plan);
    const add = (x: { light?: PlaceLight; condition?: PlaceCondition; wealth?: PlaceWealth }, k: number) => {
      x.light = CHARACTER_LIGHTS[k % 5] as PlaceLight;
      x.wealth = (["poor", "lavish"] as const)[k % 2] as PlaceWealth;
    };
    p.levels.forEach((L, i) => {
      add(L, i);
      L.condition = "ruined";
      L.areas.forEach((a, j) => {
        add(a, j);
        a.condition = j % 2 === 0 ? "ruined" : "ramshackle";
      });
      (L.structures ?? []).forEach((st, j) => {
        if (st.kind !== "enclosure") add(st, j);
      });
    });
    return p;
  }
  const line = (name: StoredPlan, plan: MapPlan) => goldenRecord({ name, plan }).line;

  it.each([
    "example-a",
    "old-stones-glade-v6",
    "three-step-glen-v1",
    "market-street-v3",
    "inn-interior-v1",
  ] as const)("%s validates and builds byte for byte as without them", { timeout: SLOW }, (name) => {
    const plan = loadPlan(name);
    expect(plan.generator).toBeLessThan(5);
    const stated = withFields(plan);
    expect(JSON.stringify(stated)).not.toBe(JSON.stringify(plan));
    expect(validatePlan(stated, STRUCTURE_ONLY).issues).toEqual(validatePlan(plan, STRUCTURE_ONLY).issues);
    expect(line(name, stated)).toBe(line(name, plan));
  });

  it("a ramshackle building builds as weathered at generator 4", { timeout: SLOW }, () => {
    const plan = loadPlan("condition-street-v1", { generator: 4 });
    const weathered = plan.levels
      .flatMap((L) => L.structures ?? [])
      .filter((s) => s.kind !== "enclosure" && s.condition === "weathered");
    expect(weathered.length).toBeGreaterThan(0);
    const ram = structuredClone(plan);
    for (const L of ram.levels)
      for (const st of L.structures ?? [])
        if (st.kind !== "enclosure" && st.condition === "weathered") st.condition = "ramshackle";
    expect(line("condition-street-v1", ram)).toBe(line("condition-street-v1", plan));
  });
});
