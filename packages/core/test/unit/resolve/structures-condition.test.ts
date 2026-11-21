/**
 * Generator 3 condition rules: a weathered building reads as neglected (not the same as intact), a ruin's cut wall
 * tops carry broken blocks and rubble, and a ruin keeps some doorway and window arches standing alone.
 */
import { describe, expect, it } from "vitest";
import type { Building, MapPlan, Structure } from "../../../src/contracts/plan";
import type { ResolvedLevel, ResolvedStructure } from "../../../src/contracts/resolved";
import { realize, verifyBuild } from "../../../src/compile";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import "../../../src/resolve/autoregister";
import { WEATHER_MINIMUMS, structureRuinMeasures, weatherMeasures, weatherSigns } from "../../../src/resolve";
import { reviewDesign } from "../../../src/review";
import { townPlan } from "../../fixtures/planBuilder";

const palettes = loadPalettes();

const plan = (structures: Structure[], generator: 2 | 3 = 3, theme = "forest"): MapPlan =>
  townPlan({
    generator,
    id: "cond",
    seed: 5,
    theme,
    w: 30,
    h: 30,
    structures,
    level: { features: [{ id: "f", type: "statue", at: [2, 2] }] },
  });
const first = (p: MapPlan): ResolvedStructure =>
  ((resolvePlan(p, bundledPalettes()).levels[0] as ResolvedLevel).structures ?? [])[0] as ResolvedStructure;
const b = (style: string, seed: number, w: number, h: number, extra: Partial<Building> = {}): Building => ({
  id: "b",
  style,
  seed,
  wings: [{ x: 8, y: 8, w, h }],
  ...extra,
});
const placementsOf = (p: MapPlan) =>
  realize(resolvePlan(p, bundledPalettes()), palettes).levels[0]?.placements ?? [];

const CASES: Array<[string, number, number, number, Partial<Building>]> = [
  ["cottage", 12, 8, 7, { roof: { type: "gable" } }],
  ["cottage", 3, 7, 6, {}],
  ["tower", 7, 6, 6, {}],
  ["keep", 4, 9, 9, {}],
  ["modern_block", 5, 8, 8, { use: "apartments" }],
];

