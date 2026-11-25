/**
 * Synthetic game files built in test code (no game bytes are ever committed): a literal-only LZMA encoder, an LZ4
 * literal block, a Unity serialized file (format 22, with type trees) holding a prefab of GameObjects, Transforms,
 * MeshFilters, MeshRenderers and Meshes, and the UnityFS container round it.
 */

// ───────────── LZMA (literals only: every symbol a literal; enough to drive the decoder's range coder) ─────────────

const TOP = 2 ** 24;

export function lzmaEncodeLiterals(data: Uint8Array): Uint8Array {
  const lc = 3;
  const lp = 0;
  const pb = 2;
  const out: number[] = [lc + lp * 9 + pb * 45, 0, 0, 0x10, 0]; // props, dictionary 1 MB
  let low = 0;
  let range = 0xffffffff;
  let cache = 0;
  let cacheSize = 1;
  const shiftLow = (): void => {
    if (low < 0xff000000 || low >= 2 ** 32) {
      const carry = low >= 2 ** 32 ? 1 : 0;
      let temp = cache;
      do {
        out.push((temp + carry) & 0xff);
        temp = 0xff;
      } while (--cacheSize !== 0);
      cache = Math.floor(low / 2 ** 24) & 0xff;
    }
    cacheSize++;
    low = (low % 2 ** 24) * 256;
  };
  const bit = (probs: Uint16Array, i: number, b: number): void => {
    const p = probs[i] ?? 1024;
    const bound = (range >>> 11) * p;
    if (b === 0) {
      range = bound;
      probs[i] = p + ((2048 - p) >>> 5);
    } else {
      low += bound;
      range = (range - bound) >>> 0;
      probs[i] = p - (p >>> 5);
    }
    while (range < TOP) {
      range = (range * 256) >>> 0;
      shiftLow();
    }
  };
  const isMatch = new Uint16Array(12 << 4).fill(1024);
  const literal = new Uint16Array(0x300 << (lc + lp)).fill(1024);
  let prev = 0;
  for (let pos = 0; pos < data.length; pos++) {
    const byte = data[pos] ?? 0;
    bit(isMatch, pos & ((1 << pb) - 1), 0); // state stays 0 after literals
    const base = 0x300 * (prev >>> (8 - lc));
    let sym = 1;
    for (let k = 7; k >= 0; k--) {
      const b = (byte >>> k) & 1;
      bit(literal, base + sym, b);
      sym = (sym << 1) | b;
    }
    prev = byte;
  }
  for (let i = 0; i < 5; i++) shiftLow();
  return Uint8Array.from(out);
}

/** An LZ4 block of one literal run (valid LZ4: the last sequence has literals only). */
export function lz4Literals(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let len = data.length;
  out.push(Math.min(15, len) << 4);
  if (len >= 15) {
    len -= 15;
    while (len >= 255) {
      out.push(255);
      len -= 255;
    }
    out.push(len);
  }
  return Uint8Array.from([...out, ...data]);
}

// ───────────── serialized file ─────────────

/** A type-tree node spec. */
export interface T {
  t: string;
  n: string;
  kids?: T[];
  align?: boolean;
}
export type V = number | bigint | boolean | string | Uint8Array | V[] | { [k: string]: V };

const prim = (t: string, n: string): T => ({ t, n });
const array = (elem: T): T => ({
  t: "Array",
  n: "Array",
  align: true,
  kids: [prim("int", "size"), { ...elem, n: "data" }],
});
const vector = (n: string, elem: T): T => ({ t: "vector", n, kids: [array(elem)] });
const string = (n: string): T => ({ t: "string", n, kids: [array(prim("char", "data"))] });
const pptr = (n: string): T => ({
  t: "PPtr<Object>",
  n,
  kids: [prim("int", "m_FileID"), prim("SInt64", "m_PathID")],
});
const v3 = (n: string): T => ({ t: "Vector3f", n, kids: ["x", "y", "z"].map((k) => prim("float", k)) });
const quat = (n: string): T => ({
  t: "Quaternionf",
  n,
  kids: ["x", "y", "z", "w"].map((k) => prim("float", k)),
});

