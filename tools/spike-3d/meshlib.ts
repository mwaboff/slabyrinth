/**
 * Reads a prefab's renderable triangles out of a TaleSpire bundle: bundle -> SerializedFile -> GameObject named
 * like the index's AssetName -> Transform hierarchy -> MeshFilter/MeshRenderer -> Mesh vertex and index buffers.
 * Output is in the prefab root's space (the root's own TRS included), Unity axes (+x east, +y up, +z north).
 */
import { readFileSync } from "node:fs";
import { readBundle } from "./unityfs";
import { CLASS, readObject, readSerializedFile, type ObjectInfo, type SerializedFile, type Value } from "./serialized";

type V3 = [number, number, number];
type Q = [number, number, number, number];
type Obj = Record<string, Value>;

export interface Geometry {
  /** xyz triples. */
  positions: Float32Array;
  /** triangle vertex indices. */
  indices: Uint32Array;
  /** Average vertex colour (0..1 RGB) when the mesh has a colour channel. */
  meanColor?: V3;
}

export interface LoadedBundle {
  path: string;
  sf: SerializedFile;
  resS: Uint8Array | undefined;
  byId: Map<bigint, ObjectInfo>;
  cache: Map<bigint, Obj>;
  stats: { fileBytes: number; unpackedBytes: number; ms: number };
}

export function loadBundle(path: string): LoadedBundle {
  const t0 = performance.now();
  const file = readFileSync(path);
  const b = readBundle(file);
  const sfNode = b.nodes.find((n) => !n.path.endsWith(".resS") && !n.path.endsWith(".resource"));
  if (!sfNode) throw new Error(`${path}: no serialized file`);
  const sf = readSerializedFile(sfNode.data);
  if (!sf.typeTreeEnabled) throw new Error(`${path}: type trees stripped`);
  const resS = b.nodes.find((n) => n.path.endsWith(".resS"))?.data;
  const byId = new Map(sf.objects.map((o) => [o.pathId, o]));
  return {
    path,
    sf,
    resS,
    byId,
    cache: new Map(),
    stats: {
      fileBytes: file.length,
      unpackedBytes: b.nodes.reduce((n, x) => n + x.data.length, 0),
      ms: performance.now() - t0,
    },
  };
}

export function obj(lb: LoadedBundle, id: bigint): Obj | undefined {
  let v = lb.cache.get(id);
  if (v) return v;
  const o = lb.byId.get(id);
  if (!o) return undefined;
  v = readObject(lb.sf, o);
  lb.cache.set(id, v);
  return v;
}
const pptr = (v: Value | undefined): bigint => {
  const p = v as Obj | undefined;
  return p && (p.m_FileID as number) === 0 ? (p.m_PathID as bigint) : 0n;
};
const v3 = (v: Value): V3 => {
  const o = v as Obj;
  return [o.x as number, o.y as number, o.z as number];
};
const q4 = (v: Value): Q => {
  const o = v as Obj;
  return [o.x as number, o.y as number, o.z as number, o.w as number];
};

