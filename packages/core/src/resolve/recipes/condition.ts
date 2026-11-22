/**
 * Condition recipes (generator 5, plan §11.1 P10, P11, P24): what a worn, ramshackle or ruined building shows at its
 * foot. Which of them a building gets, and how much, is its treatment (treatments.ts families "growth" and "rubble",
 * weighted by its condition state); both read only the resolved level, never a plan word.
 *
 *   wallFootGrowth  growth at the foot of a building's outside walls, only on faces with no door (a used face is kept
 *                   clear), more the farther a face is from the building's doors and less on its street face: wear grows
 *                   with distance from use. Variants: feet (a fringe), thick (most of the run).
 *   breachRubble    a ruin's rubble graded by distance from each breach, inside and out: big blocks near the wall, piles
 *                   further, small stones furthest; the breach itself stays walkable (the keep-clear rule refuses its way).
 *
 * Pieces, theme's own first, nothing borrowed (a theme without them shows none):
 *   weeds   feature.undergrowth → feature.tall_grass (low: at most LOW_H tall)
 *   clumps  ruin_growth.default → feature.bush (a bigger clump for the thick variant)
 *   blocks  ruin_block.<wall family> → ruin_block.default
 *   piles   ruin_rubble.default → feature.rubble
 *   stones  feature.rock → feature.debris (low pieces only)
 * The palettes have no overgrowth, ivy or rubble-grade roles (plan §11.9, decisions 18 and 19): these stand in.
 *
 * Every piece stands wholly on one floor height outside water, paths, stairs and links, sunk at most SINK_MAX. Loose
 * pieces turn at free 15° steps, the same rule whatever the building's condition (condition never turns anything).
 */
import type { ArrangePiece, Placed } from "../../arrange";
import type { Side } from "../../contracts/plan";
import { CELL_FLAG, type ResolvedStructure } from "../../contracts/resolved";
import { isPassage } from "../../gen/openingKinds";
import { wallStyleInfo } from "../../gen/wallStyles";
import { hashUnitMixed } from "../../util/hash";
import { turnedHalfExtents } from "../../util/turn";
import { framePoint, NORMAL_TURN, type AnchorFrame } from "../anchors";
import { minOf } from "../../util/lists";
import type { FilledSlot, Recipe, RecipeCtx } from "./types";

/** Growth and stones: at most this tall. */
const LOW_H = 1.4;
/** A loose piece sinks at most this far (verify's support slack). */
const SINK_MAX = 0.05;
/** Cells no loose piece reaches onto. */
const KEEP_OFF = CELL_FLAG.WATER | CELL_FLAG.PATH | CELL_FLAG.STEPS | CELL_FLAG.LINK;
/** Share of a face's length the growth covers, by variant (a subject's draw within each range). */
const GROWTH_SHARE = { feet: [0.25, 0.4], thick: [0.55, 0.8] } as const;
/** The street face shows this share of what its distance from use asks; a face at a door none. */
const FRONT_FACTOR = 0.4;
/** Distance from the nearest door (tiles) at which a face counts as wholly unused. */
const UNUSED_AT = 8;
/** Rubble bands out from a breach's wall surface (tiles): near, mid, far, and pieces per band (a subject's draw). */
const BANDS = [
  { from: 0.3, to: 1.4, count: [2, 3] },
  { from: 1.4, to: 2.8, count: [2, 4] },
  { from: 2.8, to: 4.5, count: [3, 5] },
] as const;

const piecesOf = (s: FilledSlot | undefined): readonly ArrangePiece[] => s?.pieces ?? [];
const low = (ps: readonly ArrangePiece[]): ArrangePiece[] =>
  ps.filter((p) => p.measures.height <= LOW_H && p.measures.length <= 2.5);

/** The side a frame's normal points to (a grid frame's turn is a quarter turn). */
export function normalSide(f: AnchorFrame): Side {
  const t = (((Math.round(f.turn / 90) * 90) % 360) + 360) % 360;
  return (Object.keys(NORMAL_TURN) as Side[]).find((s) => NORMAL_TURN[s] === t) ?? "N";
}

/** Cells a piece flanking a path may stand on the edge of (a path is ground; water, stairs and links are not). */
export const KEEP_OFF_BESIDE_PATH = CELL_FLAG.WATER | CELL_FLAG.STEPS | CELL_FLAG.LINK;

/**
 * Where a loose piece at local (x, z) of frame `f`, turned `yaw`, stands: its local bottom y on the ground under it
 * (sunk `sink` at most SINK_MAX), or null when its footprint is not wholly on one floor height clear of the cells
 * `keepOff` flags (default: water, paths, stairs and links).
 */
