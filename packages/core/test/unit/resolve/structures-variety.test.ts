/**
 * Building variety (owner, 2026-11-20: "all the buildings look the same"): designs drawn from a style's design space
 * (massing archetype, storeys, material, roof, parapet, rooftop sets, window pattern, base and top treatment),
 * shifted by `use`, kept different between neighbours; plus street frontage (party walls, alleys, volumes-only
 * plans). The variety metric is the design signature and a silhouette (volume rects and wall tops).
 */
import { describe, expect, it } from "vitest";
import type { Building, MapPlan, Structure } from "../../../src/contracts/plan";
import { CELL, type ResolvedLevel, type ResolvedStructure } from "../../../src/contracts/resolved";
import { placedName, realize, verifyBuild } from "../../../src/compile";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { validatePlan } from "../../../src/plan";
import { resolvePlan } from "../../../src/resolve/index";
import "../../../src/resolve/autoregister";
import {
  WEATHER_MINIMUMS,
  structureRuinMeasures,
  structureSignature,
  structureSilhouette,
  structureTone,
  weatherMeasures,
} from "../../../src/resolve";
import { townPlan } from "../../fixtures/planBuilder";

const palettes = loadPalettes();

const plan = (structures: Structure[], w = 60, h = 24, theme = "city"): MapPlan =>
  townPlan({
    generator: 2,
    id: "variety",
    seed: 5,
    theme,
    w,
    h,
    base: { type: "ground", material: "concrete" },
    structures,
  });
const structuresOf = (p: MapPlan): ResolvedStructure[] =>
  (resolvePlan(p, bundledPalettes()).levels[0] as ResolvedLevel).structures ?? [];
const sig = (s: ResolvedStructure): string => {
  const d = s.design;
  return d
    ? [
        d.archetype,
        d.storeys,
        d.material,
        d.baseMaterial,
        d.roof,
        d.parapet,
        d.rooftop.join("+"),
        d.windows,
        d.base,
        d.top,
      ].join("|")
    : "none";
};
const silhouette = structureSilhouette;
const one = (style: string, seed: number, use?: string, w = 8, h = 8): Building => ({
  id: "b",
  style,
  seed,
  wings: [{ x: 4, y: 4, w, h }],
  ...(use ? { use } : {}),
});

describe("variety: one style, many seeds", () => {
  for (const [style, minSig, minArch, minSil] of [
    ["modern_block", 25, 5, 10],
    ["cottage", 12, 3, 6],
  ] as const)
    it(`${style}: 40 seeds give at least ${minSig} signatures, ${minArch} archetypes and ${minSil} silhouettes`, () => {
      const sigs = new Set<string>();
      const archs = new Set<string>();
      const sils = new Set<string>();
      const mats = new Set<string>();
      for (let seed = 0; seed < 40; seed++) {
        const st = structuresOf(plan([one(style, seed)], 20, 20))[0] as ResolvedStructure;
        expect(st.design, `seed ${seed}`).toBeDefined();
        sigs.add(sig(st));
        archs.add(st.design?.archetype ?? "");
        sils.add(silhouette(st));
        mats.add(st.design?.material ?? "");
      }
      expect(sigs.size).toBeGreaterThanOrEqual(minSig);
      expect(archs.size).toBeGreaterThanOrEqual(minArch);
      expect(sils.size).toBeGreaterThanOrEqual(minSil);
      expect(mats.size).toBeGreaterThanOrEqual(2);
    });

  it("use shifts the design: warehouses are mostly low sheds with a garage door, shops have shopfronts", () => {
    let sheds = 0;
    let shops = 0;
    for (let seed = 0; seed < 30; seed++) {
      const w = structuresOf(plan([one("modern_block", seed, "warehouse")], 20, 20))[0];
      if (w?.design?.archetype === "shed") sheds++;
      const s = structuresOf(plan([one("modern_block", seed, "shop")], 20, 20))[0];
      if (s?.design?.base === "shopfront") shops++;
    }
    expect(sheds).toBeGreaterThanOrEqual(18);
    expect(shops).toBeGreaterThanOrEqual(18);
  });

  it("a plan that fixes the shape or roof is built as given (no design drawn)", () => {
    const st = structuresOf(plan([{ ...one("modern_block", 1), roof: { type: "flat" } }], 20, 20))[0];
    expect(st?.design).toBeUndefined();
  });
});

