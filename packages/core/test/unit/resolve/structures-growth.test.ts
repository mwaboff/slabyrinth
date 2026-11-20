/**
 * Generator 3: growth that climbs weathered and ruined buildings, a ruin that keeps one roofed part as its anchor, and
 * the review notes that go with them (growth_bare, the recalibrated ruin_flat_top).
 */
import { describe, expect, it } from "vitest";
import type { Building, MapPlan, Structure } from "../../../src/contracts/plan";
import type { ResolvedLevel, ResolvedStructure } from "../../../src/contracts/resolved";
import { realize, verifyBuild } from "../../../src/compile";
import { loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import "../../../src/resolve/autoregister";
import { growthMeasures, roofUnsupportedEdges, structureRuinMeasures } from "../../../src/resolve";
import { GROWTH_LEVELS } from "../../../src/resolve/growth";
import { reviewDesign } from "../../../src/review";

const palettes = loadPalettes();

function plan(structures: Structure[], generator: 2 | 3 = 3, theme = "forest"): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator,
    id: "grow",
    title: "grow",
    kind: "outdoor",
    seed: 5,
    theme,
    links: [],
    levels: [
      {
        id: "g",
        name: "g",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 36, h: 30 },
        base: { type: "ground", material: "grass" },
        areas: [{ id: "lot", kind: "zone", shape: { type: "rect", x: 0, y: 0, w: 36, h: 30 } }],
        openings: [],
        walls: [],
        features: [{ id: "f", type: "statue", at: [2, 2] }],
        terrain: [],
        labels: [],
        structures,
      },
    ],
  };
}
const first = (p: MapPlan): ResolvedStructure =>
  ((resolvePlan(p).levels[0] as ResolvedLevel).structures ?? [])[0] as ResolvedStructure;
const b = (style: string, seed: number, w: number, h: number, extra: Partial<Building> = {}): Building => ({
  id: "b",
  style,
  seed,
  wings: [{ x: 8, y: 8, w, h }],
  ...extra,
});
const placementsOf = (p: MapPlan) => realize(resolvePlan(p), palettes).levels[0]?.placements ?? [];
const count = (p: MapPlan, re: RegExp): number => placementsOf(p).filter((q) => re.test(String(q.source.elementId))).length;

/** A chapel of four volumes: a nave, a chancel, an annex and a tower, ruined. */
const chapel = (seed: number, extra: Partial<Building> = {}): Building => ({
  id: "b",
  style: "cottage",
  seed,
  condition: "ruined",
  front: "S",
  volumes: [
    { id: "nave", x: 10, y: 10, w: 12, h: 8, storeys: [{ walls: "stone", footing: "none", height: 4 }], roof: { type: "gable", ridge: "ew" } },
    { id: "chancel", x: 22, y: 11, w: 5, h: 6, storeys: [{ walls: "stone", footing: "none", height: 3.5 }], roof: { type: "gable", ridge: "ew" } },
    { id: "annex", x: 6, y: 12, w: 4, h: 5, storeys: [{ walls: "stone", footing: "none", height: 3 }], roof: { type: "gable", ridge: "ns" } },
    { id: "tower", x: 10, y: 18, w: 4, h: 4, storeys: [{ walls: "stone", footing: "none", height: 4 }, { walls: "stone", height: 3.5 }], roof: { type: "flat", parapet: "stone" } },
  ],
  openings: [{ kind: "door", side: "S", position: 0.5 }],
  ...extra,
});

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

