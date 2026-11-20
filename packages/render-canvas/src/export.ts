/**
 * PNG export (architecture §5.5, UX §6.10): draws a display list into an OffscreenCanvas at an arbitrary scale with
 * the same drawDisplayList used on screen. The grid / room numbers / names / GM-layer toggles are DisplayOptions,
 * applied when the caller builds the list (core buildDisplayList); this helper adds size clamping, background,
 * an optional room-key side panel and an optional legend strip.
 */
import type { Canvas2DLike, DisplayList, MapTheme } from "@slabyrinth/core/contracts/resolved";
import { legendEntries, type LegendEntry } from "@slabyrinth/core/render";
import { drawList } from "./draw";
import { painterFor } from "./painters";
import { roundRectPath } from "./prims";
import { tokenColor } from "./themes";

export const MAX_PNG_SIDE = 16384;

export interface PngRenderOptions {
  /** Pixels per square (UX default 70). Reduced so no side exceeds 16384 px. */
  pxPerCell: number;
  background: "theme" | "transparent";
  /** Margin around the level in cells (default 0.5). */
  margin?: number;
  /** Room key side panel: entries in display order. */
  keyPanel?: Array<{ key: string; name: string }> | null;
  /** Legend strip under the map. */
  legend?: boolean;
  /** Title line above the room key. */
  title?: string;
}

export interface PngLayout {
  pxPerCell: number;
  width: number;
  height: number;
  mapWidth: number;
  mapHeight: number;
  panelWidth: number;
  legendHeight: number;
  clamped: boolean;
}

/** Room-key panel geometry: entries flow into as many columns as the map height needs (never truncated). */
export function keyPanelGeometry(
  px: number,
  mapHeight: number,
  opts: Pick<PngRenderOptions, "keyPanel" | "title">,
): { fs: number; top: number; rowH: number; rows: number; cols: number; colW: number; width: number } {
  const n = opts.keyPanel?.length ?? 0;
  const fs = Math.max(13, px * 0.3);
  const rowH = fs * 1.6;
  const top = fs * 1.6 + (opts.title ? fs * 2 : 0);
  const rows = Math.max(1, Math.floor((mapHeight - fs - top) / rowH) + 1);
  const cols = n > 0 ? Math.ceil(n / rows) : 0;
  const colW = Math.round(Math.max(260, px * 5));
  return { fs, top, rowH, rows, cols, colW, width: cols * colW };
}

export function pngLayout(list: DisplayList, opts: PngRenderOptions): PngLayout {
  const margin = opts.margin ?? 0.5;
  const cellsW = list.viewBox.w + 2 * margin;
  const cellsH = list.viewBox.h + 2 * margin;
  let px = Math.max(1, opts.pxPerCell);
  const panelFor = (p: number): number => keyPanelGeometry(p, Math.round(cellsH * p), opts).width;
  const legendFor = (p: number, w: number): number => {
    if (!opts.legend) return 0;
    const n = legendEntries(list).length;
    const perRow = Math.max(1, Math.floor(w / Math.max(160, p * 3.2)));
    return Math.ceil(n / perRow) * Math.max(28, p * 0.6) + Math.max(16, p * 0.3);
  };
  let clamped = false;
  for (let guard = 0; guard < 64; guard++) {
    const mw = Math.round(cellsW * px);
    const mh = Math.round(cellsH * px);
    const width = mw + panelFor(px);
    const height = mh + legendFor(px, mw);
    if (width <= MAX_PNG_SIDE && height <= MAX_PNG_SIDE) {
      return {
        pxPerCell: px,
        width,
        height,
        mapWidth: mw,
        mapHeight: mh,
        panelWidth: panelFor(px),
        legendHeight: legendFor(px, mw),
        clamped,
      };
    }
    clamped = true;
    px = Math.floor(px * Math.min(MAX_PNG_SIDE / width, MAX_PNG_SIDE / height) * 0.995 * 100) / 100;
  }
  return {
    pxPerCell: px,
    width: 1,
    height: 1,
    mapWidth: 1,
    mapHeight: 1,
    panelWidth: 0,
    legendHeight: 0,
    clamped: true,
  };
}

