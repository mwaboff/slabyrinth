/**
 * Narrow adapter between the UI and WP2's drawing code (@slabyrinth/render-canvas) and pure 2D model
 * (@slabyrinth/core/render). Everything the map view and PNG export need from WP2 goes through here.
 */
import type {
  DisplayItem,
  DisplayList,
  HitTarget,
  MapSelection,
  MapTheme,
  ResolvedLevel,
  ResolvedLink,
} from "@slabyrinth/core";
import {
  hitTest as coreHitTest,
  legendEntries,
  selectionItems,
  type LegendEntry,
} from "@slabyrinth/core/render";
import {
  drawDisplayList,
  drawLegendSwatch,
  exportPng,
  getMapTheme,
  pngLayout,
  type PngRenderOptions,
} from "@slabyrinth/render-canvas";

export type { LegendEntry };

export const PX_PER_CELL = 24;

export function mapThemeFor(appTheme: "dark" | "light"): MapTheme {
  return getMapTheme(appTheme === "light" ? "ohsheet-light" : "ohsheet-dark");
}

export const printTheme = (): MapTheme => getMapTheme("print");

export interface View {
  scale: number;
  ox: number;
  oy: number;
  w: number;
  h: number;
}

/** Pointer (canvas CSS px) → global cell coordinates (fractional). */
export function toCell(view: Pick<View, "scale" | "ox" | "oy">, px: number, py: number): [number, number] {
  return [(px - view.ox) / view.scale, (py - view.oy) / view.scale];
}

export function hitAt(
  level: ResolvedLevel,
  links: readonly ResolvedLink[],
  view: Pick<View, "scale" | "ox" | "oy">,
  px: number,
  py: number,
): HitTarget | null {
  return coreHitTest(level, toCell(view, px, py), { links });
}

export function drawLevel(ctx: CanvasRenderingContext2D, list: DisplayList, theme: MapTheme, v: View): void {
  drawDisplayList(ctx, list, theme, {
    scale: v.scale,
    offsetX: v.ox,
    offsetY: v.oy,
    viewport: { x: -v.ox / v.scale, y: -v.oy / v.scale, w: v.w / v.scale, h: v.h / v.scale },
  });
}

/**
 * The level's display list split for the map view: everything but the label layer, then the label layer alone.
 * The view draws selection, compare outlines and plan-check markers between the two, so room numbers and names
 * stay on top and readable. Same items as PNG export (where labels are already the last layer drawn).
 */
export function splitLabels(list: DisplayList): { base: DisplayList; labels: DisplayList } {
  const base: DisplayItem[] = [];
  const labels: DisplayItem[] = [];
  for (const it of list.items) (it.layer === "label" ? labels : base).push(it);
  return {
    base: { levelId: list.levelId, viewBox: list.viewBox, items: base },
    labels: { levelId: list.levelId, viewBox: list.viewBox, items: labels },
  };
}

export function overlayItems(
  level: ResolvedLevel,
  links: readonly ResolvedLink[],
  sel: Omit<MapSelection, "levelId">,
  hover: HitTarget | null,
): DisplayItem[] {
  const items = selectionItems(level, sel, "select", { links });
  if (hover?.kind === "area" && !sel.areaIds.includes(hover.id))
    items.unshift(...selectionItems(level, { areaIds: [hover.id] }, "hover", { links }));
  if (hover?.kind === "feature" && !sel.featureIds.includes(hover.id))
    items.unshift(...selectionItems(level, { featureIds: [hover.id] }, "hover", { links }));
  return items;
}

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  list: DisplayList,
  items: DisplayItem[],
  theme: MapTheme,
  v: View,
): void {
  if (items.length === 0) return;
  drawLevel(ctx, { levelId: list.levelId, viewBox: list.viewBox, items }, theme, v);
}

/** The selected room's badge becomes a solid gold disc (token sheet "Room number … Selected"). */
export function drawSelectedBadges(
  ctx: CanvasRenderingContext2D,
  list: DisplayList,
  areaIds: readonly string[],
  theme: MapTheme,
  v: View,
  fill: string,
  onAccent: string,
): void {
  if (areaIds.length === 0) return;
  for (const it of list.items) {
    if (it.style !== "room-number" || !it.text || it.ref === undefined || !areaIds.includes(it.ref)) continue;
    const x = v.ox + it.text.x * v.scale;
    const y = v.oy + it.text.y * v.scale;
    const r = Math.max(8, Math.min(16, v.scale * 0.42));
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r + 0.5, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    const px = it.text.value.length > 2 ? r * 0.85 : r * 1.15;
    ctx.font = `700 ${Math.round(px)}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = onAccent;
    ctx.fillText(it.text.value, x, y + px * 0.04);
    ctx.restore();
  }
}

export function legendFor(list: DisplayList): LegendEntry[] {
  return legendEntries(list);
}

export function drawSwatch(canvas: HTMLCanvasElement, e: LegendEntry, theme: MapTheme): void {
  const dpr = window.devicePixelRatio || 1;
  const w = 30;
  const h = 20;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  drawLegendSwatch(ctx, e, theme, { x: 0, y: 0, w, h });
}

export async function renderPng(list: DisplayList, theme: MapTheme, opts: PngRenderOptions): Promise<string> {
  const blob = await exportPng(list, theme, opts);
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export function pngSize(
  list: DisplayList,
  pxPerCell: number,
): { width: number; height: number; clamped: boolean } {
  const l = pngLayout(list, { pxPerCell, background: "theme" });
  return { width: l.width, height: l.height, clamped: l.clamped };
}
