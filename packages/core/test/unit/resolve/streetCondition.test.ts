/**
 * The street and condition round (generator 5) on the varied-street-v1 and condition-street-v1 fixtures, each a fault
 * the owner's screenshots showed, held by the switch that fixes it (the switch off rebuilds the fault):
 *   twinnedPairs   a guardian pair is one piece twinned, both standing or neither (resolve/recipes/threshold.ts).
 *   roofKitFacts   no hip in a kit whose corner is a spiked tip; a roof patch is a repair of the same roof or none
 *                  (resolve/roofKits.ts, resolve/building/wear.ts, compile/realize/structures/roofPiece.ts).
 *   leanUnderMain  a lean-to stands under the house's ridge (resolve/structureVariety.ts, resolve/structure.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import type { MapPlan } from "../../../src/contracts/plan";
import type { ResolvedLevel, ResolvedPlan } from "../../../src/contracts/resolved";
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
import { approachLights, guardianPair } from "../../../src/resolve/recipes/threshold";
import { ROOF_KITS } from "../../../src/resolve/roofKits";
import { loadPlan } from "../../fixtures";
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

  it("patches a slate roof in its own worn pieces, in small groups; without the switch in orange village tiles", () => {
    const r = resolvePlan(inKit("slate"), pal);
    const shack = r.levels[0]?.structures?.find((s) => s.id === "shack");
    expect(shack?.roofPatch?.length ?? 0).toBeGreaterThan(4);
    const names = namesOf(r, "shack~");
    expect(names.some((n) => /broken/i.test(n))).toBe(true);
    expect(names.some((n) => /village/i.test(n))).toBe(false);
    without("roofKitFacts");
    expect(namesOf(resolvePlan(inKit("slate"), pal), "shack~").some((n) => /village/i.test(n))).toBe(true);
  });

  it("leaves a village roof unpatched (no kit reads like it); without the switch it is patched in grey slate", () => {
    const shackOf = (r: ResolvedPlan) => r.levels[0]?.structures?.find((s) => s.id === "shack");
    expect(shackOf(resolvePlan(inKit("village"), pal))?.roofPatch).toBeUndefined();
    without("roofKitFacts");
    const off = resolvePlan(inKit("village"), pal);
    expect(shackOf(off)?.roofPatch?.length ?? 0).toBeGreaterThan(0);
    expect(namesOf(off, "shack~").some((n) => /haunted roof/i.test(n))).toBe(true);
  });

  it("patches only a worn or worse building (the kept house has none)", () => {
    const r = resolvePlan(inKit("slate"), pal);
    expect(r.levels[0]?.structures?.find((s) => s.id === "kept")?.roofPatch).toBeUndefined();
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
