/**
 * The ONE answer to "which pieces does role R have in theme T, for a plan of generator G, built with these palettes".
 *
 * Realize builds from it (compile/realize/context.ts `lookup`, which adds the diagnostics), verify judges the build by
 * it (compile/verify/context.ts) and the palette view the resolver and the design review ask goes through it
 * (palette/view.ts). Before, each built its own resolver: verify saw roles the plan's generator hides (`minGenerator`)
 * and fell back to another theme than realize for a theme with no palette, so it could judge a wall realize did not
 * build. The rules, in one place:
 *   - generator: a role introduced after the plan's generator (`minGenerator`) does not exist for it;
 *   - theme fallback: a theme with no palette of its own is asked as the default theme;
 *   - default theme: `generic` when the catalog has it, else its first palette;
 *   - generator 5 (`catalogExtension`): the palettes' own pieces only (not the released generators' run-time keyword
 *     variants, palette/auto.ts), plus, where the caller hands one over (realize and verify, never the resolver), the
 *     palette extension's pieces after a role's own (palette/extension.ts), each marked `extension`.
 * Answers are memoized for the life of the object (one build, or one palette view).
 */
import type { Palette, PaletteRole, RoleName } from "../contracts/compiler";
import type { ThemeId } from "../contracts/plan";
import { generatorProfile } from "../plan/generator";
import { minOf } from "../util/lists";
import { dict, own } from "../util/own";
import { isLegacyAutoVariant, type ExtensionPiece, type PaletteExtension } from "./extension";
import {
  GENERIC_THEME,
  resolveRole,
  usableVariants,
  type ResolveOutcome,
  type ResolvePalettes,
  type ResolvedVariant,
  type VariantFilter,
} from "./resolve";
import { floorRole } from "./roles";
import { traitPool, traitQueryKey, type TraitPool, type TraitQuery } from "./traitPools";

export interface PlanRoles {
  /** The generator whose roles are visible (`minGenerator` at most this). */
  readonly generator: number;
  /** The theme a theme with no palette is asked as. */
  readonly defaultTheme: ThemeId;
  /** Whether the catalog has a palette for the theme (else it is asked as `defaultTheme`). */
  hasPalette(theme: ThemeId): boolean;
  /** The theme the catalog is asked in for `theme`: itself when it has a palette, else `defaultTheme`. */
  paletteTheme(theme: ThemeId): ThemeId;
  /** The role in the theme (asked as `paletteTheme(theme)`), through the palette's fallback chain; memoized. */
  resolve(theme: ThemeId, role: RoleName, filter?: VariantFilter): ResolveOutcome;
  /** The theme's pieces of a shape across its roles (asked as `paletteTheme(theme)`; palette/traitPools.ts); memoized. */
  pool(theme: ThemeId, query: TraitQuery): TraitPool;
}

/** The theme a catalog asks for a theme it has no palette for: `generic` when it has one, else its first palette. */
export function defaultThemeOf(catalog: ResolvePalettes): ThemeId {
  const ids = Object.keys(catalog.palettes);
  return ids.includes(GENERIC_THEME) ? GENERIC_THEME : (ids[0] ?? GENERIC_THEME);
}

/**
 * The role answers of `catalog` for `generator`. One build makes one and hands it on (realize puts it on the realized
 * set for verify; the palette view keeps its own per catalog), so its memo lives as long as the build that asks.
 * `extension` is handed over by realize and verify only (see the rules above).
 */
