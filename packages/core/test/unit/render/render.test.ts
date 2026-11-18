/** buildDisplayList, hit-testing, selection overlay, legend, and the §8.3 display-list performance target. */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import type { DisplayList } from "../../../src/contracts/resolved";
import {
  DEFAULT_DISPLAY_OPTIONS,
  LAYER_ORDER,
  SYMBOLS,
  buildDisplayList,
  buildPlanDisplayList,
  hitTest,
  legendEntries,
  levelLabels,
  selectRect,
  selectionItems,
} from "../../../src/render/index";
import { ringArea } from "../../../src/resolve/index";
import { resolvePlan } from "../../../src/resolve/index";
import { loadPlan } from "../../fixtures/index";

const a = resolvePlan(loadPlan("example-a"));
const l1 = a.levels.find((l) => l.id === "l1");
const l2 = a.levels.find((l) => l.id === "l2");
if (!l1 || !l2) throw new Error("levels");

const listA = buildPlanDisplayList(a, "l1", {}, "l1") as DisplayList;

describe("buildDisplayList", () => {
  it("is in layer paint order", () => {
    const ranks = listA.items.map((it) => LAYER_ORDER.indexOf(it.layer));
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
  });
  it("uses known symbol ids only", () => {
    for (const it of listA.items) if (it.symbol) expect(SYMBOLS[it.symbol.id], it.symbol.id).toBeDefined();
  });
  it("orients closed rings clockwise (outer) so non-zero fill equals even-odd", () => {
    for (const it of listA.items) {
      if (!it.geom?.closed || it.layer === "selection") continue;
      const total = it.geom.rings.reduce((s, r) => {
        const pts: Array<[number, number]> = [];
        for (let i = 0; i + 1 < r.length; i += 2) pts.push([r[i] as number, r[i + 1] as number]);
        return s + ringArea(pts);
      }, 0);
      expect(total, it.style).toBeGreaterThan(0);
    }
  });
  it("draws walls as half-cell strips in the host cell", () => {
    const walls = listA.items.filter((it) => it.layer === "wall");
    expect(walls.length).toBeGreaterThan(0);
    for (const it of walls)
      for (const r of it.geom?.rings ?? []) for (const v of r) expect((v * 2) % 1).toBe(0);
    // hall interior (x 8..23, y 6..13) stays free of wall strips
    const inside = (x: number, y: number): boolean => x > 8 && x < 23.5 && y > 6 && y < 14; // hall/ossuary wall is hosted in the (bigger) hall: x 23.5..24
    for (const it of walls)
      for (const r of it.geom?.rings ?? [])
        for (let i = 0; i + 1 < r.length; i += 2)
          expect(inside(r[i] as number, r[i + 1] as number)).toBe(false);
  });
  it("draws doors, the secret door, stairwell and a link badge to L2", () => {
    const ids = listA.items.map((it) => it.symbol?.id).filter(Boolean);
    expect(ids).toContain("door-door");
    expect(ids).toContain("door-secret_door");
    expect(ids).toContain("link-stairs");
    const badge = listA.items.find((it) => it.style === "link-badge-down");
    expect(badge?.text?.value).toBe("L2");
  });
  it("player view hides the secret door and draws it as wall", () => {
    const player = buildPlanDisplayList(a, "l1", { gmLayer: false }) as DisplayList;
    expect(player.items.some((it) => it.symbol?.id === "door-secret_door")).toBe(false);
    const wallArea = (l: DisplayList): number =>
      l.items
        .filter((it) => it.layer === "wall")
        .reduce(
          (s, it) =>
            s +
            (it.geom?.rings ?? []).reduce((t, r) => {
              const pts: Array<[number, number]> = [];
              for (let i = 0; i + 1 < r.length; i += 2) pts.push([r[i] as number, r[i + 1] as number]);
              return t + ringArea(pts);
            }, 0),
          0,
        );
    expect(wallArea(player) - wallArea(listA)).toBeCloseTo(0.5, 5);
  });
  it("toggles grid, room numbers, names and furniture", () => {
    const off = buildDisplayList(
      l1,
      { ...DEFAULT_DISPLAY_OPTIONS, grid: false, roomNumbers: false, furniture: false },
      { links: a.links },
    );
    expect(off.items.some((it) => it.layer === "grid")).toBe(false);
    expect(off.items.some((it) => it.style === "room-number")).toBe(false);
    expect(off.items.some((it) => it.symbol?.id === "feat-bunk_bed")).toBe(false);
    expect(off.items.some((it) => it.symbol?.id === "feat-pillar")).toBe(true);
    const names = buildDisplayList(l1, { ...DEFAULT_DISPLAY_OPTIONS, roomNames: true }, {});
    expect(names.items.filter((it) => it.style === "room-name").map((it) => it.text?.value)).toContain(
      "Hall of Pillars",
    );
  });
  it("places room names clear of furniture (a bookshelf right under the hall's badge)", () => {
    const plan = structuredClone(loadPlan("example-a"));
    plan.levels.find((l) => l.id === "l1")?.features.push({ id: "shelf_mid", type: "bookshelf", at: [15, 10] });
    const lvl = resolvePlan(plan).levels.find((l) => l.id === "l1");
    if (!lvl) throw new Error("l1");
    const shelf = lvl.features.find((f) => f.id === "shelf_mid");
    expect(shelf).toBeDefined();
    const covered = new Set<string>();
    for (const f of lvl.features)
      for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
        for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) covered.add(`${x},${y}`);
    const list = buildDisplayList(lvl, { ...DEFAULT_DISPLAY_OPTIONS, roomNames: true }, { links: a.links });
    const hall = list.items.find((it) => it.style === "room-name" && it.ref === "hall")?.text;
    expect(hall?.value).toBe("Hall of Pillars");
    if (!hall) return;
    // the name plate spans ~0.13 cell per character either side of its centre, in the row it sits in
    const half = hall.value.length * 0.13;
    const row = Math.floor(hall.y);
    for (let x = Math.floor(hall.x - half); x <= Math.floor(hall.x + half); x++)
      expect(covered.has(`${x},${row}`), `cell ${x},${row}`).toBe(false);
    // the badge sits directly above its name
    const badge = list.items.find((it) => it.style === "room-number" && it.ref === "hall")?.text;
    expect(badge?.x).toBe(hall.x);
    expect(Math.floor(badge?.y ?? 0)).toBe(row - 1);
    // and no room name shares a row strip with a plan label ("Collapsed Stair" vs "Up to the abbey")
    const span = (t: { value: string; x: number }): [number, number] => [
      t.x - t.value.length * 0.13,
      t.x + t.value.length * 0.13,
    ];
    const planLabels = list.items.filter((it) => it.style === "label").map((it) => it.text);
    expect(planLabels.length).toBeGreaterThan(0);
    for (const it of list.items) {
      if (it.style !== "room-name" || !it.text) continue;
      const [n0, n1] = span(it.text);
      for (const p of planLabels) {
        if (!p || Math.floor(p.y) !== Math.floor(it.text.y)) continue;
        const [p0, p1] = span(p);
        expect(n1 <= p0 || p1 <= n0, `${it.text.value} / ${p.value}`).toBe(true);
      }
    }
  });
  it("legend labels are unique (solid rock ground vs the rock feature)", () => {
    const list: DisplayList = {
      levelId: "l1",
      viewBox: { x: 0, y: 0, w: 4, h: 4 },
      items: [
        { layer: "ground", style: "rock", geom: { rings: [[0, 0, 4, 0, 4, 4, 0, 4]], closed: true } },
        { layer: "feature", style: "feat", symbol: { id: "feat-rock", x: 1, y: 1, w: 1, h: 1, rot: 0 } },
      ],
    };
    const labels = legendEntries(list).map((e) => e.label);
    expect(labels).toEqual(["Solid rock", "Rock"]);
    for (const l of [listA, buildPlanDisplayList(a, "l2", {}, "l1") as DisplayList]) {
      const ls = legendEntries(l).map((e) => e.label);
      expect(new Set(ls).size).toBe(ls.length);
    }
  });
  it("labels levels in tab order (entry first)", () => {
    expect(levelLabels(a, "l1")).toEqual({ l1: "L1", l2: "L2" });
    const tower = resolvePlan(loadPlan("multi-level-stairs"));
    expect(levelLabels(tower, "ground")).toEqual({ ground: "L1", study_lvl: "L2", roof: "L3" });
  });
  it("legend lists only what is drawn", () => {
    const labels = legendEntries(listA).map((e) => e.id);
    expect(labels).toContain("rock");
    expect(labels).toContain("feat-pillar");
    expect(labels).not.toContain("feat-tree");
  });
});

