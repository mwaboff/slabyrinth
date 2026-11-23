/**
 * A built object set on the map as one (technique M2): its frame turned to a heading and stood on a plan point, every
 * piece with it. An object with tile pieces (a deck, a counter) turns in quarter turns only, since a tile off the grid
 * is wrong (structure_off_axis); one of props only turns in 15° steps. Its pieces become arrangement instances of at
 * most `ARRANGE_LIMITS.piecesPerInstance` each (`packParts`), all on the same anchor (a large vessel is two), and its
 * surfaces, spaces, footprint and keep-clear ring become plan cells with absolute heights.
 */
import type { Vec2 } from "../contracts/plan";
import type { ResolvedArrangement } from "../contracts/resolved";
import { ARRANGE_LIMITS } from "../arrange/budget";
import { planPointOf, toInstance, type Anchor } from "../arrange/instance";
import { snapYaw, type Placed, type XZ } from "../arrange/piece";
import { inPolygon } from "../arrange/scatter";
import { maxOf, minOf } from "../util/lists";
import { rotateXZ } from "../util/turn";
import { insetConvex } from "./outline";
import { piecesOf, type BuiltObject } from "./recipe";

/** The turn step an object allows: 90 when any of its pieces is a tile, else 15. */
export function turnStep(obj: BuiltObject): 15 | 90 {
  return piecesOf(obj).some((p) => p.piece.measures.kind === "tile") ? 90 : 15;
}

/** A heading snapped to the object's turn step (degrees clockwise, 0..345). */
export function objectTurn(obj: BuiltObject, turn: number): number {
  const step = turnStep(obj);
  return snapYaw(Math.round(turn / step) * step);
}

/** A surface or space on the map: its plan cells (centre inside) and absolute heights. */
export interface PlacedSurface {
  readonly id: string;
  readonly y: number;
  readonly cells: Vec2[];
}

export interface PlacedObject {
  readonly instances: ResolvedArrangement[];
  readonly turn: number;
  readonly surfaces: PlacedSurface[];
  readonly spaces: (PlacedSurface & { readonly ceiling: number })[];
  /** Cells whose centre lies in the footprint. */
  readonly footprint: Vec2[];
  /** Cells within the clearance round the footprint, outside it: kept free of other things. */
  readonly keepClear: Vec2[];
}

/** The plan cells whose centres lie inside a frame polygon placed at `at` turned `turn`, ascending. */
export function cellsInside(poly: readonly XZ[], at: readonly [number, number], turn: number): Vec2[] {
  if (poly.length < 3) return [];
  const plan = poly.map(([x, z]) => planPointOf(at, turn, x, z));
  const xs = plan.map((p) => p[0]);
  const ys = plan.map((p) => p[1]);
  const out: Vec2[] = [];
  for (let y = Math.floor(minOf(ys)); y <= Math.ceil(maxOf(ys)); y++)
    for (let x = Math.floor(minOf(xs)); x <= Math.ceil(maxOf(xs)); x++) {
      // the cell centre back in the frame
      const r = rotateXZ(x + 0.5 - at[0], -(y + 0.5 - at[1]), -turn);
      if (inPolygon(poly, r.x, r.z)) out.push([x, y]);
    }
  return out;
}

export interface PlaceSpec {
  readonly id: string;
  readonly anchor: Anchor;
  readonly layer?: string;
  readonly host?: string;
}

/**
 * The object's pieces in instances of at most `cap`: whole parts in recipe order, a new instance when the next part
 * does not fit (so a part and what stands on it, listed next to it, usually share one); a part larger than `cap` is
 * split. Every new instance opens with the next grounded part not yet placed (one reaching the object's lowest point,
 * a keel, a foot), when there is one: verify measures an instance's lowest piece against what is under it, so every
 * instance must stand on the ground.
 */
export function packParts(obj: BuiltObject, cap: number): Placed[][] {
  const low = (p: BuiltObject["parts"][number]): number => minOf(p.pieces.map((q) => q.y));
  const ground = minOf(obj.parts.map(low));
  const rest = [...obj.parts];
  const out: Placed[][] = [[]];
  const put = (p: BuiltObject["parts"][number]): void => {
    let cur = out[out.length - 1] as Placed[];
    for (const q of p.pieces) {
      if (cur.length >= cap) out.push((cur = []));
      cur.push(q);
    }
  };
  while (rest.length > 0) {
    const p = rest.shift() as BuiltObject["parts"][number];
    const cur = out[out.length - 1] as Placed[];
    if (cur.length > 0 && cur.length + p.pieces.length > cap) {
      out.push([]);
      const g = rest.findIndex(
        (r) => r.pieces.length > 0 && low(r) <= ground + 0.05 && r.pieces.length < cap,
      );
      const [grounded] = g >= 0 && low(p) > ground + 0.05 ? rest.splice(g, 1) : [];
      if (grounded) put(grounded);
    }
    put(p);
  }
  return out.filter((g) => g.length > 0);
}

/** The object set on the map (see the file header). */
export function placeObject(obj: BuiltObject, spec: PlaceSpec): PlacedObject {
  const turn = objectTurn(obj, spec.anchor.turn ?? 0);
  const at = spec.anchor.at;
  const groups = packParts(obj, ARRANGE_LIMITS.piecesPerInstance);
  const instances = groups.map((pieces, i) =>
    toInstance(pieces, {
      id: groups.length === 1 ? spec.id : `${spec.id}#${i + 1}`,
      recipe: `object:${obj.recipe}`,
      anchor: { ...spec.anchor, turn },
      ...(spec.layer !== undefined ? { layer: spec.layer } : {}),
      ...(spec.host !== undefined ? { host: spec.host } : {}),
    }),
  );
  const base = spec.anchor.base;
  const footprint = cellsInside(obj.footprint, at, turn);
  const inFoot = new Set(footprint.map(([x, y]) => `${x},${y}`));
  const ring = cellsInside(insetConvex(obj.footprint, -obj.clearance), at, turn).filter(
    ([x, y]) => !inFoot.has(`${x},${y}`),
  );
  return {
    instances,
    turn,
    surfaces: obj.surfaces.map((s) => ({ id: s.id, y: base + s.y, cells: cellsInside(s.polygon, at, turn) })),
    spaces: obj.spaces.map((s) => ({
      id: s.id,
      y: base + s.floorY,
      ceiling: base + s.ceilingY,
      cells: cellsInside(s.polygon, at, turn),
    })),
    footprint,
    keepClear: ring,
  };
}
