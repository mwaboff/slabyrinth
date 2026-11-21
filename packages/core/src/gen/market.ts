/**
 * Markets and settlements (generator 3): rows of market stalls, goods standing on them, lines strung overhead and the
 * props a trade puts outside its door. Pure layout: the resolver (resolve/level/market.ts `stepMarket`) asks for placements
 * and commits the ones whose cells are free; the realizer turns the feature types (`stall`, `goods`, `overhead`,
 * `line_post`) into palette pieces. See docs/internal/handoff-settlement.md.
 */
import type { FeatureType, Side, StallKind, StallRow } from "../contracts/plan";
import type { StallBuild, StallForm } from "../contracts/resolved";
import { subSeed } from "../util/hash";
import { createPrng } from "../util/prng";
import { FACE_ROT } from "./gridGeometry";
import type { SmallFamily } from "./surfaces";

/** The palette variants of `feature.stall`: the real stall pieces, and the bare table the other kinds stand on. */
export type StallPiece = "fruit" | "vegetables" | "spices" | "magic" | "weapons" | "empty";

/**
 * How a stall's front row is laid when it is covered (generator 4): `tray` = the stall piece is a 1x1 tile with the goods
 * built in, one per cell; `wide` = a two-cell stall prop; `counter` = plain counters with small things on them.
 */
export type StallFront = "tray" | "wide" | "counter";

/** Everything the generator and the realizer know about one kind of stall: ONE table, read by both generators and stages. */
export interface StallKindInfo {
  /** The `feature.stall` variant it stands on (the kinds with goods stand on the bare table, `empty`). */
  piece: StallPiece;
  /** How a covered stall lays its front row. */
  front: StallFront;
  /** Small things (gen/surfaces.ts family) on the plain counters of a covered stall; none = bare counters. */
  goods?: SmallFamily;
  /** Small things on the generator-3 bare table of this kind (the kinds with a real stall piece have goods built in). */
  tableGoods?: SmallFamily;
  /** Loose stock that may stand beside a covered stall (generator 4). */
  stock: readonly FeatureType[];
}

const GENERAL_STOCK: readonly FeatureType[] = ["crate", "barrel", "sack"];

export const STALL_KIND_INFO: Readonly<Record<StallKind, StallKindInfo>> = {
  fruit: { piece: "fruit", front: "tray", goods: "produce", stock: GENERAL_STOCK },
  vegetables: { piece: "vegetables", front: "tray", goods: "produce", stock: GENERAL_STOCK },
  spices: { piece: "spices", front: "tray", goods: "produce", stock: GENERAL_STOCK },
  magic: { piece: "magic", front: "wide", goods: "potions", stock: GENERAL_STOCK },
  weapons: { piece: "weapons", front: "wide", stock: GENERAL_STOCK },
  empty: { piece: "empty", front: "counter", tableGoods: "produce", stock: GENERAL_STOCK },
  bread: { piece: "empty", front: "counter", goods: "bread", tableGoods: "bread", stock: GENERAL_STOCK },
  dairy: { piece: "empty", front: "counter", goods: "dairy", tableGoods: "dairy", stock: GENERAL_STOCK },
  fish: { piece: "empty", front: "counter", goods: "fish", tableGoods: "fish", stock: GENERAL_STOCK },
  potions: {
    piece: "empty",
    front: "counter",
    goods: "potions",
    tableGoods: "potions",
    stock: GENERAL_STOCK,
  },
  grain: { piece: "empty", front: "counter", goods: "grain", tableGoods: "grain", stock: GENERAL_STOCK },
};

/** The `feature.stall` variant a plan's stall `variant` stands on; a name that is no kind is left as it is (the realizer then notes it). */
export function stallPieceOf(variant: string): string {
  return Object.hasOwn(STALL_KIND_INFO, variant) ? STALL_KIND_INFO[variant as StallKind].piece : variant;
}

/** The table row of a stall's `variant` (a name the plan gave; anything unknown is the bare table, like `empty`). */
export function stallKindInfo(variant: string | undefined): StallKindInfo {
  return variant !== undefined && Object.hasOwn(STALL_KIND_INFO, variant)
    ? STALL_KIND_INFO[variant as StallKind]
    : STALL_KIND_INFO.empty;
}

export const DEFAULT_STALL_GOODS: readonly StallKind[] = [
  "fruit",
  "vegetables",
  "bread",
  "dairy",
  "potions",
  "spices",
];

/** A stall or line piece turns to face the side named by its `faces`. */
const TURN = FACE_ROT;

