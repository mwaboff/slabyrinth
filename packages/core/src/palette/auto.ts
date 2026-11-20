/**
 * Runtime palette enrichment from the user's scanned catalog (2026-11-19): assets a game update adds become
 * extra, low-weight variants of the roles they classify into (catalog/classify.ts), with footprint and pivot
 * from the catalog record. Curated entries stay authoritative:
 *  - only roles a theme ALREADY defines get auto variants (no new roles, no aliases filled behind the curator's back);
 *  - an auto variant must share a name word with one of that role's curated variants in that theme, so a new
 *    "Stalagmite column 05" joins the cave kit and a new "Pine 03" joins the forest, and tone stays consistent;
 *  - it must fit the feature's footprint; it gets a small weight; at most a few per role.
 * Nothing is written to disk and nothing from the catalog is bundled.
 */
import type { CatalogAsset, Palette } from "../contracts/compiler";
import type { FeatureType } from "../contracts/plan";
import { FEATURE_INFO } from "../gen/catalog";
import { autoVariantsFor, classifyAsset } from "../catalog/classify";

const nameWords = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/\(auto\)/g, "")
    .split(/[^a-z]+/)
    .filter((w) => w.length > 3 && !["prop", "large", "small", "medium"].includes(w));

/** Feature roles whose catalog footprint fits the asset (either orientation). */
export function featureRoleFits(role: string, fp: readonly [number, number]): boolean {
  if (!role.startsWith("feature.")) return false;
  const info = Object.hasOwn(FEATURE_INFO, role.slice(8))
    ? FEATURE_INFO[role.slice(8) as FeatureType]
    : undefined;
  if (!info) return false;
  const [w, h] = info.size;
  return (fp[0] <= w && fp[1] <= h) || (fp[0] <= h && fp[1] <= w);
}

/** Copies of the palettes with auto variants appended. Deterministic for a given catalog. */
export function withAutoVariants(
  palettes: Record<string, Palette>,
  assets: readonly CatalogAsset[],
  opts: { perRole?: number; weight?: number } = {},
): { palettes: Record<string, Palette>; added: number } {
  const known = new Set<string>();
  for (const p of Object.values(palettes))
    for (const r of Object.values(p.roles))
      for (const v of r.variants) {
        known.add(v.asset.toLowerCase());
        for (const a of v.alternates ?? []) known.add(a.toLowerCase());
      }
  const byUuid = new Map(assets.map((a) => [a.uuid.toLowerCase(), a]));
  const candidates = autoVariantsFor(assets, known, featureRoleFits, {
    perRole: 12,
    weight: opts.weight ?? 0.2,
  });
  const perRole = opts.perRole ?? 3;
  let added = 0;
  const out: Record<string, Palette> = {};
  for (const [id, p] of Object.entries(palettes)) {
    const roles = { ...p.roles };
    for (const [role, list] of Object.entries(candidates)) {
      const def = roles[role];
      if (!def || def.variants.length === 0) continue;
      const curatedWords = new Set(def.variants.flatMap((v) => nameWords(v.name ?? "")));
      const fits = list
        .filter((v) => {
          const a = byUuid.get(v.asset.toLowerCase());
          return (
            a !== undefined &&
            nameWords(a.name).some((w) => curatedWords.has(w)) &&
            classifyAsset(a).length > 0
          );
        })
        .slice(0, perRole);
      if (fits.length === 0) continue;
      roles[role] = {
        ...def,
        variants: [...def.variants, ...fits.map((v) => JSON.parse(JSON.stringify(v)) as typeof v)],
      };
      added += fits.length;
    }
    out[id] = { ...p, roles };
  }
  return { palettes: out, added };
}
