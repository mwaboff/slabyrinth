/**
 * Builds small synthetic binary asset indexes (format v5 layout, talespire-assets.md §8) for parser tests.
 * The real `index` files are never committed.
 */
import { guidToBytes } from "../../../src/slab/guid";

export interface FixtureAsset {
  id: string;
  name: string;
  kind: 1 | 2 | 4;
  category?: string;
  folder?: string;
  groupTag?: string;
  tags?: string[];
  flags?: number;
  center?: [number, number, number];
  extent?: [number, number, number];
  interactable?: boolean;
  meshParts?: number;
}

export interface FixtureOptions {
  version?: number;
  schema?: string;
  packName?: string;
  /** Mutate the finished buffer (corruption tests). Receives offsets of interesting structures. */
  corrupt?: (b: Uint8Array, dv: DataView, at: { root: number; table: number; boards: number }) => void;
  /** Name written into the board object record (to provoke a mismatch). */
  boardNameOverride?: Record<string, string>;
  /** Omit board objects for these ids. */
  omitBoard?: string[];
  /**
   * Mesh parts per asset id: written as the board object's parts array and a loader table at root+12 (which then
   * points at the table instead of holding the table's size, as in the real files).
   */
  parts?: Record<string, FixturePart[]>;
}

export interface FixturePart {
  bundleId: string;
  assetName: string;
  /** Content id (GUID); parts of one prefab share it. Absent from the loader table when `unlisted`. */
  contentId: string;
  unlisted?: boolean;
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

export function buildIndexFixture(assets: FixtureAsset[], opts: FixtureOptions = {}): Uint8Array {
  const strings: string[] = [];
  const strIndex = new Map<string, number>();
  const intern = (s: string): void => {
    if (s && !strIndex.has(s)) {
      strIndex.set(s, -1);
      strings.push(s);
    }
  };
  const packName = opts.packName ?? "Fixture Pack";
  intern(packName);
  for (const a of assets) {
    [
      a.name,
      a.category ?? (a.kind === 1 ? "TILE" : a.kind === 2 ? "PROP" : "CREATURE x"),
      a.folder ?? "",
      a.groupTag ?? "",
    ].forEach(intern);
    (a.tags ?? []).forEach(intern);
    const o = opts.boardNameOverride?.[a.id];
    if (o) intern(o);
  }
  const allParts = Object.values(opts.parts ?? {}).flat();
  for (const pt of allParts) {
    intern(pt.bundleId);
    intern(pt.assetName);
  }
  const loaderRows = [
    ...new Map(allParts.filter((pt) => !pt.unlisted).map((pt) => [pt.contentId, pt])).values(),
  ];
  // layout: header(0x30) | blob | root(64) | table(80) | columns | tag arrays | boards
  let p = 0x30;
  const blobOffsets = new Map<string, number>();
  for (const s of strings) {
    blobOffsets.set(s, p);
    p += s.length * 2;
  }
  const align = (v: number): number => (v + 15) & ~15;
  const root = align(p);
  const table = root + 64;
  const n = assets.length;
  const colSizes = [16, 8, 8, 8, 12, 8, 8, 4, 64, 4];
  const cols: number[] = [];
  let q = table + 80;
  for (const s of colSizes) {
    cols.push(q);
    q += s * n;
  }
  const tagArrays: number[] = [];
  for (const a of assets) {
    tagArrays.push(q);
    q += 8 * (a.tags ?? []).length;
  }
  const boardAssets = assets.filter(
    (a) => (a.kind === 1 || a.kind === 2) && !(opts.omitBoard ?? []).includes(a.id),
  );
  const boards = align(q);
  const loader = boards + 176 * boardAssets.length;
  const loaderCols = [
    loader + 24,
    loader + 24 + 16 * loaderRows.length,
    loader + 24 + 24 * loaderRows.length,
  ];
  let partsAt = loader + (opts.parts ? 24 + 32 * loaderRows.length : 0);
  const partArrays = new Map<string, number>();
  for (const a of boardAssets) {
    const list = opts.parts?.[a.id] ?? [];
    if (!list.length) continue;
    partArrays.set(a.id, partsAt);
    partsAt += 104 * list.length;
  }
  const end = partsAt;
  const b = new Uint8Array(end);
  const dv = new DataView(b.buffer);
  const rel = (field: number, target: number): void => {
    dv.setInt32(field, target - field, true);
  };
  const str = (field: number, s: string): void => {
    if (!s) return;
    const off = blobOffsets.get(s);
    if (off === undefined) throw new Error("not interned");
    rel(field, off);
    dv.setUint32(field + 4, s.length, true);
  };
  dv.setUint32(0, 0xd1ced1ce, true);
  dv.setUint32(4, opts.version ?? 5, true);
  dv.setUint32(8, root, true);
  guidToBytes(opts.schema ?? "2061c3a8-4467-113e-1ab5-705888f6959f", b, 0x10);
  for (const [s, off] of blobOffsets)
    for (let i = 0; i < s.length; i++) dv.setUint16(off + 2 * i, s.charCodeAt(i), true);
  str(root, packName);
  rel(root + 8, table);
  dv.setUint32(root + 12, q - table, true);
  if (boardAssets.length) rel(root + 16, boards);
  dv.setUint32(root + 20, boardAssets.length, true);
  for (let c = 0; c < 10; c++) {
    if (n) rel(table + 8 * c, cols[c] ?? 0);
    dv.setUint32(table + 8 * c + 4, n, true);
  }
  assets.forEach((a, i) => {
    guidToBytes(a.id, b, (cols[0] ?? 0) + 16 * i);
    str((cols[1] ?? 0) + 8 * i, a.name);
    str((cols[2] ?? 0) + 8 * i, a.category ?? (a.kind === 1 ? "TILE" : a.kind === 2 ? "PROP" : "CREATURE x"));
    str((cols[3] ?? 0) + 8 * i, a.folder ?? "");
    str((cols[4] ?? 0) + 12 * i, a.groupTag ?? "");
    const tags = a.tags ?? [];
    const ta = (cols[6] ?? 0) + 8 * i;
    if (tags.length) rel(ta, tagArrays[i] ?? 0);
    dv.setUint32(ta + 4, tags.length, true);
    tags.forEach((t, k) => {
      str((tagArrays[i] ?? 0) + 8 * k, t);
    });
    dv.setUint32((cols[7] ?? 0) + 4 * i, a.flags ?? 0, true);
    dv.setUint32((cols[9] ?? 0) + 4 * i, a.kind, true);
  });
  boardAssets.forEach((a, i) => {
    const rec = boards + 176 * i;
    str(rec, opts.boardNameOverride?.[a.id] ?? a.name);
    guidToBytes(a.id, b, rec + 8);
    dv.setUint32(rec + 24, a.kind, true);
    dv.setUint32(rec + 40, a.meshParts ?? 1, true);
    const c = a.center ?? [0.5, 0.25, 0.5];
    const e = a.extent ?? [0.5, 0.25, 0.5];
    c.forEach((v, k) => {
      dv.setFloat32(rec + 60 + 4 * k, v, true);
    });
    e.forEach((v, k) => {
      dv.setFloat32(rec + 72 + 4 * k, v, true);
    });
    if (a.interactable) dv.setInt32(rec + 112, 16, true);
    const list = opts.parts?.[a.id] ?? [];
    const at = partArrays.get(a.id);
    if (at === undefined) {
      if (opts.parts) dv.setUint32(rec + 40, 0, true);
      return;
    }
    rel(rec + 36, at);
    dv.setUint32(rec + 40, list.length, true);
    list.forEach((pt, k) => {
      const e = at + 104 * k;
      guidToBytes(pt.contentId, b, e + 44);
      (pt.position ?? [0, 0, 0]).forEach((v, j) => {
        dv.setFloat32(e + 64 + 4 * j, v, true);
      });
      (pt.rotation ?? [0, 0, 0, 1]).forEach((v, j) => {
        dv.setFloat32(e + 76 + 4 * j, v, true);
      });
      (pt.scale ?? [1, 1, 1]).forEach((v, j) => {
        dv.setFloat32(e + 92 + 4 * j, v, true);
      });
    });
  });
  if (opts.parts) {
    rel(root + 12, loader);
    loaderCols.forEach((col, c) => {
      if (loaderRows.length) rel(loader + 8 * c, col);
      dv.setUint32(loader + 8 * c + 4, loaderRows.length, true);
    });
    loaderRows.forEach((pt, i) => {
      guidToBytes(pt.contentId, b, (loaderCols[0] ?? 0) + 16 * i);
      str((loaderCols[1] ?? 0) + 8 * i, pt.bundleId);
      str((loaderCols[2] ?? 0) + 8 * i, pt.assetName);
    });
  }
  opts.corrupt?.(b, dv, { root, table, boards });
  return b;
}

export const FIXTURE_ASSETS: FixtureAsset[] = [
  {
    id: "63270c8a-9484-4ae8-926e-22e3de9048a1",
    name: "Dungeon Wall 01",
    kind: 1,
    folder: "Dungeon Cellar",
    groupTag: "wall",
    tags: ["1x1", "dungeon", "wall"],
    center: [0.5, 1, 0.25],
    extent: [0.5, 1, 0.25],
  },
  {
    id: "e62c6746-cecf-46bf-8b20-f81738f1d220",
    name: "Tavern Floor 03",
    kind: 1,
    folder: "Tavern",
    groupTag: "floor",
    tags: ["2x2"],
    center: [1, 0.25, 1],
    extent: [1, 0.25, 1],
    flags: 2,
  },
  {
    id: "3da5dbe8-132e-4cab-b539-cedc04b22099",
    name: "Leather Chest",
    kind: 2,
    folder: "Traps & Treasure",
    tags: ["chest"],
    center: [0.001, 0.209, -0.002],
    extent: [0.425, 0.209, 0.2575],
    interactable: true,
    meshParts: 2,
  },
  { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "Goblin", kind: 4, category: "CREATURE Humanoid" },
];