export function onGround(
  ctx: RecipeCtx,
  f: AnchorFrame,
  x: number,
  z: number,
  p: ArrangePiece,
  yaw: number,
  sink = 0,
  keepOff: number = KEEP_OFF,
): number | null {
  const g = ctx.anchors.grid;
  const h = turnedHalfExtents(p.variant.geom.size.x, p.variant.geom.size.z, yaw + f.turn);
  const [px, py] = framePoint(f, x, z);
  let top: number | null = null;
  for (const [qx, qy] of [
    [px, py],
    [px - h.x, py - h.z],
    [px + h.x, py - h.z],
    [px - h.x, py + h.z],
    [px + h.x, py + h.z],
  ] as const) {
    const cx = Math.floor(qx);
    const cy = Math.floor(qy);
    if (!g.cell(cx, cy).floor) return null;
    if (((ctx.level.cells.flags[g.index(cx, cy)] ?? 0) & keepOff) !== 0) return null;
    const t = g.top(cx, cy);
    if (top === null) top = t;
    else if (Math.abs(t - top) > 0.01) return null;
  }
  if (top === null) return null;
  return top - Math.min(SINK_MAX, sink * p.measures.height) - f.base;
}

/** A free 15° turn drawn from `u` (0..1). */
const freeYaw = (u: number): number => Math.floor(u * 24) * 15;

/** The building a building anchor belongs to. */
const structureOf = (ctx: RecipeCtx, id: string | null): ResolvedStructure | undefined =>
  id === null ? undefined : (ctx.level.structures ?? []).find((s) => s.id === id);

/** Plan points of a building's doors (passages that are not breaches). */
function doorsOf(ctx: RecipeCtx, st: ResolvedStructure): Array<[number, number]> {
  const ids = new Set(st.openingIds);
  return ctx.level.openings
    .filter((o) => ids.has(o.id) && isPassage(o.kind) && !isBreach(o.id))
    .map((o) =>
      o.orientation === "h" ? [o.start[0] + o.width / 2, o.start[1]] : [o.start[0], o.start[1] + o.width / 2],
    );
}

/** A breach a ruin's wall fell open in (resolve/building: its synthetic id). */
export const isBreach = (id: string): boolean => id.includes("~breach");

export const wallFootGrowth: Recipe<"face"> = {
  id: "wallFootGrowth",
  doc: "growth at the foot of a building's outside walls with no door, more away from use, least on the street face",
  switch: "wallFootGrowth",
  family: "growth",
  anchor: "face",
  tier: () => 3,
  mount: "floor",
  blocking: false,
  thinnable: true,
  underfoot: true,
  when: (a) =>
    a.structure !== null &&
    a.outside &&
    a.seen &&
    !a.natural &&
    a.storey === 0 &&
    a.length >= 1 &&
    !a.gaps.some((g) => isPassage(g.kind)),
  slots: {
    weeds: {
      roles: () => [{ role: "feature.undergrowth" }, { role: "feature.tall_grass" }],
      fallback: "simplify",
    },
    clumps: {
      roles: () => [{ role: "ruin_growth.default" }, { role: "feature.bush" }],
      fallback: "simplify",
    },
  },
  compose: (a, slots, ctx) => {
    const weeds = low(piecesOf(slots.weeds));
    const clumps = low(piecesOf(slots.clumps));
    if (weeds.length === 0 && clumps.length === 0) return null;
    const st = structureOf(ctx, a.structure);
    if (!st) return null;
    const range = ctx.variant === "thick" ? GROWTH_SHARE.thick : GROWTH_SHARE.feet;
    // wear grows with distance from use: the face's middle against the nearest door, less on the street face
    const [mx, my] = framePoint(a.frame, a.length / 2, 0);
    const doors = doorsOf(ctx, st);
    const d = doors.length === 0 ? UNUSED_AT : minOf(doors.map(([x, y]) => Math.hypot(x - mx, y - my)));
    const front = st.frontage?.side === normalSide(a.frame) ? FRONT_FACTOR : 1;
    const share =
      (range[0] + (range[1] - range[0]) * ctx.treatment.jitter("growthShare")) *
      (0.35 + 0.65 * Math.min(1, d / UNUSED_AT)) *
      front *
      ctx.density;
    const draw = (what: string, i: number): number => hashUnitMixed(ctx.seed, "growth", what, i);
    const out: Placed[] = [];
    // clusters along the run: each about a tile long, kept where the share asks
    const n = Math.floor(a.length);
    for (let i = 0; i < n; i++) {
      if (draw("keep", i) >= share) continue;
      const big = ctx.variant === "thick" && clumps.length > 0 && draw("big", i) < 0.5;
      const pool = big || weeds.length === 0 ? clumps : weeds;
      const count = big ? 1 : 1 + Math.floor(draw("count", i) * 2);
      for (let k = 0; k < count; k++) {
        const p = pool[Math.floor(draw(`piece${k}`, i) * pool.length)] as ArrangePiece;
        const yaw = freeYaw(draw(`yaw${k}`, i));
        const x = i + 0.2 + 0.6 * draw(`x${k}`, i);
        // at the foot: the clump's near side against the wall, a little into it
        const z = Math.max(0.05, p.measures.width / 2 - 0.1) + 0.25 * draw(`z${k}`, i);
        const y = onGround(ctx, a.frame, x, z, p, yaw, 0.3);
        if (y === null) continue;
        out.push({ piece: p, x, y, z, yaw });
      }
    }
    return out.length > 0 ? out : null;
  },
};

