/**
 * The ids of an object placed as a site (resolve/objectSite.ts), one reading for every stage: the object's own areas
 * are `<object>~<part>` (its decks, rooms, gangway), its arrangement instances `<object>`, `<object>#<n>` (one object
 * split into instances) and `<object>@<level>` (its pieces on another level). The one question the stages ask:
 * which object owns this element.
 */

/** The object an instance or a site area belongs to, or null for an element no object placed. */
export function objectOf(elementId: string | undefined): string | null {
  if (elementId === undefined || elementId === "") return null;
  const m = /^([^#@~]+)([#@~].*)?$/.exec(elementId);
  return m?.[1] ?? null;
}

/** The recipe word an object's own arrangement instances carry: `object:<recipe>` (objects/place.ts writes it). */
const OBJECT_RECIPE_PREFIX = "object:";

/** The recipe of an instance of an object's body built by `recipe`. */
export const objectBodyRecipe = (recipe: string): string => `${OBJECT_RECIPE_PREFIX}${recipe}`;

/**
 * Is an arrangement instance part of an object's own body (its hull, decks, rails, masts: whatever placeObject laid,
 * however the object was split into instances or levels), not a thing furnishing one of its rooms? Read from the mark
 * the build puts on the instance, never from its id.
 */
export const isObjectBody = (a: { readonly recipe: string }): boolean =>
  a.recipe.startsWith(OBJECT_RECIPE_PREFIX);

/** An object's own area id for one of its parts. */
export const siteAreaId = (object: string, part: string): string => `${object}~${part}`;

/** Whether an area is one an object placed (`<object>~<part>`), and which. */
export function areaObject(areaId: string | undefined): string | null {
  return areaId !== undefined && areaId.includes("~") ? objectOf(areaId) : null;
}
