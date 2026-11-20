/**
 * Theme defaults the resolver needs to pick a floor material when an area has no `floor`.
 * These mirror `Palette.defaults` for the bundled themes; the resolver is a pure function of the plan, so the
 * table lives here (callers may pass their own lookup, e.g. built from loaded palettes, via ResolveOptions).
 */
import type { Material, ThemeId, WallStyle } from "../contracts/plan";

export interface ThemeDefaults {
  floor: Material;
  caveFloor: Material;
  courtyardFloor: Material;
  /** Default wall style of non-cave areas (generator 2); absent = "wall". */
  wallStyle?: WallStyle;
}

const FALLBACK: ThemeDefaults = { floor: "flagstone", caveFloor: "rock", courtyardFloor: "cobble" };

export const BUILTIN_THEME_DEFAULTS: Record<string, ThemeDefaults> = {
  stone_dungeon: { floor: "flagstone", caveFloor: "rock", courtyardFloor: "flagstone" },
  dungeon: { floor: "flagstone", caveFloor: "rock", courtyardFloor: "flagstone" },
  cave: { floor: "rock", caveFloor: "rock", courtyardFloor: "rock", wallStyle: "cave_rock" },
  outdoor: { floor: "wood_plank", caveFloor: "rock", courtyardFloor: "cobble" },
  forest: { floor: "wood_plank", caveFloor: "rock", courtyardFloor: "dirt" },
  town: { floor: "wood_plank", caveFloor: "rock", courtyardFloor: "cobble" },
  city: { floor: "concrete", caveFloor: "rock", courtyardFloor: "concrete" },
  tavern: { floor: "wood_plank", caveFloor: "rock", courtyardFloor: "cobble" },
  castle: { floor: "stone_tile", caveFloor: "rock", courtyardFloor: "cobble" },
  temple: { floor: "marble", caveFloor: "rock", courtyardFloor: "flagstone" },
  swamp: { floor: "wood_plank", caveFloor: "mud", courtyardFloor: "mud" },
  desert: { floor: "sand", caveFloor: "rock", courtyardFloor: "sand" },
  snow: { floor: "wood_plank", caveFloor: "ice", courtyardFloor: "snow" },
};

export function builtinThemeDefaults(theme: ThemeId): ThemeDefaults {
  return BUILTIN_THEME_DEFAULTS[theme] ?? FALLBACK;
}
