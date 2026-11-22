/**
 * Layered ground (plan W9, H4): open ground and large floors given depth by partial cover of flat and low pieces, the
 * way builders layer a field or a yard: flat pieces overlapping each other at free 15° turns, low ones (tufts, rocks,
 * rubble) sunk into the ground, gathered where the ground meets something (a wall foot, a fence, a kerb, another
 * material, water: the zone's `edgeAt`). Theme-neutral: it reads what the resolved level says of the place (the zone:
 * indoor or out, natural ground or built, its wear) and of each cell (water, a path, a stair), never a plan word. The
 * subject's treatment (family "ground") says how much: layered, gathered at the edges, sparse, or bare.
 *
 * Amount: the share of the place's open ground the pieces cover (their footprints, less what they lie over each other):
 * 30 % on natural ground outdoors, 15 % on built ground outdoors, indoors 5 % kept up, 10 % rough, 20 % abandoned; the
 * variants scale it (edges 0.7, only within a tile of an edge; sparse 0.4). At least half the cover lies within a tile
 * of an edge (cells there weigh NEAR_WEIGHT against the middle's).
 *
 * Pieces (slots, every one "simplify": a theme without the role has none of that kind; nothing is borrowed for it):
 *   cover   feature.ground_cover, the theme's own leaves, pebbles, papers: flat ones lie, low ones stand
 *   grass   feature.tall_grass (natural ground outdoors)
 *   bloom   feature.flowers (natural ground outdoors)
 *   rock    feature.rock (natural ground: the emergent rocks at edges)
 *   rubble  feature.rubble (worn places), then feature.debris
 * Flat: at most FLAT_H tall. Low: at most LOW_H tall and LOW_L long. Bigger pieces are not cover.
 *
 * Variety: every cluster draws its pieces from the place's own pool (`pick` by hash, never one piece everywhere): a
 * different flat piece under each cluster, its overlapping partner of the same kind (one role, one kit), low pieces mixed
 * with no three alike in a row. One place, one pool: a field never mixes in another theme's cover.
 */
import { single, type Arrangement, type ArrangePiece, type Placed } from "../../arrange";
import { CELL_FLAG } from "../../contracts/resolved";
import { hashUnitMixed } from "../../util/hash";
import { turnedHalfExtents } from "../../util/turn";
import { ZONE, type ZoneAnchor } from "../anchors";
import type { ComposeCtx, FilledSlot, Recipe } from "./types";

/** Flat cover is at most this tall; low cover at most this tall and this long. */
const FLAT_H = 0.17;
const LOW_H = 0.6;
const LOW_L = 1.8;
/** Cover share by place (see the header). */
const COVER = { natural: 0.3, built: 0.15, indoor: [0.05, 0.1, 0.2] } as const;
const VARIANT = { layered: 1, edges: 0.7, sparse: 0.4 } as const;
/** A cell within a tile of an edge weighs this much against one in the middle (within NEAR_REACH: 1.5). */
const NEAR_WEIGHT = 5;
const NEAR_REACH = 1.5;
/** Flat partners overlap by this share of their size; low pieces sink this share of their height. */
const OVERLAP = [0.2, 0.4] as const;
const SINK = [0.3, 0.5] as const;
/** ... but never deeper than this: a floor may be thinner than the piece is sunk (verify judges a base within 0.06 of the
 * floor top as standing on it, and a deeper one only where a floor piece is there to be sunk into). */
const SINK_MAX = 0.05;
/** Cells no piece of the cover reaches onto: water, a path, a stair, a link. */
const KEEP_OFF = CELL_FLAG.WATER | CELL_FLAG.PATH | CELL_FLAG.STEPS | CELL_FLAG.LINK;

const flatOf = (ps: readonly ArrangePiece[]): ArrangePiece[] =>
  ps.filter((p) => p.measures.height <= FLAT_H && p.measures.footprint >= 0.05);
const lowOf = (ps: readonly ArrangePiece[]): ArrangePiece[] =>
  ps.filter((p) => p.measures.height > FLAT_H && p.measures.height <= LOW_H && p.measures.length <= LOW_L);
const piecesOf = (s: FilledSlot | undefined): readonly ArrangePiece[] => s?.pieces ?? [];