describe("hitTest", () => {
  const ctx = { links: a.links };
  it("feature > opening > link > area > cell", () => {
    expect(hitTest(l1, [10.5, 8.5], ctx)).toEqual({ kind: "feature", id: "p1", area: "hall" });
    expect(hitTest(l1, [24.1, 9.5], ctx)).toEqual({ kind: "opening", id: "d_secret" });
    expect(hitTest(l1, [26.5, 10.5], ctx)).toEqual({ kind: "link", id: "stair_main" });
    expect(hitTest(l1, [12.5, 12.5], ctx)).toEqual({ kind: "area", id: "hall" });
    expect(hitTest(l1, [0.5, 0.5], ctx)).toEqual({ kind: "cell", cell: [0, 0] });
    expect(hitTest(l1, [-1, 3], ctx)).toBeNull();
  });
  it("opening tolerance is 0.2 cell", () => {
    expect(hitTest(l1, [24.19, 9.5])?.kind).toBe("opening");
    expect(hitTest(l1, [24.25, 9.5])?.kind).toBe("area");
  });
  it("region selection collects areas, features, openings and links", () => {
    const sel = selectRect(l1, { x: 20, y: 7, w: 8, h: 4 }, ctx);
    expect(sel.areaIds).toEqual(["hall", "ossuary"]);
    expect(sel.featureIds).toContain("p7");
    expect(sel.openingIds).toEqual(["d_secret"]);
    expect(sel.linkIds).toEqual(["stair_main"]);
    const items = selectionItems(l1, sel, "select", ctx);
    expect(items.every((it) => it.layer === "selection")).toBe(true);
    expect(items.some((it) => it.style === "select-rect")).toBe(true);
  });
});

