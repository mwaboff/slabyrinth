/**
 * Unity SerializedFile reader (format 22, Unity 2021.3) with a generic type-tree deserializer: every object is read
 * through the type tree stored in the file itself, so no per-class layout is hard-coded here.
 */

export interface TypeNode {
  type: string;
  name: string;
  level: number;
  byteSize: number;
  metaFlag: number;
}
export interface SerializedType {
  classId: number;
  nodes: TypeNode[];
}
export interface ObjectInfo {
  pathId: bigint;
  byteStart: number;
  byteSize: number;
  classId: number;
  typeIndex: number;
}
export interface SerializedFile {
  version: number;
  unityVersion: string;
  bigEndian: boolean;
  typeTreeEnabled: boolean;
  types: SerializedType[];
  objects: ObjectInfo[];
  externals: string[];
  data: Uint8Array;
  dataOffset: number;
}

const COMMON_STRINGS: Record<number, string> = {};
// Unity's built-in common string table (offsets with bit 31 set). Only the entries used by typical classes matter;
// it is reconstructed below from the well-known ordered list.
const COMMON =
  "AABB\0AnimationClip\0AnimationCurve\0AnimationState\0Array\0Base\0BitField\0bitset\0bool\0char\0ColorRGBA\0Component\0data\0deque\0double\0dynamic_array\0FastPropertyName\0first\0float\0Font\0GameObject\0Generic Mono\0GradientNEW\0GUID\0GUIStyle\0int\0list\0long long\0map\0Matrix4x4f\0MdFour\0MonoBehaviour\0MonoScript\0m_ByteSize\0m_Curve\0m_EditorClassIdentifier\0m_EditorHideFlags\0m_Enabled\0m_ExtensionPtr\0m_GameObject\0m_Index\0m_IsArray\0m_IsStatic\0m_MetaFlag\0m_Name\0m_ObjectHideFlags\0m_PrefabInternal\0m_PrefabParentObject\0m_Script\0m_StaticEditorFlags\0m_Type\0m_Version\0Object\0pair\0PPtr<Component>\0PPtr<GameObject>\0PPtr<Material>\0PPtr<MonoBehaviour>\0PPtr<MonoScript>\0PPtr<Object>\0PPtr<Prefab>\0PPtr<Sprite>\0PPtr<TextAsset>\0PPtr<Texture>\0PPtr<Texture2D>\0PPtr<Transform>\0Prefab\0Quaternionf\0Rectf\0RectInt\0RectOffset\0second\0set\0short\0size\0SInt16\0SInt32\0SInt64\0SInt8\0staticvector\0string\0TextAsset\0TextMesh\0Texture\0Texture2D\0Transform\0TypelessData\0UInt16\0UInt32\0UInt64\0UInt8\0unsigned int\0unsigned long long\0unsigned short\0vector\0Vector2f\0Vector3f\0Vector4f\0m_ScriptingClassIdentifier\0Gradient\0Type*\0int2_storage\0int3_storage\0BoundsInt\0m_CorrespondingSourceObject\0m_PrefabInstance\0m_PrefabAsset\0FileSize\0Hash128\0";
{
  let off = 0;
  for (const s of COMMON.split("\0")) {
    COMMON_STRINGS[off] = s;
    off += s.length + 1;
  }
}

export class Cursor {
  p = 0;
  readonly dv: DataView;
  constructor(
    readonly b: Uint8Array,
    public little = true,
  ) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  align4(): void {
    this.p = (this.p + 3) & ~3;
  }
  u8(): number {
    return this.b[this.p++]!;
  }
  i8(): number {
    return this.dv.getInt8(this.p++);
  }
  u16(): number {
    const v = this.dv.getUint16(this.p, this.little);
    this.p += 2;
    return v;
  }
  i16(): number {
    const v = this.dv.getInt16(this.p, this.little);
    this.p += 2;
    return v;
  }
  u32(): number {
    const v = this.dv.getUint32(this.p, this.little);
    this.p += 4;
    return v;
  }
  i32(): number {
    const v = this.dv.getInt32(this.p, this.little);
    this.p += 4;
    return v;
  }
  i64(): bigint {
    const v = this.dv.getBigInt64(this.p, this.little);
    this.p += 8;
    return v;
  }
  u64(): bigint {
    const v = this.dv.getBigUint64(this.p, this.little);
    this.p += 8;
    return v;
  }
  f32(): number {
    const v = this.dv.getFloat32(this.p, this.little);
    this.p += 4;
    return v;
  }
  f64(): number {
    const v = this.dv.getFloat64(this.p, this.little);
    this.p += 8;
    return v;
  }
  bytes(n: number): Uint8Array {
    const v = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return v;
  }
  cstr(): string {
    let e = this.p;
    while (this.b[e] !== 0) e++;
    const s = new TextDecoder().decode(this.b.subarray(this.p, e));
    this.p = e + 1;
    return s;
  }
}