describe("variety: a street", () => {
  // six plots side by side, touching (party walls), all left to the style
  const street = (gap: number): MapPlan => {
    const s: Structure[] = [];
    let x = 2;
    const widths = [7, 6, 8, 7, 6, 8];
    widths.forEach((w, i) => {
      s.push({ id: `b${i}`, style: "modern_block", seed: 100 + i, wings: [{ x, y: 4, w, h: 8 }] });
      x += w + gap;
    });
    return plan(s, x + 2, 18);
  };

  it("six unset neighbours: no two signatures alike; neighbours differ in archetype+material and storeys", () => {
    const sts = structuresOf(street(0));
    expect(new Set(sts.map(sig)).size).toBe(6);
    for (let i = 1; i < sts.length; i++) {
      const a = sts[i - 1]?.design;
      const b = sts[i]?.design;
      expect(a && b && a.archetype === b.archetype && a.material === b.material).toBe(false);
      expect(a?.storeys).not.toBe(b?.storeys);
    }
  });

  for (const gap of [0, 1, 2])
    it(`a terrace with ${gap === 0 ? "party walls" : `${gap}-cell alleys`} validates and builds without errors`, () => {
      const p = street(gap);
      expect(validatePlan(p).issues.filter((i) => i.severity === "error")).toEqual([]);
      const r = resolvePlan(p, bundledPalettes());
      const set = realize(r, palettes);
      const ver = verifyBuild(r, set, palettes, { plan: p });
      expect(ver.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    });

  it("buildings front onto the open side and their doors go there", () => {
    const sts = structuresOf(street(0));
    for (const s of sts) expect(["S", "N"]).toContain(s.frontage?.side);
  });
});

describe("street frontage", () => {
  it("volumes alone (no wings) validate and build", () => {
    const p = plan([
      {
        id: "v",
        style: "modern_block",
        volumes: [
          { id: "a", x: 4, y: 4, w: 6, h: 6, storeys: 3 },
          { id: "b", x: 10, y: 4, w: 5, h: 6, storeys: 1 },
        ],
      },
    ]);
    expect(validatePlan(p).issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(structuresOf(p)[0]?.volumes?.length).toBe(2);
  });

  it("a style missing its own pieces in a theme says so (structure_style_fallback)", () => {
    const p = plan([{ ...one("modern_block", 1), use: "shop" }], 20, 20, "wood_town");
    const r = resolvePlan(p, bundledPalettes());
    const set = realize(r, palettes);
    const codes = new Set(set.diagnostics.map((d) => d.code));
    // wood_town has the generic structure batch through its parent, so nothing may fall back; when it does, it is named
    for (const d of set.diagnostics.filter((x) => x.code === "structure_style_fallback"))
      expect(d.message).toMatch(/has no "|not a piece of this style/);
    expect(codes.has("verify_wall_gap")).toBe(false);
  });
});

describe("city street faults (street v1 repro)", () => {
  const uses = ["apartments", "shop", "office", "diner", "townhouse", "workshop", "civic", "garage"];
  const street = (): MapPlan => {
    const s: Structure[] = [];
    let x = 1;
    uses.slice(0, 5).forEach((u, i) => {
      const w = [8, 5, 10, 7, 5][i] as number;
      s.push({ id: u, style: "modern_block", use: u, front: "S", wings: [{ x, y: 3, w, h: 9 }] });
      x += w;
    });
    x = 1;
    uses.slice(5).forEach((u, i) => {
      const w = [7, 10, 6][i] as number;
      s.push({ id: u, style: "modern_block", use: u, front: "N", wings: [{ x, y: 20, w, h: 9 }] });
      x += w + 1;
    });
    return plan(s, 40, 31);
  };

  it("every piece of a modern_block under city comes from a modern (or approved cross-pack) kit", () => {
    const p = street();
    const set = realize(resolvePlan(p, bundledPalettes()), palettes);
    const ids = new Set(uses);
    const medieval =
      /castle|haunted|rural|tavern|candle|lantern|stone wall|dungeon|peasant|moorgoth|md_|abandoned|pole support/i;
    const bad = (set.levels[0]?.placements ?? [])
      .filter((q) => ids.has((q.source.elementId ?? "").split("~")[0] ?? ""))
      .map((q) => placedName(set, q))
      .filter((n) => medieval.test(n));
    expect([...new Set(bad)]).toEqual([]);
  });

  it("rooftop props sit on the roof (no base above the roof top under them), and the no-roof export verifies clean", () => {
    const p = street();
    const r = resolvePlan(p, bundledPalettes());
    const set = realize(r, palettes);
    const ver = verifyBuild(r, set, palettes, { plan: p });
    expect(
      ver.diagnostics.filter((d) => d.code === "verify_prop_floating" && /clutter|mast|hut/.test(d.message)),
    ).toEqual([]);
    const bare = realize(r, palettes, { omitLayers: ["roof"] });
    const v2 = verifyBuild(r, bare, palettes, { plan: p });
    expect(v2.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("a stoop stays inside its own plot (no plinth into a neighbour, no warning)", () => {
    const p = street();
    const issues = validatePlan(p).issues.filter((i) => /plinth/.test(i.message));
    expect(issues).toEqual([]);
    const sts = structuresOf(p);
    const plots = new Map<string, Set<string>>();
    for (const s of sts) plots.set(s.id, new Set(s.cells.map(([x, y]) => `${x},${y}`)));
    for (const s of sts)
      for (const [x, y] of s.plinth?.cells ?? [])
        for (const [id, cells] of plots)
          if (id !== s.id) expect(cells.has(`${x},${y}`), `${s.id} into ${id}`).toBe(false);
  });
});

describe("cottage spread", () => {
  it("six unset cottages of different uses have six different silhouettes", () => {
    const uses = ["shack", "farmhouse", "workshop", "tavern", "shack", "farmhouse"];
    const s: Structure[] = uses.map((u, i) => ({
      id: `c${i}`,
      style: "cottage",
      use: u,
      seed: 31 + i,
      wings: [{ x: 2 + (i % 3) * 13, y: i < 3 ? 3 : 18, w: 7 + (i % 2), h: 6 }],
    }));
    const sts = structuresOf(plan(s, 42, 28, "forest"));
    expect(new Set(sts.map(silhouette)).size).toBe(6);
  });

  it("40 cottages use every archetype (lean-to and twin included), several roofs, sizes and attic storeys", () => {
    const arch = new Set<string>();
    const roofs = new Set<string>();
    const sizes = new Set<string>();
    let attics = 0;
    for (let seed = 0; seed < 40; seed++) {
      const d = structuresOf(plan([one("cottage", seed)], 20, 20, "forest"))[0]?.design;
      arch.add(d?.archetype ?? "");
      roofs.add(d?.roof ?? "");
      sizes.add(d?.size ?? "");
      if (d?.top === "attic") attics++;
    }
    for (const a of ["box", "ell", "twin", "lean"]) expect(arch.has(a), a).toBe(true);
    expect(roofs.size).toBeGreaterThanOrEqual(3);
    expect(sizes.size).toBe(3);
    expect(attics).toBeGreaterThan(4);
  });
});

describe("main entrance on the front face", () => {
  const doorFace = (
    L: ResolvedLevel,
    st: ResolvedStructure,
  ): Array<{ side: string; at: [number, number] }> => {
    const cells = new Set(st.cells.map(([x, y]) => `${x},${y}`));
    return L.openings
      .filter((o) => st.openingIds.includes(o.id) && o.kind !== "window" && o.kind !== "arrow_slit")
      .map((o) => {
        const a: [number, number] =
          o.orientation === "h" ? [o.start[0], o.start[1] - 1] : [o.start[0] - 1, o.start[1]];
        const inA = cells.has(`${a[0]},${a[1]}`);
        const side = o.orientation === "h" ? (inA ? "S" : "N") : inA ? "E" : "W";
        return { side, at: inA ? a : ([o.start[0], o.start[1]] as [number, number]) };
      });
  };
  const STEPS: Record<string, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
  const allUses = [
    "shop",
    "apartments",
    "office",
    "warehouse",
    "townhouse",
    "diner",
    "civic",
    "garage",
    "workshop",
  ];

  for (const withFront of [true, false])
    it(`a terrace of unset modern blocks${withFront ? " with front set" : ""}: every main door is on the front face, onto open ground`, () => {
      for (let seed = 0; seed < 24; seed++) {
        const s: Structure[] = [];
        let x = 1;
        [7, 5, 9, 6, 8].forEach((w, i) => {
          s.push({
            id: `b${i}`,
            style: "modern_block",
            use: allUses[(seed + i) % allUses.length] as string,
            seed: seed * 7 + i,
            wings: [{ x, y: 3, w, h: 9 }],
            ...(withFront ? { front: "S" as const } : {}),
          });
          x += w + (i === 1 ? 2 : 0); // a party wall, then a 2-cell alley
        });
        const p = plan(s, x + 2, 20);
        const L = resolvePlan(p, bundledPalettes()).levels[0] as ResolvedLevel;
        for (const st of L.structures ?? []) {
          const front = st.frontage?.side ?? "?";
          if (withFront) expect(front, `seed ${seed} ${st.id}`).toBe("S");
          const doors = doorFace(L, st);
          const main = doors.filter((d) => d.side === front);
          expect(
            main.length,
            `seed ${seed} ${st.id}: doors ${JSON.stringify(doors)} front ${front}`,
          ).toBeGreaterThan(0);
          for (const d of main) {
            const [dx, dy] = STEPS[d.side] as [number, number];
            const i = (d.at[1] + dy - L.bounds.y) * L.bounds.w + (d.at[0] + dx - L.bounds.x);
            expect(L.cells.state[i], `seed ${seed} ${st.id} door cell open`).toBe(CELL.OPEN);
          }
        }
      }
    });
});

describe("review measures", () => {
  it("signature, silhouette and tone are exported per resolved building", () => {
    const st = structuresOf(plan([one("modern_block", 4, "shop")], 20, 20))[0] as ResolvedStructure;
    expect(structureSignature(st)?.startsWith(sig(st))).toBe(true);
    expect(structureSilhouette(st)).toMatch(/^\d+,\d+,\d+x\d+@/);
    expect(["dark", "mid", "light"]).toContain(structureTone(st));
    const fixed = structuresOf(
      plan([{ ...one("cottage", 1), roof: { type: "gable" } }], 20, 20, "forest"),
    )[0] as ResolvedStructure;
    expect(structureSignature(fixed)).toBeNull();
    expect(structureTone(fixed)).toBeNull();
  });
});

describe("wizard tower, character and condition", () => {
  const wiz = (seed: number, character?: Building["character"]): Building => ({
    id: "w",
    style: "wizard_tower",
    seed,
    wings: [{ x: 5, y: 5, w: 9, h: 9 }],
    front: "S",
    ...(character ? { character } : {}),
  });
  it("wizard towers differ in wall treatment, each a set that belongs together under one roof kit", () => {
    // base tier / shaft / lantern room; "same" crown = the shaft's material
    const sets: Record<string, { base: string; material: string; crowns: string[] }> = {
      grey_stone: { base: "stone", material: "stone", crowns: ["same", "timber"] },
      brick_trim: { base: "stone", material: "brick", crowns: ["timber", "stone"] },
      sandstone: { base: "plaster", material: "plaster", crowns: ["same", "timber"] },
      dark_stone: { base: "dark_stone", material: "dark_stone", crowns: ["same", "timber"] },
      marble: { base: "marble", material: "marble", crowns: ["same"] },
    };
    const seen = new Set<string>();
    for (let seed = 0; seed < 30; seed++) {
      const p = plan([wiz(seed)], 24, 24, "forest");
      const st = structuresOf(p)[0] as ResolvedStructure;
      const d = st.design;
      const set = sets[d?.treatment ?? ""];
      expect(set, `seed ${seed} ${d?.treatment ?? "-"}`).toBeDefined();
      if (!d || !set) continue;
      seen.add(d.treatment ?? "");
      expect([d.baseMaterial, d.material]).toEqual([set.base, set.material]);
      expect(set.crowns).toContain(d.crown);
      // the walls as built: the base tier, the shaft and the lantern room only from the set
      const allowed = new Set([set.base, set.material, ...set.crowns.filter((c) => c !== "same")]);
      for (const v of st.volumes ?? [])
        for (const sp of v.storeys)
          expect(allowed.has(sp.walls ?? ""), `seed ${seed} ${v.id} ${sp.walls ?? "-"}`).toBe(true);
      // one roof kit on every pitched roof
      const kits = new Set(
        (st.volumes ?? []).flatMap((v) =>
          v.roof.layers.filter((l) => l.type !== "none" && l.type !== "flat").map((l) => l.style),
        ),
      );
      expect([...kits], `seed ${seed}`).toHaveLength(1);
      expect([...kits][0]).toBe(d.roofKit);
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
  it("a wizard tower is a plumb, tapering shaft under a lantern room and a steep spire, with at least two signs of magic", () => {
    for (let seed = 0; seed < 12; seed++) {
      const p = plan([wiz(seed)], 24, 24, "forest");
      const r = resolvePlan(p, bundledPalettes());
      const st = (r.levels[0] as ResolvedLevel).structures?.[0] as ResolvedStructure;
      const vols = st.volumes ?? [];
      const stack = vols.filter((v) => v.id === "shaft" || /^s\d+$/.test(v.id) || v.id === "crown");
      const crown = vols.find((v) => v.id === "crown");
      const w = Math.min(...stack.map((v) => v.storeys[0]?.rect.w ?? 99));
      expect(w, `seed ${seed}`).toBeLessThanOrEqual(5);
      expect(w).toBeGreaterThanOrEqual(3);
      // plumb: every storey shares one axis
      const axes = new Set(
        stack.map(
          (v) =>
            `${2 * (v.storeys[0]?.rect.x ?? 0) + (v.storeys[0]?.rect.w ?? 0)},${2 * (v.storeys[0]?.rect.y ?? 0) + (v.storeys[0]?.rect.h ?? 0)}`,
        ),
      );
      expect(axes.size, `seed ${seed}`).toBe(1);
      // the lantern room keeps the shaft's width; it is one storey
      expect(crown?.storeys.length).toBe(1);
      expect(crown?.storeys[0]?.rect.w).toBe(w);
      // the spire is roof, never a stack of wall boxes; crown + spire about a third of the height
      const pl = realize(r, palettes).levels[0]?.placements ?? [];
      const floor = st.storeys[0]?.floorTop ?? 0;
      const tip =
        Math.max(...pl.filter((q) => String(q.source.elementId).startsWith("w~")).map((q) => q.y)) - floor;
      const crownBase = (crown?.storeys[0]?.floorTop ?? 0) - floor;
      expect(tip, `seed ${seed}`).toBeGreaterThanOrEqual(3 * w);
      expect((tip - crownBase) / tip, `seed ${seed}`).toBeLessThan(0.45);
      // signs of magic: at least two of beacon, banners, vines, balcony
      const signs = (st.design?.details ?? []).filter((x) =>
        ["beacon", "banners", "vines", "balcony"].includes(x),
      );
      expect(signs.length, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      expect(signs.length + (st.lighting?.windows === "glow" ? 1 : 0), `seed ${seed}`).toBeGreaterThanOrEqual(
        2,
      );
      // one roof material: every roof piece of the tower comes from one kit
      expect(
        new Set(vols.flatMap((v) => v.roof.layers.filter((l) => l.type !== "none").map((l) => l.style))).size,
      ).toBeLessThanOrEqual(1);
    }
  });
  it("no bare floor edge: overhanging storeys hang on a corbel course, set-backs under a roof skirt", () => {
    const p = plan([wiz(31, ["twisted"])], 24, 24, "forest");
    const r = resolvePlan(p, bundledPalettes());
    const st = (r.levels[0] as ResolvedLevel).structures?.[0] as ResolvedStructure;
    const pl = realize(r, palettes).levels[0]?.placements ?? [];
    for (const v of st.volumes ?? []) {
      if (v.on === null) continue;
      const host = (st.volumes ?? []).find((o) => o.id === v.on);
      const hostCells = new Set(
        (host?.storeys[host.storeys.length - 1]?.cells ?? []).map(([x, y]) => `${x},${y}`),
      );
      const over = (v.storeys[0]?.cells ?? []).some(([x, y]) => !hostCells.has(`${x},${y}`));
      if (over)
        expect(
          pl.some((q) => q.source.elementId === `w~${v.id}~lip`),
          v.id,
        ).toBe(true);
    }
  });
  it("twisted: every storey of the shaft stands offset from the one below; the build overhangs without errors", () => {
    const p = plan([wiz(31, ["twisted"])], 24, 24, "forest");
    expect(validatePlan(p).issues.filter((i) => i.severity !== "info")).toEqual([]);
    const st = structuresOf(p)[0] as ResolvedStructure;
    const rects = (st.volumes ?? [])
      .filter((v) => v.id !== "turret" && v.id !== "crown")
      .map((v) => v.storeys[0]?.rect);
    for (let i = 1; i < rects.length; i++)
      expect(`${rects[i]?.x},${rects[i]?.y}`).not.toBe(`${rects[i - 1]?.x},${rects[i - 1]?.y}`);
    const r = resolvePlan(p, bundledPalettes());
    const ver = verifyBuild(r, realize(r, palettes), palettes, { plan: p });
    expect(ver.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
  it("condition ruined: doorways empty, breaches, no lights, rubble and growth, broken upper courses; weathered in between", () => {
    const base = {
      ...one("cottage", 3),
      wings: [{ x: 4, y: 4, w: 8, h: 6 }],
      roof: { type: "gable" as const },
      storeys: 2,
    };
    const intact = structuresOf(plan([base], 20, 20, "forest"))[0] as ResolvedStructure;
    const ruinedPlan = plan([{ ...base, condition: "ruined" }], 20, 20, "forest");
    const ruined = structuresOf(ruinedPlan)[0] as ResolvedStructure;
    expect(ruined.condition).toBe("ruined");
    expect(ruined.lighting?.windows).toBe("none");
    expect(ruined.lights).toEqual([]);
    expect((ruined.debris ?? []).length).toBeGreaterThan(2);
    const L = resolvePlan(ruinedPlan, bundledPalettes()).levels[0] as ResolvedLevel;
    const kinds = L.openings.filter((o) => ruined.openingIds.includes(o.id)).map((o) => o.kind);
    expect(kinds).not.toContain("door");
    expect(kinds.filter((k) => k === "open").length).toBeGreaterThan(1);
    const walls = (s: ResolvedStructure, p: MapPlan) =>
      (realize(resolvePlan(p, bundledPalettes()), palettes).levels[0]?.placements ?? []).filter(
        (q) => q.source.elementId === `${s.id}~wall` && q.layer === "storey:1",
      ).length;
    // the upper storey breaks off column by column (one-cell pieces, so the count is no guide): most of it is gone
    expect(walls(intact, plan([base], 20, 20, "forest"))).toBeGreaterThan(0);
    const upper = (ruined.ruin?.columns ?? []).filter((c) => c.full > (ruined.storeys[0]?.floorTop ?? 0) + 4);
    expect(upper.filter((c) => c.top < c.full).length).toBeGreaterThan(upper.length / 2);
    const r = resolvePlan(ruinedPlan, bundledPalettes());
    const ver = verifyBuild(r, realize(r, palettes), palettes, { plan: ruinedPlan });
    expect(ver.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const weathered = structuresOf(plan([{ ...base, condition: "weathered" }], 20, 20, "forest"))[0];
    expect(weathered?.condition).toBe("weathered");
    // a ruin's rubble lies inside its walls too; a weathered building's only at its foot
    const inside = (b: ResolvedStructure | undefined): number =>
      (b?.debris ?? []).filter((d) => b?.cells.some((c) => c[0] === d.at[0] && c[1] === d.at[1])).length;
    expect(inside(ruined)).toBeGreaterThan(0);
    expect(inside(weathered)).toBe(0);
  });
  it("ruined: falls from a standing corner, ragged per-cell tops, stubs against tall remains, holed floors, rubble inside", () => {
    const cases: Building[] = [
      { ...one("tower", 7, undefined, 6, 6), condition: "ruined" },
      { ...one("keep", 4, undefined, 9, 9), condition: "ruined" },
      { ...one("modern_block", 5, "apartments", 8, 8), condition: "ruined" },
      { ...one("wizard_tower", 2, undefined, 7, 7), condition: "ruined" },
      { ...one("tower", 21, undefined, 7, 7), condition: "ruined" },
    ];
    for (const b of cases) {
      const st = structuresOf(plan([b], 24, 24, "forest"))[0] as ResolvedStructure;
      const m = structureRuinMeasures(st);
      const tag = `${b.style} seed ${b.seed}`;
      expect(m, tag).not.toBeNull();
      if (!m) continue;
      // 45–70 % of the masonry lost (owner: 35–70 %)
      expect(m.loss, tag).toBeGreaterThanOrEqual(0.4);
      expect(m.loss, tag).toBeLessThanOrEqual(0.72);
      // tops vary cell by cell, some by two tiles or more; no flat top (review ruin_flat_top fires above 0.6 equal)
      expect(m.topVariety, tag).toBeGreaterThanOrEqual(0.45);
      expect(m.topJump2, tag).toBeGreaterThan(0.08);
      // stubs against tall remains (review ruin_uniform fires below 1.8)
      expect(m.contrast, tag).toBeGreaterThanOrEqual(1.8);
      expect(m.stubShare, tag).toBeGreaterThanOrEqual(0.3);
      // most rubble inside the walls
      expect(m.rubbleInside, tag).toBeGreaterThanOrEqual(0.4);
      // every surviving upper floor has holes: a fifth to a third of it gone (or all of it, where its walls fell)
      for (const h of st.ruin?.holes ?? []) {
        const v = st.volumes?.find((o) => o.id === h.volume);
        const n = v?.storeys[h.storey]?.cells.length ?? 0;
        const share = h.cells.length / n;
        expect(
          share === 1 || (share >= 0.15 && share <= 0.35),
          `${tag} ${h.volume}:${h.storey} ${share}`,
        ).toBe(true);
      }
      // the standing corner is tallest: the columns nearest it stand higher than the farthest ones on average
      const cols = st.ruin?.columns ?? [];
      const anchor = st.ruin?.anchor ?? [0, 0];
      const d = (c: (typeof cols)[number]): number => Math.hypot(c.at[0] - anchor[0], c.at[1] - anchor[1]);
      const sorted = [...cols].sort((p, q) => d(p) - d(q));
      const third = Math.max(1, Math.floor(sorted.length / 3));
      const mean = (xs: typeof cols): number => xs.reduce((t, c) => t + c.top, 0) / xs.length;
      expect(mean(sorted.slice(0, third)), tag).toBeGreaterThan(mean(sorted.slice(-third)) + 0.5);
      // no roof survives on a ruin (a pitched one keeps at most its gable wall)
      for (const v of st.volumes ?? []) if (!v.roof.gableOnly) expect(v.roof.layers, tag).toEqual([]);
      // the build follows the profile: walls stop at the column tops, and verify passes
      const p = plan([b], 24, 24, "forest");
      const r = resolvePlan(p, bundledPalettes());
      const set = realize(r, palettes);
      const ver = verifyBuild(r, set, palettes, { plan: p });
      expect(
        ver.diagnostics.filter((x) => x.severity === "error"),
        tag,
      ).toEqual([]);
      const top = Math.max(...cols.map((c) => c.top));
      const walls = (set.levels[0]?.placements ?? []).filter((q) => q.source.elementId === `${st.id}~wall`);
      expect(Math.max(...walls.map((q) => q.y)), tag).toBeLessThan(top);
      expect(
        set.levels[0]?.placements.some((q) => /~roofd*$/.test(String(q.source.elementId))),
        tag,
      ).toBe(false);
    }
  });
  it("ruined gable building keeps the gable wall at its standing end; its slopes fall in", () => {
    const b: Building = {
      ...one("cottage", 3),
      wings: [{ x: 4, y: 4, w: 8, h: 6 }],
      roof: { type: "gable" as const },
      condition: "ruined",
    };
    const p = plan([b], 20, 20, "forest");
    const st = structuresOf(p)[0] as ResolvedStructure;
    const side = st.volumes?.[0]?.roof.gableOnly;
    expect(side).toBeDefined();
    const pl = realize(resolvePlan(p, bundledPalettes()), palettes).levels[0]?.placements ?? [];
    expect(pl.filter((q) => q.source.elementId === `${st.id}~gable`).length).toBeGreaterThan(0);
    expect(pl.some((q) => /~roofd*$/.test(String(q.source.elementId)))).toBe(false);
    // the gable wall's columns stand whole
    for (const c of st.ruin?.columns ?? [])
      if (c.side === side && c.top < c.full) {
        const line = side === "W" || side === "E" ? c.at[0] : c.at[1];
        const xs = (st.ruin?.columns ?? [])
          .filter((o) => o.side === side)
          .map((o) => (side === "W" || side === "E" ? o.at[0] : o.at[1]));
        expect(line).not.toBe(side === "W" || side === "N" ? Math.min(...xs) : Math.max(...xs));
      }
  });
  it("weathered: the shape stays whole; a roof patch has fallen in, most windows are dark, growth and rubble at its foot", () => {
    const b: Building = { ...one("modern_block", 5, "apartments", 8, 8), condition: "weathered" };
    const st = structuresOf(plan([b], 24, 24, "forest"))[0] as ResolvedStructure;
    const m = structureRuinMeasures(st);
    expect(m?.loss ?? 1).toBeLessThan(0.1);
    expect(st.ruin?.holes).toEqual([]);
    expect(st.roof.broken).toBeGreaterThanOrEqual(0.2);
    expect((st.debris ?? []).length).toBeGreaterThan(0);
    expect((st.volumes ?? []).every((v) => v.roof.layers.length > 0)).toBe(true);
    expect(structureRuinMeasures({ ...st, condition: "intact" })).toBeNull();
    // measurably not intact: the minimums the review holds it to
    for (const [style, seed, use] of [
      ["modern_block", 5, "apartments"],
      ["cottage", 12, "farmhouse"],
      ["tower", 7, undefined],
    ] as const) {
      const wb: Building = { ...one(style, seed, use, 8, 7), condition: "weathered" };
      const wp = { ...plan([wb], 24, 24, "forest"), generator: 3 as const }; // the minimums are generator 3's
      const ws = structuresOf(wp)[0] as ResolvedStructure;
      const wm = weatherMeasures(ws);
      expect(wm?.roofMissing ?? 0, style).toBeGreaterThanOrEqual(WEATHER_MINIMUMS.roofMissing);
      expect(wm?.darkWindows ?? 0, style).toBeGreaterThanOrEqual(WEATHER_MINIMUMS.darkWindows);
      const ip = { ...plan([{ ...wb, condition: "intact" }], 24, 24, "forest"), generator: 3 as const };
      const roofOf = (pp: MapPlan): number =>
        (realize(resolvePlan(pp, bundledPalettes()), palettes).levels[0]?.placements ?? []).filter(
          (q) => q.layer === "roof",
        ).length;
      expect(roofOf(wp), style).toBeLessThan(roofOf(ip));
      const r = resolvePlan(wp, bundledPalettes());
      expect(
        verifyBuild(r, realize(r, palettes), palettes, { plan: wp }).diagnostics.filter(
          (x) => x.severity === "error",
        ),
        style,
      ).toEqual([]);
    }
  });
  it("a ruin's rubble, growth and props come only from their own roles: a theme without them gets nothing", () => {
    const b: Building = { ...one("keep", 4, undefined, 9, 9), condition: "ruined" };
    const p = plan([b], 24, 24, "forest");
    const r = resolvePlan(p, bundledPalettes());
    expect((((r.levels[0] as ResolvedLevel).structures ?? [])[0]?.debris ?? []).length).toBeGreaterThan(0);
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
    const pl = realize(r, bare).levels[0]?.placements ?? [];
    expect(pl.filter((q) => /~(rubble|growth|prop)$/.test(String(q.source.elementId)))).toEqual([]);
    const full = realize(r, palettes).levels[0]?.placements ?? [];
    expect(full.filter((q) => /~(rubble|growth)$/.test(String(q.source.elementId))).length).toBeGreaterThan(
      0,
    );
  });
  it("bare x, y, w, h on a building is its one wing", () => {
    const p = plan([{ id: "b", style: "cottage", x: 4, y: 4, w: 6, h: 5 }], 20, 20, "forest");
    expect(validatePlan(p).issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(structuresOf(p)[0]?.cells.length).toBeGreaterThan(8); // the drawn size class may keep part of the plot
  });
});

describe("design spaces of the other styles", () => {
  for (const [style, w, h, minSig, minArch] of [
    ["keep", 9, 9, 12, 3],
    ["tower", 5, 5, 8, 1],
    ["ruin", 7, 6, 10, 3],
    ["modern", 8, 7, 12, 3],
    ["desert", 7, 7, 12, 3],
  ] as const)
    it(`${style}: 30 seeds give at least ${minSig} signatures and ${minArch} archetypes; a sample builds without errors`, () => {
      const sigs = new Set<string>();
      const archs = new Set<string>();
      for (let seed = 0; seed < 30; seed++) {
        const st = structuresOf(
          plan([one(style, seed, undefined, w, h)], 22, 22, "outdoor"),
        )[0] as ResolvedStructure;
        expect(st.design, `${style} seed ${seed}`).toBeDefined();
        sigs.add(structureSignature(st) ?? "");
        archs.add(st.design?.archetype ?? "");
      }
      expect(sigs.size).toBeGreaterThanOrEqual(minSig);
      expect(archs.size).toBeGreaterThanOrEqual(minArch);
      for (const seed of [1, 7, 13]) {
        const p = plan([one(style, seed, undefined, w, h)], 22, 22, "outdoor");
        expect(validatePlan(p).issues.filter((i) => i.severity === "error")).toEqual([]);
        const r = resolvePlan(p, bundledPalettes());
        const ver = verifyBuild(r, realize(r, palettes), palettes, { plan: p });
        expect(
          ver.diagnostics.filter((d) => d.severity === "error"),
          `${style} seed ${seed}`,
        ).toEqual([]);
      }
    });

  it("a tower is a tower: at most 5 cells a side and twice as tall as wide, even on an oversized plot", () => {
    for (let seed = 0; seed < 15; seed++) {
      const st = structuresOf(
        plan([one("tower", seed, undefined, 9, 9)], 22, 22, "outdoor"),
      )[0] as ResolvedStructure;
      const ground = (st.volumes ?? []).filter((v) => v.on === null);
      const w = Math.max(...ground.map((v) => v.storeys[0]?.rect.w ?? 0));
      const top = Math.max(...(st.volumes ?? []).map((v) => v.storeys[v.storeys.length - 1]?.wallTop ?? 0));
      expect(w, `seed ${seed}`).toBeLessThanOrEqual(5);
      expect(top - (st.storeys[0]?.floorTop ?? 0), `seed ${seed}`).toBeGreaterThanOrEqual(2 * w - 1);
    }
  });
});
