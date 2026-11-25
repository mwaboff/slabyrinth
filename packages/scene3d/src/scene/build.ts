/**
 * The scene of a build (a resolved plan and its realized placements) or of a slab (decoded assets only). One builder:
 * both list their pieces as `ScenePiece`s and `assembleScene` asks the mesh source once for every distinct asset,
 * places each mesh by the game's rule, and stands a box of the collider in for every piece without a mesh.
 */
import {
  LevelGrid,
  emptyBox,
  growBox,
  type Material,
  type PlacementRole,
  type PlacementSet,
  type ResolvedPlan,
  type SlabAsset,
} from "@slabyrinth/core";
import type {
  Box3,
  Fallback,
  MeshData,
  MeshLookup,
  MeshSource,
  PieceGeom,
  Scene,
  SceneInstance,
  SceneLevel,
  Vec3,
} from "../types/index";
import { colourClass, pieceColour } from "./colour";
import { cuboid, meshBox } from "../geom/mesh";
import { boxMesh, placedBox, placementOffset } from "./place";
import type { PieceLookup } from "./pieces";

/** One piece to place: where the build or slab stores it and what it came from. */
export interface ScenePiece {
  uuid: string;
  /** Stored position (tiles) and turn (degrees clockwise), as the slab holds them. */
  stored: Vec3;
  rotDeg: number;
  levelId: string;
  layer: string;
  role: PlacementRole | null;
  elementId: string | null;
  cell: readonly [number, number] | null;
  material: Material | null;
  /** The geometry the compiler placed it with (else the piece lookup's). */
  geom: PieceGeom | null;
  /** The compiler's name for it (else the piece lookup's). */
  name: string | null;
}

/** A small cube for a piece nobody knows the size of (reported as "no-geometry"). */
const UNKNOWN_GEOM: PieceGeom = {
  size: { x: 0.5, y: 0.5, z: 0.5 },
  originAt: "center",
  boundsCenter: { x: 0, y: 0.25, z: 0 },
};

/** Builds the scene of `pieces` (in their order) on `levels` (lowest first). */
export async function assembleScene(
  origin: Scene["origin"],
  pieces: readonly ScenePiece[],
  levels: ReadonlyArray<{ id: string; name: string }>,
  lookup: PieceLookup,
  source: MeshSource,
): Promise<Scene> {
  const uuids = [...new Set(pieces.map((p) => p.uuid.toLowerCase()))].sort();
  const found: ReadonlyMap<string, MeshLookup> = await source.load(uuids);
  const meshes = new Map<string, MeshData>();
  const boxes = new Map<string, Box3>();
  const localBox = (key: string, m: MeshData): Box3 => {
    let b = boxes.get(key);
    if (!b) boxes.set(key, (b = meshBox(m)));
    return b;
  };
  const fallbacks = new Map<string, Fallback>();
  const levelIndex = new Map(levels.map((l, i) => [l.id, i]));
  const levelBoxes = levels.map(() => emptyBox());
  const bounds = emptyBox();
  const instances: SceneInstance[] = [];
  for (const p of pieces) {
    const uuid = p.uuid.toLowerCase();
    const info = lookup.info(uuid);
    const name = p.name ?? info.name;
    const hit = found.get(uuid) ?? { kind: "box", reason: "not-in-index" };
    let meshKey: string;
    let geom: PieceGeom;
    if (hit.kind === "mesh") {
      meshKey = uuid;
      if (!meshes.has(uuid)) meshes.set(uuid, hit.mesh);
      geom = hit.geom ?? p.geom ?? info.geom ?? UNKNOWN_GEOM;
    } else {
      const g = p.geom ?? info.geom;
      geom = g ?? UNKNOWN_GEOM;
      meshKey = g ? `box:${uuid}` : "box:?";
      if (!meshes.has(meshKey))
        meshes.set(
          meshKey,
          g ? boxMesh(g) : cuboid({ x: -0.25, y: 0, z: -0.25 }, { x: 0.25, y: 0.5, z: 0.25 }),
        );
      const f = fallbacks.get(uuid);
      if (f) f.count++;
      else {
        const entry: Fallback = { uuid, name, reason: g ? hit.reason : "no-geometry", count: 1 };
        if (hit.detail !== undefined) entry.detail = hit.detail;
        fallbacks.set(uuid, entry);
      }
    }
    const mesh = meshes.get(meshKey);
    if (!mesh) continue;
    const at = placementOffset(geom, p.stored, p.rotDeg);
    const aabb = placedBox(localBox(meshKey, mesh), p.rotDeg, at);
    const li = levelIndex.get(p.levelId) ?? 0;
    const cls = colourClass({ role: p.role, layer: p.layer, material: p.material, facts: info.facts });
    instances.push({
      uuid,
      name,
      meshKey,
      rotDeg: p.rotDeg,
      at,
      aabb,
      colourClass: cls,
      colour: pieceColour(cls, uuid),
      levelId: p.levelId,
      levelIndex: li,
      layer: p.layer,
      role: p.role,
      elementId: p.elementId,
      cell: p.cell,
      stand: hit.kind === "mesh" ? "mesh" : "box",
    });
    const lb = levelBoxes[li];
    if (lb) growBox(lb, aabb);
    growBox(bounds, aabb);
  }
  const sceneLevels: SceneLevel[] = levels.map((l, i) => ({
    id: l.id,
    name: l.name,
    index: i,
    bounds: levelBoxes[i] ?? emptyBox(),
  }));
  return {
    origin,
    instances,
    meshes,
    levels: sceneLevels,
    bounds,
    fallbacks: [...fallbacks.values()].sort((a, b) => b.count - a.count || a.uuid.localeCompare(b.uuid)),
    meshSource: source.label,
  };
}

