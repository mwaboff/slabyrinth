/**
 * Stated character meets the halls fixes (generator 5: statedCharacter with decayWhereItBelongs and
 * lightsAgainstSomething; written on branches that could not see each other). The questions go through the place's
 * resolved character (resolve/character.ts elementCharacter), never its words:
 * - a room stated ruined or ramshackle shows decay (rubble, debris or remains on its floor) and one stated intact does
 *   not, whatever its name says;
 * - a room stated dark gets one light at most (dark is "one or none", gen/lightLevels.ts: the one at its door), whatever
 *   its name says; a room stated bright gets more, each floor light against a wall, a window or a piece that is no
 *   light.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Area, MapPlan, PlaceCondition, PlaceLight } from "../../../src/contracts/plan";
import { EDGE, type ResolvedLevel } from "../../../src/contracts/resolved";
import { featureInfo } from "../../../src/gen/catalog";
import { remainsPiece } from "../../../src/gen/pieceFacts";
import { showsDecay } from "../../../src/gen/roomTraits";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { elementCharacter } from "../../../src/resolve/character";
import { LevelGrid } from "../../../src/resolve/levelGrid";
import { rotateXZ } from "../../../src/util/turn";
import { dungeonPlan } from "../../fixtures/planBuilder";
import { sweepSeeds } from "../../sweep/seeds";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));
const SLOW = 60_000;
const SEEDS = sweepSeeds(4);

/** Asset uuid to the name the palettes give it. */
const NAMES = new Map<string, string>();
for (const p of Object.values(pal.palettes))
  for (const r of Object.values(p.roles)) for (const v of r.variants) NAMES.set(v.asset, v.name ?? "");

const DECAY_TYPES = new Set(["rubble", "debris", "bones", "skull_pile"]);
const DECAY_ROLES = new Set(["feature.rubble", "feature.debris", "feature.bones", "feature.skull_pile"]);
const SIDES = ["N", "E", "S", "W"] as const;
const STEP = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] } as const;

interface Hall {
  id: string;
  name: string;
  condition?: PlaceCondition;
  light?: PlaceLight;
}

/** Halls of 9 x 12 in a row off a gallery, each with its name and stated fields. */
function hallsPlan(halls: readonly Hall[], seed: number): MapPlan {
  const areas: Area[] = halls.map((h, i) => ({
    id: h.id,
    kind: "room",
    name: h.name,
    ...(h.condition !== undefined ? { condition: h.condition } : {}),
    ...(h.light !== undefined ? { light: h.light } : {}),
    shape: { type: "rect", x: 1 + i * 11, y: 1, w: 9, h: 12 },
  }));
  areas.push({
    id: "gallery",
    kind: "corridor",
    name: "Gallery",
    shape: { type: "rect", x: 1, y: 14, w: halls.length * 11 - 2, h: 2 },
  });
  return dungeonPlan({
    generator: 5,
    seed,
    w: halls.length * 11 + 1,
    h: 17,
    areas,
    openings: halls.map((h) => ({ id: `${h.id}_door`, kind: "door" as const, between: [h.id, "gallery"] })),
  });
}

/** The rubble, debris and remains on each area's floor (features and arrangement pieces). */
function decayByArea(L: ResolvedLevel): Map<string, number> {
  const g = new LevelGrid(L);
  const out = new Map<string, number>();
  const add = (a: string | undefined): void => {
    if (a !== undefined) out.set(a, (out.get(a) ?? 0) + 1);
  };
  for (const f of L.features) if (DECAY_TYPES.has(f.type)) add(f.area);
  for (const ar of L.arrangements ?? [])
    for (const p of ar.pieces) {
      if (!DECAY_ROLES.has(p.role) && !remainsPiece(NAMES.get(p.asset))) continue;
      const q = rotateXZ(p.x, p.z, ar.turn);
      const i = g.index(Math.floor(ar.at[0] + q.x), Math.floor(ar.at[1] - q.z));
      add(i < 0 ? undefined : L.areaIds[(L.cells.area[i] ?? 0) - 1]);
    }
  return out;
}

/** An area's lights (any feature the catalog calls a light) and those of them on the floor standing free. */
function lightsOf(L: ResolvedLevel, area: string): { lights: number; free: string[] } {
  const g = new LevelGrid(L);
  const blocker = new Set<number>();
  for (const f of L.features) {
    const info = featureInfo(f.type);
    if (!f.blocking || info.light === true || f.type === "rug") continue;
    for (let dy = 0; dy < f.size[1]; dy++)
      for (let dx = 0; dx < f.size[0]; dx++) blocker.add(g.index(f.at[0] + dx, f.at[1] + dy));
  }
  let lights = 0;
  const free: string[] = [];
  for (const f of L.features) {
    const info = featureInfo(f.type);
    if (f.area !== area || info.light !== true) continue;
    lights++;
    if (info.wallMounted || info.ceilingMounted || info.focusPiece === true) continue;
    const [x, y] = f.at;
    if (f.baseHeight - g.top(x, y) > 0.1) continue;
    const against = SIDES.some((s) => {
      const k = g.edgeKind(x, y, s);
      return k === EDGE.WALL || k === EDGE.OPENING || blocker.has(g.index(x + STEP[s][0], y + STEP[s][1]));
    });
    if (!against) free.push(`${f.type} @${x},${y} ${f.id}`);
  }
  return { lights, free };
}

