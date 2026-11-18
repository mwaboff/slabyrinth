/**
 * Property: random op sequences never commit an invalid plan, never mutate their input, and every committed
 * version reconstructs exactly from history (keyframes + replay).
 *
 * Default run is small and fast. Acceptance run (architecture §8.3, 10k sequences):
 *   SLABYRINTH_FUZZ_RUNS=10000 npx vitest run packages/core/test/unit/ops/fuzz.test.ts
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { MapPlan, Shape, Vec2 } from "../../../src/contracts/plan";
import { FEATURE_TYPES, OPENING_KINDS } from "../../../src/contracts/plan";
import type { PlanHistory, PlanOp } from "../../../src/contracts/ops";
import { applyOps } from "../../../src/ops";
import { validatePlan } from "../../../src/plan";
import { commitOps, commitVersion, createHistory, reconstruct } from "../../../src/history";
import { canonicalJson, createPrng } from "../../../src/util";
import type { Prng } from "../../../src/util";
import { VALID_PLAN_FIXTURES, loadPlan } from "../../fixtures";

const RUNS = Number(process.env.SLABYRINTH_FUZZ_RUNS ?? "150");
const T = "2026-11-18T00:00:00.000Z";

function ids(plan: MapPlan): {
  all: string[];
  areas: string[];
  levels: string[];
  terrain: string[];
  links: string[];
} {
  const all: string[] = [];
  const areas: string[] = [];
  const terrain: string[] = [];
  for (const l of plan.levels) {
    all.push(l.id);
    for (const a of l.areas) {
      all.push(a.id);
      areas.push(a.id);
    }
    for (const x of [...l.openings, ...l.walls, ...l.features, ...l.labels]) all.push(x.id);
    for (const t of l.terrain) {
      all.push(t.id);
      terrain.push(t.id);
    }
  }
  for (const k of plan.links) all.push(k.id);
  return { all, areas, levels: plan.levels.map((l) => l.id), terrain, links: plan.links.map((k) => k.id) };
}

function randomOp(plan: MapPlan, g: Prng, n: number): PlanOp {
  const I = ids(plan);
  const pickOr = (xs: string[], fallback: string): string => (xs.length > 0 ? g.pick(xs) : fallback);
  const lvl = pickOr(I.levels, "l1");
  const level = plan.levels.find((l) => l.id === lvl);
  const bw = level?.bounds.w ?? 10;
  const bh = level?.bounds.h ?? 10;
  const cell = (): Vec2 => [g.range(-2, bw + 1), g.range(-2, bh + 1)];
  const rect = (): Shape => ({
    type: "rect",
    x: g.range(-1, bw - 2),
    y: g.range(-1, bh - 2),
    w: g.range(1, 8),
    h: g.range(1, 8),
  });
  const fresh = `z${n}_${g.int(1000)}`;
  const height = (): number => g.pick([0, 0.25, 0.5, 1, -0.5, 0.3, 9]);
  switch (g.int(17)) {
    case 0:
      return {
        op: "add",
        element: {
          kind: "feature",
          level: lvl,
          value: {
            id: fresh,
            type: g.pick(FEATURE_TYPES),
            at: cell(),
            ...(g.chance(0.5) ? {} : { hint: "thing" }),
          },
        },
      };
    case 1:
      return {
        op: "add",
        element: {
          kind: "area",
          level: lvl,
          value: {
            id: fresh,
            kind: g.pick(["room", "zone", "cave", "corridor", "courtyard"] as const),
            shape: rect(),
          },
          ...(g.chance(0.3) ? { index: g.int(5) } : {}),
        },
      };
    case 2:
      return {
        op: "update",
        id: pickOr(I.areas, "nope"),
        set: g.pick([
          { name: `N${n}` },
          { floorHeight: height() },
          { key: String(g.range(1, 4)) },
          { notes: null },
          { shape: rect() },
          { walls: "none" },
          { kind: "room" },
        ]),
      };
    case 3:
      return {
        op: "remove",
        ids: [pickOr(I.all, "nope"), ...(g.chance(0.3) ? [pickOr(I.all, "nope")] : [])],
        ...(g.chance(0.2) ? { keepDependents: true } : {}),
      };
    case 4:
      return {
        op: "move",
        ids: [pickOr(I.all, "nope")],
        dx: g.range(-3, 3),
        dy: g.range(-3, 3),
        ...(g.chance(0.3) ? { withContents: false } : {}),
        ...(g.chance(0.2) ? { toLevel: pickOr(I.levels, "l1") } : {}),
      };
    case 5:
      return {
        op: "duplicate",
        ids: [pickOr(I.all, "nope")],
        dx: g.range(-4, 4),
        dy: g.range(-4, 4),
        idSuffix: `_d${n}`,
      };
    case 6:
      return { op: "reorder", id: pickOr([...I.areas, ...I.terrain], "nope"), index: g.int(6) };
    case 7:
      return {
        op: "set_meta",
        ...g.pick([{ title: `T${n}` }, { seed: g.int(1000) }, { summary: null }, { theme: "cave" }]),
      };
    case 8:
      return {
        op: "reshape",
        id: pickOr(I.all, "nope"),
        shape: g.chance(0.8)
          ? rect()
          : {
              type: "polygon",
              points: [
                [1, 1],
                [5, 1],
                [1, 5],
                [6, 6],
              ],
            },
      };
    case 9:
      return { op: "renumber" };
    case 10: {
      const from = pickOr(I.levels, "l1");
      return {
        op: "add",
        element: {
          kind: "link",
          value: {
            id: fresh,
            kind: g.pick(["stairs", "ladder", "spiral_stairs"] as const),
            from: { level: from, at: cell() },
            to: { level: pickOr(I.levels, "l1") },
            dir: g.pick(["N", "E", "S", "W"] as const),
          },
        },
      };
    }
    case 11: {
      const a = pickOr(I.areas, "nope");
      return {
        op: "add",
        element: {
          kind: "opening",
          level: lvl,
          value: {
            id: fresh,
            kind: g.pick(OPENING_KINDS),
            between: [a, g.chance(0.5) ? "@outside" : pickOr(I.areas, a)],
          },
        },
      };
    }
    case 12:
      return {
        op: "add",
        element: {
          kind: "level",
          value: {
            id: fresh,
            name: "L",
            elevation: g.pick([-5, 2.5, 5, 7.5, 0]),
            bounds: { x: 0, y: 0, w: g.range(1, 30), h: g.range(1, 30) },
            base: { type: "solid" },
          },
        },
      };
    case 13:
      return {
        op: "update",
        id: pickOr(I.links, pickOr(I.all, "nope")),
        set: g.pick([
          { to: { level: pickOr(I.levels, "l1"), at: cell() } },
          { dir: "S" },
          { width: 2 },
          { label: null },
        ]),
      };
    case 14:
      return {
        op: "add_features",
        level: lvl,
        features: Array.from({ length: g.range(1, 3) }, (_, k) => ({
          id: `${fresh}_${k}`,
          type: g.pick(FEATURE_TYPES),
          at: cell(),
          hint: "h",
        })),
      };
    case 15:
      return {
        op: "add",
        element: {
          kind: "terrain",
          level: lvl,
          value: g.chance(0.5)
            ? { id: fresh, op: "dress", area: pickOr(I.areas, "nope"), preset: "crypt" }
            : { id: fresh, op: "height", shape: rect(), ...(g.chance(0.8) ? { set: height() } : {}) },
        },
      };
    default:
      return { op: "update", id: pickOr(I.all, "nope"), set: { label: `x${n}` } };
  }
}

describe("fuzz: applyOps never commits an invalid plan", () => {
  it(`${RUNS} random op sequences`, () => {
    let committed = 0;
    fc.assert(
      fc.property(
        fc.nat({ max: VALID_PLAN_FIXTURES.length - 1 }),
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 1, max: 8 }),
        (fi, seed, steps) => {
          const g = createPrng(seed);
          let plan = loadPlan(VALID_PLAN_FIXTURES[fi] as (typeof VALID_PLAN_FIXTURES)[number]);
          let history: PlanHistory = commitVersion(createHistory(), {
            plan,
            author: "ai",
            createdAt: T,
            summary: "c",
            cause: { type: "create" },
          }).history;
          for (let s = 0; s < steps; s++) {
            const ops = Array.from({ length: g.range(1, 3) }, (_, k) => randomOp(plan, g, s * 10 + k));
            const before = canonicalJson(plan);
            const r = applyOps(plan, ops);
            expect(canonicalJson(plan)).toBe(before);
            if (!r.ok) {
              expect(r.opErrors.length + r.issues.length).toBeGreaterThan(0);
              for (const e of [...r.opErrors, ...r.issues]) expect(e.hint ?? e.message).toBeTruthy();
              continue;
            }
            const v = validatePlan(r.plan);
            expect(v.ok, JSON.stringify(v.issues)).toBe(true);
            history = commitOps(history, r.plan, ops, { author: "ai", createdAt: T, summary: "e" }).history;
            plan = r.plan;
            committed++;
          }
          const rebuilt = reconstruct(history, history.head);
          expect(rebuilt.ok && canonicalJson(rebuilt.plan)).toBe(canonicalJson(plan));
        },
      ),
      { numRuns: RUNS, seed: 20261118 },
    );
    expect(committed).toBeGreaterThan(RUNS);
  }, 600_000);
});
