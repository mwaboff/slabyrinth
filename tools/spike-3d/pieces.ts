/**
 * Asset id -> assembled geometry in the asset's own frame (index part transforms applied), loading bundles lazily.
 * Loader data (bundle id, asset name per part) comes from each pack's index.json: the binary index's part content
 * id is not yet mapped to names (open item). READ-ONLY on the install.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apply, findPrefabRoot, loadBundle, prefabGeometry, trs, type Geometry, type LoadedBundle } from "./meshlib";

export const TALEWEAVER = "C:/Program Files (x86)/Steam/steamapps/common/TaleSpire/Taleweaver";

export interface Part {
  bundle: string;
  asset: string;
  pos: [number, number, number];
  rot: [number, number, number, number];
  scale: [number, number, number];
}
export interface CatalogEntry {
  id: string;
  name: string;
  kind: "tile" | "prop";
  folder: string;
  packDir: string;
  parts: Part[];
  center: [number, number, number];
  extent: [number, number, number];
}
export interface PieceGeometry extends Geometry {
  entry: CatalogEntry;
  missing: string[];
  meshNames: string[];
}

type J = Record<string, unknown>;
const xyz = (v: unknown): [number, number, number] => {
  const o = v as J;
  return [o.x as number, o.y as number, o.z as number];
};

export function loadCatalog(root = TALEWEAVER): Map<string, CatalogEntry> {
  const out = new Map<string, CatalogEntry>();
  for (const d of readdirSync(root)) {
    const f = join(root, d, "index.json");
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8").replace(/^\uFEFF/, "")) as Record<string, J[]>;
    for (const [list, kind] of [
      ["Tiles", "tile"],
      ["Props", "prop"],
    ] as const) {
      for (const a of j[list] ?? []) {
        const c = a.ColliderBoundsBound as J;
        out.set((a.Id as string).toLowerCase(), {
          id: (a.Id as string).toLowerCase(),
          name: a.Name as string,
          kind,
          folder: a.Folder as string,
          packDir: join(root, d),
          parts: (a.Assets as J[]).map((p) => {
            const ld = p.LoaderData as J;
            const r = p.Rotation as J;
            return {
              bundle: ld.BundleId as string,
              asset: ld.AssetName as string,
              pos: xyz(p.Position),
              rot: [r.x as number, r.y as number, r.z as number, r.w as number],
              scale: xyz(p.Scale),
            };
          }),
          center: xyz(c.m_Center),
          extent: xyz(c.m_Extent),
        });
      }
    }
  }
  return out;
}

export class PieceLibrary {
  readonly bundles = new Map<string, LoadedBundle>();
  readonly pieces = new Map<string, PieceGeometry>();
  bundleMs = 0;
  meshMs = 0;
  cacheHits = 0;
  constructor(
    readonly catalog: Map<string, CatalogEntry>,
    readonly cacheDir?: string,
  ) {}
  /** Drops unpacked bundles (they are large); pieces already read stay. */
  releaseBundles(): void {
    this.bundles.clear();
  }

  bundle(entry: CatalogEntry, id: string): LoadedBundle {
    let b = this.bundles.get(id);
    if (!b) {
      const t = performance.now();
      b = loadBundle(join(entry.packDir, "Assets", id));
      this.bundleMs += performance.now() - t;
      this.bundles.set(id, b);
    }
    return b;
  }

  piece(id: string): PieceGeometry | undefined {
    const key = id.toLowerCase();
    const hit = this.pieces.get(key);
    if (hit) return hit;
    const entry = this.catalog.get(key);
    if (!entry) return undefined;
    const cached = this.cacheDir ? readCache(this.cacheDir, key, entry) : undefined;
    if (cached) {
      this.cacheHits++;
      this.pieces.set(key, cached);
      return cached;
    }
    const positions: number[] = [];
    const indices: number[] = [];
    const missing: string[] = [];
    const meshNames: string[] = [];
    let color: [number, number, number] | undefined;
    for (const p of entry.parts) {
      const lb = this.bundle(entry, p.bundle);
      const t = performance.now();
      const root = findPrefabRoot(lb, p.asset);
      if (root === undefined) {
        missing.push(`${p.bundle}/${p.asset}`);
        continue;
      }
      const g = prefabGeometry(lb, root, true);
      const m = trs(p.pos, p.rot, p.scale);
      const base = positions.length / 3;
      for (let i = 0; i < g.positions.length; i += 3) {
        const v = apply(m, g.positions[i]!, g.positions[i + 1]!, g.positions[i + 2]!);
        positions.push(v[0], v[1], v[2]);
      }
      for (const i of g.indices) indices.push(i + base);
      meshNames.push(...g.meshNames);
      color ??= g.meanColor;
      this.meshMs += performance.now() - t;
    }
    const pg: PieceGeometry = {
      entry,
      positions: Float32Array.from(positions),
      indices: Uint32Array.from(indices),
      missing,
      meshNames,
      meanColor: color,
    };
    this.pieces.set(key, pg);
    if (this.cacheDir) writeCache(this.cacheDir, key, pg);
    return pg;
  }
}

/** Cache file: u32 vertexCount, u32 indexCount, f32 mean colour ×3, positions f32, indices u32. */
function cachePath(dir: string, key: string): string {
  return join(dir, `${key}.mesh`);
}
function writeCache(dir: string, key: string, g: PieceGeometry): void {
  mkdirSync(dir, { recursive: true });
  const head = new Uint32Array([g.positions.length / 3, g.indices.length]);
  const col = new Float32Array(g.meanColor ?? [-1, -1, -1]);
  writeFileSync(
    cachePath(dir, key),
    Buffer.concat([
      Buffer.from(head.buffer),
      Buffer.from(col.buffer),
      Buffer.from(g.positions.buffer, g.positions.byteOffset, g.positions.byteLength),
      Buffer.from(g.indices.buffer, g.indices.byteOffset, g.indices.byteLength),
    ]),
  );
}
function readCache(dir: string, key: string, entry: CatalogEntry): PieceGeometry | undefined {
  const p = cachePath(dir, key);
  if (!existsSync(p)) return undefined;
  const b = readFileSync(p);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const [nv, ni] = new Uint32Array(ab, 0, 2);
  const col = new Float32Array(ab, 8, 3);
  return {
    entry,
    positions: new Float32Array(ab, 20, nv! * 3),
    indices: new Uint32Array(ab, 20 + nv! * 12, ni!),
    missing: [],
    meshNames: [],
    meanColor: col[0]! < 0 ? undefined : [col[0]!, col[1]!, col[2]!],
  };
}

