/**
 * Markets (generator 3 and up), placed with the features (step 8): rows of stalls, goods on bare-table stalls, loose
 * stock beside covered stalls, overhead lines between building walls or posts, and the props a trade puts outside
 * its door. The layout lives in gen/market.ts; this module asks it for placements and commits them.
 * Reads: the level's stall rows and lines, the stalls the plan placed itself, the buildings and their doors, the
 * palette's covered-stall forms and stall size, the cells nothing else holds. Writes: market features (stalls,
 * goods, stock, posts, overhead pieces, trade props), the generated-feature count, `resolvedLines`, plan issues.
 */
import type { FeatureType, Level, Side } from "../../contracts/plan";
import { PLAN_LIMITS } from "../../contracts/plan";
import type { ResolvedFeature, ResolvedLine, StallBuild } from "../../contracts/resolved";
import { CELL, CELL_FLAG } from "../../contracts/resolved";
import { featureInfo, rotatedSize } from "../../gen/catalog";
import {
  TRADE_PROPS,
  stallKindInfo,
  layoutLine,
  layoutStalls,
  layoutStalls4,
  stallCell,
  tradeOf,
} from "../../gen/market";
import { elementSeed, subSeed } from "../../util/hash";
import { createPrng } from "../../util/prng";
import { crossingClear } from "./features";
import type { AreaInfo, ResolveGrid } from "./grid";

/** A cell a market piece may stand on: open floor nothing else holds (no building, feature, link, water or crossing). */
function marketCellOk(work: ResolveGrid, x: number, y: number, reserved = true): boolean {
  const i = work.idx(x, y);
  if (i < 0 || work.state[i] !== CELL.OPEN) return false;
  const f = work.flags[i] as number;
  if (
    f &
    (CELL_FLAG.NO_FLOOR |
      CELL_FLAG.LINK |
      CELL_FLAG.STEPS |
      CELL_FLAG.FEATURE |
      CELL_FLAG.WATER |
      CELL_FLAG.BRIDGE)
  )
    return false;
  const sa = work.struct[i] as number;
  if (
    (work.occ[i] as number) > 0 ||
    work.areas[sa - 1]?.kind === "building" ||
    (reserved && work.structs?.reservedCell(i))
  )
    return false;
  return !crossingClear(work).has(i);
}

/** Commit a market piece as a generated feature; `occupy` false keeps its cells free for other dressing (a line). */
function commitMarket(
  work: ResolveGrid,
  id: string,
  p: {
    type: FeatureType;
    at: [number, number];
    size: [number, number];
    rot?: number;
    rotFine?: number;
    variant?: string;
    lift?: number;
    offset?: [number, number];
    stall?: StallBuild;
  },
  occupy: boolean,
): void {
  const anchor = work.idx(p.at[0], p.at[1]);
  const info = featureInfo(p.type);
  const rf: ResolvedFeature = {
    id,
    type: p.type,
    generatedBy: id.split("#")[0] as string,
    at: p.at,
    size: p.size,
    rot: (p.rot ?? 0) as ResolvedFeature["rot"],
    rotFine: p.rotFine ?? p.rot ?? 0,
    baseHeight: work.featureBase(anchor, p.lift ?? 0),
    theme: work.themes[anchor >= 0 ? (work.theme[anchor] as number) : 0] ?? work.levelTheme,
    blocking: occupy && info.blocking,
  };
  if (p.variant !== undefined) rf.variant = p.variant;
  if (p.stall !== undefined) rf.stall = p.stall;
  if (p.offset !== undefined)
    rf.offset = [Math.max(-0.5, Math.min(0.5, p.offset[0])), Math.max(-0.5, Math.min(0.5, p.offset[1]))];
  const ar = anchor >= 0 ? (work.disp[anchor] as number) : 0;
  if (ar > 0) rf.area = (work.areas[ar - 1] as AreaInfo).area.id;
  if (occupy) work.addFeature(rf, work.footprint(p.at, p.size).cells);
  else work.features.push(rf);
  work.generated++;
}

/**
 * Generator 3, markets: rows of stalls (`Level.stalls`), goods on the bare-table stalls (also on stalls the plan
 * placed itself), overhead lines (`Level.lines`) anchored on building walls or posts, and the props a trade puts
 * outside its door. Everything stands only on cells nothing else holds.
 */
