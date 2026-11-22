/**
 * The faces of a resolved building, read-only: the one walk the building realizer (compile/realize/structures/) and
 * the detail anchors (resolve/anchors/) both read, so the recipes dress exactly the walls the build lays.
 *
 * - Cell sets are keyed "x,y" and walked in the keys' string order: the order is part of the released output (the
 *   seeded picks and the emission order of the building realizer follow it), so it stays.
 * - A face cell is one side of a footprint cell; the wall on it stands OUTSIDE the cell, in the neighbour's half next to
 *   the edge (compile/realize/structures/building.ts, verified in game), so its outer surface is half a tile outside the
 *   footprint.
 * - A volume's storey builds a wall on a face of its cells unless another volume (or an earlier building of the level)
 *   fills the cell beyond over most of the storey's height (`structureNeighbours`), or a chimney breast stands in it.
 * - `structureClaims` is which edges and openings of the level's grid the buildings build themselves (the level's wall
 *   and opening passes and verify leave them alone).
 * Reads: the level's structures and openings. Writes: nothing.
 */
import type { OpeningKind, Side } from "../contracts/plan";
import type {
  ResolvedLevel,
  ResolvedOpening,
  ResolvedStructure,
  ResolvedVolume,
} from "../contracts/resolved";
import { SIDE_STEP, SIDES } from "../gen/gridGeometry";
import { sideEdgeIndex, sideOrient } from "./levelGrid";
import type { Rect } from "./roof";

/** One face of a footprint cell: the wall on it stands outside the cell, in the neighbour's half next to the edge. */
export interface FaceCell {
  x: number;
  y: number;
  face: Side;
}

export const key = (x: number, y: number): string => `${x},${y}`;
/** The cell of an "x,y" key. */
export const cellOfKey = (k: string): [number, number] => k.split(",").map(Number) as [number, number];
/** A face's key "x,y,face" (openings, ruin columns and arches are found by it). */
export const faceKey = (x: number, y: number, face: Side): string => `${x},${y},${face}`;

export const setOf = (cells: ReadonlyArray<readonly [number, number]>): Set<string> =>
  new Set(cells.map(([x, y]) => key(x, y)));

export function boundsOfCells(cells: ReadonlyArray<readonly [number, number]>): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of cells) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { x: 0, y: 0, w: 0, h: 0 };
}

/** The outer faces of a cell set: every side of a cell whose neighbour is not in the set. */
export function faceCells(cells: ReadonlySet<string>): FaceCell[] {
  const out: FaceCell[] = [];
  for (const k of [...cells].sort()) {
    const [x, y] = cellOfKey(k);
    for (const face of SIDES) {
      const [dx, dy] = SIDE_STEP[face];
      if (!cells.has(key(x + dx, y + dy))) out.push({ x, y, face });
    }
  }
  return out;
}

/** The step from a face cell `k` cells along its face (east for N/S faces, south for E/W faces). */
export const alongFace = (f: FaceCell, k: number): FaceCell =>
  f.face === "N" || f.face === "S"
    ? { x: f.x + k, y: f.y, face: f.face }
    : { x: f.x, y: f.y + k, face: f.face };

/** Runs of consecutive face cells on one line (for length-2 wall pieces), each in the order `alongFace` walks. */
export function faceRunsOf(list: readonly FaceCell[]): FaceCell[][] {
  const byLine = new Map<string, FaceCell[]>();
  for (const f of list) {
    const line = f.face === "N" || f.face === "S" ? `${f.face}|${f.y}` : `${f.face}|${f.x}`;
    const arr = byLine.get(line) ?? [];
    arr.push(f);
    byLine.set(line, arr);
  }
  const runs: FaceCell[][] = [];
  for (const arr of [...byLine.values()]) {
    const along = (f: FaceCell): number => (f.face === "N" || f.face === "S" ? f.x : f.y);
    arr.sort((a, b) => along(a) - along(b));
    let cur: FaceCell[] = [];
    for (const f of arr) {
      const last = cur[cur.length - 1];
      if (last && along(f) !== along(last) + 1) {
        runs.push(cur);
        cur = [];
      }
      cur.push(f);
    }
    if (cur.length) runs.push(cur);
  }
  return runs;
}

type VolumeStorey = ResolvedVolume["storeys"][number];

