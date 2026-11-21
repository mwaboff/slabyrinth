/**
 * Bridges: the bridge pass after the over-layer terrain (decks laid before the edges), the railings after the edges,
 * and the rubble at the ends of crumbling bridges with the features.
 * Owns BridgeRecords (the decks); the edges, the railings and the rubble read them. Reads: bridge areas and the chasm
 * bridges the chasm ops asked for (ChasmRecords.bridgeRequests), the floors and heights round each deck.
 * Writes: the deck cells (height along the span, material, BRIDGE flag, holes where broken or crumbled), the decks
 * (one ResolvedBridge each, with piers; which deck each cell is; crumble and the rubble spots at the ends), stair edges
 * on inclined spans, the railing edges on every intact deck edge over a drop, and the rubble features.
 */
import type { BridgeSpan, Material, Vec2, WallStyle } from "../../contracts/plan";
import { MATERIALS, PLAN_LIMITS } from "../../contracts/plan";
import type { ResolvedBridge, ResolvedFeature } from "../../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../../contracts/resolved";
import { featureInfo, rotatedSize } from "../../gen/catalog";
import { SIDES, stepSide } from "../../gen/gridGeometry";
import { elementSeed, h32, subSeed } from "../../util/hash";
import { createPrng } from "../../util/prng";
import { materialInfo, materialOrdinal } from "../materials";
import type { ChasmRecords } from "./chasms";
import type { FeatureWork } from "./features";
import { type AreaInfo, type ReadOnly, type ResolveGrid, RAILING_HEIGHT } from "./grid";

/** A bridge deck waiting for the bridge pass (area of kind "bridge" or a chasm op's bridge). */
export interface BridgeRequest {
  id: string;
  elementId: string;
  path: string;
  cells: number[];
  /** Deck material ordinal (materialOrdinal). */
  floorMat: number;
  /** Explicit deck height (quarter tiles) or null = infer from the floor it touches. */
  deck: number | null;
  /** Explicit railing (null = none); undefined = the span's default. */
  railing: WallStyle | null | undefined;
  broken: number[];
  crumble: number;
  seed: number;
  span?: BridgeSpan;
  /** Explicit rise of the middle (tiles). */
  arch?: number;
  /** Direction the deck runs (chasm bridges know it; areas use their longer side). */
  axis?: "h" | "v";
  label?: string;
}

/** The level's bridge decks. Written only by the bridge pass (stepBridges); read-only after it. */
export class BridgeRecords {
  /** One record per deck laid, in the order laid (ResolvedLevel.bridges). */
  readonly decks: ResolvedBridge[] = [];
  /** Per cell, the index + 1 of the deck on it (0 = not a deck). */
  readonly deckOf: Int32Array;
  /** Per deck (index + 1), how much of it crumbles and the seed it crumbles with (its parapet has the same gaps). */
  readonly crumble = new Map<number, { crumble: number; seed: number }>();
  /** Rubble at the ends of crumbling bridges, placed with the generated features (stepBridgeRubble). */
  readonly rubble: Array<{ id: string; at: Vec2 }> = [];

  constructor(cells: number) {
    this.deckOf = new Int32Array(cells);
  }
}

/** A raised deck (explicit height) laid by the bridge pass: whether anyone can get onto it is checked after all are. */
interface RaisedDeck {
  r: ReadOnly<BridgeRequest>;
  cells: number[];
  broken: ReadonlySet<number>;
  anchors: number;
  deck: number;
}

/** Deck geometry (layBridge, raisedDeckReached, stepRailings). Heights are in quarter tiles. */
const DECK = {
  /** A step a miniature walks (half a tile): deck to floor where you get on, between cells of the deck's profile. */
  walkStepQ: 2,
  /** On an inclined span, floor up to a tile from a deck cell (or a stair edge) is still a way on. */
  inclinedClimbQ: 4,
  /** An inclined span that climbs more than this per cell is steeper than a stair (warned). */
  stairRiseQ: 4,
  /** A span shorter than this keeps a level deck unless the plan gives an arch. */
  archMinLen: 4,
  /** Most of a deck's cells that may crumble. */
  maxCrumble: 0.6,
  /** Anchor cells within this many cells (Chebyshev) of each other are one end of the deck. */
  endReach: 2,
  /** A raised deck at least this far above the ground beneath stands on posts at its corners. */
  postClearQ: 4,
  /** Arch and flat spans this long or longer stand on piers at a third and two thirds of the way across. */
  pierMinLen: 5,
  /** Rubble pieces at a crumbling bridge's ends: 1 + round(crumble x this), as many as there are spots. */
  rubblePerCrumble: 4,
} as const;