/** Draws the full export image (map + optional key panel + legend) into any Canvas2DLike of size pngLayout(). */
export function drawExport(
  ctx: Canvas2DLike,
  list: DisplayList,
  theme: MapTheme,
  opts: PngRenderOptions,
  layout = pngLayout(list, opts),
): void {
  const margin = opts.margin ?? 0.5;
  const col = (t: string): string => tokenColor(theme, t);
  const px = layout.pxPerCell;
  if (opts.background === "theme") {
    ctx.fillStyle = col("paper");
    ctx.fillRect(0, 0, layout.width, layout.height);
  }
  drawList(ctx, list, theme, {
    scale: px,
    offsetX: (margin - list.viewBox.x) * px,
    offsetY: (margin - list.viewBox.y) * px,
  });
  if (layout.panelWidth > 0 && opts.keyPanel) {
    const x0 = layout.mapWidth;
    ctx.fillStyle = col("label");
    ctx.fillRect(x0, 0, layout.panelWidth, layout.mapHeight);
    ctx.fillStyle = col("ink");
    ctx.fillRect(x0, 0, Math.max(1, px * 0.03), layout.mapHeight);
    const kg = keyPanelGeometry(px, layout.mapHeight, opts);
    const fs = kg.fs;
    const y = fs * 1.6;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    if (opts.title) {
      ctx.font = `700 ${Math.round(fs * 1.25)}px ${theme.fontFamily}`;
      ctx.fillText(opts.title, x0 + fs, y);
    }
    ctx.font = `600 ${Math.round(fs)}px ${theme.fontFamily}`;
    opts.keyPanel.forEach((e, k) => {
      const cx = x0 + Math.floor(k / kg.rows) * kg.colW;
      const cy = kg.top + (k % kg.rows) * kg.rowH;
      ctx.fillStyle = col("badge-ink");
      ctx.fillText(e.key, cx + fs, cy);
      ctx.fillStyle = col("ink");
      ctx.fillText(e.name, cx + fs * 3, cy);
    });
  }
  if (layout.legendHeight > 0) {
    const entries = legendEntries(list);
    const cellW = Math.max(160, px * 3.2);
    const rowH = Math.max(28, px * 0.6);
    const perRow = Math.max(1, Math.floor(layout.mapWidth / cellW));
    const top = layout.mapHeight + Math.max(8, px * 0.15);
    ctx.fillStyle = col("label");
    ctx.fillRect(0, layout.mapHeight, layout.width, layout.legendHeight);
    entries.forEach((e, i) => {
      const x = (i % perRow) * cellW + rowH * 0.4;
      const y = top + Math.floor(i / perRow) * rowH;
      drawLegendSwatch(ctx, e, theme, { x, y, w: rowH * 1.3, h: rowH * 0.9 });
      ctx.font = `500 ${Math.round(rowH * 0.45)}px ${theme.fontFamily}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = col("ink");
      ctx.fillText(e.label, x + rowH * 1.5, y + rowH * 0.45);
    });
  }
}

/** One legend swatch drawn by the real painters (UX §6.3: 32×24 px swatches). */
export function drawLegendSwatch(
  ctx: Canvas2DLike,
  e: LegendEntry,
  theme: MapTheme,
  box: { x: number; y: number; w: number; h: number },
): void {
  const col = (t: string): string => tokenColor(theme, t);
  ctx.save();
  ctx.beginPath();
  roundRectPath(ctx, box.x, box.y, box.w, box.h, 3);
  ctx.fillStyle = col("floor");
  ctx.fill();
  ctx.clip();
  const u = box.h;
  if (e.kind === "symbol") {
    const isLink = e.id.startsWith("link-");
    const isDoor = e.id.startsWith("door-");
    ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
    const w = isDoor ? box.w * 0.8 : isLink ? box.h * 0.8 : box.h;
    const h = isDoor ? u * 0.5 : box.h;
    if (isDoor) {
      ctx.fillStyle = col("wall");
      ctx.fillRect(-box.w / 2, -h / 2, box.w, h);
    }
    painterFor(e.id)({
      ctx,
      theme,
      u,
      w,
      h,
      style: isLink ? "link-up" : "feat",
      seed: 7,
      lw: Math.max(1, u / 16) * theme.lineScale,
      rot: 0,
    });
  } else {
    const color =
      e.id === "rock"
        ? col("paper")
        : e.id === "wall"
          ? col("wall")
          : e.id === "chasm"
            ? col("chasm")
            : e.id.startsWith("water")
              ? col(e.id)
              : col("floor");
    ctx.fillStyle = color;
    ctx.globalAlpha = e.id === "water-shallow" ? 0.35 : e.id === "water-deep" ? 0.6 : 1;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.globalAlpha = 1;
    if (e.id === "rock") {
      ctx.beginPath();
      for (let c = box.x - box.h; c < box.x + box.w; c += 5) {
        ctx.moveTo(c, box.y + box.h);
        ctx.lineTo(c + box.h, box.y);
      }
      ctx.strokeStyle = col("hatch");
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (e.id === "ledge" || e.id === "zone-outline") {
      ctx.beginPath();
      ctx.moveTo(box.x + 3, box.y + box.h / 2);
      ctx.lineTo(box.x + box.w - 3, box.y + box.h / 2);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = col(e.id === "ledge" ? "ledge" : "zone");
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (e.id === "cliff") {
      const y = box.y + box.h * 0.35;
      ctx.beginPath();
      ctx.moveTo(box.x + 3, y);
      ctx.lineTo(box.x + box.w - 3, y);
      ctx.strokeStyle = col("ink");
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      for (let x = box.x + 6; x < box.x + box.w - 3; x += 6) {
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + box.h * 0.4);
      }
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (e.id === "bridge") {
      ctx.beginPath();
      for (let x = box.x + 4; x < box.x + box.w - 2; x += 4) {
        ctx.moveTo(x, box.y + 4);
        ctx.lineTo(x, box.y + box.h - 4);
      }
      ctx.strokeStyle = col("ink");
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.beginPath();
      ctx.rect(box.x + 2, box.y + 4, box.w - 4, box.h - 8);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Renders into a new OffscreenCanvas (browser / Electron renderer / worker). */
export function renderToOffscreen(
  list: DisplayList,
  theme: MapTheme,
  opts: PngRenderOptions,
): { canvas: OffscreenCanvas; layout: PngLayout } {
  const layout = pngLayout(list, opts);
  const canvas = new OffscreenCanvas(layout.width, layout.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
  drawExport(ctx, list, theme, opts, layout);
  return { canvas, layout };
}

/** PNG bytes of one level's display list. */
export async function exportPng(list: DisplayList, theme: MapTheme, opts: PngRenderOptions): Promise<Blob> {
  const { canvas } = renderToOffscreen(list, theme, opts);
  return canvas.convertToBlob({ type: "image/png" });
}
