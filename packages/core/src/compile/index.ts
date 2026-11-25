/**
 * Compiler (WP3): realize (placements), chunk (k-d split measured by real gzip, corner alignment markers), bundle,
 * estimate, and the calibration probe. Pure TypeScript: no electron, DOM or node:* imports here.
 */
export { realize } from "./realize";
export { placedBox, placedName } from "./placed";
export { ROLE_ORDER } from "./realize/output";
export type { RealizedSet } from "./realize/output";
export type { BundleSubstitution, RealizeOptions } from "./realize/context";
export {
  ANCHOR_CLEARANCE_CELLS,
  DEFAULT_FILL,
  DEFAULT_SIDE_BY_SIDE_GAP,
  MARKER_GAP_CELLS,
  besideMapBox,
  chunkAndEncode,
  extentDiagnostic,
  pasteInstructions,
} from "./chunk";
export type { BesideMapBox, ChunkEncodeOptions } from "./chunk";
export { ESTIMATE_BYTES_PER_ASSET, compileResolved, createCompilePlan, estimate } from "./compile";
export type { CompileDeps, CompileOptions } from "./compile";
export { VERIFY_CODES, verifyBuild } from "./verify";
export type { VerifyOptions, VerifyResult } from "./verify";
export { calibrationAssetsFrom, calibrationSlabAssets } from "./calibration";
export type { CalibrationAssets } from "./calibration";
export {
  DIRS,
  WorldFrame,
  placementBox,
  rotateDir,
  rotateXZ,
  storedPosition,
  turnQuarters,
} from "./geometry";

import type { RoleKeys } from "../contracts/compiler";
import { featureRole, floorRole, linkRole, openingRole, wallRole } from "../palette/roles";
/** Role-name mapping of the contract (`RoleKeys`): the builders of the role registry the realizer uses (palette/roles.ts). */
export const roleKeys: RoleKeys = {
  floor: floorRole,
  wall: wallRole,
  opening: openingRole,
  link: linkRole,
  feature: featureRole,
  edgeSideRotation: (side) => ({ N: 0, E: 90, S: 180, W: 270 })[side],
};
