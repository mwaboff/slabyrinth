/**
 * A piece is sized in the theme it is built in (generator 4, switch `piecesInCellTheme`): a thing resting on a table,
 * a counter or a stall is lifted to that support's height in the support's own theme, not the level's. A level of one
 * theme with areas of another, where the other theme's supports are taller, catches a placer that asks the level.
 */
import { describe, expect, it } from "vitest";
import type { Area, MapPlan } from "../../../src/contracts/plan";
import { BUILD_CONSTANTS } from "../../../src/contracts/plan";
import type { ResolvedFeature, ResolvedLevel } from "../../../src/contracts/resolved";
import { featureInfo } from "../../../src/gen/catalog";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { createPaletteView } from "../../../src/palette/view";
import { resolvePlan } from "../../../src/resolve";
import { oneLevelPlan } from "../../fixtures/planBuilder";

/** Supports whose pieces the tall theme makes half as tall again. */
const SUPPORTS = [
  "table",
  "round_table",
  "counter",
  "desk",
  "chest",
  "stall",
  "crate",
  "barrel",
  "boulder",
] as const;
const TALL = "tall_hall";

/** A user theme on generic whose supports are 1.5 times as tall as generic's. */
function tallCatalog() {
  const generic = bundledPalettes().palettes.generic;
  if (!generic) throw new Error("no generic palette");
  const roles: Record<string, unknown> = {};
  for (const t of SUPPORTS) {
    const role = generic.roles[`feature.${t}`];
    if (!role) continue;
    roles[`feature.${t}`] = {
      ...role,
      variants: role.variants.map((v) => ({
        ...v,
        geom: { ...v.geom, size: { ...v.geom.size, y: v.geom.size.y * 1.5 } },
      })),
    };
  }
  const data = {
    schema: "slabyrinth/palette@1",
    id: TALL,
    name: "Tall hall",
    extends: "generic",
    defaults: { floor: "flagstone", wallStyle: "wall" },
    roles,
  };
  return loadPalettes({ user: [{ source: `${TALL}.json`, data }] });
}

const rect = (x: number, y: number, w: number, h: number) => ({ type: "rect" as const, x, y, w, h });

/** A generic level with a tavern, a market yard and a camp in the tall theme, and the same three in generic. */
function twoThemePlan(): MapPlan {
  const areas: Area[] = [];
  const stalls = [];
  const terrain = [];
  const features = [];
  for (const [k, theme] of [
    [0, TALL],
    [1, "generic"],
  ] as const) {
    const y0 = k * 16;
    areas.push(
      { id: `tavern${k}`, name: "Tavern", kind: "room", theme, shape: rect(1, y0 + 1, 9, 7) },
      { id: `yard${k}`, kind: "courtyard", walls: "none", theme, shape: rect(12, y0 + 1, 12, 7) },
      { id: `camp${k}`, kind: "courtyard", walls: "none", theme, shape: rect(1, y0 + 9, 23, 6) },
    );
    stalls.push({ id: `row${k}`, area: { x: 12, y: y0 + 2, w: 12, h: 3 }, facing: "S" as const });
    terrain.push({ id: `dress${k}`, op: "dress" as const, area: `camp${k}`, preset: "campsite" as const });
    // a stall the plan places itself: the market puts goods on its bare table
    features.push({
      id: `stall${k}`,
      type: "stall" as const,
      at: [14, y0 + 6] as [number, number],
      variant: "bread",
    });
  }
  return oneLevelPlan({
    generator: 4,
    w: 26,
    h: 32,
    theme: "generic",
    seed: 7,
    level: { areas, stalls, terrain, features },
  });
}

/** What stands under a lifted feature's cell (the other features whose footprint holds it: a table, a shelf). */
function supportsUnder(L: ResolvedLevel, f: ResolvedFeature): ResolvedFeature[] {
  return L.features.filter(
    (s) =>
      s !== f &&
      f.at[0] >= s.at[0] &&
      f.at[0] < s.at[0] + s.size[0] &&
      f.at[1] >= s.at[1] &&
      f.at[1] < s.at[1] + s.size[1],
  );
}

describe("pieces are sized in their cell's theme (generator 4)", () => {
  it("every lifted thing sits at the support height of its own theme", () => {
    const catalog = tallCatalog();
    const view = createPaletteView(catalog);
    const R = resolvePlan(twoThemePlan(), catalog);
    const L = R.levels[0] as ResolvedLevel;
    const byTheme = new Map<string, number>();
    for (const f of L.features) {
      if (f.generatedBy === undefined || featureInfo(f.type).wallMounted) continue;
      const i = (f.at[1] - L.bounds.y) * L.bounds.w + (f.at[0] - L.bounds.x);
      const lift =
        f.baseHeight - (L.elevation + BUILD_CONSTANTS.floorThickness + (L.cells.height[i] ?? 0) / 4);
      if (lift < 0.05) continue;
      const under = supportsUnder(L, f);
      // on a shelf the lift is the shelf plank's (a fixed height, gen/rooms4.ts SHELF_TOP), not a piece size
      if (!under.some((s) => (SUPPORTS as readonly string[]).includes(s.type))) continue;
      if (under.some((s) => s.type === "shelf_line")) continue;
      // the heights a placer may lift to over what stands there, asked of the thing's own theme
      const allowed = under.flatMap((s) => {
        const room = view.roomPiece(f.theme, s.type, s.variant);
        const real = view.pieceSize(f.theme, s.type, true, s.type === "stall" ? "empty" : undefined);
        return [room?.h, room?.hMax, real?.h].filter((h): h is number => h !== undefined);
      });
      expect(
        allowed.some((h) => Math.abs(h - lift) < 1e-6),
        `${f.id} (${f.type} on ${under.map((s) => s.type).join("+")}, ${f.theme}) lifted ${lift}, allowed ${allowed.join(", ")}`,
      ).toBe(true);
      byTheme.set(f.theme, (byTheme.get(f.theme) ?? 0) + 1);
    }
    // the test means something: things rest on supports in both themes
    expect(byTheme.get(TALL) ?? 0).toBeGreaterThan(0);
    expect(byTheme.get("generic") ?? 0).toBeGreaterThan(0);
  });
});
