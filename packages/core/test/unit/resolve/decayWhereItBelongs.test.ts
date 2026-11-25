/**
 * Decay where it belongs (generator 5, switch decayWhereItBelongs; owner's screenshots 2026-11-23, images 190-192: a
 * rubble heap on a throne room's floor and a skeleton on a kept dining hall's). Over stored plans with furnished rooms
 * and a plan of three halls, under a few seeds:
 * - no rubble, debris or remains that core lays itself (the wall-foot piles, the furnisher's, a dead end's set, the
 *   layered ground) lies in a room in use that is kept or weathered and of no kind that keeps its dead
 *   (gen/roomTraits.ts showsDecay); a plan's own dress op and the debris on a collapse's rim are the plan's word;
 * - nothing laid after the furnisher (a wall-foot pile, a loose recipe piece) stands on a cell it kept clear.
 * Without the switch the stone dungeon's ground cover lays its skeleton and rubble in the halls.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import type { ResolvedLevel } from "../../../src/contracts/resolved";
import { remainsPiece } from "../../../src/gen/pieceFacts";
import { showsDecay } from "../../../src/gen/roomTraits";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { elementCharacter } from "../../../src/resolve/character";
import { LevelGrid } from "../../../src/resolve/levelGrid";
import { rotateXZ } from "../../../src/util/turn";
import type { StoredPlan } from "../../fixtures";
import { dungeonPlan } from "../../fixtures/planBuilder";
import { sweepPlan, sweepSeeds } from "../../sweep/seeds";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

/** Asset uuid to the name the palettes give it. */
const NAMES = new Map<string, string>();
for (const p of Object.values(pal.palettes))
  for (const r of Object.values(p.roles)) for (const v of r.variants) NAMES.set(v.asset, v.name ?? "");

const DECAY_TYPES = new Set(["rubble", "debris", "bones", "skull_pile"]);
const DECAY_ROLES = new Set(["feature.rubble", "feature.debris", "feature.bones", "feature.skull_pile"]);
/** A feature core lays itself: the wall-foot piles, the furnisher's (a room, a cell, an aisle), a dead end's set. */
const CORE_PIECE = /walls#foot|~(room|cell\d+|aisle|deadend)#\d+$/;

/** Three halls off a gallery: a great hall, a throne room, a temple nave (each 13 x 20). */
const hallsPlan = (seed: number): MapPlan =>
  dungeonPlan({
    generator: 5,
    seed,
    w: 46,
    h: 26,
    areas: [
      { id: "great", kind: "room", name: "Great hall", shape: { type: "rect", x: 1, y: 1, w: 13, h: 20 } },
      { id: "throne", kind: "room", name: "Throne room", shape: { type: "rect", x: 16, y: 1, w: 13, h: 20 } },
      { id: "nave", kind: "room", name: "Temple nave", shape: { type: "rect", x: 31, y: 1, w: 13, h: 20 } },
      { id: "gallery", kind: "corridor", name: "Gallery", shape: { type: "rect", x: 1, y: 22, w: 43, h: 2 } },
    ],
    openings: ["great", "throne", "nave"].map((id) => ({
      id: `${id}_door`,
      kind: "double_door" as const,
      between: [id, "gallery"] as [string, string],
    })),
  });

