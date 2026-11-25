/**
 * Unity serialized-file reader (format 22, Unity 2021.3) with a generic type-tree deserializer: every object is read
 * through the type tree stored in the file itself, so no class layout is written here and field changes between game
 * builds are absorbed. A file without type trees, or of another format version, throws UnsupportedFormat.
 */
import { strFromU8 } from "fflate";
import { checkedCount, checkedRange } from "./bounded";
import { DecodeError, UnsupportedFormat } from "./errors";

/** Serialized-file versions read and checked. */
export const SERIALIZED_VERSIONS: readonly number[] = [22];

export interface TypeNode {
  type: string;
  name: string;
  level: number;
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
  types: SerializedType[];
  objects: ObjectInfo[];
  data: Uint8Array;
  dataOffset: number;
}

/** A value read through a type tree. */
export type Value =
  number | bigint | boolean | string | Uint8Array | Float32Array | Value[] | { [field: string]: Value };
export type Obj = { [field: string]: Value };

/** Unity's built-in string table (type-tree string offsets with bit 31 set), in its fixed order. */
const COMMON =
  "AABB\0AnimationClip\0AnimationCurve\0AnimationState\0Array\0Base\0BitField\0bitset\0bool\0char\0ColorRGBA\0Component\0data\0deque\0double\0dynamic_array\0FastPropertyName\0first\0float\0Font\0GameObject\0Generic Mono\0GradientNEW\0GUID\0GUIStyle\0int\0list\0long long\0map\0Matrix4x4f\0MdFour\0MonoBehaviour\0MonoScript\0m_ByteSize\0m_Curve\0m_EditorClassIdentifier\0m_EditorHideFlags\0m_Enabled\0m_ExtensionPtr\0m_GameObject\0m_Index\0m_IsArray\0m_IsStatic\0m_MetaFlag\0m_Name\0m_ObjectHideFlags\0m_PrefabInternal\0m_PrefabParentObject\0m_Script\0m_StaticEditorFlags\0m_Type\0m_Version\0Object\0pair\0PPtr<Component>\0PPtr<GameObject>\0PPtr<Material>\0PPtr<MonoBehaviour>\0PPtr<MonoScript>\0PPtr<Object>\0PPtr<Prefab>\0PPtr<Sprite>\0PPtr<TextAsset>\0PPtr<Texture>\0PPtr<Texture2D>\0PPtr<Transform>\0Prefab\0Quaternionf\0Rectf\0RectInt\0RectOffset\0second\0set\0short\0size\0SInt16\0SInt32\0SInt64\0SInt8\0staticvector\0string\0TextAsset\0TextMesh\0Texture\0Texture2D\0Transform\0TypelessData\0UInt16\0UInt32\0UInt64\0UInt8\0unsigned int\0unsigned long long\0unsigned short\0vector\0Vector2f\0Vector3f\0Vector4f\0m_ScriptingClassIdentifier\0Gradient\0Type*\0int2_storage\0int3_storage\0BoundsInt\0m_CorrespondingSourceObject\0m_PrefabInstance\0m_PrefabAsset\0FileSize\0Hash128\0";
const COMMON_STRINGS = (() => {
  const m = new Map<number, string>();
  let off = 0;
  for (const s of COMMON.split("\0")) {
    m.set(off, s);
    off += s.length + 1;
  }
  return m;
})();

/** Offsets in a type node's meta flag: align the stream to 4 bytes after the value. */
const ALIGN = 0x4000;
const utf8 = { decode: (b: Uint8Array): string => strFromU8(b) };

/**
 * A reading position over `b` that never leaves [start, end): every read, skip and seek is checked first (unity/bounded.ts:
 * a size or offset from the file is a claim), so a negative or oversized field is a DecodeError, never a rewind or a
 * read of the wrong bytes. Alignment stays on the file's own positions, as Unity writes it.
 */
