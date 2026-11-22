/** How verify's messages name cells, numbers and the elements behind placements. */
import type { Solid } from "./grid";

export const fmt = (c: readonly [number, number]): string => `(${c[0]},${c[1]})`;
export const round2 = (v: number): number => Math.round(v * 100) / 100;
export const round4 = (v: number): number => Math.round(v * 10000) / 10000;

export function uniq<T>(a: T[]): T[] {
  return [...new Set(a)];
}

/**
 * Is this placement source id a plan element the user can name? Realize's own pieces carry dotted ids (a part of an
 * element, "area.floor") or "fill".
 */
export function isPlanElement(id: string | undefined): id is string {
  return !!id && !id.includes(".") && id !== "fill";
}

/** The plan elements among the ids, in order, each once. */
export function planElements(ids: ReadonlyArray<string | undefined>): string[] {
  return uniq(ids.filter(isPlanElement));
}

/** `elementId` of a diagnostic about this placement source: only plan elements (not a corner post's "post:" id). */
export function elementRef(id: string | undefined): { elementId?: string } {
  return isPlanElement(id) && !id.startsWith("post:") ? { elementId: id } : {};
}

/** A placed piece in a message: its asset name, and the plan element it belongs to. */
export function solidLabel(s: Solid): string {
  const id = s.p.source.elementId;
  return `"${s.name}"${isPlanElement(id) ? ` (${id})` : ""}`;
}
