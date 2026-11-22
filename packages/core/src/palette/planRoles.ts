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
 *   - default theme: `generic` when the catalog has it, else its first palette.
 * Answers are memoized for the life of the object (one build, or one palette view).
 */
import type { RoleName } from "../contracts/compiler";
import type { ThemeId } from "../contracts/plan";
import { own } from "../util/own";
import {
  GENERIC_THEME,
  resolveRole,
  type ResolveOutcome,
  type ResolvePalettes,
  type VariantFilter,
} from "./resolve";
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
 */
export function createPlanRoles(catalog: ResolvePalettes, generator: number): PlanRoles {
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
