/**
 * The light-levels line-up (generator 5): one taproom five times side by side, each named for one light level (dark,
 * dim, moderate, bright, flooded: its own words set its character's light), every room's door on one corridor along
 * the south, and 1 to 5 crates in the corridor outside each door as its label. Used by the light-level tests and the
 * `tavern-light-levels` proof.
 */
import type { PlacementSet } from "../../src/contracts/compiler";
import type { Area, Feature, MapPlan, Opening } from "../../src/contracts/plan";
import type { ResolvedLevel } from "../../src/contracts/resolved";
import { LIGHT_FEATURES } from "../../src/gen/catalog";
import { lightPiece } from "../../src/gen/lightReach";

/**
 * The cells of a room within reach of a light that gives light (gen/lightReach.ts, by the piece the build chose): a
 * pool lights the cells whose centres lie within its reach (plus half a tile) of its centre; a light of any other kind
 * that gives light at all lights its own cell. What the light-level steps are measured by.
 */
export function litCells(L: ResolvedLevel, set: PlacementSet, room: string): number {
  const area = L.areas.find((a) => a.id === room);
  if (!area) return 0;
  const idx = L.areas.indexOf(area) + 1;
  const cells: Array<[number, number]> = [];
  for (let i = 0; i < L.cells.area.length; i++)
    if (L.cells.area[i] === idx)
      cells.push([L.bounds.x + (i % L.bounds.w), L.bounds.y + Math.floor(i / L.bounds.w)]);
  const placements = set.levels.find((x) => x.levelId === L.id)?.placements ?? [];
  const lit = new Set<string>();
  for (const f of L.features) {
    if (f.area !== room || !LIGHT_FEATURES.has(f.type)) continue;
    const p = placements.find((q) => q.source.elementId === f.id);
    const piece = lightPiece(p ? set.placed?.get(p)?.name : undefined, f.type);
    if (piece.kind === "none") continue;
    const cx = f.at[0] + f.size[0] / 2 + (f.offset?.[0] ?? 0);
    const cy = f.at[1] + f.size[1] / 2 + (f.offset?.[1] ?? 0);
    for (const [x, y] of cells) {
      const own = x === f.at[0] && y === f.at[1];
      const near = piece.kind === "pool" && Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= piece.reach + 0.5;
      if (own || near) lit.add(`${x},${y}`);
    }
  }
  return lit.size;
}

export const LIGHT_LINEUP_LEVELS = ["Dark", "Dim", "Moderate", "Bright", "Flooded"] as const;
/** Each room's side (tiles) and the pitch between rooms. */
const SIDE = 8;
const PITCH = SIDE + 1;

export function lightLineupPlan(theme = "wood_town", seed = 17): MapPlan {
  const areas: Area[] = LIGHT_LINEUP_LEVELS.map((name, i) => ({
    id: `tap${i + 1}`,
    kind: "room",
    name: `${name} taproom`,
    floor: "wood_plank",
    shape: { type: "rect", x: 1 + i * PITCH, y: 1, w: SIDE, h: SIDE },
  }));
  areas.push({
    id: "hall",
    kind: "corridor",
    name: "Hall",
    floor: "flagstone",
    shape: { type: "rect", x: 1, y: 1 + SIDE, w: PITCH * LIGHT_LINEUP_LEVELS.length - 1, h: 3 },
  });
  const openings: Opening[] = LIGHT_LINEUP_LEVELS.map((_, i) => ({
    id: `door${i + 1}`,
    kind: "door",
    between: [`tap${i + 1}`, "hall"],
  }));
  const features: Feature[] = LIGHT_LINEUP_LEVELS.flatMap((_, i) =>
    Array.from({ length: i + 1 }, (_, k) => ({
      id: `crate${i + 1}-${k + 1}`,
      type: "crate" as const,
      at: [1 + i * PITCH + 1 + k, 2 + SIDE + 1] as [number, number],
      size: [1, 1] as [number, number],
    })),
  );
  return {
    schema: "slabyrinth/plan@1",
    generator: 5,
    id: "5b1d7e3a-0c2f-4a8b-9e6d-3f4a1c2b7d90",
    title: "tavern light levels",
    kind: "building",
    seed,
    theme,
    levels: [
      {
        id: "l1",
        name: "Taprooms",
        elevation: 0,
        bounds: { x: 0, y: 0, w: PITCH * LIGHT_LINEUP_LEVELS.length + 1, h: SIDE + 6 },
        base: { type: "solid" },
        areas,
        openings,
        walls: [],
        features,
        terrain: [],
        labels: [],
      },
    ],
    links: [],
  };
}
