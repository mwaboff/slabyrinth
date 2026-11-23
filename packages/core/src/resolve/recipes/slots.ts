/**
 * Filling a recipe's slot, in one order for every recipe (the plan's slot rule):
 *   1. its roles, in order: the first role whose usable pieces fit the slot's shape supplies them (a role marked `own`
 *      only from the theme's own palettes, so a theme never borrows another kit's piece by name; generator 5, a piece
 *      the facts keep to one place left out: palette/traitPools.ts `drawsFreely`, as every pool does);
 *   2. the theme's own pieces of the shape (palette/traitPools.ts with `stopAt: "theme"`), when there are `min`;
 *   3. the fallback: the pieces of the shape along the whole chain, generic included ("borrow"), an empty slot the recipe composes without
 *      ("simplify"), or nothing, so the recipe is left out at that anchor ("skip").
 * A piece keeps the palette and role it was asked under, so the realize pass looks it up by the same question.
 */
import { fromPool, fromVariant, type ArrangePiece } from "../../arrange";
import type { ThemeId } from "../../contracts/plan";
import type { PlanRoles } from "../../palette/planRoles";
import { GENERIC_THEME } from "../../palette/resolve";
import { drawsFreely } from "../../palette/traitPools";
import { fitsShape } from "../../palette/traits";
import type { FilledSlot, RecipeCtx, SlotSpec } from "./types";

/** The pieces of one slot at one anchor, or null when the slot (and so the recipe there) must be skipped. */
export function fillSlot<A>(
  roles: PlanRoles,
  theme: ThemeId,
  spec: SlotSpec<A>,
  a: A,
  trim: string,
  ctx?: RecipeCtx,
): FilledSlot | null {
  const t = roles.paletteTheme(theme);
  const shape = spec.shape?.(a, trim, ctx) ?? null;
  const min = Math.max(1, spec.min ?? 1);
  for (const r of spec.roles?.(a, trim, ctx) ?? []) {
    const res = roles.resolve(t, r.role).resolution;
    if (!res) continue;
    if (r.own === true && res.paletteId === GENERIC_THEME && t !== GENERIC_THEME) continue;
    const pieces: ArrangePiece[] = res.variants
      .filter(
        (v) =>
          v.weight > 0 &&
          v.parts === undefined &&
          (shape === null || fitsShape(v.geom, shape)) &&
          drawsFreely(roles.generator, v.name),
      )
      .map((v) => fromVariant(t, r.role, v));
    if (pieces.length > 0) return { pieces, source: "role" };
  }
  if (shape !== null) {
    const own = roles.pool(t, { ...shape, stopAt: "theme" });
    if (own.pieces.length >= min) return { pieces: own.pieces.map((p) => fromPool(own, p)), source: "theme" };
    if (spec.fallback === "borrow") {
      const any = roles.pool(t, shape);
      if (any.pieces.length >= min)
        return { pieces: any.pieces.map((p) => fromPool(any, p)), source: "borrowed" };
    }
  }
  if (spec.fallback === "simplify") return { pieces: [], source: "simplified" };
  return null;
}
