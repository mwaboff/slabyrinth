/**
 * The one rule every game-file reader follows: a count, offset, length or stride read from a file is a claim, and it is
 * checked against the bytes actually there and against a stated ceiling before any loop or allocation uses it. A claim
 * that fails is a DecodeError, so a corrupt file or a game update the readers were not written for costs a box with a
 * reason, never an endless loop, a 4 GiB allocation or bytes read from the wrong place.
 *
 * The input is the user's own game files, so this is robustness (a truncated download, a changed layout), not defence
 * against an attacker; the ceilings are far above anything the stock game ships and far below what would hurt.
 */
import { DecodeError } from "./errors";

export const READ_LIMITS = {
  /**
   * Most bytes one bundle may unpack to (every block together). The largest stock bundle is about 50 MB packed
   * (2026-11: a castle tileset, textures included) and unpacks to a few times that; 1 GiB is far above it and below
   * what the app's mesh worker may hold.
   */
  unpackedBytes: 1024 * 1024 * 1024,
  /**
   * LZ4's own ceiling on how far a block can grow: a match sequence turns each further input byte into at most 255
   * output bytes, so an LZ4 block can never unpack to more than this many times its packed size (plus one sequence).
   */
  lz4Ratio: 255,
  /** Deepest transform hierarchy a prefab may have (real prefabs nest a few levels; a chain deeper is a corrupt file). */
  hierarchyDepth: 256,
} as const;

/** A whole, non-negative number that JavaScript holds exactly. */
function whole(v: number): boolean {
  return Number.isSafeInteger(v) && v >= 0;
}

/**
 * A count of items read from a file, each at least `minBytes` long, of which at most `available` bytes remain: the
 * count, or a DecodeError when it is negative, fractional, or more than the bytes left could hold.
 */
export function checkedCount(what: string, count: number, minBytes: number, available: number): number {
  if (!whole(count)) throw new DecodeError(`${what}: count ${String(count)} is not a whole number`);
  if (count * Math.max(1, minBytes) > Math.max(0, available))
    throw new DecodeError(
      `${what}: ${String(count)} items do not fit in the ${String(available)} bytes left`,
    );
  return count;
}

/** A range [offset, offset + length) read from a file, inside `total` bytes, or a DecodeError. */
export function checkedRange(what: string, offset: number, length: number, total: number): number {
  if (!whole(offset) || !whole(length) || offset + length > total)
    throw new DecodeError(
      `${what}: bytes ${String(offset)}..${String(offset + length)} are outside the ${String(total)} there are`,
    );
  return offset;
}

/** A size to allocate, read from a file: a whole number at most `ceiling`, or a DecodeError (before any allocation). */
export function checkedSize(what: string, size: number, ceiling: number): number {
  if (!whole(size)) throw new DecodeError(`${what}: size ${String(size)} is not a whole number`);
  if (size > ceiling)
    throw new DecodeError(
      `${what}: size ${String(size)} is over the ${String(ceiling)} bytes a reader allows`,
    );
  return size;
}
