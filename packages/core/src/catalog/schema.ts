/**
 * The cached asset catalog's shape, checked where a catalog file enters typed code (the CLI's --catalog and --cached,
 * the app's catalog cache). A catalog that does not match is refused with the first thing wrong, never cast.
 */
import { z } from "zod";
import type { AssetCatalog } from "../contracts/compiler";

const xyz = z.object({ x: z.number(), y: z.number(), z: z.number() });

const CatalogAssetSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  kind: z.enum(["tile", "prop"]),
  pack: z.string(),
  packId: z.string(),
  folder: z.string(),
  groupTag: z.string(),
  tags: z.array(z.string()),
  deprecated: z.boolean(),
  interactable: z.boolean(),
  size: xyz,
  footprintCells: z.object({ x: z.number(), z: z.number() }),
  boundsCenter: xyz,
  boundsMin: xyz,
  originAt: z.enum(["minCorner", "center", "other"]),
  sizeTag: z.string().exactOptional(),
  meshParts: z.number().exactOptional(),
});

export const AssetCatalogSchema = z.object({
  schema: z.literal("slabyrinth/asset-catalog@1"),
  extractorVersion: z.number(),
  generatedAt: z.string(),
  fingerprint: z.object({
    installPath: z.string(),
    files: z.array(
      z.object({ relPath: z.string(), size: z.number(), mtimeMs: z.number(), sha256: z.string() }),
    ),
  }),
  packs: z.array(
    z.object({
      packId: z.string(),
      name: z.string(),
      source: z.enum(["binary-index", "index-json"]),
      tiles: z.number(),
      props: z.number(),
    }),
  ),
  assets: z.array(CatalogAssetSchema),
});

export type ParseCatalogResult = { ok: true; catalog: AssetCatalog } | { ok: false; message: string };

/** Checks untrusted JSON against the catalog's shape; the message names the first field that is wrong. */
export function parseAssetCatalog(input: unknown): ParseCatalogResult {
  const r = AssetCatalogSchema.safeParse(input);
  if (r.success) {
    const catalog: AssetCatalog = r.data;
    return { ok: true, catalog };
  }
  const first = r.error.issues[0];
  const where = first && first.path.length > 0 ? first.path.join(".") : "the file";
  return { ok: false, message: `not an asset catalog: ${where}: ${first?.message ?? "invalid"}` };
}
