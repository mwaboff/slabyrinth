/**
 * Symbols (painted by their painter, turned and scaled to their box), far-zoom dots that stand in for feature symbols,
 * and text (room badges, link badges, names and labels with a halo).
 */
import type { DisplayItem } from "@slabyrinth/core/contracts/resolved";
import { painterFor } from "../painters";
import { circlePath, polyPath, roundRectPath, withAlpha } from "../prims";
import type { DrawCtx } from "./context";

type SymbolMark = NonNullable<DisplayItem["symbol"]>;
type TextMark = NonNullable<DisplayItem["text"]>;

/** Feature symbols drawn as forest-green dots when zoomed far out (everything else is an ink dot). */
const LOD_FOREST = new Set([
  "feat-tree",
  "feat-pine_tree",
  "feat-bush",
  "feat-dead_tree",
  "feat-reeds",
  "feat-tall_grass",
  "feat-flowers",
]);
/** Below this scale (px per cell) room names are not drawn. */
const ROOM_NAME_MIN_SCALE = 16;

/** Stable small integer from a symbol position (organic variation is the same every frame). */
const seedOf = (x: number, y: number): number => Math.round(x * 16) * 7919 + Math.round(y * 16) * 104729;

export function drawSymbol(d: DrawCtx, it: DisplayItem, s: SymbolMark): void {
  const { ctx, u } = d;
  const rot = ((s.rot % 360) + 360) % 360;
  const swap = (rot > 45 && rot < 135) || (rot > 225 && rot < 315);
  const lw = (swap ? s.h : s.w) * u;
  const lh = (swap ? s.w : s.h) * u;
  ctx.save();
  ctx.translate(d.X(s.x + s.w / 2), d.Y(s.y + s.h / 2));
  if (rot !== 0) ctx.rotate((rot * Math.PI) / 180);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (it.style === "feat-gm") ctx.globalAlpha = 0.9;
  painterFor(s.id)({
    ctx,
    theme: d.theme,
    u,
    w: lw,
    h: lh,
    style: it.style,
    seed: seedOf(s.x, s.y),
    lw: d.baseLw,
    rot,
  });
  ctx.restore();
}

/**
 * Level of detail: far zoomed out, feature symbols become plain dots, batched into one path per colour. The batch is
 * drawn when anything else comes next (so paint order holds) and at the end.
 */
export class LodDots {
  private readonly batch = new Map<string, Array<[number, number, number]>>();
  constructor(private readonly d: DrawCtx) {}

  get pending(): boolean {
    return this.batch.size > 0;
  }

  add(s: SymbolMark): void {
    const { X, Y, u } = this.d;
    const token = LOD_FOREST.has(s.id) ? "forest" : "ink";
    const dots = this.batch.get(token) ?? [];
    dots.push([
      X(s.x + s.w / 2),
      Y(s.y + s.h / 2),
      Math.max(0.8, Math.min(s.w, s.h) * u * (token === "forest" ? 0.45 : 0.3)),
    ]);
    this.batch.set(token, dots);
  }

  flush(): void {
    const { ctx } = this.d;
    for (const [token, dots] of this.batch) {
      ctx.beginPath();
      for (const [x, y, r] of dots) circlePath(ctx, x, y, r);
      ctx.fillStyle = this.d.col(token);
      ctx.fill();
    }
    this.batch.clear();
  }
}

export function drawText(d: DrawCtx, st: string, t: TextMark): void {
  const x = d.X(t.x);
  const y = d.Y(t.y);
  if (st === "room-number") roomBadge(d, t.value, x, y);
  else if (st === "link-badge-up" || st === "link-badge-down")
    linkBadge(d, t.value, x, y, st === "link-badge-up");
  else if (st === "room-name") {
    if (d.u < ROOM_NAME_MIN_SCALE) return;
    textWithHalo(d, t.value, x, y, fontPx(d, "s"), d.col("ink"), 600);
  } else textWithHalo(d, t.value, x, y, fontPx(d, t.size), d.col("ink"), 600);
}

/** A room number in a filled circle. */
function roomBadge(d: DrawCtx, value: string, x: number, y: number): void {
  const { ctx, col } = d;
  const r = Math.max(8, Math.min(16, d.u * 0.42));
  ctx.beginPath();
  circlePath(ctx, x, y, r);
  ctx.fillStyle = col("label");
  ctx.fill();
  ctx.strokeStyle = col("badge-stroke");
  ctx.lineWidth = 1.5 * d.ls;
  ctx.stroke();
  const px = value.length > 2 ? r * 0.85 : r * 1.15;
  ctx.font = `700 ${Math.round(px)}px ${d.theme.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = col("badge-ink");
  ctx.fillText(value, x, y + px * 0.04);
}

/** The level a link leads to, in a rounded box with an up or down triangle. */
function linkBadge(d: DrawCtx, value: string, x: number, y: number, up: boolean): void {
  const { ctx, col } = d;
  const px = Math.max(9, Math.min(15, d.u * 0.4));
  ctx.font = `700 ${Math.round(px)}px ${d.theme.fontFamily}`;
  const tw = ctx.measureText(value).width;
  const tri = px * 0.7;
  const w = tw + tri + px * 1.0;
  const h = px * 1.55;
  ctx.beginPath();
  roundRectPath(ctx, x - w / 2, y - h / 2, w, h, px * 0.3);
  ctx.fillStyle = col("label");
  ctx.fill();
  ctx.strokeStyle = col("ink");
  ctx.lineWidth = 1.2 * d.ls;
  ctx.stroke();
  const tx = x - w / 2 + px * 0.4 + tri / 2;
  ctx.beginPath();
  polyPath(
    ctx,
    up
      ? [
          [tx - tri / 2, y + tri * 0.4],
          [tx + tri / 2, y + tri * 0.4],
          [tx, y - tri * 0.5],
        ]
      : [
          [tx - tri / 2, y - tri * 0.4],
          [tx + tri / 2, y - tri * 0.4],
          [tx, y + tri * 0.5],
        ],
  );
  ctx.fillStyle = col("ink");
  ctx.fill();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(value, tx + tri / 2 + px * 0.25, y + px * 0.04);
}

/** Font size in px for a text size at this scale (with a pixel minimum and maximum). */
function fontPx(d: DrawCtx, size: "s" | "m" | "l"): number {
  const k = size === "s" ? 0.38 : size === "m" ? 0.5 : 0.72;
  const lo = size === "s" ? 9 : size === "m" ? 11 : 14;
  return Math.max(lo, Math.min(lo * 2.4, d.u * k));
}

/** Centred text on a translucent halo, kept inside the level so it is not cut off at the map edge. */
function textWithHalo(
  d: DrawCtx,
  value: string,
  x: number,
  y: number,
  px: number,
  color: string,
  weight: number,
): void {
  const { ctx, list } = d;
  ctx.font = `${weight} ${Math.round(px)}px ${d.theme.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = ctx.measureText(value).width;
  const half = w / 2 + px * 0.3;
  const minX = d.X(list.viewBox.x) + half;
  const maxX = d.X(list.viewBox.x + list.viewBox.w) - half;
  if (minX <= maxX) x = Math.min(maxX, Math.max(minX, x));
  ctx.beginPath();
  roundRectPath(ctx, x - w / 2 - px * 0.3, y - px * 0.62, w + px * 0.6, px * 1.24, px * 0.3);
  ctx.fillStyle = d.col("label-halo");
  withAlpha(ctx, 0.82, () => {
    ctx.fill();
  });
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
}
