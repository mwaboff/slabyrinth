/**
 * drawDisplayList against a recording Canvas2DLike (Canvas does not exist in Node): balanced save/restore, every
 * colour from the theme, culling, every symbol has a painter, theme completeness, PNG size clamping.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MapPlan } from "@slabyrinth/core/contracts/plan";
import type { Canvas2DLike, DisplayList, MapTheme } from "@slabyrinth/core/contracts/resolved";
import { SYMBOLS, buildPlanDisplayList, legendEntries } from "@slabyrinth/core/render";
import { resolvePlan } from "@slabyrinth/core/resolve";
import {
  DEFAULT_MAP_THEME_ID,
  MAP_THEMES,
  MAX_PNG_SIDE,
  PAINTERS,
  REQUIRED_TOKENS,
  drawDisplayList,
  drawExport,
  drawLegendSwatch,
  getMapTheme,
  keyPanelGeometry,
  pngLayout,
} from "../src/index";

type Call = { op: string; args: unknown[] };

class RecordingContext implements Canvas2DLike {
  calls: Call[] = [];
  depth = 0;
  maxDepth = 0;
  fills: string[] = [];
  strokes: string[] = [];
  private _fill: unknown = "#000";
  private _stroke: unknown = "#000";
  lineWidth = 1;
  font = "10px sans-serif";
  globalAlpha = 1;
  textAlign = "start";
  textBaseline = "alphabetic";
  lineJoin = "miter";
  lineCap = "butt";
  get fillStyle(): unknown {
    return this._fill;
  }
  set fillStyle(v: unknown) {
    this._fill = v;
    this.calls.push({ op: "fillStyle", args: [v] });
  }
  get strokeStyle(): unknown {
    return this._stroke;
  }
  set strokeStyle(v: unknown) {
    this._stroke = v;
    this.calls.push({ op: "strokeStyle", args: [v] });
  }
  private rec(op: string, args: unknown[]): void {
    for (const a of args)
      if (typeof a === "number" && !Number.isFinite(a)) throw new Error(`${op}: non-finite argument`);
    this.calls.push({ op, args });
  }
  save(): void {
    this.depth++;
    this.maxDepth = Math.max(this.maxDepth, this.depth);
    this.rec("save", []);
  }
  restore(): void {
    this.depth--;
    if (this.depth < 0) throw new Error("restore without save");
    this.rec("restore", []);
  }
  setTransform(...a: number[]): void {
    this.rec("setTransform", a);
  }
  translate(x: number, y: number): void {
    this.rec("translate", [x, y]);
  }
  rotate(r: number): void {
    this.rec("rotate", [r]);
  }
  scale(x: number, y: number): void {
    this.rec("scale", [x, y]);
  }
  beginPath(): void {
    this.rec("beginPath", []);
  }
  closePath(): void {
    this.rec("closePath", []);
  }
  moveTo(x: number, y: number): void {
    this.rec("moveTo", [x, y]);
  }
  lineTo(x: number, y: number): void {
    this.rec("lineTo", [x, y]);
  }
  arc(x: number, y: number, r: number, a0: number, a1: number): void {
    if (r < 0) throw new Error("negative radius");
    this.rec("arc", [x, y, r, a0, a1]);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.rec("rect", [x, y, w, h]);
  }
  fill(): void {
    this.fills.push(String(this._fill));
    this.rec("fill", []);
  }
  stroke(): void {
    this.strokes.push(String(this._stroke));
    this.rec("stroke", []);
  }
  clip(): void {
    this.rec("clip", []);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.fills.push(String(this._fill));
    this.rec("fillRect", [x, y, w, h]);
  }
  fillText(t: string, x: number, y: number): void {
    this.fills.push(String(this._fill));
    this.rec("fillText", [t, x, y]);
  }
  measureText(t: string): { width: number } {
    return { width: t.length * 6 };
  }
  setLineDash(s: number[]): void {
    this.rec("setLineDash", [s]);
  }
}

const loadFixture = (name: string): MapPlan =>
  JSON.parse(
    readFileSync(new URL(`../../core/test/fixtures/plans/${name}.json`, import.meta.url), "utf8"),
  ) as MapPlan;

const resolvedA = resolvePlan(loadFixture("example-a"));
const resolvedB = resolvePlan(loadFixture("example-b"));
const listA = buildPlanDisplayList(resolvedA, "l1", { roomNames: true }, "l1") as DisplayList;
const listA2 = buildPlanDisplayList(resolvedA, "l2", {}, "l1") as DisplayList;
const listB = buildPlanDisplayList(resolvedB, "g", {}) as DisplayList;

function record(
  list: DisplayList,
  theme: MapTheme,
  scale = 24,
  viewport?: { x: number; y: number; w: number; h: number },
): RecordingContext {
  const ctx = new RecordingContext();
  drawDisplayList(
    ctx,
    list,
    theme,
    viewport ? { scale, offsetX: 0, offsetY: 0, viewport } : { scale, offsetX: 0, offsetY: 0 },
  );
  return ctx;
}

describe("drawDisplayList", () => {
  it.each(Object.keys(MAP_THEMES))("theme %s: balanced save/restore and only theme colours", (id) => {
    const theme = getMapTheme(id);
    const allowed = new Set(Object.values(theme.colors));
    for (const list of [listA, listA2, listB]) {
      const ctx = record(list, theme);
      expect(ctx.depth).toBe(0);
      expect(ctx.calls.length).toBeGreaterThan(500);
      for (const c of [...ctx.fills, ...ctx.strokes])
        expect(allowed.has(c), `${c} not from ${id}`).toBe(true);
      const fonts = ctx.calls.filter((c) => c.op === "fillText");
      expect(fonts.length).toBeGreaterThan(0);
    }
  });

  it("draws room numbers and the link badge text", () => {
    const texts = record(listA, getMapTheme(DEFAULT_MAP_THEME_ID))
      .calls.filter((c) => c.op === "fillText")
      .map((c) => c.args[0]);
    expect(texts).toEqual(
      expect.arrayContaining(["1", "2", "3", "4", "L2", "S", "Hall of Pillars", "Up to the abbey"]),
    );
  });

  it("culls items outside the viewport", () => {
    const theme = getMapTheme(DEFAULT_MAP_THEME_ID);
    const full = record(listB, theme).calls.length;
    const part = record(listB, theme, 24, { x: 0, y: 0, w: 8, h: 8 }).calls.length;
    expect(part).toBeLessThan(full / 4);
  });

  it("is deterministic (same calls twice)", () => {
    const theme = getMapTheme("print");
    expect(JSON.stringify(record(listA, theme).calls)).toBe(JSON.stringify(record(listA, theme).calls));
  });

  it("draws open air (VOID cells) as plain background, not a black slab", () => {
    const plan = {
      ...loadFixture("example-a"),
      levels: [{ ...loadFixture("example-a").levels[0], id: "up", base: { type: "void" }, terrain: [] }],
      links: [],
      entryLevel: "up",
    } as unknown as MapPlan;
    const list = buildPlanDisplayList(resolvePlan(plan), "up", {}) as DisplayList;
    expect(list.items.some((it) => it.layer === "ground" && it.style === "void")).toBe(true);
    for (const id of ["print", "ohsheet-light", "ohsheet-dark"]) {
      const theme = getMapTheme(id);
      const ctx = record({ ...list, items: list.items.filter((it) => it.layer === "ground") }, theme);
      expect(ctx.fills.length).toBeGreaterThan(0);
      expect(
        ctx.fills.every((c) => c === theme.colors["paper"]),
        id,
      ).toBe(true);
    }
  });

  it("works at tiny and huge scales", () => {
    for (const s of [2, 6, 140]) expect(record(listA, getMapTheme("ohsheet-light"), s).depth).toBe(0);
  });
});

describe("symbols and themes", () => {
  it("every catalogue symbol has a painter", () => {
    for (const id of Object.keys(SYMBOLS)) expect(PAINTERS[id], id).toBeTypeOf("function");
  });
  it("every painter draws without errors in every theme", () => {
    for (const theme of Object.values(MAP_THEMES)) {
      for (const [id, paint] of Object.entries(PAINTERS)) {
        const ctx = new RecordingContext();
        for (const style of ["feat", "link-up", "link-down"])
          paint({ ctx, theme, u: 24, w: 24, h: 48, style, seed: 3, lw: 1.5, rot: 90 });
        expect(ctx.depth, id).toBe(0);
      }
    }
  });
  it("a covered stall (generator 4) is drawn as its canopy: a panel, a ridge, rafters, a heavy front eave and four posts", () => {
    const theme = getMapTheme("ohsheet-light");
    for (const side of ["N", "E", "S", "W"]) {
      const paint = PAINTERS[`feat-stall_cover_${side}`];
      expect(paint, side).toBeTypeOf("function");
      const ctx = new RecordingContext();
      paint?.({ ctx, theme, u: 24, w: 72, h: 72, style: "feat", seed: 1, lw: 1.5, rot: 0 });
      expect(ctx.depth).toBe(0);
      // the canopy panel, rafters, front eave and four posts are each stroked
      expect(ctx.strokes.length).toBeGreaterThanOrEqual(7);
      expect(ctx.calls.filter((c) => c.op === "rect").length).toBe(4);
    }
  });
  it("themes define every required token", () => {
    for (const theme of Object.values(MAP_THEMES))
      for (const t of REQUIRED_TOKENS) expect(theme.colors[t], `${theme.id}.${t}`).toBeDefined();
  });
  it("skin B v2 dark is the default", () => {
    expect(DEFAULT_MAP_THEME_ID).toBe("ohsheet-dark");
    expect(getMapTheme("no-such-theme").id).toBe("ohsheet-dark");
    expect(getMapTheme("ohsheet-dark").colors["paper"]).toBe("#120E0B");
  });
});

describe("PNG export layout", () => {
  it("uses px per square and clamps each side to 16384", () => {
    expect(pngLayout(listA, { pxPerCell: 70, background: "theme" })).toMatchObject({
      pxPerCell: 70,
      width: 2170,
      height: 1750,
      clamped: false,
    });
    const big = pngLayout(
      { ...listA, viewBox: { x: 0, y: 0, w: 160, h: 160 } },
      { pxPerCell: 140, background: "theme" },
    );
    expect(big.clamped).toBe(true);
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(MAX_PNG_SIDE);
  });
  it("draws the export with key panel and legend", () => {
    const ctx = new RecordingContext();
    const opts = {
      pxPerCell: 40,
      background: "theme" as const,
      legend: true,
      keyPanel: [{ key: "1", name: "Collapsed Stair" }],
      title: "Upper Crypts",
    };
    drawExport(ctx, listA, getMapTheme("print"), opts);
    expect(ctx.depth).toBe(0);
    const texts = ctx.calls.filter((c) => c.op === "fillText").map((c) => c.args[0]);
    expect(texts).toEqual(expect.arrayContaining(["Collapsed Stair", "Upper Crypts", "Pillar"]));
  });
  it("wraps a long room key into extra columns instead of dropping entries", () => {
    const small: DisplayList = { ...listA, viewBox: { x: 0, y: 0, w: 10, h: 10 } };
    const keyPanel = Array.from({ length: 60 }, (_, k) => ({
      key: String(k + 1),
      name: `Room number ${k + 1}`,
    }));
    const opts = { pxPerCell: 70, background: "theme" as const, keyPanel };
    const geo = keyPanelGeometry(70, pngLayout(small, opts).mapHeight, opts);
    expect(geo.cols).toBeGreaterThan(1);
    expect(geo.rows * geo.cols).toBeGreaterThanOrEqual(60);
    const one = pngLayout(small, { ...opts, keyPanel: keyPanel.slice(0, 1) });
    expect(pngLayout(small, opts).width).toBe(one.width + (geo.cols - 1) * geo.colW);
    const ctx = new RecordingContext();
    drawExport(ctx, small, getMapTheme("print"), opts);
    const texts = ctx.calls.filter((c) => c.op === "fillText").map((c) => c.args[0]);
    for (const e of keyPanel) expect(texts).toContain(e.name);
  });

  it("legend swatches draw for every legend entry", () => {
    for (const e of legendEntries(listA)) {
      const ctx = new RecordingContext();
      drawLegendSwatch(ctx, e, getMapTheme("ohsheet-dark"), { x: 0, y: 0, w: 32, h: 24 });
      expect(ctx.depth).toBe(0);
    }
  });
});

describe("depth: chasm, cliffs and bridges", () => {
  const plan: MapPlan = {
    schema: "slabyrinth/plan@1",
    generator: 2,
    id: "depth",
    title: "Depth",
    kind: "cave",
    theme: "cave",
    seed: 3,
    links: [],
    levels: [
      {
        id: "lv",
        name: "L",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 24, h: 14 },
        base: { type: "solid" },
        areas: [{ id: "c", kind: "cave", shape: { type: "rect", x: 1, y: 1, w: 22, h: 12 } }],
        openings: [],
        walls: [],
        features: [],
        terrain: [
          {
            id: "rift",
            op: "chasm",
            points: [
              [12, 0],
              [12, 13],
            ],
            width: 3,
            depth: 3,
            floor: "lava",
            bridges: [{ width: 2, crumble: 0.25 }],
          },
        ],
        labels: [],
      },
    ],
  };
  const list = buildPlanDisplayList(resolvePlan(plan), "lv") as DisplayList;
  it.each(Object.keys(MAP_THEMES))("theme %s: cliffs and the bridge draw with theme colours only", (id) => {
    const theme = getMapTheme(id);
    const allowed = new Set(Object.values(theme.colors));
    const ctx = record(list, theme);
    expect(ctx.depth).toBe(0);
    for (const c of [...ctx.fills, ...ctx.strokes]) expect(allowed.has(c), `${c} not from ${id}`).toBe(true);
  });
  it("deeper floors get a darker tint than shallow ones", () => {
    const theme = getMapTheme("print");
    const alphaFor = (q: number): number => {
      const one: DisplayList = {
        ...list,
        items: [
          {
            layer: "height_shade",
            style: `height-down-${q}`,
            geom: { rings: [[0, 0, 1, 0, 1, 1, 0, 1]], closed: true },
          },
        ],
      };
      const ctx = new RecordingContext();
      let seen = 1;
      const orig = ctx.fill.bind(ctx);
      ctx.fill = () => {
        seen = ctx.globalAlpha;
        orig();
      };
      drawDisplayList(ctx, one, theme, { scale: 24, offsetX: 0, offsetY: 0 });
      return seen;
    };
    expect(alphaFor(12)).toBeGreaterThan(alphaFor(4));
    expect(alphaFor(4)).toBeGreaterThan(alphaFor(1));
  });
  it("the legend has cliff and bridge swatches that draw", () => {
    const entries = legendEntries(list);
    expect(entries.map((e) => e.id)).toEqual(expect.arrayContaining(["cliff", "bridge"]));
    for (const e of entries) {
      const ctx = new RecordingContext();
      drawLegendSwatch(ctx, e, getMapTheme("print"), { x: 0, y: 0, w: 32, h: 24 });
      expect(ctx.depth).toBe(0);
    }
  });
});
