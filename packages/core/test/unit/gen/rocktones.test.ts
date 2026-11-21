/**
 * One rock tone per cliff (generator 3): the bundled rock rows carry tone tags (Cliff Face reads cream, Boulder - Large
 * grey, as seen in the owner's screenshots), the face piece decides the cliff's tone and keeps every face, boulders and
 * loose rock beside the cliff match it, and the review note rock_tones_mixed fires where the rule is off.
 */
import { describe, expect, it } from "vitest";
import { realize } from "../../../src/compile/index";
import type { GeneratorVersion, MapPlan } from "../../../src/contracts/plan";
import { cliffRockKinds } from "../../../src/gen/index";
import { loadPalettes } from "../../../src/palette/load";
import { resolvePlan } from "../../../src/resolve/index";
import { reviewDesign } from "../../../src/review/index";
import { loadPlan } from "../../fixtures";

const fixture = (generator: GeneratorVersion = 3): MapPlan => loadPlan("terraced-hill", { generator });

const v = (
  tone: "dark" | "mid" | "light" | undefined,
  weight = 1,
): { tone?: "dark" | "mid" | "light"; weight: number } => (tone ? { tone, weight } : { weight });

describe("cliffRockKinds", () => {
  it("keeps both kinds when they share a tone, and says which", () => {
    expect(cliffRockKinds([v("mid")], [v("mid"), v("mid")])).toEqual({
      tone: "mid",
      face: true,
      crest: true,
    });
  });
  it("the face piece decides, and never loses its kind to the boulders' tone", () => {
    expect(cliffRockKinds([v("light")], [v("mid"), v("mid", 0.3)])).toEqual({
      tone: "light",
      face: true,
      crest: true,
    });
  });
  it("lets the boulders decide only when the palette has no tagged face piece", () => {
    expect(cliffRockKinds([v(undefined)], [v(undefined)])).toEqual({ face: true, crest: true });
    expect(cliffRockKinds([], [v("mid")])).toEqual({ tone: "mid", face: true, crest: true });
    expect(cliffRockKinds([v(undefined)], [v("mid")])).toEqual({ tone: "mid", face: true, crest: true });
  });
  it("ignores weight-0 pieces", () => {
    expect(cliffRockKinds([v("light", 0), v("dark")], [v("mid")])).toEqual({
      tone: "dark",
      face: true,
      crest: true,
    });
  });
});

describe("the bundled cliff rock", () => {
  it("tags Cliff Face light and Boulder - Large mid in every theme that has the cliff roles", () => {
    const cat = loadPalettes();
    for (const id of ["cave", "forest", "outdoor", "wood_town"]) {
      const roles = cat.palettes[id]?.roles ?? {};
      expect(
        roles["cliff.formation_face"]?.variants.map((x) => x.tone),
        id,
      ).toEqual(["light"]);
      expect(
        roles["cliff.formation_crest"]?.variants.every((x) => x.tone === "mid"),
        id,
      ).toBe(true);
    }
  });

  it("has cream boulders for the cliff band in a role of their own (generator 3 only)", () => {
    const roles = loadPalettes().palettes["outdoor"]?.roles ?? {};
    const light = roles["cliff.formation_crest_light"];
    expect(light?.minGenerator).toBe(3);
    expect(light?.variants.map((x) => x.name).sort()).toEqual(["Desert Cliff 05", "rock_large001"]);
    expect(light?.variants.every((x) => x.tone === "light")).toBe(true);
  });

  const toneOfPieces = (plan: MapPlan): { band: Set<string>; face: number; crest: number } => {
    const resolved = resolvePlan(plan);
    const cat = loadPalettes();
    const set = realize(resolved, cat);
    const tones = new Map<string, string>();
    for (const p of Object.values(cat.palettes))
      for (const d of Object.values(p.roles))
        for (const x of d.variants) if (x.tone) tones.set(x.asset.toLowerCase(), x.tone);
    const band = new Set<string>();
    let face = 0;
    let crest = 0;
    for (const L of resolved.levels) {
      const byId = new Map(L.features.map((f) => [f.id, f]));
      for (const p of set.levels.find((l) => l.levelId === L.id)?.placements ?? []) {
        const f = byId.get(String(p.source.elementId));
        if (!f || (f.type !== "cliff_face" && f.type !== "cliff_crest")) continue;
        band.add(tones.get(p.asset.toLowerCase()) ?? "unknown");
        if (f.type === "cliff_face") face++;
        else crest++;
      }
    }
    return { band, face, crest };
  };

  it("builds a generator-3 cliff in the face piece's tone, with its face rock and boulders both present", () => {
    const r = toneOfPieces(fixture());
    expect([...r.band]).toEqual(["light"]);
    expect(r.crest).toBeGreaterThan(0);
    expect(r.face).toBeGreaterThan(30);
  });

  it("leaves generator 2 as it was (face rock and boulders both built)", () => {
    const r = toneOfPieces(fixture(2));
    expect(r.face).toBeGreaterThan(0);
    expect(r.crest).toBeGreaterThan(0);
  });
});

describe("rock_tones_mixed", () => {
  const codes = (plan: MapPlan, oneToneRule?: boolean): string[] =>
    reviewDesign(plan, resolvePlan(plan), {
      limit: 99,
      ...(oneToneRule === undefined ? {} : { oneToneRule }),
    }).map((n) => n.code);

  it("fires on a cliff built without the one-tone rule", () => {
    expect(codes(fixture(), false)).toContain("rock_tones_mixed");
  });
  it("is silent once the rule holds", () => {
    expect(codes(fixture())).not.toContain("rock_tones_mixed");
  });
  it("is silent for generator 2 plans", () => {
    expect(codes(fixture(2), false)).not.toContain("rock_tones_mixed");
  });
});