export const TYPES: Record<string, { classId: number; root: T }> = {
  GameObject: {
    classId: 1,
    root: {
      t: "GameObject",
      n: "Base",
      kids: [
        vector("m_Component", { t: "ComponentPair", n: "data", kids: [pptr("component")] }),
        string("m_Name"),
        { ...prim("bool", "m_IsActive"), align: true },
      ],
    },
  },
  Transform: {
    classId: 4,
    root: {
      t: "Transform",
      n: "Base",
      kids: [
        pptr("m_GameObject"),
        quat("m_LocalRotation"),
        v3("m_LocalPosition"),
        v3("m_LocalScale"),
        vector("m_Children", pptr("data")),
        pptr("m_Father"),
      ],
    },
  },
  MeshFilter: {
    classId: 33,
    root: { t: "MeshFilter", n: "Base", kids: [pptr("m_GameObject"), pptr("m_Mesh")] },
  },
  MeshRenderer: {
    classId: 23,
    root: {
      t: "MeshRenderer",
      n: "Base",
      kids: [pptr("m_GameObject"), { ...prim("bool", "m_Enabled"), align: true }],
    },
  },
  Mesh: {
    classId: 43,
    root: {
      t: "Mesh",
      n: "Base",
      kids: [
        string("m_Name"),
        vector("m_SubMeshes", {
          t: "SubMesh",
          n: "data",
          kids: [
            prim("unsigned int", "firstByte"),
            prim("unsigned int", "indexCount"),
            prim("int", "topology"),
            prim("unsigned int", "baseVertex"),
          ],
        }),
        { ...prim("UInt8", "m_MeshCompression"), align: true },
        prim("int", "m_IndexFormat"),
        { t: "vector", n: "m_IndexBuffer", kids: [array(prim("UInt8", "data"))] },
        {
          t: "VertexData",
          n: "m_VertexData",
          kids: [
            prim("unsigned int", "m_VertexCount"),
            vector("m_Channels", {
              t: "ChannelInfo",
              n: "data",
              kids: ["stream", "offset", "format", "dimension"].map((k) => prim("UInt8", k)),
            }),
            { t: "TypelessData", n: "m_DataSize", align: true },
          ],
        },
        {
          t: "StreamingInfo",
          n: "m_StreamData",
          kids: [prim("UInt64", "offset"), prim("unsigned int", "size"), string("path")],
        },
      ],
    },
  },
};

class Writer {
  bytes: number[] = [];
  le = true;
  get p(): number {
    return this.bytes.length;
  }
  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }
  num(v: number, size: number, kind: "u" | "i" | "f"): void {
    const b = new DataView(new ArrayBuffer(size));
    if (kind === "f") {
      if (size === 4) b.setFloat32(0, v, this.le);
      else b.setFloat64(0, v, this.le);
    } else if (size === 1) b.setUint8(0, v & 0xff);
    else if (size === 2) b.setUint16(0, v & 0xffff, this.le);
    else if (kind === "u") b.setUint32(0, v >>> 0, this.le);
    else b.setInt32(0, v, this.le);
    for (let i = 0; i < size; i++) this.bytes.push(b.getUint8(i));
  }
  i64(v: bigint): void {
    const b = new DataView(new ArrayBuffer(8));
    b.setBigInt64(0, v, this.le);
    for (let i = 0; i < 8; i++) this.bytes.push(b.getUint8(i));
  }
  raw(b: ArrayLike<number>): void {
    for (let i = 0; i < b.length; i++) this.bytes.push(b[i] ?? 0);
  }
  cstr(s: string): void {
    for (const ch of s) this.bytes.push(ch.charCodeAt(0));
    this.bytes.push(0);
  }
  align(n: number): void {
    while (this.bytes.length % n !== 0) this.bytes.push(0);
  }
}

const PRIM: Record<string, [number, "u" | "i" | "f"]> = {
  bool: [1, "u"],
  UInt8: [1, "u"],
  char: [1, "u"],
  int: [4, "i"],
  "unsigned int": [4, "u"],
  float: [4, "f"],
};

function writeValue(w: Writer, t: T, v: V | undefined): void {
  const kids = t.kids ?? [];
  if (t.t === "string") {
    const s = typeof v === "string" ? v : "";
    w.num(s.length, 4, "i");
    w.cstr(s);
    w.bytes.pop();
    w.align(4);
  } else if (t.t === "TypelessData") {
    const b = v instanceof Uint8Array ? v : new Uint8Array(0);
    w.num(b.length, 4, "i");
    w.raw(b);
  } else if (t.t === "SInt64" || t.t === "UInt64") w.i64(typeof v === "bigint" ? v : BigInt(Number(v ?? 0)));
  else if (kids.length === 0) {
    const p = PRIM[t.t];
    if (!p) throw new Error(`no writer for ${t.t}`);
    w.num(typeof v === "boolean" ? (v ? 1 : 0) : Number(v ?? 0), p[0], p[1]);
  } else if (kids.length === 1 && kids[0]?.t === "Array") {
    const arr = kids[0];
    const elem = arr.kids?.[1];
    if (!elem) throw new Error("array without data");
    const items: V[] = v instanceof Uint8Array ? [...v] : Array.isArray(v) ? v : [];
    w.num(items.length, 4, "i");
    for (const item of items) writeValue(w, elem, item);
    if (arr.align) w.align(4);
  } else {
    const o = typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array) ? v : {};
    for (const k of kids) writeValue(w, k, o[k.n]);
  }
  if (t.align) w.align(4);
}

