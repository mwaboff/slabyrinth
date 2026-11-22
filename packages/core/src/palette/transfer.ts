/**
 * The palettes a plan is resolved against, as plain data: for a process that resolves plans but never builds them
 * (the app's 2D preview), so it resolves against the same palettes as the build without receiving the game's whole
 * asset catalog.
 *
 * The data keeps exactly what role resolution reads (palette/resolve.ts): the merged palettes, and the game status
 * and name of every asset they name (preferred and alternates). `resolvePalettesFromData` therefore gives the same
 * role resolutions, and so the same resolved plans, as the catalog the data was taken from.
 */
import type { AssetAvailability } from "../contracts/compiler";
import { canonicalJson } from "../util/canonical";
import { h64hex } from "../util/hash";
import { dict, own } from "../util/own";
import type { ResolvePalettes } from "./resolve";

type AssetStatus = ReturnType<AssetAvailability["status"]>;

export interface ResolvePalettesData {
  /** Content hash of the data: equal keys, equal palettes (a cache key for resolved plans). */
  key: string;
  palettes: ResolvePalettes["palettes"];
  /** By lower-case uuid: every asset a palette names, with its game status and name (null: no catalog says). */
  assets: Record<string, { status: AssetStatus; name: string | null }>;
}

/** The data of `palettes`; structured-clone and JSON safe. */
export function resolvePalettesData(palettes: ResolvePalettes): ResolvePalettesData {
  const assets: ResolvePalettesData["assets"] = dict();
  const add = (uuid: string): void => {
    const u = uuid.toLowerCase();
    if (!Object.hasOwn(assets, u))
      assets[u] = { status: palettes.availability.status(u), name: palettes.availability.name(u) };
  };
  for (const palette of Object.values(palettes.palettes))
    for (const role of Object.values(palette.roles))
      for (const v of Array.isArray(role.variants) ? role.variants : []) {
        add(v.asset);
        for (const alt of v.alternates ?? []) add(alt);
      }
  const key = h64hex(canonicalJson({ palettes: palettes.palettes, assets }));
  return { key, palettes: palettes.palettes, assets };
}

/** Palettes to resolve against from their data (the inverse of `resolvePalettesData` for role resolution). */
export function resolvePalettesFromData(data: ResolvePalettesData): ResolvePalettes {
  const asset = (uuid: string) => own(data.assets, uuid.toLowerCase());
  return {
    palettes: data.palettes,
    availability: {
      status: (uuid) => asset(uuid)?.status ?? null,
      name: (uuid) => asset(uuid)?.name ?? null,
    },
  };
}
