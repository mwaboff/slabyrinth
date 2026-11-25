/**
 * Markets (generator 3 and up), placed with the features (step 8): rows of stalls, goods on bare-table stalls, loose
 * stock beside covered stalls, overhead lines between building walls or posts, and the props a trade puts outside
 * its door. The layout lives in gen/market.ts; this module asks it for placements and commits them.
 * Reads: the level's stall rows and lines, the stalls the plan placed itself, the buildings and their doors (the
 * level's openings, read-only), the carriageways (PathRecords, read-only), the palette's covered-stall forms and stall
 * size, the cells nothing else holds. Writes: market features (stalls, goods, stock, posts, overhead pieces, trade
 * props) through FeatureWork, the overhead lines that found both anchors (the list it is handed, ResolvedLevel.lines),
 * plan issues.
 */
import type { FeatureType, Level, StallRow, ThemeId } from "../../contracts/plan";
import { PLAN_LIMITS } from "../../contracts/plan";
import type {
  ResolvedFeature,
  ResolvedLine,
  ResolvedOpening,
  StallBuild,
  StallForm,
} from "../../contracts/resolved";
import { CELL, CELL_FLAG } from "../../contracts/resolved";
import { featureInfo, rotatedSize } from "../../gen/catalog";
import { FACE_ROT as TURN, SIDE_STEP as STEP } from "../../gen/gridGeometry";
import { isPassage } from "../../gen/openingKinds";
import {
  TRADE_PROPS,
  stallKindInfo,
  layoutLine,
  layoutStalls,
  layoutStalls4,
  stallCell,
  tradeOf,
  type LinePiece,
} from "../../gen/market";
import { elementSeed, subSeed } from "../../util/hash";
import { createPrng } from "../../util/prng";
import { type FeatureWork, offWalls } from "./features";
import type { ReadOnly, ResolveGrid } from "./grid";
import type { PathRecords } from "./paths";
import { canopyTop } from "../building/canopy";
import { restsOn } from "../../util/sunk";

/**
 * A cell a market piece may stand on: open floor nothing else holds (no building, feature, link, water or crossing),
 * and (generator 4) not in front of a door.
 */
function marketCellOk(
  work: ResolveGrid,
  features: FeatureWork,
  x: number,
  y: number,
  reserved = true,
): boolean {
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
  if (features.occupied(i) || work.inBuilding(i) || (reserved && work.structs?.reservedCell(i))) return false;
  // generator 4: never in front of a door (the market keeps its own stalls' lanes: stallClutter, stepLine)
  return !features.crossingClear().has(i) && !features.inWayIn(i, false);
}

/** Commit a market piece as a generated feature; `occupy` false keeps its cells free for other dressing (a line). */
function commitMarket(
  work: ResolveGrid,
  features: FeatureWork,
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
    theme: work.themeAt(anchor),
    blocking: occupy && info.blocking,
  };
  if (p.variant !== undefined) rf.variant = p.variant;
  if (p.stall !== undefined) rf.stall = p.stall;
  if (p.offset !== undefined)
    rf.offset = [Math.max(-0.5, Math.min(0.5, p.offset[0])), Math.max(-0.5, Math.min(0.5, p.offset[1]))];
  else if (work.profile.marketFurnitureOffWalls && occupy && p.stall === undefined && (p.lift ?? 0) === 0) {
    // a trade's pieces stand against a house front, windows included
    const off = offWalls(work, p.type, p.at, p.size, true);
    if (off) rf.offset = off;
  }
  const shown = work.areaAt(anchor);
  if (shown) rf.area = shown.area.id;
  // the market may let a piece reach over a door front: it keeps the doors clear cell by cell itself (`marketCellOk`)
  // and lays its own pieces round its stalls' lanes, and a stall or table refused here would leave its goods standing
  // on nothing
  features.addGenerated(rf, { occupy, wayIn: { mayStand: "market layout keeps its own ways in" } });
}

