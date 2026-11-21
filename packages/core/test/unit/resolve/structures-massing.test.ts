/**
 * Building massing and its finish: massing (volumes, on, storey heights), silhouette (set-in storeys and their
 * seams, chamfered corners, the plinth with steps), stacked roof layers (gable, hip, shed, skirt, stepped, spire,
 * flat), roof furniture (clutter, mast, finial), lights (lit windows, entrance strips), and the wizard_tower and
 * modern_block styles: seeded variety, 100 seeds each valid and buildable.
 */
import { describe, expect, it } from "vitest";
import type { Building, Level, MapPlan, Structure } from "../../../src/contracts/plan";
import type { ResolvedLevel } from "../../../src/contracts/resolved";
import { compileResolved, realize, verifyBuild } from "../../../src/compile";
import { placementMeta } from "../../../src/compile/realize";
import { loadPalettes } from "../../../src/palette";
import { validatePlan } from "../../../src/plan";
import { resolvePlan } from "../../../src/resolve/index";
import "../../../src/resolve/autoregister";
import { canonicalJson } from "../../../src/util/canonical";
import { townPlan } from "../../fixtures/planBuilder";

const palettes = loadPalettes();

const plan = (structures: Structure[], extra: Partial<Level> = {}): MapPlan =>
  townPlan({ generator: 2, id: "phase2", seed: 17, w: 36, h: 30, lot: "land", structures, level: extra });

const level0 = (p: MapPlan): ResolvedLevel => resolvePlan(p).levels[0] as ResolvedLevel;
const build = (p: MapPlan) => {
  const r = resolvePlan(p);
  const set = realize(r, palettes);
  const pl = set.levels[0]?.placements ?? [];
  return { r, set, pl, L: r.levels[0] as ResolvedLevel };
};
const errorsOf = (p: MapPlan) => validatePlan(p).issues.filter((i) => i.severity === "error");
const warningsOf = (p: MapPlan) => validatePlan(p).issues.filter((i) => i.severity === "warning");

const tower = (more: Partial<Building> = {}): Building => ({
  id: "tower",
  style: "wizard_tower",
  wings: [{ x: 12, y: 8, w: 10, h: 10 }],
  openings: [{ kind: "door", side: "S" }],
  ...more,
});
const block = (more: Partial<Building> = {}): Building => ({
  id: "block",
  style: "modern_block",
  wings: [{ x: 4, y: 6, w: 8, h: 10 }],
  volumes: [
    { id: "tall", x: 4, y: 6, w: 8, h: 10, storeys: 5 },
    { id: "low", x: 12, y: 8, w: 12, h: 8, storeys: 1, storeyHeight: 4 },
  ],
  openings: [{ kind: "double_door", side: "S", position: 0.3, width: 2 }],
  ...more,
});

describe("massing", () => {
  it("volumes of different heights: one ground storey area, own storeys and heights per volume", () => {
    const L = level0(plan([block()]));
    const st = L.structures?.[0];
    expect(st?.volumes?.map((v) => v.id)).toEqual(["tall", "low"]);
    const area = L.areas.find((a) => a.id === "block");
    expect(area?.cellCount).toBe(8 * 10 + 12 * 8);
    const [tall, low] = st?.volumes ?? [];
    expect(tall?.storeys.length).toBe(5);
    expect(low?.storeys.length).toBe(1);
    expect((low?.storeys[0]?.wallTop ?? 0) - (low?.storeys[0]?.floorTop ?? 0)).toBe(4);
    // each storey's floor lies on the wall top of the one below (half a tile of floor)
    for (let i = 1; i < (tall?.storeys.length ?? 0); i++)
      expect(tall?.storeys[i]?.floorTop).toBe((tall?.storeys[i - 1]?.wallTop ?? 0) + 0.5);
  });

  it("a volume on another starts on its roof", () => {
    const p = plan([
      {
        id: "hall",
        style: "keep",
        wings: [{ x: 8, y: 8, w: 10, h: 8 }],
        volumes: [
          { id: "hall", x: 8, y: 8, w: 10, h: 8, storeys: 1 },
          { id: "top", x: 10, y: 10, w: 4, h: 4, storeys: 2, on: "hall" },
        ],
        openings: [{ kind: "door", side: "S" }],
      },
    ]);
    expect(errorsOf(p)).toEqual([]);
    const st = level0(p).structures?.[0];
    const [hall, top] = st?.volumes ?? [];
    expect(top?.on).toBe("hall");
    expect(top?.storeys[0]?.floorTop).toBe((hall?.storeys[0]?.wallTop ?? 0) + 0.5);
  });

  it("builds no wall between joined ground volumes and no duplicate pieces", () => {
    const { pl } = build(plan([block()]));
    const seen = new Set<string>();
    let dup = 0;
    for (const q of pl) {
      const k = `${q.asset}|${q.x}|${q.y}|${q.z}|${q.rot}`;
      if (seen.has(k)) dup++;
      seen.add(k);
    }
    expect(dup).toBe(0);
    // the low volume's west face (x = 12) is covered by the tall one: no low wall stands on that line
    const lowWalls = pl.filter((q) => q.source.elementId === "block~low~wall");
    expect(lowWalls.length).toBeGreaterThan(0);
    expect(lowWalls.every((q) => (q.source.cell?.[0] ?? 0) !== 11)).toBe(true);
  });

  it("upper storeys close the floor band and never reach into the storey below", () => {
    const { pl, L } = build(plan([block()]));
    const tall = L.structures?.[0]?.volumes?.[0];
    for (let s = 1; s < 5; s++) {
      const floor = tall?.storeys[s]?.floorTop ?? 0;
      const ws = pl.filter((q) => q.layer === `storey:${s}` && q.source.elementId === "block~wall");
      expect(ws.length).toBeGreaterThan(0);
      // the course starts on the wall top below (covering the floor band), not lower
      expect(Math.min(...ws.map((q) => q.y))).toBeCloseTo(floor - 0.5);
    }
  });
});

