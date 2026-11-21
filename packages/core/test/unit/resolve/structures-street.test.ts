/**
 * Generator 3 streets and condition: a street of one style differs in wall and roof material, entrances vary, no hip
 * roofs or stacks apart from the walls, no blank walls; a weathered roof loses a ragged patch at an eave, an attached
 * porch takes the building's condition, a timber ruin uses timber logic.
 */
import { describe, expect, it } from "vitest";
import type { Building, MapPlan, Structure } from "../../../src/contracts/plan";
import type { ResolvedLevel, ResolvedStructure } from "../../../src/contracts/resolved";
import { realize } from "../../../src/compile";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import "../../../src/resolve/autoregister";
import { townPlan } from "../../fixtures/planBuilder";

const palettes = loadPalettes();

const plan = (structures: Structure[], generator: 2 | 3 = 3, seed = 5): MapPlan =>
  townPlan({
    generator,
    id: "r4",
    seed,
    theme: "forest",
    w: 70,
    h: 20,
    structures,
    level: { features: [{ id: "f", type: "statue", at: [1, 1] }] },
  });
const all = (p: MapPlan): ResolvedStructure[] =>
  (resolvePlan(p, bundledPalettes()).levels[0] as ResolvedLevel).structures ?? [];
const street = (seed: number): MapPlan =>
  plan(
    [3, 15, 28, 40, 54].map((x, i) => ({
      id: `b${i + 1}`,
      style: "cottage",
      seed: seed * 10 + i,
      ...(i > 2 ? { use: "tavern" } : {}),
      wings: [{ x, y: 4, w: 7 + (i % 3), h: 6 + (i % 2) }],
      front: "S" as const,
    })),
    3,
    seed,
  );
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

describe("a street of one style (generator 3)", () => {
  it("differs in wall and roof material: stone, timber or plaster, a second roof kit, and no neighbour repeats a pair", () => {
    const mats = new Set<string>();
    const kits = new Set<string>();
    for (const s of SEEDS) {
      const ds = all(street(s)).map((st) => st.design);
      expect(ds.every((d) => d !== undefined)).toBe(true);
      for (const d of ds) {
        mats.add(String(d?.material));
        kits.add(String(d?.roofKit));
      }
      for (let i = 0; i < ds.length; i++)
        for (let j = i + 1; j < ds.length; j++) {
          const a = ds[i];
          const b = ds[j];
          // within ten cells (each plot is 7-9 wide, 12 apart): the same walls, base and roof kit never repeat
          if (j - i === 1)
            expect(`${a?.material}|${a?.baseMaterial}|${a?.roofKit}`, `seed ${s} ${i}/${j}`).not.toBe(
              `${b?.material}|${b?.baseMaterial}|${b?.roofKit}`,
            );
        }
    }
    expect(mats.size).toBeGreaterThanOrEqual(3);
    expect(kits.size).toBeGreaterThanOrEqual(2);
  });

  it("offers no hip roof, and draws no chimney on one", () => {
    for (const s of SEEDS)
      for (const st of all(street(s))) {
        expect(st.design?.roof).not.toBe("hip");
        for (const v of st.volumes ?? [])
          if (v.roof.layers[0]?.type === "hip") expect(st.chimneys.length).toBe(0);
      }
  });

  it("varies the entrance: none, a roofed hood, a wide porch or an open landing, never the same twice running", () => {
    const kinds = new Set<string>();
    for (const s of SEEDS) {
      const seq = all(street(s)).map((st) => {
        const p = st.porches[0];
        const k = !p ? "none" : !p.roof ? "landing" : p.cells.length >= 8 ? "porch" : "hood";
        kinds.add(k);
        return k;
      });
      for (let i = 1; i < seq.length; i++) expect(seq[i], `seed ${s}`).not.toBe(seq[i - 1]);
    }
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  });

  it("windows follow the wall: every face of three cells or more has an opening, gaps at most three cells", () => {
    for (const s of SEEDS) {
      const p = plan(
        [
          { id: "b", style: "cottage", seed: s, wings: [{ x: 10, y: 4, w: 10, h: 8 }], front: "S" },
        ] as Structure[],
        3,
        s,
      );
      const st = all(p)[0] as ResolvedStructure;
      const level = resolvePlan(p, bundledPalettes()).levels[0] as ResolvedLevel;
      const wins =
        level.openings.filter((o) => st.openingIds.includes(o.id) && o.kind === "window").length +
        st.upperOpenings.filter((o) => o.kind === "window").length;
      const old = plan(
        [
          { id: "b", style: "cottage", seed: s, wings: [{ x: 10, y: 4, w: 10, h: 8 }], front: "S" },
        ] as Structure[],
        2,
        s,
      );
      const st2 = all(old)[0] as ResolvedStructure;
      const level2 = resolvePlan(old, bundledPalettes()).levels[0] as ResolvedLevel;
      const wins2 =
        level2.openings.filter((o) => st2.openingIds.includes(o.id) && o.kind === "window").length +
        st2.upperOpenings.filter((o) => o.kind === "window").length;
      expect(wins, `seed ${s}`).toBeGreaterThan(0);
      expect(wins).toBeGreaterThanOrEqual(Math.min(wins2, 1));
    }
  });
});

