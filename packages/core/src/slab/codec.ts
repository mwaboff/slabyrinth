/**
 * TaleSpire slab codec (docs/talespire-slab-format.md §2, architecture §4.5).
 *
 * v2 payload (all little-endian):
 *   u32 0xD1CEFACE · u16 version=2 · u16 layoutCount · u16 creatureCount=0
 *   layoutCount × { 16-byte GUID (.NET order) · u16 assetCount · u16 reserved=0 }
 *   Σ assetCount × u64 { x:18 | y:18 | z:18 | rot:5 | unused:5 }   (bit 0 upward, 100 = 1 tile, y is up)
 *   u16 trailer 0x0000
 * Wrapped as gzip (fflate level 9, mtime 0 → deterministic) then standard base64, no fences.
 *
 * Decoding accepts v2 and legacy v1, surrounding whitespace and optional triple-backtick fences, and keeps
 * unknown UUIDs verbatim.
 */
import { gunzipSync, gzipSync } from "fflate";
import type { DecodedSlab, SlabAsset, SlabCodec } from "../contracts/compiler";
import { base64Decode, base64Encode } from "./base64";
import { bytesToGuid, guidToBytes, normalizeGuid } from "./guid";

export const SLAB_MAGIC = 0xd1ceface;
export const SLAB_LIMITS = {
  /** gzip output (base64-decoded length), VERIFIED. */
  maxCompressedBytes: 30720,
  maxAssetsPerLayout: 0xffff,
  maxLayouts: 0xffff,
  maxCoord: 0x3ffff,
} as const;

const MASK18 = 0x3ffffn;

export class SlabFormatError extends Error {
  override name = "SlabFormatError";
}

/** Scaled int for a coordinate in tiles: round(v·100). The toFixed step removes float noise (0.285·100 = 28.4999…). */
export function toScaled(t: number): number {
  return Math.round(Number((t * 100).toFixed(6)));
}

/** TaleSpire turns an asset in steps of this many degrees ... */
export const ROTATION_STEP = 15;
/** ... so a full turn is this many steps (the slab's rotation index is 0..ROTATION_STEPS - 1). */
export const ROTATION_STEPS = 360 / ROTATION_STEP;

export function degreesToRot(deg: number): number {
  const steps = Math.round(deg / ROTATION_STEP);
  if (Math.abs(steps * ROTATION_STEP - deg) > 1e-6)
    throw new RangeError(`rotation ${deg}° is not a multiple of ${ROTATION_STEP}°`);
  return ((steps % ROTATION_STEPS) + ROTATION_STEPS) % ROTATION_STEPS;
}

export function rotToDegrees(rot: number): number {
  return (((rot % ROTATION_STEPS) + ROTATION_STEPS) % ROTATION_STEPS) * ROTATION_STEP;
}

/** Packs one instance into the u64 (BigInt; the fields straddle bit 32). */
export function packInstance(sx: number, sy: number, sz: number, rot: number): bigint {
  for (const [n, v] of [
    ["x", sx],
    ["y", sy],
    ["z", sz],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v > SLAB_LIMITS.maxCoord) {
      throw new SlabFormatError(`scaled ${n} ${v} out of range 0..${SLAB_LIMITS.maxCoord}`);
    }
  }
  if (!Number.isInteger(rot) || rot < 0 || rot > 23)
    throw new SlabFormatError(`rot ${rot} out of range 0..23`);
  return BigInt(sx) | (BigInt(sy) << 18n) | (BigInt(sz) << 36n) | (BigInt(rot) << 54n);
}

export function unpackInstance(v: bigint): {
  sx: number;
  sy: number;
  sz: number;
  rot: number;
  extra: number;
} {
  return {
    sx: Number(v & MASK18),
    sy: Number((v >> 18n) & MASK18),
    sz: Number((v >> 36n) & MASK18),
    rot: Number((v >> 54n) & 0x1fn),
    extra: Number((v >> 59n) & 0x1fn),
  };
}

/** A layout in payload order: one asset kind and its instances in stored order. */
export interface SlabLayout {
  uuid: string;
  assets: Array<{ sx: number; sy: number; sz: number; rot: number }>;
}

