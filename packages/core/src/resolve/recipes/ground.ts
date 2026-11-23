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
import {
  COVER_RASTER,
  coverKind,
  coveredSamples,
  sampleCell,
  type CoverShape,
} from "../../util/visibleCover";
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

/**
 * Clusters (generator 5, `groundClusters`): an anchor piece (a bush, a larger rock, a tall tuft: ANCHOR_H tall, at most
 * ANCHOR_L long) with companions round it, COMPANIONS in the middle and more where ground meets an edge. Low pieces sink
 * SINK_DEEP of their height, at most SINK_DEEP_MAX (ground tiles are half a tile thick: verify takes a piece sunk into a
 * floor piece under its centre as resting in it), and a low or flat companion may lean PATH_LEAN over a path's edge
 * (its centre stays on the ground), so the path's line breaks up.
 */
const ANCHOR_H = [0.45, 1.25] as const;
const ANCHOR_L = 2;
const COMPANIONS = { middle: [2, 3], edge: [3, 4] } as const;
const SINK_DEEP = [0.3, 0.5] as const;
const SINK_DEEP_MAX = 0.3;
const PATH_LEAN = 0.35;
/** A layout's footprints, less what they lie over each other (about this share kept); its rate corrected within these. */
const OVERLAP_KEPT = 0.75;
const CORRECTION = [0.5, 3] as const;
/** Share of a natural place's clusters that are anchored (the rest are the flat-pair clusters). */
const ANCHORED = { middle: 0.45, edge: 0.7 } as const;

/**
 * Generator 5 (`visibleGround`), measured on the owner's screenshots of the varied street (the box measure said 30-42 %,
 * the street showed 10-15 % spread evenly, litter far from any street): cover is laid to a share of what is SEEN
 * (util/visibleCover.ts), gathered where ground meets something and opened up in the middle:
 *   the edge band (a step from an edge) gets BAND_SHARE times the place's share (at most BAND_MAX), a corner more;
 *   the middle MIDDLE_SHARE times it, as anchored clumps only;
 *   flat cover (litter, pebbles) only within USE_REACH of a door's apron, a lane or a path.
 */
const BAND_SHARE = 1.6;
const BAND_MAX = 0.6;
const MIDDLE_SHARE = 0.15;
const USE_REACH = 2;
/** A cell with more than three of its eight neighbours off the place (an inner corner) weighs this much more each. */
const CORNER_STEP = 0.5;
/** A sunk piece's centre stands at least this far from another floor height or a missing floor. */
const SUNK_CLEAR = 0.35;
const CORNER_MAX = 2;
const AROUND = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const;

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

/**
 * (groundClusters) The pieces tall enough to anchor a cluster, from every slot of a natural place: its bushes, then its
 * rocks, flowers, tufts and cover of ANCHOR_H, at most ANCHOR_L long; each piece once.
 */
