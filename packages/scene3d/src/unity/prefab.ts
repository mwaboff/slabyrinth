/**
 * A prefab's triangles out of an unpacked bundle: the GameObject named by the index's asset name, its Transform
 * hierarchy, each active MeshFilter + enabled MeshRenderer (LOD 1+ renderers skipped), and the Mesh vertex and index
 * buffers. Output is in the prefab root's space (the root's own transform included), Unity axes (+x east, +y up,
 * +z north), which are the game's. Ported from the 3D spike (meshlib.ts), with typed field access.
 */
import type { MeshData } from "../types/index";
import { READ_LIMITS, checkedCount, checkedRange } from "./bounded";
import { DecodeError, UnsupportedFormat } from "./errors";
import {
  CLASS,
  big,
  bytes,
  field,
  isObj,
  num,
  obj,
  objList,
  readObject,
  readSerializedFile,
  str,
  type ObjectInfo,
  type Obj,
  type SerializedFile,
} from "./serialized";
import { readBundle } from "./unityfs";

type V3 = readonly [number, number, number];
type Q = readonly [number, number, number, number];

/** A 3×4 affine transform: rows of the 3×3 part, then the translation. */
export type Affine = Float64Array;

/** Rotates v by the unit quaternion q. */
function qrot(q: Q, v: V3): [number, number, number] {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

/** Translation, rotation (quaternion), scale → affine. */
export function trs(t: V3, q: Q, s: V3): Affine {
  const ex = qrot(q, [s[0], 0, 0]);
  const ey = qrot(q, [0, s[1], 0]);
  const ez = qrot(q, [0, 0, s[2]]);
  return Float64Array.from([ex[0], ey[0], ez[0], ex[1], ey[1], ez[1], ex[2], ey[2], ez[2], t[0], t[1], t[2]]);
}

const at = (m: Affine, i: number): number => m[i] ?? 0;

export function mul(a: Affine, b: Affine): Affine {
  const r = new Float64Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] =
        at(a, i * 3) * at(b, j) + at(a, i * 3 + 1) * at(b, 3 + j) + at(a, i * 3 + 2) * at(b, 6 + j);
    r[9 + i] =
      at(a, i * 3) * at(b, 9) + at(a, i * 3 + 1) * at(b, 10) + at(a, i * 3 + 2) * at(b, 11) + at(a, 9 + i);
  }
  return r;
}

/** Applies `m` to the xyz triples of `src`, appending to `out`. */
export function applyAll(m: Affine, src: ArrayLike<number>, out: number[]): void {
  for (let i = 0; i + 2 < src.length; i += 3) {
    const x = src[i] ?? 0;
    const y = src[i + 1] ?? 0;
    const z = src[i + 2] ?? 0;
    out.push(
      at(m, 0) * x + at(m, 1) * y + at(m, 2) * z + at(m, 9),
      at(m, 3) * x + at(m, 4) * y + at(m, 5) * z + at(m, 10),
      at(m, 6) * x + at(m, 7) * y + at(m, 8) * z + at(m, 11),
    );
  }
}