/** Rise of the deck's middle (quarter tiles) by span; plank bridges sag. */
const SPAN_ARCH_Q: Record<BridgeSpan, number> = { arch: 3, flat: 0, plank: -1, natural: 1 };
const SPAN_RAILING: Record<BridgeSpan, WallStyle | null> = {
  arch: "railing_stone",
  flat: "railing_stone",
  plank: "railing",
  natural: null,
};

/**
 * Bridge pass: every bridge (areas of kind "bridge" in area order, then chasm bridges in op order) records what
 * lies under its cells, then lays the deck: height = explicit floorHeight or the highest floor it touches, its own
 * floor material, CELL_FLAG.BRIDGE, no walls toward open cells. Broken and crumbled cells become holes.
 */
export function stepBridges(work: ResolveGrid, out: BridgeRecords, chasms: ReadOnly<ChasmRecords>): void {
  const reqs: Array<ReadOnly<BridgeRequest>> = [];
  for (const info of work.areas) {
    if (!info.isBridge) continue;
    const cells = work.areaCells(info.index);
    if (cells.length === 0) continue;
    const a = info.area;
    const broken: number[] = [];
    (a.broken ?? []).forEach((c, k) => {
      const i = work.idx(c[0], c[1]);
      if (i >= 0 && work.struct[i] === info.index + 1) broken.push(i);
      else
        work.issue(
          "warning",
          "no_effect",
          `broken cell ${c[0]},${c[1]} of bridge "${a.id}" is not part of the bridge`,
          {
            path: `/levels/${work.li}/areas/${info.index}/broken/${k}`,
            elementId: a.id,
            cell: c,
            hint: "list only cells of the bridge's own shape",
          },
        );
    });
    const req: BridgeRequest = {
      id: a.id,
      elementId: a.id,
      path: `/levels/${work.li}/areas/${info.index}`,
      cells,
      floorMat: info.floorNone ? materialOrdinal("flagstone") : info.floorMat,
      deck: a.floorHeight !== undefined ? Math.round(a.floorHeight * 4) : null,
      railing: a.railing === "none" ? null : a.railing,
      broken,
      crumble: a.crumble ?? 0,
      seed: subSeed(elementSeed(work.plan.seed, a.id), "crumble"),
      ...(a.span !== undefined ? { span: a.span } : {}),
      ...(a.arch !== undefined ? { arch: a.arch } : {}),
    };
    if (a.name !== undefined) req.label = a.name;
    reqs.push(req);
  }
  reqs.push(...chasms.bridgeRequests);
  // raised decks (explicit height) first, so spans that climb to them meet their real height
  const ordered = [...reqs.filter((r) => r.deck !== null), ...reqs.filter((r) => r.deck === null)];
  const raised: RaisedDeck[] = [];
  for (const r of ordered) {
    const d = layBridge(work, r, out);
    if (d) raised.push(d);
  }
  // a raised deck may be reached by a bridge laid after it: checked once every deck is down
  for (const d of raised)
    if (!raisedDeckReached(work, d)) warnUnanchored(work, d.r, d.cells, d.anchors, d.deck);
}

