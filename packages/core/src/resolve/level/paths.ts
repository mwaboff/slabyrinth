/**
 * Path ops after they are drawn (resolve/level/terrain.ts): pavements beside roads, the road records and their kerbs,
 * kerbs along kerbed paths, spur trails to focal pieces and doors, and parking a vehicle in a kerb lane.
 * Pavements are laid with each terrain layer and run on to building fronts once the pads are flat (step 4); roads and
 * kerbs are recorded after the edges (step 5); vehicles are parked when the plan's features are placed (step 8).
 * Owns PathRecords: the path ops queue their roads and kerbed paths there as they are drawn (terrain.ts), and this
 * module turns them into `roads` and `kerbs`. Reads: the queued roads and kerbed paths, the cells' floors, heights and
 * flags, the buildings' lots and porches. Writes: pavement and spur cells (floor, height, PATH flag), each queued
 * road's pavement cells, and `roads` and `kerbs` (records on the resolved level).
 */
import type { Material, TerrainOp, Vec2 } from "../../contracts/plan";
import type { ResolvedLevel } from "../../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../../contracts/resolved";
import { SIDES, SIDE_STEP, stepSide } from "../../gen/gridGeometry";
import { forEachMaskCell } from "../../gen/mask";
import { ValueNoise } from "../../gen/noise";
import { rasterPolyline } from "../../gen/shapes";
import { elementSeed, h32, subSeed } from "../../util/hash";
import { isWater, materialOrdinal } from "../materials";
import { crossingCells, kerbLinesAndCorners } from "../road";
import { trailCells } from "../trail";
import type { ReadOnly, ResolveGrid } from "./grid";

/** A path op in road form (generator 2) as drawn: its carriageway cells and the pavement cells laid beside it so far. */
export interface PendingRoad {
  op: Extract<TerrainOp, { op: "path" }>;
  axis: Vec2[];
  layer: "under" | "over";
  cells: number[];
  /** Pavement cells with the height each was laid at (a cell a later stage changes is no longer pavement). */
  pave: Array<{ i: number; h: number }>;
}

/** A path op with `kerb: true` as drawn: its cells, waiting for kerbs once the edges are known. */
export interface PendingKerb {
  cells: Set<number>;
  material: Material;
  seed: number;
  anchors: Vec2[];
  /** Natural trails get broken kerbs (stones on the verge); straight paths a continuous line. */
  natural: boolean;
}

/** The level's paths: queued by the path ops (terrain.ts), finished by this module, then read-only. */
export class PathRecords {
  readonly pendingRoads: PendingRoad[] = [];
  readonly pendingKerbs: PendingKerb[] = [];
  /** Roads with their carriageway, pavements, kerb lines and crossings (ResolvedLevel.roads), after the edges. */
  readonly roads: NonNullable<ResolvedLevel["roads"]> = [];
  /** Kerb pieces (ResolvedLevel.kerbs), after the edges. */
  readonly kerbs: NonNullable<ResolvedLevel["kerbs"]> = [];
}

/** Pavements beside roads (stepPavements, stepRoads). Heights are in quarter tiles. */
const PAVEMENT = {
  /** A sidewalk's raise (tiles) when the path op gives none. */
  defaultRaise: 0.25,
  /** A building front (its wall ring included) at most this many cells beyond a pavement draws the pavement on to it. */
  reachToFront: 3,
} as const;

/** Kerb pieces along roads (stepRoads) and along kerbed paths (stepKerbs). */
const KERB = {
  /** Most height difference (quarter tiles) between a carriageway cell and the pavement it kerbs. */
  roadStepQ: 2,
  /** Most height difference (quarter tiles) between a kerbed path cell and the floor beside it. */
  pathStepQ: 1,
  /** A natural trail has no kerb within this many cells (Chebyshev) of what it joins. */
  anchorClear: 2,
  /** Cells per noise unit of a natural trail's broken kerbs. */
  noiseScale: 2.5,
  /** A natural trail keeps a kerb where the noise is at least this (about 40% of the edges). */
  keepFrom: 0.58,
  /** Noise offset per side, so the four sides of one cell draw apart. */
  sideOffset: { N: 0.3, S: 0.6, E: 0.9, W: 0.1 },
} as const;

