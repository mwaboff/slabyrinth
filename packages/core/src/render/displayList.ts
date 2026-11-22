/**
 * buildDisplayList (architecture §5.1): ResolvedLevel → renderer-agnostic DisplayList in cell units.
 * Geometry is traced from cell masks (outer rings clockwise, holes counter-clockwise in screen orientation, so
 * non-zero and even-odd fills agree). Walls are filled half-cell strips in the HOST cell (EdgeGrid.host), traced
 * on a half-cell grid with corner posts, so the 2D view shows exactly the usable floor the compiler builds.
 * No colours here: DisplayItem.style is a semantic token resolved by a MapTheme at draw time.
 *
 * The steps live in render/display/ (one file per kind of mark); each reads the DisplayCtx and returns its items.
 * Items are collected in step order, then stable-sorted by LAYER_ORDER, so a step's place in the list below decides
 * the paint order within a layer.
 */
import type { LevelId } from "../contracts/plan";
import type {
  DisplayContext,
  DisplayItem,
  DisplayLayer,
  DisplayList,
  DisplayOptions,
  ResolvedLevel,
  ResolvedPlan,
} from "../contracts/resolved";
import { createDisplayCtx } from "./display/context";
import { bridgeItems, cliffItems, gridItems, ledgeItems } from "./display/edges";
import { planLabelItems, roomLabelItems, waterLevelItems, zoneItems } from "./display/labels";
import { featureItems, linkItems, openingItems, stepItems } from "./display/marks";
import { roofItems } from "./display/roofs";
import { floorItems, groundItems, heightItems, waterItems } from "./display/surfaces";
import { wallItems } from "./display/walls";

/** Contract DisplayContext (links + level labels), re-exported for existing importers. */
export type { DisplayContext };

export const LAYER_ORDER: readonly DisplayLayer[] = [
  "ground",
  "floor",
  "water",
  "height_shade",
  "ledge",
  "grid",
  "wall",
  "opening",
  "link",
  "feature",
  "area_outline",
  "label",
  "selection",
];

export const DEFAULT_DISPLAY_OPTIONS: DisplayOptions = {
  grid: true,
  roomNumbers: true,
  roomNames: false,
  furniture: true,
  gmLayer: true,
  legend: false,
};

/**
 * Levels in tab order: the entry level first (else the one nearest elevation 0), then by distance in elevation from
 * it (ties: higher first, then plan order). Plan levels and resolved levels alike.
 */
export function levelTabOrder<L extends { id: LevelId; elevation: number }>(
  levels: readonly L[],
  entryLevel?: LevelId,
): L[] {
  const entry =
    levels.find((l) => l.id === entryLevel) ??
    levels.slice().sort((a, b) => Math.abs(a.elevation) - Math.abs(b.elevation))[0];
  const e0 = entry?.elevation ?? 0;
  return levels
    .map((l, i) => ({ l, i }))
    .sort((a, b) => {
      if (a.l === entry) return -1;
      if (b.l === entry) return 1;
      return (
        Math.abs(a.l.elevation - e0) - Math.abs(b.l.elevation - e0) ||
        b.l.elevation - a.l.elevation ||
        a.i - b.i
      );
    })
    .map(({ l }) => l);
}

/** "L1", "L2"… in tab order (levelTabOrder). */
export function levelLabels(
  resolved: Pick<ResolvedPlan, "levels">,
  entryLevel?: LevelId,
): Record<LevelId, string> {
  const out: Record<LevelId, string> = {};
  levelTabOrder(resolved.levels, entryLevel).forEach((l, k) => (out[l.id] = `L${k + 1}`));
  return out;
}

export function buildDisplayList(
  level: ResolvedLevel,
  opts: DisplayOptions,
  ctx: DisplayContext = {},
): DisplayList {
  const c = createDisplayCtx(level, opts, ctx);
  const items: DisplayItem[] = [
    ...groundItems(c),
    ...floorItems(c),
    ...waterItems(c),
    ...heightItems(c),
    ...ledgeItems(c),
    ...cliffItems(c),
    ...bridgeItems(c),
    ...gridItems(c),
    ...wallItems(c),
    ...openingItems(c),
    ...stepItems(c),
    ...linkItems(c),
    ...featureItems(c),
    ...roofItems(c),
    ...zoneItems(c),
    ...roomLabelItems(c),
    ...waterLevelItems(c),
    ...planLabelItems(c),
  ];
  return { levelId: level.id, viewBox: { x: c.bx, y: c.by, w: c.w, h: c.h }, items: paintOrder(items) };
}

/** Stable sort into paint order (LAYER_ORDER, then the order the steps produced). */
function paintOrder(items: readonly DisplayItem[]): DisplayItem[] {
  const rank = new Map(LAYER_ORDER.map((l, i) => [l, i]));
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (rank.get(a.it.layer) ?? 0) - (rank.get(b.it.layer) ?? 0) || a.i - b.i)
    .map((x) => x.it);
}

/**
 * Box around what is actually drawn on the level (floors, walls, openings, links, features; not the rock/void
 * ground or the grid), padded by `pad` cells and clamped to the level's viewBox. Used to fit small previews to
 * the content: a level whose rooms sit on one edge of a big level should not be a sliver in a sea of nothing.
 * Falls back to the full viewBox when nothing but ground is drawn.
 */
export function contentViewBox(list: DisplayList, pad = 1): DisplayList["viewBox"] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (ax: number, ay: number, bx2: number, by2: number): void => {
    x0 = Math.min(x0, ax);
    y0 = Math.min(y0, ay);
    x1 = Math.max(x1, bx2);
    y1 = Math.max(y1, by2);
  };
  for (const it of list.items) {
    if (it.layer === "ground" || it.layer === "grid" || it.layer === "selection") continue;
    if (it.geom) {
      for (const r of it.geom.rings)
        for (let i = 0; i + 1 < r.length; i += 2)
          add(r[i] as number, r[i + 1] as number, r[i] as number, r[i + 1] as number);
    } else if (it.symbol) {
      const s = it.symbol;
      add(s.x, s.y, s.x + s.w, s.y + s.h);
    }
  }
  const vb = list.viewBox;
  if (!Number.isFinite(x0)) return { ...vb };
  const nx0 = Math.max(vb.x, Math.floor(x0) - pad);
  const ny0 = Math.max(vb.y, Math.floor(y0) - pad);
  const nx1 = Math.min(vb.x + vb.w, Math.ceil(x1) + pad);
  const ny1 = Math.min(vb.y + vb.h, Math.ceil(y1) + pad);
  return { x: nx0, y: ny0, w: Math.max(1, nx1 - nx0), h: Math.max(1, ny1 - ny0) };
}

/** Convenience: display list of one level of a resolved plan, with links and level labels filled in. */
export function buildPlanDisplayList(
  resolved: ResolvedPlan,
  levelId: LevelId,
  opts: Partial<DisplayOptions> = {},
  entryLevel?: LevelId,
): DisplayList | null {
  const level = resolved.levels.find((l) => l.id === levelId);
  if (!level) return null;
  return buildDisplayList(
    level,
    { ...DEFAULT_DISPLAY_OPTIONS, ...opts },
    { links: resolved.links, levelLabels: levelLabels(resolved, entryLevel) },
  );
}
