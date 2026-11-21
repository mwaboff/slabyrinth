/**
 * Builds one covered market stall from palette parts (generator 4; the resolver chose its shape, gen/market.ts
 * `layoutStalls4`, and left it on the `stall` feature as `ResolvedFeature.stall`).
 *
 * From the bottom up, in the stall's own frame (`lx` along the front, `ly` deep, 0 = the front row, the lane side):
 *   stall.base      a low plank platform under every cell of the footprint
 *   stall.counter   skirted counters on the platform: across the front (a walk-in gap where the build says), down both
 *                   sides and across the back; the front row of a fruit, vegetable or spice stall is its goods tray
 *                   (feature.stall tiles), magic and weapon stalls take the two-cell stall prop
 *   small things   baskets, loaves and jugs standing on the plain counters, by kind of goods (gen/surfaces.ts: one table
 *                   of families and counts for stalls and rooms alike; an empty stall has none)
 *   stall.post      a post at each corner of the footprint (and a middle post along a 4-wide front and back)
 *   stall.canopy    cloth on top of the posts: a gable (two sloped halves meeting at a ridge, a beam tied along it) or a
 *                   flat cloth, whichever form the build chose
 *   stall.light     a lantern under the canopy at the front;  stall.seat  a stool inside
 * What each kind of stall is (its piece, how its front row is laid, its goods) is the table in gen/market.ts
 * (`STALL_KIND_INFO`); whether the palette can build the parts is palette/stallParts.ts, the same question the resolver
 * asked when it chose this footprint, so a covered stall the resolver laid out is a covered stall here. If a caller
 * resolved against other palettes than it compiles with and a part is missing after all, the footprint still gets what
 * the kind sells: the front row as table pieces (or trays) at ground level with its goods on top, and verify says the
 * stall is uncovered (verify_stall_uncovered). Everything is built from the roles above, so a palette changes the stall
 * by changing the roles.
 */
import type { PaletteFacing, Placement, PlacementRole } from "../contracts/compiler";
import type { Side } from "../contracts/plan";
import type { ResolvedFeature } from "../contracts/resolved";
import { stallCell, stallKindInfo } from "../gen/market";
import { SMALL_THINGS_ROLES, SURFACE_LOAD, surfaceCount, type SmallFamily, type SurfaceLoad } from "../gen/surfaces";
import type { ResolvedVariant, RoleResolution, VariantFilter } from "../palette/resolve";
import { ONE_CELL_TILE, stallParts, type RoleProbe } from "../palette/stallParts";
import { subSeed } from "../util/hash";
import { createPrng } from "../util/prng";
import type { WorldFrame } from "./geometry";
import { h32, rotateXZ } from "./geometry";

export interface StallRealizeCtx {
  frame: WorldFrame;
  seed: number | string;
  lookup: (theme: string, roles: string[], filter?: VariantFilter, quiet?: boolean) => RoleResolution | null;
  pick: (vs: ResolvedVariant[], key: string) => ResolvedVariant | undefined;
  facingOf: (v: ResolvedVariant, rolePrefix: string, role: string) => PaletteFacing;
  emit: (
    v: ResolvedVariant,
    role: PlacementRole,
    x: number,
    y: number,
    z: number,
    rotDeg: number,
    source: Placement["source"],
    layer?: string,
  ) => void;
  info: (code: string, message: string, role?: string) => void;
}

const OPP: Record<Side, Side> = { N: "S", S: "N", E: "W", W: "E" };
const oneCell: VariantFilter = ONE_CELL_TILE;
const quarter = (deg: number): number => ((Math.round(deg / 90) % 4) + 4) % 4 * 90;

/**
 * Builds the stall on its footprint. False only for a feature that is not a covered stall (nothing placed). A covered
 * stall whose palette lacks a part is built as the kind's table-and-goods stall (see the header), never dropped.
 */
