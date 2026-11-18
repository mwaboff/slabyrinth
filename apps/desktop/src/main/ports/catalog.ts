import { CATALOG_SOURCES, EXTRACTOR_VERSION } from "@slabyrinth/core/catalog";
import type { CatalogAsset, CatalogSource, CatalogSourceId } from "@slabyrinth/core";

/**
 * Narrow port onto core's catalog readers (WP3, `packages/core/src/catalog`). The contract type is
 * `CatalogSource` (compiler.ts): pure functions over bytes. The shell does all file access and
 * caching; the reader only turns one pack's index bytes into assets.
 *
 * Real wiring: core's `CATALOG_SOURCES` (binary index first, index.json as fallback);
 * `EXTRACTOR_VERSION` versions the cache.
 */
export interface PackFile {
  name: "index" | "index.json";
  bytes: Uint8Array;
}

export interface PackReadResult {
  packName: string;
  source: CatalogSourceId;
  assets: CatalogAsset[];
  warnings: string[];
}

export interface CatalogReaderPort {
  readonly kind: "core" | "fake";
  readonly extractorVersion: number;
  /** Reads one pack, binary index first, index.json as fallback. Throws when no source can read it. */
  readPack(pack: { packId: string; dirName: string }, files: PackFile[]): PackReadResult;
}

export function readerFromSources(
  sources: readonly CatalogSource[],
  kind: "core" | "fake",
  extractorVersion: number,
): CatalogReaderPort {
  return {
    kind,
    extractorVersion,
    readPack(pack, files) {
      const errors: string[] = [];
      for (const source of sources) {
        const wanted = source.id === "binary-index" ? "index" : "index.json";
        const file = files.find((f) => f.name === wanted && source.canRead(f.name, f.bytes.subarray(0, 64)));
        if (!file) continue;
        try {
          const r = source.read(file.bytes, pack);
          return { packName: r.packName, source: source.id, assets: r.assets, warnings: r.warnings };
        } catch (err) {
          errors.push(`${source.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      throw new Error(errors.length > 0 ? errors.join("; ") : "no readable index file");
    },
  };
}

/** The real reader: core's catalog sources, binary index first. */
export function createCoreCatalogReader(): CatalogReaderPort {
  return readerFromSources(CATALOG_SOURCES, "core", EXTRACTOR_VERSION);
}

// ───────────────────────── fake reader (tests, and dev builds until WP3's readers land) ─────────────────────────

interface JsonBoardObject {
  Id?: string;
  Name?: string;
  IsDeprecated?: boolean;
  GroupTag?: string;
  Tags?: string[];
  Folder?: string;
  IsInteractable?: boolean;
  ColliderBoundsBound?: {
    m_Center?: { x: number; y: number; z: number };
    m_Extent?: { x: number; y: number; z: number };
  };
}

function toAsset(
  o: JsonBoardObject,
  kind: "tile" | "prop",
  pack: string,
  packId: string,
): CatalogAsset | null {
  if (typeof o.Id !== "string" || typeof o.Name !== "string") return null;
  const e = o.ColliderBoundsBound?.m_Extent ?? { x: 0.5, y: 0.5, z: 0.5 };
  const c = o.ColliderBoundsBound?.m_Center ?? { x: 0, y: 0, z: 0 };
  const size = { x: 2 * e.x, y: 2 * e.y, z: 2 * e.z };
  const minCorner = Math.abs(c.x - e.x) < 0.01 && Math.abs(c.z - e.z) < 0.01;
  const centred = Math.abs(c.x) < 0.1 && Math.abs(c.z) < 0.1;
  return {
    uuid: o.Id.toLowerCase(),
    name: o.Name,
    kind,
    pack,
    packId,
    folder: o.Folder ?? "",
    groupTag: o.GroupTag ?? "",
    tags: o.Tags ?? [],
    deprecated: o.IsDeprecated === true,
    interactable: o.IsInteractable === true,
    size,
    footprintCells: { x: Math.max(1, Math.ceil(size.x - 1e-6)), z: Math.max(1, Math.ceil(size.z - 1e-6)) },
    boundsCenter: c,
    boundsMin: { x: c.x - e.x, y: c.y - e.y, z: c.z - e.z },
    originAt: minCorner ? "minCorner" : centred ? "center" : "other",
  };
}

/** Reads only index.json (the stale fallback format). Not a replacement for WP3's binary reader. */
export const fakeIndexJsonSource: CatalogSource = {
  id: "index-json",
  canRead: (fileName, head) => fileName === "index.json" && head.length > 0 && head[0] !== 0xce,
  read(bytes, pack) {
    const json = JSON.parse(new TextDecoder().decode(bytes)) as {
      Name?: string;
      Tiles?: JsonBoardObject[];
      Props?: JsonBoardObject[];
    };
    const packName = typeof json.Name === "string" ? json.Name : pack.dirName;
    const assets: CatalogAsset[] = [];
    for (const t of json.Tiles ?? []) {
      const a = toAsset(t, "tile", packName, pack.packId);
      if (a) assets.push(a);
    }
    for (const p of json.Props ?? []) {
      const a = toAsset(p, "prop", packName, pack.packId);
      if (a) assets.push(a);
    }
    return { packName, assets, warnings: ["read by the shell's fallback index.json reader"] };
  },
};

export const fakeCatalogReader: CatalogReaderPort = readerFromSources([fakeIndexJsonSource], "fake", 0);
