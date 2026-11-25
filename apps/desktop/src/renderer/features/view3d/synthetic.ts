/**
 * A synthetic town for measuring and testing the viewer at map scale, built with scene3d itself (no game files): a
 * grid of blocks, each empty ground with a few trees or a building of one to eight storeys (a storey per level), with
 * floor tiles (box stand-ins), walls and barrels (small synthetic meshes) and a roof layer on top. Deterministic.
 */
import {
  assembleScene,
  boxMeshSource,
  cuboid,
  type MeshData,
  type MeshLookup,
  type MeshSource,
  type PieceLookup,
  type Scene,
  type ScenePiece,
} from "@slabyrinth/scene3d";

export const SYN = {
  FLOOR: "50000000-0000-4000-8000-000000000001",
  WALL: "50000000-0000-4000-8000-000000000002",
  BARREL: "50000000-0000-4000-8000-000000000003",
  TREE: "50000000-0000-4000-8000-000000000004",
  ROOF: "50000000-0000-4000-8000-000000000005",
} as const;

const STOREY_H = 3;

/** Several cuboids as one mesh. */
function merge(parts: MeshData[]): MeshData {
  let nv = 0;
  let ni = 0;
  for (const p of parts) {
    nv += p.positions.length;
    ni += p.indices.length;
  }
  const positions = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    positions.set(p.positions, vo);
    for (let i = 0; i < p.indices.length; i++) indices[io + i] = (p.indices[i] ?? 0) + vo / 3;
    vo += p.positions.length;
    io += p.indices.length;
  }
  return { positions, indices };
}

const v = (x: number, y: number, z: number): { x: number; y: number; z: number } => ({ x, y, z });

/** The synthetic meshes (in their own frames, min-corner origin like tiles). */
export function syntheticMeshes(): Map<string, MeshData> {
  const wall = merge([
    cuboid(v(0, 0, 0), v(1, 2, 0.25)),
    cuboid(v(0, 2, 0), v(0.35, 2.4, 0.25)),
    cuboid(v(0.65, 2, 0), v(1, 2.4, 0.25)),
  ]);
  // a barrel: an octagon of thin staves
  const staves: MeshData[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 4;
    const c = Math.cos(a) * 0.3;
    const s = Math.sin(a) * 0.3;
    staves.push(
      cuboid(
        v(0.5 - Math.abs(c) - 0.05, 0, 0.5 - Math.abs(s) - 0.05),
        v(0.5 + Math.abs(c) + 0.05, 0.8, 0.5 + Math.abs(s) + 0.05),
      ),
    );
  }
  const tree = merge([
    cuboid(v(0.4, 0, 0.4), v(0.6, 1.2, 0.6)),
    cuboid(v(0, 1.2, 0), v(1, 2, 1)),
    cuboid(v(0.2, 2, 0.2), v(0.8, 2.8, 0.8)),
  ]);
  return new Map([
    [SYN.WALL, wall],
    [SYN.BARREL, merge(staves)],
    [SYN.TREE, tree],
  ]);
}

/** A mesh source giving the synthetic meshes, boxes for the rest. */
export function syntheticMeshSource(): MeshSource {
  const meshes = syntheticMeshes();
  return {
    label: "synthetic",
    load(uuids) {
      const out = new Map<string, MeshLookup>();
      for (const u of uuids) {
        const m = meshes.get(u);
        out.set(u, m ? { kind: "mesh", mesh: m } : { kind: "box", reason: "boxes-requested" });
      }
      return Promise.resolve(out);
    },
  };
}

const geom = (x: number, y: number, z: number) => ({
  size: { x, y, z },
  originAt: "minCorner" as const,
  boundsCenter: { x: x / 2, y: y / 2, z: z / 2 },
});

export const syntheticLookup: PieceLookup = {
  info(uuid) {
    switch (uuid) {
      case SYN.WALL:
        return {
          name: "Wall",
          geom: geom(1, 2.4, 0.25),
          facts: { kind: "tile", groupTag: "wall", tags: [], name: "Wall", height: 2.4 },
        };
      case SYN.BARREL:
        return {
          name: "Barrel",
          geom: geom(1, 0.8, 1),
          facts: { kind: "prop", groupTag: "", tags: [], name: "Barrel", height: 0.8 },
        };
      case SYN.TREE:
        return {
          name: "Tree",
          geom: geom(1, 2.8, 1),
          facts: { kind: "prop", groupTag: "", tags: ["tree"], name: "Tree", height: 2.8 },
        };
      case SYN.ROOF:
        return {
          name: "Roof",
          geom: geom(1, 0.3, 1),
          facts: { kind: "tile", groupTag: "roof", tags: [], name: "Roof", height: 0.3 },
        };
      default:
        return {
          name: "Floor",
          geom: geom(1, 0.1, 1),
          facts: { kind: "tile", groupTag: "floor", tags: [], name: "Floor", height: 0.1 },
        };
    }
  },
};