export const IDENTITY: Affine = trs([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);

/** An unpacked bundle, its objects read lazily. Drop it after use: it holds the whole unpacked bundle. */
export class LoadedBundle {
  private readonly byId: Map<bigint, ObjectInfo>;
  private readonly cache = new Map<bigint, Obj>();
  readonly sf: SerializedFile;
  readonly resS: Uint8Array | undefined;

  constructor(file: Uint8Array) {
    const b = readBundle(file);
    const sfNode = b.nodes.find((n) => !n.path.endsWith(".resS") && !n.path.endsWith(".resource"));
    if (!sfNode) throw new UnsupportedFormat("bundle without a serialized file");
    this.sf = readSerializedFile(sfNode.data);
    this.resS = b.nodes.find((n) => n.path.endsWith(".resS"))?.data;
    this.byId = new Map(this.sf.objects.map((o) => [o.pathId, o]));
  }

  classOf(id: bigint): number | undefined {
    return this.byId.get(id)?.classId;
  }

  get(id: bigint): Obj | undefined {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const o = this.byId.get(id);
    if (!o) return undefined;
    const v = readObject(this.sf, o);
    this.cache.set(id, v);
    return v;
  }

  objectsOf(classId: number): ObjectInfo[] {
    return this.sf.objects.filter((o) => o.classId === classId);
  }
}

/** The local object a PPtr field points at (0 = none or in another file). */
function pptr(o: Obj, name: string): bigint {
  return pptrOf(o[name]);
}
function pptrOf(p: Obj[string] | undefined): bigint {
  if (!isObj(p)) return 0n;
  return num(p, "m_FileID") === 0 ? big(p, "m_PathID") : 0n;
}
const v3 = (o: Obj, name: string): V3 => {
  const v = obj(o, name);
  return [num(v, "x"), num(v, "y"), num(v, "z")];
};
const q4 = (o: Obj, name: string): Q => {
  const v = obj(o, name);
  return [num(v, "x"), num(v, "y"), num(v, "z"), num(v, "w")];
};

function componentIds(go: Obj): bigint[] {
  return objList(go, "m_Component").map((c) => pptr(c, "component"));
}

function componentOf(lb: LoadedBundle, go: Obj, classId: number): { id: bigint; o: Obj } | undefined {
  for (const id of componentIds(go))
    if (lb.classOf(id) === classId) {
      const o = lb.get(id);
      if (o) return { id, o };
    }
  return undefined;
}

/** A bundle's names, read once: its container's prefab entries and its GameObjects, by lower-cased name. */
interface BundleNames {
  /** Container entry base name → the prefab's root (the first entry of a name wins). */
  container: Map<string, bigint>;
  /** GameObject name → its ids, in the bundle's order. */
  objects: Map<string, bigint[]>;
}

const NAMES = new WeakMap<LoadedBundle, BundleNames>();

function bundleNames(lb: LoadedBundle): BundleNames {
  let names = NAMES.get(lb);
  if (names) return names;
  names = { container: new Map(), objects: new Map() };
  for (const ab of lb.objectsOf(CLASS.AssetBundle)) {
    const bundle = lb.get(ab.pathId);
    if (!bundle) continue;
    for (const e of objList(bundle, "m_Container")) {
      const path = str(e, "first").toLowerCase();
      if (!path.endsWith(".prefab")) continue;
      const base = path.slice(path.lastIndexOf("/") + 1, -".prefab".length);
      if (!names.container.has(base)) names.container.set(base, pptr(obj(e, "second"), "asset"));
    }
  }
  for (const o of lb.objectsOf(CLASS.GameObject)) {
    const go = lb.get(o.pathId);
    if (!go) continue;
    const name = str(go, "m_Name").toLowerCase();
    const list = names.objects.get(name);
    if (list) list.push(o.pathId);
    else names.objects.set(name, [o.pathId]);
  }
  NAMES.set(lb, names);
  return names;
}

/**
 * The prefab root GameObject for an index asset name: the bundle's container entry, else a root GameObject by name.
 * The bundle's names are read once (a bundle is asked for many prefabs), so each look-up is a map read.
 */
export function findPrefabRoot(lb: LoadedBundle, assetName: string): bigint | undefined {
  const want = assetName.toLowerCase();
  const names = bundleNames(lb);
  const listed = names.container.get(want);
  if (listed !== undefined) return listed;
  for (const id of names.objects.get(want) ?? []) {
    const go = lb.get(id);
    const tr = go ? componentOf(lb, go, CLASS.Transform) : undefined;
    if (tr && pptr(tr.o, "m_Father") === 0n) return id;
  }
  return undefined;
}

/** Bytes per component of each vertex format (Unity VertexFormat order). */
const FORMAT_SIZE = [4, 2, 1, 1, 2, 2, 1, 1, 2, 2, 4, 4];

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** A Mesh object's positions and triangle indices (submeshes of triangles only). */
export function meshGeometry(lb: LoadedBundle, mesh: Obj): MeshData {
  if (num(mesh, "m_MeshCompression") !== 0) throw new UnsupportedFormat("compressed mesh");
  const vd = obj(mesh, "m_VertexData");
  const channels = objList(vd, "m_Channels");
  let data = bytes(vd, "m_DataSize");
  const sd = mesh["m_StreamData"];
  if (isObj(sd) && num(sd, "size") > 0) {
    if (!lb.resS) throw new DecodeError("mesh streams from .resS but the bundle has none");
    const off = checkedRange("mesh stream", num(sd, "offset"), num(sd, "size"), lb.resS.length);
    data = lb.resS.subarray(off, off + num(sd, "size"));
  }
  // a channel's dimension is its low 4 bits (the high bits are flags): one reading for the check and the stride
  const dims = (c: Obj): number => num(c, "dimension") & 0xf;
  // streams are consecutive, each aligned to 16 bytes
  const used = channels.filter((c) => dims(c) > 0);
  const streams = used.reduce((m, c) => Math.max(m, num(c, "stream")), -1) + 1;
  const strideOf = (s: number): number => {
    let stride = 0;
    for (const c of used)
      if (num(c, "stream") === s)
        stride = Math.max(stride, num(c, "offset") + (FORMAT_SIZE[num(c, "format")] ?? 4) * dims(c));
    return stride;
  };
  const pc = channels[0];
  if (!pc || dims(pc) < 3) throw new DecodeError("mesh without positions");
  const fmt = num(pc, "format");
  if (fmt !== 0 && fmt !== 1) throw new UnsupportedFormat(`position format ${fmt}`);
  const ps = num(pc, "stream");
  const posBytes = fmt === 0 ? 12 : 6;
  // the vertex count is a claim: each vertex takes at least the position stream's stride (never less than a position)
  const stride = strideOf(ps);
  if (stride < num(pc, "offset") + posBytes) throw new DecodeError("vertex stride shorter than its position");
  const n = checkedCount("mesh vertices", num(vd, "m_VertexCount"), stride, data.length);
  let pos = 0;
  let base = -1;
  for (let s = 0; s < streams; s++) {
    if (s === ps) base = pos + num(pc, "offset");
    pos = (pos + strideOf(s) * n + 15) & ~15;
  }
  if (base < 0 || (n > 0 && base + stride * (n - 1) + posBytes > data.length))
    throw new DecodeError("vertex data shorter than its vertices");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = base + stride * i;
    for (let k = 0; k < 3; k++)
      positions[i * 3 + k] =
        fmt === 0 ? dv.getFloat32(o + 4 * k, true) : halfToFloat(dv.getUint16(o + 2 * k, true));
  }
  const ib = bytes(mesh, "m_IndexBuffer");
  const wide = num(mesh, "m_IndexFormat") === 1;
  const idv = new DataView(ib.buffer, ib.byteOffset, ib.byteLength);
  const tris: number[] = [];
  for (const sm of objList(mesh, "m_SubMeshes")) {
    if (num(sm, "topology") !== 0) continue; // triangles only
    const w = wide ? 4 : 2;
    const firstByte = checkedRange("submesh", num(sm, "firstByte"), num(sm, "indexCount") * w, ib.length);
    if (firstByte % w !== 0) throw new DecodeError("submesh starts inside an index");
    const first = firstByte / w;
    const count = num(sm, "indexCount");
    const baseVertex = num(sm, "baseVertex");
    for (let i = 0; i < count; i++) {
      const v =
        (wide ? idv.getUint32((first + i) * 4, true) : idv.getUint16((first + i) * 2, true)) + baseVertex;
      if (!(v >= 0 && v < n)) throw new DecodeError("index outside the vertices");
      tris.push(v);
    }
  }
  return { positions, indices: Uint32Array.from(tris) };
}

