/**
 * A theme's own range for the style draw (generator 5, `themeOwnRange`): which wall materials and roof kits the theme
 * supplies itself, as its palettes answer them (not borrowed from the generic palette), so a street in one theme does
 * not look like the same street in another with only the wall tone changed.
 *
 *   own wall   a material whose wall role the theme's own palette answers; a setting-kit material (gen/wallStyles.ts
 *              settingKit: wood, plaster) is built in the theme's own wall when the theme has one (`ownWallsFirst`),
 *              so it counts as own exactly when the theme has its own wall
 *   own kits   roof kits (resolve/roofKits.ts) whose pieces the theme's own palette answers, or the generic palette's
 *              kit made for the theme (named for it: `roof.city.*` is the city's)
 *
 * What the bundled palettes give (2026-11): wood_town and city own their walls and no roof kit; city's own roof is the
 * generic palette's flat "city" kit. Neither has a pitched kit of its own (a palette request).
 */
import type { ThemeId } from "../contracts/plan";
import { THEME_WALL_STYLE, wallStyleInfo } from "../gen/wallStyles";
import { GENERIC_THEME } from "../palette/resolve";
import { roofRole, wallRole } from "../palette/roles";
import type { PaletteView } from "../palette/view";
import { ROOF_KITS } from "./roofKits";

export interface ThemeRange {
  /** Whether a wall material is built in the theme's own pieces. */
  readonly ownWall: (material: string) => boolean;
  /** The theme's own pitched kits and flat kits (palette roof.<kit>.*), in the table's order. */
  readonly pitchedKits: readonly string[];
  readonly flatKits: readonly string[];
}

export function themeRange(view: PaletteView, theme: ThemeId, ownWallsFirst: boolean): ThemeRange {
  const roles = view.roles;
  const t = roles.paletteTheme(theme);
  const own = (role: string): boolean => {
    const res = roles.resolve(t, role).resolution;
    return !!res && res.variants.length > 0 && (res.paletteId !== GENERIC_THEME || t === GENERIC_THEME);
  };
  const ownThemeWall = own(wallRole(THEME_WALL_STYLE));
  const ownWall = (m: string): boolean =>
    m === THEME_WALL_STYLE
      ? ownThemeWall
      : ownWallsFirst && wallStyleInfo(m)?.settingKit === true
        ? ownThemeWall
        : own(wallRole(m));
  const named = (kit: string): boolean => kit === t;
  const kits = Object.keys(ROOF_KITS);
  const pitchedKits = kits.filter(
    (k) => ROOF_KITS[k]?.pitched === true && (own(roofRole(k, "slope")) || named(k)),
  );
  const flatKits = kits.filter(
    (k) =>
      ROOF_KITS[k]?.pitched === false &&
      (own(roofRole(k, "flat")) || (named(k) && !!roles.resolve(t, roofRole(k, "flat")).resolution)),
  );
  return { ownWall, pitchedKits, flatKits };
}