function flatten(root: T): Array<{ t: T; level: number }> {
  const out: Array<{ t: T; level: number }> = [];
  const walk = (t: T, level: number): void => {
    out.push({ t, level });
    for (const k of t.kids ?? []) walk(k, level + 1);
  };
  walk(root, 0);
  return out;
}

export interface SynthObject {
  pathId: bigint;
  type: keyof typeof TYPES;
  value: { [k: string]: V };
}

/** A serialized file of the objects (format `version`, little-endian, type trees on). */
export function serializedFile(objects: SynthObject[], version = 22): Uint8Array {
  const typeNames = [...new Set(objects.map((o) => o.type))];
  const meta = new Writer();
  meta.bytes = new Array<number>(48).fill(0);
  meta.cstr("2021.3.45f2");
  meta.num(19, 4, "i"); // platform
  meta.u8(1); // type trees
  meta.num(typeNames.length, 4, "i");
  for (const name of typeNames) {
    const ty = TYPES[name];
    if (!ty) throw new Error(name);
    meta.num(ty.classId, 4, "i");
    meta.u8(0);
    meta.num(-1, 2, "i");
    meta.raw(new Uint8Array(16));
    const nodes = flatten(ty.root);
    const strs: number[] = [];
    const strOff = new Map<string, number>();
    const off = (s: string): number => {
      let o = strOff.get(s);
      if (o === undefined) {
        o = strs.length;
        strOff.set(s, o);
        for (const ch of s) strs.push(ch.charCodeAt(0));
        strs.push(0);
      }
      return o;
    };
    const offs = nodes.map((n) => [off(n.t.t), off(n.t.n)] as const);
    meta.num(nodes.length, 4, "i");
    meta.num(strs.length, 4, "i");
    nodes.forEach((n, i) => {
      meta.num(1, 2, "u");
      meta.u8(n.level);
      meta.u8(0);
      meta.num(offs[i]?.[0] ?? 0, 4, "u");
      meta.num(offs[i]?.[1] ?? 0, 4, "u");
      meta.num(-1, 4, "i");
      meta.num(i, 4, "i");
      meta.num(n.t.align ? 0x4000 : 0, 4, "i");
      meta.i64(0n);
    });
    meta.raw(strs);
    meta.num(0, 4, "i"); // dependencies
  }
  // object data first, to know offsets
  const data = new Writer();
  const infos = objects.map((o) => {
    data.align(8);
    const start = data.p;
    const ty = TYPES[o.type];
    if (!ty) throw new Error(o.type);
    writeValue(data, ty.root, o.value);
    return { pathId: o.pathId, start, size: data.p - start, typeIndex: typeNames.indexOf(o.type) };
  });
  meta.num(infos.length, 4, "i");
  for (const i of infos) {
    meta.align(4);
    meta.i64(i.pathId);
    meta.i64(BigInt(i.start));
    meta.num(i.size, 4, "u");
    meta.num(i.typeIndex, 4, "i");
  }
  meta.num(0, 4, "i"); // scripts
  meta.num(0, 4, "i"); // externals
  meta.align(16);
  const dataOffset = meta.p;
  const out = Uint8Array.from([...meta.bytes, ...data.bytes]);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, version, false);
  dv.setUint8(16, 0); // little-endian
  dv.setUint32(20, dataOffset, false);
  dv.setBigInt64(24, BigInt(out.length), false);
  dv.setBigInt64(32, BigInt(dataOffset), false);
  return out;
}

