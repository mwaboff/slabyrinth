/**
 * The 3D scene as it crosses IPC (shared/ipc.ts View3dHeader, View3dChunk, View3dMesh): a header without per-piece
 * data, instances in chunks of 32 × 32 tiles per level as typed arrays, and meshes by key on demand. Pure, so main's
 * scene worker and the renderer's fake bridge pack scenes the same way.
 */
import { COLOUR_CLASSES, type Box3, type ColourClass, type Scene } from "@slabyrinth/scene3d";
import type { View3dBox, View3dChunk, View3dHeader, View3dMesh } from "./ipc";

/** Chunk side in tiles. */
export const CHUNK_TILES = 32;

/** The header fields a packed scene knows (the service adds the ids, the version and the detail state). */
export type PackedHeader = Omit<
  View3dHeader,
  "sceneId" | "version" | "buildId" | "pendingDetail" | "limited"
>;

export interface PackedScene {
  header: PackedHeader;
  chunks: ReadonlyMap<string, View3dChunk>;
  meshes: ReadonlyMap<string, View3dMesh>;
}

/** Plain words for each reason a piece is a box (the header's `boxes.reasons`). */
export const BOX_REASON_WORDS: Readonly<Record<string, string>> = {
  "boxes-requested": "3D is turned off",
  "no-install": "TaleSpire not found",
  "not-read-yet": "not read yet",
  "not-in-index": "not in the game's files",
  "no-parts": "no shape in the game's files",
  "bundle-missing": "a game file is missing",
  "unsupported-format": "stored in a way Slabyrinth can't read yet",
  "decode-failed": "couldn't be read",
  "no-geometry": "size unknown",
  budget: "detail limited to keep Slabyrinth responsive",
};

const CLASS_ORDER = Object.keys(COLOUR_CLASSES) as ColourClass[];

export function wireBox(b: Box3): View3dBox {
  return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
}
const finite = (b: Box3): boolean => Number.isFinite(b.min.x) && Number.isFinite(b.max.x);

function meshBounds(positions: Float32Array): View3dBox {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k] ?? 0;
      if (v < (min[k] ?? 0)) min[k] = v;
      if (v > (max[k] ?? 0)) max[k] = v;
    }
  return Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
}

/** Indices as 16-bit when every vertex number fits (half the bytes). */
function compactIndices(indices: Uint32Array, vertices: number): Uint16Array | Uint32Array {
  return vertices <= 0xffff ? Uint16Array.from(indices) : indices;
}

/** The bytes a chunk or mesh adds to a reply (typed arrays, plus its strings at two bytes a character). */
export function wireBytes(x: View3dChunk | View3dMesh): number {
  if ("positions" in x) return x.positions.byteLength + x.indices.byteLength + x.key.length * 2;
  const strings = [...x.layers, ...x.names, ...x.elements].reduce((n, s) => n + s.length * 2, 0);
  return (
    x.mesh.byteLength +
    x.transform.byteLength +
    x.colour.byteLength +
    x.colourClass.byteLength +
    x.level.byteLength +
    x.layer.byteLength +
    x.name.byteLength +
    x.element.byteLength +
    strings
  );
}