/** Every active, enabled mesh renderer under a prefab root (LOD 1+ skipped), in the root's space. */
export function prefabGeometry(lb: LoadedBundle, rootGo: bigint): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const skip = new Set<bigint>();
  const seen = new Set<bigint>();
  const visit = (goId: bigint, parent: Affine, depth: number): void => {
    if (seen.has(goId)) throw new DecodeError("transform hierarchy has a cycle");
    if (depth > READ_LIMITS.hierarchyDepth) throw new DecodeError("transform hierarchy too deep");
    seen.add(goId);
    const go = lb.get(goId);
    if (!go) return;
    if (field(go, "m_IsActive") === false) return;
    const tr = componentOf(lb, go, CLASS.Transform);
    if (!tr) return;
    const m = mul(
      parent,
      trs(v3(tr.o, "m_LocalPosition"), q4(tr.o, "m_LocalRotation"), v3(tr.o, "m_LocalScale")),
    );
    const lod = componentOf(lb, go, CLASS.LODGroup);
    if (lod)
      for (const l of objList(lod.o, "m_LODs").slice(1))
        for (const r of objList(l, "renderers")) skip.add(pptr(r, "renderer"));
    const mf = componentOf(lb, go, CLASS.MeshFilter);
    const mr = componentOf(lb, go, CLASS.MeshRenderer);
    if (mf && mr && mr.o["m_Enabled"] !== false && !skip.has(mr.id)) {
      const mesh = lb.get(pptr(mf.o, "m_Mesh"));
      if (mesh) {
        const g = meshGeometry(lb, mesh);
        const base = positions.length / 3;
        applyAll(m, g.positions, positions);
        for (const i of g.indices) indices.push(i + base);
      }
    }
    for (const child of objList(tr.o, "m_Children")) {
      const ct = lb.get(pptrOf(child));
      if (ct) visit(pptr(ct, "m_GameObject"), m, depth + 1);
    }
  };
  visit(rootGo, IDENTITY, 0);
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}
