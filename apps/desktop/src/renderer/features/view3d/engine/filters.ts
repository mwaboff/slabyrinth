/**
 * What the viewer leaves out to show inside a map, as switches over scene data only (levels, colour classes, the roof
 * paste layer, a height), never lists of pieces: per-level visibility, "cut at level N" (levels above hidden), roofs
 * hidden (the roof layer and the roof class), hidden classes, a cut height, and a fade of what stands between the
 * camera and its target. The vertex shader reads the same masks as `pieceHidden`, so picking and the far summary
 * boxes agree with what is drawn.
 */
import type { ColourClass } from "@slabyrinth/scene3d";
import type { Chunk, SceneStore } from "./store";

export interface ViewFilters {
  /** Levels switched off, by level index. */
  hiddenLevels: ReadonlySet<number>;
  /** Show levels up to and including this index only (null: all). */
  cutLevel: number | null;
  /** Hide the roof paste layer and roof-class pieces. */
  hideRoofs: boolean;
  hiddenClasses: ReadonlySet<ColourClass>;
  /** Hide everything above this world height (null: none). */
  cutHeight: number | null;
  /** See through what stands between the camera and its target. */
  fade: boolean;
}

export const defaultFilters = (): ViewFilters => ({
  hiddenLevels: new Set(),
  cutLevel: null,
  hideRoofs: false,
  hiddenClasses: new Set(),
  cutHeight: null,
  fade: false,
});

/** The filters as the masks the shader and the planner read. */
export interface FilterMasks {
  /** Bit i: header class i hidden. */
  classMask: number;
  hideRoofs: boolean;
  /** 1 per shown level. */
  levelShown: Uint8Array;
  /** Infinity for none. */
  cutHeight: number;
}

export function filterMasks(store: SceneStore, f: ViewFilters, out?: FilterMasks): FilterMasks {
  const h = store.header;
  let classMask = 0;
  h.classes.forEach((c, i) => {
    if (i < 16 && (f.hiddenClasses.has(c.id as ColourClass) || (f.hideRoofs && c.id === "roof")))
      classMask |= 1 << i;
  });
  const levelShown =
    out?.levelShown.length === h.levels.length ? out.levelShown : new Uint8Array(h.levels.length);
  for (let i = 0; i < h.levels.length; i++)
    levelShown[i] = f.hiddenLevels.has(i) || (f.cutLevel !== null && i > f.cutLevel) ? 0 : 1;
  const m = out ?? { classMask: 0, hideRoofs: false, levelShown, cutHeight: Infinity };
  m.classMask = classMask >>> 0;
  m.hideRoofs = f.hideRoofs;
  m.levelShown = levelShown;
  m.cutHeight = f.cutHeight ?? Infinity;
  return m;
}

/** The per-piece flag word: class (bits 0-3), roof layer (8), water (9). */
export function pieceFlags(store: SceneStore, c: Chunk, k: number): number {
  const d = c.data;
  if (!d) return 0;
  const cls = d.colourClass[k] ?? 0;
  const roof = c.roofLayer >= 0 && d.layer[k] === c.roofLayer ? 1 : 0;
  const water = store.waterClass >= 0 && cls === store.waterClass ? 1 : 0;
  return (cls & 15) | (roof << 8) | (water << 9);
}

/** Is a flag word hidden by the masks (the vertex shader's test)? */
export function flagsHidden(flags: number, m: FilterMasks): boolean {
  if ((m.classMask >>> (flags & 15)) & 1) return true;
  return m.hideRoofs && ((flags >> 8) & 1) === 1;
}

/** Is piece k of a loaded chunk hidden (level, class, roof, or wholly above the cut height)? */
export function pieceHidden(store: SceneStore, c: Chunk, k: number, m: FilterMasks): boolean {
  const d = c.data;
  if (!d || !c.aabb) return true;
  if (m.levelShown[d.level[k] ?? 0] !== 1) return true;
  if ((c.aabb[k * 6 + 1] ?? 0) > m.cutHeight) return true;
  return flagsHidden(pieceFlags(store, c, k), m);
}
