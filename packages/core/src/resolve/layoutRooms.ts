/**
 * The rooms of a complex as a walk sees them (generator 5, build plan §11.3, technique catalogue Part 4 Q4): each room's
 * floor, its ways on and whether anything stands in it. One answer for the two that ask: the resolver, while a level is
 * being built (resolve/level/deadEnds.ts gives a dead end something to hold), and the review over the finished map
 * (review/layout.ts, the `dead_end_empty` note and the quality meter). Both walk with stepEdge and standable
 * (resolve/playability.ts), the steps every walk of the map takes, so a door, a step or a stair counts here as it
 * counts for playability.
 */
import type { AreaKind, FeatureType, RoomPurpose, Vec2 } from "../contracts/plan";
import { CELL, CELL_FLAG, type ResolvedOpening } from "../contracts/resolved";
import { LIGHT_FEATURES, featureInfo } from "../gen/catalog";
import { SIDES } from "../gen/gridGeometry";
import { MATERIALS } from "../contracts/plan";
import { standable, stepEdge, type WalkLevel, type WalkMode } from "./playability";
import type { ResolveGrid } from "./level/grid";

/** One room of a level: its floor, its ways on, and whether it holds something. */
export interface LayoutRoom {
  readonly levelId: string;
  readonly id: string;
  readonly name: string;
  readonly floor: number;
  /** Distinct neighbouring areas a step leads into, plus one for a link (stairs, ladder, drop) in the room. */
  readonly ways: number;
  /** A feature stands in it that is neither a light nor strewn litter. */
  readonly holds: boolean;
  /** A corridor in all but name (purpose "passage": a landing, a vestibule): no dead end, whatever its ways. */
  readonly passage: boolean;
  readonly cell: Vec2;
}

/** A level as the room walk reads it: a walk level with its origin and its cells' (shown) areas. */
export interface LayoutLevel extends WalkLevel {
  readonly id: string;
  readonly bounds: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly cells: WalkLevel["cells"] & { readonly area: ArrayLike<number> };
}

/** An area as the room walk reads it. */
export interface LayoutArea {
  readonly id: string;
  readonly name?: string | undefined;
  readonly kind: AreaKind;
  /** A building's ground-storey room is the building's, not a room of the complex. */
  readonly building?: string | undefined;
  readonly purpose?: RoomPurpose | undefined;
}

const MODE: WalkMode = { secret: true, ignoreFeatures: true };

/** A room of the plan's layout (a building's ground-storey rooms, generator 5 buildingRooms, are the building's). */
export const isLayoutRoom = (a: LayoutArea): boolean => a.kind === "room" && a.building === undefined;

/** Does something stand in the area: a feature that is neither a light nor strewn litter (furniture, a chest, remains)? */
export const holdsSomething = (
  features: ReadonlyArray<{ readonly area?: string | undefined; readonly type: FeatureType }>,
  areaId: string,
): boolean =>
  features.some(
    (f) => f.area === areaId && !LIGHT_FEATURES.has(f.type) && featureInfo(f.type).strewn !== true,
  );

/** The walkable floor cells of each area of a level (local indices), by area index. */
export function floorCells(l: LayoutLevel): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let i = 0; i < l.cells.area.length; i++) {
    const a = l.cells.area[i] as number;
    if (a === 0 || l.cells.state[i] !== CELL.OPEN) continue;
    if (((l.cells.flags[i] as number) & (CELL_FLAG.NO_FLOOR | CELL_FLAG.WATER)) !== 0) continue;
    const list = out.get(a - 1) ?? [];
    list.push(i);
    out.set(a - 1, list);
  }
  return out;
}

/**
 * The rooms of a level with their ways on. `deep` and `lava`: the values of deep water and lava in the level's
 * `material` array (0 = none); `floors`: floorCells(l), when the caller has it.
 */
export function layoutRooms(
  l: LayoutLevel,
  areas: readonly LayoutArea[],
  features: ReadonlyArray<{ readonly area?: string | undefined; readonly type: FeatureType }>,
  water: { readonly deep: number; readonly lava: number },
  floors: ReadonlyMap<number, readonly number[]> = floorCells(l),
): LayoutRoom[] {
  const W = l.bounds.w;
  const xy = (i: number): Vec2 => [l.bounds.x + (i % W), l.bounds.y + Math.floor(i / W)];
  const rooms: LayoutRoom[] = [];
  areas.forEach((a, ai) => {
    const cells = floors.get(ai) ?? [];
    if (!isLayoutRoom(a) || cells.length === 0) return;
    const next = new Set<number>();
    let link = false;
    for (const i of cells) {
      if (((l.cells.flags[i] as number) & (CELL_FLAG.LINK | CELL_FLAG.STEPS)) !== 0) link = true;
      for (const s of SIDES) {
        const [j, pass] = stepEdge(l, i, s, MODE);
        if (!pass || j < 0 || !standable(l, j, water.deep, water.lava, MODE)) continue;
        const b = l.cells.area[j] as number;
        if (b !== ai + 1) next.add(b);
      }
    }
    rooms.push({
      levelId: l.id,
      id: a.id,
      name: a.name ?? a.id,
      floor: cells.length,
      ways: next.size + (link ? 1 : 0),
      holds: holdsSomething(features, a.id),
      passage: a.purpose === "passage",
      cell: xy(cells[0] as number),
    });
  });
  return rooms;
}

/** Rooms with one way on that hold nothing (a passage in all but name is no dead end). */
export const emptyDeadEndsOf = (rooms: readonly LayoutRoom[]): LayoutRoom[] =>
  rooms.filter((r) => r.ways === 1 && !r.holds && !r.passage);

const DEEP = MATERIALS.indexOf("water_deep") + 1;
const LAVA = MATERIALS.indexOf("lava") + 1;

/**
 * The resolver's grid as the room walk reads it, once the level's openings are placed (phase 2): the same cells, edges
 * and openings the finished level will carry (resolve/level/output.ts copies them index for index), its materials as
 * the grid holds them (MATERIALS ordinal + 1).
 */
export function gridLayoutLevel(
  work: ResolveGrid,
  openings: readonly ResolvedOpening[],
): { level: LayoutLevel; water: { deep: number; lava: number } } {
  return {
    level: {
      id: work.level.id,
      bounds: { x: work.bx, y: work.by, w: work.w, h: work.h },
      cells: {
        state: work.state,
        flags: work.flags,
        height: work.height,
        material: work.mat,
        area: work.disp,
      },
      hEdges: work.hE,
      vEdges: work.vE,
      openings,
    },
    water: { deep: DEEP, lava: LAVA },
  };
}