/** A phase-1 record has no volumes: one volume over its footprint and wings, storeys and roof. */
export function volumesOf(st: ResolvedStructure): ResolvedVolume[] {
  if (st.volumes && st.volumes.length > 0) return st.volumes;
  return [
    {
      id: "main",
      on: null,
      corners: "square",
      rects: st.wings,
      storeys: st.storeys.map((s) => ({
        floorTop: s.floorTop,
        wallTop: s.floorTop + s.wallHeight,
        cells: st.cells,
        rect: boundsOfCells(st.cells),
        footing: s.footing,
        walls: s.walls,
        floor: s.floor,
        seam: null,
      })),
      roof: {
        layers: [
          {
            type: st.roof.type,
            requested: st.roof.requested,
            style: st.roof.style,
            courses: 1,
            low: "S",
            parapet: st.roof.parapet,
            ridge: st.wings[0]?.ridge ?? "ew",
          },
        ],
        deck: st.roof.deck,
        broken: st.roof.broken,
      },
    },
  ];
}

/** The id of a building's main volume (the first on the ground). */
export const mainVolumeId = (vols: readonly ResolvedVolume[]): string =>
  vols.find((v) => v.on === null)?.id ?? "main";

/** Element id prefix of a volume's pieces: the main volume's is the building's id. */
export const volumeTag = (st: ResolvedStructure, mainId: string, volume: string): string =>
  volume === mainId ? st.id : `${st.id}~${volume}`;

/** Wall faces ("x,y,face") a chimney breast stands in: no wall there. */
export function chimneyWalls(st: ResolvedStructure): Set<string> {
  const out = new Set<string>();
  for (const c of st.chimneys) {
    const [dx, dy] = SIDE_STEP[c.side];
    out.add(faceKey(c.at[0] - dx, c.at[1] - dy, c.side));
  }
  return out;
}

/** Cells of every other building of the level: no parapet, detail or balcony stands against them. */
export function foreignCells(L: ResolvedLevel, st: ResolvedStructure): Set<string> {
  const out = new Set<string>();
  for (const o of L.structures ?? [])
    if (o !== st && o.kind === "building") for (const [x, y] of o.cells) out.add(key(x, y));
  return out;
}

/**
 * Who builds the wall between two volumes. `party`: a neighbour earlier in the level's list has wall courses on this
 * cell spanning this storey's whole height (its ground walls reach the ground), so it builds the shared wall.
 * `covered`: another volume's storey (this building's, or a party neighbour) fills the cell over most of this
 * storey's height, so no wall faces it.
 */
export function structureNeighbours(
  L: ResolvedLevel,
  st: ResolvedStructure,
  vols: readonly ResolvedVolume[],
): {
  covered: (v: ResolvedVolume, sp: VolumeStorey, x: number, y: number) => boolean;
  party: (sp: VolumeStorey, x: number, y: number) => boolean;
} {
  const all = L.structures ?? [];
  const earlier = all
    .slice(0, Math.max(0, all.indexOf(st)))
    .filter((o) => o.kind === "building")
    .flatMap((o) => volumesOf(o));
  const party = (sp: VolumeStorey, x: number, y: number): boolean =>
    earlier.some((o) => {
      let lo = Infinity;
      let hi = -Infinity;
      o.storeys.forEach((os, i) => {
        if (!os.cells.some((c) => c[0] === x && c[1] === y)) return;
        lo = Math.min(lo, i === 0 && o.on === null ? -Infinity : os.floorTop - 0.5);
        hi = Math.max(hi, os.wallTop);
      });
      return lo <= sp.floorTop - 0.5 + 1e-6 && hi >= sp.wallTop - 1e-6;
    });
  const covered = (v: ResolvedVolume, sp: VolumeStorey, x: number, y: number): boolean =>
    vols.some(
      (o) =>
        o !== v &&
        o.storeys.some(
          (os) =>
            os.cells.some((c) => c[0] === x && c[1] === y) &&
            Math.min(os.wallTop, sp.wallTop) - Math.max(os.floorTop, sp.floorTop) > 0.5,
        ),
    ) || party(sp, x, y);
  return { covered, party };
}

/**
 * The faces a volume's storey builds a wall on: its cells' outer faces, less those another volume or an earlier
 * building covers. The kept, roofed volume of a ruin keeps its wall where a wing stood against it: the wing's own walls
 * fell, so the cell beside it is no longer a room, and the eave must not hang over a gap (generator 3).
 */
