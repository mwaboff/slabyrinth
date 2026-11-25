/**
 * Asset catalog (WP3): CatalogSource readers (binary index primary, index.json fallback), Steam/VDF install
 * discovery over an injected read-only fs, fingerprinting, catalog diff and AssetAvailability.
 * Pure TypeScript: no electron, DOM or node:* imports here.
 */
export {
  INDEX_KNOWN_SCHEMA,
  INDEX_KNOWN_VERSION,
  INDEX_MAGIC,
  IndexFormatError,
  binaryIndexSource,
  binaryIndexToCatalog,
  readBinaryIndex,
  readBinaryIndexParts,
} from "./binaryIndex";
export type { BinaryIndexAsset, BinaryIndexResult, IndexPart, IndexPartsResult } from "./binaryIndex";
export { IndexJsonError, indexJsonSource, readIndexJson } from "./indexJson";
export { deriveCatalogAsset, geomOf, lengthAxisOf, round4 } from "./derive";
export type { RawCatalogRecord } from "./derive";
export { VdfError, parseAppManifest, parseLibraryFolders, parseVdf, vdfGet } from "./vdf";
export type { AppManifest, SteamLibrary, VdfObject, VdfValue } from "./vdf";
export {
  STEAM_LAUNCH_URL,
  TALESPIRE_APP_ID,
  joinPath,
  listPackDirs,
  locateTaleSpire,
  protonUserDataPath,
  steamRootCandidates,
} from "./discovery";
export type {
  HostPlatform,
  LocateResult,
  PackDir,
  ReadonlyFs,
  SteamRootHints,
  TaleSpireInstall,
} from "./discovery";
export {
  CATALOG_SCHEMA,
  EXTRACTOR_VERSION,
  buildCatalogFromFiles,
  buildCatalogFromInstall,
  changedFiles,
  planFingerprint,
} from "./build";
export type {
  BuildCatalogOptions,
  BuildCatalogResult,
  FileStat,
  FingerprintPlan,
  PackBuildInfo,
} from "./build";
export { diffCatalogs, geometryChanged } from "./diff";
export { AssetCatalogSchema, parseAssetCatalog } from "./schema";
export type { ParseCatalogResult } from "./schema";
export { NULL_AVAILABILITY, createAvailability, isNullAvailability } from "./availability";
export {
  ROLE_RULES,
  autoVariantsFor,
  classifyAsset,
  footprintOf,
  searchCatalog,
  sizeClass,
  variantFromCatalog,
} from "./classify";
export type { CatalogHit, CatalogQuery, Classification, RoleRule, SizeClass } from "./classify";

import type { CatalogSource } from "../contracts/compiler";
import { binaryIndexSource } from "./binaryIndex";
import { indexJsonSource } from "./indexJson";
/** Sources in preference order. */
export const CATALOG_SOURCES: readonly CatalogSource[] = [binaryIndexSource, indexJsonSource];