class Cursor {
  private pos: number;
  private readonly dv: DataView;
  readonly end: number;
  constructor(
    readonly b: Uint8Array,
    public little: boolean,
    start = 0,
    end = b.length,
  ) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    checkedRange("serialized file", start, end - start, b.length);
    this.pos = start;
    this.end = end;
  }
  get p(): number {
    return this.pos;
  }
  /** Moves to `to`, which must be inside the cursor's range. */
  seek(to: number): void {
    if (!Number.isSafeInteger(to) || to < 0 || to > this.end)
      throw new DecodeError(`serialized file: position ${String(to)} is outside the data`);
    this.pos = to;
  }
  /** Bytes left before the end. */
  get left(): number {
    return this.end - this.pos;
  }
  need(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.end)
      throw new DecodeError("serialized file: read past the end");
  }
  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
  align4(): void {
    this.seek(Math.min(this.end, (this.pos + 3) & ~3));
  }
  u8(): number {
    this.need(1);
    return this.b[this.pos++] ?? 0;
  }
  i8(): number {
    this.need(1);
    return this.dv.getInt8(this.pos++);
  }
  u16(): number {
    this.need(2);
    const v = this.dv.getUint16(this.pos, this.little);
    this.pos += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.dv.getInt16(this.pos, this.little);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.dv.getUint32(this.pos, this.little);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.dv.getInt32(this.pos, this.little);
    this.pos += 4;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.dv.getBigInt64(this.pos, this.little);
    this.pos += 8;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.dv.getBigUint64(this.pos, this.little);
    this.pos += 8;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.dv.getFloat32(this.pos, this.little);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.dv.getFloat64(this.pos, this.little);
    this.pos += 8;
    return v;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const v = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  cstr(): string {
    let e = this.pos;
    while (e < this.end && this.b[e] !== 0) e++;
    if (e >= this.end) throw new DecodeError("serialized file: unterminated string");
    const s = utf8.decode(this.b.subarray(this.pos, e));
    this.pos = e + 1;
    return s;
  }
}

/** Bytes of one type-tree node record (format ≥ 19). */
const NODE_BYTES = 32;
/** The fewest bytes a type record can take (class id, stripped, script index, hash, two empty counts, no deps). */
const TYPE_MIN_BYTES = 4 + 1 + 2 + 16 + 4 + 4 + 4;
/** Bytes of one object-table record (path id, start, size, type index; before its alignment). */
const OBJECT_BYTES = 8 + 8 + 4 + 4;

function readTypeTree(c: Cursor): TypeNode[] {
  const nodeCount = checkedCount("type tree nodes", c.i32(), NODE_BYTES, c.left);
  const strSize = c.i32();
  const strAt = c.p + nodeCount * NODE_BYTES;
  c.need(nodeCount * NODE_BYTES + strSize);
  const strBuf = c.b.subarray(strAt, strAt + strSize);
  const str = (off: number): string => {
    if (off & 0x80000000) return COMMON_STRINGS.get(off & 0x7fffffff) ?? `common@${off & 0x7fffffff}`;
    let e = off;
    while (e < strBuf.length && strBuf[e] !== 0) e++;
    return utf8.decode(strBuf.subarray(off, e));
  };
  const nodes: TypeNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    c.u16(); // version
    const level = c.u8();
    c.u8(); // type flags
    const typeOff = c.u32();
    const nameOff = c.u32();
    c.i32(); // byte size
    c.i32(); // index
    const metaFlag = c.i32();
    c.u64(); // ref type hash
    nodes.push({ type: str(typeOff), name: str(nameOff), level, metaFlag });
  }
  c.seek(strAt + strSize);
  return nodes;
}