export function stepMarket(work: ResolveGrid): void {
  const stallRows = work.level.stalls ?? [];
  const lineList = work.level.lines ?? [];
  if (!work.profile.stallsAndLines) {
    if (stallRows.length + lineList.length > 0)
      work.issue(
        "warning",
        "no_effect",
        `stalls and lines need generator 3; this plan is generator ${work.plan.generator}`,
        {
          hint: 'set "generator": 3 on the plan',
        },
      );
    return;
  }
  const cap = PLAN_LIMITS.generatedFeaturesPerLevel;
  const seedOf = (id: string): number => elementSeed(work.plan.seed, `${work.level.id}~${id}`, undefined);
  const ok = (x: number, y: number): boolean => marketCellOk(work, x, y);
  // goods on a bare-table stall: two pieces resting on the table top (its real height; nothing floats)
  const putGoods = (
    stallId: string,
    st: { at: [number, number]; size: [number, number] },
    kind: string,
  ): void => {
    const set = stallKindInfo(kind).tableGoods;
    if (set === undefined) return;
    const ext = work.ctx.palette.pieceSize(work.levelTheme, "stall", true, "empty");
    if (!ext) return;
    const rng = createPrng(subSeed(seedOf(stallId), "goods"));
    const cells: Array<[number, number]> = [];
    for (let y = st.at[1]; y < st.at[1] + st.size[1]; y++)
      for (let x = st.at[0]; x < st.at[0] + st.size[0]; x++) cells.push([x, y]);
    cells.forEach((c, n) => {
      if (work.generated >= cap) return;
      commitMarket(
        work,
        `${stallId}#g${n}`,
        {
          type: "goods",
          at: c,
          size: [1, 1],
          rotFine: rng.int(24) * 15,
          variant: set,
          lift: ext.h,
          offset: [(rng.next() - 0.5) * 0.3, (rng.next() - 0.5) * 0.3],
        },
        false,
      );
    });
  };
  for (const f of [...work.features]) {
    if (f.type === "stall" && f.generatedBy === undefined)
      putGoods(f.id, { at: [f.at[0], f.at[1]], size: [f.size[0], f.size[1]] }, f.variant ?? "empty");
  }
  // generator 4: covered stalls when the theme's palette has the parts (else the table stall of generator 3)
  const forms = work.profile.coveredStalls ? work.ctx.palette.stallForms(work.levelTheme) : [];
  stallRows.forEach((row, k) => {
    let placed;
    if (forms.length > 0) {
      // a stall stands on one level of ground: only the most common floor height of the rectangle takes one
      const heights = new Map<number, number>();
      for (let y = row.area.y; y < row.area.y + row.area.h; y++)
        for (let x = row.area.x; x < row.area.x + row.area.w; x++) {
          const i = work.idx(x, y);
          if (i >= 0 && ok(x, y))
            heights.set(work.height[i] as number, (heights.get(work.height[i] as number) ?? 0) + 1);
        }
      const level = [...heights].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
      const flat = (x: number, y: number): boolean => ok(x, y) && work.height[work.idx(x, y)] === level;
      placed = layoutStalls4(row, flat, seedOf(`stalls${k}~${row.seed ?? 0}`), forms);
    } else placed = layoutStalls(row, ok, seedOf(`stalls${k}~${row.seed ?? 0}`));
    if (placed.length === 0)
      work.issue("warning", "no_effect", `stall row "${row.id}" placed no stall`, {
        elementId: row.id,
        hint: "its rectangle is taken (buildings, features, water) or too small: a stall needs 2 free cells in a line",
      });
    placed.forEach((p, n) => {
      if (work.generated >= cap) return;
      const id = `${row.id}#${n}`;
      commitMarket(
        work,
        id,
        {
          type: "stall",
          at: p.at,
          size: p.size,
          rot: p.rot,
          variant: p.kind,
          ...(p.build ? { stall: p.build } : {}),
        },
        true,
      );
      // a covered stall carries its own goods (the realizer puts them on its counters); a table gets them here
      if (!p.build) putGoods(id, p, p.kind);
    });
    // stock beside the stalls goes in once every stall of the row stands (it takes only cells they left free)
    placed.forEach((p, n) => {
      if (p.build) stallClutter(work, `${row.id}#${n}`, p, p.build, cap);
    });
  });
  lineList.forEach((line, k) => {
    stepLine(work, line, k, cap);
  });
  // outside a front door the lot's reserved ring is exactly where trade props stand (the door approach stays free)
  stepTradeProps(work, cap, (x, y) => marketCellOk(work, x, y, false));
}

/**
 * Generator 4: loose stock behind or beside a covered stall (a crate, barrel or sack on a free cell touching it),
 * on about half of them. Never in front: the lane stays clear.
 */