/** Lays one deck; returns it when it is a raised deck whose way on is checked after every deck is laid. */
function layBridge(work: ResolveGrid, r: ReadOnly<BridgeRequest>, out: BridgeRecords): RaisedDeck | null {
  const k = out.decks.length + 1;
  const cells = r.cells.filter((i) => out.deckOf[i] === 0);
  if (cells.length === 0) return null;
  const inThis = new Set(cells);
  // deck height: explicit, else the highest open floor it touches (its ends)
  let touch = -Infinity;
  for (const i of cells) {
    for (const j of work.neighbours4(i)) {
      if (j < 0 || inThis.has(j) || work.state[j] !== CELL.OPEN) continue;
      if ((work.flags[j] as number) & CELL_FLAG.NO_FLOOR) continue;
      touch = Math.max(touch, work.height[j] as number);
    }
  }
  let deck =
    r.deck ?? (Number.isFinite(touch) ? touch : Math.max(...cells.map((i) => work.height[i] as number)));
  deck = Math.max(PLAN_LIMITS.minHeight * 4, Math.min(PLAN_LIMITS.maxHeight * 4, deck));
  // anchor cells: deck cells next to walkable floor within a 0.5 step of the deck (where you get on and off)
  const anchorCells: number[] = [];
  for (const i of cells) {
    const ok = work
      .neighbours4(i)
      .some(
        (j) =>
          j >= 0 &&
          !inThis.has(j) &&
          work.state[j] === CELL.OPEN &&
          ((work.flags[j] as number) & CELL_FLAG.NO_FLOOR) === 0 &&
          Math.abs((work.height[j] as number) - deck) <= DECK.walkStepQ,
      );
    if (ok) anchorCells.push(i);
  }
  // anchored at both ends = the anchors form at least two groups that are far apart (not one side of a pier)
  const under: number[] = [];
  const underMaterial: ResolvedBridge["underMaterial"] = [];
  for (const i of cells) {
    under.push(work.height[i] as number);
    const noFloor = ((work.flags[i] as number) & CELL_FLAG.NO_FLOOR) !== 0 || work.state[i] !== CELL.OPEN;
    const m = work.mat[i] as number;
    underMaterial.push(noFloor || m === 0 ? null : (MATERIALS[m - 1] as Material));
  }
  // span: arched / sagging deck along its axis, in 0.25 steps no more than 0.5 apart (walkable)
  const deckMat = MATERIALS[r.floorMat - 1] as Material;
  const span: BridgeSpan = r.span ?? materialInfo(deckMat).deckSpan;
  const cxy = cells.map((i) => work.cellXY(i));
  const bx0 = Math.min(...cxy.map((c) => c[0]));
  const bx1 = Math.max(...cxy.map((c) => c[0]));
  const by0 = Math.min(...cxy.map((c) => c[1]));
  const by1 = Math.max(...cxy.map((c) => c[1]));
  const axis = r.axis ?? (bx1 - bx0 >= by1 - by0 ? "h" : "v");
  const p0 = axis === "h" ? bx0 : by0;
  const len = (axis === "h" ? bx1 - bx0 : by1 - by0) + 1;
  const along = (i: number): number => {
    const [x, y] = work.cellXY(i);
    return (axis === "h" ? x : y) - p0;
  };
  // the floor beyond each end of the deck (along its axis): an inclined span joins two different heights
  const endHeight = (p: number, step: -1 | 1): number | null => {
    let best: number | null = null;
    for (const i of cells) {
      if (along(i) !== p) continue;
      const [x, y] = work.cellXY(i);
      const j = axis === "h" ? work.idx(x + step, y) : work.idx(x, y + step);
      if (j < 0 || inThis.has(j) || !work.isFloor(j)) continue;
      // a raised deck at the far end counts at its deck height, even before it is laid
      best = Math.max(
        best ?? -Infinity,
        out.deckOf[j] === 0
          ? (work.deckHeightOf(j) ?? (work.height[j] as number))
          : (work.height[j] as number),
      );
    }
    return best;
  };
  const h0 = endHeight(0, -1);
  const h1 = endHeight(len - 1, 1);
  const inclined = r.deck === null && h0 !== null && h1 !== null && h0 !== h1;
  const prof: number[] = [];
  if (inclined) {
    // inclined span: the deck climbs evenly from one end's floor to the other's; steps over 0.5 become stairs
    deck = h0;
    for (let p = 0; p < len; p++) prof.push(Math.round(((h1 - h0) * (len > 1 ? p + 1 : 1)) / (len + 1)));
  } else {
    const archQ =
      r.arch !== undefined ? Math.round(r.arch * 4) : len >= DECK.archMinLen ? SPAN_ARCH_Q[span] : 0;
    for (let p = 0; p < len; p++) {
      const t = len > 1 ? p / (len - 1) : 0.5;
      const u = 2 * t - 1;
      prof.push(Math.round(archQ * (1 - u * u)));
    }
    for (let pass = 0; pass < len; pass++)
      for (let p = 1; p < len; p++) {
        const a = prof[p - 1] as number;
        const b = prof[p] as number;
        if (b - a > DECK.walkStepQ) prof[p] = a + DECK.walkStepQ;
        if (a - b > DECK.walkStepQ) prof[p - 1] = b + DECK.walkStepQ;
      }
  }
  for (const i of cells) {
    work.state[i] = CELL.OPEN;
    work.height[i] = deck + (prof[along(i)] ?? 0);
    work.mat[i] = r.floorMat;
    work.flags[i] =
      ((work.flags[i] as number) & ~(CELL_FLAG.NO_FLOOR | CELL_FLAG.WATER | CELL_FLAG.PATH)) |
      CELL_FLAG.BRIDGE;
    out.deckOf[i] = k;
  }
  if (inclined) {
    const stepQ = Math.abs(h1 - h0) / (len + 1);
    if (stepQ > DECK.stairRiseQ)
      work.issue(
        "warning",
        "stairs_invalid",
        `bridge "${r.id}" climbs ${stepQ / 4} tiles per cell: steeper than a stair`,
        {
          path: r.path,
          elementId: r.elementId,
          hint: "make the span longer, or meet a lower point of the higher floor",
        },
      );
    // stair edges on the deck (and onto the floors at its ends) wherever a step is more than 0.5
    for (const i of cells)
      for (const j of work.neighbours4(i)) {
        if (j < 0 || !work.isFloor(j)) continue;
        const [ix, iy] = work.cellXY(i);
        const [jx, jy] = work.cellXY(j);
        if (axis === "h" ? jy !== iy : jx !== ix) continue; // only along the span
        if (Math.abs((work.height[j] as number) - (work.height[i] as number)) > DECK.walkStepQ)
          work.addStairEdge(i, j);
      }
    // anchors are where the deck meets floor at its own height or one step from it
    anchorCells.splice(0, anchorCells.length);
    for (const i of cells) {
      const ok = work
        .neighbours4(i)
        .some(
          (j) =>
            j >= 0 &&
            !inThis.has(j) &&
            work.isFloor(j) &&
            (Math.abs((work.height[j] as number) - (work.height[i] as number)) <= DECK.inclinedClimbQ ||
              work.hasStairEdge(i, j)),
        );
      if (ok) anchorCells.push(i);
    }
  }
  // broken cells: explicit, then crumble (seeded, never cutting the way between the anchors)
  const broken = new Set<number>(r.broken.filter((i) => inThis.has(i)));
  const anchorSet = new Set(anchorCells);
  const connected = (): boolean => {
    const live = anchorCells.filter((i) => !broken.has(i));
    if (live.length <= 1) return true;
    const seen = new Set<number>([live[0] as number]);
    const q = [live[0] as number];
    while (q.length > 0) {
      const i = q.pop() as number;
      for (const j of work.neighbours4(i))
        if (j >= 0 && inThis.has(j) && !broken.has(j) && !seen.has(j)) {
          seen.add(j);
          q.push(j);
        }
    }
    return live.every((i) => seen.has(i));
  };
  const target = Math.round(Math.min(DECK.maxCrumble, Math.max(0, r.crumble)) * cells.length);
  if (target > 0) {
    const rng = createPrng(r.seed);
    // outer cells (next to the drop) crumble first, then the rest
    const outer = cells.filter(
      (i) => !anchorSet.has(i) && work.neighbours4(i).some((j) => j < 0 || !inThis.has(j)),
    );
    const inner = cells.filter((i) => !anchorSet.has(i) && !outer.includes(i));
    let n = 0;
    for (const i of [...rng.shuffle(outer), ...rng.shuffle(inner)]) {
      if (n >= target) break;
      if (broken.has(i)) continue;
      broken.add(i);
      if (connected()) n++;
      else broken.delete(i);
    }
  }
  for (const i of broken) {
    work.flags[i] = (work.flags[i] as number) | CELL_FLAG.NO_FLOOR;
    work.mat[i] = 0;
  }
  const sorted = cells.map((i, j) => ({ i, j })).sort((a, b) => a.i - b.i);
  // piers: long arch and flat spans stand on stone piers at a third and two thirds of the way across
  const piers: Vec2[] = [];
  // a raised deck on supports (watchtower, gallows, scaffold, pier): explicit height, well above the ground beneath
  // it: posts at its corners
  if (r.deck !== null) {
    const corners = new Set([work.idx(bx0, by0), work.idx(bx1, by0), work.idx(bx0, by1), work.idx(bx1, by1)]);
    sorted.forEach(({ i, j }) => {
      if (
        corners.has(i) &&
        underMaterial[j] !== null &&
        deck - (under[j] as number) >= DECK.postClearQ &&
        !broken.has(i)
      )
        piers.push(work.cellXY(i));
    });
  } else if ((span === "arch" || span === "flat") && len >= DECK.pierMinLen) {
    const at = new Set([Math.round((len - 1) / 3), Math.round((2 * (len - 1)) / 3)]);
    sorted.forEach(({ i, j }) => {
      if (at.has(along(i)) && underMaterial[j] !== null && !broken.has(i)) piers.push(work.cellXY(i));
    });
  }
  // a crumbling bridge sheds rubble at its ends
  if (r.crumble > 0) {
    const rng = createPrng(subSeed(r.seed, "rubble"));
    const spots: Vec2[] = [];
    for (const i of anchorCells)
      for (const j of work.neighbours4(i))
        if (j >= 0 && !inThis.has(j) && work.isFloor(j) && out.deckOf[j] === 0) spots.push(work.cellXY(j));
    const pickN = Math.min(spots.length, 1 + Math.round(r.crumble * DECK.rubblePerCrumble));
    rng
      .shuffle(spots)
      .slice(0, pickN)
      .forEach((at, n) => out.rubble.push({ id: `${r.id}#rubble${n}`, at }));
  }
  out.crumble.set(k, { crumble: r.crumble, seed: r.seed });
  const rec: ResolvedBridge = {
    id: r.id,
    cells: sorted.map(({ i }) => work.cellXY(i)),
    broken: [...broken].sort((a, b) => a - b).map((i) => work.cellXY(i)),
    deck,
    under: sorted.map(({ j }) => under[j] as number),
    underMaterial: sorted.map(({ j }) => underMaterial[j] ?? null),
    railing: r.railing === undefined ? SPAN_RAILING[span] : r.railing,
    span,
  };
  if (piers.length > 0) rec.piers = piers;
  if (r.label !== undefined) rec.label = r.label;
  out.decks.push(rec);
  // ends: a real bridge touches walkable floor on two sides that are not next to each other
  const groups = groupCount(work, anchorCells);
  const anchors = anchorCells.length;
  // anchored = walkable floor beyond BOTH ends along the span (within a step of the deck there, or by stairs)
  const endOk = (p: number, step: -1 | 1): boolean =>
    cells.some((i) => {
      if (along(i) !== p || broken.has(i)) return false;
      const [x, y] = work.cellXY(i);
      const j = axis === "h" ? work.idx(x + step, y) : work.idx(x, y + step);
      if (j < 0 || inThis.has(j) || !work.isFloor(j)) return false;
      return (
        Math.abs((work.height[j] as number) - (work.height[i] as number)) <= DECK.walkStepQ ||
        work.hasStairEdge(i, j)
      );
    });
  // a raised deck (explicit height) needs one way on and off, which another bridge laid after it may give
  if (r.deck !== null) return { r, cells, broken, anchors, deck };
  if (!(endOk(0, -1) && endOk(len - 1, 1)) && (anchors === 0 || groups < 2))
    warnUnanchored(work, r, cells, anchors, deck);
  return null;
}

