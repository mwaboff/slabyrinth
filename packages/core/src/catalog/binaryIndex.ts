/**
 * Reader for TaleSpire's binary per-pack asset index (`Taleweaver/<packGuid>/index`, format v5).
 * Port of tools/research/TsIndexReader.cs with the defensive checks of docs/talespire-assets.md §8.7.
 *
 * Encoding (VERIFIED on v5): little-endian; `rel` = int32 offset relative to the address of the field itself
 * (0 = null); string = {rel, u32 lengthInUtf16Units}; array = {rel, u32 count}; GUID in .NET byte order.
 */
import type { CatalogAsset, CatalogSource } from "../contracts/compiler";
import { bytesToGuid } from "../slab/guid";
import { deriveCatalogAsset, type RawCatalogRecord } from "./derive";

export const INDEX_MAGIC = 0xd1ced1ce;
export const INDEX_KNOWN_VERSION = 5;
export const INDEX_KNOWN_SCHEMA = "2061c3a8-4467-113e-1ab5-705888f6959f";
const BOARD_OBJECT_SIZE = 176;
const SEARCH_COLUMNS = 10;
const STRING_BLOB_START = 0x30;
const MAX_STRING = 100_000;

/** Hard-check failure: the pack is unreadable with this reader (fall back per §8.7). */
export class IndexFormatError extends Error {
  override name = "IndexFormatError";
}

export interface BinaryIndexAsset {
  id: string;
  name: string;
  category: string;
  folder: string;
  groupTag: string;
  groupTagExtra: number;
  footprintA: number;
  footprintB: number;
  tags: string[];
  flags: number;
  deprecated: boolean;
  kindCode: number;
  kind: "tile" | "prop" | "creature" | `unknown${number}`;
  /** Present for tiles and props (from the BoardObject record). */
  board?: {
    mainUnknown32: number;
    meshParts: number;
    colliderCount: number;
    center: { x: number; y: number; z: number };
    extent: { x: number; y: number; z: number };
    interactable: boolean;
  };
}

export interface BinaryIndexResult {
  version: number;
  schemaId: string;
  packName: string;
  /** Search-table rows in file order (tiles, props, creatures). */
  rows: BinaryIndexAsset[];
  boardObjectCount: number;
  searchTableBytes: number;
  warnings: string[];
}

class Reader {
  readonly dv: DataView;
  readonly len: number;
  /** End of the string blob (= root offset); string targets must fall in [0x30, blobEnd). */
  blobEnd: number;
  constructor(readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    this.len = b.length;
    this.blobEnd = b.length;
  }
  check(o: number, n: number, what: string): void {
    if (!Number.isInteger(o) || o < 0 || n < 0 || o + n > this.len) {
      throw new IndexFormatError(`${what}: read of ${n} bytes at 0x${o.toString(16)} is outside the file`);
    }
  }
  u32(o: number): number {
    this.check(o, 4, "u32");
    return this.dv.getUint32(o, true);
  }
  i32(o: number): number {
    this.check(o, 4, "i32");
    return this.dv.getInt32(o, true);
  }
  f32(o: number): number {
    this.check(o, 4, "f32");
    return this.dv.getFloat32(o, true);
  }
  /** Absolute target of a relative pointer, or -1 for null. */
  ptr(fieldAt: number): number {
    const rel = this.i32(fieldAt);
    if (rel === 0) return -1;
    const t = fieldAt + rel;
    if (t < 0 || t >= this.len)
      throw new IndexFormatError(
        `pointer at 0x${fieldAt.toString(16)} targets 0x${t.toString(16)}, outside the file`,
      );
    return t;
  }
  str(fieldAt: number): string {
    const n = this.u32(fieldAt + 4);
    if (n === 0) return "";
    if (n >= MAX_STRING)
      throw new IndexFormatError(`implausible string length ${n} at 0x${fieldAt.toString(16)}`);
    const p = this.ptr(fieldAt);
    if (p < 0)
      throw new IndexFormatError(`null string pointer with length ${n} at 0x${fieldAt.toString(16)}`);
    if (p < STRING_BLOB_START || p + n * 2 > this.blobEnd) {
      throw new IndexFormatError(`string at 0x${fieldAt.toString(16)} points outside the string blob`);
    }
    this.check(p, n * 2, "string");
    let s = "";
    for (let i = 0; i < n; i += 4096) {
      const units: number[] = [];
      const end = Math.min(n, i + 4096);
      for (let k = i; k < end; k++) units.push(this.dv.getUint16(p + 2 * k, true));
      s += String.fromCharCode(...units);
    }
    return s;
  }
  guid(o: number): string {
    this.check(o, 16, "guid");
    return bytesToGuid(this.b, o);
  }
  /** Array descriptor: {target, count}, with the whole span checked against the file. */
  array(fieldAt: number, elemSize: number, what: string): { at: number; count: number } {
    const count = this.u32(fieldAt + 4);
    if (count === 0) return { at: -1, count: 0 };
    const at = this.ptr(fieldAt);
    if (at < 0) throw new IndexFormatError(`${what}: null pointer with count ${count}`);
    if (count > this.len / Math.max(1, elemSize))
      throw new IndexFormatError(`${what}: implausible count ${count}`);
    this.check(at, count * elemSize, what);
    return { at, count };
  }
}

