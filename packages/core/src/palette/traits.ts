/**
 * Shape traits of a palette piece, derived from the geometry the palette already holds (`geom.size`, `originAt`), so a
 * builder can ask for "a thin long piece about two tiles long" in whatever theme is in use instead of naming a role
 * (the pool query is palette/traitPools.ts; inside one role the same test is `traitFilter` in palette/filters.ts).
 *
 * - `MEASURES` is one table of the continuous measures a consumer constrains (tiles, from the collider size).
 * - `TRAITS` is one table of shape classes, each a test over the measures. A piece may have several (a 2x2x2 block is
 *   also a mass) or none. Adding a trait is one row.
 * - `borrowRisk` names the roles whose pieces are a poor borrow for their shape (doors, stairs, lights, GM-only
 *   markers): the pool leaves them out unless the query allows them.
 *
 * Only what the collider size can honestly tell. Roundness, hollowness (frames), colour, material, a front side, true
 * visual bounds and which pieces join seamlessly are not in the palette data; they need a palette field from the owner.
 * Measures are in the asset's own axes (before a variant's correction `rot`); x and z are horizontal, y is up.
 */
import type { PaletteVariant, RoleName } from "../contracts/compiler";
import type { FeatureType } from "../contracts/plan";
import { FEATURE_INFO } from "../gen/catalog";
import { own } from "../util/own";
import { roleFamily } from "./roles";

type Geom = Pick<PaletteVariant["geom"], "size" | "originAt">;

/** An axis of the asset, or none when no side is clearly the longest. */
export type PieceAxis = "x" | "y" | "z";

/** The measures of a piece (tiles), each derived from its collider size. */
export interface PieceMeasures {
  /** The longer horizontal side. */
  readonly length: number;
  /** The shorter horizontal side. */
  readonly width: number;
  /** The vertical side. */
  readonly height: number;
  /** The smallest side of the three. */
  readonly thickness: number;
  /** The middle side of the three. */
  readonly middle: number;
  /** The largest side of the three. */
  readonly extent: number;
  /** Ground area covered, x times z. */
  readonly footprint: number;
  /** x times y times z. */
  readonly volume: number;
  /** extent / thickness (1 for a cube; large for a rod or a sheet). */
  readonly slenderness: number;
  /** length / width (1 for a square footprint). */
  readonly spread: number;
  /** "tile" for a corner-origin piece (laid on the grid), "prop" for one placed by its centre. */
  readonly kind: "tile" | "prop";
  /** The local axis of the largest side, or null when the largest two are within 10% of each other. */
  readonly longAxis: PieceAxis | null;
  /** The horizontal axis of `length`, or null when x and z are within 10% of each other. */
  readonly runAxis: "x" | "z" | null;
}

/** The numeric measures a query may constrain. */
export type MeasureId = {
  [K in keyof PieceMeasures]: PieceMeasures[K] extends number ? K : never;
}[keyof PieceMeasures];

/** Floor for a side, so a degenerate collider (a 0.0001-wide sign) cannot divide by zero. */
const MIN_SIDE = 0.01;
/** Two sides within this ratio are "about equal" (no long axis). */
const SAME_SIDE = 1.1;

/** The measures of a piece from its geometry. */
export function measurePiece(geom: Geom): PieceMeasures {
  const x = Math.max(MIN_SIDE, geom.size.x);
  const y = Math.max(MIN_SIDE, geom.size.y);
  const z = Math.max(MIN_SIDE, geom.size.z);
  const sides: [PieceAxis, number][] = [
    ["x", x],
    ["y", y],
    ["z", z],
  ];
  sides.sort((a, b) => b[1] - a[1]);
  const [first, second, third] = sides as [[PieceAxis, number], [PieceAxis, number], [PieceAxis, number]];
  const length = Math.max(x, z);
  const width = Math.min(x, z);
  return {
    length,
    width,
    height: y,
    thickness: third[1],
    middle: second[1],
    extent: first[1],
    footprint: x * z,
    volume: x * y * z,
    slenderness: first[1] / third[1],
    spread: length / width,
    kind: geom.originAt === "minCorner" ? "tile" : "prop",
    longAxis: first[1] >= second[1] * SAME_SIDE ? first[0] : null,
    runAxis: length >= width * SAME_SIDE ? (x > z ? "x" : "z") : null,
  };
}

/** One shape class: what it is for, and its test over a piece's measures. */
interface TraitRow {
  readonly doc: string;
  readonly test: (m: PieceMeasures) => boolean;
}

/**
 * The shape vocabulary. Thresholds are ratios (tile pieces come in half-tile steps: a wall is 0.5 thick, a floor 0.5
 * tall), with a size floor so a small prop does not count as a beam or a panel.
 */
