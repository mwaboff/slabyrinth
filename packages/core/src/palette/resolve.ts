/**
 * Role resolution with the curated fallback chain (decisions.md "Asset substitution"):
 *   1. the theme's palette, then its `extends` chain, provides the role definition;
 *   2. per variant: the preferred asset, else its `alternates` in order (availability from the scanned catalog);
 *   3. no usable variant → the role's `fallback` role (resolved again from the area's theme);
 *   4. still nothing → the same role in the `generic` palette;
 *   5. still nothing → dropped with a warning by the caller (never a hard failure).
 *
 * Bundled palettes use "alias roles" — `variants: []` with a `fallback` — to map IR vocabulary the kits lack onto
 * the nearest role (floor.marble → floor.stone_tile). The contract allows this (ruling 2026-11-18).
 */
import type {
  Palette,
  PaletteCatalog,
  PaletteFacing,
  PaletteRole,
  PaletteVariant,
  RoleName,
} from "../contracts/compiler";
import type { ThemeId } from "../contracts/plan";
import { own } from "./own";

export const GENERIC_THEME = "generic";

export interface ResolvedVariant {
  /** uuid actually used (preferred or alternate). */
  uuid: string;
  /** uuid the palette asked for. */
  wanted: string;
  substituted: boolean;
  geom: PaletteVariant["geom"];
  name: string | undefined;
  weight: number;
  variant: string | undefined;
  /** Observed tone (palette tag), when known. */
  tone?: "dark" | "mid" | "light";
  hue?: string;
  /** Footprint in cells at rot 0 (variant ?? role ?? derived from geometry). */
  footprint: readonly [number, number];
  /** Correction rotation (degrees). */
  rot: number;
  offset: { x: number; y: number; z: number };
  unitHeight: number;
  /** variant.facing ?? role.facing (calibration defaults are applied by the realizer). */
  facing: PaletteFacing | undefined;
  /** Assembly pieces placed with this asset (palette `parts`). */
  parts?: NonNullable<PaletteVariant["parts"]>;
}

export interface RoleResolution {
  requested: RoleName;
  /** Role that supplied the variants (differs from `requested` after alias/fallback). */
  role: RoleName;
  paletteId: ThemeId;
  def: PaletteRole;
  variants: ResolvedVariant[];
  /** Roles walked, for diagnostics ("floor.marble → floor.stone_tile → floor.flagstone"). */
  path: string[];
}

export interface Substitution {
  role: RoleName;
  wanted: { uuid: string; name?: string };
  used: { uuid: string; name?: string } | null;
}

export interface ResolveOutcome {
  resolution: RoleResolution | null;
  /** Availability-driven substitutions met on the way (alternates, fallback roles, drops). */
  substitutions: Substitution[];
  /** True when the requested theme had no palette and generic was used. */
  themeMissing: boolean;
}

/** Optional variant filter (e.g. walls of length 2); `key` makes the memo cache work. */
export interface VariantFilter {
  key: string;
  test: (v: ResolvedVariant) => boolean;
}

/** Palette ids from `theme` up its extends chain, ending with generic. */
export function themeChain(palettes: Record<ThemeId, Palette>, theme: ThemeId): ThemeId[] {
  const out: ThemeId[] = [];
  let cur: ThemeId | undefined = own(palettes, theme) ? theme : undefined;
  while (cur !== undefined && !out.includes(cur) && own(palettes, cur)) {
    out.push(cur);
    cur = own(palettes, cur)?.extends;
  }
  if (!out.includes(GENERIC_THEME) && own(palettes, GENERIC_THEME)) out.push(GENERIC_THEME);
  return out;
}

const round = (v: number): number => Math.max(1, Math.round(v));

/** Default rot-0 footprint from geometry: tiles round up (ceil − 0.01), props round to nearest. */
export function footprintFromGeom(g: PaletteVariant["geom"]): [number, number] {
  if (g.originAt === "minCorner")
    return [Math.max(1, Math.ceil(g.size.x - 0.01)), Math.max(1, Math.ceil(g.size.z - 0.01))];
  return [round(g.size.x), round(g.size.z)];
}

function variantGeomFor(v: PaletteVariant, uuid: string): PaletteVariant["geom"] | undefined {
  if (uuid.toLowerCase() === v.asset.toLowerCase()) return v.geom;
  const g = v.alternateGeom ?? {};
  return (
    own(g, uuid) ??
    own(g, uuid.toLowerCase()) ??
    Object.entries(g).find(([k]) => k.toLowerCase() === uuid.toLowerCase())?.[1]
  );
}