export interface StallPlacement {
  at: [number, number];
  size: [number, number];
  rot: number;
  kind: StallKind;
  /** Generator 4: how a covered stall is built; absent for an open table (the generator-3 stall). */
  build?: StallBuild;
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

/** Plan cell of a covered stall's local cell: `lx` along the front, `ly` deep (0 = the front row, the lane side). */
export function stallCell(
  front: Side,
  at: readonly [number, number],
  size: readonly [number, number],
  lx: number,
  ly: number,
): [number, number] {
  const [x0, y0] = at;
  const [pw, ph] = size;
  if (front === "S") return [x0 + lx, y0 + ph - 1 - ly];
  if (front === "N") return [x0 + lx, y0 + ly];
  if (front === "E") return [x0 + pw - 1 - ly, y0 + lx];
  return [x0 + ly, y0 + lx];
}

/** The sizes of a covered stall (w along the front, d deep) and how often each is drawn. */
const STALL_SIZES: ReadonlyArray<{ name: string; w: number; d: number; weight: number }> = [
  { name: "small", w: 2, d: 3, weight: 3 },
  { name: "medium", w: 3, d: 3, weight: 4 },
  { name: "large", w: 4, d: 4, weight: 2 },
  { name: "long", w: 4, d: 3, weight: 1.5 },
  { name: "mini", w: 2, d: 2, weight: 1 },
  { name: "wide", w: 3, d: 2, weight: 1 },
];

/** How one covered stall is built (seeded): canopy form, walk-in gap, counters, seat, light. Interior = free of counters. */
function designStall(
  s: { name: string; w: number; d: number },
  kind: StallKind,
  front: Side,
  forms: readonly StallForm[],
  rng: ReturnType<typeof createPrng>,
): StallBuild {
  const form: StallForm = forms.length === 1 ? (forms[0] as StallForm) : rng.next() < 0.6 ? "gable" : "flat";
  let gap = -1;
  if (s.w >= 3 && (kind === "empty" ? rng.next() < 0.75 : rng.next() < 0.35)) gap = 1 + rng.int(s.w - 2);
  else if (s.w === 2 && kind === "empty" && rng.next() < 0.5) gap = rng.int(2);
  const sides = s.w >= 3 && s.d >= 3 && rng.next() < 0.85;
  const back = s.d >= 3 && rng.next() < 0.7;
  const lo = sides ? 1 : 0;
  const hi = s.w - 1 - (sides ? 1 : 0);
  const lastRow = s.d - 1 - (back ? 1 : 0);
  let seat: [number, number] | undefined;
  if (lastRow >= 1 && hi >= lo && rng.next() < 0.75) {
    const lx = lo + rng.int(hi - lo + 1);
    // not straight behind the walk-in gap
    if (!(lx === gap && lastRow === 1)) seat = [lx, lastRow];
  }
  return {
    form,
    front,
    w: s.w,
    d: s.d,
    gap,
    sides,
    back,
    ...(seat ? { seat } : {}),
    light: rng.next() < 0.7,
    size: s.name,
  };
}

/**
 * Generator 4: lay covered stalls out in a row's rectangle. Stalls come in several sizes (small 2x3, medium 3x3, large
 * 4x4, long 4x3, mini 2x2, wide 3x2), face the aisle (or the one open side), sit loosely: gaps of 0 to 2 cells, a
 * setback of one cell now and then, an end stall now and then turned to face along the row, and a few open tables
 * among them. `forms` are the canopy forms the palette has; with none the caller uses `layoutStalls` (the table
 * stall of generator 3). Pure and seeded.
 */
export function layoutStalls4(
  row: StallRow,
  ok: (x: number, y: number) => boolean,
  seed: number,
  forms: readonly StallForm[],
): StallPlacement[] {
  const rng = createPrng(subSeed(seed, `stalls4~${row.id}`));
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
  const f0: Side = row.facing ?? (horizontal ? "S" : "E");
  // bands along the long side: where each starts (cells from the rectangle's near edge), how deep, which side it faces
  const bands: Array<{ depth0: number; bd: number; faces: Side }> = [];
  if (deep >= aisle + 4) {
    const bd0 = Math.floor((deep - aisle) / 2);
    bands.push(
      { depth0: 0, bd: bd0, faces: horizontal ? "S" : "E" },
      { depth0: bd0 + aisle, bd: deep - aisle - bd0, faces: horizontal ? "N" : "W" },
    );
  } else {
    const bd = Math.min(deep, 4);
    const towardEnd = horizontal ? f0 === "S" : f0 === "E";
    bands.push({
      depth0: towardEnd ? 0 : deep - bd,
      bd,
      faces: horizontal ? (f0 === "N" ? "N" : "S") : f0 === "W" ? "W" : "E",
    });
  }
  const out: StallPlacement[] = [];
  const cap = row.count ?? 60;
  const GAPS = [0, 0, 1, 1, 1, 2];
  const cellsFree = (at: [number, number], size: [number, number]): boolean => {
    for (let y = at[1]; y < at[1] + size[1]; y++)
      for (let x = at[0]; x < at[0] + size[0]; x++) if (!ok(x, y)) return false;
    return true;
  };
  for (const band of bands) {
    const toEnd = band.faces === "S" || band.faces === "E";
    let p = rng.int(2);
    let prev = "";
    let first = true;
    while (p < long && out.length < cap) {
      const remaining = long - p;
      // an open table now and then: the generator-3 stall, 2 along the row and 1 deep, at the front of the band
      const wantTable = !first && rng.next() < 0.12 && remaining >= 2;
      const front = toEnd ? band.depth0 + band.bd - 1 : band.depth0;
      const place = (
        along0: number,
        alongLen: number,
        depLen: number,
        depthFront: number,
        faces: Side,
      ): [number, number] | null => {
        const dmin =
          toEnd || faces === "W" || faces === "N" ? depthFront - (toEnd ? depLen - 1 : 0) : depthFront;
        const at: [number, number] = horizontal ? [ax + along0, ay + dmin] : [ax + dmin, ay + along0];
        const size: [number, number] = horizontal ? [alongLen, depLen] : [depLen, alongLen];
        return cellsFree(at, size) ? at : null;
      };
      if (wantTable) {
        const at = place(p, 2, 1, front, band.faces);
        if (at) {
          out.push({ at, size: horizontal ? [2, 1] : [1, 2], rot: TURN[band.faces], kind: nextKind() });
          p += 2 + (GAPS[rng.int(GAPS.length)] as number);
          prev = "table";
          first = false;
          continue;
        }
      }
      const cands = STALL_SIZES.filter((s) => s.d <= band.bd && s.w <= remaining);
      if (cands.length === 0) break;
      const weights = cands.map((s) => s.weight * (s.name === prev ? 0.25 : 1));
      let r = rng.next() * weights.reduce((a, b) => a + b, 0);
      let s = cands[cands.length - 1] as (typeof cands)[number];
      for (let i = 0; i < cands.length; i++) {
        r -= weights[i] as number;
        if (r < 0) {
          s = cands[i] as (typeof cands)[number];
          break;
        }
      }
      // the first stall of a band is sometimes turned to face along the row, toward the row's start
      if (first && s.w <= band.bd && s.d <= remaining && rng.next() < 0.25) {
        const faces: Side = horizontal ? "W" : "N";
        // a turned stall's footprint is d along the row and w deep; its front is the row's start side
        const dmin = toEnd ? band.depth0 + band.bd - s.w : band.depth0;
        const at: [number, number] = horizontal ? [ax + p, ay + dmin] : [ax + dmin, ay + p];
        const size: [number, number] = horizontal ? [s.d, s.w] : [s.w, s.d];
        if (cellsFree(at, size)) {
          const kind = nextKind();
          out.push({ at, size, rot: TURN[faces], kind, build: designStall(s, kind, faces, forms, rng) });
          p += s.d + (GAPS[rng.int(GAPS.length)] as number);
          prev = s.name;
          first = false;
          continue;
        }
      }
      const slack = band.bd - s.d;
      const setback = slack > 0 && rng.next() < 0.45 ? 1 : 0;
      const depthFront = toEnd ? front - setback : front + setback;
      const dmin = toEnd ? depthFront - s.d + 1 : depthFront;
      const at: [number, number] = horizontal ? [ax + p, ay + dmin] : [ax + dmin, ay + p];
      const size: [number, number] = horizontal ? [s.w, s.d] : [s.d, s.w];
      if (cellsFree(at, size)) {
        const kind = nextKind();
        out.push({
          at,
          size,
          rot: TURN[band.faces],
          kind,
          build: designStall(s, kind, band.faces, forms, rng),
        });
        p += s.w + (GAPS[rng.int(GAPS.length)] as number);
        prev = s.name;
        first = false;
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
  const cell = (along: number): [number, number] => (span.alongX ? [along, span.lane] : [span.lane, along]);
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
  baker: [
    ["sack", 3],
    ["barrel", 1],
    ["crate", 1],
  ],
  smith: [
    ["anvil", 3],
    ["barrel", 1],
    ["weapon_rack", 1],
  ],
  shop: [
    ["crate", 3],
    ["barrel", 2],
    ["sack", 2],
  ],
  tavern: [
    ["barrel", 3],
    ["bench", 2],
    ["stool", 1],
  ],
  apothecary: [
    ["barrel", 2],
    ["crate", 1],
    ["flowers", 2],
  ],
  cobbler: [
    ["bench", 2],
    ["crate", 2],
    ["stool", 1],
  ],
  butcher: [
    ["barrel", 2],
    ["crate", 2],
    ["cart", 1],
  ],
  stable: [
    ["barrel", 1],
    ["crate", 1],
    ["cart", 1],
  ],
};

/** The trade a `use` word means (case and spaces ignored), or undefined. */
export function tradeOf(use: string | undefined): Trade | undefined {
  if (!use) return undefined;
  return TRADE_OF[
    use
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, "")
  ];
}
