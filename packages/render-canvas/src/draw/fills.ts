/** Pattern fills drawn inside a clipped area: hatching (rock, ruined walls), water waves, floor textures. */
import { hash01, withAlpha } from "../prims";
import type { Box, DrawCtx } from "./context";

export type TextureKind = "planks" | "stipple" | "tufts" | "cracks";

/** Below this scale (px per cell) floors draw no texture marks. */
const TEXTURE_MIN_SCALE = 14;

/** Diagonal hatching over the box (px spacing). */
export function hatch(d: DrawCtx, b: Box, spacing: number, color: string, width: number): void {
  const { ctx } = d;
  const a = d.pxArea(b);
  ctx.beginPath();
  const start = Math.floor((a.x0 + a.y0) / spacing) * spacing;
  for (let c = start; c <= a.x1 + a.y1; c += spacing) {
    ctx.moveTo(c - a.y0, a.y0);
    ctx.lineTo(c - a.y1, a.y1);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

/** Rows of sine waves over the box, alternate rows shifted half a wave. */
export function waves(
  d: DrawCtx,
  b: Box,
  spacing: number,
  color: string,
  width: number,
  alpha: number,
): void {
  const { ctx } = d;
  const a = d.pxArea(b);
  const amp = Math.max(1, spacing * 0.18);
  const wl = Math.max(6, spacing * 1.6);
  ctx.beginPath();
  let row = 0;
  for (let y = Math.floor(a.y0 / spacing) * spacing; y <= a.y1 + spacing; y += spacing, row++) {
    const shift = (row % 2) * wl * 0.5;
    for (let x = a.x0 - wl; x <= a.x1 + wl; x += wl / 6) {
      const yy = y + Math.sin(((x + shift) / wl) * Math.PI * 2) * amp;
      if (x === a.x0 - wl) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  withAlpha(ctx, alpha, () => {
    ctx.stroke();
  });
}

/** Sparse per-cell texture marks (planks, stipple) — skipped when zoomed far out. Builds the path only. */
export function texture(d: DrawCtx, b: Box, kind: TextureKind, key: number): void {
  const { ctx, u, X, Y, clipBox } = d;
  if (u < TEXTURE_MIN_SCALE) return;
  const x0 = Math.floor(Math.max(b.x0, clipBox.x0));
  const y0 = Math.floor(Math.max(b.y0, clipBox.y0));
  const x1 = Math.ceil(Math.min(b.x1, clipBox.x1));
  const y1 = Math.ceil(Math.min(b.y1, clipBox.y1));
  ctx.beginPath();
  for (let cy = y0; cy < y1; cy++) {
    for (let cx = x0; cx < x1; cx++) {
      if (kind === "planks") {
        for (const k of [0.25, 0.5, 0.75]) {
          ctx.moveTo(X(cx), Y(cy + k));
          ctx.lineTo(X(cx + 1), Y(cy + k));
        }
        const j = 0.2 + hash01(cx, cy, key) * 0.6;
        ctx.moveTo(X(cx + j), Y(cy + 0.25));
        ctx.lineTo(X(cx + j), Y(cy + 0.5));
      } else if (kind === "stipple") {
        for (let k = 0; k < 3; k++) {
          const px = X(cx + hash01(cx, cy, key + k) * 0.9 + 0.05);
          const py = Y(cy + hash01(cy, cx, key + k + 9) * 0.9 + 0.05);
          ctx.moveTo(px + 0.9, py);
          ctx.arc(px, py, 0.9, 0, Math.PI * 2);
        }
      } else if (kind === "tufts") {
        if (hash01(cx, cy, key) > 0.45) continue;
        const px = X(cx + 0.2 + hash01(cx, cy, key + 1) * 0.6);
        const py = Y(cy + 0.3 + hash01(cx, cy, key + 2) * 0.5);
        const s = u * 0.08;
        ctx.moveTo(px - s, py);
        ctx.lineTo(px - s * 0.4, py - s * 1.4);
        ctx.moveTo(px, py);
        ctx.lineTo(px, py - s * 1.8);
        ctx.moveTo(px + s, py);
        ctx.lineTo(px + s * 0.4, py - s * 1.4);
      } else {
        if (hash01(cx, cy, key) > 0.3) continue;
        const px = X(cx + 0.2 + hash01(cx, cy, key + 1) * 0.6);
        const py = Y(cy + 0.2 + hash01(cx, cy, key + 2) * 0.6);
        ctx.moveTo(px, py);
        ctx.lineTo(px + u * 0.18, py + u * 0.08);
        ctx.lineTo(px + u * 0.26, py - u * 0.06);
      }
    }
  }
}