/** A raised deck is reached when floor beside an intact cell lies within a step of it, or a stair leads to it. */
function raisedDeckReached(work: ResolveGrid, d: RaisedDeck): boolean {
  const inThis = new Set(d.cells);
  return d.cells.some(
    (i) =>
      !d.broken.has(i) &&
      work
        .neighbours4(i)
        .some(
          (j) =>
            j >= 0 &&
            !inThis.has(j) &&
            work.isFloor(j) &&
            (Math.abs((work.height[j] as number) - (work.height[i] as number)) <= DECK.walkStepQ ||
              work.hasStairEdge(i, j)),
        ),
  );
}

function warnUnanchored(
  work: ResolveGrid,
  r: ReadOnly<BridgeRequest>,
  cells: readonly number[],
  anchors: number,
  deck: number,
): void {
  const first = work.cellXY(cells[0] as number);
  work.issue(
    "warning",
    "bridge_unanchored",
    anchors === 0
      ? `bridge "${r.id}" touches no walkable floor at deck height ${deck / 4}: nobody can get onto it`
      : `bridge "${r.id}" reaches walkable floor at one end only`,
    {
      path: r.path,
      elementId: r.elementId,
      cell: first,
      hint:
        r.deck !== null
          ? "add a stairs terrain op from the ground to its edge, or a bridge that climbs to it"
          : "make it span from floor to floor (extend it over the whole drop), or set floorHeight to the height of the floor at its ends",
    },
  );
}