function usableVariants(
  def: PaletteRole,
  role: RoleName,
  cat: PaletteCatalog,
  subs: Substitution[],
): ResolvedVariant[] {
  const out: ResolvedVariant[] = [];
  const ok = (u: string): boolean => {
    const s = cat.availability.status(u);
    return s === null || s === "present";
  };
  for (const v of Array.isArray(def.variants) ? def.variants : []) {
    let uuid: string | null = ok(v.asset) ? v.asset : null;
    if (uuid === null) {
      for (const alt of v.alternates ?? []) {
        if (ok(alt) && variantGeomFor(v, alt)) {
          uuid = alt;
          break;
        }
      }
      const wanted: Substitution["wanted"] = { uuid: v.asset.toLowerCase() };
      if (v.name !== undefined) wanted.name = v.name;
      const usedName = uuid ? cat.availability.name(uuid) : null;
      subs.push({
        role,
        wanted,
        used: uuid
          ? usedName
            ? { uuid: uuid.toLowerCase(), name: usedName }
            : { uuid: uuid.toLowerCase() }
          : null,
      });
    }
    if (uuid === null) continue;
    const geom = variantGeomFor(v, uuid) ?? v.geom;
    const fp = v.footprint ?? def.footprint ?? footprintFromGeom(geom);
    out.push({
      uuid: uuid.toLowerCase(),
      wanted: v.asset.toLowerCase(),
      substituted: uuid.toLowerCase() !== v.asset.toLowerCase(),
      geom,
      name: v.name,
      weight: v.weight ?? 1,
      variant: v.variant,
      footprint: [fp[0], fp[1]],
      rot: v.rot ?? 0,
      offset: { x: v.offset?.x ?? 0, y: v.offset?.y ?? 0, z: v.offset?.z ?? 0 },
      unitHeight: v.stack?.unitHeight ?? def.height ?? Math.max(0.25, Math.round(geom.size.y * 4) / 4),
      facing: v.facing ?? def.facing,
      ...(v.parts && v.parts.length > 0 ? { parts: v.parts } : {}),
      ...(v.tone !== undefined ? { tone: v.tone } : {}),
      ...(v.hue !== undefined ? { hue: v.hue } : {}),
    });
  }
  return out;
}

/**
 * Resolves `role` for `theme`. Never throws. `filter` restricts the variants (a role whose variants all fail the
 * filter continues down the chain exactly like an unavailable one).
 */
export function resolveRole(
  cat: PaletteCatalog,
  theme: ThemeId,
  role: RoleName,
  filter?: VariantFilter,
): ResolveOutcome {
  const subs: Substitution[] = [];
  const themeMissing = !own(cat.palettes, theme);
  const visited = new Set<string>();
  const path: string[] = [];

  const attempt = (startTheme: ThemeId, r: RoleName, onlyGeneric: boolean): RoleResolution | null => {
    const key = `${onlyGeneric ? "G" : startTheme}|${r}`;
    if (visited.has(key)) return null;
    visited.add(key);
    path.push(r);
    const chain = onlyGeneric ? [GENERIC_THEME] : themeChain(cat.palettes, startTheme);
    const roleOf = (id: ThemeId): PaletteRole | undefined => own(own(cat.palettes, id)?.roles, r);
    const ownerId = chain.find((id) => roleOf(id) !== undefined);
    const def = ownerId !== undefined ? roleOf(ownerId) : undefined;
    if (ownerId !== undefined && def) {
      let vs = usableVariants(def, r, cat, subs);
      if (filter) vs = vs.filter(filter.test);
      if (vs.length > 0)
        return { requested: role, role: r, paletteId: ownerId, def, variants: vs, path: [...path] };
      // 3. role fallback (resolved from the area's theme again)
      if (def.fallback) {
        const viaFallback = attempt(startTheme, def.fallback, false);
        if (viaFallback) return viaFallback;
      }
      // 4. generic theme's definition of the same role
      if (ownerId !== GENERIC_THEME && !onlyGeneric) {
        const g = attempt(GENERIC_THEME, r, true);
        if (g) return g;
      }
    }
    return null;
  };

  const resolution = attempt(themeMissing ? GENERIC_THEME : theme, role, false);
  // A dropped variant followed by a successful fallback: record what was used instead.
  if (resolution) {
    for (const s of subs) {
      if (s.used === null && resolution.role !== s.role) {
        const v = resolution.variants[0];
        if (v) s.used = v.name !== undefined ? { uuid: v.uuid, name: v.name } : { uuid: v.uuid };
      }
    }
  }
  return { resolution, substitutions: subs, themeMissing };
}

/** Memoizing wrapper used by the realizer (same inputs → same outcome object). */
export function createRoleResolver(
  cat: PaletteCatalog,
): (theme: ThemeId, role: RoleName, filter?: VariantFilter) => ResolveOutcome {
  const memo = new Map<string, ResolveOutcome>();
  return (theme, role, filter) => {
    const k = `${theme}\u0000${role}\u0000${filter?.key ?? ""}`;
    let r = memo.get(k);
    if (!r) {
      r = resolveRole(cat, theme, role, filter);
      memo.set(k, r);
    }
    return r;
  };
}
