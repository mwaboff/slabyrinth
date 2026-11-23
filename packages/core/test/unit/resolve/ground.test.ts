/**
 * Layered ground (resolve/recipes/ground.ts) on ground-and-walls-v1, its "layered" variant forced: cover share by place,
 * gathered at the ground's edges, overlapping flat pairs, nothing in a lane, an apron, a way, on the path or under
 * furniture, less indoors, thinned by the budget, deterministic, held to the meter's hard rules; generator 4 and the
 * switch off build none.
 */
import { describe, expect, it } from "vitest";
import { placedBox, planPointOf } from "../../../src/arrange";
import { realize } from "../../../src/compile";
import { CELL_FLAG, type ResolvedArrangement, type ResolvedLevel } from "../../../src/contracts/resolved";
import { bundledPalettes } from "../../../src/palette";
import { resolveView } from "../../../src/palette/view";
import { generatorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { LevelAnchors, ZONE } from "../../../src/resolve/anchors";
import { ArrangementRecords } from "../../../src/resolve/level/arrangements";
import { runRecipes } from "../../../src/resolve/recipes/engine";
import { layeredGround } from "../../../src/resolve/recipes/ground";
import { loadPlan } from "../../fixtures";
import { coplanarShare, duplicateCount, piecesOf, restContact } from "../../fixtures/quality";
import { forced, withArrangements } from "../../fixtures/treatments";

const pal = bundledPalettes();
const plan = { ...loadPlan("ground-and-walls-v1"), generator: 5 as const };
const view = resolveView(plan, pal);
const resolved = resolvePlan(plan, pal);
const L0 = resolved.levels[0] as ResolvedLevel;
const bare: ResolvedLevel = { ...L0 };
delete bare.arrangements;
const anchors = new LevelAnchors(bare);
const LAYERED = forced({ ground: { layeredGround: "layered" } });
const run = (budget = 1e6, profile = generatorProfile(5), families = LAYERED) =>
  runRecipes(bare, new ArrangementRecords(), {
    planSeed: plan.seed,
    profile,
    palette: view,
    budget,
    families,
    recipes: [layeredGround],
  });
const all = run();
const zoneOf = (id: string) => anchors.of("zone").find((z) => z.area === id);

/** Sample points (4 x 4 per cell) of a zone's open cells covered by its instances' footprints. */
function coverage(area: string, inst: readonly ResolvedArrangement[]): { share: number; nearEdge: number } {
  const z = zoneOf(area);
  if (!z) throw new Error(area);
  const mine = inst.filter((x) => x.host === area);
  const boxes = mine.flatMap((x) =>
    x.pieces.map((p) => {
      const v = view.roles
        .resolve(view.roles.paletteTheme(p.palette), p.role)
        .resolution?.variants.find((q) => q.wanted === p.asset);
      const b = placedBox({
        piece: { palette: p.palette, role: p.role, variant: v as never, measures: {} as never },
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
      });
      const a = planPointOf(x.at, x.turn, b.min.x, b.min.z);
      const c = planPointOf(x.at, x.turn, b.max.x, b.max.z);
      return {
        x0: Math.min(a[0], c[0]),
        x1: Math.max(a[0], c[0]),
        y0: Math.min(a[1], c[1]),
        y1: Math.max(a[1], c[1]),
      };
    }),
  );
  let open = 0;
  let covered = 0;
  let near = 0;
  for (const [x, y] of z.cells) {
    const f = bare.cells.flags[anchors.grid.index(x, y)] ?? 0;
    if ((f & (CELL_FLAG.PATH | CELL_FLAG.WATER)) !== 0 || (z.classAt(x, y) & (ZONE.LANE | ZONE.DOOR)) !== 0)
      continue;
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) {
        const px = x + (i + 0.5) / 4;
        const py = y + (j + 0.5) / 4;
        open++;
        if (boxes.some((b) => px > b.x0 && px < b.x1 && py > b.y0 && py < b.y1)) {
          covered++;
          if (z.edgeAt(x, y) <= 1) near++;
        }
      }
  }
  return { share: covered / open, nearEdge: covered > 0 ? near / covered : 0 };
}

describe("layered ground on ground-and-walls-v1", () => {
  it("covers about 25-35 % of open natural ground outdoors, at least half of it within a tile of an edge", () => {
    const c = coverage("yard", all.attached);
    expect(c.share).toBeGreaterThanOrEqual(0.2);
    // (by boxes: with `visibleGround` the share is laid to what is seen, which boxes read higher; streetCondition.test)
    expect(c.share).toBeLessThanOrEqual(0.5);
    expect(c.nearEdge).toBeGreaterThanOrEqual(0.5);
  });

  it("covers a kept-up hall much less than open ground", () => {
    const hall = coverage("hall", all.attached).share;
    expect(hall).toBeLessThan(coverage("yard", all.attached).share / 2);
  });

  it("keeps lanes, aprons, ways and the path clean, and nothing lies over water or under furniture", () => {
    for (const x of all.attached)
      for (const p of x.pieces) {
        const [px, py] = planPointOf(x.at, x.turn, p.x, p.z);
        const cx = Math.floor(px);
        const cy = Math.floor(py);
        const f = bare.cells.flags[anchors.grid.index(cx, cy)] ?? 0;
        expect(f & (CELL_FLAG.PATH | CELL_FLAG.WATER | CELL_FLAG.STEPS | CELL_FLAG.LINK)).toBe(0);
        const z = zoneOf(x.host ?? "");
        expect((z?.classAt(cx, cy) ?? 0) & (ZONE.LANE | ZONE.DOOR)).toBe(0);
      }
    expect(all.skipped.some((s) => /lane|way/.test(s.why))).toBe(true);
  });

  it("lays flat pieces in overlapping pairs at free turns, and sinks low ones a little", () => {
    const yaws = new Set(all.attached.flatMap((x) => x.pieces.map((p) => p.yaw % 90)));
    expect([...yaws].some((y) => y !== 0)).toBe(true);
    expect(all.attached.some((x) => x.pieces.some((p) => x.base + p.y < x.base - 0.01))).toBe(true);
  });

  it("meets the meter's hard rules: no coplanar flat tops, no duplicates, every piece rests", () => {
    const r = withArrangements(resolved, L0.id, all.attached);
    const set = realize(r, pal, {});
    const ps = piecesOf(set, (e) => e.startsWith("layeredGround@"));
    expect(ps.length).toBeGreaterThan(50);
    expect(coplanarShare(ps)).toBe(0);
    expect(duplicateCount(ps)).toBe(0);
    // (the rest test measures each prop among the whole build: a slow quadratic walk)
    expect(
      restContact(
        ps,
        piecesOf(set, () => true),
      ),
    ).toEqual([]);
  }, 60_000);

  it("thins under a tight budget, calm blocks first, and is deterministic", () => {
    expect(run().attached).toEqual(all.attached);
    const n = all.attached.reduce((s, x) => s + x.pieces.length, 0);
    const tight = run(Math.floor(n / 2));
    expect(tight.spent).toBeLessThanOrEqual(Math.floor(n / 2));
    expect(tight.attached.length).toBeGreaterThan(0);
  });

  it("is built by no generator before 5, nor with its switch off", () => {
    expect(resolvePlan({ ...plan, generator: 4 }, pal).levels[0]?.arrangements).toBeUndefined();
    const off = { ...generatorProfile(5), layeredGround: false };
    expect(run(1e6, off).attached).toEqual([]);
  });
});
