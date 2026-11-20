/**
 * Markets and settlements (generator 3): rows of market stalls, goods standing on them, lines strung overhead and the
 * props a trade puts outside its door. Pure layout: the resolver (resolve/level.ts `stepMarket`) asks for placements
 * and commits the ones whose cells are free; the realizer turns the feature types (`stall`, `goods`, `overhead`,
 * `line_post`) into palette pieces. See docs/internal/handoff-settlement.md.
 */
import type { FeatureType, Side, StallKind, StallRow } from "../contracts/plan";
import { subSeed } from "../util/hash";
import { createPrng } from "../util/prng";

/** The palette variant of `feature.stall` each kind stands on (the kinds with goods stand on the bare table). */
export const STALL_BASE: Readonly<
  Record<StallKind, "fruit" | "vegetables" | "spices" | "magic" | "weapons" | "empty">
> = {
  fruit: "fruit",
  vegetables: "vegetables",
  spices: "spices",
  magic: "magic",
  weapons: "weapons",
  empty: "empty",
  bread: "empty",
  dairy: "empty",
  fish: "empty",
  potions: "empty",
  grain: "empty",
};

/** The goods set (palette variant of `feature.goods`) a bare-table kind puts on the table; none for the rest. */
export const STALL_GOODS: Readonly<Partial<Record<StallKind, string>>> = {
  empty: "produce",
  bread: "bread",
  dairy: "dairy",
  fish: "fish",
  potions: "potions",
  grain: "grain",
};

export const DEFAULT_STALL_GOODS: readonly StallKind[] = [
  "fruit",
  "vegetables",
  "bread",
  "dairy",
  "potions",
  "spices",
];

const TURN: Record<Side, number> = { S: 0, W: 90, N: 180, E: 270 };

export interface StallPlacement {
  at: [number, number];
  size: [number, number];
  rot: number;
  kind: StallKind;
}

/**
 * Lay a stall row out. `ok(x, y)` says a cell can take a stall. A stall is 2 cells along the row and 1 deep; gaps
 * between stalls are 0 to 3 cells (irregular). Two rows stand facing each other across the aisle when the rectangle
 * is deep enough, else one row along the side away from `facing`.
 */
export function layoutStalls(
  row: StallRow,
  ok: (x: number, y: number) => boolean,
  seed: number,
): StallPlacement[] {
  const rng = createPrng(subSeed(seed, `stalls~${row.id}`));
  const { x: ax, y: ay, w, h } = row.area;
  const horizontal = w >= h;
  const aisle = Math.max(1, Math.min(4, row.aisle ?? 2));
  const long = horizontal ? w : h;
  const deep = horizontal ? h : w;
  const kinds = row.goods && row.goods.length > 0 ? row.goods : DEFAULT_STALL_GOODS;
  const queue: StallKind[] = [];
  const nextKind = (): StallKind => {
    if (queue.length === 0) {
      const bag = [...kinds];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [bag[i], bag[j]] = [bag[j] as StallKind, bag[i] as StallKind];
      }
      queue.push(...bag);
    }
    return queue.shift() as StallKind;
  };
  // depth offsets of the lines (cells from the rectangle's near edge) and the side each faces
  const lines: Array<{ depth: number; faces: Side }> = [];
  const f0: Side = row.facing ?? (horizontal ? "S" : "E");
  if (deep >= aisle + 2) {
    const pad = Math.floor((deep - aisle - 2) / 2);
    lines.push(
      { depth: pad, faces: horizontal ? "S" : "E" },
      { depth: pad + 1 + aisle, faces: horizontal ? "N" : "W" },
    );
  } else if (horizontal) {
    lines.push({ depth: f0 === "N" ? deep - 1 : 0, faces: f0 === "N" ? "N" : "S" });
  } else {
    lines.push({ depth: f0 === "W" ? deep - 1 : 0, faces: f0 === "W" ? "W" : "E" });
  }
  const out: StallPlacement[] = [];
  const cap = row.count ?? 60;
  const GAPS = [0, 0, 0, 1, 1, 2, 3];
  for (const ln of lines) {
    let p = rng.int(2);
    while (p + 2 <= long && out.length < cap) {
      const at: [number, number] = horizontal ? [ax + p, ay + ln.depth] : [ax + ln.depth, ay + p];
      const rot = TURN[ln.faces];
      const size: [number, number] = horizontal ? [2, 1] : [1, 2];
      const free = horizontal
        ? ok(at[0], at[1]) && ok(at[0] + 1, at[1])
        : ok(at[0], at[1]) && ok(at[0], at[1] + 1);
      if (free) {
        out.push({ at, size, rot, kind: nextKind() });
        p += 2 + (GAPS[rng.int(GAPS.length)] as number);
      } else p += 1;
    }
  }
  return out;
}