/** Spur trails to focal pieces and doors (stepPathSpurs). */
const SPUR = {
  /** No spur when a path already passes within this many cells (Chebyshev) of the target. */
  nearPath: 3,
  /** The same for an exact target (generator 3: a door cell, the focal piece): the path must touch it. */
  nearPathExact: 1,
  /** Trail width (cells) and wander (trailCells). */
  width: 1,
  wander: 0.4,
} as const;

/** Landmark-class pieces a spur trail leads to (the first found), then lesser focal pieces. */
const SPUR_PRIMARY = new Set<string>([
  "landmark",
  "statue_large",
  "monolith",
  "tree_large",
  "giant_mushroom",
]);
const SPUR_FOCAL = new Set<string>([
  "statue",
  "altar",
  "fountain",
  "well",
  "standing_stone",
  "tall_marker",
  "campfire",
  "fire_pit",
]);

/**
 * After the building pads are flattened: the cells between a pavement and a building face (the wall ring the pad
 * flattened, a 1-cell setback) take the pavement's height and material, so no strip at road level runs along a
 * frontage. Footprints, porches, stair and link cells and anything higher than the pavement (a plinth) keep theirs.
 */
export function stepPavementFronts(work: ResolveGrid, paths: PathRecords): void {
  if (!work.profile.roads || !work.structs) return;
  type Road = PendingRoad;
  const owner = new Map<number, Road>();
  for (const r of paths.pendingRoads) for (const p of r.pave) owner.set(p.i, r);
  if (owner.size === 0) return;
  const footprint = work.structs.occupied();
  const keep = new Set<string>(footprint.keys());
  for (const b of work.structs.buildings)
    for (const p of b.porches) for (const c of p.cells) keep.add(`${c[0]},${c[1]}`);
  const nearFootprint = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (footprint.has(`${x + dx},${y + dy}`)) return true;
    return false;
  };
  const carriage = new Set<number>();
  for (const r of paths.pendingRoads) for (const i of r.cells) carriage.add(i);
  const add: Array<{ i: number; h: number; r: Road }> = [];
  for (let i = 0; i < work.state.length; i++) {
    if (owner.has(i) || carriage.has(i) || work.state[i] !== CELL.OPEN) continue;
    const [x, y] = work.cellXY(i);
    if (keep.has(`${x},${y}`) || !nearFootprint(x, y)) continue;
    const f = work.flags[i] as number;
    if (
      (f & (CELL_FLAG.WATER | CELL_FLAG.BRIDGE | CELL_FLAG.NO_FLOOR | CELL_FLAG.LINK | CELL_FLAG.STEPS)) !==
      0
    )
      continue;
    // the highest pavement beside it (a pavement height is current only while the cell still holds it)
    let best: { h: number; r: Road } | null = null;
    for (const side of SIDES) {
      const [dx, dy] = SIDE_STEP[side];
      const j = work.idx(x + dx, y + dy);
      const r = j >= 0 ? owner.get(j) : undefined;
      if (!r || j < 0) continue;
      const h = work.height[j] as number;
      if (r.pave.some((p) => p.i === j && p.h === h) && (!best || h > best.h)) best = { h, r };
    }
    // (a building pad now stands level with the pavement: an equal-height ring cell is paved too)
    if (!best || (work.height[i] as number) > best.h) continue;
    add.push({ i, h: best.h, r: best.r });
  }
  for (const { i, h, r } of add) {
    const sw = r.op.sidewalk;
    if (!sw) continue;
    work.setMaterial(i, sw.material);
    work.height[i] = h;
    r.pave.push({ i, h });
  }
}