describe("growth that climbs (generator 3)", () => {
  it("ruined and weathered buildings carry vines, with the climbing share the study measured", () => {
    for (const condition of ["ruined", "weathered"] as const) {
      let withVines = 0;
      for (const seed of SEEDS) {
        const st = first(plan([b("cottage", seed, 8, 7, { condition })]));
        const g = growthMeasures(st);
        if (g.vines > 0) withVines++;
        // a share of the growth (heaps at the foot included) climbs: the study's ruins 15 % or more
        expect(g.climbingShare, `${condition} seed ${seed}`).toBeGreaterThanOrEqual(0.15);
      }
      expect(withVines).toBe(SEEDS.length);
    }
  });

  it("vines climb the wall faces, denser low down and thinning upward; plants stand within a tile of a wall", () => {
    const heights: number[] = [];
    for (const seed of SEEDS) {
      const p = plan([chapel(seed)]);
      const st = first(p);
      const cells = new Set(st.cells.map(([x, y]) => `${x},${y}`));
      const base = st.storeys[0]?.floorTop ?? 0;
      for (const g of st.growth ?? []) {
        if (g.kind === "vine" || g.kind === "root") {
          // on a face of the footprint, from the ground (or hanging from a tall top) up to at most the column's top
          expect(cells.has(`${g.at[0]},${g.at[1]}`)).toBe(true);
          expect(g.to).toBeGreaterThan(g.from);
          const col = st.ruin?.columns.find((c) => c.at[0] === g.at[0] && c.at[1] === g.at[1] && c.side === g.side);
          expect(col).toBeDefined();
          expect(g.to).toBeLessThanOrEqual((col?.top ?? 0) + 1e-6);
          if (g.kind === "vine" && g.from <= base + 1e-6) heights.push(g.to - base);
        }
      }
      // no vine or root on a doorway's or window's face (nor the cell beside it)
      const level = resolvePlan(p).levels[0] as ResolvedLevel;
      for (const o of level.openings.filter((q) => st.openingIds.includes(q.id)))
        for (let k = -1; k <= o.width; k++) {
          // the two faces the opening's edge can be (the building's cell on the one side or the other)
          const faces: Array<[number, number, string]> =
            o.orientation === "h"
              ? [[o.start[0] + k, o.start[1] - 1, "S"], [o.start[0] + k, o.start[1], "N"]]
              : [[o.start[0] - 1, o.start[1] + k, "E"], [o.start[0], o.start[1] + k, "W"]];
          for (const [x, y, side] of faces)
            expect(
              (st.growth ?? []).some((g) => g.kind !== "tree" && g.at[0] === x && g.at[1] === y && g.side === side),
            ).toBe(false);
        }
    }
    // thinning upward: far more vines reach 1.5 tiles than reach 4
    const reach = (h: number): number => heights.filter((x) => x >= h).length;
    expect(heights.length).toBeGreaterThan(20);
    expect(reach(1.5)).toBeGreaterThan(reach(4) * 2);
  });

  it("the compiler builds the growth: vine strands on the wall faces, roots, and a tree in a roofless ruin", () => {
    let vines = 0;
    let trees = 0;
    for (const seed of SEEDS) {
      const p = plan([chapel(seed)]);
      vines += count(p, /^b~vine$/);
      trees += count(p, /^b~tree$/);
      // stands near the wall: every vine strand within 1.5 cells of the footprint
      const st = first(p);
      const cells = new Set(st.cells.map(([x, y]) => `${x},${y}`));
      for (const q of placementsOf(p).filter((r) => r.source.elementId === "b~vine")) {
        const [cx, cy] = q.source.cell ?? [0, 0];
        const near = [-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => cells.has(`${cx + dx},${cy + dy}`)));
        expect(near).toBe(true);
      }
    }
    expect(vines).toBeGreaterThan(SEEDS.length * 5);
    expect(trees).toBeGreaterThan(0);
  });

  it("two ruins of one style differ by seed, deterministically", () => {
    const a = first(plan([chapel(1)])).growth;
    const a2 = first(plan([chapel(1)])).growth;
    const c = first(plan([chapel(2)])).growth;
    expect(a).toEqual(a2);
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(c));
  });

  it("generator 2 plans get no growth field, and an intact building none", () => {
    expect(first(plan([chapel(3)], 2)).growth).toBeUndefined();
    expect(first(plan([b("cottage", 3, 8, 7, { condition: "intact" })])).growth).toBeUndefined();
  });

  it("verifies clean: no door blocked by a plant, nothing floating", () => {
    for (const seed of SEEDS) {
      const p = plan([chapel(seed)]);
      const r = resolvePlan(p);
      const ver = verifyBuild(r, realize(r, palettes), palettes, { plan: p });
      expect(
        ver.diagnostics.filter((x) => x.severity === "error"),
        `seed ${seed}`,
      ).toEqual([]);
    }
  });

  it("the review flags a weathered or ruined building bare of growth, and nothing when it is overgrown", () => {
    const p = plan([chapel(4)]);
    const r = resolvePlan(p);
    const code = (rr: typeof r): string[] =>
      reviewDesign(p, rr, { limit: 99 }).filter((n) => n.code === "growth_bare").map((n) => n.code);
    expect(code(r)).toEqual([]);
    const st = (r.levels[0] as ResolvedLevel).structures?.[0] as ResolvedStructure;
    delete st.growth;
    expect(code(r)).toEqual(["growth_bare"]);
  });

  it("growth has an amount: coverage of the wall cells rises with the level, and each level meets what it promises", () => {
    const cover = (level: "none" | "light" | "medium" | "heavy" | undefined, seed: number, condition: "ruined" | "weathered" = "ruined"): number => {
      const st = first(plan([chapel(seed, { condition, ...(level ? { growth: level } : {}) })]));
      return growthMeasures(st).coverage;
    };
    const mean = (xs: number[]): number => xs.reduce((a, c) => a + c, 0) / xs.length;
    const by = (level: "none" | "light" | "medium" | "heavy") => SEEDS.map((s) => cover(level, s));
    expect(by("none").every((c) => c === 0)).toBe(true);
    expect(mean(by("light"))).toBeLessThan(mean(by("medium")));
    expect(mean(by("medium"))).toBeLessThan(mean(by("heavy")));
    // heavy is "a third to a half" of the exterior wall cells, on every seed
    for (const s of SEEDS) {
      expect(cover("heavy", s), `heavy seed ${s}`).toBeGreaterThanOrEqual(GROWTH_LEVELS.heavy.min);
      expect(cover("medium", s), `medium seed ${s}`).toBeGreaterThanOrEqual(GROWTH_LEVELS.medium.min);
      expect(cover("light", s), `light seed ${s}`).toBeGreaterThanOrEqual(GROWTH_LEVELS.light.min);
    }
    expect(mean(by("heavy"))).toBeGreaterThan(0.33);
    expect(mean(by("heavy"))).toBeLessThan(0.7);
    // defaults: medium for ruined, light for weathered; the level is data on the building
    expect(first(plan([chapel(3)])).growthLevel).toBe("medium");
    expect(first(plan([chapel(3, { condition: "weathered" })])).growthLevel).toBe("light");
    expect(first(plan([chapel(3, { condition: "intact" })])).growthLevel).toBeUndefined();
    expect(first(plan([chapel(3)], 2)).growthLevel).toBeUndefined();
  });

  it("heavy growth is the real thing: masses start at the ground and thin upward, bushes and trees stand in and at the walls", () => {
    let low = 0;
    let high = 0;
    let heaps = 0;
    let trees = 0;
    for (const s of SEEDS) {
      const st = first(plan([chapel(s, { growth: "heavy" })]));
      const base = st.storeys[0]?.floorTop ?? 0;
      for (const g of st.growth ?? []) {
        if (g.kind === "vine") {
          expect(g.thick ?? 1).toBeGreaterThanOrEqual(2);
          if (g.from <= base + 1e-6) low++;
          if (g.to - base >= 4) high++;
        }
        if (g.kind === "tree") trees++;
      }
      heaps += (st.debris ?? []).filter((d) => d.kind === "growth").length;
      // plants on the cut wall tops
    }
    expect(low).toBeGreaterThan(high * 2);
    expect(heaps).toBeGreaterThan(SEEDS.length * 6);
    expect(trees).toBeGreaterThan(SEEDS.length / 2);
    // compiled: far more climbing pieces than a medium ruin, three strands abreast at the foot
    const pieces = (g: "medium" | "heavy"): number => SEEDS.reduce((n, s) => n + count(plan([chapel(s, { growth: g })]), /^b~vine$/), 0);
    expect(pieces("heavy")).toBeGreaterThan(pieces("medium") * 1.6);
  });

  it("growth_bare fails a chapel with the sparse growth of the first proof (a share of almost nothing), and brief words ask for heavy", () => {
    const p = plan([chapel(5, { growth: "heavy" })]);
    const r = resolvePlan(p);
    const st = (r.levels[0] as ResolvedLevel).structures?.[0] as ResolvedStructure;
    const notes = (): string[] => reviewDesign(p, r, { limit: 99 }).filter((n) => n.code === "growth_bare").map((n) => n.message);
    expect(notes()).toEqual([]);
    // the v1 chapel: 14 single strands, two roots, two plants on 66 faces (coverage by area about a fifth of a face each)
    const vines = (st.growth ?? []).filter((g) => g.kind === "vine").slice(0, 14).map((g) => ({ ...g, thick: 1 }));
    const roots = (st.growth ?? []).filter((g) => g.kind === "root").slice(0, 2);
    st.growth = [...vines, ...roots, ...(st.growth ?? []).filter((g) => g.kind === "cap").slice(0, 2)];
    expect(growthMeasures(st).coverage).toBeLessThan(GROWTH_LEVELS.heavy.min);
    expect(notes().length).toBe(1);
    // the review's brief check: overgrown / ivy / reclaimed / abandoned want heavy growth
    const asked = { ...p, title: "An overgrown, ivy-covered chapel" };
    const brief = reviewDesign(asked, r, { limit: 99 }).filter((n) => n.code === "brief_not_met");
    expect(brief.some((n) => /heavy growth/.test(n.message))).toBe(true);
    const light = plan([chapel(5, { growth: "light" })]);
    expect(
      reviewDesign({ ...light, title: "Reclaimed ruin" }, resolvePlan(light), { limit: 99 }).some(
        (n) => n.code === "brief_not_met" && /heavy growth/.test(n.message),
      ),
    ).toBe(true);
    const ok = { ...plan([chapel(5, { growth: "heavy" })]), title: "Overgrown chapel" };
    expect(reviewDesign(ok, resolvePlan(ok), { limit: 99 }).some((n) => n.code === "brief_not_met" && /heavy growth/.test(n.message))).toBe(false);
  });
});

