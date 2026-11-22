/**
 * Treatments (resolve/recipes/treatments.ts): every subject draws one option per family, deterministically; options
 * appear about as often as their weights say; a street shows a few treatments with repetition and no two neighbours
 * alike; one building is dressed one way (one treatment, one post, one trim material); trims in a contrasting material
 * appear at their weight and never make a third material; the facades_alike note reads the treatment.
 */
import { describe, expect, it } from "vitest";
import type { ResolvedLevel } from "../../../src/contracts/resolved";
import { wallStyleInfo } from "../../../src/gen/wallStyles";
import { bundledPalettes } from "../../../src/palette";
import { partRole, postRole } from "../../../src/palette/roles";
import { resolveView } from "../../../src/palette/view";
import { generatorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { LevelAnchors } from "../../../src/resolve/anchors";
import { ArrangementRecords } from "../../../src/resolve/level/arrangements";
import { boxGap } from "../../../src/resolve/neighbours";
import { runRecipes } from "../../../src/resolve/recipes/engine";
import {
  NEXT_DOOR,
  TREATMENTS,
  drawTreatments,
  type Treatment,
} from "../../../src/resolve/recipes/treatments";
import { qualityNotes } from "../../../src/review/qualityNotes";
import { loadPlan } from "../../fixtures";
import { ALL_WALLS, withArrangements } from "../../fixtures/treatments";

const pal = bundledPalettes();
const plan = { ...loadPlan("market-street-v3"), generator: 5 as const };
const view = resolveView(plan, pal);
const resolved = resolvePlan(plan, pal);
const L0 = resolved.levels[0] as ResolvedLevel;
const bare: ResolvedLevel = { ...L0 };
delete bare.arrangements;
const anchors = new LevelAnchors(bare);
const hasTrim = (theme: string, style: string): boolean => {
  const t = view.roles.paletteTheme(theme);
  return [partRole("facade_post", style), postRole(style)].some((r) => !!view.roles.resolve(t, r).resolution);
};
const draw = (planSeed: number): Map<string, Treatment> =>
  drawTreatments({
    planSeed,
    level: bare,
    defaultTheme: view.defaultTheme,
    zones: anchors.of("zone"),
    areaWalls: new Map(),
    hasTrim,
  });
const SEEDS = Array.from({ length: 150 }, (_, i) => 1000 + i * 7);
const buildingsOf = (m: Map<string, Treatment>): Treatment[] =>
  [...m.values()].filter((t) => t.subject.kind === "building");

describe("treatments", () => {
  it("are deterministic", () => {
    const a = draw(42);
    const b = draw(42);
    expect([...a].map(([k, t]) => [k, t.key, t.trim])).toEqual([...b].map(([k, t]) => [k, t.key, t.trim]));
  });

  it("draw every open option over many seeds, none far beyond its weight", () => {
    const counts = new Map<string, number>();
    const expected = new Map<string, number>();
    let n = 0;
    for (const seed of SEEDS)
      for (const t of buildingsOf(draw(seed))) {
        n++;
        for (const [f, o] of t.options) counts.set(`${f}:${o}`, (counts.get(`${f}:${o}`) ?? 0) + 1);
        for (const f of TREATMENTS) {
          const total = f.options.reduce((s, o) => s + o.weight(t.subject), 0);
          for (const o of f.options)
            if (total > 0)
              expected.set(
                `${f.id}:${o.id}`,
                (expected.get(`${f.id}:${o.id}`) ?? 0) + o.weight(t.subject) / total,
              );
        }
      }
    for (const [k, e] of expected) {
      if (e / n < 0.02) continue;
      const got = (counts.get(k) ?? 0) / n;
      expect(got, k).toBeGreaterThan(0);
      // the street sets and the neighbour rule spread draws; no option runs away with it
      expect(got, k).toBeLessThan(e / n + 0.2);
    }
    // restraint: plain has real weight in the wall families
    expect((counts.get("frame:plain") ?? 0) / n).toBeGreaterThan(0.1);
    expect((counts.get("courses:plain") ?? 0) / n).toBeGreaterThan(0.1);
  });

  it("show a street a few treatments with repetition, and never give neighbours the same one", () => {
    let alike = 0;
    for (const seed of SEEDS) {
      const bs = buildingsOf(draw(seed));
      const keys = new Set(bs.map((t) => t.key));
      expect(keys.size).toBeGreaterThanOrEqual(2);
      expect(keys.size).toBeLessThan(bs.length);
      for (const a of bs)
        for (const b of bs)
          if (a !== b && boxGap(a.subject.box, b.subject.box) <= NEXT_DOOR.building && a.key === b.key)
            alike++;
    }
    expect(alike).toBe(0);
  });

  it("contrast trims appear at their weight, in a material the wall table allows, never a third one", () => {
    let contrast = 0;
    let n = 0;
    for (const seed of SEEDS)
      for (const t of buildingsOf(draw(seed))) {
        n++;
        if (t.trim === null) continue;
        contrast++;
        const fams = new Set(t.subject.walls.map((w) => wallStyleInfo(w)?.family));
        fams.add(wallStyleInfo(t.trim)?.family);
        expect(fams.size).toBeLessThanOrEqual(2);
      }
    expect(contrast / n).toBeGreaterThan(0.15);
    expect(contrast / n).toBeLessThan(0.55);
  });
});

describe("treatments on a built street", () => {
  const run = (families?: typeof ALL_WALLS) =>
    runRecipes(bare, new ArrangementRecords(), {
      planSeed: plan.seed,
      profile: generatorProfile(5),
      palette: view,
      budget: 1e6,
      ...(families ? { families } : {}),
    }).attached;

  it("dress one building one way: one treatment, one post on every jamb and corner, one trim material", () => {
    const inst = run();
    const hosts = new Set(inst.map((x) => x.host));
    for (const h of hosts) {
      const mine = inst.filter((x) => x.host === h);
      expect(new Set(mine.map((x) => x.treatment)).size).toBe(1);
      const posts = mine.filter((x) => x.recipe === "jambPosts" || x.recipe === "cornerPosts");
      // (a storey too low for the building's post, or a corner too narrow, takes its next best)
      expect(new Set(posts.flatMap((x) => x.pieces.map((p) => p.asset))).size).toBeLessThanOrEqual(2);
      const jambs = mine.filter((x) => x.recipe === "jambPosts" && x.layer === "storey:0");
      expect(new Set(jambs.flatMap((x) => x.pieces.map((p) => p.asset))).size).toBeLessThanOrEqual(1);
    }
  });

  it("let facades_alike fire on a street forced to one treatment, and stay silent on the drawn one", () => {
    // every house of the street of one height and one wall, so only the treatment tells them apart
    const one = (L0.structures ?? []).find((s) => s.kind === "building");
    if (!one) throw new Error("no building");
    const uniform = {
      ...resolved,
      levels: resolved.levels.map((L) => ({
        ...L,
        structures: (L.structures ?? []).map((s) =>
          s.kind === "building"
            ? {
                ...s,
                storeys: one.storeys,
                ...(s.design ? { design: { ...s.design, storeys: 2, material: "wall" as const } } : {}),
              }
            : s,
        ),
      })),
    };
    const with_ = (inst: ReturnType<typeof run>) => withArrangements(uniform, L0.id, inst);
    const forced = qualityNotes(plan, with_(run(ALL_WALLS))).filter((n) => n.code === "facades_alike");
    const drawn = qualityNotes(plan, with_(run())).filter((n) => n.code === "facades_alike");
    expect(forced.length).toBeGreaterThan(0);
    expect(drawn).toEqual([]);
  });
});
