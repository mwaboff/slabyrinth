/**
 * What the resolver takes a theme to default to: the floor of an area that names none (a cave's, a courtyard's), the
 * wall style that decides whether its areas are natural rock, and its interior character (tidy or rough rooms, stone
 * or timber floors, generator 4).
 *
 * The owner of these facts is the palette that supplies the theme (`Palette.defaults`, read through
 * PaletteView.themeDefaults), so a user theme states them in its palette file and no code lists theme names. From
 * generator 4 on (switch `paletteThemeDefaults`) the resolver asks the palette. The table below is two things only:
 *   - the frozen answer of generators 1-3, which resolved every theme with it (their output is frozen, so it stays as
 *     it was, including where it disagrees with the bundled palettes: forest and outdoor floors, wood_town);
 *   - for generator 4, the answer for a theme no palette supplies (a theme name with no palette file of its own), and
 *     PALETTE_GAPS below for the fields the palette format has no slot for.
 */
import type { Material, ThemeId, WallStyle } from "../contracts/plan";
import { MATERIALS, WALL_STYLES } from "../contracts/plan";
import type { ThemeInterior } from "../contracts/resolved";
import type { PaletteView } from "../palette/view";
import type { GeneratorProfile } from "../plan/generator";

export interface ThemeDefaults {
  floor: Material;
  caveFloor: Material;
  courtyardFloor: Material;
  /** Default wall style of non-cave areas (generator 2); absent = the theme's own wall (THEME_WALL_STYLE). */
  wallStyle?: WallStyle;
  /** Interior character (generator 4). */
  interior: ThemeInterior;
}

/** Old stone: the character of a theme that declares none (dungeons, caves, unknown themes). */
export const DEFAULT_INTERIOR: ThemeInterior = { finish: "rough", floorFamily: "stone" };
/** A kept-up timber or plaster building: clean walls, wood floors with tiled kitchens and wash rooms. */
const TIDY_TIMBER: ThemeInterior = { finish: "tidy", floorFamily: "timber" };

type TableRow = Omit<ThemeDefaults, "interior"> & { interior?: ThemeInterior };

const FALLBACK: TableRow = { floor: "flagstone", caveFloor: "rock", courtyardFloor: "cobble" };

/** Generators 1-3 (frozen) for every theme; generator 4 for a theme no palette supplies. */
const BUILTIN_THEME_DEFAULTS: Readonly<Record<string, TableRow>> = {
  stone_dungeon: { floor: "flagstone", caveFloor: "rock", courtyardFloor: "flagstone" },
  dungeon: { floor: "flagstone", caveFloor: "rock", courtyardFloor: "flagstone" },
  cave: { floor: "rock", caveFloor: "rock", courtyardFloor: "rock", wallStyle: "cave_rock" },
  outdoor: { floor: "wood_plank", caveFloor: "rock", courtyardFloor: "cobble" },
  forest: { floor: "wood_plank", caveFloor: "rock", courtyardFloor: "dirt" },
  town: { floor: "wood_plank", caveFloor: "rock", courtyardFloor: "cobble", interior: TIDY_TIMBER },
  city: { floor: "concrete", caveFloor: "rock", courtyardFloor: "concrete" },
  tavern: { floor: "wood_plank", caveFloor: "rock", courtyardFloor: "cobble", interior: TIDY_TIMBER },
  // the floors are the fallback's (generators 1-3 have always resolved wood_town with them; frozen)
  wood_town: FALLBACK,
  castle: { floor: "stone_tile", caveFloor: "rock", courtyardFloor: "cobble" },
  temple: { floor: "marble", caveFloor: "rock", courtyardFloor: "flagstone" },
  swamp: { floor: "wood_plank", caveFloor: "mud", courtyardFloor: "mud" },
  desert: { floor: "sand", caveFloor: "rock", courtyardFloor: "sand" },
  snow: { floor: "wood_plank", caveFloor: "ice", courtyardFloor: "snow" },
};

/**
 * Generator 4, a theme its palette supplies: the fields the palette leaves the resolver to find elsewhere, taken
 * from the theme's row above (else the fallback's). For the owner: the palette format has no courtyard floor, and no
 * bundled palette but `cave` declares a cave floor; once they do, these fields go.
 */
const PALETTE_GAPS = ["courtyardFloor", "caveFloor"] as const satisfies ReadonlyArray<keyof TableRow>;

const isMaterial = (m: string | undefined): m is Material =>
  m !== undefined && (MATERIALS as readonly string[]).includes(m);
const isWallStyle = (s: string): s is WallStyle => (WALL_STYLES as readonly string[]).includes(s);

/**
 * What the resolver takes `theme` to default to, for a plan of generator `profile`: the palette's declared defaults
 * (generator 4, `paletteThemeDefaults`; PALETTE_GAPS from the table), else the table.
 */
export function themeDefaults(
  theme: ThemeId,
  palette: PaletteView,
  profile: GeneratorProfile,
): ThemeDefaults {
  const row = BUILTIN_THEME_DEFAULTS[theme] ?? FALLBACK;
  const declared = palette.themeDefaults(theme);
  const interior = declared?.interior ?? row.interior ?? DEFAULT_INTERIOR;
  if (!profile.paletteThemeDefaults || declared === undefined) return { ...row, interior };
  const gaps = Object.fromEntries(PALETTE_GAPS.map((k) => [k, row[k]])) as Pick<
    TableRow,
    (typeof PALETTE_GAPS)[number]
  >;
  const td: ThemeDefaults = {
    ...gaps,
    // a palette's word the plan contract does not know keeps the table's (validation of palettes reports it)
    floor: isMaterial(declared.floor) ? declared.floor : row.floor,
    interior,
  };
  if (isMaterial(declared.caveFloor)) td.caveFloor = declared.caveFloor;
  if (isWallStyle(declared.wallStyle)) td.wallStyle = declared.wallStyle;
  return td;
}