describe("silhouette", () => {
  const stepped = tower({
    storeys: [
      {},
      { inset: 1, seam: "skirt" },
      { inset: 1, seam: "crenellated" },
      { inset: 1, seam: "plain" },
    ],
  });

  it("set-in storeys step in by a cell and record their seam", () => {
    const st = level0(plan([stepped])).structures?.[0];
    const v = st?.volumes?.[0];
    expect(v?.storeys.map((s) => s.rect.w)).toEqual([10, 8, 6, 4]);
    expect(v?.storeys.map((s) => s.seam)).toEqual([null, "skirt", "crenellated", "plain"]);
    expect(v?.corners).toBe("chamfer");
    // chamfered: the four corner cells of every storey are cut
    expect(v?.storeys[0]?.cells.length).toBe(100 - 4);
  });

  it("builds a skirt of roof slope, a battlemented ledge and a plain ledge at the three set-ins", () => {
    const { pl } = build(plan([stepped]));
    expect(pl.some((q) => q.source.elementId === "tower~seam1~roof")).toBe(true);
    expect(pl.some((q) => q.source.elementId === "tower~seam2~ledge")).toBe(true);
    expect(pl.some((q) => q.source.elementId === "tower~seam2~crenel")).toBe(true);
    expect(pl.some((q) => q.source.elementId === "tower~seam3~ledge")).toBe(true);
    expect(pl.some((q) => q.source.elementId === "tower~seam3~crenel")).toBe(false);
  });

  it("a set-in that would leave a storey narrower than 2 cells keeps the width, with a warning", () => {
    const p = plan([tower({ wings: [{ x: 12, y: 8, w: 4, h: 4 }], storeys: [{}, { inset: 2 }] })]);
    expect(warningsOf(p).some((i) => /narrower than 2 cells/.test(i.message))).toBe(true);
  });

  it("a plinth raises the building and gets steps to its door", () => {
    const p = plan([tower({ plinth: { height: 2, margin: 3, face: "rock", rim: "low_wall" } })]);
    expect(errorsOf(p)).toEqual([]);
    const L = level0(p);
    const st = L.structures?.[0];
    expect(st?.plinth?.height).toBe(2);
    expect(st?.volumes?.[0]?.storeys[0]?.floorTop).toBe(2.5);
    const { set, r } = build(p);
    const ver = verifyBuild(r, set, palettes, { plan: p });
    expect(ver.diagnostics.filter((d) => d.code === "verify_area_unreachable")).toEqual([]);
  });
});