/** Groups assets by uuid (first-seen instance order kept) and sorts the layouts by lower-case uuid, as the game does. */
export function groupLayouts(assets: readonly SlabAsset[]): SlabLayout[] {
  const map = new Map<string, SlabLayout>();
  for (const a of assets) {
    const uuid = normalizeGuid(a.uuid);
    let l = map.get(uuid);
    if (!l) {
      l = { uuid, assets: [] };
      map.set(uuid, l);
    }
    l.assets.push({ sx: a.sx, sy: a.sy, sz: a.sz, rot: a.rot });
  }
  return [...map.values()].sort((a, b) => (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
}

/** Writes layouts in the given order (no re-sorting). Use `encodeRaw` for normal output. */
export function encodeLayoutsRaw(
  layouts: readonly SlabLayout[],
  opts: { trailer?: boolean } = {},
): Uint8Array {
  if (layouts.length > SLAB_LIMITS.maxLayouts)
    throw new SlabFormatError(`too many layouts: ${layouts.length}`);
  const seen = new Set<string>();
  let n = 0;
  for (const l of layouts) {
    const u = normalizeGuid(l.uuid);
    if (seen.has(u)) throw new SlabFormatError(`uuid ${u} appears in two layouts`);
    seen.add(u);
    if (l.assets.length > SLAB_LIMITS.maxAssetsPerLayout) {
      throw new SlabFormatError(
        `layout ${u} has ${l.assets.length} assets (max ${SLAB_LIMITS.maxAssetsPerLayout})`,
      );
    }
    n += l.assets.length;
  }
  const trailer = opts.trailer ?? true;
  const size = 10 + 20 * layouts.length + 8 * n + (trailer ? 2 : 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, SLAB_MAGIC, true);
  dv.setUint16(4, 2, true);
  dv.setUint16(6, layouts.length, true);
  dv.setUint16(8, 0, true);
  let p = 10;
  for (const l of layouts) {
    guidToBytes(l.uuid, out, p);
    dv.setUint16(p + 16, l.assets.length, true);
    dv.setUint16(p + 18, 0, true);
    p += 20;
  }
  for (const l of layouts) {
    for (const a of l.assets) {
      dv.setBigUint64(p, packInstance(a.sx, a.sy, a.sz, a.rot), true);
      p += 8;
    }
  }
  // trailer bytes are already zero
  return out;
}

export function encodeRaw(assets: readonly SlabAsset[]): Uint8Array {
  return encodeLayoutsRaw(groupLayouts(assets));
}

export function gzip(raw: Uint8Array): Uint8Array {
  return gzipSync(raw, { level: 9, mtime: 0 });
}

/** Strips whitespace and optional triple-backtick fences. */
export function unwrapSlabString(slab: string): string {
  let s = slab.trim();
  if (s.startsWith("```")) s = s.slice(3);
  if (s.endsWith("```")) s = s.slice(0, -3);
  return s.trim();
}

export function encode(assets: readonly SlabAsset[]): {
  slab: string;
  rawBytes: number;
  compressedBytes: number;
} {
  const raw = encodeRaw(assets);
  const gz = gzip(raw);
  return { slab: base64Encode(gz), rawBytes: raw.length, compressedBytes: gz.length };
}

/** v1 instance (legacy float format), kept verbatim alongside the converted SlabAsset. */
export interface SlabV1Instance {
  uuid: string;
  center: { x: number; y: number; z: number };
  halfExtents: { x: number; y: number; z: number };
  rot: number;
}

/** Full decode result: the contract's DecodedSlab plus layout structure and v1 detail. */
export interface DecodedSlabDetail extends DecodedSlab {
  layouts: Array<{ uuid: string; count: number }>;
  creatureCount: number;
  /** Raw (uncompressed) payload. */
  raw: Uint8Array;
  /** v1 only: original float records and the slab bounds footer (centre, size). */
  v1?: {
    instances: SlabV1Instance[];
    bounds: { center: { x: number; y: number; z: number }; size: { x: number; y: number; z: number } } | null;
  };
  /** Instances whose 5 unused high bits were not zero (never seen in game output). */
  nonZeroExtraBits: number;
}

export interface DecodeOptions {
  /**
   * v1 → v2 conversion: whether an asset's stored position is its min corner (tiles) or its origin (props).
   * Default: every asset uses the min corner of its v1 bounding box. Supply catalog knowledge when available.
   */
  v1OriginAt?: (uuid: string) => "minCorner" | "center" | null;
}

/**
 * Input bounds for decoding untrusted slab strings (pasted by users, imported as stamps). The game's paste limit is
 * 30,720 gzip bytes ≈ 40,960 base64 characters; 64 Ki characters leaves headroom for fences and line breaks.
 * A valid slab's payload is 8 bytes per instance (v1: 28), so 4 MiB is far above any slab the game accepts.
 */
export const MAX_SLAB_BASE64_CHARS = 64 * 1024;
export const MAX_SLAB_RAW_BYTES = 4 * 1024 * 1024;

export function decompress(slab: string): { raw: Uint8Array; compressedBytes: number } {
  if (slab.length > MAX_SLAB_BASE64_CHARS * 2) {
    throw new SlabFormatError(
      `slab string too long (${slab.length} characters; limit ${MAX_SLAB_BASE64_CHARS})`,
    );
  }
  const b64 = unwrapSlabString(slab);
  if (b64.length === 0) throw new SlabFormatError("empty slab string");
  if (b64.length > MAX_SLAB_BASE64_CHARS) {
    throw new SlabFormatError(
      `slab string too long (${b64.length} characters; limit ${MAX_SLAB_BASE64_CHARS})`,
    );
  }
  let gz: Uint8Array;
  try {
    gz = base64Decode(b64);
  } catch (e) {
    throw new SlabFormatError(`not base64: ${(e as Error).message}`);
  }
  // gzip ends with ISIZE (u32 LE, uncompressed length mod 2^32). Never let it size an allocation unchecked:
  // fflate pre-allocates from it, so a 30-byte string could otherwise request 4 GB.
  if (gz.length < 18 || gz[0] !== 0x1f || gz[1] !== 0x8b) throw new SlabFormatError("not gzip: bad header");
  const declared = new DataView(gz.buffer, gz.byteOffset, gz.byteLength).getUint32(gz.length - 4, true);
  if (declared > MAX_SLAB_RAW_BYTES) {
    throw new SlabFormatError(
      `declared payload size ${declared} bytes exceeds the limit (${MAX_SLAB_RAW_BYTES})`,
    );
  }
  let raw: Uint8Array;
  try {
    // one spare byte: a stream longer than declared fills it and is caught below (fflate truncates to `out`)
    raw = gunzipSync(gz, { out: new Uint8Array(declared + 1) });
  } catch (e) {
    throw new SlabFormatError(`not gzip: ${(e as Error).message}`);
  }
  if (raw.length !== declared) {
    throw new SlabFormatError(`gzip size mismatch: declared ${declared} bytes, inflated ${raw.length}`);
  }
  return { raw, compressedBytes: gz.length };
}

export function decodeRaw(
  raw: Uint8Array,
  opts: DecodeOptions = {},
): Omit<DecodedSlabDetail, "compressedBytes"> {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const need = (off: number, n: number, what: string): void => {
    if (off + n > raw.length) throw new SlabFormatError(`truncated slab: ${what} at byte ${off}`);
  };
  need(0, 8, "header");
  const magic = dv.getUint32(0, true);
  if (magic !== SLAB_MAGIC) throw new SlabFormatError(`bad magic 0x${magic.toString(16).toUpperCase()}`);
  const version = dv.getUint16(4, true);
  const layoutCount = dv.getUint16(6, true);
  let p = 8;
  let creatureCount = 0;
  if (version === 2) {
    need(8, 2, "creature count");
    creatureCount = dv.getUint16(8, true);
    p = 10;
  } else if (version !== 1) {
    throw new SlabFormatError(`unsupported slab version ${version}`);
  }
  const layouts: Array<{ uuid: string; count: number }> = [];
  for (let i = 0; i < layoutCount; i++) {
    need(p, 20, "layout");
    layouts.push({ uuid: bytesToGuid(raw, p), count: dv.getUint16(p + 16, true) });
    p += 20;
  }
  const assets: SlabAsset[] = [];
  let nonZeroExtraBits = 0;
  if (version === 2) {
    for (const l of layouts) {
      need(p, 8 * l.count, "instances");
      for (let j = 0; j < l.count; j++) {
        const u = unpackInstance(dv.getBigUint64(p, true));
        if (u.extra !== 0) nonZeroExtraBits++;
        assets.push({ uuid: l.uuid, sx: u.sx, sy: u.sy, sz: u.sz, rot: u.rot });
        p += 8;
      }
    }
    return {
      version: 2,
      assets,
      trailing: raw.slice(p),
      rawBytes: raw.length,
      layouts,
      creatureCount,
      raw,
      nonZeroExtraBits,
    };
  }
  // v1: 28 bytes per instance: float3 centre, float3 half-extents, u8 rot, 3 pad; then float3 centre + float3 size.
  const v1: SlabV1Instance[] = [];
  for (const l of layouts) {
    need(p, 28 * l.count, "v1 instances");
    for (let j = 0; j < l.count; j++) {
      const f = (k: number): number => dv.getFloat32(p + 4 * k, true);
      v1.push({
        uuid: l.uuid,
        center: { x: f(0), y: f(1), z: f(2) },
        halfExtents: { x: f(3), y: f(4), z: f(5) },
        rot: raw[p + 24] ?? 0,
      });
      p += 28;
    }
  }
  let bounds: NonNullable<DecodedSlabDetail["v1"]>["bounds"] = null;
  if (p + 24 <= raw.length) {
    const f = (k: number): number => dv.getFloat32(p + 4 * k, true);
    bounds = { center: { x: f(0), y: f(1), z: f(2) }, size: { x: f(3), y: f(4), z: f(5) } };
  }
  // Convert to v2 semantics: stored position = AABB min corner (tiles) or centre (props), normalised to min 0.
  const pos = v1.map((a) => {
    const origin = opts.v1OriginAt?.(a.uuid) ?? "minCorner";
    return origin === "center"
      ? { x: a.center.x, y: a.center.y - a.halfExtents.y, z: a.center.z }
      : { x: a.center.x - a.halfExtents.x, y: a.center.y - a.halfExtents.y, z: a.center.z - a.halfExtents.z };
  });
  const lo = pos.reduce((m, q) => ({ x: Math.min(m.x, q.x), y: Math.min(m.y, q.y), z: Math.min(m.z, q.z) }), {
    x: Infinity,
    y: Infinity,
    z: Infinity,
  });
  const minX = pos.length ? Math.floor(lo.x) : 0;
  const minY = pos.length ? Math.floor(lo.y * 4) / 4 : 0;
  const minZ = pos.length ? Math.floor(lo.z) : 0;
  v1.forEach((a, i) => {
    const q = pos[i] ?? { x: 0, y: 0, z: 0 };
    assets.push({
      uuid: a.uuid,
      sx: toScaled(q.x - minX),
      sy: toScaled(q.y - minY),
      sz: toScaled(q.z - minZ),
      rot: a.rot % 24,
    });
  });
  return {
    version: 1,
    assets,
    trailing: raw.slice(p),
    rawBytes: raw.length,
    layouts,
    creatureCount: 0,
    raw,
    v1: { instances: v1, bounds },
    nonZeroExtraBits: 0,
  };
}

export function decodeDetailed(slab: string, opts: DecodeOptions = {}): DecodedSlabDetail {
  const { raw, compressedBytes } = decompress(slab);
  return { ...decodeRaw(raw, opts), compressedBytes };
}

export function decode(slab: string): DecodedSlab {
  const d = decodeDetailed(slab);
  return {
    version: d.version,
    assets: d.assets,
    trailing: d.trailing,
    compressedBytes: d.compressedBytes,
    rawBytes: d.rawBytes,
  };
}

/** The codec object implementing the contract seam (`SlabCodec`). */
export const slabCodec: SlabCodec = {
  formatVersion: 2,
  limits: { ...SLAB_LIMITS },
  toScaled,
  degreesToRot,
  rotToDegrees,
  encodeRaw,
  encode,
  decode,
};

/** Optional copy format: the game accepts both. */
export function fenceSlab(slab: string): string {
  return "```" + slab + "```";
}
