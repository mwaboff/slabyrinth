/**
 * drawDisplayList — THE single Canvas 2D drawing routine (architecture §5.1/§5.2) for the live map view and PNG
 * export. Works on any Canvas2DLike (on-screen, OffscreenCanvas, a recording context in tests). Coordinates in
 * the list are cells; px = offset + cell × scale. `viewport` (cell units) enables culling. All colours and fonts
 * come from the MapTheme.
 *
 * drawList walks the items in list order (the list is already in paint order) and hands each to the step for its
 * kind, in draw/: geometry.ts (one painter per layer), marks.ts (symbols, far-zoom dots, text), fills.ts (patterns),
 * context.ts (the DrawCtx every step reads).
 */
import type {
  Canvas2DLike,
  DisplayItem,
  DisplayList,
  DrawDisplayList,
  MapTheme,
} from "@slabyrinth/core/contracts/resolved";
import { type Box, createDrawCtx, type DrawView } from "./draw/context";
import { drawGeom } from "./draw/geometry";
import { drawSymbol, drawText, LodDots } from "./draw/marks";

export type { DrawView } from "./draw/context";

const bboxCache = new WeakMap<DisplayItem, Box>();

/** Symbols may overhang their box by this much (tree crowns, the "S" of secret doors), in cells. */
const SYMBOL_OVERHANG = 0.8;
/** Below this scale (px per cell) feature symbols are drawn as dots. */
const LOD_SCALE = 10;

function itemBox(it: DisplayItem): Box {
  const cached = bboxCache.get(it);
  if (cached) return cached;
  let b: Box;
  if (it.geom) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of it.geom.rings) {
      for (let i = 0; i + 1 < r.length; i += 2) {
        const x = r[i] as number;
        const y = r[i + 1] as number;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    b = { x0, y0, x1, y1 };
  } else if (it.symbol) {
    const s = it.symbol;
    const o = SYMBOL_OVERHANG;
    b = { x0: s.x - o, y0: s.y - o, x1: s.x + s.w + o, y1: s.y + s.h + o };
  } else if (it.text) {
    const t = it.text;
    const half = Math.max(1.5, t.value.length * 0.3);
    b = { x0: t.x - half, y0: t.y - 1, x1: t.x + half, y1: t.y + 1.5 };
  } else b = { x0: 0, y0: 0, x1: 0, y1: 0 };
  bboxCache.set(it, b);
  return b;
}

const intersects = (a: Box, v: { x: number; y: number; w: number; h: number }): boolean =>
  a.x0 <= v.x + v.w && a.x1 >= v.x && a.y0 <= v.y + v.h && a.y1 >= v.y;

export const drawDisplayList: DrawDisplayList = (ctx, list, theme, view) => {
  drawList(ctx, list, theme, view);
};

export function drawList(ctx: Canvas2DLike, list: DisplayList, theme: MapTheme, view: DrawView): void {
  const d = createDrawCtx(ctx, list, theme, view);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "butt";
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  const lod = d.u < LOD_SCALE;
  const dots = new LodDots(d);
  for (const it of list.items) {
    const b = itemBox(it);
    if (!intersects(b, d.vp)) continue;
    const asDot = lod && it.symbol !== undefined && it.layer === "feature";
    if (dots.pending && !asDot) dots.flush();
    if (asDot && it.symbol) dots.add(it.symbol);
    else if (it.geom) drawGeom(d, it, it.geom, b);
    else if (it.symbol) drawSymbol(d, it, it.symbol);
    else if (it.text) drawText(d, it.style, it.text);
  }
  dots.flush();
  ctx.restore();
}