export function storeyWallFaces(
  st: ResolvedStructure,
  nb: ReturnType<typeof structureNeighbours>,
  v: ResolvedVolume,
  sp: VolumeStorey,
): FaceCell[] {
  const keptWhole = st.condition === "ruined" && st.ruin?.keep === v.id;
  return faceCells(setOf(sp.cells)).filter((f) => {
    const [dx, dy] = SIDE_STEP[f.face];
    if (keptWhole && !nb.party(sp, f.x + dx, f.y + dy)) return true;
    return !nb.covered(v, sp, f.x + dx, f.y + dy);
  });
}

/** One face cell of an opening: the opening, its first face cell and this cell's index along it. */
export interface StoreyOpening {
  id: string;
  kind: OpeningKind;
  width: number;
  first: FaceCell;
  index: number;
}

/** The key of the ground storey's faces: every ground volume's ground storey shares it. */
export const GROUND_FACES = "@ground:0";

/** The key of a volume's storey's faces ("<volume>:<storey>"). */
export const storeyFaces = (volume: string, storey: number): string => `${volume}:${storey}`;

/**
 * Footprint cell and face of one of the building's ground openings: the resolver records an opening by the edge's
 * start vertex, and the face is on the side of the building's cell.
 */
export function openingFace(st: ResolvedStructure, op: ResolvedOpening): { c: [number, number]; face: Side } {
  const cells = setOf(st.cells);
  const cellA: [number, number] =
    op.orientation === "h" ? [op.start[0], op.start[1] - 1] : [op.start[0] - 1, op.start[1]];
  const inA = cells.has(key(cellA[0], cellA[1]));
  return {
    c: inA ? cellA : [op.start[0], op.start[1]],
    face: op.orientation === "h" ? (inA ? "S" : "N") : inA ? "E" : "W",
  };
}

/**
 * The face cells every opening takes, per storey faces key ("x,y,face" → opening): ground openings on the ground faces,
 * upper openings on their volume's storey (a ground volume's storey 0 is the ground).
 */
export function openingsByStorey(
  st: ResolvedStructure,
  levelOpenings: readonly ResolvedOpening[],
  vols: readonly ResolvedVolume[],
  mainId: string,
  tagOf: (volume: string) => string,
): Map<string, Map<string, StoreyOpening>> {
  const opsBy = new Map<string, Map<string, StoreyOpening>>();
  const mark = (k: string, id: string, kind: OpeningKind, first: FaceCell, width: number): void => {
    const m = opsBy.get(k) ?? new Map<string, StoreyOpening>();
    for (let i = 0; i < width; i++) {
      const c = alongFace(first, i);
      m.set(faceKey(c.x, c.y, c.face), { id, kind, width, first, index: i });
    }
    opsBy.set(k, m);
  };
  const byId = new Map(levelOpenings.map((o) => [o.id, o]));
  for (const id of st.openingIds) {
    const o = byId.get(id);
    if (!o) continue;
    const { c, face } = openingFace(st, o);
    mark(GROUND_FACES, id, o.kind, { x: c[0], y: c[1], face }, o.width);
  }
  st.upperOpenings.forEach((u, i) => {
    const vid = u.volume ?? mainId;
    const ground = u.storey === 0 && vols.find((v) => v.id === vid)?.on === null;
    mark(
      ground ? GROUND_FACES : storeyFaces(vid, u.storey),
      `${tagOf(vid)}~u${u.storey}${u.kind}${i}`,
      u.kind,
      { x: u.at[0], y: u.at[1], face: u.side },
      u.width,
    );
  });
  return opsBy;
}

/** Shell edges and structure openings the level's own passes must leave to the structure builders. */
export function structureClaims(L: ResolvedLevel): {
  edges: Set<string>;
  openings: Set<string>;
  /** Shell edges of ruined buildings: their walls may break off a tile above the floor. */
  ruined: Set<string>;
} {
  const edges = new Set<string>();
  const ruined = new Set<string>();
  const openings = new Set<string>();
  for (const st of L.structures ?? []) {
    for (const id of st.openingIds) openings.add(id);
    if (st.kind !== "building") continue;
    const cells = new Set(st.cells.map(([x, y]) => key(x, y)));
    const out = st.condition === "ruined" ? ruined : null;
    for (const [x, y] of st.cells) {
      const lx = x - L.bounds.x;
      const ly = y - L.bounds.y;
      for (const face of SIDES) {
        const [dx, dy] = SIDE_STEP[face];
        if (cells.has(key(x + dx, y + dy))) continue;
        const e = `${sideOrient(face)}${sideEdgeIndex(L.bounds, lx, ly, face)}`;
        edges.add(e);
        out?.add(e);
      }
    }
  }
  return { edges, openings, ruined };
}