/** The flat and low pools of a place. */
function pools(
  a: ZoneAnchor,
  slots: Readonly<Record<string, FilledSlot>>,
): { flat: ArrangePiece[]; low: ArrangePiece[]; rocks: ArrangePiece[] } {
  const cover = piecesOf(slots.cover);
  const rubble = a.wear > 0 ? piecesOf(slots.rubble) : [];
  if (a.indoor) return { flat: [...flatOf(cover), ...flatOf(rubble)], low: lowOf(rubble), rocks: [] };
  const flat = [...flatOf(cover), ...flatOf(rubble)];
  if (!a.natural) return { flat, low: [...lowOf(rubble), ...lowOf(piecesOf(slots.grass))], rocks: [] };
  return {
    flat,
    low: [
      ...lowOf(cover),
      ...lowOf(piecesOf(slots.grass)),
      ...lowOf(piecesOf(slots.bloom)),
      ...lowOf(rubble),
    ],
    rocks: lowOf(piecesOf(slots.rock)),
  };
}

/** The cover share the place asks, before the variant. */
const coverOf = (a: ZoneAnchor): number =>
  a.indoor ? COVER.indoor[a.wear] : a.natural ? COVER.natural : COVER.built + 0.05 * a.wear;

/** Cells of the place cover may lie on: floor, not a lane or apron, not water, a path, a stair or a link. */
function openCells(a: ZoneAnchor, ctx: ComposeCtx): Array<[number, number]> {
  const g = ctx.anchors.grid;
  const L = ctx.level;
  const out: Array<[number, number]> = [];
  for (const [x, y] of a.cells) {
    if ((a.classAt(x, y) & (ZONE.LANE | ZONE.DOOR)) !== 0) continue;
    const c = g.cell(x, y);
    if (!c.floor) continue;
    const f = L.cells.flags[g.index(x, y)] ?? 0;
    if ((f & (CELL_FLAG.WATER | CELL_FLAG.PATH | CELL_FLAG.STEPS | CELL_FLAG.LINK | CELL_FLAG.FEATURE)) !== 0)
      continue;
    out.push([x, y]);
  }
  return out;
}