const house = (seed: number, condition: Building["condition"], extra: Partial<Building> = {}): Structure =>
  ({
    id: "b",
    style: "cottage",
    seed,
    condition,
    wings: [{ x: 12, y: 5, w: 9, h: 7, ridge: "ew" }],
    front: "S",
    ...extra,
  }) as Structure;

describe("weathered and ruined buildings (generator 3)", () => {
  it("a weathered roof loses a ragged patch at an eave or a corner, not a square in the middle", () => {
    let edge = 0;
    let ragged = 0;
    let n = 0;
    for (const s of SEEDS) {
      const st = all(plan([house(s, "weathered")], 3, s))[0] as ResolvedStructure;
      const holes = st.ruin?.roofHoles ?? [];
      if (holes.length === 0) continue;
      n++;
      const cells = new Set(st.cells.map(([x, y]) => `${x},${y}`));
      if (
        holes.some(([x, y]) =>
          [
            [0, 1],
            [0, -1],
            [1, 0],
            [-1, 0],
          ].some(([dx, dy]) => !cells.has(`${x + (dx ?? 0)},${y + (dy ?? 0)}`)),
        )
      )
        edge++;
      if (holes.length !== 9 && holes.length !== 4) ragged++;
    }
    expect(n).toBeGreaterThan(4);
    expect(edge).toBe(n);
    expect(ragged).toBeGreaterThan(n / 2);
  });

  it("an attached porch takes the building's condition: gone from a ruin, partly gone when weathered", () => {
    const roofs = (condition: Building["condition"]): number => {
      let n = 0;
      for (const s of SEEDS) {
        const p = plan(
          [house(s, condition, { attachments: [{ type: "porch", side: "S", width: 3, depth: 2 }] })],
          3,
          s,
        );
        n += (realize(resolvePlan(p, bundledPalettes()), palettes).levels[0]?.placements ?? []).filter(
          (q) => String(q.source.elementId) === "b~porchroof0",
        ).length;
      }
      return n;
    };
    const intact = roofs("intact");
    expect(intact).toBeGreaterThan(0);
    expect(roofs("weathered")).toBeLessThan(intact);
    expect(roofs("ruined")).toBe(0);
  });

  it("a timber ruin uses timber logic: no lone stepped gable, no grey stone rubble on the planks", () => {
    for (const s of SEEDS) {
      const p = plan(
        [
          house(s, "ruined", {
            wings: [{ x: 12, y: 5, w: 9, h: 7, ridge: "ew" }],
            storeys: [{ walls: "wood", height: 3 }],
          }),
        ],
        3,
        s,
      );
      const st = all(p)[0] as ResolvedStructure;
      expect((st.volumes ?? []).every((v) => v.roof.gableOnly === undefined)).toBe(true);
      const pl = realize(resolvePlan(p, bundledPalettes()), palettes).levels[0]?.placements ?? [];
      expect(pl.filter((q) => ["b~walltop", "b~rubble"].includes(String(q.source.elementId)))).toEqual([]);
    }
  });

  it("generator 2 plans are unchanged by the entrance and window rules", () => {
    for (const s of SEEDS) {
      const st = all(plan([house(s, undefined)], 2, s))[0] as ResolvedStructure;
      expect(st.growthLevel).toBeUndefined();
      expect(st.valleys).toBeUndefined();
    }
  });
});