function stallClutter(
  work: ResolveGrid,
  id: string,
  p: { at: [number, number]; size: [number, number]; kind: string },
  b: StallBuild,
  cap: number,
): void {
  if (work.generated >= cap) return;
  const rng = createPrng(
    subSeed(elementSeed(work.plan.seed, `${work.level.id}~${id}`, undefined), "clutter"),
  );
  if (rng.next() > 0.5) return;
  const cands: Array<[number, number]> = [];
  for (let lx = 0; lx < b.w; lx++) cands.push(stallCell(b.front, p.at, p.size, lx, b.d));
  cands.push(stallCell(b.front, p.at, p.size, -1, b.d - 1), stallCell(b.front, p.at, p.size, b.w, b.d - 1));
  const types = stallKindInfo(p.kind).stock;
  const type = types[rng.int(types.length)] as FeatureType;
  const free = cands.filter(
    ([x, y]) => marketCellOk(work, x, y) && work.featureProblem(type, [x, y], [1, 1], undefined) === null,
  );
  const at = free[rng.int(Math.max(1, free.length))];
  if (!at) return;
  commitMarket(work, `${id}#stock`, { type, at, size: [1, 1], rot: rng.int(4) * 90 }, true);
}

/** One overhead line: straightness, two anchors (a building wall within 3 cells beyond the end, else a post), pieces. */
function stepLine(
  work: ResolveGrid,
  line: NonNullable<Level["lines"]>[number],
  k: number,
  cap: number,
): void {
  const bad = (msg: string, hint: string): void => {
    work.issue("warning", "line_unanchored", `line "${line.id}" ${msg}; it was dropped`, {
      path: `/levels/${work.li}/lines/${k}`,
      elementId: line.id,
      hint,
    });
  };
  const [x0, y0] = line.from;
  const [x1, y1] = line.to;
  if (x0 !== x1 && y0 !== y1) {
    bad("is not straight", "give from and to on one row or one column of cells");
    return;
  }
  const alongX = y0 === y1;
  const lane = alongX ? y0 : x0;
  const lo = Math.min(alongX ? x0 : y0, alongX ? x1 : y1);
  const hi = Math.max(alongX ? x0 : y0, alongX ? x1 : y1);
  if (hi - lo < 2) {
    bad("is shorter than 3 cells", "a line spans at least 3 cells");
    return;
  }
  const cellAt = (a: number): [number, number] => (alongX ? [a, lane] : [lane, a]);
  const building = (a: number): boolean => {
    const [x, y] = cellAt(a);
    // a footprint cell (a porch or stoop beside it is not a wall)
    return work.structs?.buildings.some((b) => b.cellSet.has(`${x},${y}`)) === true;
  };
  const anchor = (end: number, dir: 1 | -1): { kind: "wall" | "post"; at: number } | null => {
    for (let d = 0; d <= 3; d++) if (building(end + dir * d)) return { kind: "wall", at: end + dir * d };
    for (let d = 0; d <= 1; d++) {
      const a = end - dir * d;
      const [x, y] = cellAt(a);
      if (marketCellOk(work, x, y) && work.featureProblem("line_post", [x, y], [1, 1], undefined) === null)
        return { kind: "post", at: a };
    }
    return null;
  };
  const aLo = anchor(lo, -1);
  const aHi = anchor(hi, 1);
  if (!aLo || !aHi) {
    bad(
      "has no building wall within 3 cells of an end and no free cell for a post there",
      "end it beside a building wall, or on a free cell",
    );
    return;
  }
  for (let a = aLo.at + 1; a < aHi.at; a++)
    if (building(a)) {
      bad("passes through a building", "end it at the building's wall");
      return;
    }
  if (aHi.at - aLo.at < 3) {
    bad("is shorter than 3 cells between its anchors", "make the span longer");
    return;
  }
  // generator 4: a covered stall's canopy rises above a rope's height; the line runs along the aisle, not through it
  if (work.profile.coveredStalls)
    for (let a = aLo.at + 1; a < aHi.at; a++) {
      const [cx, cy] = cellAt(a);
      if (
        work.features.some(
          (f) =>
            f.stall !== undefined &&
            cx >= f.at[0] &&
            cx < f.at[0] + f.size[0] &&
            cy >= f.at[1] &&
            cy < f.at[1] + f.size[1],
        )
      ) {
        bad(
          "passes through a covered stall",
          "run it along the aisle or the street, clear of the stalls' footprints",
        );
        return;
      }
    }
  // 2.6 clears the awnings of shop fronts (2 to 2.5 up); a wall must reach it, else the verifier says the line is not held
  const height = Math.max(2, Math.min(3, line.height ?? 2.6));
  // the posts (an anchor that is not a wall)
  const anchors: ResolvedLine["anchors"] = [
    { kind: aLo.kind, at: cellAt(aLo.at) },
    { kind: aHi.kind, at: cellAt(aHi.at) },
  ];
  [aLo, aHi].forEach((an, n) => {
    if (an.kind === "post")
      commitMarket(work, `${line.id}#post${n}`, { type: "line_post", at: cellAt(an.at), size: [1, 1] }, true);
  });
  const start = aLo.kind === "wall" ? aLo.at + 1 : aLo.at + 0.65;
  const end = aHi.kind === "wall" ? aHi.at : aHi.at + 0.35;
  const pieces = layoutLine({ alongX, lane, start, end }, line.kind ?? "lanterns", line.spacing ?? 3);
  pieces.forEach((p, n) => {
    if (work.generated >= cap) return;
    commitMarket(
      work,
      `${line.id}#${n}`,
      {
        type: "overhead",
        at: p.at,
        size: p.size,
        rotFine: p.rotFine,
        variant: p.variant,
        lift: height,
        offset: p.offset,
      },
      false,
    );
  });
  work.resolvedLines.push({ id: line.id, a: cellAt(aLo.at), b: cellAt(aHi.at), height, anchors });
}