export const breachRubble: Recipe<"opening"> = {
  id: "breachRubble",
  doc: "a ruin's rubble graded by distance from each breach: big blocks near, piles further, small stones far (P11)",
  switch: "breachRubble",
  family: "rubble",
  anchor: "opening",
  tier: () => 2,
  mount: "floor",
  blocking: false,
  thinnable: true,
  // (rubble is climbed over, as ground cover is walked over: it may cover open ground, never a way, lane or apron)
  underfoot: true,
  when: (a) => a.structure !== null && a.outside && a.storey === 0 && isBreach(a.id),
  slots: {
    blocks: {
      roles: (a) => [
        { role: `ruin_block.${wallStyleInfo(a.style)?.family ?? "default"}` },
        { role: "ruin_block.default" },
      ],
      fallback: "simplify",
    },
    piles: {
      roles: () => [{ role: "ruin_rubble.default" }, { role: "feature.rubble" }],
      fallback: "simplify",
    },
    stones: {
      roles: () => [{ role: "feature.rock" }, { role: "feature.debris" }],
      fallback: "simplify",
    },
  },
  compose: (a, slots, ctx) => {
    const byVolume = (ps: readonly ArrangePiece[]): ArrangePiece[] =>
      [...ps].sort((p, q) => q.measures.volume - p.measures.volume);
    const blocks = byVolume(piecesOf(slots.blocks));
    const piles = byVolume(piecesOf(slots.piles));
    const stones = byVolume(low(piecesOf(slots.stones)));
    // each band takes its own grade; a theme missing one grade takes the nearest grade's pieces of that size order
    const all = byVolume([...blocks, ...piles, ...stones]);
    if (all.length === 0) return null;
    const third = (i: number): ArrangePiece[] => {
      const k = Math.max(1, Math.ceil(all.length / 3));
      return all.slice(Math.min(i * k, all.length - 1), Math.min(all.length, (i + 1) * k));
    };
    const grades: ArrangePiece[][] = [
      blocks.length > 0 ? blocks : third(0),
      piles.length > 0 ? piles : third(1),
      stones.length > 0 ? stones : third(2),
    ];
    const draw = (what: string, i: number, k = 0): number => hashUnitMixed(ctx.seed, "rubble", what, i, k);
    const out: Placed[] = [];
    BANDS.forEach((band, bi) => {
      const pool = grades[bi] ?? [];
      if (pool.length === 0) return;
      const n = Math.round(
        (band.count[0] + (band.count[1] - band.count[0]) * ctx.treatment.jitter(`rubble${bi}`)) * ctx.density,
      );
      for (let i = 0; i < n; i++) {
        const p = pool[Math.floor(draw("piece", bi, i) * pool.length)] as ArrangePiece;
        const yaw = freeYaw(draw("yaw", bi, i));
        // fallen both ways: three in five outside; spread along the wall a little wider than the breach
        const inside = draw("side", bi, i) < 0.4;
        const dist = band.from + (band.to - band.from) * draw("d", bi, i);
        const spread = a.width / 2 + 0.6 + 0.6 * bi;
        const x = (draw("x", bi, i) * 2 - 1) * spread;
        // (inside, past the wall's thickness: a building's outside surface stands half a cell off its grid line)
        const z = inside ? -(dist + 0.5 + p.measures.width / 2) : dist + p.measures.width / 2;
        const y = onGround(ctx, a.frame, x, z, p, yaw, 0.3);
        if (y === null) continue;
        out.push({ piece: p, x, y, z, yaw });
      }
    });
    return out.length > 0 ? out : null;
  },
};