describe("stacked roofs", () => {
  const one = (roof: NonNullable<Building["roof"]>, more: Partial<Building> = {}): MapPlan =>
    plan([
      {
        id: "b",
        style: "cottage",
        wings: [{ x: 10, y: 8, w: 7, h: 5 }],
        openings: [{ kind: "door", side: "S" }],
        roof,
        chimneys: [],
        ...more,
      },
    ]);

  for (const type of ["hip", "shed", "skirt", "stepped", "spire"] as const)
    it(`builds a ${type} roof with no errors`, () => {
      const p = one({ type });
      expect(errorsOf(p)).toEqual([]);
      const st = level0(p).structures?.[0];
      expect(st?.volumes?.[0]?.roof.layers[0]?.type).toBe(type);
      const { r, set, pl } = build(p);
      expect(pl.filter((q) => q.layer === "roof").length).toBeGreaterThan(5);
      const ver = verifyBuild(r, set, palettes, { plan: p });
      expect(ver.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    });

  it("cone builds as a spire; dome is built flat with a warning", () => {
    expect(level0(one({ type: "cone" })).structures?.[0]?.volumes?.[0]?.roof.layers[0]?.type).toBe("spire");
    const p = one({ type: "dome" });
    expect(warningsOf(p).some((i) => /"dome" roofs are not built yet/.test(i.message))).toBe(true);
  });

  it("stacks layers: a skirt, then a spire on the flat top it leaves, ending in a pointed tip (or a finial)", () => {
    const p = one({ type: "skirt", layers: [{ type: "skirt" }, { type: "spire", courses: 1 }] });
    const { pl } = build(p);
    // a kit without tile-faced thin walls (slate) builds the spire as a steep pyramid of its own roof pieces
    const roof = pl.filter((q) => q.source.elementId === "b~roof");
    // the kit's pointed tip piece is the spire's own finial (nothing balances on its point); a finial otherwise
    const finial = pl.filter((q) => q.source.elementId === "b~finial" || q.source.elementId === "b~tip");
    expect(pl.some((q) => q.source.elementId === "b~spire")).toBe(false); // never a stack of wall boxes
    expect(roof.length).toBeGreaterThan(0);
    expect(finial.length).toBe(1);
    expect(finial[0]?.y ?? 0).toBeGreaterThanOrEqual(Math.max(...roof.map((q) => q.y)));
  });

  it("a flat roof gets its parapet along every edge", () => {
    const { pl } = build(one({ type: "flat", parapet: "low_wall" }));
    expect(pl.filter((q) => q.source.elementId === "b~parapet").length).toBeGreaterThan(8);
  });
});

describe("roof furniture and lights", () => {
  it("a modern block gets roof clutter, a mast assembly and lit windows from the style; overrides switch them off", () => {
    const on = build(
      plan([
        block({ roofFurniture: { clutter: 0.4, mast: true }, lighting: { windows: "warm", strips: true } }),
      ]),
    );
    const ids = (pl: typeof on.pl, id: string) => pl.filter((q) => q.source.elementId === id);
    expect(ids(on.pl, "block~clutter").length).toBeGreaterThan(2);
    expect(ids(on.pl, "block~mast").length).toBeGreaterThanOrEqual(1); // a dish mast (an assembly where the palette has parts)
    expect(ids(on.pl, "block~strip").length).toBe(2);
    // clutter pieces keep a cell apart
    const cells = ids(on.pl, "block~clutter").map((q) => q.source.cell ?? [0, 0]);
    for (let i = 0; i < cells.length; i++)
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i] as [number, number];
        const b = cells[j] as [number, number];
        expect(Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))).toBeGreaterThan(1);
      }
    const off = build(
      plan([
        block({ roofFurniture: { clutter: 0, mast: false }, lighting: { windows: "none", strips: false } }),
      ]),
    );
    expect(ids(off.pl, "block~clutter")).toEqual([]);
    expect(ids(off.pl, "block~mast")).toEqual([]);
    expect(ids(off.pl, "block~lit")).toEqual([]);
    expect(ids(off.pl, "block~strip")).toEqual([]);
  });

  it("a wizard tower's lit windows glow (crystals on the floor inside the window)", () => {
    const { pl } = build(plan([tower({ lighting: { windows: "glow" } })]));
    const lit = pl.filter((q) => q.source.elementId === "tower~lit");
    expect(lit.length).toBeGreaterThan(0);
    expect(lit.every((q) => /crystal/i.test(placementMeta.get(q)?.name ?? ""))).toBe(true);
  });
});

describe("wizard tower and modern block styles", () => {
  for (const [name, make] of [
    ["wizard_tower", (seed: number) => plan([tower({ seed })])],
    ["modern_block", (seed: number) => plan([block({ seed })])],
  ] as const) {
    it(`${name}: another seed gives another building; the same seed is byte-stable`, () => {
      const a = build(make(1));
      const a2 = build(make(1));
      expect(canonicalJson(a.pl)).toBe(canonicalJson(a2.pl));
      const variants = new Set<string>();
      for (const s of [1, 2, 3, 4, 5, 6]) {
        const st = level0(make(s)).structures?.[0];
        variants.add(canonicalJson({ v: st?.volumes, l: st?.lighting, f: st?.furniture, p: st?.plinth }));
      }
      expect(variants.size).toBeGreaterThan(3);
    });

    it(`${name}: 100 seeds are valid and build without errors`, () => {
      for (let seed = 0; seed < 100; seed++) {
        const p = make(seed);
        expect(errorsOf(p), `seed ${seed}`).toEqual([]);
        const r = resolvePlan(p);
        const set = realize(r, palettes);
        const ver = verifyBuild(r, set, palettes, { plan: p });
        expect(
          ver.diagnostics.filter((d) => d.severity === "error" || d.code === "verify_area_unreachable"),
          `seed ${seed}`,
        ).toEqual([]);
      }
    }, 30_000); // 100 resolve + realize + verify runs: 5.5 to 6.5 s under a parallel run, over the 5 s default
  }

  it("a tall building compiles to one slab under the size budget", () => {
    const p = plan([tower({ seed: 3 })]);
    const bundle = compileResolved(resolvePlan(p), palettes, undefined, { plan: p });
    expect(bundle.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(bundle.chunks.length).toBe(1);
  });
});