/** Lays the pavements of this layer's roads: beside the carriageway, never on any road's carriageway or a building. */
export function stepPavements(work: ResolveGrid, layer: "under" | "over", paths: PathRecords): void {
  if (!work.profile.roads) return;
  const carriage = new Set<number>();
  for (const r of paths.pendingRoads) for (const i of r.cells) carriage.add(i);
  const paved = new Set<number>();
  for (const r of paths.pendingRoads) for (const p of r.pave) paved.add(p.i);
  const lots = work.structs?.occupied();
  for (const r of paths.pendingRoads) {
    const sw = r.op.sidewalk;
    if (r.layer !== layer || !sw) continue;
    const raise = Math.round((sw.raise ?? PAVEMENT.defaultRaise) * 4);
    // a building's lot: its footprint and the ring of cells around it (its walls and pad)
    const inLot = (x: number, y: number): boolean => {
      const i = work.idx(x, y);
      return i >= 0 && (lots?.has(`${x},${y}`) === true || work.ownerAt(i)?.kind === "building");
    };
    const lot = (x: number, y: number): boolean => {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) if (inLot(x + dx, y + dy)) return true;
      return false;
    };
    const lay = (x: number, y: number): void => {
      const i = work.idx(x, y);
      if (i < 0 || carriage.has(i) || paved.has(i) || work.state[i] !== CELL.OPEN) return;
      if (((work.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.BRIDGE | CELL_FLAG.NO_FLOOR)) !== 0)
        return;
      if (lot(x, y)) return;
      work.setMaterial(i, sw.material);
      const h = (work.height[i] as number) + raise;
      work.height[i] = h;
      paved.add(i);
      r.pave.push({ i, h });
    };
    forEachMaskCell(rasterPolyline(r.axis, r.op.width + 2 * sw.width, work.rasterClip()), lay);
    // the pavement runs on up to a building front that stands a few cells beyond it (its wall ring included):
    // no strip of bare ground between the pavement and the lot
    for (const { i } of r.pave.slice()) {
      const [x, y] = work.cellXY(i);
      for (const side of SIDES) {
        const [dx, dy] = SIDE_STEP[side];
        for (let k = 1; k <= PAVEMENT.reachToFront; k++) {
          const j = work.idx(x + dx * k, y + dy * k);
          if (j < 0 || carriage.has(j)) break;
          if (lot(x + dx * k, y + dy * k)) {
            for (let q = 1; q < k; q++) lay(x + dx * q, y + dy * q);
            break;
          }
        }
      }
    }
  }
}

/** Road records and their kerbs (after the edges): continuous kerb lines, gaps at crossings and junction mouths. */
export function stepRoads(work: ResolveGrid, paths: PathRecords): void {
  if (paths.pendingRoads.length === 0) return;
  const k = (i: number): string => {
    const [x, y] = work.cellXY(i);
    return `${x},${y}`;
  };
  const carriage = new Set<string>();
  const claimed = new Set<number>();
  const pavedAll = new Set<string>();
  const crossingAll = new Set<string>();
  const recs = paths.pendingRoads.map((r) => {
    const carriageway = r.cells.filter((i) => !claimed.has(i) && work.isFloor(i));
    for (const i of carriageway) claimed.add(i);
    for (const i of r.cells) carriage.add(k(i));
    // a pavement cell a building pad (or a later op) changed is no longer pavement
    const sw = r.op.sidewalk;
    const pave = r.pave
      .filter(
        (p) =>
          work.isFloor(p.i) &&
          work.height[p.i] === p.h &&
          sw &&
          work.mat[p.i] === materialOrdinal(sw.material),
      )
      .map((p) => p.i);
    for (const i of pave) pavedAll.add(k(i));
    const cw = carriageway.map((i) => work.cellXY(i) as Vec2);
    const crossings = crossingCells(r.axis, cw, r.op.crossings ?? []);
    for (const c of crossings) for (const [x, y] of c.cells) crossingAll.add(`${x},${y}`);
    return { r, carriageway, cw, pave, crossings };
  });
  for (const { r, carriageway, cw, pave, crossings } of recs) {
    const sw = r.op.sidewalk;
    const pv = pave.map((i) => work.cellXY(i) as Vec2);
    const { kerbLines, corners } = kerbLinesAndCorners(pv, carriage, crossingAll, pavedAll);
    paths.roads.push({
      id: r.op.id,
      axis: r.axis.map((p) => [p[0], p[1]] as Vec2),
      width: r.op.width,
      carriageway: cw,
      pavement: pv,
      pavementMaterial: sw?.material ?? null,
      pavementRaise: sw ? Math.round((sw.raise ?? PAVEMENT.defaultRaise) * 4) : 0,
      kerbLines,
      corners,
      crossings,
    });
    // kerb pieces: on by default with a sidewalk; along every carriageway edge that meets pavement (or, without a
    // sidewalk, any other floor), never on a crossing nor across a junction mouth
    if (r.op.kerb === false || (r.op.kerb !== true && !sw)) continue;
    for (const i of carriageway) {
      const [x, y] = work.cellXY(i);
      if (crossingAll.has(`${x},${y}`)) continue;
      for (const side of SIDES) {
        const [nx, ny] = stepSide(x, y, side);
        const j = work.idx(nx, ny);
        if (j < 0 || carriage.has(`${nx},${ny}`) || !work.isFloor(j)) continue;
        if (sw && !pavedAll.has(`${nx},${ny}`)) continue;
        if (Math.abs((work.height[j] as number) - (work.height[i] as number)) > KERB.roadStepQ) continue;
        const ed = work.sideEdge(x, y, side);
        if (!ed || (ed.e.kind[ed.i] !== EDGE.NONE && ed.e.kind[ed.i] !== EDGE.LEDGE)) continue;
        paths.kerbs.push({ at: [x, y], side, material: sw?.material ?? r.op.material });
      }
    }
  }
}