export const TRAITS = {
  beam: {
    doc: "thin and long, lying down (a plank, a log, a rail): the longest side is horizontal, at least 3x each other side",
    test: (m) => m.length >= 0.75 && m.length >= m.height && Math.max(m.width, m.height) * 3 <= m.length,
  },
  post: {
    doc: "standing upright (a post, a column, a pier): at least 0.75 tall, at least twice its longer horizontal side, and its foot less than 2:1 (a 1x0.5 foot is a wall panel)",
    test: (m) => m.height >= 0.75 && m.length * 2 <= m.height && m.spread < 2,
  },
  panel: {
    doc: "a sheet on edge (a wall piece, a fence, a sign board): thin in one horizontal axis, at least twice as long and as tall",
    test: (m) => Math.max(m.length, m.height) >= 0.75 && m.width * 2 <= Math.min(m.length, m.height),
  },
  slab: {
    doc: "a sheet lying flat (a floor tile, a roof flat, a rug): at most half as tall as its shorter horizontal side, which is at least 0.5",
    test: (m) => m.width >= 0.5 && m.height * 2 <= m.width,
  },
  block: {
    doc: "roughly cubic and at least 0.75 a side (a whole-cell block, a crate, a boulder): no side more than 1.5x another",
    test: (m) => m.thickness >= 0.75 && m.slenderness <= 1.5,
  },
  clutter: {
    doc: "small in every axis (a cup, a book, a pebble): no side over 0.6",
    test: (m) => m.extent <= 0.6,
  },
  mass: {
    doc: "large in two or more axes (a tree, a big rock, a 2x2x2 block): volume at least 4 and the middle side at least 1.5",
    test: (m) => m.volume >= 4 && m.middle >= 1.5,
  },
} as const satisfies Record<string, TraitRow>;

export type TraitId = keyof typeof TRAITS;
export const TRAIT_IDS = Object.keys(TRAITS) as TraitId[];

/** The traits of a piece, in table order. */
export function traitsOf(geom: Geom): TraitId[] {
  const m = measurePiece(geom);
  return TRAIT_IDS.filter((t) => TRAITS[t].test(m));
}

/** Whether a piece has the trait. */
export const hasTrait = (geom: Geom, trait: TraitId): boolean => TRAITS[trait].test(measurePiece(geom));

/** An inclusive range of a measure: [min, max]. */
export type MeasureRange = readonly [min: number, max: number];

/** The shape a consumer asks for: a trait, optionally narrowed by measures and kind. */
export interface TraitShape {
  readonly trait: TraitId;
  /** Inclusive ranges on measures ({ length: [1.5, 2.5], thickness: [0, 0.3] }). */
  readonly where?: Partial<Record<MeasureId, MeasureRange>>;
  readonly kind?: PieceMeasures["kind"];
}

/** Whether a piece has the shape. */
export function fitsShape(geom: Geom, shape: TraitShape): boolean {
  const m = measurePiece(geom);
  if (!TRAITS[shape.trait].test(m)) return false;
  if (shape.kind !== undefined && m.kind !== shape.kind) return false;
  for (const [id, range] of Object.entries(shape.where ?? {}) as [MeasureId, MeasureRange | undefined][]) {
    if (range !== undefined && (m[id] < range[0] || m[id] > range[1])) return false;
  }
  return true;
}

/** A memo key that follows from every field of the shape (measures in name order). */
export function shapeKey(shape: TraitShape): string {
  const where = Object.entries(shape.where ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, [lo, hi]]) => `${id}${lo}..${hi}`)
    .join(",");
  return `trait:${shape.trait}${shape.kind !== undefined ? `/${shape.kind}` : ""}${where !== "" ? `[${where}]` : ""}`;
}

// ── which roles lend their pieces ──

/**
 * Why a role's pieces are a poor borrow for their shape: they do something besides being a shape (open, climb, light,
 * mark for the GM), so a lattice of them would read wrong. `null`: borrowable.
 */
export type BorrowRisk = "opening" | "passage" | "light" | "gm_only" | "marker";

/** Role families whose every piece carries a risk. */
const FAMILY_RISK: Readonly<Record<string, BorrowRisk>> = {
  opening: "opening",
  gate: "opening",
  link: "passage",
  stairs: "passage",
  stairs_block: "passage",
  step: "passage",
  ramp: "passage",
  light: "light",
  wall_light: "light",
  glow: "light",
  magic_beacon: "light",
  marker: "marker",
  marking: "marker",
};

const FEATURE_FAMILY = "feature";
const STALL_LIGHT: RoleName = "stall.light";

/** The risk of borrowing a role's pieces (the feature catalog says which features are lights or GM-only). */
export function borrowRisk(role: RoleName): BorrowRisk | null {
  const family = roleFamily(role);
  const byFamily = own(FAMILY_RISK, family);
  if (byFamily !== undefined) return byFamily;
  if (role === STALL_LIGHT) return "light";
  if (family === FEATURE_FAMILY) {
    const info = own(FEATURE_INFO, role.slice(family.length + 1) as FeatureType);
    if (info?.light === true) return "light";
    if (info?.gmOnly === true) return "gm_only";
  }
  return null;
}
