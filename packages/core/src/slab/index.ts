/**
 * Slab codec v2 (byte-exact encode, v1/v2 decode) — public API (WP3).
 * Pure TypeScript: no electron, DOM or node:* imports here.
 */
export {
  SLAB_LIMITS,
  SLAB_MAGIC,
  MAX_SLAB_BASE64_CHARS,
  MAX_SLAB_RAW_BYTES,
  SlabFormatError,
  decode,
  decodeDetailed,
  decodeRaw,
  decompress,
  degreesToRot,
  encode,
  encodeLayoutsRaw,
  encodeRaw,
  fenceSlab,
  groupLayouts,
  gzip,
  packInstance,
  rotToDegrees,
  slabCodec,
  toScaled,
  unpackInstance,
  unwrapSlabString,
} from "./codec";
export type { DecodeOptions, DecodedSlabDetail, SlabLayout, SlabV1Instance } from "./codec";
export { base64Decode, base64Encode } from "./base64";
export { bytesToGuid, guidToBytes, isGuid, normalizeGuid } from "./guid";
export { sha256, sha256Hex, toHex } from "./sha256";