/** A small integer hash in 0..1 (deterministic, no state). */
function rand(a: number, b: number, salt: number): number {
  let h = (a * 374761393 + b * 668265263 + salt * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export interface TownOptions {
  /** Map side in tiles (default 1024). */
  side?: number;
  /** Block side in tiles (default 16). */
  block?: number;
  /** Most storeys (levels), default 8. */
  levels?: number;
}

/** The pieces of the synthetic town. */
export function townPieces(o: TownOptions = {}): {
  pieces: ScenePiece[];
  levels: { id: string; name: string }[];
} {
  const side = o.side ?? 1024;
  const block = o.block ?? 16;
  const maxLevels = o.levels ?? 8;
  const pieces: ScenePiece[] = [];
  const base = { cell: null, material: null, geom: null, name: null } as const;
  const put = (
    uuid: string,
    x: number,
    y: number,
    z: number,
    rotDeg: number,
    level: number,
    layer: string,
    role: ScenePiece["role"],
    elementId: string | null,
  ): void => {
    pieces.push({ ...base, uuid, stored: { x, y, z }, rotDeg, levelId: `l${level}`, layer, role, elementId });
  };
  const blocks = Math.floor(side / block);
  for (let bz = 0; bz < blocks; bz++)
    for (let bx = 0; bx < blocks; bx++) {
      const x0 = bx * block;
      const z0 = bz * block;
      if (rand(bx, bz, 1) < 0.45) {
        for (let t = 0; t < 3; t++)
          put(
            SYN.TREE,
            x0 + Math.floor(rand(bx, bz, 10 + t) * block),
            0,
            z0 + Math.floor(rand(bx, bz, 20 + t) * block),
            0,
            0,
            "site",
            "feature",
            null,
          );
        continue;
      }
      const s = 4 + Math.floor(rand(bx, bz, 2) * 5);
      const storeys = Math.min(maxLevels, 1 + Math.floor(rand(bx, bz, 3) ** 3 * maxLevels));
      const ox = x0 + 2;
      const oz = z0 + 2;
      const el = `b${bx}-${bz}`;
      for (let st = 0; st < storeys; st++) {
        const y = st * STOREY_H;
        const layer = `storey:${st}`;
        for (let z = 0; z < s; z++)
          for (let x = 0; x < s; x++) put(SYN.FLOOR, ox + x, y, oz + z, 0, st, layer, "floor", el);
        for (let i = 0; i < s; i++) {
          put(SYN.WALL, ox + i, y, oz, 0, st, layer, "wall", el);
          put(SYN.WALL, ox + i + 1, y, oz + s, 180, st, layer, "wall", el);
          put(SYN.WALL, ox, y, oz + i + 1, 90, st, layer, "wall", el);
          put(SYN.WALL, ox + s, y, oz + i, 270, st, layer, "wall", el);
        }
        put(SYN.BARREL, ox + 1, y + 0.1, oz + 1, 0, st, layer, "feature", el);
        put(SYN.BARREL, ox + s - 2, y + 0.1, oz + s - 2, 45, st, layer, "feature", el);
      }
      const top = storeys - 1;
      for (let z = 0; z < s; z++)
        for (let x = 0; x < s; x++)
          put(SYN.ROOF, ox + x, storeys * STOREY_H - 0.4, oz + z, 0, top, "roof", "floor", el);
    }
  const levels = Array.from({ length: maxLevels }, (_, i) => ({ id: `l${i}`, name: `Level ${i + 1}` }));
  return { pieces, levels };
}

/** The synthetic town as a scene: with its synthetic meshes, or every piece a box. */
export function syntheticTown(o: TownOptions & { boxes?: boolean } = {}): Promise<Scene> {
  const { pieces, levels } = townPieces(o);
  return assembleScene(
    "build",
    pieces,
    levels,
    syntheticLookup,
    o.boxes ? boxMeshSource() : syntheticMeshSource(),
  );
}