/** What lies where it should not, on one resolved level. */
function faults(label: string, L: ResolvedLevel): { decay: string[]; onKept: string[] } {
  const g = new LevelGrid(L);
  const kept = new Set(L.keptClear ?? []);
  const dressed = new Set(L.areas.length > 0 ? dressedAreas(L) : []);
  const decay: string[] = [];
  const onKept: string[] = [];
  const swept = new Set(
    L.areas
      .filter(
        (a) =>
          !dressed.has(a.id) &&
          !showsDecay({
            room: a.kind === "room",
            purpose: a.purpose,
            kind: a.roomKind ?? a.purpose,
            abandoned: a.abandoned,
            condition: elementCharacter(L, a.id)?.condition,
          }),
      )
      .map((a) => a.id),
  );
  const areaAt = (x: number, y: number): string | undefined => {
    const i = g.index(Math.floor(x), Math.floor(y));
    return i < 0 ? undefined : L.areaIds[(L.cells.area[i] ?? 0) - 1];
  };
  for (const f of L.features) {
    if (!CORE_PIECE.test(f.id)) continue;
    if (DECAY_TYPES.has(f.type) && f.area !== undefined && swept.has(f.area))
      decay.push(`${label} ${f.area} ${f.type} ${f.id}`);
    if (f.id.startsWith("walls#foot") && kept.has(g.index(f.at[0], f.at[1])))
      onKept.push(`${label} ${f.id} @${f.at.join(",")}`);
  }
  for (const ar of L.arrangements ?? [])
    for (const p of ar.pieces) {
      const q = rotateXZ(p.x, p.z, ar.turn);
      const [x, y] = [ar.at[0] + q.x, ar.at[1] - q.z];
      const area = areaAt(x, y);
      const name = NAMES.get(p.asset);
      if (area !== undefined && swept.has(area) && (DECAY_ROLES.has(p.role) || remainsPiece(name)))
        decay.push(`${label} ${area} ${ar.recipe} ${name ?? p.asset}`);
      if (ar.mount !== "wall" && kept.has(g.index(Math.floor(x), Math.floor(y))))
        onKept.push(`${label} ${ar.recipe} ${name ?? p.asset} @${x.toFixed(1)},${y.toFixed(1)}`);
    }
  return { decay, onKept };
}

/** Areas a plan's dress op composes (its own word for what lies there: a hall dressed as a ruin keeps its rubble). */
const dressedAreas = (L: ResolvedLevel): string[] =>
  L.areas
    .filter((a) => L.features.some((f) => f.area === a.id && /^dress_/.test(f.generatedBy ?? "")))
    .map((a) => a.id);

function measure(plans: ReadonlyArray<readonly [string, MapPlan]>): { decay: string[]; onKept: string[] } {
  const out = { decay: [] as string[], onKept: [] as string[] };
  for (const [label, plan] of plans)
    for (const L of resolvePlan(plan, pal).levels) {
      const f = faults(label, L);
      out.decay.push(...f.decay);
      out.onKept.push(...f.onKept);
    }
  return out;
}

const STORED: readonly StoredPlan[] = [
  "building-rooms-street-v1",
  "dungeon-complex-v1",
  "cell-rows-town-v1",
  "inn-interior-v1",
  "purpose-lineup-v1",
  "example-a",
];

describe("decay where it belongs (decayWhereItBelongs)", () => {
  it("no core-laid rubble or remains in a kept room in use, nothing laid on a kept-clear cell (stored plans)", () => {
    const got = measure(
      STORED.flatMap((n) => sweepSeeds(2).map((s) => [`${n}@${s}`, sweepPlan(n, s)] as const)),
    );
    expect(got.decay).toEqual([]);
    expect(got.onKept).toEqual([]);
  }, 30_000);

  it("three kept halls: no skeleton or rubble on their floors; without the switch the ground cover lays them", () => {
    const plans = [3, 4, 5].map((s) => [`halls@${s}`, hallsPlan(s)] as const);
    const on = measure(plans);
    expect(on.decay).toEqual([]);
    expect(on.onKept).toEqual([]);
    P5.decayWhereItBelongs = false;
    expect(measure(plans).decay.length).toBeGreaterThan(0);
  }, 30_000);

  it("the one question: a kept or weathered room in use is swept, a crypt, cells, a run-down or abandoned room not", () => {
    const room = { room: true, purpose: "dining" } as const;
    expect(showsDecay({ ...room, condition: "intact" })).toBe(false);
    expect(showsDecay({ ...room, condition: "weathered" })).toBe(false);
    expect(showsDecay({ ...room, condition: "ramshackle" })).toBe(true);
    expect(showsDecay({ ...room, condition: "ruined" })).toBe(true);
    expect(showsDecay({ ...room, abandoned: true, condition: "intact" })).toBe(true);
    expect(showsDecay({ room: true, purpose: "crypt", condition: "intact" })).toBe(true);
    expect(showsDecay({ room: true, purpose: "prison", condition: "intact" })).toBe(true);
    expect(showsDecay({ room: true, purpose: "ruin", condition: "intact" })).toBe(true);
    expect(showsDecay({ room: false, condition: "intact" })).toBe(true);
    expect(remainsPiece("Skeleton 01")).toBe(true);
    expect(remainsPiece("Rock pebbles 01")).toBe(false);
  });
});