/** One piece of an overhead line before the resolver commits it. */
export interface LinePiece {
  /** Anchor cell of the footprint, size, and sub-cell shift of the piece centre (tiles). */
  at: [number, number];
  size: [number, number];
  offset: [number, number];
  rotFine: number;
  variant: "rope" | "lights" | "lantern" | "flag";
}

export interface LineSpan {
  /** True along x (a row of cells), false along y. */
  alongX: boolean;
  /** Cell row (alongX) or column of the line. */
  lane: number;
  /** Start and end of the rope along its axis, in tiles (cell edges: cell c spans c..c+1). */
  start: number;
  end: number;
}

/**
 * Pieces along a span: rope (or lights) pieces 2 long end to end (shortened evenly so the ends meet the anchors) and,
 * for lanterns and flags, one hung piece about every `spacing` cells.
 */
export function layoutLine(
  span: LineSpan,
  kind: "lanterns" | "lights" | "flags",
  spacing: number,
): LinePiece[] {
  const L = span.end - span.start;
  if (L < 1) return [];
  const out: LinePiece[] = [];
  const rotFine = span.alongX ? 0 : 90;
  const cell = (along: number): [number, number] =>
    span.alongX ? [along, span.lane] : [span.lane, along];
  const body = kind === "lights" ? "lights" : "rope";
  const n = Math.max(1, Math.ceil(L / 2 - 1e-6));
  for (let k = 0; k < n; k++) {
    const c = span.start + ((k + 0.5) * L) / n;
    const a = Math.round(c - 1);
    out.push({
      at: cell(a),
      size: span.alongX ? [2, 1] : [1, 2],
      offset: span.alongX ? [c - (a + 1), 0] : [0, c - (a + 1)],
      rotFine,
      variant: body,
    });
  }
  if (kind !== "lights") {
    // hung pieces keep 0.6 clear of the anchors (a flag is a tile wide)
    const m = Math.max(1, Math.round(L / spacing));
    const inner = Math.max(0.1, L - 1.2);
    for (let j = 0; j < m; j++) {
      const c = span.start + 0.6 + ((j + 0.5) * inner) / m;
      const a = Math.floor(c);
      out.push({
        at: cell(a),
        size: [1, 1],
        offset: span.alongX ? [c - (a + 0.5), 0] : [0, c - (a + 0.5)],
        rotFine,
        variant: kind === "flags" ? "flag" : "lantern",
      });
    }
  }
  return out;
}

export type Trade = "baker" | "smith" | "shop" | "tavern" | "apothecary" | "cobbler" | "butcher" | "stable";

/** What a trade is called by `use`: the open word a plan gives, mapped to the trade the style and props know. */
export const TRADE_OF: Readonly<Record<string, Trade>> = {
  baker: "baker",
  bakery: "baker",
  smith: "smith",
  smithy: "smith",
  blacksmith: "smith",
  forge: "smith",
  armourer: "smith",
  shop: "shop",
  store: "shop",
  general: "shop",
  grocer: "shop",
  merchant: "shop",
  tavern: "tavern",
  inn: "tavern",
  pub: "tavern",
  alehouse: "tavern",
  apothecary: "apothecary",
  herbalist: "apothecary",
  alchemist: "apothecary",
  cobbler: "cobbler",
  tailor: "cobbler",
  weaver: "cobbler",
  tanner: "cobbler",
  butcher: "butcher",
  fishmonger: "butcher",
  stable: "stable",
};

/** Props outside the door by trade (feature types the palettes have), with weights. */
export const TRADE_PROPS: Readonly<Record<Trade, ReadonlyArray<readonly [FeatureType, number]>>> = {
  baker: [["sack", 3], ["barrel", 1], ["crate", 1]],
  smith: [["anvil", 3], ["barrel", 1], ["weapon_rack", 1]],
  shop: [["crate", 3], ["barrel", 2], ["sack", 2]],
  tavern: [["barrel", 3], ["bench", 2], ["stool", 1]],
  apothecary: [["barrel", 2], ["crate", 1], ["flowers", 2]],
  cobbler: [["bench", 2], ["crate", 2], ["stool", 1]],
  butcher: [["barrel", 2], ["crate", 2], ["cart", 1]],
  stable: [["barrel", 1], ["crate", 1], ["cart", 1]],
};

/** The trade a `use` word means (case and spaces ignored), or undefined. */
export function tradeOf(use: string | undefined): Trade | undefined {
  if (!use) return undefined;
  return TRADE_OF[use.trim().toLowerCase().replace(/[^a-z]/g, "")];
}