export const layeredGround: Recipe<"zone"> = {
  id: "layeredGround",
  doc: "layered ground cover: flat pieces overlapping at free turns, low ones sunk, gathered at the ground's edges (H4)",
  switch: "layeredGround",
  family: "ground",
  anchor: "zone",
  tier: () => 3,
  mount: "floor",
  blocking: false,
  thinnable: true,
  underfoot: true,
  block: 8,
  when: (a) => a.cells.length >= 4,
  slots: {
    cover: { roles: () => [{ role: "feature.ground_cover" }], fallback: "simplify" },
    grass: {
      roles: (a) => (a.indoor || !a.natural ? [] : [{ role: "feature.tall_grass" }]),
      fallback: "simplify",
    },
    bloom: {
      roles: (a) => (a.indoor || !a.natural ? [] : [{ role: "feature.flowers" }]),
      fallback: "simplify",
    },
    rock: { roles: (a) => (a.indoor || !a.natural ? [] : [{ role: "feature.rock" }]), fallback: "simplify" },
    rubble: {
      roles: (a) => (a.wear > 0 ? [{ role: "feature.rubble" }, { role: "feature.debris" }] : []),
      fallback: "simplify",
    },
  },
  compose: (a, slots, ctx) => {
    const { flat, low, rocks } = pools(a, slots);
    if (flat.length === 0 && low.length === 0) return null;
    const share = coverOf(a) * (ctx.variant in VARIANT ? VARIANT[ctx.variant as keyof typeof VARIANT] : 1);
    const edgesOnly = ctx.variant === "edges";
    const cells = openCells(a, ctx).filter(([x, y]) => !edgesOnly || a.edgeAt(x, y) <= 1);
    if (cells.length === 0 || share <= 0) return null;
    const weightOf = (x: number, y: number): number => {
      const d = a.edgeAt(x, y);
      return d <= 1 ? NEAR_WEIGHT : d <= NEAR_REACH + 0.5 ? 1.5 : 1;
    };
    // a cluster covers about its main flat piece and (three times in four) a partner, less their overlap and what
    // is left out at a path or a drop
    const main = flat.length > 0 ? flat : low;
    const mean = main.reduce((s, p) => s + p.measures.footprint, 0) / main.length;
    const clusterArea = mean * (flat.length > 0 ? 1.45 : 1) + (low.length > 0 ? 0.15 : 0);
    const total = cells.reduce((s, [x, y]) => s + weightOf(x, y), 0);
    const k = (share * cells.length) / (clusterArea * total);
    const g = ctx.anchors.grid;
    const f = a.frame;
    const draw = (what: string, x: number, y: number, i = 0): number =>
      hashUnitMixed(ctx.seed, "ground", what, x, y, i);
    const out: Placed[] = [];
    const lows: Placed[] = [];
    const recent = new Map<readonly ArrangePiece[], number[]>();
    // a piece lies wholly on this place's own floor at the cluster's height (never over water, a path, a drop or a wall)
    const onGround = (px: number, py: number, p: ArrangePiece, yaw: number, top: number): boolean => {
      const h = turnedHalfExtents(p.variant.geom.size.x, p.variant.geom.size.z, yaw);
      return [
        [px - h.x, py - h.z],
        [px + h.x, py - h.z],
        [px - h.x, py + h.z],
        [px + h.x, py + h.z],
        [px, py],
      ].every(([qx = 0, qy = 0]) => {
        const cx = Math.floor(qx);
        const cy = Math.floor(qy);
        const c = g.cell(cx, cy);
        return (
          c.floor &&
          a.classAt(cx, cy) !== 0 &&
          Math.abs(g.top(cx, cy) - top) < 0.01 &&
          ((ctx.level.cells.flags[g.index(cx, cy)] ?? 0) & KEEP_OFF) === 0
        );
      });
    };
    const put = (
      into: Placed[],
      p: ArrangePiece,
      px: number,
      py: number,
      top: number,
      y: number,
      yaw: number,
    ): void => {
      if (!onGround(px, py, p, yaw, top)) return;
      const q = single(p, yaw)[0] as Placed;
      into.push({ ...q, x: px - f.at[0], z: f.at[1] - py, y: y - f.base });
    };
    for (const [x, y] of cells) {
      const p = Math.min(0.85, k * weightOf(x, y) * ctx.density);
      if (draw("keep", x, y) >= p) continue;
      const ground = g.top(x, y);
      const cx = x + 0.2 + 0.6 * draw("x", x, y);
      const cy = y + 0.2 + 0.6 * draw("y", x, y);
      const near = a.edgeAt(x, y) <= 1;
      if (flat.length > 0) {
        const m = flat[Math.floor(draw("flat", x, y) * flat.length)] as ArrangePiece;
        const yaw = Math.floor(draw("yaw", x, y) * 24) * 15;
        put(out, m, cx, cy, ground, ground, yaw);
        // its partner, of the same kind, overlapping it by 0.2-0.4 of their size at another turn
        const kin = flat.filter((q) => q.role === m.role);
        const n = kin[Math.floor(draw("partner", x, y) * kin.length)] ?? m;
        const ov = OVERLAP[0] + (OVERLAP[1] - OVERLAP[0]) * draw("overlap", x, y);
        const reach = ((1 - ov) * (m.measures.length + n.measures.length)) / 2;
        const dir = draw("dir", x, y) * 2 * Math.PI;
        if (draw("pair", x, y) < 0.75)
          put(
            out,
            n,
            cx + Math.cos(dir) * reach,
            cy + Math.sin(dir) * reach,
            ground,
            ground,
            Math.floor(draw("yaw2", x, y) * 24) * 15,
          );
      }
      // low pieces gather at the edges: sunk tufts and rocks, rare in the middle
      const lowPool = near && rocks.length > 0 && draw("rock", x, y) < 0.35 ? rocks : low;
      // (a place with no flat cover makes its clusters of low pieces: one at least, in the middle too)
      const least = flat.length === 0 ? 1 : 0;
      const lowCount =
        lowPool.length === 0
          ? 0
          : near
            ? 1 + Math.floor(draw("lows", x, y) * 2)
            : Math.max(least, draw("lows", x, y) < 0.2 ? 1 : 0);
      for (let i = 0; i < lowCount; i++) {
        // mixed within the pool, never three alike in a row
        let li = Math.floor(draw("low", x, y, i) * lowPool.length);
        const last = recent.get(lowPool) ?? [];
        if (lowPool.length > 1 && last.length >= 2 && last.slice(-2).every((r) => r === li))
          li = (li + 1) % lowPool.length;
        recent.set(lowPool, [...last.slice(-1), li]);
        const q = lowPool[li] as ArrangePiece;
        const sink = SINK[0] + (SINK[1] - SINK[0]) * draw("sink", x, y, i);
        const ang = draw("lowDir", x, y, i) * 2 * Math.PI;
        const r = 0.25 + 0.2 * draw("lowR", x, y, i);
        put(
          lows,
          q,
          cx + Math.cos(ang) * r,
          cy + Math.sin(ang) * r,
          ground,
          ground - Math.min(SINK_MAX, sink * q.measures.height),
          Math.floor(draw("lowYaw", x, y, i) * 24) * 15,
        );
      }
    }
    const all: Arrangement = [...out, ...lows];
    return all.length > 0 ? all : null;
  },
};
