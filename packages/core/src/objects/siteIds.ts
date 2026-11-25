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

/** An object's own area id for one of its parts. */
export const siteAreaId = (object: string, part: string): string => `${object}~${part}`;

/** Whether an area is one an object placed (`<object>~<part>`), and which. */
export function areaObject(areaId: string | undefined): string | null {
  return areaId !== undefined && areaId.includes("~") ? objectOf(areaId) : null;
}