export function createPlanRoles(
  catalog: ResolvePalettes,
  generator: number,
  extension?: PaletteExtension,
): PlanRoles {
  const curatedOnly = generatorProfile(generator).catalogExtension;
  if (curatedOnly) catalog = curatedOf(catalog);
  const extra =
    curatedOnly && extension !== undefined && extension.pieces.length > 0
      ? extensionIndex(extension)
      : undefined;
  const defaultTheme = defaultThemeOf(catalog);
  const hasPalette = (theme: ThemeId): boolean => own(catalog.palettes, theme) !== undefined;
  const paletteTheme = (theme: ThemeId): ThemeId => (hasPalette(theme) ? theme : defaultTheme);
  const answers = new Map<string, ResolveOutcome>();
  const pools = new Map<string, TraitPool>();
  return {
    generator,
    defaultTheme,
    hasPalette,
    paletteTheme,
    resolve(theme, role, filter) {
      const t = paletteTheme(theme);
      const k = `${t}\u0000${role}\u0000${filter?.key ?? ""}`;
      let r = answers.get(k);
      if (!r) {
        r = resolveRole(catalog, t, role, filter, generator);
        if (extra) r = withExtension(r, extra, catalog, filter);
        answers.set(k, r);
      }
      return r;
    },
    pool(theme, query) {
      const t = paletteTheme(theme);
      const k = `${t}\u0000${traitQueryKey(query)}`;
      let p = pools.get(k);
      if (!p) {
        p = traitPool(catalog, t, query, generator);
        pools.set(k, p);
      }
      return p;
    },
  };
}

const curated = new WeakMap<ResolvePalettes, ResolvePalettes>();

/** `catalog` without the released generators' run-time keyword variants (palette/extension.ts isLegacyAutoVariant). */
function curatedOf(catalog: ResolvePalettes): ResolvePalettes {
  const known = curated.get(catalog);
  if (known) return known;
  let changed = false;
  const palettes: Record<ThemeId, Palette> = dict();
  for (const [id, p] of Object.entries(catalog.palettes)) {
    let roles: Palette["roles"] | undefined;
    for (const [name, def] of Object.entries(p.roles)) {
      const vs = Array.isArray(def.variants) ? def.variants : [];
      if (!vs.some(isLegacyAutoVariant)) continue;
      roles ??= { ...p.roles };
      roles[name] = { ...def, variants: vs.filter((v) => !isLegacyAutoVariant(v)) };
    }
    palettes[id] = roles ? { ...p, roles } : p;
    changed ||= roles !== undefined;
  }
  const out = changed ? { ...catalog, palettes } : catalog;
  curated.set(catalog, out);
  return out;
}

/** Extension pieces by the palette and role they join. */
function extensionIndex(extension: PaletteExtension): Map<string, ExtensionPiece[]> {
  const idx = new Map<string, ExtensionPiece[]>();
  for (const p of extension.pieces) {
    const k = `${p.theme}\u0000${p.role}`;
    const list = idx.get(k);
    if (list) list.push(p);
    else idx.set(k, [p]);
  }
  return idx;
}

/**
 * A role answer with the extension pieces of the palette and role that supplied it appended, each only while the piece
 * it was modelled on is among the answer's variants (a user's palette that replaced the role keeps to its own pieces).
 */
function withExtension(
  out: ResolveOutcome,
  idx: ReadonlyMap<string, readonly ExtensionPiece[]>,
  catalog: ResolvePalettes,
  filter: VariantFilter | undefined,
): ResolveOutcome {
  const res = out.resolution;
  if (!res) return out;
  const wanted = new Set(res.variants.map((v) => v.wanted));
  const pieces = (idx.get(`${res.paletteId}\u0000${res.role}`) ?? []).filter(
    (p) => wanted.has(p.model) && !wanted.has(p.uuid),
  );
  if (pieces.length === 0) return out;
  const def: PaletteRole = { ...res.def, variants: pieces.map((p) => p.variant) };
  let vs: ResolvedVariant[] = usableVariants(def, res.role, catalog, []);
  if (filter) vs = vs.filter(filter.test);
  if (vs.length === 0) return out;
  const added = vs.map((v): ResolvedVariant => ({ ...v, extension: true }));
  return { ...out, resolution: { ...res, variants: [...res.variants, ...added] } };
}

/**
 * How thick the floor of `material` in `theme` is at least: the thinnest piece of its floor role (any of them may be the
 * one realize lays, compile/realize/floors.ts), undefined when the role has none (no floor piece is laid there). What a
 * piece sunk into the floor may sink into (util/sunk.ts).
 */
export function thinnestFloor(roles: PlanRoles, theme: ThemeId, material: string): number | undefined {
  const vs = roles.resolve(theme, floorRole(material)).resolution?.variants ?? [];
  return vs.length === 0 ? undefined : minOf(vs.map((v) => v.geom.size.y));
}
