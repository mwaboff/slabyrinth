/**
 * What the live map draws over the display list, in MapView's draw order: compare outlines (UX §2.3), the changed-room
 * pulse, plan-check markers, rulers, and the shadow plate under the level. Pure drawing on a 2D context in CSS px.
 */
import type { MapTheme, PlanDiff, ResolvedLevel } from "@slabyrinth/core";
import type { UiIssue } from "../../shared/resolveCore";
import { cssVar } from "../app/theme";
import { colLetters } from "../lib/format";
import type { View } from "./render";

type Rings = ReadonlyArray<ReadonlyArray<readonly [number, number]>>;

/** How long the changed-room pulse runs (ms), and how long reduced motion shows a static outline instead. */
export const PULSE_MS = 900;
export const PULSE_REDUCED_MS = 2000;
/** The pulse's rise (ms), and the fade that follows it (ms), peaking at full then 0.6 alpha. */
const PULSE_RISE_MS = 300;
const PULSE_FADE_MS = 600;
/** Rulers show from this zoom up; below this scale (px per cell) they label every other cell. */
const RULER_MIN_ZOOM = 0.75;
const RULER_DENSE_SCALE = 22;

/** Starts a closed path of area outline rings (cells) in px. */
function outlinePath(ctx: CanvasRenderingContext2D, rings: Rings, view: View): void {
  ctx.beginPath();
  for (const r of rings)
    r.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(view.ox + x * view.scale, view.oy + y * view.scale);
      else ctx.lineTo(view.ox + x * view.scale, view.oy + y * view.scale);
    });
  ctx.closePath();
}

/** Compare outlines: added solid + NEW, changed dashed + Δ, removed ghosted + ✕ (from the old version's level). */
export function drawCompare(
  ctx: CanvasRenderingContext2D,
  level: ResolvedLevel,
  oldLevel: ResolvedLevel | undefined,
  diff: PlanDiff,
  theme: MapTheme,
  view: View,
): void {
  const scale = view.scale;
  const tag = (x: number, y: number, text: string, color: string): void => {
    ctx.font = `600 11px ${theme.fontFamily}`;
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y - 16, w, 16, 3);
    ctx.fill();
    ctx.fillStyle = theme.colors["label"] ?? "transparent";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 5, y - 8);
  };
  const outline = (rings: Rings, color: string, dash: number[], fill: string | null): void => {
    outlinePath(ctx, rings, view);
    if (fill !== null) {
      ctx.fillStyle = fill;
      ctx.globalAlpha = 0.22;
      ctx.fill("evenodd");
      ctx.globalAlpha = 1;
    }
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const tagAt = (a: ResolvedLevel["areas"][number], text: string, color: string): void => {
    tag(view.ox + a.bbox.x * scale + 4, view.oy + a.bbox.y * scale + 2, text, color);
  };
  const cNew = cssVar("--map-new");
  const cChg = theme.colors["accent"] ?? cNew;
  const cDel = cssVar("--map-removed");
  for (const a of level.areas) {
    if (diff.areas.added.includes(a.id)) {
      outline(a.outline, cNew, [], null);
      tagAt(a, "NEW", cNew);
    } else if (diff.areas.changed.includes(a.id)) {
      outline(a.outline, cChg, [8, 4], null);
      tagAt(a, "Δ changed", cChg);
    }
  }
  for (const a of oldLevel?.areas ?? []) {
    if (!diff.areas.removed.includes(a.id)) continue;
    outline(a.outline, cDel, [4, 4], cDel);
    tagAt(a, "✕ removed", cDel);
  }
}

