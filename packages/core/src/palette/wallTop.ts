/**
 * What the top of a wall is made of: the roles a flat piece laid flush on a wall is resolved from (generator 4: the cap
 * that closes the one-cell gap between two tidy rooms, compile/realize/solidShell.ts).
 *
 * The cap belongs to the wall, not to a room beside it. It follows the wall as the palette builds it: the wall's own
 * role is resolved first (with its aliases and fallbacks, so a style the theme lacks caps like the wall that stands in
 * for it), and the style of the role that supplied the pieces names the material through the wall-style table
 * (gen/wallStyles.ts `surface`). The theme's own wall ("wall") is made of what the palette that supplies it is made
 * of: that palette's default floor. The floor role of that material is then resolved like any floor, with its own
 * fallback chain; `cap.solid` is the last resort.
 */
import type { Palette, RoleName } from "../contracts/compiler";
import type { Material, ThemeId } from "../contracts/plan";
import { wallStyleInfo } from "../gen/wallStyles";
import { own } from "./own";
import type { RoleResolution } from "./resolve";

/** The material of a wall's top, or undefined when neither the wall nor its palette names one. */
export function wallTopMaterial(
  palettes: Record<ThemeId, Palette>,
  style: string,
  wall: RoleResolution | null,
): Material | undefined {
  const built = wall?.role.startsWith("wall.") === true ? wall.role.slice("wall.".length) : undefined;
  const info = wallStyleInfo(built) ?? wallStyleInfo(style);
  if (!info) return undefined;
  if (info.surface !== null) return info.surface;
  return wall ? own(palettes, wall.paletteId)?.defaults.floor : undefined;
}

/** The roles a wall's top is resolved from, in order: the floor of its material, then the solid cap. */
export function wallTopRoles(
  palettes: Record<ThemeId, Palette>,
  style: string,
  wall: RoleResolution | null,
): RoleName[] {
  const material = wallTopMaterial(palettes, style, wall);
  return material === undefined ? ["cap.solid"] : [`floor.${material}`, "cap.solid"];
}