/** Kerbs along kerbed paths: every edge of a path cell that meets non-path floor at (about) the same height. */
export function stepKerbs(work: ResolveGrid, paths: PathRecords): void {
  for (const k of paths.pendingKerbs) {
    const noise = new ValueNoise(subSeed(k.seed, "kerb"));
    const nearAnchor = (x: number, y: number): boolean =>
      k.anchors.some(([ax, ay]) => Math.max(Math.abs(ax - x), Math.abs(ay - y)) <= KERB.anchorClear);
    const before = paths.kerbs.length;
    for (const i of k.cells) {
      if (!work.isFloor(i) || ((work.flags[i] as number) & CELL_FLAG.PATH) === 0) continue;
      const [x, y] = work.cellXY(i);
      for (const side of SIDES) {
        const [nx, ny] = stepSide(x, y, side);
        const j = work.idx(nx, ny);
        if (j < 0 || k.cells.has(j) || !work.isFloor(j)) continue;
        if (Math.abs((work.height[j] as number) - (work.height[i] as number)) > KERB.pathStepQ) continue;
        const ed = work.sideEdge(x, y, side);
        if (!ed || ed.e.kind[ed.i] !== EDGE.NONE) continue;
        if (work.profile.naturalPaths && k.natural) {
          // broken runs, none at junctions or where the path meets what it joins
          if (nearAnchor(x, y)) continue;
          const off = KERB.sideOffset[side];
          if (noise.sample(x / KERB.noiseScale + off, y / KERB.noiseScale + off) < KERB.keepFrom) continue;
        }
        paths.kerbs.push({ at: [x, y], side, material: k.material });
      }
    }
    if (work.profile.naturalPaths && k.natural) {
      // never both sides of the same cell (that reads as a rail); keep the one on the noisier side
      const added = paths.kerbs.splice(before);
      const byCell = new Map<string, Array<(typeof added)[number]>>();
      for (const kb of added) {
        const key = `${kb.at[0]},${kb.at[1]}`;
        byCell.set(key, [...(byCell.get(key) ?? []), kb]);
      }
      for (const list of byCell.values()) {
        const ns = list.some((q) => q.side === "N") && list.some((q) => q.side === "S");
        const ew = list.some((q) => q.side === "E") && list.some((q) => q.side === "W");
        const drop = new Set<string>();
        const at = list[0]?.at ?? [0, 0];
        const h = h32(`${k.seed}:${at[0]},${at[1]}`) % 2;
        if (ns) drop.add(h === 0 ? "N" : "S");
        if (ew) drop.add(h === 0 ? "E" : "W");
        for (const q of list) if (!drop.has(q.side)) paths.kerbs.push(q);
      }
    }
  }
}

/**
 * A vehicle the plan put on a pavement or across a carriageway (owner's model test, 2026-11-20: taxis half on the
 * pavement, a bus across the road): park it in the nearest kerb lane, its long side along the road, one lane deep.
 * Vehicles away from roads (a car park, a yard) keep what the plan gave. Returns the new anchor and size, or null.
 * `occupied` says whether a feature already stands on a cell (a lane must be free).
 */