/** Rotates v by unit quaternion q. */
export function qrot(q: Q, v: V3): V3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}
/** 3x4 affine as [m00..m22 (row-major 3x3), tx, ty, tz]. */
export type Affine = Float64Array;
export function trs(t: V3, q: Q, s: V3): Affine {
  const ex = qrot(q, [s[0], 0, 0]);
  const ey = qrot(q, [0, s[1], 0]);
  const ez = qrot(q, [0, 0, s[2]]);
  // columns ex, ey, ez
  return Float64Array.from([ex[0], ey[0], ez[0], ex[1], ey[1], ez[1], ex[2], ey[2], ez[2], t[0], t[1], t[2]]);
}
export function mul(a: Affine, b: Affine): Affine {
  const r = new Float64Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
    r[9 + i] = a[i * 3]! * b[9]! + a[i * 3 + 1]! * b[10]! + a[i * 3 + 2]! * b[11]! + a[9 + i]!;
  }
  return r;
}
export function apply(m: Affine, x: number, y: number, z: number): V3 {
  return [
    m[0]! * x + m[1]! * y + m[2]! * z + m[9]!,
    m[3]! * x + m[4]! * y + m[5]! * z + m[10]!,
    m[6]! * x + m[7]! * y + m[8]! * z + m[11]!,
  ];
}
export const IDENTITY: Affine = trs([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);

const FORMAT_SIZE = [4, 2, 1, 1, 2, 2, 1, 1, 2, 2, 4, 4];

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

export function meshGeometry(lb: LoadedBundle, mesh: Obj): Geometry {
  if ((mesh.m_MeshCompression as number) !== 0) throw new Error(`mesh ${String(mesh.m_Name)} uses mesh compression`);
  const vd = mesh.m_VertexData as Obj;
  const n = vd.m_VertexCount as number;
  const channels = vd.m_Channels as Obj[];
  let data = vd.m_DataSize as Uint8Array;
  const sd = mesh.m_StreamData as Obj | undefined;
  if (sd && (sd.size as number) > 0) {
    if (!lb.resS) throw new Error("mesh streams from .resS but the bundle has none");
    const off = Number(sd.offset as bigint);
    data = lb.resS.subarray(off, off + (sd.size as number));
  }
  // stream layout: streams are consecutive, each aligned to 16 bytes
  const streams = Math.max(...channels.filter((c) => (c.dimension as number) > 0).map((c) => c.stream as number)) + 1;
  const strides: number[] = [];
  const offsets: number[] = [];
  let at = 0;
  for (let s = 0; s < streams; s++) {
    let stride = 0;
    for (const c of channels)
      if ((c.stream as number) === s && (c.dimension as number) > 0)
        stride = Math.max(
          stride,
          (c.offset as number) + FORMAT_SIZE[c.format as number]! * ((c.dimension as number) & 0xf),
        );
    offsets.push(at);
    strides.push(stride);
    at += stride * n;
    at = (at + 15) & ~15;
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pc = channels[0]!;
  const ps = pc.stream as number;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = offsets[ps]! + strides[ps]! * i + (pc.offset as number);
    for (let k = 0; k < 3; k++)
      positions[i * 3 + k] =
        (pc.format as number) === 0 ? dv.getFloat32(o + 4 * k, true) : halfToFloat(dv.getUint16(o + 2 * k, true));
  }
  let meanColor: V3 | undefined;
  const cc = channels[3];
  if (cc && (cc.dimension as number) >= 3 && (cc.format as number) === 2) {
    const sum = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const o = offsets[cc.stream as number]! + strides[cc.stream as number]! * i + (cc.offset as number);
      for (let k = 0; k < 3; k++) sum[k]! += data[o + k]! / 255;
    }
    meanColor = [sum[0]! / n, sum[1]! / n, sum[2]! / n];
  }
  const ib = mesh.m_IndexBuffer as Uint8Array;
  const wide = (mesh.m_IndexFormat as number) === 1;
  const idv = new DataView(ib.buffer, ib.byteOffset, ib.byteLength);
  const tris: number[] = [];
  for (const sm of mesh.m_SubMeshes as Obj[]) {
    if ((sm.topology as number) !== 0) continue; // triangles only
    const first = (sm.firstByte as number) / (wide ? 4 : 2);
    const count = sm.indexCount as number;
    const base = sm.baseVertex as number;
    for (let i = 0; i < count; i++)
      tris.push((wide ? idv.getUint32((first + i) * 4, true) : idv.getUint16((first + i) * 2, true)) + base);
  }
  return { positions, indices: Uint32Array.from(tris), meanColor };
}

export interface PrefabGeometry extends Geometry {
  meshNames: string[];
  rootName: string;
}