/** Parses the binary index. Throws IndexFormatError when a hard check fails; soft checks become warnings. */
export function readBinaryIndex(bytes: Uint8Array): BinaryIndexResult {
  const r = new Reader(bytes);
  const warnings: string[] = [];
  if (bytes.length < 0x40) throw new IndexFormatError("file too short");
  const magic = r.u32(0);
  if (magic !== INDEX_MAGIC)
    throw new IndexFormatError(`bad magic 0x${magic.toString(16).toUpperCase().padStart(8, "0")}`);
  const version = r.u32(4);
  const schemaId = r.guid(0x10);
  if (version !== INDEX_KNOWN_VERSION)
    warnings.push(`unknown index version ${version} (reader built for v${INDEX_KNOWN_VERSION})`);
  if (schemaId !== INDEX_KNOWN_SCHEMA) warnings.push(`unknown schema id ${schemaId}`);
  const rootLo = r.u32(8);
  const rootHi = r.u32(12);
  if (rootHi !== 0 || rootLo + 64 > bytes.length || rootLo < STRING_BLOB_START)
    throw new IndexFormatError("root offset out of range");
  const root = rootLo;
  r.blobEnd = root;
  const packName = r.str(root + 0);

  // ---- search table: SEARCH_COLUMNS × {rel, count}; all columns share one count
  const tbl = r.ptr(root + 8);
  if (tbl < 0) throw new IndexFormatError("no search table");
  r.check(tbl, SEARCH_COLUMNS * 8, "search table");
  const searchTableBytes = r.u32(root + 12);
  if (searchTableBytes === 0 || searchTableBytes > bytes.length)
    warnings.push(`implausible search table size ${searchTableBytes}`);
  const elemSizes = [16, 8, 8, 8, 12, 8, 8, 4, 64, 4] as const;
  const n = r.u32(tbl + 4);
  const col: number[] = [];
  for (let c = 0; c < SEARCH_COLUMNS; c++) {
    const count = r.u32(tbl + 8 * c + 4);
    if (count !== n) throw new IndexFormatError(`search column ${c} count ${count} != ${n}`);
    col.push(n === 0 ? -1 : r.array(tbl + 8 * c, elemSizes[c] ?? 4, `search column ${c}`).at);
  }
  const c = (i: number): number => col[i] ?? -1;
  const rows: BinaryIndexAsset[] = [];
  const byId = new Map<string, BinaryIndexAsset>();
  let unknownFlagBits = 0;
  const unknownKinds = new Set<number>();
  for (let i = 0; i < n; i++) {
    const tagArr = c(6) + 8 * i;
    const tagDesc = r.array(tagArr, 8, "tags");
    if (tagDesc.count > 1000) throw new IndexFormatError("implausible tag count");
    const tags: string[] = [];
    for (let k = 0; k < tagDesc.count; k++) tags.push(r.str(tagDesc.at + 8 * k));
    const flags = r.u32(c(7) + 4 * i);
    if ((flags & ~2) !== 0) unknownFlagBits |= flags & ~2;
    const kindCode = r.u32(c(9) + 4 * i);
    const kind: BinaryIndexAsset["kind"] =
      kindCode === 1 ? "tile" : kindCode === 2 ? "prop" : kindCode === 4 ? "creature" : `unknown${kindCode}`;
    if (kindCode !== 1 && kindCode !== 2 && kindCode !== 4) unknownKinds.add(kindCode);
    const a: BinaryIndexAsset = {
      id: r.guid(c(0) + 16 * i),
      name: r.str(c(1) + 8 * i),
      category: r.str(c(2) + 8 * i),
      folder: r.str(c(3) + 8 * i),
      groupTag: r.str(c(4) + 12 * i),
      groupTagExtra: r.u32(c(4) + 12 * i + 8),
      footprintA: r.u32(c(5) + 8 * i),
      footprintB: r.u32(c(5) + 8 * i + 4),
      tags,
      flags,
      deprecated: (flags & 2) !== 0,
      kindCode,
      kind,
    };
    if (byId.has(a.id)) warnings.push(`duplicate id ${a.id}`);
    else byId.set(a.id, a);
    rows.push(a);
  }
  if (unknownFlagBits !== 0)
    warnings.push(`unknown flag bits 0x${unknownFlagBits.toString(16)} in search column 7`);
  for (const k of unknownKinds) warnings.push(`unknown kind code ${k}`);

  // ---- board objects (tiles + props): array at root+16 of 176-byte records
  const boards = r.array(root + 16, BOARD_OBJECT_SIZE, "board objects");
  const expected = rows.filter((x) => x.kindCode === 1 || x.kindCode === 2).length;
  if (boards.count !== expected) {
    throw new IndexFormatError(`board object count ${boards.count} != tile+prop rows ${expected}`);
  }
  for (let i = 0; i < boards.count; i++) {
    const rec = boards.at + BOARD_OBJECT_SIZE * i;
    const id = r.guid(rec + 8);
    const a = byId.get(id);
    if (!a) throw new IndexFormatError(`board object ${i} (${id}) missing from the search table`);
    const name = r.str(rec + 0);
    if (name !== a.name)
      throw new IndexFormatError(`board object ${i} (${id}) name "${name}" != search table "${a.name}"`);
    const k = r.u32(rec + 24);
    if (k !== a.kindCode) warnings.push(`kind mismatch for ${id}`);
    const center = { x: r.f32(rec + 60), y: r.f32(rec + 64), z: r.f32(rec + 68) };
    const extent = { x: r.f32(rec + 72), y: r.f32(rec + 76), z: r.f32(rec + 80) };
    for (const v of [extent.x, extent.y, extent.z]) {
      if (!Number.isFinite(v) || v < 0 || v > 1000)
        throw new IndexFormatError(`implausible bounds extent ${v} for ${id}`);
    }
    for (const v of [center.x, center.y, center.z]) {
      if (!Number.isFinite(v) || Math.abs(v) > 1000)
        throw new IndexFormatError(`implausible bounds centre ${v} for ${id}`);
    }
    a.board = {
      mainUnknown32: r.u32(rec + 32),
      meshParts: r.u32(rec + 40),
      colliderCount: r.u32(rec + 48),
      center,
      extent,
      interactable: r.i32(rec + 112) !== 0,
    };
  }
  return { version, schemaId, packName, rows, boardObjectCount: boards.count, searchTableBytes, warnings };
}

