/**
 * UnityFS asset-bundle container reader (bundle format 6-8). Returns the files ("nodes") inside the bundle:
 * normally one SerializedFile (`CAB-<hash>`) and its resource stream (`CAB-<hash>.resS`).
 * Supports compression 0 (none), 2 (LZ4) and 3 (LZ4HC); LZMA (1) throws.
 */
import { lz4BlockDecompress } from "./lz4";

export interface BundleNode {
  path: string;
  flags: number;
  data: Uint8Array;
}
export interface Bundle {
  formatVersion: number;
  unityVersion: string;
  unityRevision: string;
  /** Compression of the blocks-info header and of each data block (0 none, 1 LZMA, 2 LZ4, 3 LZ4HC). */
  infoCompression: number;
  blockCompressions: number[];
  blockCount: number;
  nodes: BundleNode[];
}

class BE {
  p = 0;
  readonly dv: DataView;
  constructor(readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8(): number {
    return this.b[this.p++]!;
  }
  u16(): number {
    const v = this.dv.getUint16(this.p, false);
    this.p += 2;
    return v;
  }
  u32(): number {
    const v = this.dv.getUint32(this.p, false);
    this.p += 4;
    return v;
  }
  i64(): number {
    const v = this.dv.getBigInt64(this.p, false);
    this.p += 8;
    return Number(v);
  }
  cstr(): string {
    let e = this.p;
    while (this.b[e] !== 0) e++;
    const s = new TextDecoder().decode(this.b.subarray(this.p, e));
    this.p = e + 1;
    return s;
  }
}

function decompress(kind: number, src: Uint8Array, size: number): Uint8Array {
  if (kind === 0) return src;
  if (kind === 2 || kind === 3) return lz4BlockDecompress(src, size);
  throw new Error(`unsupported UnityFS compression ${kind} (1 = LZMA)`);
}

export function readBundle(file: Uint8Array): Bundle {
  const r = new BE(file);
  const sig = r.cstr();
  if (sig !== "UnityFS") throw new Error(`not a UnityFS bundle (signature "${sig}")`);
  const formatVersion = r.u32();
  const unityVersion = r.cstr();
  const unityRevision = r.cstr();
  r.i64(); // total size
  const ciSize = r.u32();
  const uiSize = r.u32();
  const flags = r.u32();
  if (formatVersion >= 7) r.p = (r.p + 15) & ~15;
  let infoAt = r.p;
  if (flags & 0x80) infoAt = file.length - ciSize; // blocks info at the end
  const infoCompression = flags & 0x3f;
  const info = new BE(decompress(infoCompression, file.subarray(infoAt, infoAt + ciSize), uiSize));
  let dataAt = flags & 0x80 ? r.p : infoAt + ciSize;
  if (flags & 0x200) dataAt = (dataAt + 15) & ~15;
  info.p += 16; // uncompressed data hash
  const blockCount = info.u32();
  const blocks: Array<{ u: number; c: number; f: number }> = [];
  for (let i = 0; i < blockCount; i++) blocks.push({ u: info.u32(), c: info.u32(), f: info.u16() });
  const nodeCount = info.u32();
  const rawNodes: Array<{ off: number; size: number; flags: number; path: string }> = [];
  for (let i = 0; i < nodeCount; i++)
    rawNodes.push({ off: info.i64(), size: info.i64(), flags: info.u32(), path: info.cstr() });
  const total = blocks.reduce((n, b) => n + b.u, 0);
  const stream = new Uint8Array(total);
  let s = dataAt;
  let d = 0;
  for (const b of blocks) {
    stream.set(decompress(b.f & 0x3f, file.subarray(s, s + b.c), b.u), d);
    s += b.c;
    d += b.u;
  }
  return {
    formatVersion,
    unityVersion,
    unityRevision,
    infoCompression,
    blockCompressions: [...new Set(blocks.map((b) => b.f & 0x3f))],
    blockCount,
    nodes: rawNodes.map((n) => ({ path: n.path, flags: n.flags, data: stream.subarray(n.off, n.off + n.size) })),
  };
}
