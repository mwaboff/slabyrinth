/**
 * Slab -> world-space draw list. Placement follows docs/talespire-slab-format.md §2.2: rot steps of 15° clockwise
 * from above; a tile's stored position is the min x/z corner of its collider box after rotation; a prop's stored
 * position is its origin.
 */
import { decode } from "../../packages/core/src/slab";
import type { PieceGeometry, PieceLibrary } from "./pieces";
import type { DrawMesh, V3 } from "./raster";

export interface Placed {
  uuid: string;
  name: string;
  kind: "tile" | "prop" | "unknown";
  rot: number;
  pos: V3;
  mesh: DrawMesh;
}

/** Rotation by rot×15° clockwise seen from above (+x east, +z north). */
export function rotY(rot: number): (x: number, z: number) => [number, number] {
  const t = (rot * 15 * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return (x, z) => [x * c + z * s, -x * s + z * c];
}

export function hashColor(key: string): V3 {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  const hue = ((h >>> 0) % 360) / 360;
  const f = (n: number): number => {
    const k = (n + hue * 12) % 12;
    return 0.62 - 0.42 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

export type Colorer = (name: string, uuid: string) => V3;
export const defaultColor: Colorer = (name, uuid) => {
  if (/^(Dungeon Floor|Tavern Wall|Tavern Inner Corner)/.test(name)) return [0.55, 0.53, 0.5];
  if (/Dark Crate|practice pole/i.test(name)) return [0.12, 0.12, 0.12];
  return hashColor(uuid);
};

/** World positions of a piece stored at `pos` (tiles) with rotation index `rot`. */
export function placePositions(g: PieceGeometry, rot: number, pos: V3): Float32Array {
  const e = g.entry;
  const r = rotY(rot);
  let [dx, dy, dz] = pos;
  if (e.kind === "tile") {
    let mx = Infinity;
    let mz = Infinity;
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const [x, z] = r(e.center[0] + sx * e.extent[0], e.center[2] + sz * e.extent[2]);
        mx = Math.min(mx, x);
        mz = Math.min(mz, z);
      }
    dx -= mx;
    dz -= mz;
  }

  const P = new Float32Array(g.positions.length);
  for (let i = 0; i < P.length; i += 3) {
    const [x, z] = r(g.positions[i]!, g.positions[i + 2]!);
    P[i] = x + dx;
    P[i + 1] = g.positions[i + 1]! + dy;
    P[i + 2] = z + dz;
  }
  return P;
}

export function slabScene(
  slabText: string,
  lib: PieceLibrary,
  color: Colorer = defaultColor,
  chunkOffsets?: V3[],
): { placed: Placed[]; unknown: number; assets: number } {
  const lines = slabText.split(/\r?\n/).filter((l) => l.trim());
  const placed: Placed[] = [];
  let unknown = 0;
  let assets = 0;
  lines.forEach((line, li) => {
    const off = chunkOffsets?.[li] ?? [0, 0, 0];
    for (const a of decode(line.trim()).assets) {
      assets++;
      const g = lib.piece(a.uuid);
      if (!g) {
        unknown++;
        continue;
      }
      const e = g.entry;
      const P = placePositions(g, a.rot, [a.sx / 100 + off[0], a.sy / 100 + off[1], a.sz / 100 + off[2]]);
      placed.push({
        uuid: a.uuid,
        name: e.name,
        kind: e.kind,
        rot: a.rot,
        pos: [a.sx / 100, a.sy / 100, a.sz / 100],
        mesh: { positions: P, indices: g.indices, color: color(e.name, a.uuid) },
      });
    }
  });
  return { placed, unknown, assets };
}