/** Converts a parsed binary index into catalog records (tiles and props, search-table order). */
export function binaryIndexToCatalog(res: BinaryIndexResult, pack: { packId: string }): CatalogAsset[] {
  const out: CatalogAsset[] = [];
  for (const a of res.rows) {
    if ((a.kind !== "tile" && a.kind !== "prop") || !a.board) continue;
    const raw: RawCatalogRecord = {
      id: a.id,
      name: a.name,
      kind: a.kind,
      folder: a.folder,
      groupTag: a.groupTag,
      tags: a.tags,
      deprecated: a.deprecated,
      interactable: a.board.interactable,
      center: a.board.center,
      extent: a.board.extent,
      meshParts: a.board.meshParts,
    };
    out.push(deriveCatalogAsset(raw, { packId: pack.packId, packName: res.packName }));
  }
  return out;
}

export const binaryIndexSource: CatalogSource = {
  id: "binary-index",
  canRead(fileName: string, head: Uint8Array): boolean {
    if (fileName !== "index" || head.length < 8) return false;
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    return dv.getUint32(0, true) === INDEX_MAGIC;
  },
  read(bytes, pack) {
    const res = readBinaryIndex(bytes);
    return { packName: res.packName, assets: binaryIndexToCatalog(res, pack), warnings: res.warnings };
  },
};
