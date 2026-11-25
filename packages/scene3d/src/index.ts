/**
 * @slabyrinth/scene3d public entry: the 3D scene of a build or a slab, the mesh-source port, and the software
 * renderer. Pure TypeScript (no node:*, no DOM), so the CLI, tests and the app's workers share it.
 *
 * The usual run:
 *   const lookup = pieceLookup(palettes.palettes, catalog);          // names, collider sizes, catalog facts
 *   const scene = await sceneFromBuild(resolved, placements, lookup, source);   // or sceneFromSlab(assets, …)
 *   for (const spec of [overviewShot(scene, size), ...levelShots(scene, size)])
 *     png = encodePng(renderScene(scene, spec));
 * `source` is a MeshSource: `boxMeshSource()` without an install; with one, `installMeshSource` over the install's
 * files (the host supplies the bytes and the mesh cache through `InstallFiles` and `MeshCache`).
 */
export type * from "./types/index";
export { cuboid, meshBox } from "./geom/mesh";
export { COLOUR_CLASSES, colourClass, pieceColour } from "./scene/colour";
export type { ClassInput, PieceFacts } from "./scene/colour";
export { pieceLookup } from "./scene/pieces";
export type { PieceInfo, PieceLookup } from "./scene/pieces";
export { assembleScene, sceneFromBuild, sceneFromSlab } from "./scene/build";
export type { ScenePiece } from "./scene/build";
export { boxMesh, placementOffset } from "./scene/place";
export { directionFrom, finiteBox, frameBox, viewBasis } from "./raster/camera";
export type { FrameOptions, ViewBasis } from "./raster/camera";
export { BACKGROUND, LOD_BOX_PX, renderScene, shown, shownBounds } from "./raster/raster";
export { encodePng } from "./raster/png";
export { boxMeshSource } from "./source/box";
export { EXTRACTOR_VERSION, installMeshSource, unityExtractor } from "./source/install";
export type {
  BundleExtractor,
  InstallMeshSource,
  InstallSourceOptions,
  InstallStats,
  MeshCache,
} from "./source/install";
export { MESH_FILE_VERSION, decodeMeshFile, encodeMeshFile, quantised } from "./source/meshFile";
export { indexJsonAssets, readPackIndex } from "./source/packIndex";
export type { PackAsset, PackIndex } from "./source/packIndex";
export { DecodeError, UnsupportedFormat } from "./unity/errors";
export { levelShots, overviewShot, slug, topShot } from "./shots/presets";
export type { ShotSize } from "./shots/presets";
