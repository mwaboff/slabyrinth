/**
 * drawDisplayList — THE single Canvas 2D drawing routine (architecture §5.1/§5.2) for the live map view and PNG
 * export. Works on any Canvas2DLike (on-screen, OffscreenCanvas, a recording context in tests). Coordinates in
 * the list are cells; px = offset + cell × scale. `viewport` (cell units) enables culling. All colours and fonts
 * come from the MapTheme.
 */
import type {
  Canvas2DLike,
  DisplayItem,
  DisplayList,
  DrawDisplayList,
  MapTheme,
} from "@slabyrinth/core/contracts/resolved";
import { painterFor } from "./painters";
import { circlePath, hash01, polyPath, roundRectPath, withAlpha } from "./prims";
import { tokenColor } from "./themes";

export interface DrawView {
  scale: number;
  offsetX: number;
  offsetY: number;
  viewport?: { x: number; y: number; w: number; h: number };
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const bboxCache = new WeakMap<DisplayItem, Box>();

const LOD_FOREST = new Set([
  "feat-tree",
  "feat-pine_tree",
  "feat-bush",
  "feat-dead_tree",
  "feat-reeds",
  "feat-tall_grass",
  "feat-flowers",
]);

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
    // symbols may overhang their box (tree crowns, the "S" of secret doors)
    b = { x0: s.x - 0.8, y0: s.y - 0.8, x1: s.x + s.w + 0.8, y1: s.y + s.h + 0.8 };
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

/** Stable small integer from a symbol position (organic variation is the same every frame). */
const seedOf = (x: number, y: number): number => Math.round(x * 16) * 7919 + Math.round(y * 16) * 104729;

export const drawDisplayList: DrawDisplayList = (ctx, list, theme, view) => {
  drawList(ctx, list, theme, view);
};

export function drawList(ctx: Canvas2DLike, list: DisplayList, theme: MapTheme, view: DrawView): void {
  const u = view.scale;
  const X = (x: number): number => view.offsetX + x * u;
  const Y = (y: number): number => view.offsetY + y * u;
  const col = (t: string): string => tokenColor(theme, t);
  const ls = theme.lineScale;
  const baseLw = Math.max(0.75, Math.min(3, u / 16)) * ls;
  const vp = view.viewport ?? list.viewBox;
  const visible: Box = { x0: vp.x, y0: vp.y, x1: vp.x + vp.w, y1: vp.y + vp.h };
  const clipBox: Box = {
    x0: Math.max(visible.x0, list.viewBox.x),
    y0: Math.max(visible.y0, list.viewBox.y),
    x1: Math.min(visible.x1, list.viewBox.x + list.viewBox.w),
    y1: Math.min(visible.y1, list.viewBox.y + list.viewBox.h),
  };

  const ringsPath = (rings: number[][], closed: boolean): void => {
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
  };
  /** Area covered by both the item and the view, in px. */
  const pxArea = (b: Box): Box => ({
    x0: X(Math.max(b.x0, clipBox.x0)),
    y0: Y(Math.max(b.y0, clipBox.y0)),
    x1: X(Math.min(b.x1, clipBox.x1)),
    y1: Y(Math.min(b.y1, clipBox.y1)),
  });

  const hatch = (b: Box, spacing: number, color: string, width: number): void => {
    const a = pxArea(b);
    ctx.beginPath();
    const start = Math.floor((a.x0 + a.y0) / spacing) * spacing;
    for (let c = start; c <= a.x1 + a.y1; c += spacing) {
      ctx.moveTo(c - a.y0, a.y0);
      ctx.lineTo(c - a.y1, a.y1);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };

  const waves = (b: Box, spacing: number, color: string, width: number, alpha: number): void => {
    const a = pxArea(b);
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
  };

  /** Sparse per-cell texture marks (planks, stipple) — skipped when zoomed far out. */
  const texture = (b: Box, kind: "planks" | "stipple" | "tufts" | "cracks", key: number): void => {
    if (u < 14) return;
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
  };

  const MAT_TEXTURE: Record<string, ["planks" | "stipple" | "tufts" | "cracks", number]> = {
    "mat-wood_plank": ["planks", 0.35],
    "mat-bridge_wood": ["planks", 0.5],
    "mat-gravel": ["stipple", 0.35],
    "mat-cobble": ["cracks", 0.35],
    "mat-sand": ["stipple", 0.22],
    "mat-dirt": ["stipple", 0.25],
    "mat-mud": ["stipple", 0.3],
    "mat-grass": ["tufts", 0.3],
    "mat-swamp": ["tufts", 0.35],
    "mat-rock": ["cracks", 0.2],
    "mat-snow": ["stipple", 0.15],
    "mat-ice": ["cracks", 0.3],
    "mat-lava": ["cracks", 0.6],
  };

  const fontPx = (size: "s" | "m" | "l"): number => {
    const k = size === "s" ? 0.38 : size === "m" ? 0.5 : 0.72;
    const lo = size === "s" ? 9 : size === "m" ? 11 : 14;
    return Math.max(lo, Math.min(lo * 2.4, u * k));
  };

  const textWithHalo = (
    value: string,
    x: number,
    y: number,
    px: number,
    color: string,
    weight: number,
  ): void => {
    ctx.font = `${weight} ${Math.round(px)}px ${theme.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(value).width;
    // keep labels inside the level so they are not cut off at the map edge
    const half = w / 2 + px * 0.3;
    const minX = X(list.viewBox.x) + half;
    const maxX = X(list.viewBox.x + list.viewBox.w) - half;
    if (minX <= maxX) x = Math.min(maxX, Math.max(minX, x));
    ctx.beginPath();
    roundRectPath(ctx, x - w / 2 - px * 0.3, y - px * 0.62, w + px * 0.6, px * 1.24, px * 0.3);
    ctx.fillStyle = col("label-halo");
    withAlpha(ctx, 0.82, () => {
      ctx.fill();
    });
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  };

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "butt";
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Level of detail: far zoomed out, features become plain dots batched into one path per colour.
  const lod = u < 10;
  const lodBatch = new Map<string, Array<[number, number, number]>>();
  const flushLod = (): void => {
    for (const [token, dots] of lodBatch) {
      ctx.beginPath();
      for (const [x, y, r] of dots) circlePath(ctx, x, y, r);
      ctx.fillStyle = col(token);
      ctx.fill();
    }
    lodBatch.clear();
  };

  for (const it of list.items) {
    const b = itemBox(it);
    if (!intersects(b, vp)) continue;
    const st = it.style;
    if (lodBatch.size > 0 && !(lod && it.symbol && it.layer === "feature")) flushLod();
    if (lod && it.symbol && it.layer === "feature") {
      const s = it.symbol;
      const token = LOD_FOREST.has(s.id) ? "forest" : "ink";
      const list2 = lodBatch.get(token) ?? [];
      list2.push([
        X(s.x + s.w / 2),
        Y(s.y + s.h / 2),
        Math.max(0.8, Math.min(s.w, s.h) * u * (token === "forest" ? 0.45 : 0.3)),
      ]);
      lodBatch.set(token, list2);
      continue;
    }

    if (it.geom) {
      const { rings, closed } = it.geom;
      switch (it.layer) {
        case "ground": {
          if (st === "ghost") {
            ringsPath(rings, true);
            ctx.setLineDash([6, 4]);
            ctx.strokeStyle = col("accent");
            ctx.lineWidth = baseLw;
            withAlpha(ctx, 0.4, () => {
              ctx.stroke();
            });
            ctx.setLineDash([]);
            break;
          }
          ringsPath(rings, true);
          // VOID cells are "nothing here" (open air around a building on an upper floor): plain background, no
          // hatch. Only a real drop (NO_FLOOR, the "chasm" floor style) gets the dark fill and a legend entry.
          ctx.fillStyle = col("paper");
          ctx.fill();
          if (st === "rock") {
            ctx.save();
            ringsPath(rings, true);
            ctx.clip();
            hatch(b, Math.max(4, u * 0.27), col("hatch"), Math.max(0.8, u / 22) * ls);
            ctx.restore();
          }
          break;
        }
        case "floor":
        case "water": {
          ringsPath(rings, true);
          if (st === "chasm" || st === "stairwell") {
            ctx.fillStyle = col(st);
            ctx.fill();
            if (st === "chasm") {
              ctx.strokeStyle = col("ink");
              ctx.lineWidth = baseLw * 1.3;
              ctx.stroke();
            }
            break;
          }
          if (it.layer === "water") {
            ctx.fillStyle = col("floor");
            ctx.fill();
            const deep = st === "water-deep";
            ctx.fillStyle = col(st);
            withAlpha(ctx, deep ? 0.55 : 0.3, () => {
              ctx.fill();
            });
            ctx.save();
            ringsPath(rings, true);
            ctx.clip();
            waves(
              b,
              Math.max(4, u * (deep ? 0.2 : 0.33)),
              col(st),
              Math.max(0.8, baseLw * 0.7),
              deep ? 0.95 : 0.8,
            );
            ctx.restore();
            break;
          }
          ctx.fillStyle = col(st);
          ctx.fill();
          const tex = MAT_TEXTURE[st];
          if (tex) {
            ctx.save();
            ringsPath(rings, true);
            ctx.clip();
            texture(b, tex[0], st.length);
            ctx.strokeStyle = col("texture");
            ctx.fillStyle = col("texture");
            ctx.lineWidth = Math.max(0.6, baseLw * 0.5);
            withAlpha(ctx, tex[1], () => {
              if (tex[0] === "stipple") ctx.fill();
              else ctx.stroke();
            });
            ctx.restore();
          }
          break;
        }
        case "height_shade": {
          const up = st.startsWith("height-up");
          const q = Number(st.slice(st.lastIndexOf("-") + 1)) || 1;
          ringsPath(rings, true);
          ctx.fillStyle = col(up ? "height-up" : "height-down");
          // graded: every quarter tile deeper is visibly darker, up to a 4-tile drop (raised floors stay subtle)
          withAlpha(ctx, up ? Math.min(0.3, 0.05 * q + 0.03) : Math.min(0.62, 0.035 * q + 0.06), () => {
            ctx.fill();
          });
          break;
        }
        case "ledge": {
          if (st === "cliff") {
            // solid ink line on the cliff top, hachures hanging toward the low side (right of each segment)
            ringsPath(rings, false);
            ctx.strokeStyle = col("ink");
            ctx.lineWidth = baseLw * 2;
            ctx.stroke();
            ctx.beginPath();
            const tick = Math.max(3, u * 0.3);
            for (const r of rings) {
              const x0 = r[0] as number;
              const y0 = r[1] as number;
              const x1 = r[2] as number;
              const y1 = r[3] as number;
              const dx = x1 - x0;
              const dy = y1 - y0;
              for (const f of [0.17, 0.5, 0.83]) {
                const px = X(x0 + dx * f);
                const py = Y(y0 + dy * f);
                ctx.moveTo(px, py);
                ctx.lineTo(px - dy * tick, py + dx * tick);
              }
            }
            ctx.lineWidth = Math.max(1, baseLw);
            ctx.stroke();
            break;
          }
          if (st === "bridge-h" || st === "bridge-v") {
            // planks across the deck, then a strong outline
            ctx.save();
            ringsPath(rings, true);
            ctx.clip();
            ctx.beginPath();
            const step = 0.5;
            if (st === "bridge-h") {
              for (let x = Math.floor(b.x0); x <= b.x1; x += step) {
                ctx.moveTo(X(x), Y(b.y0));
                ctx.lineTo(X(x), Y(b.y1));
              }
            } else {
              for (let y = Math.floor(b.y0); y <= b.y1; y += step) {
                ctx.moveTo(X(b.x0), Y(y));
                ctx.lineTo(X(b.x1), Y(y));
              }
            }
            ctx.strokeStyle = col("ink");
            ctx.lineWidth = Math.max(0.6, baseLw * 0.6);
            withAlpha(ctx, 0.45, () => {
              ctx.stroke();
            });
            ctx.restore();
            ringsPath(rings, true);
            ctx.strokeStyle = col("ink");
            ctx.lineWidth = baseLw * 1.8;
            ctx.stroke();
            break;
          }
          ringsPath(rings, false);
          ctx.setLineDash([Math.max(2, u * 0.12), Math.max(2, u * 0.08)]);
          ctx.strokeStyle = col("ledge");
          ctx.lineWidth = baseLw * 1.1;
          ctx.stroke();
          ctx.setLineDash([]);
          break;
        }
        case "grid": {
          if (u < 6) break;
          ringsPath(rings, false);
          ctx.strokeStyle = col("grid");
          ctx.lineWidth = Math.max(0.6, Math.min(1.2, u / 24)) * ls;
          ctx.stroke();
          break;
        }
        case "wall": {
          ringsPath(rings, true);
          ctx.fillStyle = col(st);
          const style = st.startsWith("wall-") ? st.slice(5) : "wall";
          const alpha = style === "low_wall" ? 0.7 : style === "ruined" ? 0.8 : 1;
          withAlpha(ctx, alpha, () => {
            ctx.fill();
          });
          if (style === "ruined") {
            ctx.save();
            ringsPath(rings, true);
            ctx.clip();
            hatch(b, Math.max(5, u * 0.35), col("paper"), Math.max(1, u * 0.06));
            ctx.restore();
          } else if (
            style === "fence" ||
            style === "palisade" ||
            style === "railing" ||
            style === "iron_bars"
          ) {
            ringsPath(rings, true);
            ctx.setLineDash([Math.max(2, u * 0.1), Math.max(2, u * 0.1)]);
            ctx.strokeStyle = col("floor");
            ctx.lineWidth = Math.max(1, u * 0.05);
            ctx.stroke();
            ctx.setLineDash([]);
          } else if (style === "hedge") {
            ringsPath(rings, true);
            ctx.strokeStyle = col("ink");
            ctx.lineWidth = baseLw * 0.6;
            withAlpha(ctx, 0.5, () => {
              ctx.stroke();
            });
          }
          break;
        }
        case "area_outline": {
          ringsPath(rings, closed);
          // building roof plans: the ridge solid in ink, the roof edge dashed in ink; zones dashed in the zone colour
          const roof = st === "roof-outline" || st === "roof-ridge";
          ctx.setLineDash(st === "roof-ridge" ? [] : [Math.max(4, u * 0.33), Math.max(3, u * 0.17)]);
          ctx.strokeStyle = col(roof ? "ink" : "zone");
          ctx.lineWidth = roof ? baseLw * 0.8 : baseLw;
          withAlpha(ctx, 0.75, () => {
            ctx.stroke();
          });
          ctx.setLineDash([]);
          break;
        }
        case "selection": {
          ringsPath(rings, true);
          const sel = st.startsWith("select");
          if (st.endsWith("-area")) {
            ctx.fillStyle = col("select");
            withAlpha(ctx, sel ? 0.16 : 0.09, () => {
              ctx.fill();
            });
          }
          if (st !== "hover-area") {
            ctx.setLineDash(st === "select-rect" || st === "select-area" ? [8, 4] : []);
            ctx.strokeStyle = col("select");
            ctx.lineWidth = 2 * ls;
            ctx.stroke();
            ctx.setLineDash([]);
          }
          break;
        }
        default: {
          ringsPath(rings, closed);
          ctx.strokeStyle = col(st);
          ctx.lineWidth = baseLw;
          ctx.stroke();
        }
      }
      continue;
    }

    if (it.symbol) {
      const s = it.symbol;
      const rot = ((s.rot % 360) + 360) % 360;
      const swap = (rot > 45 && rot < 135) || (rot > 225 && rot < 315);
      const lw = (swap ? s.h : s.w) * u;
      const lh = (swap ? s.w : s.h) * u;
      ctx.save();
      ctx.translate(X(s.x + s.w / 2), Y(s.y + s.h / 2));
      if (rot !== 0) ctx.rotate((rot * Math.PI) / 180);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      if (it.style === "feat-gm") ctx.globalAlpha = 0.9;
      painterFor(s.id)({
        ctx,
        theme,
        u,
        w: lw,
        h: lh,
        style: it.style,
        seed: seedOf(s.x, s.y),
        lw: baseLw,
        rot,
      });
      ctx.restore();
      continue;
    }

    if (it.text) {
      const t = it.text;
      const x = X(t.x);
      const y = Y(t.y);
      if (st === "room-number") {
        const r = Math.max(8, Math.min(16, u * 0.42));
        ctx.beginPath();
        circlePath(ctx, x, y, r);
        ctx.fillStyle = col("label");
        ctx.fill();
        ctx.strokeStyle = col("badge-stroke");
        ctx.lineWidth = 1.5 * ls;
        ctx.stroke();
        const px = t.value.length > 2 ? r * 0.85 : r * 1.15;
        ctx.font = `700 ${Math.round(px)}px ${theme.fontFamily}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = col("badge-ink");
        ctx.fillText(t.value, x, y + px * 0.04);
      } else if (st === "link-badge-up" || st === "link-badge-down") {
        const px = Math.max(9, Math.min(15, u * 0.4));
        ctx.font = `700 ${Math.round(px)}px ${theme.fontFamily}`;
        const tw = ctx.measureText(t.value).width;
        const tri = px * 0.7;
        const w = tw + tri + px * 1.0;
        const h = px * 1.55;
        ctx.beginPath();
        roundRectPath(ctx, x - w / 2, y - h / 2, w, h, px * 0.3);
        ctx.fillStyle = col("label");
        ctx.fill();
        ctx.strokeStyle = col("ink");
        ctx.lineWidth = 1.2 * ls;
        ctx.stroke();
        const tx = x - w / 2 + px * 0.4 + tri / 2;
        const up = st === "link-badge-up";
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
        ctx.fillText(t.value, tx + tri / 2 + px * 0.25, y + px * 0.04);
      } else if (st === "room-name") {
        if (u < 16) continue;
        textWithHalo(t.value, x, y, fontPx("s"), col("ink"), 600);
      } else {
        textWithHalo(t.value, x, y, fontPx(t.size), col("ink"), 600);
      }
    }
  }
  flushLod();
  ctx.restore();
}
