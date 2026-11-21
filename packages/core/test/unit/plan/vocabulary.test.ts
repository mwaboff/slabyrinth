/**
 * Plan vocabulary a later generator added (plan/generator.ts VOCABULARY), used in a plan for an earlier generator. One
 * rule for every kind of word: validation refuses it with code `schema`, which is what the released generators did
 * before the word existed (their schema did not know it), so released plans validate exactly as they did when shipped.
 */
import { describe, expect, it } from "vitest";
import { GENERATOR_VERSIONS, type MapPlan } from "../../../src/contracts/plan";
import { VOCABULARY_SINCE, validatePlan } from "../../../src/plan";
import { loadPlan } from "../../fixtures";

type Level = MapPlan["levels"][number];

/** single-room at `generator`, with `use` applied to its one level. */
function planWith(generator: number, use: (level: Level) => void): MapPlan {
  const plan = structuredClone<MapPlan>(loadPlan("single-room"));
  plan.generator = generator as MapPlan["generator"];
  use(plan.levels[0] as Level);
  return plan;
}

/** Every vocabulary kind, with one way a plan uses a word of it and the path validation names. */
const USES: Record<string, { word: string; use: (level: Level) => void; path: string }> = {
  "feature type (a feature)": {
    word: "clutter",
    use: (l) => l.features.push({ id: "extra", type: "clutter", at: [4, 6] }),
    path: `/levels/0/features/FEATURE/type`,
  },
  "feature type (a scatter op)": {
    word: "shelf_line",
    use: (l) => l.terrain.push({ id: "sc", op: "scatter", feature: "shelf_line", density: 0.1 }),
    path: "/levels/0/terrain/0/feature",
  },
  "level field": {
    word: "roomDress",
    use: (l) => {
      l.roomDress = false;
    },
    path: "/levels/0/roomDress",
  },
  "area field": {
    word: "purpose",
    use: (l) => {
      (l.areas[0] as Level["areas"][number]).purpose = "storeroom";
    },
    path: "/levels/0/areas/0/purpose",
  },
};

const refusals = (plan: MapPlan): Array<{ severity: string; code: string; path: string | undefined }> =>
  validatePlan(plan)
    .issues.filter((i) => /needs generator/.test(i.message))
    .map((i) => ({ severity: i.severity, code: i.code, path: i.path }));

describe("vocabulary of a later generator", () => {
  const fourOn = GENERATOR_VERSIONS.filter((v) => v >= 4);
  const released = GENERATOR_VERSIONS.filter((v) => v < 4);

  it("the cases cover every vocabulary kind", () => {
    const words = Object.values(USES).map((u) => u.word);
    for (const kind of Object.keys(VOCABULARY_SINCE) as Array<keyof typeof VOCABULARY_SINCE>)
      expect(
        words.some((w) => VOCABULARY_SINCE[kind][w] !== undefined),
        kind,
      ).toBe(true);
  });

  for (const [name, { word, use, path }] of Object.entries(USES)) {
    it(`${name}: refused below its generator, code schema`, () => {
      for (const g of released) {
        const plan = planWith(g, use);
        const at = path.replace("FEATURE", String((plan.levels[0] as Level).features.length - 1));
        expect(validatePlan(plan).ok, `generator ${g}`).toBe(false);
        expect(refusals(plan), `generator ${g}`).toEqual([{ severity: "error", code: "schema", path: at }]);
        const issue = validatePlan(plan).issues.find((i) => i.path === at);
        expect(issue?.message).toMatch(new RegExp(`${word} needs generator 4; this plan is generator ${g}$`));
        expect(issue?.hint).toMatch(/^set the plan generator to 4 \(new plans have it\), or /);
      }
    });

    it(`${name}: accepted from its generator on`, () => {
      for (const g of fourOn) expect(refusals(planWith(g, use)), `generator ${g}`).toEqual([]);
    });
  }

  it("words every generator knows are never refused", () => {
    const plan = planWith(3, (l) => {
      l.features.push({ id: "extra", type: "chest", at: [4, 6] });
      l.terrain.push({ id: "sc", op: "scatter", feature: "rubble", density: 0.1 });
    });
    expect(refusals(plan)).toEqual([]);
  });
});
