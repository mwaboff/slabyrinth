/**
 * Facing, a part-level rule for every object recipe: a piece with a front (gen/pieceFacts.ts `front`, read from its
 * mesh) is turned so its front points where its job says: a gun's muzzle OUT from the body it is mounted on (away from
 * the body's centre line), a control's operator the way the body TRAVELS. A recipe asks `yawFacing` instead of keeping
 * a turn per piece, so a new kit with its fronts in the facts needs no trial turns; `facingFaults` is the check any
 * built object is held to (tests), whatever recipe built it.
 */
import { placedBox, type ArrangePiece, type XZ } from "../arrange/piece";
import { frontSide, pieceFacts } from "../gen/pieceFacts";
import { maxOf, minOf } from "../util/lists";
import { insideOrNear } from "./outline";
import { piecesOf, type BuiltObject } from "./recipe";

const SIDE: Readonly<Record<"N" | "E" | "S" | "W", XZ>> = { E: [1, 0], W: [-1, 0], N: [0, 1], S: [0, -1] };

/** A frame vector turned by a yaw (degrees clockwise from above, the frame's +z north, +x east). */
export function turned(v: XZ, yaw: number): XZ {
  const t = (yaw * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c];
}

/** A piece's front at rot 0 by its name (+z north), or null when the facts give it none. */
export function frontVector(name: string | undefined): XZ | null {
  // the one source realize reads too (gen/pieceFacts.ts `frontSide`)
  const s = frontSide(name);
  return s ? SIDE[s] : null;
}

/** The piece's front at rot 0, or null when the facts give it none. */
export const frontOf = (piece: ArrangePiece): XZ | null => frontVector(piece.variant.name);

/**
 * The facing rule's numbers: a front faces the way its job says when its cosine with that way is above `cos` (within 60
 * degrees); a piece within `centre` of its body's centre line has no outward way to face.
 */
export const FACING = { cos: 0.5, centre: 0.25 } as const;

/** A body's centre line: through `centre`, along unit `travel`, reaching `reach` either way of the centre. */
export interface BodyLine {
  readonly centre: XZ;
  readonly travel: XZ;
  readonly reach: number;
}

/**
 * How well a front (a unit vector, as the piece stands) faces where its job says, as a cosine: a "travel" front with
 * the body's travel, an "outboard" front with the way out from the body's centre line at the piece's point `at`. Null
 * when an outboard piece stands on the centre line (no way out). A cosine at most `FACING.cos` is a fault. The one
 * rule a recipe is held to (`facingFaults`) and the 3D scene's facing check measures.
 */
export function frontCosine(faces: "outboard" | "travel", front: XZ, at: XZ, line: BodyLine): number | null {
  const [tx, tz] = line.travel;
  if (faces === "travel") return front[0] * tx + front[1] * tz;
  const along = (at[0] - line.centre[0]) * tx + (at[1] - line.centre[1]) * tz;
  const t = Math.min(line.reach, Math.max(-line.reach, along));
  const dx = at[0] - (line.centre[0] + tx * t);
  const dz = at[1] - (line.centre[1] + tz * t);
  const n = Math.hypot(dx, dz);
  if (n <= FACING.centre) return null;
  return (front[0] * dx + front[1] * dz) / n;
}

/**
 * The quarter-turn yaw that points the piece's front nearest `dir` (in the frame the piece is placed in), or `fallback`
 * when the piece has no front fact.
 */
export function yawFacing(piece: ArrangePiece, dir: XZ, fallback = 0): number {
  const f = frontOf(piece);
  if (!f) return fallback;
  let best = fallback;
  let score = -Infinity;
  for (const yaw of [0, 90, 180, 270]) {
    const v = turned(f, yaw);
    const d = v[0] * dir[0] + v[1] * dir[1];
    if (d > score + 1e-9) {
      score = d;
      best = yaw;
    }
  }
  return best;
}

/**
 * A built object's facing faults (in its own frame, travel `+z`): a piece whose front should face out from the body
 * but points at it, or a control whose operator faces against travel. "Out" is away from the body's centre line: the
 * segment along the travel through the middle of its footprint, as long as the footprint is longer than wide (a square
 * body's centre line is its centre point, so out is radial).
 */