/** 160×160 outdoor map with ~4,000 scattered features plus rooms, roads and water. */
function bigPlan(): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator: 1,
    id: "perf",
    title: "Perf",
    kind: "outdoor",
    seed: 77,
    theme: "outdoor",
    levels: [
      {
        id: "g",
        name: "Big",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 160, h: 160 },
        base: { type: "ground", material: "grass" },
        areas: Array.from({ length: 12 }, (_, k) => ({
          id: `b${k}`,
          kind: "building" as const,
          key: String(k + 1),
          shape: { type: "rect" as const, x: 8 + (k % 4) * 38, y: 10 + Math.floor(k / 4) * 50, w: 10, h: 8 },
        })),
        openings: [],
        walls: [],
        features: [],
        terrain: [
          {
            id: "dirt",
            op: "noise",
            shape: { type: "rect", x: 0, y: 0, w: 160, h: 160 },
            material: "dirt",
            coverage: 0.25,
            scale: 7,
          },
          {
            id: "river",
            op: "path",
            points: [
              [80, 0],
              [70, 80],
              [90, 159],
            ],
            width: 4,
            material: "water_shallow",
            jitter: 0.3,
          },
          {
            id: "trees",
            op: "scatter",
            feature: "tree",
            density: 0.2,
            minSpacing: 1,
            avoid: ["water", "areas"],
          },
        ],
        labels: [],
      },
    ],
    links: [],
  };
}

describe("performance (§8.3)", () => {
  it("builds the display list of a 160×160 level with 4,000 features in < 150 ms", () => {
    const r = resolvePlan(bigPlan());
    const lvl = r.levels[0];
    if (!lvl) throw new Error("level");
    expect(lvl.features.length).toBeGreaterThanOrEqual(4000);
    buildDisplayList(lvl, DEFAULT_DISPLAY_OPTIONS); // warm-up (JIT)
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      buildDisplayList(lvl, DEFAULT_DISPLAY_OPTIONS);
      times.push(performance.now() - t0);
    }
    // best of 5 keeps the test robust on a busy CI runner while still catching algorithmic regressions
    expect(Math.min(...times)).toBeLessThan(150);
  });
});
