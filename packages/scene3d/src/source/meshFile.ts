/**
 * The mesh cache's file format: a header (magic, format version, the piece's source key, counts, a layout word, bounds),
 * positions quantised to 16 bits over the bounds, and 16-bit indices when the vertices fit (else 32-bit). About half the
 * size of float32 + uint32. A mesh is always used in its quantised form, read from the cache or freshly extracted, so a
 * picture does not depend on whether the cache was warm.
 *
 * A piece whose prefab could not be read is recorded too, under the same source key a mesh would have had (layout word
 * FAILED, no vertices, then its reason and detail as JSON): the next run answers it from the cache as a box with its
 * reason instead of reading its bundle again, and a game update that changes the bundle changes the key, so it is
 * retried then and only then. A reader of the first layout sees a failure record as a miss (its length does not match).
 */
import { strFromU8, strToU8 } from "fflate";
import { meshBox } from "../geom/mesh";
import type { FallbackReason, MeshData } from "../types/index";

const MAGIC = 0x4d443353; // "S3DM" little-endian
/** Bumped when the layout below changes; older files are then re-extracted. */
export const MESH_FILE_VERSION = 1;
const KEY_BYTES = 32;
const HEADER = 4 + 4 + KEY_BYTES + 4 + 4 + 4 + 24;
/** The layout word: 16-bit indices, 32-bit indices, or a failure record. */
const LAYOUT = { narrow: 0, wide: 1, failed: 2 } as const;
/** Longest failure record body (reason and detail as JSON); a longer detail is cut. */
const FAILURE_BYTES = 2048;
/** The reasons a failure record may hold: the bundle's bytes decided them, so they hold until the bundle changes. */
const RECORDED: ReadonlySet<FallbackReason> = new Set(["unsupported-format", "decode-failed"]);

/** A recorded failure: why the piece's prefab could not be read. */
export interface MeshFailure {
  reason: FallbackReason;
  detail: string;
}

/** What a cache file holds for a source key: the piece's mesh, the reason it could not be read, or nothing usable. */
export type CacheEntry = { kind: "mesh"; mesh: MeshData } | ({ kind: "failed" } & MeshFailure) | null;

/** Is a failure one the bundle's bytes decided (so it is recorded until the bundle changes)? */
export const recordedFailure = (reason: FallbackReason): boolean => RECORDED.has(reason);

function header(sourceKey: string, layout: number, bodyBytes: number): Uint8Array {
  if (sourceKey.length > KEY_BYTES) throw new Error("mesh file: source key too long");
  const out = new Uint8Array(HEADER + bodyBytes);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, MESH_FILE_VERSION, true);
  for (let i = 0; i < sourceKey.length; i++) out[8 + i] = sourceKey.charCodeAt(i) & 0x7f;
  dv.setUint32(48, layout, true);
  return out;
}

/** Encodes a failure record for a piece with its source key. */
export function encodeFailureFile(failure: MeshFailure, sourceKey: string): Uint8Array {
  if (!RECORDED.has(failure.reason)) throw new Error(`mesh file: ${failure.reason} is not recorded`);
  let detail = failure.detail;
  let body = strToU8(JSON.stringify({ reason: failure.reason, detail }));
  while (body.length > FAILURE_BYTES) {
    detail = detail.slice(0, Math.floor(detail.length / 2));
    body = strToU8(JSON.stringify({ reason: failure.reason, detail }));
  }
  const out = header(sourceKey, LAYOUT.failed, body.length);
  out.set(body, HEADER);
  return out;
}

/** The quantisation range: the mesh's box (geom/mesh.ts `meshBox`) in float32, zero for a mesh of no vertices. */
function bounds(mesh: MeshData): { min: number[]; max: number[] } {
  if (mesh.positions.length < 3) return { min: [0, 0, 0], max: [0, 0, 0] };
  const b = meshBox(mesh);
  return {
    min: [b.min.x, b.min.y, b.min.z].map(Math.fround),
    max: [b.max.x, b.max.y, b.max.z].map(Math.fround),
  };
}

/** Encodes a mesh with its source key (at most 32 ASCII characters). */
export function encodeMeshFile(mesh: MeshData, sourceKey: string): Uint8Array {
  const n = Math.floor(mesh.positions.length / 3);
  const wide = n > 65535;
  const posBytes = n * 6;
  const idxAt = HEADER + ((posBytes + 3) & ~3);
  const out = header(
    sourceKey,
    wide ? LAYOUT.wide : LAYOUT.narrow,
    idxAt - HEADER + mesh.indices.length * (wide ? 4 : 2),
  );
  const dv = new DataView(out.buffer);
  dv.setUint32(40, n, true);
  dv.setUint32(44, mesh.indices.length, true);
  const b = bounds(mesh);
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

/** Decodes a cache file: the mesh or the failure it records, or null when it is neither, of another version or key. */
export function decodeCacheFile(bytes: Uint8Array, sourceKey: string): CacheEntry {
  if (bytes.length < HEADER) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== MESH_FILE_VERSION) return null;
  for (let i = 0; i < KEY_BYTES; i++)
    if ((bytes[8 + i] ?? 0) !== (i < sourceKey.length ? sourceKey.charCodeAt(i) & 0x7f : 0)) return null;
  if (dv.getUint32(48, true) === LAYOUT.failed) return decodeFailure(bytes.subarray(HEADER));
  const mesh = decodeMeshBody(bytes, dv);
  return mesh ? { kind: "mesh", mesh } : null;
}

function decodeFailure(body: Uint8Array): CacheEntry {
  if (body.length > FAILURE_BYTES) return null;
  try {
    const v: unknown = JSON.parse(strFromU8(body));
    if (typeof v !== "object" || v === null) return null;
    const { reason, detail } = v as { reason?: unknown; detail?: unknown };
    if (typeof reason !== "string" || typeof detail !== "string") return null;
    if (!RECORDED.has(reason as FallbackReason)) return null;
    return { kind: "failed", reason: reason as FallbackReason, detail };
  } catch {
    return null;
  }
}

/** Decodes a mesh file, or null when it is not one (a failure record too), of another format version or source key. */
export function decodeMeshFile(bytes: Uint8Array, sourceKey: string): MeshData | null {
  const e = decodeCacheFile(bytes, sourceKey);
  return e?.kind === "mesh" ? e.mesh : null;
}

function decodeMeshBody(bytes: Uint8Array, dv: DataView): MeshData | null {
  const n = dv.getUint32(40, true);
  const ni = dv.getUint32(44, true);
  const layout = dv.getUint32(48, true);
  if (layout !== LAYOUT.narrow && layout !== LAYOUT.wide) return null;
  const wide = layout === LAYOUT.wide;
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