/** Props a trade puts outside its front door (not in front of the door itself, never in the carriageway). */
function stepTradeProps(work: ResolveGrid, cap: number, ok: (x: number, y: number) => boolean): void {
  if (!work.structs) return;
  const carriage = new Set<number>();
  for (const r of work.pendingRoads) for (const i of r.cells) carriage.add(i);
  const STEP: Record<Side, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
  const TURN: Record<Side, number> = { S: 0, W: 90, N: 180, E: 270 };
  for (const b of work.structs.buildings) {
    const trade = tradeOf(b.st.use);
    if (!trade || (b.st.style ?? "cottage") === "modern") continue;
    const side = b.frontage.side;
    const [dx, dy] = STEP[side];
    const cands: Array<[number, number]> = [];
    // a door (not a window) on the front edge of cell (cx, cy) or of a cell beside it along the frontage
    const doorOn = (cx: number, cy: number): boolean =>
      work.openings.some((o) => {
        if (o.kind === "window" || o.kind === "arrow_slit" || o.kind === "bars") return false;
        const [sx, sy] = o.start;
        if (o.orientation === "h") {
          const ey = side === "S" ? cy + 1 : cy;
          return (side === "S" || side === "N") && sy === ey && cx >= sx && cx < sx + o.width;
        }
        const ex = side === "E" ? cx + 1 : cx;
        return (side === "E" || side === "W") && sx === ex && cy >= sy && cy < sy + o.width;
      });
    const doorNear = (cx: number, cy: number): boolean =>
      [-1, 0, 1].some((d) => (dx === 0 ? doorOn(cx + d, cy) : doorOn(cx, cy + d)));
    for (const [cx, cy] of b.cells) {
      const ox = cx + dx;
      const oy = cy + dy;
      if (b.cellSet.has(`${ox},${oy}`)) continue;
      const i = work.idx(ox, oy);
      if (i < 0 || carriage.has(i) || !ok(ox, oy)) continue;
      // keep the doorway's approach clear: no prop on or beside a door's cell (windows do not count)
      if (doorNear(cx, cy)) continue;
      cands.push([ox, oy]);
    }
    const rng = createPrng(
      subSeed(elementSeed(work.plan.seed, `${work.level.id}~${b.st.id}`, undefined), "trade"),
    );
    for (let i = cands.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [cands[i], cands[j]] = [cands[j] as [number, number], cands[i] as [number, number]];
    }
    const want = Math.min(cands.length, 1 + rng.int(3));
    const table = TRADE_PROPS[trade];
    const total = table.reduce((a, [, w]) => a + w, 0);
    const taken: Array<[number, number]> = [];
    for (const c of cands) {
      if (taken.length >= want || work.generated >= cap) break;
      if (taken.some((t) => Math.abs(t[0] - c[0]) + Math.abs(t[1] - c[1]) < 2)) continue;
      let r = rng.next() * total;
      let type = table[0]?.[0] as FeatureType;
      for (const [t, w] of table) {
        r -= w;
        if (r < 0) {
          type = t;
          break;
        }
      }
      const sz = rotatedSize(featureInfo(type).size, TURN[side]);
      // a wide piece lies along the frontage from its cell
      let at: [number, number] = [c[0], c[1]];
      if (sz[0] * sz[1] > 1) {
        const along: [number, number] = dy === 0 ? [0, 1] : [1, 0];
        const cells: Array<[number, number]> = [];
        for (let a = 0; a < Math.max(sz[0], sz[1]); a++)
          cells.push([c[0] + along[0] * a, c[1] + along[1] * a]);
        if (!cells.every(([x, y]) => ok(x, y) && cands.some((q) => q[0] === x && q[1] === y))) continue;
        at = [c[0], c[1]];
      }
      if (work.featureProblem(type, at, sz, undefined) !== null) continue;
      commitMarket(work, `${b.st.id}~trade#${taken.length}`, { type, at, size: sz, rot: TURN[side] }, true);
      taken.push(c);
    }
  }
}