export function readSerializedFile(b: Uint8Array): SerializedFile {
  const h = new Cursor(b, false);
  h.u32(); // metadata size (old header)
  h.u32(); // file size (old header)
  const version = h.u32();
  h.u32(); // data offset (old header)
  if (!SERIALIZED_VERSIONS.includes(version))
    throw new UnsupportedFormat(
      `serialized file version ${version} (known: ${SERIALIZED_VERSIONS.join(", ")})`,
    );
  const bigEndian = h.u8() !== 0;
  h.skip(3);
  h.u32(); // metadata size
  h.i64(); // file size
  const dataOffset = checkedRange("serialized file data", Number(h.i64()), 0, b.length);
  h.i64();
  const c = new Cursor(b, !bigEndian, h.p);
  const unityVersion = c.cstr();
  c.i32(); // target platform
  const typeTreeEnabled = c.u8() !== 0;
  if (!typeTreeEnabled) throw new UnsupportedFormat("serialized file without type trees");
  const typeCount = checkedCount("serialized file types", c.i32(), TYPE_MIN_BYTES, c.left);
  const types: SerializedType[] = [];
  for (let i = 0; i < typeCount; i++) {
    const classId = c.i32();
    c.u8(); // stripped
    c.i16(); // script type index
    if (classId === 114) c.skip(16); // script id
    c.skip(16); // old type hash
    const nodes = readTypeTree(c);
    c.skip(4 * checkedCount("type dependencies", c.i32(), 4, c.left));
    types.push({ classId, nodes });
  }
  const objCount = checkedCount("serialized file objects", c.i32(), OBJECT_BYTES, c.left);
  const objects: ObjectInfo[] = [];
  for (let i = 0; i < objCount; i++) {
    c.align4();
    const pathId = c.i64();
    const byteStart = Number(c.i64());
    const byteSize = c.u32();
    const typeIndex = c.i32();
    checkedRange("serialized object", dataOffset + byteStart, byteSize, b.length);
    objects.push({ pathId, byteStart, byteSize, typeIndex, classId: types[typeIndex]?.classId ?? -1 });
  }
  return { version, unityVersion, bigEndian, types, objects, data: b, dataOffset };
}

/**
 * The fewest bytes a value of type node `i` takes in the stream (0 for a node of no fixed part), memoised in `memo`:
 * an array's count is checked against it, so a count claiming more items than the bytes left could hold is refused.
 */
function minBytes(
  nodes: readonly TypeNode[],
  kids: (i: number) => number[],
  i: number,
  memo: Map<number, number>,
): number {
  const known = memo.get(i);
  if (known !== undefined) return known;
  const n = nodes[i];
  let v = 0;
  if (n && (n.type === "string" || n.type === "TypelessData" || n.type === "Array")) v = 4;
  else if (n) {
    const ks = kids(i);
    v =
      ks.length === 0
        ? (PRIM_BYTES[n.type] ?? 0)
        : ks.reduce((s, k) => s + minBytes(nodes, kids, k, memo), 0);
  }
  memo.set(i, v);
  return v;
}

const PRIM_BYTES: Readonly<Record<string, number>> = {
  SInt8: 1,
  UInt8: 1,
  char: 1,
  bool: 1,
  SInt16: 2,
  short: 2,
  UInt16: 2,
  "unsigned short": 2,
  SInt32: 4,
  int: 4,
  UInt32: 4,
  "unsigned int": 4,
  "Type*": 4,
  float: 4,
  SInt64: 8,
  "long long": 8,
  UInt64: 8,
  "unsigned long long": 8,
  FileSize: 8,
  double: 8,
};