/** Finds the GameObject for an index AssetName (root GameObject name, else container basename). */
export function findPrefabRoot(lb: LoadedBundle, assetName: string): bigint | undefined {
  const want = assetName.toLowerCase();
  const ab = lb.sf.objects.find((o) => o.classId === CLASS.AssetBundle);
  if (ab) {
    for (const e of obj(lb, ab.pathId)!.m_Container as Obj[]) {
      const path = (e.first as string).toLowerCase();
      if (!path.endsWith(".prefab")) continue;
      const base = path.slice(path.lastIndexOf("/") + 1, -".prefab".length);
      if (base === want) return pptr((e.second as Obj).asset);
    }
  }
  for (const o of lb.sf.objects) {
    if (o.classId !== CLASS.GameObject) continue;
    const go = obj(lb, o.pathId)!;
    if ((go.m_Name as string).toLowerCase() !== want) continue;
    const tr = componentOf(lb, go, CLASS.Transform);
    if (tr && pptr(tr.m_Father) === 0n) return o.pathId;
  }
  return undefined;
}

function componentOf(lb: LoadedBundle, go: Obj, classId: number): Obj | undefined {
  for (const c of go.m_Component as Obj[]) {
    const id = pptr(c.component);
    if (lb.byId.get(id)?.classId === classId) return obj(lb, id);
  }
  return undefined;
}

/** Collects all active, enabled mesh renderers under a prefab root, skipping LOD levels above 0. */
export function prefabGeometry(lb: LoadedBundle, rootGo: bigint, includeRootTransform = true): PrefabGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const meshNames: string[] = [];
  const colors: Array<[V3, number]> = [];
  const root = obj(lb, rootGo)!;
  // renderers that belong to LOD 1+ of any LODGroup are skipped
  const skip = new Set<bigint>();
  const visit = (goId: bigint, parent: Affine, isRoot: boolean): void => {
    const go = obj(lb, goId)!;
    if (go.m_IsActive === false) return;
    const tr = componentOf(lb, go, CLASS.Transform)!;
    const local = trs(v3(tr.m_LocalPosition!), q4(tr.m_LocalRotation!), v3(tr.m_LocalScale!));
    const m = isRoot && !includeRootTransform ? parent : mul(parent, local);
    const lod = componentOf(lb, go, CLASS.LODGroup);
    if (lod) {
      const lods = lod.m_LODs as Obj[];
      for (const l of lods.slice(1))
        for (const r of l.renderers as Obj[]) skip.add(pptr(r.renderer));
    }
    const mf = componentOf(lb, go, CLASS.MeshFilter);
    const mrId = (go.m_Component as Obj[])
      .map((c) => pptr(c.component))
      .find((id) => lb.byId.get(id)?.classId === CLASS.MeshRenderer);
    const mr = mrId !== undefined ? obj(lb, mrId) : undefined;
    if (mf && mr && mr.m_Enabled !== false && !(mrId !== undefined && skip.has(mrId))) {
      const mesh = obj(lb, pptr(mf.m_Mesh));
      if (mesh) {
        const g = meshGeometry(lb, mesh);
        const base = positions.length / 3;
        for (let i = 0; i < g.positions.length; i += 3) {
          const p = apply(m, g.positions[i]!, g.positions[i + 1]!, g.positions[i + 2]!);
          positions.push(p[0], p[1], p[2]);
        }
        for (const i of g.indices) indices.push(i + base);
        meshNames.push(mesh.m_Name as string);
        if (g.meanColor) colors.push([g.meanColor, g.positions.length / 3]);
      }
    }
    for (const ch of tr.m_Children as Obj[]) {
      const ctr = obj(lb, pptr(ch));
      if (ctr) visit(pptr(ctr.m_GameObject), m, false);
    }
  };
  visit(rootGo, IDENTITY, true);
  let meanColor: V3 | undefined;
  if (colors.length) {
    const tot = colors.reduce((n, [, w]) => n + w, 0);
    meanColor = [0, 1, 2].map((k) => colors.reduce((s, [c, w]) => s + c[k]! * w, 0) / tot) as V3;
  }
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    meshNames,
    rootName: root.m_Name as string,
    meanColor,
  };
}
