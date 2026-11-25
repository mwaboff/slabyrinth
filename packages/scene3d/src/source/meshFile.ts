/**
 * The mesh cache's file format: a header (magic, format version, the piece's source key, counts, bounds), positions
 * quantised to 16 bits over the bounds, and 16-bit indices when the vertices fit (else 32-bit). About half the size
 * of float32 + uint32. A mesh is always used in its quantised form, read from the cache or freshly extracted, so a
 * picture does not depend on whether the cache was warm.
 */
import type { MeshData } from "../types/index";

const MAGIC = 0x4d443353; // "S3DM" little-endian
/** Bumped when the layout below changes; older files are then re-extracted. */
export const MESH_FILE_VERSION = 1;
const KEY_BYTES = 32;
const HEADER = 4 + 4 + KEY_BYTES + 4 + 4 + 4 + 24;

function bounds(p: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < p.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = p[i + k] ?? 0;
      if (v < (min[k] ?? 0)) min[k] = v;
      if (v > (max[k] ?? 0)) max[k] = v;
    }
  if (p.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: min.map(Math.fround), max: max.map(Math.fround) };
}

/** Encodes a mesh with its source key (at most 32 ASCII characters). */
export function encodeMeshFile(mesh: MeshData, sourceKey: string): Uint8Array {
  if (sourceKey.length > KEY_BYTES) throw new Error("mesh file: source key too long");
  const n = Math.floor(mesh.positions.length / 3);
  const wide = n > 65535;
  const posBytes = n * 6;
  const idxAt = HEADER + ((posBytes + 3) & ~3);
  const out = new Uint8Array(idxAt + mesh.indices.length * (wide ? 4 : 2));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, MESH_FILE_VERSION, true);
  for (let i = 0; i < sourceKey.length; i++) out[8 + i] = sourceKey.charCodeAt(i) & 0x7f;
  dv.setUint32(40, n, true);
  dv.setUint32(44, mesh.indices.length, true);
  dv.setUint32(48, wide ? 1 : 0, true);
  const b = bounds(mesh.positions);
  for (let k = 0; k < 3; k++) {
    dv.setFloat32(52 + 4 * k, b.min[k] ?? 0, true);
    dv.setFloat32(64 + 4 * k, b.max[k] ?? 0, true);
  }
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      const lo = b.min[k] ?? 0;
      const span = (b.max[k] ?? 0) - lo;
      const v = mesh.positions[i * 3 + k] ?? 0;
      const q = span > 0 ? Math.round(((v - lo) / span) * 65535) : 0;
      dv.setUint16(HEADER + (i * 3 + k) * 2, Math.max(0, Math.min(65535, q)), true);
    }
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i] ?? 0;
    if (wide) dv.setUint32(idxAt + 4 * i, v, true);
    else dv.setUint16(idxAt + 2 * i, v, true);
  }
  return out;
}

/** Decodes a mesh file, or null when it is not one, of another format version, or of another source key. */
export function decodeMeshFile(bytes: Uint8Array, sourceKey: string): MeshData | null {
  if (bytes.length < HEADER) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== MESH_FILE_VERSION) return null;
  for (let i = 0; i < KEY_BYTES; i++)
    if ((bytes[8 + i] ?? 0) !== (i < sourceKey.length ? sourceKey.charCodeAt(i) & 0x7f : 0)) return null;
  const n = dv.getUint32(40, true);
  const ni = dv.getUint32(44, true);
  const wide = dv.getUint32(48, true) === 1;
  const idxAt = HEADER + ((n * 6 + 3) & ~3);
  if (bytes.length !== idxAt + ni * (wide ? 4 : 2)) return null;
  const min = [0, 1, 2].map((k) => dv.getFloat32(52 + 4 * k, true));
  const max = [0, 1, 2].map((k) => dv.getFloat32(64 + 4 * k, true));
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      const lo = min[k] ?? 0;
      positions[i * 3 + k] =
        lo + (dv.getUint16(HEADER + (i * 3 + k) * 2, true) / 65535) * ((max[k] ?? 0) - lo);
    }
  const indices = new Uint32Array(ni);
  for (let i = 0; i < ni; i++) {
    const v = wide ? dv.getUint32(idxAt + 4 * i, true) : dv.getUint16(idxAt + 2 * i, true);
    if (v >= n) return null;
    indices[i] = v;
  }
  return { positions, indices };
}

/** The mesh as the cache will give it back: what every run draws. */
export function quantised(mesh: MeshData): MeshData {
  const back = decodeMeshFile(encodeMeshFile(mesh, ""), "");
  if (!back) throw new Error("mesh file round trip failed");
  return back;
}
