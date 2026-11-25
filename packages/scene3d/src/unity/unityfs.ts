/**
 * UnityFS asset-bundle container reader (bundle formats 6-8). Returns the files ("nodes") inside: normally one
 * serialized file (`CAB-<hash>`) and its resource stream (`CAB-<hash>.resS`). Block compression 0 (none), 1 (LZMA),
 * 2 (LZ4) and 3 (LZ4HC). Anything else throws UnsupportedFormat, which the mesh source turns into boxes.
 */
import { strFromU8 } from "fflate";
import { READ_LIMITS, checkedCount, checkedRange, checkedSize } from "./bounded";
import { DecodeError, UnsupportedFormat } from "./errors";
import { lz4BlockDecompress } from "./lz4";
import { lzmaDecompress } from "./lzma";

/** Container versions read and checked (TaleSpire's bundles are format 8, Unity 2021.3). */
export const UNITYFS_FORMATS: readonly number[] = [6, 7, 8];

export interface BundleNode {
  path: string;
  flags: number;
  data: Uint8Array;
}

export interface Bundle {
  formatVersion: number;
  unityVersion: string;
  nodes: BundleNode[];
}

/** Big-endian cursor over the container header. */
class BigEndian {
  p = 0;
  private readonly dv: DataView;
  constructor(readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  private need(n: number): void {
    if (n < 0 || this.p < 0 || this.p + n > this.b.length)
      throw new DecodeError("UnityFS: header runs past the end");
  }
  /** Bytes left after the cursor. */
  get left(): number {
    return this.b.length - this.p;
  }
  skip(n: number): void {
    this.need(n);
    this.p += n;
  }
  u16(): number {
    this.need(2);
    const v = this.dv.getUint16(this.p, false);
    this.p += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.dv.getUint32(this.p, false);
    this.p += 4;
    return v;
  }
  i64(): number {
    this.need(8);
    const v = this.dv.getBigInt64(this.p, false);
    this.p += 8;
    return Number(v);
  }
  cstr(): string {
    let e = this.p;
    while (e < this.b.length && this.b[e] !== 0) e++;
    if (e >= this.b.length) throw new DecodeError("UnityFS: unterminated string");
    const s = strFromU8(this.b.subarray(this.p, e));
    this.p = e + 1;
    return s;
  }
}

function decompress(kind: number, src: Uint8Array, size: number): Uint8Array {
  switch (kind) {
    case 0:
      if (src.length !== size) throw new DecodeError("UnityFS: stored block size mismatch");
      return src;
    case 1:
      return lzmaDecompress(src, size);
    case 2:
    case 3:
      return lz4BlockDecompress(src, size);
    default:
      throw new UnsupportedFormat(`UnityFS compression ${kind}`);
  }
}

export function readBundle(file: Uint8Array): Bundle {
  const r = new BigEndian(file);
  const sig = r.cstr();
  if (sig !== "UnityFS")
    throw new UnsupportedFormat(`not a UnityFS bundle (signature "${sig.slice(0, 16)}")`);
  const formatVersion = r.u32();
  if (!UNITYFS_FORMATS.includes(formatVersion))
    throw new UnsupportedFormat(`UnityFS format ${formatVersion} (known: ${UNITYFS_FORMATS.join(", ")})`);
  const unityVersion = r.cstr();
  r.cstr(); // revision
  r.i64(); // total size
  const ciSize = r.u32();
  const uiSize = r.u32();
  const flags = r.u32();
  if (formatVersion >= 7) r.p = (r.p + 15) & ~15;
  const infoAtEnd = (flags & 0x80) !== 0;
  const infoAt = infoAtEnd ? file.length - ciSize : r.p;
  checkedRange("UnityFS blocks info", infoAt, ciSize, file.length);
  checkedSize("UnityFS blocks info", uiSize, READ_LIMITS.unpackedBytes);
  const info = new BigEndian(decompress(flags & 0x3f, file.subarray(infoAt, infoAt + ciSize), uiSize));
  let dataAt = infoAtEnd ? r.p : infoAt + ciSize;
  if (flags & 0x200) dataAt = (dataAt + 15) & ~15;
  info.skip(16); // hash of the uncompressed data
  const blockCount = checkedCount("UnityFS blocks", info.u32(), BLOCK_BYTES, info.left);
  const blocks: Array<{ u: number; c: number; f: number }> = [];
  for (let i = 0; i < blockCount; i++) blocks.push({ u: info.u32(), c: info.u32(), f: info.u16() });
  const nodeCount = checkedCount("UnityFS nodes", info.u32(), NODE_MIN_BYTES, info.left);
  const raw: Array<{ off: number; size: number; flags: number; path: string }> = [];
  for (let i = 0; i < nodeCount; i++)
    raw.push({ off: info.i64(), size: info.i64(), flags: info.u32(), path: info.cstr() });
  // the whole stream is allocated once: its size is checked before, and every block against the file after it
  const total = checkedSize(
    "UnityFS data",
    blocks.reduce((n, b) => n + b.u, 0),
    READ_LIMITS.unpackedBytes,
  );
  let s = dataAt;
  for (const b of blocks) {
    checkedRange("UnityFS block", s, b.c, file.length);
    s += b.c;
  }
  for (const n of raw) checkedRange(`UnityFS node ${n.path}`, n.off, n.size, total);
  const stream = new Uint8Array(total);
  s = dataAt;
  let d = 0;
  for (const b of blocks) {
    stream.set(decompress(b.f & 0x3f, file.subarray(s, s + b.c), b.u), d);
    s += b.c;
    d += b.u;
  }
  return {
    formatVersion,
    unityVersion,
    nodes: raw.map((n) => ({ path: n.path, flags: n.flags, data: stream.subarray(n.off, n.off + n.size) })),
  };
}

/** Bytes of one block record in the blocks info (unpacked size, packed size, flags). */
const BLOCK_BYTES = 4 + 4 + 2;
/** The fewest bytes of one node record (offset, size, flags, an empty name's terminator). */
const NODE_MIN_BYTES = 8 + 8 + 4 + 1;
