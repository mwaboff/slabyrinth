/**
 * Realize, a building's openings by storey face: which face cells of which storey each ground opening (the level's
 * openings, ids in `ResolvedStructure.openingIds`) and each upper opening takes.
 * Reads: the structure, its volumes and the level's openings. Writes: nothing (the faces are handed to the courses).
 */
import type { OpeningKind, Side } from "../../../contracts/plan";
import type { ResolvedOpening, ResolvedStructure, ResolvedVolume } from "../../../contracts/resolved";
import { alongFace, faceKey, key, setOf, type FaceCell } from "./pieces";

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