/** A UnityFS container (format `format`) of the files, its data in one block of `compression` (0, 1 LZMA, 2 LZ4). */
export function unityFsBundle(
  files: Array<{ path: string; data: Uint8Array }>,
  compression: 0 | 1 | 2 = 1,
  format = 8,
): Uint8Array {
  const stream = Uint8Array.from(files.flatMap((f) => [...f.data]));
  const block =
    compression === 1 ? lzmaEncodeLiterals(stream) : compression === 2 ? lz4Literals(stream) : stream;
  const info = new Writer();
  info.le = false;
  info.raw(new Uint8Array(16));
  info.num(1, 4, "u");
  info.num(stream.length, 4, "u");
  info.num(block.length, 4, "u");
  info.num(compression, 2, "u");
  info.num(files.length, 4, "u");
  let off = 0;
  for (const f of files) {
    info.i64(BigInt(off));
    info.i64(BigInt(f.data.length));
    info.num(4, 4, "u");
    info.cstr(f.path);
    off += f.data.length;
  }
  const h = new Writer();
  h.le = false;
  h.cstr("UnityFS");
  h.num(format, 4, "u");
  h.cstr("5.x.x");
  h.cstr("2021.3.45f2");
  const sizeAt = h.p;
  h.i64(0n);
  h.num(info.p, 4, "u");
  h.num(info.p, 4, "u");
  h.num(0, 4, "u"); // flags: info uncompressed, right after the header
  if (format >= 7) h.align(16);
  const out = Uint8Array.from([...h.bytes, ...info.bytes, ...block]);
  new DataView(out.buffer).setBigInt64(sizeAt, BigInt(out.length), false);
  return out;
}

/** The objects of one prefab: a root GameObject `name` at `position` with a unit cube mesh, and a child scaled 2×. */
export function cratePrefab(name: string, position: [number, number, number], idBase = 1n): SynthObject[] {
  const id = (k: bigint): bigint => idBase * 100n + k;
  const ref = (k: bigint): V => ({ m_FileID: 0, m_PathID: id(k) });
  const none: V = { m_FileID: 0, m_PathID: 0n };
  // unit cube 0..1: 8 corners, 12 triangles, float32 positions in stream 0 (stride 12)
  const corners: number[] = [];
  for (let i = 0; i < 8; i++) corners.push(i & 1 ? 1 : 0, i & 2 ? 1 : 0, i & 4 ? 1 : 0);
  const vertexBytes = new Uint8Array(new Float32Array(corners).buffer);
  const tri = [
    0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7,
    6,
  ];
  const indexBytes = new Uint8Array(new Uint16Array(tri).buffer);
  const go = (k: bigint, n: string, comps: bigint[]): SynthObject => ({
    pathId: id(k),
    type: "GameObject",
    value: { m_Component: comps.map((c) => ({ component: ref(c) })), m_Name: n, m_IsActive: true },
  });
  const tr = (
    k: bigint,
    goK: bigint,
    pos: number[],
    scale: number,
    children: bigint[],
    father: V,
  ): SynthObject => ({
    pathId: id(k),
    type: "Transform",
    value: {
      m_GameObject: ref(goK),
      m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 },
      m_LocalPosition: { x: pos[0] ?? 0, y: pos[1] ?? 0, z: pos[2] ?? 0 },
      m_LocalScale: { x: scale, y: scale, z: scale },
      m_Children: children.map(ref),
      m_Father: father,
    },
  });
  return [
    go(1n, name, [2n, 3n, 4n]),
    tr(2n, 1n, position, 1, [12n], none),
    { pathId: id(3n), type: "MeshFilter", value: { m_GameObject: ref(1n), m_Mesh: ref(5n) } },
    { pathId: id(4n), type: "MeshRenderer", value: { m_GameObject: ref(1n), m_Enabled: true } },
    {
      pathId: id(5n),
      type: "Mesh",
      value: {
        m_Name: `${name}_mesh`,
        m_SubMeshes: [{ firstByte: 0, indexCount: tri.length, topology: 0, baseVertex: 0 }],
        m_MeshCompression: 0,
        m_IndexFormat: 0,
        m_IndexBuffer: indexBytes,
        m_VertexData: {
          m_VertexCount: 8,
          m_Channels: [{ stream: 0, offset: 0, format: 0, dimension: 3 }],
          m_DataSize: vertexBytes,
        },
        m_StreamData: { offset: 0n, size: 0, path: "" },
      },
    },
    go(11n, `${name}_child`, [12n, 13n, 14n]),
    tr(12n, 11n, [0, 1, 0], 2, [], ref(2n)),
    { pathId: id(13n), type: "MeshFilter", value: { m_GameObject: ref(11n), m_Mesh: ref(5n) } },
    { pathId: id(14n), type: "MeshRenderer", value: { m_GameObject: ref(11n), m_Enabled: true } },
  ];
}