export function realizeStall(ctx: StallRealizeCtx, f: ResolvedFeature): boolean {
  const b = f.stall;
  if (!b) return false;
  const theme = f.theme;
  const find = (roles: readonly string[], filter?: VariantFilter): RoleResolution | null => ctx.lookup(theme, [...roles], filter, true);
  const probe: RoleProbe = (roles, filter) => find(roles, filter);
  const built = stallParts(probe, b.form);
  const covered = "base" in built;
  if (!covered) {
    ctx.info(
      "asset_substituted",
      `stall ${f.id}: the theme has no ${built.missing} piece for a covered stall; its table stands on the footprint instead`,
    );
  }
  const info = stallKindInfo(f.variant);
  const fr = ctx.frame;
  const rng = createPrng(subSeed(h32(`${ctx.seed}:stall:${f.id}`), "parts"));
  const src: Placement["source"] = { cell: [f.at[0], f.at[1]], elementId: f.id };
  const y0 = f.baseHeight;
  const cell = (lx: number, ly: number): [number, number] => stallCell(b.front, f.at, f.size, lx, ly);
  const [X0, Y0] = f.at;
  const X1 = X0 + f.size[0];
  const Y1 = Y0 + f.size[1];
  /** Plan point of a float position in the stall's frame (lx along the front, ly from the front edge inward). */
  const point = (lx: number, ly: number): [number, number] =>
    b.front === "S" ? [X0 + lx, Y1 - ly] : b.front === "N" ? [X0 + lx, Y0 + ly] : b.front === "E" ? [X1 - ly, Y0 + lx] : [X0 + ly, Y0 + lx];
  /** Plan rect of a block of local cells. */
  const rectOf = (lx: number, ly: number, lw: number, ld: number): { x: number; y: number; w: number; h: number } => {
    const a = cell(lx, ly);
    const c = cell(lx + lw - 1, ly + ld - 1);
    return { x: Math.min(a[0], c[0]), y: Math.min(a[1], c[1]), w: Math.abs(a[0] - c[0]) + 1, h: Math.abs(a[1] - c[1]) + 1 };
  };
  const sideOfStep = (dx: number, dy: number): Side => (dx > 0 ? "E" : dx < 0 ? "W" : dy > 0 ? "S" : "N");
  /** Plan side that local side `lx` low/high faces outward (0 = the low end of the front row, 1 = the high end). */
  const lateral = (high: boolean): Side => {
    const a = cell(high ? b.w - 1 : 0, 0);
    const c = cell(high ? b.w - 2 : 1, 0);
    return sideOfStep(a[0] - c[0], a[1] - c[1]);
  };
  const turn = (side: Side, v: ResolvedVariant, role: string): number => {
    const fct = ctx.facingOf(v, "feature", role);
    return fr.stepsToFace(fct.front ?? "N", fr.worldSide(side)) * 15 + v.rot;
  };
  const tile = (v: ResolvedVariant, r: { x: number; y: number; w: number; h: number }, y: number, deg: number): void => {
    const m = fr.rectMin(r.x, r.y, r.w, r.h);
    ctx.emit(v, "feature", m.x, y, m.z, quarter(deg), src);
  };
  const prop = (v: ResolvedVariant, px: number, py: number, y: number, deg: number): void => {
    const c = fr.point(px, py);
    const off = rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * fr.o.rotSense);
    ctx.emit(v, "feature", c.x - off.x, y, c.z - off.z, deg, src);
  };
  const choose = (res: RoleResolution, key: string, filter?: (v: ResolvedVariant) => boolean): ResolvedVariant | undefined =>
    ctx.pick(filter ? res.variants.filter(filter) : res.variants, `${f.id}:${key}`);

  // small things from the shared table (gen/surfaces.ts), by the kind's family; none for a bare or built-in-goods kind
  const thingsOf = (family: SmallFamily | undefined): RoleResolution | null =>
    family ? find(SMALL_THINGS_ROLES, { key: `goods:${family}`, test: (v) => v.variant === family }) : null;
  const goods = thingsOf(info.goods);
  /** The small things of one support: a seeded count from SURFACE_LOAD, spread over the cell [cx, cy], on top at `topY`. */
  const smallThings = (goods: RoleResolution | null, cx: number, cy: number, topY: number, lx: number, ly: number): void => {
    if (!goods) return;
    const n = surfaceCount(SURFACE_LOAD.stall_counter as SurfaceLoad, (k) => rng.int(k));
    for (let k = 0; k < n; k++) {
      const g = choose(goods, `goods:${lx}:${ly}:${k}`);
      if (g) prop(g, cx + 0.5 + (rng.next() - 0.5) * 0.4, cy + 0.5 + (rng.next() - 0.5) * 0.4, topY, rng.int(24) * 15);
    }
  };
  const frontRow: number[] = [];
  for (let lx = 0; lx < b.w; lx++) if (lx !== b.gap) frontRow.push(lx);

  // The palette lacks a covered-stall part (a caller resolved against other palettes): the kind's own stall on the
  // footprint. The front row as the kind's piece at ground level (tiles one per cell, a two-cell piece per pair of
  // cells), the goods on its top. verify_stall_uncovered tells the author.
  if (!("base" in built)) {
    const piece = find(["feature.stall"], { key: `stall:${info.piece}`, test: (v) => v.variant === info.piece });
    if (!piece) return false;
    // the kinds with a real stall piece have their goods built in; a bare table gets its goods on top
    const onTable = thingsOf(info.tableGoods);
    const tiles = piece.variants.filter((v) => oneCell.test(v));
    const runs = tiles.length > 0 ? frontRow.map((lx) => [lx]) : [];
    if (tiles.length === 0)
      for (let i = 0; i < frontRow.length; ) {
        const lx = frontRow[i] as number;
        if (frontRow[i + 1] === lx + 1) {
          runs.push([lx, lx + 1]);
          i += 2;
        } else i += 1;
      }
    for (const run of runs) {
      const lx = run[0] as number;
      const v = choose(piece, `table:${lx}`, tiles.length > 0 ? (q) => oneCell.test(q) : (q) => !oneCell.test(q));
      if (!v) continue;
      if (run.length === 1) {
        const [cx, cy] = cell(lx, 0);
        tile(v, { x: cx, y: cy, w: 1, h: 1 }, y0, turn(b.front, v, "feature.stall"));
        smallThings(onTable, cx, cy, y0 + v.geom.size.y, lx, 0);
      } else {
        const [px, py] = point(lx + 1, 0.5);
        prop(v, px, py, y0, turn(b.front, v, "feature.stall"));
        for (const l of run) {
          const [cx, cy] = cell(l, 0);
          smallThings(onTable, cx, cy, y0 + v.geom.size.y, l, 0);
        }
      }
    }
    return true;
  }
  const { base: baseRes, counter: counterRes, post: postRes, canopy: canopyRes } = built;

  // 1. base
  const baseThick = baseRes.variants[0]?.geom.size.y ?? 0.5;
  for (let ly = 0; ly < b.d; ly++)
    for (let lx = 0; lx < b.w; lx++) {
      const v = choose(baseRes, `base:${lx}:${ly}`);
      const [cx, cy] = cell(lx, ly);
      if (v) tile(v, { x: cx, y: cy, w: 1, h: 1 }, y0, 0);
    }
  const top0 = y0 + baseThick;

  // 2. counters and goods
  const counterH = counterRes.variants[0]?.geom.size.y ?? 0.5;
  const trays = info.front === "tray" ? find(["feature.stall"], { key: `tray:${info.piece}`, test: (v) => v.variant === info.piece && oneCell.test(v) }) : null;
  const wide = info.front === "wide" ? find(["feature.stall"], { key: `wide:${info.piece}`, test: (v) => v.variant === info.piece && v.geom.originAt !== "minCorner" }) : null;
  const plain: Array<[number, number, Side]> = [];
  const frontCells: number[] = [];
  for (let lx = 0; lx < b.w; lx++) if (lx !== b.gap) frontCells.push(lx);
  // a two-cell stall prop (magic, weapons) takes the first free neighbouring pair of the front row
  const pair = wide ? frontCells.find((lx) => frontCells.includes(lx + 1)) : undefined;
  if (wide && pair !== undefined) {
    const v = choose(wide, "wide");
    if (v) {
      const [px, py] = point(pair + 1, 0.5);
      prop(v, px, py, top0, turn(b.front, v, "feature.stall"));
    }
  }
  for (const lx of frontCells) {
    if (pair !== undefined && (lx === pair || lx === pair + 1)) continue;
    if (trays) {
      const v = choose(trays, `tray:${lx}`);
      const [cx, cy] = cell(lx, 0);
      if (v) tile(v, { x: cx, y: cy, w: 1, h: 1 }, top0, turn(b.front, v, "feature.stall"));
    } else plain.push([lx, 0, b.front]);
  }
  if (b.sides)
    for (let ly = 1; ly < b.d - (b.back ? 1 : 0); ly++) {
      plain.push([0, ly, lateral(false)]);
      plain.push([b.w - 1, ly, lateral(true)]);
    }
  if (b.back) for (let lx = 0; lx < b.w; lx++) plain.push([lx, b.d - 1, OPP[b.front]]);
  for (const [lx, ly, face] of plain) {
    const v = choose(counterRes, `counter:${lx}:${ly}`);
    const [cx, cy] = cell(lx, ly);
    if (v) tile(v, { x: cx, y: cy, w: 1, h: 1 }, top0, turn(face, v, "stall.counter"));
    smallThings(goods, cx, cy, top0 + (v?.geom.size.y ?? counterH), lx, ly);
  }

  // 3. posts at the corners (and the middle of a wide front and back), standing on the platform
  const post = postRes.variants[0]?.geom;
  const postH = post?.size.y ?? 2;
  const ps = post?.size.x ?? 0.5;
  const postAt: Array<[number, number]> = [
    [X0, Y0],
    [X1 - ps, Y0],
    [X0, Y1 - ps],
    [X1 - ps, Y1 - ps],
  ];
  if (b.w >= 4) {
    const mid = b.w / 2 - ps / 2;
    for (const ly of [0, b.d - ps]) {
      const [px, py] = point(mid + ps / 2, ly + ps / 2);
      postAt.push([px - ps / 2, py - ps / 2]);
    }
  }
  postAt.forEach(([px, py], i) => {
    const v = choose(postRes, `post:${i}`);
    if (v) tile(v, { x: px, y: py, w: ps, h: ps }, top0, 0);
  });
  const yc = top0 + postH;

  // 4. canopy on the post tops
  const canopyAt = (v: ResolvedVariant, r: { x: number; y: number; w: number; h: number }, deg: number): void => {
    tile(v, r, yc, deg);
  };
  let ridgeY = yc;
  if (b.form === "flat") {
    const used = new Set<string>();
    const free = (lx: number, ly: number): boolean => lx < b.w && ly < b.d && !used.has(`${lx},${ly}`);
    const fits = (lx: number, ly: number, lw: number, ld: number): { v: ResolvedVariant; deg: number } | null => {
      const r = rectOf(lx, ly, lw, ld);
      for (const v of canopyRes.variants) {
        if (v.weight <= 0) continue;
        if (v.footprint[0] === r.w && v.footprint[1] === r.h) return { v, deg: 0 };
        if (v.footprint[1] === r.w && v.footprint[0] === r.h) return { v, deg: 90 };
      }
      return null;
    };
    for (let ly = 0; ly < b.d; ly++)
      for (let lx = 0; lx < b.w; lx++) {
        if (used.has(`${lx},${ly}`)) continue;
        const tries: Array<[number, number]> = [
          [2, 2],
          [2, 1],
          [1, 2],
          [1, 1],
        ];
        for (const [lw, ld] of tries) {
          let all = true;
          for (let j = 0; j < ld; j++) for (let i = 0; i < lw; i++) if (!free(lx + i, ly + j)) all = false;
          if (!all) continue;
          const r = rectOf(lx, ly, lw, ld);
          const pool = canopyRes.variants.filter((v) => v.weight > 0 && ((v.footprint[0] === r.w && v.footprint[1] === r.h) || (v.footprint[1] === r.w && v.footprint[0] === r.h)));
          const pickV = ctx.pick(pool, `${f.id}:canopy:${lx}:${ly}`);
          const fit = pickV ? { v: pickV, deg: pickV.footprint[0] === r.w && pickV.footprint[1] === r.h ? 0 : 90 } : fits(lx, ly, lw, ld);
          if (!fit) continue;
          canopyAt(fit.v, r, fit.deg);
          for (let j = 0; j < ld; j++) for (let i = 0; i < lw; i++) used.add(`${lx + i},${ly + j}`);
          ridgeY = Math.max(ridgeY, yc + fit.v.geom.size.y);
          break;
        }
      }
  } else {
    // two halves sloping down to the front and the back, meeting at the ridge
    const df = Math.floor(b.d / 2);
    const halves: Array<{ r0: number; n: number; low: Side }> = [
      { r0: 0, n: df, low: b.front },
      { r0: df, n: b.d - df, low: OPP[b.front] },
    ];
    for (const half of halves) {
      if (half.n < 1) continue;
      let lx = 0;
      const placePiece = (px: number, w: number, depth: number): void => {
        const r = rectOf(px, half.r0, w, depth);
        const pool = canopyRes.variants.filter((v) => v.weight > 0 && (v.footprint[0] * v.footprint[1] === w * depth));
        // a 2x1 run is the long strip turned across (it slopes over its short side); a 2x2 or 1x1 is the same piece
        const want = w * depth === 2 ? pool.filter((v) => Math.max(...v.footprint) === 2 && Math.min(...v.footprint) === 1) : pool;
        const v = ctx.pick(want.length > 0 ? want : pool, `${f.id}:canopy:${half.r0}:${px}`);
        if (!v) return;
        canopyAt(v, r, turn(half.low, v, "stall.canopy"));
        ridgeY = Math.max(ridgeY, yc + v.geom.size.y);
      };
      for (; lx + 2 <= b.w; lx += 2) placePiece(lx, 2, half.n);
      if (lx < b.w) for (let j = 0; j < half.n; j++) {
        const r = rectOf(lx, half.r0 + j, 1, 1);
        const pool = canopyRes.variants.filter((v) => v.weight > 0 && v.footprint[0] * v.footprint[1] === 1);
        const v = ctx.pick(pool, `${f.id}:canopy:${half.r0}:${lx}:${j}`);
        if (v) {
          canopyAt(v, r, turn(half.low, v, "stall.canopy"));
          ridgeY = Math.max(ridgeY, yc + v.geom.size.y);
        }
      }
    }
    // a beam along the ridge, tied on top of the cloth
    const ridgeRes = find(["stall.ridge"]);
    if (ridgeRes) {
      const nb = Math.max(1, Math.ceil(b.w / 2));
      const alongX = b.front === "S" || b.front === "N";
      for (let k = 0; k < nb; k++) {
        const v = choose(ridgeRes, `ridge:${k}`);
        if (!v) continue;
        const along = nb === 1 ? b.w / 2 : 1 + (k * (b.w - 2)) / (nb - 1);
        const [px, py] = point(along, df);
        prop(v, px, py, ridgeY - v.geom.size.y * 0.7, fr.planDegreesToWorld(alongX ? 0 : 90) + v.rot);
      }
    }
  }

  // 5. a lantern under the front of the canopy, a stool inside
  if (b.light) {
    const lr = find(["stall.light"]);
    const v = lr ? choose(lr, "light") : undefined;
    if (v) {
      const [px, py] = point(b.w / 2 + (rng.next() - 0.5) * 0.6, 0.35);
      prop(v, px, py, yc - v.geom.size.y, 0);
    }
  }
  if (b.seat) {
    const sr = find(["stall.seat", "feature.stool"]);
    const v = sr ? choose(sr, "seat") : undefined;
    if (v) {
      const [lx, ly] = b.seat;
      const [px, py] = point(lx + 0.5, ly + 0.5);
      prop(v, px, py, top0, rng.int(24) * 15);
    }
  }
  return true;
}