const levelOf = (plan: MapPlan): ResolvedLevel => {
  const L = resolvePlan(plan, pal).levels[0];
  if (!L) throw new Error("no level");
  return L;
};

describe("stated condition decides decay, not the room's words", () => {
  const HALLS: readonly Hall[] = [
    { id: "ruined", name: "Great hall", condition: "ruined" },
    { id: "shack", name: "Great hall", condition: "ramshackle" },
    { id: "kept", name: "Ruined hall", condition: "intact" },
    { id: "keptRot", name: "Collapsed rotting dining hall", condition: "intact" },
  ];

  it(
    "ruined and ramshackle halls show decay; intact ones, named ruined or collapsed, show none",
    { timeout: SLOW },
    () => {
      const total = new Map<string, number>();
      for (const seed of SEEDS) {
        const L = levelOf(hallsPlan(HALLS, seed));
        for (const h of HALLS) {
          const area = L.areas.find((a) => a.id === h.id);
          const ch = elementCharacter(L, h.id);
          expect(ch?.condition, `${h.id}@${seed}`).toBe(h.condition);
          const decay = showsDecay({
            room: area?.kind === "room",
            purpose: area?.purpose,
            kind: area?.roomKind ?? area?.purpose,
            abandoned: area?.abandoned,
            condition: ch?.condition,
          });
          expect(decay, `${h.id}@${seed} showsDecay`).toBe(h.condition !== "intact");
        }
        for (const [a, n] of decayByArea(L)) total.set(a, (total.get(a) ?? 0) + n);
      }
      expect(total.get("kept") ?? 0).toBe(0);
      expect(total.get("keptRot") ?? 0).toBe(0);
      expect(total.get("ruined") ?? 0).toBeGreaterThan(0);
      expect(total.get("shack") ?? 0).toBeGreaterThan(0);
      // without the stated fields the words decide: the hall named ruined is a ruin and shows its decay
      P5.statedCharacter = false;
      let worded = 0;
      for (const seed of SEEDS) worded += decayByArea(levelOf(hallsPlan(HALLS, seed))).get("kept") ?? 0;
      expect(worded).toBeGreaterThan(0);
    },
  );
});

describe("stated light meets lights against something and the cell rows", () => {
  // (a barracks, a stable and a ward of this size draw a cell row on some seeds: gen/roomTraits.ts CELL_ROWS)
  const DARK: readonly Hall[] = [
    { id: "dStudy", name: "Brightly lit study", light: "dark" },
    { id: "dBarracks", name: "Barracks", light: "dark" },
    { id: "dStable", name: "Stable", light: "dark" },
    { id: "dWard", name: "Infirmary ward", light: "dark" },
  ];
  const BRIGHT: readonly Hall[] = [
    { id: "bBarracks", name: "Gloomy shadowed barracks", light: "bright" },
    { id: "bHall", name: "Dark dining hall", light: "bright" },
  ];
  const plan = (seed: number): MapPlan => hallsPlan([...DARK, ...BRIGHT], seed);

  it(
    "a room stated dark gets one light at most; one stated bright more, none free mid-floor",
    { timeout: SLOW },
    () => {
      for (const seed of SEEDS) {
        const L = levelOf(plan(seed));
        for (const h of DARK) {
          expect(elementCharacter(L, h.id)?.light).toBe("dark");
          // dark is "one or none" (gen/lightLevels.ts): the one at its door, or its aisle's one (darkCellRows)
          const got = lightsOf(L, h.id);
          expect(got.lights, `${h.id}@${seed}`).toBeLessThanOrEqual(1);
          expect(got.free, `${h.id}@${seed}`).toEqual([]);
        }
        for (const h of BRIGHT) {
          expect(elementCharacter(L, h.id)?.light).toBe("bright");
          const got = lightsOf(L, h.id);
          expect(got.lights, `${h.id}@${seed}`).toBeGreaterThan(1);
          expect(got.free, `${h.id}@${seed}`).toEqual([]);
        }
      }
    },
  );

  it("without darkCellRows a dark room's cell row lights every cell and its aisle", { timeout: SLOW }, () => {
    P5.darkCellRows = false;
    let most = 0;
    for (const seed of SEEDS) {
      const L = levelOf(plan(seed));
      for (const h of DARK) most = Math.max(most, lightsOf(L, h.id).lights);
    }
    expect(most).toBeGreaterThan(1);
  });
});