/** The pulse's alpha `t` ms after it started: a quick rise and fade, or a static outline under reduced motion. */
export function pulseAlpha(t: number, reduced: boolean): number {
  if (reduced) return t < PULSE_REDUCED_MS ? 1 : 0;
  if (t >= PULSE_MS) return 0;
  return (
    Math.sin((Math.min(t, PULSE_RISE_MS) / PULSE_RISE_MS) * Math.PI) * (t < PULSE_RISE_MS ? 1 : 0) +
    (t >= PULSE_RISE_MS ? Math.max(0, 1 - (t - PULSE_RISE_MS) / PULSE_FADE_MS) * 0.6 : 0)
  );
}

/** Changed rooms outlined in the accent colour at the given alpha. */
export function drawPulse(
  ctx: CanvasRenderingContext2D,
  level: ResolvedLevel,
  ids: readonly string[],
  alpha: number,
  theme: MapTheme,
  view: View,
): void {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  for (const a of level.areas) {
    if (!ids.includes(a.id)) continue;
    outlinePath(ctx, a.outline, view);
    ctx.strokeStyle = theme.colors["accent"] ?? "transparent";
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Plan-check markers: shape + glyph, not colour alone (error = solid triangle, warning = outlined triangle, note =
 * circled i, notes only while the Issues list is open).
 */
export function drawIssueMarkers(
  ctx: CanvasRenderingContext2D,
  issues: readonly UiIssue[],
  levelId: string,
  issuesOpen: boolean,
  theme: MapTheme,
  view: View,
): void {
  const scale = view.scale;
  for (const is of issues) {
    if (is.levelId !== levelId || !is.cell) continue;
    if (is.severity === "info" && !issuesOpen) continue;
    const x = view.ox + (is.cell[0] + 0.5) * scale;
    const y = view.oy + (is.cell[1] + 0.5) * scale;
    const r = Math.max(7, Math.min(11, scale * 0.38));
    const col = cssVar(
      is.severity === "error" ? "--danger-fill" : is.severity === "warning" ? "--warning" : "--info",
    );
    ctx.save();
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (is.severity === "info") ctx.arc(x, y, r * 0.9, 0, Math.PI * 2);
    else {
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 1.05, y + r * 0.8);
      ctx.lineTo(x - r * 1.05, y + r * 0.8);
      ctx.closePath();
    }
    ctx.fillStyle = is.severity === "error" ? col : cssVar("--surface");
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.stroke();
    ctx.font = `700 ${Math.round(r * 1.1)}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = is.severity === "error" ? cssVar("--surface") : col;
    ctx.fillText(is.severity === "info" ? "i" : "!", x, y + (is.severity === "info" ? 0 : r * 0.12));
    ctx.restore();
  }
}

/** Rulers (zoom ≥ 75%): column letters and row numbers along the level's top and left edges. */
export function drawRulers(
  ctx: CanvasRenderingContext2D,
  level: ResolvedLevel,
  zoom: number,
  theme: MapTheme,
  view: View,
): void {
  if (zoom < RULER_MIN_ZOOM) return;
  const scale = view.scale;
  const b = level.bounds;
  ctx.save();
  ctx.font = `500 10px ${theme.fontFamily}`;
  ctx.fillStyle = cssVar("--muted");
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const every = scale < RULER_DENSE_SCALE ? 2 : 1;
  for (let i = 0; i < b.w; i += every)
    ctx.fillText(colLetters(i), view.ox + (b.x + i + 0.5) * scale, view.oy + b.y * scale - 4);
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let j = 0; j < b.h; j += every)
    ctx.fillText(String(j + 1), view.ox + b.x * scale - 5, view.oy + (b.y + j + 0.5) * scale);
  ctx.restore();
}

/** The shadow plate (a DOM element under the canvas) placed over the level's bounds. */
export function placeShadowPlate(sh: HTMLElement, level: ResolvedLevel, view: View): void {
  const b = level.bounds;
  sh.style.transform = `translate(${view.ox + b.x * view.scale}px, ${view.oy + b.y * view.scale}px)`;
  sh.style.width = `${b.w * view.scale}px`;
  sh.style.height = `${b.h * view.scale}px`;
}