/**
 * Generator 3, markets: rows of stalls (`Level.stalls`), goods on the bare-table stalls (also on stalls the plan
 * placed itself), overhead lines (`Level.lines`) anchored on building walls or posts, and the props a trade puts
 * outside its door. Everything stands only on cells nothing else holds.
 */
export function stepMarket(
  work: ResolveGrid,
  features: FeatureWork,
  lines: ResolvedLine[],
  paths: ReadOnly<PathRecords>,
  openings: readonly ResolvedOpening[],
): void {
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
  const ok = (x: number, y: number): boolean => marketCellOk(work, features, x, y);
  // goods on a bare-table stall: two pieces resting on the table top (its real height; nothing floats)
  const putGoods = (
    stallId: string,
    st: { at: [number, number]; size: [number, number] },
    kind: string,
  ): void => {
    const set = stallKindInfo(kind).tableGoods;
    if (set === undefined) return;
    // the table as the stall's own theme builds it (generator 4; the released generators asked the level's)
    const ext = work.ctx.palette.pieceSize(
      work.pieceTheme(work.idx(st.at[0], st.at[1])),
      "stall",
      true,
      "empty",
    );
    if (!ext) return;
    const rng = createPrng(subSeed(seedOf(stallId), "goods"));
    const cells: Array<[number, number]> = [];
    for (let y = st.at[1]; y < st.at[1] + st.size[1]; y++)
      for (let x = st.at[0]; x < st.at[0] + st.size[0]; x++) cells.push([x, y]);
    cells.forEach((c, n) => {
      if (features.generated >= cap) return;
      commitMarket(
        work,
        features,
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
  for (const f of [...features.all]) {
    if (f.type === "stall" && f.generatedBy === undefined)
      putGoods(f.id, { at: [f.at[0], f.at[1]], size: [f.size[0], f.size[1]] }, f.variant ?? "empty");
  }
  // generator 4: covered stalls when the theme's palette has the parts (else the table stall of generator 3)
  // The theme is the stall's own, as the realizer builds it and verify checks it (a row in an area of another theme
  // than its level): the most common theme of the row's free cells, like the height below.
  const rowForms = (row: StallRow): StallForm[] => {
    if (!work.profile.coveredStalls) return [];
    const themes = new Map<ThemeId, number>();
    for (let y = row.area.y; y < row.area.y + row.area.h; y++)
      for (let x = row.area.x; x < row.area.x + row.area.w; x++) {
        const i = work.idx(x, y);
        if (i >= 0 && ok(x, y)) {
          const t = work.themeAt(i);
          themes.set(t, (themes.get(t) ?? 0) + 1);
        }
      }
    const theme =
      [...themes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ??
      work.themeAt(work.idx(row.area.x, row.area.y));
    return work.ctx.palette.stallForms(theme);
  };
  stallRows.forEach((row, k) => {
    let placed;
    const forms = rowForms(row);
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
      if (features.generated >= cap) return;
      const id = `${row.id}#${n}`;
      commitMarket(
        work,
        features,
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
      if (p.build) stallClutter(work, features, `${row.id}#${n}`, p, p.build, cap);
    });
  });
  lineList.forEach((line, k) => {
    const resolved = stepLine(work, features, line, k, cap);
    if (resolved) lines.push(resolved);
  });
  // outside a front door the lot's reserved ring is exactly where trade props stand (the door approach stays free)
  stepTradeProps(work, features, paths, openings, cap, (x, y) => marketCellOk(work, features, x, y, false));
}

/**
 * Generator 4: loose stock behind or beside a covered stall (a crate, barrel or sack on a free cell touching it),
 * on about half of them. Never in front: the lane stays clear.
 */
function stallClutter(
  work: ResolveGrid,
  features: FeatureWork,
  id: string,
  p: { at: [number, number]; size: [number, number]; kind: string },
  b: StallBuild,
  cap: number,
): void {
  if (features.generated >= cap) return;
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
    ([x, y]) =>
      marketCellOk(work, features, x, y) && work.featureProblem(type, [x, y], [1, 1], undefined) === null,
  );
  const at = free[rng.int(Math.max(1, free.length))];
  if (!at) return;
  commitMarket(work, features, `${id}#stock`, { type, at, size: [1, 1], rot: rng.int(4) * 90 }, true);
}

/**
 * One overhead line: straightness, two anchors (a building wall within 3 cells beyond the end, else a post), pieces.
 * Returns the line when it found both anchors, null when it was dropped (with a plan issue).
 */
function stepLine(
  work: ResolveGrid,
  features: FeatureWork,
  line: NonNullable<Level["lines"]>[number],
  k: number,
  cap: number,
): ResolvedLine | null {
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
    return null;
  }
  const alongX = y0 === y1;
  const lane = alongX ? y0 : x0;
  const lo = Math.min(alongX ? x0 : y0, alongX ? x1 : y1);
  const hi = Math.max(alongX ? x0 : y0, alongX ? x1 : y1);
  if (hi - lo < 2) {
    bad("is shorter than 3 cells", "a line spans at least 3 cells");
    return null;
  }
  const cellAt = (a: number): [number, number] => (alongX ? [a, lane] : [lane, a]);
  const building = (a: number): boolean => {
    const [x, y] = cellAt(a);
    // a footprint cell (a porch or stoop beside it is not a wall)
    return work.structs?.buildings.some((b) => b.cellSet.has(`${x},${y}`)) === true;
  };
  type Anchor = { kind: "wall" | "post"; at: number };
  const anchor = (end: number, dir: 1 | -1, walls = true): Anchor | null => {
    if (walls)
      for (let d = 0; d <= 3; d++) if (building(end + dir * d)) return { kind: "wall", at: end + dir * d };
    for (let d = 0; d <= 1; d++) {
      const a = end - dir * d;
      const [x, y] = cellAt(a);
      if (
        marketCellOk(work, features, x, y) &&
        work.featureProblem("line_post", [x, y], [1, 1], undefined) === null
      )
        return { kind: "post", at: a };
    }
    return null;
  };
  /** Why a pair of anchors cannot hold the line, or null when they can (each check in its released order). */
  const fault = (aLo: Anchor | null, aHi: Anchor | null): [string, string] | null => {
    if (!aLo || !aHi)
      return [
        "has no building wall within 3 cells of an end and no free cell for a post there",
        "end it beside a building wall, or on a free cell",
      ];
    for (let a = aLo.at + 1; a < aHi.at; a++)
      if (building(a)) return ["passes through a building", "end it at the building's wall"];
    if (aHi.at - aLo.at < 3) return ["is shorter than 3 cells between its anchors", "make the span longer"];
    // generator 4: a covered stall's canopy rises above a rope's height; the line runs along the aisle, not through it
    if (work.profile.coveredStalls)
      for (let a = aLo.at + 1; a < aHi.at; a++) {
        const [cx, cy] = cellAt(a);
        if (
          features.all.some(
            (f) =>
              f.stall !== undefined &&
              cx >= f.at[0] &&
              cx < f.at[0] + f.size[0] &&
              cy >= f.at[1] &&
              cy < f.at[1] + f.size[1],
          )
        )
          return [
            "passes through a covered stall",
            "run it along the aisle or the street, clear of the stalls' footprints",
          ];
      }
    return null;
  };
  // 2.6 clears the awnings of shop fronts (2 to 2.5 up); a wall must reach it, else the verifier says the line is not held
  const height = Math.max(2, Math.min(3, line.height ?? 2.6));
  /** The line's pieces between its anchors (a wall's face, a post's side). */
  const layout = (aLo: Anchor, aHi: Anchor): LinePiece[] => {
    const start = aLo.kind === "wall" ? aLo.at + 1 : aLo.at + 0.65;
    const end = aHi.kind === "wall" ? aHi.at : aHi.at + 0.35;
    return layoutLine({ alongX, lane, start, end }, line.kind ?? "lanterns", line.spacing ?? 3);
  };
  // generator 5 (linesClearCanopies): the canopies and awnings over shop fronts as built (resolve/building/canopy.ts;
  // a plinth and pad lift them above the 2.5 the height was chosen for). The rope (hanging its own height under the
  // line, its size from the palette it is built with) may run wholly under one or rest on it (util/sunk.ts, the
  // question verify asks), and nothing hangs from it over one. A wall anchor behind a canopy the rope would pass
  // through gives way to a post at that end of the line; when no anchors keep it clear, the line is left out (raised
  // over the canopy, it would run into the same front's signs, porch roofs and upper windows).
  const canopies = work.profile.linesClearCanopies
    ? (work.structs?.canopies(work.level.elevation) ?? []).flatMap(({ canopy, theme }) => {
        const top = canopyTop(canopy, work.ctx.palette.roles, theme);
        return top === null ? [] : [{ cells: canopy.cells, bottom: canopy.y, top }];
      })
    : [];
  // (linesClearCanopies) roofed porches, for the hung pieces: their outline, not only their cell, keeps off them
  const porchRoofCells = new Set<string>();
  if (work.profile.linesClearCanopies)
    for (const b of work.structs?.buildings ?? [])
      for (const q of b.porches) if (q.roof) for (const [x, y] of q.cells) porchRoofCells.add(`${x},${y}`);
  /**
   * Which of a layout's pieces pass through a canopy (each piece's outline round its centre and its height under the
   * line, from the palette it is built with) or hang into a roofed porch, and whether one of them is rope (the hung
   * ones are left out instead).
   */
  const overCanopies = (pieces: readonly LinePiece[]): { hits: Set<number>; through: boolean } => {
    const hits = new Set<number>();
    let through = false;
    pieces.forEach((p, n) => {
      const hung = p.size[0] * p.size[1] === 1;
      const cx = p.at[0] + p.size[0] / 2 + p.offset[0];
      const cy = p.at[1] + p.size[1] / 2 + p.offset[1];
      const i = work.idx(Math.floor(cx), Math.floor(cy));
      const ext = work.ctx.palette.roomPiece(work.pieceTheme(i), "overhead", p.variant);
      // rope runs the length of its footprint; a hung piece reaches its longest side round its centre (any turn)
      const r = Math.max(ext?.wMax ?? 0, ext?.dMax ?? 0) / 2;
      const hx = p.size[0] > 1 ? p.size[0] / 2 : r;
      const hy = p.size[1] > 1 ? p.size[1] / 2 : r;
      const meets = (cells: ReadonlySet<string>): boolean => {
        for (let y = Math.floor(cy - hy); y < cy + hy; y++)
          for (let x = Math.floor(cx - hx); x < cx + hx; x++)
            if (
              cells.has(`${x},${y}`) &&
              Math.min(cx + hx, x + 1) - Math.max(cx - hx, x) > 0.01 &&
              Math.min(cy + hy, y + 1) - Math.max(cy - hy, y) > 0.01
            )
              return true;
        return false;
      };
      if (hung && meets(porchRoofCells)) hits.add(n);
      const top = work.featureBase(i, height);
      const bottom = top - (ext?.hMax ?? 0);
      for (const c of canopies) {
        if (top <= c.bottom || restsOn(bottom, c.top) || !meets(c.cells)) continue;
        hits.add(n);
        if (!hung) through = true;
      }
    });
    return { hits, through };
  };
  let aLo = anchor(lo, -1);
  let aHi = anchor(hi, 1);
  const first = fault(aLo, aHi);
  if (first) {
    bad(...first);
    return null;
  }
  const clearOf = (l: Anchor, h: Anchor): boolean => !overCanopies(layout(l, h)).through;
  if (canopies.length > 0 && aLo && aHi && !clearOf(aLo, aHi)) {
    const tries: Array<[Anchor | null, Anchor | null]> = [
      [aLo, anchor(hi, 1, false)],
      [anchor(lo, -1, false), aHi],
      [anchor(lo, -1, false), anchor(hi, 1, false)],
    ];
    const clear = tries.find(([l, h]) => l && h && fault(l, h) === null && clearOf(l, h));
    if (!clear) {
      bad(
        "passes through a building's canopy or awning, and no post at its ends keeps it clear",
        "end it clear of the shop fronts with a canopy or awning, or against a wall without one",
      );
      return null;
    }
    [aLo, aHi] = clear;
  }
  if (!aLo || !aHi) return null;
  const pieces = layout(aLo, aHi);
  const intoCanopy = overCanopies(pieces).hits;
  // the posts (an anchor that is not a wall)
  const anchors: ResolvedLine["anchors"] = [
    { kind: aLo.kind, at: cellAt(aLo.at) },
    { kind: aHi.kind, at: cellAt(aHi.at) },
  ];
  [aLo, aHi].forEach((an, n) => {
    if (an.kind === "post")
      commitMarket(
        work,
        features,
        `${line.id}#post${n}`,
        { type: "line_post", at: cellAt(an.at), size: [1, 1] },
        true,
      );
  });
  // generator 4: a lantern or flag hangs below the rope, into a porch roof under it: none hangs over a roofed porch
  const porchRoofs = new Set<string>();
  if (work.profile.linesClearPorches)
    for (const b of work.structs?.buildings ?? [])
      for (const q of b.porches) if (q.roof) for (const [x, y] of q.cells) porchRoofs.add(`${x},${y}`);
  pieces.forEach((p, n) => {
    if (features.generated >= cap) return;
    const hung = p.size[0] * p.size[1] === 1;
    if (hung && porchRoofs.has(`${p.at[0]},${p.at[1]}`)) return;
    if (intoCanopy.has(n)) return;
    commitMarket(
      work,
      features,
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
  return { id: line.id, a: cellAt(aLo.at), b: cellAt(aHi.at), height, anchors };
}

/** Props a trade puts outside its front door (not in front of the door itself, never in the carriageway). */
function stepTradeProps(
  work: ResolveGrid,
  features: FeatureWork,
  paths: ReadOnly<PathRecords>,
  openings: readonly ResolvedOpening[],
  cap: number,
  ok: (x: number, y: number) => boolean,
): void {
  if (!work.structs) return;
  const carriage = new Set<number>();
  for (const r of paths.pendingRoads) for (const i of r.cells) carriage.add(i);
  for (const b of work.structs.buildings) {
    const trade = tradeOf(b.st.use);
    if (!trade || (b.st.style ?? "cottage") === "modern") continue;
    const side = b.frontage.side;
    const [dx, dy] = STEP[side];
    const cands: Array<[number, number]> = [];
    // a door (not a window) on the front edge of cell (cx, cy) or of a cell beside it along the frontage
    const doorOn = (cx: number, cy: number): boolean =>
      openings.some((o) => {
        if (!isPassage(o.kind)) return false;
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
      if (taken.length >= want || features.generated >= cap) break;
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
      // generator 5 (tradePropsOnOneFloor): on one floor height, where it stands pushed against the front as well (a
      // bench across a lowered doorway cell and the raised pavement beside it was sunk into the pavement)
      if (
        work.profile.tradePropsOnOneFloor &&
        !work.oneFloorUnder(
          at,
          sz,
          (work.profile.marketFurnitureOffWalls ? offWalls(work, type, at, sz, true) : undefined) ?? [0, 0],
        )
      )
        continue;
      commitMarket(
        work,
        features,
        `${b.st.id}~trade#${taken.length}`,
        { type, at, size: sz, rot: TURN[side] },
        true,
      );
      taken.push(c);
    }
  }
}
