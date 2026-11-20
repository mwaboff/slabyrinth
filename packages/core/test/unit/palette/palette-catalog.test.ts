/**
 * Every asset id the bundled palettes reference exists, undeprecated, in the local TaleSpire catalog index, with
 * the geometry the palette copied. The catalog is never committed: the test looks for the app's scanned catalog
 * (SLABYRINTH_CATALOG, %APPDATA%/Slabyrinth/catalog/catalog.json, ~/.config/Slabyrinth/catalog/catalog.json) or the
 * research extract (data/talespire-assets.json) and is skipped when none is present (CI).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_PALETTES } from "../../../src/palette/bundled";
import type { Palette } from "../../../src/contracts/compiler";

interface CatAsset {
  uuid: string;
  name: string;
  folder?: string;
  tags?: string[];
  deprecated: boolean;
  size: { x: number; y: number; z: number };
  originAt: string;
}

function findCatalog(): CatAsset[] | null {
  const candidates = [
    process.env["SLABYRINTH_CATALOG"],
    process.env["APPDATA"]
      ? join(process.env["APPDATA"], "Slabyrinth", "catalog", "catalog.json")
      : undefined,
    join(homedir(), ".config", "Slabyrinth", "catalog", "catalog.json"),
    new URL("../../../../../data/talespire-assets.json", import.meta.url).pathname.replace(
      /^\/([A-Za-z]:)/,
      "$1",
    ),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const raw = JSON.parse(readFileSync(p, "utf8")) as {
      catalog?: { assets: CatAsset[] };
      assets?: CatAsset[];
    };
    const assets = raw.catalog?.assets ?? raw.assets;
    if (Array.isArray(assets) && assets.length > 0) return assets;
  }
  return null;
}

const catalog = findCatalog();

describe.skipIf(catalog === null)("bundled palettes against the local catalog index", () => {
  const byId = new Map((catalog ?? []).map((a) => [a.uuid.toLowerCase(), a]));
  const refs: Array<{ where: string; uuid: string; geom: { size: { x: number; y: number; z: number } } }> =
    [];
  for (const p of BUNDLED_PALETTES as Palette[])
    for (const [role, def] of Object.entries(p.roles))
      for (const v of def.variants) {
        refs.push({ where: `${p.id}/${role}/${v.name ?? ""}`, uuid: v.asset, geom: v.geom });
        for (const alt of v.alternates ?? [])
          refs.push({ where: `${p.id}/${role}/alt`, uuid: alt, geom: v.alternateGeom?.[alt] ?? v.geom });
      }

  it("references only assets that exist and are not deprecated", () => {
    const bad = refs
      .filter((r) => {
        const a = byId.get(r.uuid.toLowerCase());
        return !a || a.deprecated;
      })
      .map((r) => `${r.where} ${r.uuid}`);
    expect(bad).toEqual([]);
  });

  it("copies each asset's size from the catalog (footprint and pivot come from it)", () => {
    const off = refs
      .filter((r) => {
        const a = byId.get(r.uuid.toLowerCase());
        if (!a) return false;
        return (["x", "y", "z"] as const).some((k) => Math.abs(a.size[k] - r.geom.size[k]) > 0.01);
      })
      .map((r) => r.where);
    expect(off).toEqual([]);
  });

  it("never picks temporary, development or placeholder assets (a weight-0 opt-in is allowed)", () => {
    // tempWater (folder "TempWater") does not render as water in game; water is TaleSpire's board water level.
    // It stays only as the legacy water surface, until channels use bed.* roles under the board water level.
    const ALLOWED = new Set(["dc968e8a-1bb6-4940-8b77-403573cf6094", "798bcc88-cb34-49e6-8a9a-ee98c5721467"]);
    const temp = /(^|[^a-z])(temp|placeholder|dev|debug|test)([^a-z]|$)|^temp/i;
    const bad: string[] = [];
    for (const p of BUNDLED_PALETTES as Palette[])
      for (const [role, def] of Object.entries(p.roles))
        for (const v of def.variants) {
          const a = byId.get(v.asset.toLowerCase());
          if (!a || ALLOWED.has(a.uuid.toLowerCase()) || (v.weight ?? 1) === 0) continue;
          if (temp.test(a.name) || temp.test(a.folder ?? "")) bad.push(`${p.id}/${role}: ${a.name}`);
        }
    expect(bad).toEqual([]);
  });

  it("keeps a theme's tone: no white palace marble, pale limestone or tan desert rock outside roles that ask for it", () => {
    // owner round 4 (2026-11-19): a palace-marble rim used as a kerb rendered as a blinding white strip, and the
    // rock_large family (tagged grey) rendered as cream limestone beside brown rocks
    const bad: string[] = [];
    for (const p of BUNDLED_PALETTES as Palette[])
      for (const [role, def] of Object.entries(p.roles))
        for (const v of def.variants) {
          const a = byId.get(v.asset.toLowerCase());
          if (!a || (v.weight ?? 1) === 0) continue;
          const tags = (a.tags ?? []).map((t) => t.toLowerCase());
          const marble = tags.includes("marble") || tags.includes("palace") || tags.includes("ceiling");
          // building roles (roofs, facades…) choose their own materials; this guards dressing and ground
          const dressingOrGround = /^(feature|floor|fill|bed|step|cliff|kerb|ledge|trim|pier)\./.test(role);
          if (marble && dressingOrGround && !/marble/.test(role))
            bad.push(`${p.id}/${role}: ${a.name} (marble)`);
          if (/^rock_large/i.test(a.name)) bad.push(`${p.id}/${role}: ${a.name} (pale limestone)`);
          if (
            /desert/i.test(a.name) &&
            /formation|boulder|rock|cliff|stone|monolith|edge|debris|marker|landmark/.test(role)
          )
            bad.push(`${p.id}/${role}: ${a.name} (desert)`);
          if (/sewer/i.test(a.name) && /^bed./.test(role) && p.id !== "stone_dungeon")
            bad.push(`${p.id}/${role}: ${a.name} (masonry bed)`);
        }
    expect(bad).toEqual([]);
  });

  it("covers far more of the catalog than the original ~125-asset kit", () => {
    expect(new Set(refs.map((r) => r.uuid.toLowerCase())).size).toBeGreaterThan(250);
  });
});