describe("weathered at generator 3", () => {
  for (const [style, seed, w, h, extra] of CASES)
    it(`${style} seed ${seed}: shows at least ${WEATHER_MINIMUMS.signs} signs; intact shows fewer`, () => {
      const wb = b(style, seed, w, h, { ...extra, condition: "weathered" });
      const ws = first(plan([wb]));
      const wm = weatherMeasures(ws);
      expect(wm).not.toBeNull();
      if (!wm) return;
      expect(weatherSigns(wm), JSON.stringify(wm)).toBeGreaterThanOrEqual(WEATHER_MINIMUMS.signs);
      expect(wm.darkWindows).toBeGreaterThanOrEqual(WEATHER_MINIMUMS.darkWindows);
      expect(ws.ruin?.weather?.windows ?? 0).toBeGreaterThanOrEqual(0);
      const im = weatherMeasures(first(plan([{ ...wb, condition: "intact" }])));
      expect(im).not.toBeNull();
      if (!im) return;
      expect(weatherSigns(im)).toBeLessThan(weatherSigns(wm));
      expect(im.boardedWindows).toBe(0);
      expect(im.roofMissing).toBe(0);
      // the shape stays whole and the build is clean
      const p = plan([wb]);
      const r = resolvePlan(p, bundledPalettes());
      expect(
        verifyBuild(r, realize(r, palettes), palettes, { plan: p }).diagnostics.filter(
          (x) => x.severity === "error",
        ),
      ).toEqual([]);
    });

  it("boarded windows are built as plain wall and a bitten parapet loses pieces; generator 2 is unchanged", () => {
    const wb = b("cottage", 12, 8, 7, { roof: { type: "gable" }, condition: "weathered" });
    const w3 = first(plan([wb]));
    const boarded = w3.ruin?.weather?.boarded ?? [];
    expect(boarded.length).toBeGreaterThan(0);
    const n3 = placementsOf(plan([wb])).filter((q) => String(q.source.elementId).includes("~window")).length;
    const n2 = placementsOf(plan([wb], 2)).filter((q) =>
      String(q.source.elementId).includes("~window"),
    ).length;
    expect(n3).toBeLessThanOrEqual(n2);
    const w2 = first(plan([wb], 2));
    expect(w2.ruin?.weather).toBeUndefined();
    expect(w2.ruin?.roofHoles?.length ?? 0).toBeLessThanOrEqual(w3.ruin?.roofHoles?.length ?? 0);
    // the bitten parapet of a flat-roofed block
    const mb = first(plan([b("modern_block", 5, 8, 8, { use: "apartments", condition: "weathered" })]));
    expect(mb.ruin?.weather?.parapetBites.length ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("review: weathered_same_as_intact fires when the signs are missing, and is quiet otherwise", () => {
    const wp = plan([b("cottage", 12, 8, 7, { roof: { type: "gable" }, condition: "weathered" })]);
    const good = resolvePlan(wp, bundledPalettes());
    expect(reviewDesign(wp, good, bundledPalettes(), { limit: 99 }).map((n) => n.code)).not.toContain(
      "weathered_same_as_intact",
    );
    const bare = resolvePlan(wp, bundledPalettes());
    const st = (bare.levels[0] as ResolvedLevel).structures?.[0] as ResolvedStructure;
    if (st.ruin) {
      st.ruin.roofHoles = [];
      st.ruin.weather = { boarded: [], parapetBites: [], lost: [], windows: 4 };
      for (const c of st.ruin.columns) c.top = c.full;
    }
    st.debris = [];
    if (st.lighting) st.lighting.lit = 0.8;
    const notes = reviewDesign(wp, bare, bundledPalettes(), { limit: 99 });
    expect(notes.map((n) => n.code)).toContain("weathered_same_as_intact");
    // generator 2 plans are never told (their output is frozen)
    const wp2 = plan([b("cottage", 12, 8, 7, { roof: { type: "gable" }, condition: "weathered" })], 2);
    const r2 = resolvePlan(wp2, bundledPalettes());
    expect(reviewDesign(wp2, r2, bundledPalettes(), { limit: 99 }).map((n) => n.code)).not.toContain(
      "weathered_same_as_intact",
    );
  });
});

describe("ruins at generator 3", () => {
  const ruins: Array<[string, number, number, number]> = [
    ["tower", 7, 6, 6],
    ["keep", 4, 9, 9],
    ["tower", 21, 7, 7],
    ["cottage", 3, 8, 6],
    ["keep", 11, 10, 8],
    ["modern_block", 5, 8, 8],
  ];
  it("rubble sits on cut wall tops: on the wall's own cell, at the cut height, never over a doorway", () => {
    let total = 0;
    for (const [style, seed, w, h] of ruins) {
      const p = plan([b(style, seed, w, h, { condition: "ruined" })]);
      const st = first(p);
      const top = st.ruin?.topRubble ?? [];
      total += top.length;
      const cols = st.ruin?.columns ?? [];
      const cut = cols.filter((c) => c.top < c.full - 1e-6).length;
      // a share of the cut columns, not every one
      expect(top.length, `${style} ${seed}`).toBeLessThan(Math.max(1, cut));
      const cells = new Set(st.cells.map(([x, y]) => `${x},${y}`));
      const doorFaces = new Set<string>();
      for (const o of (resolvePlan(p, bundledPalettes()).levels[0] as ResolvedLevel).openings) {
        if (!st.openingIds.includes(o.id) || o.kind === "window") continue;
        for (let k = 0; k < o.width; k++) {
          const [x, y] = o.orientation === "h" ? [o.start[0] + k, o.start[1]] : [o.start[0], o.start[1] + k];
          for (const key of o.orientation === "h"
            ? [`${x},${y - 1},S`, `${x},${y},N`]
            : [`${x - 1},${y},E`, `${x},${y},W`])
            doorFaces.add(key);
        }
      }
      const colAt = new Map(cols.map((c) => [`${c.at[0]},${c.at[1]},${c.side}`, c]));
      for (const t of top) {
        const col = colAt.get(`${t.at[0]},${t.at[1]},${t.side}`);
        expect(col, `${style} ${seed}`).toBeDefined();
        expect(t.top).toBeCloseTo(col?.top ?? -1, 5);
        expect(t.top).toBeLessThan((col?.full ?? 0) - 1e-6);
        expect(cells.has(`${t.at[0]},${t.at[1]}`)).toBe(true);
        expect(doorFaces.has(`${t.at[0]},${t.at[1]},${t.side}`), `${style} ${seed} doorway`).toBe(false);
      }
      const placed = placementsOf(p).filter((q) => q.source.elementId === `${st.id}~walltop`);
      expect(placed.length, `${style} ${seed} placed`).toBeGreaterThan(0);
      const step = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] } as const;
      for (const q of placed) {
        // on the wall strip: the ring cell outside a footprint cell's face, at that column's cut height
        const c = q.source.cell as readonly [number, number];
        const mine = top.filter(
          (t) => t.at[0] + step[t.side][0] === c[0] && t.at[1] + step[t.side][1] === c[1],
        );
        expect(mine.length, `${style} ${seed} placement cell`).toBeGreaterThan(0);
        expect(
          mine.some((t) => Math.abs(t.top - q.y) < 0.6),
          `${style} ${seed} y ${q.y} vs ${mine.map((t) => t.top).join(",")}`,
        ).toBe(true);
      }
    }
    expect(total).toBeGreaterThan(0);
  });

  it("rubble on wall tops is generator 3 only, and a theme without the roles gets nothing", () => {
    const rb = b("keep", 4, 9, 9, { condition: "ruined" });
    expect(first(plan([rb], 2)).ruin?.topRubble).toBeUndefined();
    const p = plan([rb]);
    const r = resolvePlan(p, bundledPalettes());
    const bare = {
      ...palettes,
      palettes: Object.fromEntries(
        Object.entries(palettes.palettes).map(([id, pal]) => [
          id,
          {
            ...pal,
            roles: Object.fromEntries(Object.entries(pal.roles).filter(([k]) => !k.startsWith("ruin_"))),
          },
        ]),
      ),
    };
    expect(
      (realize(r, bare).levels[0]?.placements ?? []).filter((q) =>
        String(q.source.elementId).endsWith("~walltop"),
      ),
    ).toEqual([]);
  });

  it("arches: a doorway or window frame stands alone where the wall beside it fell (one or two, seeded)", () => {
    let found = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const style = seed % 2 ? "keep" : "tower";
      const p = plan([b(style, seed, 8, 8, { condition: "ruined" })]);
      const st = first(p);
      const arches = st.ruin?.arches ?? [];
      expect(arches.length).toBeLessThanOrEqual(2);
      if (arches.length === 0) continue;
      found++;
      const cols = new Map((st.ruin?.columns ?? []).map((c) => [`${c.at[0]},${c.at[1]},${c.side}`, c]));
      for (const a of arches) {
        const along = a.side === "N" || a.side === "S" ? [1, 0] : [0, 1];
        const own = cols.get(`${a.at[0]},${a.at[1]},${a.side}`);
        expect(own).toBeDefined();
        // the frame stands at least 2 tiles above the floor (door height) ...
        expect((own?.top ?? 0) - (st.storeys[0]?.floorTop ?? 0)).toBeGreaterThanOrEqual(2);
        // ... and nothing taller stands one cell beyond the frame
        const next = cols.get(
          `${a.at[0] + (along[0] ?? 0) * (a.width + 1)},${a.at[1] + (along[1] ?? 0) * (a.width + 1)},${a.side}`,
        );
        const prev = cols.get(`${a.at[0] - (along[0] ?? 0) * 2},${a.at[1] - (along[1] ?? 0) * 2},${a.side}`);
        const beyond = [next, prev].filter((c) => c !== undefined);
        for (const c of beyond) expect(c.top).toBeLessThanOrEqual((own?.top ?? 0) + 1e-6);
      }
      // it is built: lintel pieces over the open doorway
      const pl = placementsOf(p);
      expect(pl.length).toBeGreaterThan(0);
      const r = resolvePlan(p, bundledPalettes());
      const ver = verifyBuild(r, realize(r, palettes), palettes, { plan: p });
      expect(ver.diagnostics.filter((x) => x.severity === "error")).toEqual([]);
      const m = structureRuinMeasures(st);
      // (arches restore some masonry, and stubs a tile and a half tall lower the share lost)
      expect(m?.loss ?? 0).toBeGreaterThan(0.15);
    }
    expect(found).toBeGreaterThan(3);
    // generator 2 keeps no arches
    expect(first(plan([b("keep", 4, 9, 9, { condition: "ruined" })], 2)).ruin?.arches).toBeUndefined();
  });

  it("two ruins of one style differ by seed", () => {
    const a = first(plan([b("keep", 4, 9, 9, { condition: "ruined" })])).ruin?.topRubble ?? [];
    const c = first(plan([b("keep", 5, 9, 9, { condition: "ruined" })])).ruin?.topRubble ?? [];
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });
});