export function parkVehicle(
  work: ResolveGrid,
  paths: ReadOnly<PathRecords>,
  occupied: (i: number) => boolean,
  at: Vec2,
  size: readonly [number, number],
): { at: Vec2; size: [number, number] } | null {
  const roads = paths.roads;
  if (!work.profile.roads || roads.length === 0) return null;
  const k = (x: number, y: number): string => `${x},${y}`;
  const cw = new Set<string>();
  const pave = new Set<string>();
  const cross = new Set<string>();
  for (const r of roads) {
    for (const [x, y] of r.carriageway) cw.add(k(x, y));
    for (const [x, y] of r.pavement) pave.add(k(x, y));
    for (const c of r.crossings) for (const [x, y] of c.cells) cross.add(k(x, y));
  }
  const cells: Vec2[] = [];
  for (let y = at[1]; y < at[1] + size[1]; y++)
    for (let x = at[0]; x < at[0] + size[0]; x++) cells.push([x, y]);
  const onPave = cells.some(([x, y]) => pave.has(k(x, y)));
  const onRoad = cells.some(([x, y]) => cw.has(k(x, y)));
  if (!onPave && !onRoad) return null;
  // on the carriageway and already lying along its road (a stalled car mid-lane): leave it
  if (!onPave) {
    const road = roads.find((r) =>
      cells.some(([x, y]) => r.carriageway.some((c) => c[0] === x && c[1] === y)),
    );
    const a = road?.axis;
    const horizontalRoad =
      a !== undefined &&
      a.length > 1 &&
      Math.abs((a[1] as Vec2)[0] - (a[0] as Vec2)[0]) >= Math.abs((a[1] as Vec2)[1] - (a[0] as Vec2)[1]);
    if (size[0] !== size[1] && size[0] > size[1] === horizontalRoad) return null;
  }
  // the road it is on or beside, and whether the vehicle already lies along it in one lane against a kerb
  const len = Math.max(size[0], size[1]);
  let best: { at: Vec2; size: [number, number]; d: number } | null = null;
  for (const r of roads)
    for (const kl of r.kerbLines) {
      const [dx, dy] = SIDE_STEP[kl.side];
      const horiz = kl.side === "N" || kl.side === "S";
      const n = Math.max(Math.abs(kl.to[0] - kl.from[0]), Math.abs(kl.to[1] - kl.from[1])) + 1;
      const sx = Math.sign(kl.to[0] - kl.from[0]);
      const sy = Math.sign(kl.to[1] - kl.from[1]);
      for (let t = 0; t + len <= n; t++) {
        // lane cells: one step from the kerb into the carriageway, `len` long
        const lane: Vec2[] = [];
        for (let u = 0; u < len; u++)
          lane.push([kl.from[0] + sx * (t + u) + dx, kl.from[1] + sy * (t + u) + dy]);
        if (!lane.every(([x, y]) => cw.has(k(x, y)) && !cross.has(k(x, y)))) continue;
        if (lane.some(([x, y]) => occupied(work.idx(x, y)))) continue;
        const x0 = Math.min(...lane.map((c) => c[0]));
        const y0 = Math.min(...lane.map((c) => c[1]));
        const d = Math.abs(x0 - at[0]) + Math.abs(y0 - at[1]);
        if (!best || d < best.d) best = { at: [x0, y0], size: horiz ? [len, 1] : [1, len], d };
      }
    }
  if (!best) return null;
  if (best.at[0] === at[0] && best.at[1] === at[1] && best.size[0] === size[0] && best.size[1] === size[1])
    return null;
  return { at: best.at, size: best.size };
}

/**
 * Generator 2: paths lead somewhere. When a level has natural paths, the focal piece (the first landmark-class
 * feature) and the front of each building get a spur trail from the nearest path cell unless a path already passes
 * near (`SPUR`). The spur is a 1-cell winding trail of the same material.
 */