function anchorsOf(slots: Readonly<Record<string, FilledSlot>>): ArrangePiece[] {
  const seen = new Set<string>();
  return ["anchor", "rock", "bloom", "grass", "cover"]
    .flatMap((k) => piecesOf(slots[k]))
    .filter((p) => {
      const k = `${p.role}|${p.variant.wanted}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return (
        p.measures.height >= ANCHOR_H[0] && p.measures.height <= ANCHOR_H[1] && p.measures.length <= ANCHOR_L
      );
    });
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
    // (groundClusters) a cluster's anchor: a bush, a larger rock or a tall tuft, on natural ground outdoors
    anchor: {
      roles: (a, _t, ctx) =>
        a.indoor || !a.natural || ctx?.profile.groundClusters !== true ? [] : [{ role: "feature.bush" }],
      fallback: "simplify",
    },
    rubble: {
      roles: (a) => (a.wear > 0 ? [{ role: "feature.rubble" }, { role: "feature.debris" }] : []),
      fallback: "simplify",
    },
  },
  compose: (a, slots, ctx) => {
    const { flat, low, rocks } = pools(a, slots);
    if (flat.length === 0 && low.length === 0) return null;
    const clusters = ctx.profile.groundClusters;
    const share = coverOf(a) * (ctx.variant in VARIANT ? VARIANT[ctx.variant as keyof typeof VARIANT] : 1);
    const edgesOnly = ctx.variant === "edges";
    const open = openCells(a, ctx);
    const cells = open.filter(([x, y]) => !edgesOnly || a.edgeAt(x, y) <= 1);
    if (cells.length === 0 || share <= 0) return null;
    // (visibleGround) the edge and the middle are laid at rates of their own, a corner more than a straight edge
    // (outdoors only: a room's floor cover keeps its own rule, among furniture the room furnisher places)
    const visible = ctx.profile.visibleGround && clusters && !a.indoor;
    const outsideAround = (x: number, y: number): number => {
      let n = 0;
      for (const [dx, dy] of AROUND) if (a.classAt(x + dx, y + dy) === 0) n++;
      return n;
    };
    const rates = { edge: 1, middle: 1 };
    const weightOf = (x: number, y: number): number => {
      const d = a.edgeAt(x, y);
      if (visible)
        return d <= 1
          ? NEAR_WEIGHT *
              rates.edge *
              Math.min(CORNER_MAX, 1 + CORNER_STEP * Math.max(0, outsideAround(x, y) - 3))
          : rates.middle;
      return d <= 1 ? NEAR_WEIGHT : d <= NEAR_REACH + 0.5 ? 1.5 : 1;
    };
    // (visibleGround) where the place is used: within USE_REACH of a door's apron, a lane or a path; flat cover (litter,
    // pebbles) lies only there
    const useCells = new Set<string>();
    if (visible)
      for (const [x, y] of a.cells) {
        const used =
          (a.classAt(x, y) & (ZONE.LANE | ZONE.DOOR)) !== 0 ||
          ((ctx.level.cells.flags[ctx.anchors.grid.index(x, y)] ?? 0) & CELL_FLAG.PATH) !== 0;
        if (!used) continue;
        for (let dy = -USE_REACH; dy <= USE_REACH; dy++)
          for (let dx = -USE_REACH; dx <= USE_REACH; dx++) useCells.add(`${x + dx},${y + dy}`);
      }
    const nearUse = (x: number, y: number): boolean => !visible || useCells.has(`${x},${y}`);
    // a cluster covers about its main flat piece and (three times in four) a partner, less their overlap and what
    // is left out at a path or a drop
    const main = flat.length > 0 ? flat : low;
    const meanOf = (ps: readonly ArrangePiece[]): number =>
      ps.length === 0 ? 0 : ps.reduce((s, p) => s + p.measures.footprint, 0) / ps.length;
    const mean = meanOf(main);
    const clusterArea = mean * (flat.length > 0 ? 1.45 : 1) + (low.length > 0 ? 0.15 : 0);
    // (groundClusters) anchored clusters: an anchor piece and its companions, more of them at an edge
    const anchors = clusters ? anchorsOf(slots) : [];
    const companions = [...low, ...flat];
    const anchoredAt = (near: boolean): number =>
      anchors.length === 0 ? 0 : near ? ANCHORED.edge : ANCHORED.middle;
    const areaAt = (near: boolean): number => {
      if (!clusters) return clusterArea;
      const [c0, c1] = near ? COMPANIONS.edge : COMPANIONS.middle;
      const anchored = meanOf(anchors) + meanOf(companions) * ((c0 + c1) / 2) * 0.8;
      const pa = anchoredAt(near);
      return pa * anchored + (1 - pa) * clusterArea;
    };
    const total = cells.reduce(
      (s, [x, y]) => s + weightOf(x, y) * (clusters ? areaAt(a.edgeAt(x, y) <= 1) : 1),
      0,
    );
    // (groundClusters: the share is of the whole place's open ground for every variant; "edges" gathers it at them)
    const k = clusters ? (share * open.length) / total : (share * cells.length) / (clusterArea * total);
    const g = ctx.anchors.grid;
    const f = a.frame;
    const draw = (what: string, x: number, y: number, i = 0): number =>
      hashUnitMixed(ctx.seed, "ground", what, x, y, i);
    const out: Placed[] = [];
    const lows: Placed[] = [];
    const recent = new Map<readonly ArrangePiece[], number[]>();
    // a piece lies wholly on this place's own floor at the cluster's height (never over water, a path, a drop or a wall)
    const fits = (qx: number, qy: number, top: number, keepOff: number): boolean => {
      const cx = Math.floor(qx);
      const cy = Math.floor(qy);
      const c = g.cell(cx, cy);
      return (
        c.floor &&
        a.classAt(cx, cy) !== 0 &&
        Math.abs(g.top(cx, cy) - top) < 0.01 &&
        ((ctx.level.cells.flags[g.index(cx, cy)] ?? 0) & keepOff) === 0
      );
    };
    // (`lean`, groundClusters: a corner may lie up to PATH_LEAN over a path's edge, never in a lane or an apron)
    const onGround = (
      px: number,
      py: number,
      p: ArrangePiece,
      yaw: number,
      top: number,
      lean = false,
    ): boolean => {
      const h = turnedHalfExtents(p.variant.geom.size.x, p.variant.geom.size.z, yaw);
      if (!fits(px, py, top, KEEP_OFF)) return false;
      return [
        [px - h.x, py - h.z],
        [px + h.x, py - h.z],
        [px - h.x, py + h.z],
        [px + h.x, py + h.z],
      ].every(([qx = 0, qy = 0]) => {
        if (fits(qx, qy, top, KEEP_OFF)) return true;
        if (!lean || !fits(qx, qy, top, KEEP_OFF & ~CELL_FLAG.PATH)) return false;
        if ((a.classAt(Math.floor(qx), Math.floor(qy)) & (ZONE.LANE | ZONE.DOOR)) !== 0) return false;
        // the corner pulled PATH_LEAN back toward the centre is off the path
        const d = Math.hypot(px - qx, py - qy);
        const t = d <= PATH_LEAN ? 1 : PATH_LEAN / d;
        return fits(qx + (px - qx) * t, qy + (py - qy) * t, top, KEEP_OFF);
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
      lean = false,
    ): void => {
      if (!onGround(px, py, p, yaw, top, lean)) return;
      // (visibleGround: with cover gathered at edges, a sunk piece's centre keeps SUNK_CLEAR from any other floor
      // height or missing floor, so verify finds the ground tile it is sunk into under its centre)
      if (
        visible &&
        y < top - 1e-6 &&
        !AROUND.every(([dx, dy]) => fits(px + dx * SUNK_CLEAR, py + dy * SUNK_CLEAR, top, KEEP_OFF))
      )
        return;
      const q = single(p, yaw)[0] as Placed;
      into.push({ ...q, x: px - f.at[0], z: f.at[1] - py, y: y - f.base });
    };
    // how deep a low piece sinks: a little (verify's support slack), or (groundClusters) into the ground tile
    // (visibleGround: only soil takes a piece deep; paving is a thin tile a piece lies on)
    const sunk = (q: ArrangePiece, u: number): number =>
      clusters && (!visible || a.natural)
        ? Math.min(SINK_DEEP_MAX, (SINK_DEEP[0] + (SINK_DEEP[1] - SINK_DEEP[0]) * u) * q.measures.height)
        : Math.min(SINK_MAX, (SINK[0] + (SINK[1] - SINK[0]) * u) * q.measures.height);
    const yawOf = (u: number): number => Math.floor(u * 24) * 15;
    // one layout at a cluster rate `rate`
    const lay = (rate: number): void => {
      out.length = 0;
      lows.length = 0;
      recent.clear();
      for (const [x, y] of cells) layCell(rate, x, y);
    };
    const layCell = (rate: number, x: number, y: number): void => {
      const p = Math.min(0.85, rate * weightOf(x, y) * ctx.density);
      if (draw("keep", x, y) >= p) return;
      const ground = g.top(x, y);
      const cx = x + 0.2 + 0.6 * draw("x", x, y);
      const cy = y + 0.2 + 0.6 * draw("y", x, y);
      const near = a.edgeAt(x, y) <= 1;
      const used = nearUse(x, y);
      // (visibleGround) the open middle has clumps only: an anchored cluster, never a lone flat pair
      if (visible && !near && anchors.length === 0) return;
      if (clusters && (draw("anchored", x, y) < anchoredAt(near) || (visible && !near))) {
        // an anchor piece, sunk, with its companions round it (flat ones lying, low ones sunk), mixed by hash
        const m = anchors[Math.floor(draw("anchor", x, y) * anchors.length)] as ArrangePiece;
        put(
          lows,
          m,
          cx,
          cy,
          ground,
          ground - sunk(m, draw("anchorSink", x, y)),
          yawOf(draw("anchorYaw", x, y)),
        );
        const [c0, c1] = near ? COMPANIONS.edge : COMPANIONS.middle;
        const n = c0 + Math.floor(draw("companions", x, y) * (c1 - c0 + 1));
        const turn0 = draw("ring", x, y) * 2 * Math.PI;
        // (visibleGround: flat companions, litter and pebbles, only where the place is used)
        const mates = used || low.length === 0 ? companions : low;
        for (let i = 0; i < n && mates.length > 0 && (used || !visible || low.length > 0); i++) {
          const q = mates[Math.floor(draw("companion", x, y, i) * mates.length)] as ArrangePiece;
          const ang = turn0 + (i * 2 * Math.PI) / n + (draw("ringJit", x, y, i) - 0.5) * 0.9;
          const r = 0.4 * m.measures.length + 0.3 * q.measures.length + 0.15 * draw("ringR", x, y, i);
          const isFlat = q.measures.height <= FLAT_H;
          const top = isFlat ? ground : ground - sunk(q, draw("sink", x, y, i));
          put(
            isFlat ? out : lows,
            q,
            cx + Math.cos(ang) * r,
            cy + Math.sin(ang) * r,
            ground,
            top,
            yawOf(draw("lowYaw", x, y, i)),
            true,
          );
        }
        return;
      }
      if (flat.length > 0 && used) {
        const m = flat[Math.floor(draw("flat", x, y) * flat.length)] as ArrangePiece;
        const yaw = Math.floor(draw("yaw", x, y) * 24) * 15;
        put(out, m, cx, cy, ground, ground, yaw, clusters);
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
            clusters,
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
        const ang = draw("lowDir", x, y, i) * 2 * Math.PI;
        const r = 0.25 + 0.2 * draw("lowR", x, y, i);
        put(
          lows,
          q,
          cx + Math.cos(ang) * r,
          cy + Math.sin(ang) * r,
          ground,
          ground - sunk(q, draw("sink", x, y, i)),
          Math.floor(draw("lowYaw", x, y, i) * 24) * 15,
          clusters,
        );
      }
    };
    lay(k);
    if (visible) {
      // (visibleGround) the edge and the middle each corrected to their own share of VISIBLE cover (the pieces' seen
      // area, util/visibleCover.ts), twice, each step within CORRECTION
      const openSet = new Set(open.map(([x, y]) => `${x},${y}`));
      const edgeCells = open.filter(([x, y]) => a.edgeAt(x, y) <= 1).length;
      const middleCells = open.length - edgeCells;
      const want = { edge: Math.min(BAND_MAX, share * BAND_SHARE), middle: share * MIDDLE_SHARE };
      for (let step = 0; step < 2; step++) {
        const shapes: CoverShape[] = [...out, ...lows].map((q) => ({
          x: q.x + f.at[0],
          y: f.at[1] - q.z,
          sx: q.piece.variant.geom.size.x,
          sz: q.piece.variant.geom.size.z,
          yaw: f.turn + q.yaw,
          kind: coverKind(q.piece.role, q.piece.measures.height),
        }));
        const seen = { edge: 0, middle: 0 };
        for (const s of coveredSamples(shapes, (cx, cy) => openSet.has(`${cx},${cy}`))) {
          const [cx, cy] = sampleCell(s);
          if (a.edgeAt(cx, cy) <= 1) seen.edge++;
          else seen.middle++;
        }
        const per = COVER_RASTER * COVER_RASTER;
        const fix = (part: "edge" | "middle", cellsOf: number): void => {
          if (cellsOf === 0) return;
          const got = seen[part] / (per * cellsOf);
          rates[part] *=
            got > 0 ? Math.min(CORRECTION[1], Math.max(CORRECTION[0], want[part] / got)) : CORRECTION[1];
        };
        fix("edge", edgeCells);
        fix("middle", middleCells);
        lay(k);
      }
    } else if (clusters) {
      // (groundClusters) the estimate is corrected once by what the layout really covered (pieces that did not fit at
      // an edge, a path or a drop): the rate is scaled to the target, within CORRECTION
      const laid = [...out, ...lows].reduce((s, q) => s + q.piece.measures.footprint, 0) * OVERLAP_KEPT;
      const target = share * open.length;
      if (laid > 0) lay(k * Math.min(CORRECTION[1], Math.max(CORRECTION[0], target / laid)));
    }
    const all: Arrangement = [...out, ...lows];
    return all.length > 0 ? all : null;
  },
};