/** The scene of a build: every realized placement, in the set's order, coloured by role, layer and material. */
export function sceneFromBuild(
  resolved: ResolvedPlan,
  set: PlacementSet,
  lookup: PieceLookup,
  source: MeshSource,
): Promise<Scene> {
  const levels = resolved.levels
    .map((l, i) => ({ l, i }))
    .sort((a, b) => a.l.elevation - b.l.elevation || a.i - b.i)
    .map(({ l }) => l);
  const grids = new Map(levels.map((l) => [l.id, new LevelGrid(l)]));
  const pieces: ScenePiece[] = [];
  for (const lv of set.levels) {
    const grid = grids.get(lv.levelId);
    for (const p of lv.placements) {
      const cell = p.source.cell ?? null;
      const placed = set.placed?.get(p);
      pieces.push({
        uuid: p.asset,
        stored: { x: p.x, y: p.y, z: p.z },
        rotDeg: p.rot,
        levelId: p.levelId,
        layer: p.layer ?? "site",
        role: p.role,
        elementId: p.source.elementId ?? null,
        cell,
        material: cell && grid ? grid.cell(cell[0], cell[1]).material : null,
        geom: placed?.geom ?? null,
        name: placed?.name ?? null,
      });
    }
  }
  return assembleScene(
    "build",
    pieces,
    levels.map((l) => ({ id: l.id, name: l.name })),
    lookup,
    source,
  );
}

/** The scene of decoded slab assets (one paste origin), classed by catalog facts alone. */
export function sceneFromSlab(
  assets: readonly SlabAsset[],
  lookup: PieceLookup,
  source: MeshSource,
): Promise<Scene> {
  const pieces: ScenePiece[] = assets.map((a) => ({
    uuid: a.uuid,
    stored: { x: a.sx / 100, y: a.sy / 100, z: a.sz / 100 },
    rotDeg: a.rot * 15,
    levelId: "slab",
    layer: "site",
    role: null,
    elementId: null,
    cell: null,
    material: null,
    geom: null,
    name: null,
  }));
  return assembleScene("slab", pieces, [{ id: "slab", name: "Slab" }], lookup, source);
}
