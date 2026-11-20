/**
 * A building's bare x, y, w, h (a shorthand models reach for) as its one wing. Used wherever a building's footprint
 * is read (validate, resolve, outline), so the shorthand behaves exactly like wings: [{x, y, w, h}].
 */
import type { Building, Structure } from "../contracts/plan";

export function withWings<S extends Structure>(st: S): S {
  if (st.kind === "enclosure") return st;
  const b: Building = st;
  if (b.wings !== undefined || b.volumes !== undefined || b.footprint !== undefined) return st;
  if (b.x === undefined || b.y === undefined || b.w === undefined || b.h === undefined) return st;
  const out: Building = { ...b, wings: [{ x: b.x, y: b.y, w: b.w, h: b.h }] };
  delete out.x;
  delete out.y;
  delete out.w;
  delete out.h;
  return out as S;
}