function readTypeTreeBlob(c: Cursor, version: number): TypeNode[] {
  const nodeCount = c.i32();
  const strSize = c.i32();
  const nodeSize = version >= 19 ? 32 : 24;
  const nodesAt = c.p;
  const strAt = nodesAt + nodeCount * nodeSize;
  const strBuf = c.b.subarray(strAt, strAt + strSize);
  const str = (off: number): string => {
    if (off & 0x80000000) return COMMON_STRINGS[off & 0x7fffffff] ?? `common@${off & 0x7fffffff}`;
    let e = off;
    while (strBuf[e] !== 0) e++;
    return new TextDecoder().decode(strBuf.subarray(off, e));
  };
  const nodes: TypeNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    c.u16(); // version
    const level = c.u8();
    c.u8(); // type flags
    const typeOff = c.u32();
    const nameOff = c.u32();
    const byteSize = c.i32();
    c.i32(); // index
    const metaFlag = c.i32();
    if (version >= 19) c.u64(); // ref type hash
    nodes.push({ type: str(typeOff), name: str(nameOff), level, byteSize, metaFlag });
  }
  c.p = strAt + strSize;
  return nodes;
}

export function readSerializedFile(b: Uint8Array): SerializedFile {
  const h = new Cursor(b, false);
  h.u32(); // metadata size (old)
  h.u32(); // file size (old)
  const version = h.u32();
  let dataOffset = h.u32();
  if (version < 22) throw new Error(`SerializedFile version ${version}: this spike reader handles 22+`);
  const bigEndian = h.u8() !== 0;
  h.p += 3;
  h.u32(); // metadata size
  h.i64(); // file size
  dataOffset = Number(h.i64());
  h.i64();
  const c = new Cursor(b, !bigEndian);
  c.p = h.p;
  const unityVersion = c.cstr();
  c.i32(); // target platform
  const typeTreeEnabled = c.u8() !== 0;
  const readTypes = (isRef: boolean): SerializedType[] => {
    const n = c.i32();
    const out: SerializedType[] = [];
    for (let i = 0; i < n; i++) {
      const classId = c.i32();
      c.u8(); // stripped
      const scriptTypeIndex = c.i16();
      if ((isRef && scriptTypeIndex >= 0) || classId === 114) c.bytes(16); // script id
      c.bytes(16); // old type hash
      let nodes: TypeNode[] = [];
      if (typeTreeEnabled) {
        nodes = readTypeTreeBlob(c, version);
        if (version >= 21) {
          if (isRef) {
            c.cstr();
            c.cstr();
            c.cstr();
          } else {
            const deps = c.i32();
            c.p += 4 * deps;
          }
        }
      }
      out.push({ classId, nodes });
    }
    return out;
  };
  const types = readTypes(false);
  const objCount = c.i32();
  const objects: ObjectInfo[] = [];
  for (let i = 0; i < objCount; i++) {
    c.align4();
    const pathId = c.i64();
    const byteStart = Number(c.i64());
    const byteSize = c.u32();
    const typeIndex = c.i32();
    objects.push({ pathId, byteStart, byteSize, typeIndex, classId: types[typeIndex]?.classId ?? -1 });
  }
  const scriptCount = c.i32();
  for (let i = 0; i < scriptCount; i++) {
    c.i32();
    c.align4();
    c.i64();
  }
  const extCount = c.i32();
  const externals: string[] = [];
  for (let i = 0; i < extCount; i++) {
    c.cstr();
    c.bytes(16);
    c.i32();
    externals.push(c.cstr());
  }
  return { version, unityVersion, bigEndian, typeTreeEnabled, types, objects, externals, data: b, dataOffset };
}