/** Number of groups of anchor cells, where anchors within `DECK.endReach` of each other count as one group. */
function groupCount(work: ResolveGrid, anchors: number[]): number {
  const xy = anchors.map((i) => work.cellXY(i));
  const group = new Int32Array(xy.length).fill(-1);
  let g = 0;
  for (let s = 0; s < xy.length; s++) {
    if (group[s] !== -1) continue;
    group[s] = g;
    const q = [s];
    while (q.length > 0) {
      const a = q.pop() as number;
      const pa = xy[a] as [number, number];
      for (let b = 0; b < xy.length; b++) {
        if (group[b] !== -1) continue;
        const pb = xy[b] as [number, number];
        if (Math.max(Math.abs(pa[0] - pb[0]), Math.abs(pa[1] - pb[1])) <= DECK.endReach) {
          group[b] = g;
          q.push(b);
        }
      }
    }
    g++;
  }
  return g;
}

/** Railings: a WALL (the bridge's railing style, 1 tile) on every intact deck edge that faces a drop. */
export function stepRailings(work: ResolveGrid, bridges: ReadOnly<BridgeRecords>): void {
  bridges.decks.forEach((b, bi) => {
    if (b.railing === null) return;
    const k = bi + 1;
    for (const [x, y] of b.cells) {
      const i = work.idx(x, y);
      if (i < 0 || (work.flags[i] as number) & CELL_FLAG.NO_FLOOR) continue;
      for (const side of SIDES) {
        const [nx, ny] = stepSide(x, y, side);
        const j = work.idx(nx, ny);
        if (j < 0 || work.state[j] !== CELL.OPEN || bridges.deckOf[j] === k) continue;
        const drop =
          ((work.flags[j] as number) & CELL_FLAG.NO_FLOOR) !== 0 ||
          (work.height[j] as number) < Math.min(b.deck, work.height[i] as number) - DECK.walkStepQ;
        if (!drop) continue;
        // a crumbling bridge has gaps in its parapet too
        const cr = bridges.crumble.get(k);
        if (cr && cr.crumble > 0 && h32(`${cr.seed}:parapet:${x}:${y}:${side}`) / 4294967296 < cr.crumble)
          continue;
        const ed = work.sideEdge(x, y, side);
        if (!ed) continue;
        ed.e.kind[ed.i] = EDGE.WALL;
        ed.e.style[ed.i] = b.railing;
        ed.e.height[ed.i] = RAILING_HEIGHT;
        // the railing stands on the deck: host on the deck cell (first = N/W cell of the edge)
        ed.e.hostSet[ed.i] = side === "N" || side === "W" ? 1 : 0;
      }
    }
  });
}

/** Rubble at the ends of crumbling bridges (generated features "<bridgeId>#rubble<n>"). */
export function stepBridgeRubble(
  work: ResolveGrid,
  features: FeatureWork,
  bridges: ReadOnly<BridgeRecords>,
): void {
  const info = featureInfo("rubble");
  for (const r of bridges.rubble) {
    const size = rotatedSize(info.size, 0);
    if (work.featureProblem("rubble", r.at, size, undefined) !== null) continue;
    const anchor = work.idx(r.at[0], r.at[1]);
    const rf: ResolvedFeature = {
      id: r.id,
      type: "rubble",
      generatedBy: r.id.split("#")[0] as string,
      at: [r.at[0], r.at[1]],
      size,
      rot: 0,
      rotFine: (h32(r.id) % 24) * 15,
      baseHeight: work.featureBase(anchor, 0),
      theme: work.themes[anchor >= 0 ? (work.theme[anchor] as number) : 0] ?? work.levelTheme,
      blocking: info.blocking,
    };
    const ar = anchor >= 0 ? (work.disp[anchor] as number) : 0;
    if (ar > 0) rf.area = (work.areas[ar - 1] as AreaInfo).area.id;
    features.addGenerated(rf);
  }
}