export function facingFaults(obj: BuiltObject, travel: XZ = [0, 1]): string[] {
  const along = (p: XZ): number => p[0] * travel[0] + p[1] * travel[1];
  const across = (p: XZ): number => p[0] * travel[1] - p[1] * travel[0];
  const a = obj.footprint.map(along);
  const c = obj.footprint.map(across);
  const length = maxOf(a) - minOf(a);
  const width = maxOf(c) - minOf(c);
  const mid = (maxOf(a) + minOf(a)) / 2;
  // the object's frame puts its centre line through the origin, across the travel
  const line: BodyLine = {
    centre: [mid * travel[0], mid * travel[1]],
    travel,
    reach: Math.max(0, (length - width) / 2),
  };
  const out: string[] = [];
  for (const q of piecesOf(obj)) {
    const fact = pieceFacts(q.piece.variant.name).front;
    const f0 = frontOf(q.piece);
    if (!fact || !f0) continue;
    const cos = frontCosine(fact.faces, turned(f0, q.yaw), [q.x, q.z], line);
    if (cos === null || cos > FACING.cos) continue;
    out.push(
      fact.faces === "travel"
        ? `${q.piece.variant.name} faces against travel`
        : `${q.piece.variant.name} points at the body`,
    );
  }
  return out;
}

/**
 * A body left open at a deck level: the whole cells of its footprint (inset `rim`, the bulwark's band) that no surface
 * at height `y` covers. A deck's own tiles can all be laid (`openDeckCells` empty) while the deck's outline falls short
 * of the body (a deck tapered where the hull is square, a raised deck stopping short of its end wall): this asks the
 * body, not the deck.
 */
export function uncappedCells(obj: BuiltObject, y: number, rim = 0.5): string[] {
  const at = obj.surfaces.filter((s) => Math.abs(s.y - y) < 0.05);
  const xs = obj.footprint.map((p) => p[0]);
  const zs = obj.footprint.map((p) => p[1]);
  const out: string[] = [];
  for (let z = Math.floor(minOf(zs)); z < Math.ceil(maxOf(zs)); z++)
    for (let x = Math.floor(minOf(xs)); x < Math.ceil(maxOf(xs)); x++) {
      const c: XZ = [x + 0.5, z + 0.5];
      // the cell's centre well inside the body (at least the rim's band from its outline)
      const inBody = [
        [rim, 0],
        [-rim, 0],
        [0, rim],
        [0, -rim],
      ].every(([dx, dz]) => insideOrNear(obj.footprint, c[0] + (dx ?? 0), c[1] + (dz ?? 0), 0));
      if (!inBody) continue;
      if (!at.some((s) => insideOrNear(s.polygon, c[0], c[1], 0.02))) out.push(`${x},${z}`);
    }
  return out;
}

/**
 * A built object's decks with holes: the whole cells of each surface (deck) that no floor tile of the object covers at
 * the surface's height (a shell left open where a deck level sits). Only for an object that lays its own decks.
 */
export function openDeckCells(obj: BuiltObject): string[] {
  const out: string[] = [];
  const tops = piecesOf(obj).filter((q) => q.piece.measures.kind === "tile");
  for (const s of obj.surfaces) {
    const xs = s.polygon.map((p) => p[0]);
    const zs = s.polygon.map((p) => p[1]);
    for (let z = Math.floor(minOf(zs)); z < Math.ceil(maxOf(zs)); z++)
      for (let x = Math.floor(minOf(xs)); x < Math.ceil(maxOf(xs)); x++) {
        const corners: XZ[] = [
          [x, z],
          [x + 1, z],
          [x, z + 1],
          [x + 1, z + 1],
        ];
        if (!corners.every((p) => insideOrNear(s.polygon, p[0], p[1], 0.02))) continue;
        const cx = x + 0.5;
        const cz = z + 0.5;
        const covered = tops.some((q) => {
          const b = placedBox(q);
          return (
            b.min.x <= cx &&
            b.max.x >= cx &&
            b.min.z <= cz &&
            b.max.z >= cz &&
            Math.abs(b.max.y - s.y) <= 0.15
          );
        });
        if (!covered) out.push(`${s.id} ${x},${z}`);
      }
  }
  return out;
}