describe("a ruin keeps one roofed part as its anchor (generator 3)", () => {
  it("more often than not, with one volume whole under its roof and the rest decayed", () => {
    let kept = 0;
    for (const seed of SEEDS) {
      const st = first(plan([chapel(seed)]));
      const keep = st.ruin?.keep;
      if (keep === undefined) continue;
      kept++;
      const vol = st.volumes?.find((v) => v.id === keep);
      expect(vol?.roof.layers.length).toBeGreaterThan(0);
      // its walls stand whole
      const cells = new Set((vol?.storeys[0]?.cells ?? []).map(([x, y]) => `${x},${y}`));
      const cols = (st.ruin?.columns ?? []).filter((c) => cells.has(`${c.at[0]},${c.at[1]}`));
      expect(cols.length).toBeGreaterThan(0);
      expect(cols.every((c) => c.top >= c.full - 1e-6)).toBe(true);
      // the others have lost their roofs
      for (const v of st.volumes ?? []) if (v.id !== keep) expect(v.roof.layers.length === 0 || v.roof.gableOnly !== undefined).toBe(true);
      expect(structureRuinMeasures(st)?.intactShare ?? 0).toBeGreaterThan(0.1);
    }
    expect(kept).toBeGreaterThanOrEqual(5);
    expect(kept).toBeLessThan(SEEDS.length);
  });

  it("a ruin with stepped tops and one roofed part passes the flat-top check; a clean cut still fails", () => {
    // stepped tops and an anchor: no ruin_flat_top / ruin_uniform note on any seed
    let checked = 0;
    for (const seed of SEEDS) {
      const p = plan([chapel(seed)]);
      const r = resolvePlan(p);
      const st = (r.levels[0] as ResolvedLevel).structures?.[0] as ResolvedStructure;
      if (st.ruin?.keep === undefined) continue;
      checked++;
      const m = structureRuinMeasures(st);
      expect(m?.runShort ?? 0).toBeGreaterThanOrEqual(0.55);
      const notes = reviewDesign(p, r, { limit: 99 }).filter((n) => n.code === "ruin_flat_top" || n.code === "ruin_uniform");
      expect(notes, `seed ${seed}`).toEqual([]);
    }
    expect(checked).toBeGreaterThan(3);
    // a clean-cut ruin: every cut top at one height, one long run per face
    const p = plan([chapel(2)]);
    const r = resolvePlan(p);
    const st = (r.levels[0] as ResolvedLevel).structures?.[0] as ResolvedStructure;
    const ruin = st.ruin;
    expect(ruin).toBeDefined();
    if (!ruin) return;
    for (const c of ruin.columns) if (c.top < c.full - 1e-6) c.top = Math.min(c.full, (st.storeys[0]?.floorTop ?? 0) + 2);
    const m = structureRuinMeasures(st);
    expect(m?.runShort ?? 1).toBeLessThan(0.55);
    const notes = reviewDesign(p, r, { limit: 99 }).filter((n) => n.code === "ruin_flat_top");
    expect(notes.length).toBe(1);
  });

  it("a roof is always held up: the kept part keeps its wall where a wing stood against it, and the review catches a hanging eave", () => {
    let checked = 0;
    let joined = 0;
    for (const seed of SEEDS) {
      const p = plan([chapel(seed)]);
      const r = resolvePlan(p);
      const st = (r.levels[0] as ResolvedLevel).structures?.[0] as ResolvedStructure;
      expect(roofUnsupportedEdges(st), `seed ${seed}`).toEqual([]);
      const keep = st.ruin?.keep;
      if (keep === undefined) continue;
      checked++;
      // every face of the kept part that looks at another part of the building (a lost wing) is built as wall
      const vol = st.volumes?.find((v) => v.id === keep);
      const mine = new Set((vol?.storeys[0]?.cells ?? []).map(([x, y]) => `${x},${y}`));
      const others = new Set(
        (st.volumes ?? []).filter((v) => v.id !== keep && v.on === null).flatMap((v) => (v.storeys[0]?.cells ?? []).map(([x, y]) => `${x},${y}`)),
      );
      const tag = keep === st.volumes?.[0]?.id ? "b~wall" : `b~${keep}~wall`;
      const walls = realize(r, palettes).levels[0]?.placements.filter((q) => String(q.source.elementId) === tag) ?? [];
      const hosted = new Set(walls.map((q) => `${q.source.cell?.[0]},${q.source.cell?.[1]}`));
      for (const k of mine) {
        const [x, y] = k.split(",").map(Number) as [number, number];
        for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
          const nk = `${x + dx},${y + dy}`;
          if (!others.has(nk)) continue;
          joined++;
          expect(hosted.has(nk), `seed ${seed} wall under the eave at ${nk}`).toBe(true);
        }
      }
      // the check fires when a bay of the kept part's wall is cut away under its roof
      const col = st.ruin?.columns.find((c) => c.top >= c.full - 1e-6 && mine.has(`${c.at[0]},${c.at[1]}`));
      expect(col).toBeDefined();
      if (!col) continue;
      col.top = Math.max(0, col.full - 2);
      expect(roofUnsupportedEdges(st).length).toBeGreaterThan(0);
      expect(reviewDesign(p, r, { limit: 99 }).some((n) => n.code === "roof_unsupported")).toBe(true);
    }
    expect(checked).toBeGreaterThanOrEqual(5);
    expect(joined).toBeGreaterThan(0);
  });

  it("collapse goes top-down: no upper wall hangs over a breach", () => {
    for (const seed of SEEDS) {
      const p = plan([b("keep", seed, 9, 8, { condition: "ruined" })]);
      const r = resolvePlan(p);
      const st = (r.levels[0] as ResolvedLevel).structures?.[0] as ResolvedStructure;
      const level = r.levels[0] as ResolvedLevel;
      const groundTop = (st.storeys[0]?.floorTop ?? 0) + (st.storeys[0]?.wallHeight ?? 0);
      for (const o of level.openings.filter((q) => q.id.startsWith("b~breach")))
        for (let k = 0; k < o.width; k++) {
          const faces: Array<[number, number, string]> =
            o.orientation === "h"
              ? [[o.start[0] + k, o.start[1] - 1, "S"], [o.start[0] + k, o.start[1], "N"]]
              : [[o.start[0] - 1, o.start[1] + k, "E"], [o.start[0], o.start[1] + k, "W"]];
          for (const [x, y, side] of faces) {
            const col = st.ruin?.columns.find((c) => c.at[0] === x && c.at[1] === y && c.side === side);
            if (col) expect(col.top).toBeLessThanOrEqual(groundTop + 1e-6);
          }
        }
    }
  });

  it("wall tops read as a collapse, not battlements: few one-cell peaks and pits, long runs", () => {
    let total = 0;
    for (const seed of SEEDS) {
      const m = structureRuinMeasures(first(plan([chapel(seed)])));
      expect(m?.teeth ?? 1, `seed ${seed}`).toBeLessThanOrEqual(0.5);
      total += m?.teeth ?? 0;
    }
    expect(total / SEEDS.length).toBeLessThan(0.4);
    // a regular alternation (one block up, one down along every wall) is flagged
    const p = plan([chapel(2)]);
    const r = resolvePlan(p);
    const st = (r.levels[0] as ResolvedLevel).structures?.[0] as ResolvedStructure;
    const floor0 = st.storeys[0]?.floorTop ?? 0;
    for (const c of st.ruin?.columns ?? [])
      if (c.top < c.full - 1e-6) c.top = floor0 + 1 + (((c.side === "N" || c.side === "S" ? c.at[0] : c.at[1]) % 2) === 0 ? 1 : 0);
    expect(structureRuinMeasures(st)?.teeth ?? 0).toBeGreaterThan(0.6);
    expect(reviewDesign(p, r, { limit: 99 }).some((n) => n.code === "ruin_teeth")).toBe(true);
  });

  it("wall-top rubble is broken stuff at its own angles, never a neat pale block seated square", () => {
    let pieces = 0;
    const yaws = new Set<number>();
    for (const seed of SEEDS) {
      const p = plan([chapel(seed)]);
      for (const q of placementsOf(p).filter((r) => r.source.elementId === "b~walltop")) {
        pieces++;
        // (the pale 1x1 stair block that read as coping stones)
        expect(q.asset).not.toBe("0252d209-c23c-4f72-aa8b-51ed0dc09f3a");
        yaws.add(q.rot);
      }
    }
    expect(pieces).toBeGreaterThan(20);
    // turned in 15 degree steps: more than the four square orientations
    expect(yaws.size).toBeGreaterThan(4);
    expect([...yaws].some((y) => y % 90 !== 0)).toBe(true);
  });

  it("fallen material lies on the ground in clusters beside the fallen walls, inside and outside", () => {
    let inside = 0;
    let outside = 0;
    for (const seed of SEEDS) {
      const st = first(plan([chapel(seed)]));
      const cells = new Set(st.cells.map(([x, y]) => `${x},${y}`));
      const rub = (st.debris ?? []).filter((d) => d.kind === "rubble");
      for (const d of rub) {
        if (cells.has(`${d.at[0]},${d.at[1]}`)) inside++;
        else outside++;
      }
      // a cluster: heaps standing next to each other
      expect(rub.some((a) => rub.some((b) => b !== a && Math.abs(a.at[0] - b.at[0]) <= 1 && Math.abs(a.at[1] - b.at[1]) <= 1))).toBe(true);
    }
    expect(inside).toBeGreaterThan(SEEDS.length * 3);
    expect(outside).toBeGreaterThan(SEEDS.length * 3);
  });

  it("generator 2 ruins are unchanged: no anchor", () => {
    for (const seed of SEEDS) expect(first(plan([chapel(seed)], 2)).ruin?.keep).toBeUndefined();
  });
});