export type Value = number | bigint | boolean | string | Uint8Array | Value[] | { [k: string]: Value } | Float32Array;

/** Reads one object through its type tree into plain JS values. */
export function readObject(sf: SerializedFile, o: ObjectInfo): Record<string, Value> {
  const t = sf.types[o.typeIndex];
  if (!t || !t.nodes.length) throw new Error("object has no type tree");
  const c = new Cursor(sf.data, !sf.bigEndian);
  c.p = sf.dataOffset + o.byteStart;
  const nodes = t.nodes;
  const children = (i: number): number[] => {
    const out: number[] = [];
    const lvl = nodes[i]!.level;
    for (let k = i + 1; k < nodes.length && nodes[k]!.level > lvl; k++)
      if (nodes[k]!.level === lvl + 1) out.push(k);
    return out;
  };
  const kidsCache = new Map<number, number[]>();
  const kids = (i: number): number[] => {
    let v = kidsCache.get(i);
    if (!v) kidsCache.set(i, (v = children(i)));
    return v;
  };
  const prim = (type: string): Value | undefined => {
    switch (type) {
      case "SInt8":
        return c.i8();
      case "UInt8":
      case "char":
        return c.u8();
      case "bool":
        return c.u8() !== 0;
      case "SInt16":
      case "short":
        return c.i16();
      case "UInt16":
      case "unsigned short":
        return c.u16();
      case "SInt32":
      case "int":
        return c.i32();
      case "UInt32":
      case "unsigned int":
      case "Type*":
        return c.u32();
      case "SInt64":
      case "long long":
        return c.i64();
      case "UInt64":
      case "unsigned long long":
      case "FileSize":
        return c.u64();
      case "float":
        return c.f32();
      case "double":
        return c.f64();
      default:
        return undefined;
    }
  };
  const read = (i: number): Value => {
    const n = nodes[i]!;
    let v: Value;
    const ks = kids(i);
    if (n.type === "string") {
      const len = c.i32();
      v = new TextDecoder().decode(c.bytes(len));
      const arr = ks[0] !== undefined ? nodes[ks[0]]! : undefined;
      if (arr && arr.metaFlag & 0x4000) c.align4();
    } else if (n.type === "TypelessData") {
      v = c.bytes(c.i32());
    } else if (ks.length === 0) {
      const p = prim(n.type);
      if (p === undefined) throw new Error(`unknown primitive ${n.type} (${n.name})`);
      v = p;
    } else if (ks.length === 1 && nodes[ks[0]!]!.type === "Array") {
      v = readArray(ks[0]!);
    } else if (n.type === "Array") {
      v = readArray(i);
      return v; // readArray handles align
    } else {
      const obj: Record<string, Value> = {};
      for (const k of ks) obj[nodes[k]!.name] = read(k);
      v = obj;
    }
    if (n.metaFlag & 0x4000) c.align4();
    return v;
  };
  const readArray = (ai: number): Value => {
    const a = nodes[ai]!;
    const [, dataIdx] = kids(ai);
    const size = c.i32();
    const dn = nodes[dataIdx!]!;
    let v: Value;
    if ((dn.type === "UInt8" || dn.type === "char") && kids(dataIdx!).length === 0) {
      v = c.bytes(size);
    } else if (dn.type === "float" && kids(dataIdx!).length === 0) {
      const f = new Float32Array(size);
      for (let k = 0; k < size; k++) f[k] = c.f32();
      v = f;
    } else {
      const arr: Value[] = [];
      for (let k = 0; k < size; k++) arr.push(read(dataIdx!));
      v = arr;
    }
    if (a.metaFlag & 0x4000) c.align4();
    return v;
  };
  const root: Record<string, Value> = {};
  for (const k of kids(0)) root[nodes[k]!.name] = read(k);
  return root;
}

export const CLASS = {
  GameObject: 1,
  Transform: 4,
  Material: 21,
  MeshRenderer: 23,
  Texture2D: 28,
  MeshFilter: 33,
  Mesh: 43,
  MonoBehaviour: 114,
  MeshCollider: 64,
  BoxCollider: 65,
  AssetBundle: 142,
  LODGroup: 205,
} as const;