/** Packs a scene for the wire. Deterministic: the same scene gives the same header, chunks and meshes. */
export function packScene(scene: Scene): PackedScene {
  const meshKeys = [...scene.meshes.keys()].sort();
  const meshIndex = new Map(meshKeys.map((k, i) => [k, i]));
  const meshes = new Map<string, View3dMesh>();
  const meshRows: PackedHeader["meshes"] = meshKeys.map((key) => {
    const m = scene.meshes.get(key);
    const positions = m ? m.positions : new Float32Array(0);
    const indices = compactIndices(m ? m.indices : new Uint32Array(0), positions.length / 3);
    const mesh: View3dMesh = { key, positions, indices };
    meshes.set(key, mesh);
    return {
      key,
      triangles: indices.length / 3,
      bytes: wireBytes(mesh),
      box: key.startsWith("box:"),
      bounds: meshBounds(positions),
    };
  });

  // instances by chunk (level, then 32-tile square), in scene order inside each chunk
  const byChunk = new Map<string, { levelIndex: number; idx: number[] }>();
  scene.instances.forEach((inst, i) => {
    const cx = Math.floor(inst.at.x / CHUNK_TILES);
    const cz = Math.floor(inst.at.z / CHUNK_TILES);
    const id = `L${String(inst.levelIndex)}:${String(cx)}:${String(cz)}`;
    let c = byChunk.get(id);
    if (!c) byChunk.set(id, (c = { levelIndex: inst.levelIndex, idx: [] }));
    c.idx.push(i);
  });
  const chunkIds = [...byChunk.keys()].sort((a, b) => {
    const ca = byChunk.get(a);
    const cb = byChunk.get(b);
    return (ca?.levelIndex ?? 0) - (cb?.levelIndex ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
  });
  const chunks = new Map<string, View3dChunk>();
  const chunkRows: PackedHeader["chunks"] = [];
  let triangles = 0;
  for (const id of chunkIds) {
    const c = byChunk.get(id);
    if (!c) continue;
    const n = c.idx.length;
    const chunk: View3dChunk = {
      id,
      count: n,
      mesh: new Uint32Array(n),
      transform: new Float32Array(n * 4),
      colour: new Uint8Array(n * 3),
      colourClass: new Uint8Array(n),
      level: new Uint8Array(n),
      layer: new Uint8Array(n),
      layers: [],
      name: new Uint32Array(n),
      names: [],
      element: new Int32Array(n),
      elements: [],
    };
    const tables = {
      layers: new Map<string, number>(),
      names: new Map<string, number>(),
      elements: new Map<string, number>(),
    };
    const lookup = (t: Map<string, number>, list: string[], s: string): number => {
      let k = t.get(s);
      if (k === undefined) {
        k = list.length;
        t.set(s, k);
        list.push(s);
      }
      return k;
    };
    const box = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
    };
    c.idx.forEach((si, j) => {
      const inst = scene.instances[si];
      if (!inst) return;
      const mi = meshIndex.get(inst.meshKey) ?? 0;
      chunk.mesh[j] = mi;
      triangles += meshRows[mi]?.triangles ?? 0;
      chunk.transform.set([inst.at.x, inst.at.y, inst.at.z, inst.rotDeg], j * 4);
      chunk.colour.set(inst.colour, j * 3);
      chunk.colourClass[j] = Math.max(0, CLASS_ORDER.indexOf(inst.colourClass));
      chunk.level[j] = Math.min(255, inst.levelIndex);
      chunk.layer[j] = lookup(tables.layers, chunk.layers, inst.layer);
      chunk.name[j] = lookup(tables.names, chunk.names, inst.name);
      chunk.element[j] =
        inst.elementId === null ? -1 : lookup(tables.elements, chunk.elements, inst.elementId);
      const a = inst.aabb;
      box.min.x = Math.min(box.min.x, a.min.x);
      box.min.y = Math.min(box.min.y, a.min.y);
      box.min.z = Math.min(box.min.z, a.min.z);
      box.max.x = Math.max(box.max.x, a.max.x);
      box.max.y = Math.max(box.max.y, a.max.y);
      box.max.z = Math.max(box.max.z, a.max.z);
    });
    chunks.set(id, chunk);
    chunkRows.push({
      id,
      levelIndex: c.levelIndex,
      bounds: wireBox(box),
      instances: n,
      bytes: wireBytes(chunk),
    });
  }

  const boxes = scene.instances.filter((i) => i.stand === "box").length;
  const reasons = new Map<string, number>();
  for (const f of scene.fallbacks) reasons.set(f.reason, (reasons.get(f.reason) ?? 0) + f.count);
  const reasonRows = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([reason, pieces]) => ({ reason, pieces }));
  return {
    header: {
      levels: scene.levels.map((l) => ({
        id: l.id,
        name: l.name,
        index: l.index,
        bounds: finite(l.bounds) ? wireBox(l.bounds) : null,
      })),
      bounds: finite(scene.bounds) ? wireBox(scene.bounds) : null,
      classes: CLASS_ORDER.map((id) => {
        const c = COLOUR_CLASSES[id];
        return { id, label: c.label, rgb: [c.rgb[0], c.rgb[1], c.rgb[2]] };
      }),
      meshes: meshRows,
      chunks: chunkRows,
      counts: { instances: scene.instances.length, boxes, triangles },
      boxes: {
        pieces: boxes,
        kinds: scene.fallbacks.length,
        reasons: reasonRows,
        note: boxNote(boxes, scene.instances.length, reasonRows),
      },
    },
    chunks,
    meshes,
  };
}

/** One plain sentence about the boxes. */
export function boxNote(
  boxes: number,
  total: number,
  reasons: ReadonlyArray<{ reason: string; pieces: number }>,
): string {
  if (boxes === 0) return "Every piece is shown with its game shape.";
  const why = reasons
    .slice(0, 3)
    .map((r) => `${String(r.pieces)} ${BOX_REASON_WORDS[r.reason] ?? r.reason}`)
    .join(", ");
  if (boxes === total) return `Every piece is shown as a box of its real size (${why}).`;
  return `${String(boxes)} of ${String(total)} pieces are shown as boxes of their real size (${why}).`;
}

/**
 * The items asked for, in the order asked, while they fit in `capBytes` (the first always goes, so a reply is never
 * empty); the rest in `more`, unknown ids dropped.
 */
export function takeWithin<T extends View3dChunk | View3dMesh>(
  ids: readonly string[],
  get: (id: string) => T | undefined,
  capBytes: number,
): { items: T[]; more: string[] } {
  const items: T[] = [];
  const more: string[] = [];
  let used = 0;
  for (const id of ids) {
    const x = get(id);
    if (!x) continue;
    const b = wireBytes(x);
    if (more.length > 0 || (items.length > 0 && used + b > capBytes)) {
      more.push(id);
      continue;
    }
    items.push(x);
    used += b;
  }
  return { items, more };
}
