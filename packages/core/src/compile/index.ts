/**
 * Compiler (WP3): realize (placements), chunk (k-d split measured by real gzip, corner alignment markers), bundle,
 * estimate, and the calibration probe. Pure TypeScript: no electron, DOM or node:* imports here.
 */
export { placementBoxes, realize } from "./realize";
export { ROLE_ORDER } from "./realize/output";
export type { RealizedSet } from "./realize/output";
export type { BundleSubstitution, RealizeOptions } from "./realize/context";
export {
  DEFAULT_FILL,
  DEFAULT_SIDE_BY_SIDE_GAP,
  MARKER_GAP_CELLS,
  chunkAndEncode,
  extentDiagnostic,
  pasteInstructions,
} from "./chunk";
export type { ChunkEncodeOptions } from "./chunk";
export { ESTIMATE_BYTES_PER_ASSET, compileResolved, createCompilePlan, estimate } from "./compile";
export type { CompileDeps, CompileOptions } from "./compile";
export { VERIFY_CODES, verifyBuild } from "./verify";
export type { VerifyOptions, VerifyResult } from "./verify";
export { placementMeta } from "./realize";
export { calibrationAssetsFrom, calibrationSlabAssets } from "./calibration";
export type { CalibrationAssets } from "./calibration";
export { DIRS, WorldFrame, placementBox, rotateDir, rotateXZ, turnQuarters } from "./geometry";

import type { RoleKeys } from "../contracts/compiler";
/** Role-name mapping used by the realizer (contract `RoleKeys`). */
export const roleKeys: RoleKeys = {
  floor: (m) => `floor.${m}`,
  wall: (s) => `wall.${s}`,
  opening: (k) => `opening.${k}`,
  link: (k) => `link.${k}`,
  feature: (t) => `feature.${t}`,
  edgeSideRotation: (side) => ({ N: 0, E: 90, S: 180, W: 270 })[side],
};
