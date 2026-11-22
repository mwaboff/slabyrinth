/**
 * Small things on a surface (generator 4): the one table behind "a plate on a table", "loaves on a counter" and "jugs on
 * a stall", read by market goods (`feature.goods`, by kind of stall), room clutter (`feature.clutter`, by family of room)
 * and the room recipes' per-support counts:
 *
 *   FAMILIES        every family of small things, and the palette variant name it goes by. The variant name is the
 *                   family name, so a palette lists the pieces of a family under one name wherever they live.
 *   SMALL_THINGS_ROLES  the palette roles that hold them, tried in order. `feature.clutter` comes first, `feature.goods`
 *                   (the generator-3 market role) is the fallback, so a family a theme only lists under goods is found
 *                   and a theme can supply either. Role chain and variant filter are the whole lookup; nothing else
 *                   knows which role a family lives in.
 *   SURFACE_LOAD    how many small things stand on each kind of support (a room's table, a stall's counter cell).
 *
 * Callers: gen/rooms4 (room recipes), gen/market.ts (the stall-kind table names a family per kind), compile/stalls.ts
 * (counters of a covered stall) and the palette view (piece sizes). Generators 1-3 keep their own tables
 * (gen/place.ts, the generator-3 stall goods) and never read this one.
 */
import type { FeatureType } from "../contracts/plan";
import { typesWith } from "./catalog";

/** What a stall or a shop sells, as small things (the palette variant names of `feature.goods`). */
export type GoodsFamily = "produce" | "bread" | "dairy" | "fish" | "potions" | "grain";
/** What a room keeps on its tables, desks and shelves (the palette variant names of `feature.clutter`). */
export type RoomFamily = "table" | "study" | "store" | "tools" | "shelf";
export type SmallFamily = GoodsFamily | RoomFamily;

export const GOODS_FAMILIES: readonly GoodsFamily[] = [
  "produce",
  "bread",
  "dairy",
  "fish",
  "potions",
  "grain",
];
export const ROOM_FAMILIES: readonly RoomFamily[] = ["table", "study", "store", "tools", "shelf"];

/** Palette roles that hold small things, in the order they are tried (generator 4). */
export const SMALL_THINGS_ROLES: readonly string[] = ["feature.clutter", "feature.goods"];

/** Feature types that are small things on a surface (`smallThing`); at generator 4 they resolve through SMALL_THINGS_ROLES. */
export const SMALL_THING_TYPES: ReadonlySet<FeatureType> = new Set(typesWith((f) => f.smallThing === true));

/**
 * Palette roles a feature type is built from at generator 4 (the single place that says so). A small thing is looked up
 * in its own role first, then in the other one: a `goods` feature with no family still gets goods, a `clutter` one clutter.
 */
export function featureRoles(type: FeatureType): readonly string[] {
  if (!SMALL_THING_TYPES.has(type)) return [`feature.${type}`];
  return type === "goods" ? [...SMALL_THINGS_ROLES].reverse() : SMALL_THINGS_ROLES;
}

/** A support the small things stand on: how many (min, max) and the family it carries unless the recipe says other. */
export interface SurfaceLoad {
  n: readonly [number, number];
  family?: SmallFamily;
  /** Chance it takes anything at all (default: gen/rooms4/recipes.ts ROOM_DRESS.topChance). */
  chance?: number;
  /** The variant that carries things and stacks on itself (a small crate: a large one's top is taller). */
  stackVariant?: string;
}

/**
 * Per support. Keys are feature types (a room's furniture) and `stall_counter` (one counter cell of a covered stall,
 * compile/stalls.ts). Types not listed take nothing.
 */
export const SURFACE_LOAD: Readonly<Record<string, SurfaceLoad>> = {
  table: { n: [2, 3] },
  round_table: { n: [1, 2] },
  counter: { n: [2, 3] },
  bar_counter: { n: [1, 2] },
  desk: { n: [2, 3] },
  chest: { n: [1, 1], chance: 0.8 },
  crate: { n: [1, 1], family: "store", stackVariant: "small" },
  barrel: { n: [1, 1], family: "store" },
  anvil: { n: [1, 1], family: "tools" },
  stall_counter: { n: [1, 2] },
};

/** How many small things a support takes (`rand(k)` is a draw in 0..k-1, so the count is seeded by the caller). */
export function surfaceCount(load: SurfaceLoad, rand: (k: number) => number): number {
  return load.n[0] + rand(load.n[1] - load.n[0] + 1);
}
