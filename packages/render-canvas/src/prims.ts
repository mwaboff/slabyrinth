/** Small path helpers over the structural Canvas2DLike interface (no DOM-only APIs, so recording contexts work). */
import type { Canvas2DLike } from "@slabyrinth/core/contracts/resolved";

export const TAU = Math.PI * 2;

export function circlePath(ctx: Canvas2DLike, x: number, y: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, TAU);
}

export function roundRectPath(
  ctx: Canvas2DLike,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr === 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
  ctx.lineTo(x + rr, y + h);
  ctx.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + rr);
  ctx.arc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

export function polyPath(
  ctx: Canvas2DLike,
  pts: ReadonlyArray<readonly [number, number]>,
  close = true,
): void {
  pts.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  if (close) ctx.closePath();
}

export function line(ctx: Canvas2DLike, x0: number, y0: number, x1: number, y1: number): void {
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
}

/** Star / spiky polygon centred at (x, y). */
export function starPoints(
  x: number,
  y: number,
  rOuter: number,
  rInner: number,
  spikes: number,
  phase = -Math.PI / 2,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = phase + (i * Math.PI) / spikes;
    pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
  }
  return pts;
}

/** Deterministic 0..1 value from integers (organic variation per symbol position). */
export function hash01(a: number, b: number, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function withAlpha(ctx: Canvas2DLike, alpha: number, fn: () => void): void {
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  fn();
  ctx.globalAlpha = prev;
}
