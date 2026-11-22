/**
 * What every drawing step reads: the canvas, the theme, the scale and the cell-to-pixel mapping, the base line width,
 * the box the drawing is clipped to, and the path helpers built on them. Read-only; built once per drawList call.
 */
import type { Canvas2DLike, DisplayList, MapTheme } from "@slabyrinth/core/contracts/resolved";
import { tokenColor } from "../themes";

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface DrawView {
  scale: number;
  offsetX: number;
  offsetY: number;
  viewport?: { x: number; y: number; w: number; h: number };
}

export interface DrawCtx {
  ctx: Canvas2DLike;
  theme: MapTheme;
  list: DisplayList;
  /** Pixels per cell. */
  u: number;
  /** Cell x / y to pixels. */
  X: (x: number) => number;
  Y: (y: number) => number;
  /** A theme token's colour. */
  col: (token: string) => string;
  /** The theme's line scale, and the base line width at this scale. */
  ls: number;
  baseLw: number;
  /** The view in cells (the viewport, else the whole list), and its part inside the level. */
  vp: { x: number; y: number; w: number; h: number };
  clipBox: Box;
  /** Starts a path of the rings (cell coords). */
  ringsPath: (rings: number[][], closed: boolean) => void;
  /** Area covered by both the box and the view, in px. */
  pxArea: (b: Box) => Box;
}

/** Base line width: grows with the scale between these bounds (px, before the theme's line scale). */
const MIN_BASE_LW = 0.75;
const MAX_BASE_LW = 3;
const BASE_LW_CELLS = 16;

export function createDrawCtx(
  ctx: Canvas2DLike,
  list: DisplayList,
  theme: MapTheme,
  view: DrawView,
): DrawCtx {
  const u = view.scale;
  const X = (x: number): number => view.offsetX + x * u;
  const Y = (y: number): number => view.offsetY + y * u;
  const vp = view.viewport ?? list.viewBox;
  const visible: Box = { x0: vp.x, y0: vp.y, x1: vp.x + vp.w, y1: vp.y + vp.h };
  const clipBox: Box = {
    x0: Math.max(visible.x0, list.viewBox.x),
    y0: Math.max(visible.y0, list.viewBox.y),
    x1: Math.min(visible.x1, list.viewBox.x + list.viewBox.w),
    y1: Math.min(visible.y1, list.viewBox.y + list.viewBox.h),
  };
  return {
    ctx,
    theme,
    list,
    u,
    X,
    Y,
    col: (t) => tokenColor(theme, t),
    ls: theme.lineScale,
    baseLw: Math.max(MIN_BASE_LW, Math.min(MAX_BASE_LW, u / BASE_LW_CELLS)) * theme.lineScale,
    vp,
    clipBox,
    ringsPath: (rings, closed) => {
      ctx.beginPath();
      for (const r of rings) {
        for (let i = 0; i + 1 < r.length; i += 2) {
          const x = X(r[i] as number);
          const y = Y(r[i + 1] as number);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        if (closed) ctx.closePath();
      }
    },
    pxArea: (b) => ({
      x0: X(Math.max(b.x0, clipBox.x0)),
      y0: Y(Math.max(b.y0, clipBox.y0)),
      x1: X(Math.min(b.x1, clipBox.x1)),
      y1: Y(Math.min(b.y1, clipBox.y1)),
    }),
  };
}