export function stepPathSpurs(work: ResolveGrid): void {
  if (!work.profile.naturalPaths) return;
  const trails = work.level.terrain.filter(
    (t): t is Extract<TerrainOp, { op: "path" }> =>
      t.op === "path" && !isWater(t.material) && t.sidewalk === undefined && t.crossings === undefined,
  );
  if (trails.length === 0) return;
  const material = (trails[0] as Extract<TerrainOp, { op: "path" }>).material;
  const pathCells: Array<[number, number]> = [];
  for (let i = 0; i < work.n; i++)
    if (((work.flags[i] as number) & CELL_FLAG.PATH) !== 0) pathCells.push(work.cellXY(i));
  if (pathCells.length === 0) return;
  const targets: Array<{ id: string; at: Vec2; exact?: boolean }> = [];
  const focal =
    work.level.features.find((ft) => SPUR_PRIMARY.has(ft.type)) ??
    work.level.features.find((ft) => SPUR_FOCAL.has(ft.type));
  if (focal)
    targets.push({
      id: focal.id,
      at: focal.at,
      ...(work.profile.spursReachTargets ? { exact: true } : {}),
    });
  for (const st of work.level.structures ?? []) {
    if (st.kind === "enclosure") continue;
    // the building's first wing, first ground volume, or its bare rectangle
    const bare = st as { x?: number; y?: number; w?: number; h?: number };
    const w0 =
      st.wings?.[0] ??
      st.volumes?.find((v) => v.on === undefined) ??
      (bare.x !== undefined && bare.y !== undefined && bare.w !== undefined && bare.h !== undefined
        ? { x: bare.x, y: bare.y, w: bare.w, h: bare.h }
        : undefined);
    if (!w0) continue;
    // generator 3: the trail ends at the cell outside the building's door
    const doorOpening = work.profile.spursReachTargets
      ? work.level.openings.find(
          (o) =>
            o.id.startsWith(`${st.id}~`) &&
            (o.kind === "door" || o.kind === "double_door" || o.kind === "locked_door") &&
            o.at !== undefined,
        )
      : undefined;
    if (doorOpening?.at) {
      const d = SIDE_STEP[doorOpening.at.side];
      targets.push({
        id: st.id,
        at: [doorOpening.at.x + d[0], doorOpening.at.y + d[1]],
        exact: true,
      });
      continue;
    }
    const side = st.front ?? "S";
    const at: Vec2 =
      side === "N"
        ? [w0.x + Math.floor(w0.w / 2), w0.y - 2]
        : side === "S"
          ? [w0.x + Math.floor(w0.w / 2), w0.y + w0.h + 1]
          : side === "W"
            ? [w0.x - 2, w0.y + Math.floor(w0.h / 2)]
            : [w0.x + w0.w + 1, w0.y + Math.floor(w0.h / 2)];
    targets.push({ id: st.id, at });
  }
  const clip = work.rasterClip();
  for (const t of targets) {
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (const p of pathCells) {
      const d = Math.max(Math.abs(p[0] - t.at[0]), Math.abs(p[1] - t.at[1]));
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    // generator 3 (exact targets): a path must touch the door cell or the focal piece, not merely pass near
    if (!best || bestD <= (t.exact ? SPUR.nearPathExact : SPUR.nearPath)) continue;
    const seed = subSeed(elementSeed(work.plan.seed, t.id), "spur");
    for (const [x, y] of trailCells([best, t.at], SPUR.width, SPUR.wander, seed, clip)) {
      const i = work.idx(x, y);
      if (i < 0 || work.state[i] !== CELL.OPEN) continue;
      if (((work.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.PATH)) !== 0) continue;
      if (work.ownerAt(i)?.kind === "building") continue;
      work.setMaterial(i, material);
      work.flags[i] = (work.flags[i] as number) | CELL_FLAG.PATH;
      pathCells.push([x, y]);
    }
    if (t.exact) {
      const i = work.idx(t.at[0], t.at[1]);
      if (
        i >= 0 &&
        work.state[i] === CELL.OPEN &&
        ((work.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.PATH)) === 0 &&
        work.ownerAt(i)?.kind !== "building"
      ) {
        work.setMaterial(i, material);
        work.flags[i] = (work.flags[i] as number) | CELL_FLAG.PATH;
        pathCells.push([t.at[0], t.at[1]]);
      }
    }
  }
}