/** Reads one object through its type tree into plain values (never past the object's own bytes). */
export function readObject(sf: SerializedFile, o: ObjectInfo): Obj {
  const t = sf.types[o.typeIndex];
  if (!t || t.nodes.length === 0) throw new UnsupportedFormat("object without a type tree");
  const nodes = t.nodes;
  const start = checkedRange("serialized object", sf.dataOffset + o.byteStart, o.byteSize, sf.data.length);
  const c = new Cursor(sf.data, !sf.bigEndian, start, start + o.byteSize);
  const kidsCache = new Map<number, number[]>();
  const sizes = new Map<number, number>();
  const kids = (i: number): number[] => {
    let v = kidsCache.get(i);
    if (v) return v;
    v = [];
    const lvl = nodes[i]?.level ?? 0;
    for (let k = i + 1; k < nodes.length && (nodes[k]?.level ?? 0) > lvl; k++)
      if (nodes[k]?.level === lvl + 1) v.push(k);
    kidsCache.set(i, v);
    return v;
  };
  const node = (i: number): TypeNode => {
    const n = nodes[i];
    if (!n) throw new DecodeError("type tree index out of range");
    return n;
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
  const readArray = (ai: number): Value => {
    const dataIdx = kids(ai)[1];
    if (dataIdx === undefined) throw new DecodeError("array without a data node");
    const size = checkedCount("array", c.i32(), minBytes(nodes, kids, dataIdx, sizes), c.left);
    const dn = node(dataIdx);
    const leaf = kids(dataIdx).length === 0;
    let v: Value;
    if (leaf && (dn.type === "UInt8" || dn.type === "char")) v = c.bytes(size);
    else if (leaf && dn.type === "float") {
      c.need(4 * size);
      const f = new Float32Array(size);
      for (let k = 0; k < size; k++) f[k] = c.f32();
      v = f;
    } else {
      const arr: Value[] = [];
      for (let k = 0; k < size; k++) arr.push(read(dataIdx));
      v = arr;
    }
    if (node(ai).metaFlag & ALIGN) c.align4();
    return v;
  };
  const read = (i: number): Value => {
    const n = node(i);
    const ks = kids(i);
    let v: Value;
    if (n.type === "string") {
      v = utf8.decode(c.bytes(c.i32()));
      const arr = ks[0] !== undefined ? node(ks[0]) : undefined;
      if (arr && arr.metaFlag & ALIGN) c.align4();
    } else if (n.type === "TypelessData") v = c.bytes(c.i32());
    else if (ks.length === 0) {
      const p = prim(n.type);
      if (p === undefined) throw new UnsupportedFormat(`unknown primitive ${n.type} (${n.name})`);
      v = p;
    } else if (n.type === "Array") return readArray(i);
    else if (ks.length === 1 && ks[0] !== undefined && node(ks[0]).type === "Array") v = readArray(ks[0]);
    else {
      const obj: Obj = {};
      for (const k of ks) obj[node(k).name] = read(k);
      v = obj;
    }
    if (n.metaFlag & ALIGN) c.align4();
    return v;
  };
  const root: Obj = {};
  for (const k of kids(0)) root[node(k).name] = read(k);
  return root;
}

/** Unity class ids the mesh reader asks for. */
export const CLASS = {
  GameObject: 1,
  Transform: 4,
  MeshRenderer: 23,
  MeshFilter: 33,
  Mesh: 43,
  AssetBundle: 142,
  LODGroup: 205,
} as const;

// typed field access: a missing or mistyped field is a DecodeError, never a silent undefined

export function field(o: Obj, name: string): Value {
  const v = o[name];
  if (v === undefined) throw new DecodeError(`missing field ${name}`);
  return v;
}
export function num(o: Obj, name: string): number {
  const v = field(o, name);
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new DecodeError(`field ${name} is not a number`);
}
export function big(o: Obj, name: string): bigint {
  const v = field(o, name);
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  throw new DecodeError(`field ${name} is not an integer`);
}
export function str(o: Obj, name: string): string {
  const v = field(o, name);
  if (typeof v !== "string") throw new DecodeError(`field ${name} is not a string`);
  return v;
}
export function isObj(v: Value | undefined): v is Obj {
  return (
    typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof Float32Array)
  );
}
export function obj(o: Obj, name: string): Obj {
  const v = field(o, name);
  if (!isObj(v)) throw new DecodeError(`field ${name} is not an object`);
  return v;
}
export function list(o: Obj, name: string): Value[] {
  const v = field(o, name);
  if (!Array.isArray(v)) throw new DecodeError(`field ${name} is not a list`);
  return v;
}
export function objList(o: Obj, name: string): Obj[] {
  return list(o, name).map((v) => {
    if (!isObj(v)) throw new DecodeError(`field ${name} holds a non-object`);
    return v;
  });
}
export function bytes(o: Obj, name: string): Uint8Array {
  const v = field(o, name);
  if (!(v instanceof Uint8Array)) throw new DecodeError(`field ${name} is not bytes`);
  return v;
}
