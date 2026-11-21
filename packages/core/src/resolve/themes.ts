/**
 * Theme defaults the resolver needs to pick a floor material when an area has no `floor`.
 * These mirror `Palette.defaults` for the bundled themes; the resolver is a pure function of the plan, so the
 * table lives here (callers may pass their own lookup, e.g. built from loaded palettes, via ResolveOptions).
 *
 * Generator 4 adds the theme's interior character (`interior`): whether its rooms are kept tidy or left rough, and
 * which floors they vary within. It is data on the theme (`Palette.defaults.interior`, read through PaletteView); this
 * table mirrors it for the built-in themes, including the ones with no palette of their own (a unit test keeps the
 * mirror equal to the bundled palettes), so a user theme states its character in its palette file and no code lists
 * theme names.
 */
import type { Material, ThemeId, WallStyle } from "../contracts/plan";
import type { ThemeInterior } from "../contracts/resolved";

export interface ThemeDefaults {
  floor: Material;
  caveFloor: Material;
  courtyardFloor: Material;
  /** Default wall style of non-cave areas (generator 2); absent = "wall". */
  wallStyle?: WallStyle;
  /** Interior character (generator 4); absent = DEFAULT_INTERIOR. */
  interior?: ThemeInterior;
}

/** Old stone: the character of a theme that declares none (dungeons, caves, unknown themes). */
export const DEFAULT_INTERIOR: ThemeInterior = { finish: "rough", floorFamily: "stone" };
/** A kept-up timber or plaster building: clean walls, wood floors with tiled kitchens and wash rooms. */
const TIDY_TIMBER: ThemeInterior = { finish: "tidy", floorFamily: "timber" };

const FALLBACK: ThemeDefaults = { floor: "flagstone", caveFloor: "rock", courtyardFloor: "cobble" };

export const BUILTIN_THEME_DEFAULTS: Record<string, ThemeDefaults> = {
  stone_dungeon: { floor: "flagstone", caveFloor: "rock", courtyardFloor: "flagstone" },
  dungeon: { floor: "flagstone", caveFloor: "rock", courtyardFloor: "flagstone" },
  cave: { floor: "rock", caveFloor: "rock", courtyardFloor: "rock", wallStyle: "cave_rock" },
  outdoor: { floor: "wood_plank", caveFloor: "rock", courtyardFloor: "cobble" },
  forest: { floor: "wood_plank", caveFloor: "rock", courtyardFloor: "dirt" },
  town: { floor: "wood_plank", caveFloor: "rock", courtyardFloor: "cobble", interior: TIDY_TIMBER },
  city: { floor: "concrete", caveFloor: "rock", courtyardFloor: "concrete", interior: TIDY_TIMBER },
  tavern: { floor: "wood_plank", caveFloor: "rock", courtyardFloor: "cobble", interior: TIDY_TIMBER },
  // the floors are the fallback's (generators 1-3 have always resolved wood_town with them; frozen)
  wood_town: { ...FALLBACK, interior: TIDY_TIMBER },
  castle: { floor: "stone_tile", caveFloor: "rock", courtyardFloor: "cobble" },
  temple: { floor: "marble", caveFloor: "rock", courtyardFloor: "flagstone" },
  swamp: { floor: "wood_plank", caveFloor: "mud", courtyardFloor: "mud" },
  desert: { floor: "sand", caveFloor: "rock", courtyardFloor: "sand" },
  snow: { floor: "wood_plank", caveFloor: "ice", courtyardFloor: "snow" },
};

export function builtinThemeDefaults(theme: ThemeId): ThemeDefaults {
  return BUILTIN_THEME_DEFAULTS[theme] ?? FALLBACK;
}

/**
 * The interior character of a theme: what its palette declares (PaletteView.interior: a user theme states it in its
 * palette file), else this table's, else DEFAULT_INTERIOR.
 */
export function themeInterior(declared: ThemeInterior | undefined, td: ThemeDefaults): ThemeInterior {
  return declared ?? td.interior ?? DEFAULT_INTERIOR;
}
