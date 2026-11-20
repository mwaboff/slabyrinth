/**
 * Symbol painters for the UX §6.2 cartographic vocabulary. Each painter draws in a local frame centred on the
 * symbol, unrotated (the caller translates and rotates), with every colour taken from the theme. Every symbol has
 * a non-colour cue (shape, letter, dots, treads…) so nothing relies on colour alone.
 */
import type { Canvas2DLike, MapTheme } from "@slabyrinth/core/contracts/resolved";
import type { FeatureType } from "@slabyrinth/core/contracts/plan";
import { FEATURE_INFO, glyphType } from "@slabyrinth/core/gen";
import { TAU, circlePath, hash01, line, polyPath, roundRectPath, starPoints, withAlpha } from "./prims";
import { tokenColor } from "./themes";

export interface PaintArgs {
  ctx: Canvas2DLike;
  theme: MapTheme;
  /** Pixels per cell. */
  u: number;
  /** Local (unrotated) footprint in px. */
  w: number;
  h: number;
  /** DisplayItem.style (e.g. "link-up"/"link-down", "feat-gm"). */
  style: string;
  /** Stable per-symbol number for organic variation. */
  seed: number;
  /** Base stroke width in px (already includes theme.lineScale). */
  lw: number;
  /** Rotation applied by the caller, degrees (painters that draw text counter-rotate). */
  rot: number;
}

export type Painter = (p: PaintArgs) => void;

const c = (p: PaintArgs, token: string): string => tokenColor(p.theme, token);

function fillStroke(p: PaintArgs, fill: string | null, stroke: string | null, lw = p.lw): void {
  const { ctx } = p;
  if (fill !== null) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke !== null) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
}

function font(p: PaintArgs, px: number, weight = 700): string {
  return `${weight} ${Math.max(6, Math.round(px))}px ${p.theme.fontFamily}`;
}

/** Text drawn upright regardless of the symbol's rotation, centred at local (x, y). */
function uprightText(p: PaintArgs, text: string, x: number, y: number, px: number, color: string): void {
  const { ctx } = p;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((-p.rot * Math.PI) / 180);
  ctx.font = font(p, px);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

// ───────────────────────────── furniture & architecture ─────────────────────────────

const box =
  (
    inset: number,
    radius: number,
    extra?: (p: PaintArgs, x: number, y: number, w: number, h: number) => void,
  ): Painter =>
  (p) => {
    const { ctx, u } = p;
    const x = -p.w / 2 + inset * u;
    const y = -p.h / 2 + inset * u;
    const w = p.w - 2 * inset * u;
    const h = p.h - 2 * inset * u;
    ctx.beginPath();
    roundRectPath(ctx, x, y, w, h, radius * u);
    fillStroke(p, c(p, "floor"), c(p, "ink"));
    if (extra) {
      ctx.beginPath();
      extra(p, x, y, w, h);
      ctx.strokeStyle = c(p, "ink");
      ctx.lineWidth = p.lw * 0.8;
      ctx.stroke();
    }
  };

const pillar: Painter = (p) => {
  p.ctx.beginPath();
  circlePath(p.ctx, 0, 0, Math.min(p.w, p.h) * 0.35);
  fillStroke(p, c(p, "ink"), null);
};

const statue: Painter = (p) => {
  const r = Math.min(p.w, p.h) * 0.4;
  p.ctx.beginPath();
  circlePath(p.ctx, 0, 0, r);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
  p.ctx.beginPath();
  polyPath(p.ctx, starPoints(0, 0, r * 0.72, r * 0.3, 5));
  fillStroke(p, c(p, "ink"), null);
};

const roundTable: Painter = (p) => {
  p.ctx.beginPath();
  circlePath(p.ctx, 0, 0, Math.min(p.w, p.h) * 0.4);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
};

const chair: Painter = (p) => {
  const { ctx, u } = p;
  const s = Math.min(p.w, p.h) * 0.42;
  ctx.beginPath();
  roundRectPath(ctx, -s / 2, -s / 2 + 0.04 * u, s, s, 0.05 * u);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
  ctx.beginPath();
  line(ctx, -s / 2, -s / 2, s / 2, -s / 2);
  ctx.strokeStyle = c(p, "ink");
  ctx.lineWidth = p.lw * 2;
  ctx.stroke();
};

const throne: Painter = (p) => {
  const { ctx, u } = p;
  const s = Math.min(p.w, p.h) * 0.66;
  ctx.beginPath();
  roundRectPath(ctx, -s / 2, -s / 2 + 0.06 * u, s, s * 0.85, 0.06 * u);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
  ctx.beginPath();
  roundRectPath(ctx, -s / 2, -s / 2 - 0.04 * u, s, s * 0.24, 0.04 * u);
  fillStroke(p, c(p, "ink"), null);
};

const stool: Painter = (p) => {
  p.ctx.beginPath();
  circlePath(p.ctx, 0, 0, Math.min(p.w, p.h) * 0.2);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
};

const bed =
  (lines: number): Painter =>
  (p) => {
    const { ctx, u } = p;
    const x = -p.w / 2 + 0.1 * u;
    const y = -p.h / 2 + 0.08 * u;
    const w = p.w - 0.2 * u;
    const h = p.h - 0.16 * u;
    ctx.beginPath();
    roundRectPath(ctx, x, y, w, h, 0.06 * u);
    fillStroke(p, c(p, "floor"), c(p, "ink"));
    ctx.beginPath();
    roundRectPath(ctx, x + 0.12 * u, y + 0.08 * u, w - 0.24 * u, 0.22 * u, 0.05 * u);
    for (let k = 0; k < lines; k++) line(ctx, x, y + (0.42 + k * 0.14) * u, x + w, y + (0.42 + k * 0.14) * u);
    ctx.strokeStyle = c(p, "ink");
    ctx.lineWidth = p.lw * 0.8;
    ctx.stroke();
  };

const chest: Painter = (p) => {
  const { ctx } = p;
  const w = Math.min(p.w, p.h) * 0.72;
  const h = Math.min(p.w, p.h) * 0.5;
  ctx.beginPath();
  ctx.rect(-w / 2, -h / 2, w, h);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
  ctx.beginPath();
  line(ctx, -w / 2, -h / 2 + h * 0.36, w / 2, -h / 2 + h * 0.36);
  ctx.stroke();
  ctx.beginPath();
  circlePath(ctx, 0, -h / 2 + h * 0.36, Math.max(1, h * 0.09));
  fillStroke(p, c(p, "ink"), null);
};

const altar: Painter = (p) => {
  const { ctx, u } = p;
  ctx.beginPath();
  ctx.rect(-p.w / 2 + 0.1 * u, -p.h / 2 + 0.12 * u, p.w - 0.2 * u, p.h - 0.24 * u);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
  ctx.beginPath();
  ctx.rect(-p.w / 2 + 0.2 * u, -p.h / 2 + 0.22 * u, p.w - 0.4 * u, p.h - 0.44 * u);
  fillStroke(p, null, c(p, "ink"), p.lw * 0.8);
};

const coffin =
  (centreLine: boolean, cross: boolean): Painter =>
  (p) => {
    const { ctx } = p;
    const w = p.w * 0.72;
    const h = p.h * 0.86;
    const pts: Array<[number, number]> = [
      [-w * 0.32, -h / 2],
      [w * 0.32, -h / 2],
      [w / 2, -h * 0.22],
      [w * 0.3, h / 2],
      [-w * 0.3, h / 2],
      [-w / 2, -h * 0.22],
    ];
    ctx.beginPath();
    polyPath(ctx, pts);
    fillStroke(p, c(p, "floor"), c(p, "ink"));
    ctx.beginPath();
    if (centreLine) line(ctx, 0, -h * 0.36, 0, h * 0.4);
    if (cross) {
      line(ctx, 0, -h * 0.3, 0, h * 0.1);
      line(ctx, -w * 0.18, -h * 0.15, w * 0.18, -h * 0.15);
    }
    ctx.lineWidth = p.lw * 0.8;
    ctx.stroke();
  };

const grave: Painter = (p) => {
  const { ctx } = p;
  const w = p.w * 0.6;
  ctx.beginPath();
  roundRectPath(ctx, -w / 2, -p.h * 0.42, w, p.h * 0.22, w * 0.3);
  fillStroke(p, c(p, "stone"), c(p, "ink"));
  ctx.beginPath();
  roundRectPath(ctx, -w * 0.45, -p.h * 0.16, w * 0.9, p.h * 0.56, w * 0.4);
  fillStroke(p, null, c(p, "ink"), p.lw * 0.8);
};

const light =
  (core: number, rays: number, ring: boolean): Painter =>
  (p) => {
    const { ctx } = p;
    const s = Math.min(p.w, p.h);
    const r = s * core;
    ctx.beginPath();
    for (let i = 0; i < rays; i++) {
      const a = (i * TAU) / rays - Math.PI / 2;
      line(
        ctx,
        Math.cos(a) * r * 1.35,
        Math.sin(a) * r * 1.35,
        Math.cos(a) * s * 0.44,
        Math.sin(a) * s * 0.44,
      );
    }
    ctx.strokeStyle = c(p, "fire");
    ctx.lineWidth = p.lw;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.beginPath();
    circlePath(ctx, 0, 0, r);
    fillStroke(p, c(p, "fire"), c(p, "ink"), p.lw * 0.8);
    if (ring) {
      ctx.beginPath();
      circlePath(ctx, 0, 0, s * 0.3);
      fillStroke(p, null, c(p, "ink"), p.lw * 0.7);
    }
  };

const campfire: Painter = (p) => {
  const { ctx } = p;
  const s = Math.min(p.w, p.h);
  ctx.beginPath();
  for (let i = 0; i < 7; i++) {
    const a = (i * TAU) / 7;
    circlePath(ctx, Math.cos(a) * s * 0.3, Math.sin(a) * s * 0.3, s * 0.065);
  }
  fillStroke(p, c(p, "stone"), c(p, "ink"), p.lw * 0.6);
  light(0.13, 6, false)(p);
};

const torchWall: Painter = (p) => {
  const { ctx } = p;
  const s = Math.min(p.w, p.h);
  const y = -p.h / 2 + s * 0.16;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = Math.PI * (0.1 + (0.8 * i) / 4);
    line(
      ctx,
      Math.cos(a) * s * 0.14,
      y + Math.sin(a) * s * 0.14,
      Math.cos(a) * s * 0.34,
      y + Math.sin(a) * s * 0.34,
    );
  }
  ctx.strokeStyle = c(p, "fire");
  ctx.lineWidth = p.lw;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.beginPath();
  circlePath(ctx, 0, y, s * 0.1);
  fillStroke(p, c(p, "fire"), c(p, "ink"), p.lw * 0.8);
};

const barrel: Painter = (p) => {
  const { ctx } = p;
  const r = Math.min(p.w, p.h) * 0.36;
  ctx.beginPath();
  circlePath(ctx, 0, 0, r);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
  ctx.beginPath();
  circlePath(ctx, 0, 0, r * 0.62);
  fillStroke(p, null, c(p, "ink"), p.lw * 0.8);
};

const crate: Painter = (p) => {
  const { ctx } = p;
  const s = Math.min(p.w, p.h) * 0.66;
  ctx.beginPath();
  ctx.rect(-s / 2, -s / 2, s, s);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
  ctx.beginPath();
  line(ctx, -s / 2, -s / 2, s / 2, s / 2);
  line(ctx, s / 2, -s / 2, -s / 2, s / 2);
  fillStroke(p, null, c(p, "ink"), p.lw * 0.8);
};

const sack: Painter = (p) => {
  const { ctx } = p;
  const s = Math.min(p.w, p.h);
  ctx.beginPath();
  roundRectPath(ctx, -s * 0.27, -s * 0.2, s * 0.54, s * 0.5, s * 0.22);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
  ctx.beginPath();
  line(ctx, -s * 0.1, -s * 0.28, s * 0.1, -s * 0.28);
  fillStroke(p, null, c(p, "ink"), p.lw * 1.3);
};

const shelf =
  (diag: boolean): Painter =>
  (p) => {
    const { ctx, u } = p;
    const depth = Math.min(p.h, 0.38 * u);
    const y = -p.h / 2 + 0.04 * u;
    const x = -p.w / 2 + 0.06 * u;
    const w = p.w - 0.12 * u;
    ctx.beginPath();
    ctx.rect(x, y, w, depth);
    fillStroke(p, c(p, "floor"), c(p, "ink"));
    ctx.beginPath();
    const n = Math.max(2, Math.round(w / (0.18 * u)));
    for (let i = 1; i < n; i++) {
      const tx = x + (w * i) / n;
      if (diag) line(ctx, tx - depth * 0.3, y + depth, tx + depth * 0.3, y);
      else line(ctx, tx, y, tx, y + depth);
    }
    fillStroke(p, null, c(p, "ink"), p.lw * 0.7);
  };

const armorStand: Painter = (p) => {
  const { ctx } = p;
  const s = Math.min(p.w, p.h);
  ctx.beginPath();
  circlePath(ctx, 0, 0, s * 0.3);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
  ctx.beginPath();
  line(ctx, -s * 0.3, 0, s * 0.3, 0);
  line(ctx, 0, -s * 0.3, 0, s * 0.3);
  fillStroke(p, null, c(p, "ink"), p.lw * 0.8);
};

const wardrobe = box(0.08, 0.03, (p, x, y, w, h) => {
  line(p.ctx, x + w / 2, y, x + w / 2, y + h);
});

const dots =
  (count: number, radius: number, polygons: boolean): Painter =>
  (p) => {
    const { ctx } = p;
    const s = Math.min(p.w, p.h);
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const dx = (hash01(p.seed, i, 1) - 0.5) * s * 0.7;
      const dy = (hash01(p.seed, i, 2) - 0.5) * s * 0.7;
      const r = s * radius * (0.6 + hash01(p.seed, i, 3) * 0.8);
      if (polygons && i % 2 === 0) {
        polyPath(ctx, [
          [dx - r * 1.4, dy - r * 0.4],
          [dx + r * 0.2, dy - r * 1.3],
          [dx + r * 1.4, dy + r * 0.3],
          [dx - r * 0.3, dy + r * 1.2],
        ]);
      } else circlePath(ctx, dx, dy, r);
    }
    fillStroke(p, c(p, "ink"), null);
  };

const bones: Painter = (p) => {
  dots(4, 0.05, false)(p);
  const { ctx } = p;
  const s = Math.min(p.w, p.h);
  ctx.beginPath();
  line(ctx, -s * 0.22, -s * 0.12, s * 0.2, s * 0.14);
  line(ctx, -s * 0.18, s * 0.16, s * 0.16, -s * 0.18);
  ctx.lineCap = "round";
  fillStroke(p, null, c(p, "ink"), p.lw * 1.1);
};

const web: Painter = (p) => {
  const { ctx } = p;
  const s = Math.min(p.w, p.h) * 0.46;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * TAU) / 8;
    line(ctx, 0, 0, Math.cos(a) * s, Math.sin(a) * s);
  }
  for (const k of [0.35, 0.7]) {
    for (let i = 0; i <= 8; i++) {
      const a = (i * TAU) / 8;
      if (i === 0) ctx.moveTo(Math.cos(a) * s * k, Math.sin(a) * s * k);
      else ctx.lineTo(Math.cos(a) * s * k, Math.sin(a) * s * k);
    }
  }
  withAlpha(ctx, 0.7, () => {
    fillStroke(p, null, c(p, "ink"), p.lw * 0.6);
  });
};

const trap: Painter = (p) => {
  const { ctx } = p;
  const s = Math.min(p.w, p.h) * 0.8;
  ctx.beginPath();
  polyPath(ctx, [
    [0, -s * 0.48],
    [s * 0.5, s * 0.38],
    [-s * 0.5, s * 0.38],
  ]);
  fillStroke(p, c(p, "floor"), c(p, "trap"), p.lw * 1.2);
  uprightText(p, "T", 0, s * 0.08, s * 0.5, c(p, "trap"));
};

const lever: Painter = (p) => {
  const { ctx } = p;
  const s = Math.min(p.w, p.h);
  ctx.beginPath();
  ctx.rect(-s * 0.16, s * 0.05, s * 0.32, s * 0.16);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
  ctx.beginPath();
  line(ctx, 0, s * 0.1, s * 0.2, -s * 0.25);
  fillStroke(p, null, c(p, "ink"), p.lw * 1.2);
  ctx.beginPath();
  circlePath(ctx, s * 0.2, -s * 0.25, s * 0.06);
  fillStroke(p, c(p, "ink"), null);
};

const rug: Painter = (p) => {
  const { ctx, u } = p;
  const x = -p.w / 2 + 0.12 * u;
  const y = -p.h / 2 + 0.12 * u;
  const w = p.w - 0.24 * u;
  const h = p.h - 0.24 * u;
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  withAlpha(ctx, 0.18, () => {
    fillStroke(p, c(p, "accent"), null);
  });
  fillStroke(p, null, c(p, "ink"), p.lw * 0.8);
  ctx.beginPath();
  ctx.rect(x + 0.1 * u, y + 0.1 * u, w - 0.2 * u, h - 0.2 * u);
  ctx.setLineDash([0.08 * u, 0.06 * u]);
  fillStroke(p, null, c(p, "ink"), p.lw * 0.6);
  ctx.setLineDash([]);
};

const cage: Painter = (p) => {
  const { ctx } = p;
  const s = Math.min(p.w, p.h) * 0.74;
  ctx.beginPath();
  ctx.rect(-s / 2, -s / 2, s, s);
  fillStroke(p, null, c(p, "ink"));
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    line(ctx, -s / 2 + (s * i) / 4, -s / 2, -s / 2 + (s * i) / 4, s / 2);
    line(ctx, -s / 2, -s / 2 + (s * i) / 4, s / 2, -s / 2 + (s * i) / 4);
  }
  fillStroke(p, null, c(p, "ink"), p.lw * 0.6);
};

const stocks: Painter = (p) => {
  const { ctx } = p;
  const w = p.w * 0.8;
  const h = p.h * 0.3;
  ctx.beginPath();
  ctx.rect(-w / 2, -h / 2, w, h);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
  ctx.beginPath();
  for (const k of [-0.3, 0, 0.3]) circlePath(ctx, k * w, 0, h * 0.25);
  fillStroke(p, c(p, "ink"), null);
};

const cauldron: Painter = (p) => {
  const { ctx } = p;
  const r = Math.min(p.w, p.h) * 0.34;
  ctx.beginPath();
  circlePath(ctx, 0, 0, r);
  fillStroke(p, c(p, "ink"), null);
  ctx.beginPath();
  circlePath(ctx, 0, 0, r * 0.66);
  fillStroke(p, c(p, "floor"), null);
};

const anvil: Painter = (p) => {
  const { ctx } = p;
  const s = Math.min(p.w, p.h);
  ctx.beginPath();
  polyPath(ctx, [
    [-s * 0.38, -s * 0.12],
    [s * 0.22, -s * 0.12],
    [s * 0.4, -s * 0.02],
    [s * 0.22, s * 0.08],
    [s * 0.12, s * 0.08],
    [s * 0.16, s * 0.22],
    [-s * 0.2, s * 0.22],
    [-s * 0.16, s * 0.08],
    [-s * 0.38, s * 0.08],
  ]);
  fillStroke(p, c(p, "ink"), null);
};

const forge: Painter = (p) => {
  box(0.1, 0.04)(p);
  const { ctx } = p;
  const s = Math.min(p.w, p.h);
  ctx.beginPath();
  circlePath(ctx, 0, 0, s * 0.2);
  fillStroke(p, c(p, "fire"), c(p, "ink"), p.lw * 0.8);
};

const water =
  (ringToken: string): Painter =>
  (p) => {
    const { ctx } = p;
    const r = Math.min(p.w, p.h) * 0.42;
    ctx.beginPath();
    circlePath(ctx, 0, 0, r);
    fillStroke(p, c(p, ringToken), c(p, "ink"));
    ctx.beginPath();
    circlePath(ctx, 0, 0, r * 0.74);
    fillStroke(p, c(p, "floor"), null);
    ctx.beginPath();
    circlePath(ctx, 0, 0, r * 0.74);
    withAlpha(ctx, 0.45, () => {
      fillStroke(p, c(p, "water-shallow"), null);
    });
    ctx.beginPath();
    for (const k of [-0.25, 0.05, 0.35]) {
      const y = k * r;
      for (let i = 0; i <= 8; i++) {
        const x = -r * 0.5 + (r * i) / 8;
        const yy = y + Math.sin(i * 1.6) * r * 0.05;
        if (i === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
    }
    fillStroke(p, null, c(p, "water-shallow"), p.lw * 0.7);
  };

const tent: Painter = (p) => {
  const { ctx, u } = p;
  const x = -p.w / 2 + 0.1 * u;
  const y = -p.h / 2 + 0.1 * u;
  const w = p.w - 0.2 * u;
  const h = p.h - 0.2 * u;
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
  ctx.beginPath();
  line(ctx, x, y, x + w / 2, y + h / 2);
  line(ctx, x + w, y, x + w / 2, y + h / 2);
  line(ctx, x, y + h, x + w / 2, y + h / 2);
  line(ctx, x + w, y + h, x + w / 2, y + h / 2);
  line(ctx, x + w / 2, y + h / 2, x + w / 2, y + h);
  fillStroke(p, null, c(p, "ink"), p.lw * 0.7);
};

const cart: Painter = (p) => {
  const { ctx, u } = p;
  const w = p.w - 0.3 * u;
  const h = p.h * 0.6;
  ctx.beginPath();
  ctx.rect(-w / 2, -h / 2, w, h);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
  ctx.beginPath();
  for (const sx of [-1, 1]) {
    ctx.rect(sx * w * 0.2 - 0.12 * u, -h / 2 - 0.1 * u, 0.24 * u, 0.1 * u);
    ctx.rect(sx * w * 0.2 - 0.12 * u, h / 2, 0.24 * u, 0.1 * u);
  }
  fillStroke(p, c(p, "ink"), null);
  ctx.beginPath();
  line(ctx, w / 2, 0, w / 2 + 0.15 * u, 0);
  fillStroke(p, null, c(p, "ink"));
};

const smallSquare: Painter = (p) => {
  const s = Math.min(p.w, p.h) * 0.24;
  p.ctx.beginPath();
  p.ctx.rect(-s / 2, -s / 2, s, s);
  fillStroke(p, c(p, "wood"), c(p, "ink"), p.lw * 0.7);
};

const signpost: Painter = (p) => {
  const { ctx } = p;
  const s = Math.min(p.w, p.h);
  ctx.beginPath();
  ctx.rect(-s * 0.32, -s * 0.12, s * 0.64, s * 0.16);
  fillStroke(p, c(p, "wood"), c(p, "ink"), p.lw * 0.7);
  ctx.beginPath();
  circlePath(ctx, 0, s * 0.18, s * 0.07);
  fillStroke(p, c(p, "ink"), null);
};

const wallHanging =
  (banner: boolean): Painter =>
  (p) => {
    const { ctx } = p;
    const s = Math.min(p.w, p.h);
    const y = -p.h / 2 + s * 0.06;
    const w = s * 0.5;
    ctx.beginPath();
    if (banner) {
      polyPath(ctx, [
        [-w / 2, y],
        [w / 2, y],
        [w / 2, y + s * 0.3],
        [0, y + s * 0.2],
        [-w / 2, y + s * 0.3],
      ]);
      fillStroke(p, c(p, "accent"), c(p, "ink"), p.lw * 0.7);
    } else {
      ctx.rect(-w / 2, y, w, s * 0.1);
      fillStroke(p, c(p, "floor"), c(p, "ink"), p.lw * 0.9);
    }
  };

const custom: Painter = (p) => {
  const { ctx } = p;
  const s = Math.min(p.w, p.h) * 0.62;
  ctx.beginPath();
  roundRectPath(ctx, -s / 2, -s / 2, s, s, s * 0.2);
  fillStroke(p, c(p, "floor"), c(p, "ink"));
  uprightText(p, "?", 0, s * 0.04, s * 0.7, c(p, "ink"));
};

// ───────────────────────────── outdoor ─────────────────────────────

function scallop(
  p: PaintArgs,
  r: number,
  lobes: number,
  fillAlpha: number,
  token: string,
  centreDot: boolean,
): void {
  const { ctx } = p;
  const phase = hash01(p.seed, 7) * TAU;
  ctx.beginPath();
  const steps = lobes * 6;
  for (let i = 0; i <= steps; i++) {
    const a = phase + (i * TAU) / steps;
    const k = Math.abs(Math.sin((i * Math.PI) / 6));
    const rr = r * (0.86 + 0.14 * k);
    if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  withAlpha(ctx, fillAlpha, () => {
    fillStroke(p, c(p, token), null);
  });
  fillStroke(p, null, c(p, token), p.lw);
  if (centreDot) {
    ctx.beginPath();
    circlePath(ctx, 0, 0, Math.max(1, r * 0.1));
    fillStroke(p, c(p, token), null);
  }
}

const tree: Painter = (p) => {
  scallop(p, Math.min(p.w, p.h) * (0.56 + hash01(p.seed, 3) * 0.14), 9, 0.3, "forest", true);
};
const bush: Painter = (p) => {
  scallop(p, Math.min(p.w, p.h) * 0.33, 6, 0.4, "forest", false);
};

const pine: Painter = (p) => {
  const { ctx } = p;
  const r = Math.min(p.w, p.h) * 0.56;
  ctx.beginPath();
  polyPath(ctx, starPoints(0, 0, r, r * 0.62, 11, hash01(p.seed, 5) * TAU));
  withAlpha(ctx, 0.38, () => {
    fillStroke(p, c(p, "forest"), null);
  });
  fillStroke(p, null, c(p, "forest"), p.lw);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i * TAU) / 6 + hash01(p.seed, 6);
    line(ctx, 0, 0, Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5);
  }
  fillStroke(p, null, c(p, "forest"), p.lw * 0.6);
};

const deadTree: Painter = (p) => {
  const { ctx } = p;
  const r = Math.min(p.w, p.h) * 0.45;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = (i * TAU) / 5 + hash01(p.seed, 9) * TAU;
    const mx = Math.cos(a) * r * 0.55;
    const my = Math.sin(a) * r * 0.55;
    line(ctx, 0, 0, mx, my);
    line(ctx, mx, my, Math.cos(a + 0.4) * r, Math.sin(a + 0.4) * r);
    line(ctx, mx, my, Math.cos(a - 0.35) * r * 0.9, Math.sin(a - 0.35) * r * 0.9);
  }
  ctx.lineCap = "round";
  fillStroke(p, null, c(p, "wood"), p.lw);
  ctx.beginPath();
  circlePath(ctx, 0, 0, r * 0.14);
  fillStroke(p, c(p, "wood"), c(p, "ink"), p.lw * 0.6);
};

const rock =
  (size: number): Painter =>
  (p) => {
    const { ctx } = p;
    const r = Math.min(p.w, p.h) * size;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 7; i++) {
      const a = (i * TAU) / 7 + hash01(p.seed, 11) * 0.8;
      const rr = r * (0.72 + 0.28 * hash01(p.seed, i, 4));
      pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
    }
    ctx.beginPath();
    polyPath(ctx, pts);
    withAlpha(ctx, 0.55, () => {
      fillStroke(p, c(p, "stone"), null);
    });
    fillStroke(p, null, c(p, "ink"), p.lw * 0.9);
  };

const standingStone: Painter = (p) => {
  const { ctx } = p;
  const s = Math.min(p.w, p.h);
  ctx.beginPath();
  roundRectPath(ctx, -s * 0.16, -s * 0.34, s * 0.32, s * 0.68, s * 0.12);
  fillStroke(p, c(p, "stone"), c(p, "ink"));
};

const stump: Painter = (p) => {
  const { ctx } = p;
  const r = Math.min(p.w, p.h) * 0.3;
  ctx.beginPath();
  circlePath(ctx, 0, 0, r);
  fillStroke(p, c(p, "wood"), c(p, "ink"));
  ctx.beginPath();
  circlePath(ctx, 0, 0, r * 0.55);
  fillStroke(p, null, c(p, "ink"), p.lw * 0.6);
};

const log: Painter = (p) => {
  const { ctx, u } = p;
  const w = p.w - 0.2 * u;
  const h = Math.min(p.h, u) * 0.38;
  ctx.beginPath();
  roundRectPath(ctx, -w / 2, -h / 2, w, h, h / 2);
  fillStroke(p, c(p, "wood"), c(p, "ink"));
  ctx.beginPath();
  circlePath(ctx, w / 2 - h / 2, 0, h * 0.28);
  line(ctx, -w * 0.3, -h * 0.15, w * 0.15, -h * 0.15);
  fillStroke(p, null, c(p, "ink"), p.lw * 0.6);
};

const sprigs =
  (count: number, token: string, heads: boolean): Painter =>
  (p) => {
    const { ctx } = p;
    const s = Math.min(p.w, p.h);
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const x = (hash01(p.seed, i, 21) - 0.5) * s * 0.7;
      const y = (hash01(p.seed, i, 22) - 0.5) * s * 0.6;
      line(ctx, x, y + s * 0.12, x + (hash01(p.seed, i, 23) - 0.5) * s * 0.12, y - s * 0.12);
    }
    ctx.lineCap = "round";
    fillStroke(p, null, c(p, token), p.lw * 0.9);
    if (heads) {
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const x = (hash01(p.seed, i, 21) - 0.5) * s * 0.7;
        const y = (hash01(p.seed, i, 22) - 0.5) * s * 0.6;
        circlePath(ctx, x, y - s * 0.13, s * 0.05);
      }
      fillStroke(p, c(p, "light"), null);
    }
  };

const mushroom: Painter = (p) => {
  const { ctx } = p;
  const s = Math.min(p.w, p.h);
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const x = (hash01(p.seed, i, 31) - 0.5) * s * 0.5;
    const y = (hash01(p.seed, i, 32) - 0.5) * s * 0.5;
    circlePath(ctx, x, y, s * (0.07 + 0.05 * hash01(p.seed, i, 33)));
  }
  fillStroke(p, c(p, "light"), c(p, "ink"), p.lw * 0.6);
};

// ───────────────────────────── openings (local: length along x, edge line at top) ─────────────────────────────

function gap(p: PaintArgs): void {
  const { ctx } = p;
  ctx.beginPath();
  ctx.rect(-p.w / 2, -p.h / 2, p.w, p.h);
  fillStroke(p, c(p, "floor"), null);
}

function jambs(p: PaintArgs, size: number): void {
  const { ctx, u } = p;
  const s = size * u;
  ctx.beginPath();
  ctx.rect(-p.w / 2, -p.h / 2, s, p.h);
  ctx.rect(p.w / 2 - s, -p.h / 2, s, p.h);
  fillStroke(p, c(p, "wall"), null);
}

const door =
  (leaves: number, lock: boolean): Painter =>
  (p) => {
    const { ctx, u } = p;
    gap(p);
    jambs(p, 0.1);
    const t = Math.min(p.h * 0.62, 0.26 * u);
    const L = p.w - 0.3 * u;
    ctx.beginPath();
    ctx.rect(-L / 2, -t / 2, L, t);
    fillStroke(p, c(p, "door"), c(p, "ink"), p.lw);
    if (leaves === 2) {
      ctx.beginPath();
      line(ctx, 0, -t / 2, 0, t / 2);
      fillStroke(p, null, c(p, "ink"), p.lw);
    }
    if (lock) {
      ctx.beginPath();
      circlePath(ctx, 0, 0, Math.max(1.2, 0.07 * u));
      fillStroke(p, c(p, "ink"), null);
    }
  };

const secretDoor: Painter = (p) => {
  const { ctx, u } = p;
  gap(p);
  ctx.beginPath();
  line(ctx, -p.w / 2, 0, p.w / 2, 0);
  ctx.setLineDash([Math.max(2, 0.16 * u), Math.max(1.5, 0.12 * u)]);
  ctx.lineCap = "butt";
  fillStroke(p, null, c(p, "secret"), p.h * 0.8);
  ctx.setLineDash([]);
  uprightText(p, "S", 0, -p.h / 2 - 0.32 * u, Math.max(9, 0.5 * u), c(p, "secret"));
};

const archway: Painter = (p) => {
  gap(p);
  jambs(p, 0.18);
};

const portcullis =
  (n: number): Painter =>
  (p) => {
    const { ctx, u } = p;
    gap(p);
    jambs(p, 0.1);
    ctx.beginPath();
    for (let i = 0; i < n; i++) circlePath(ctx, -p.w / 2 + ((i + 0.5) * p.w) / n, 0, Math.max(1.2, 0.06 * u));
    fillStroke(p, c(p, "ink"), null);
  };

const windowSlit =
  (fraction: number): Painter =>
  (p) => {
    const { ctx, u } = p;
    const L = p.w * fraction - 0.1 * u;
    ctx.beginPath();
    line(ctx, -L / 2, 0, L / 2, 0);
    ctx.lineCap = "butt";
    fillStroke(p, null, c(p, "floor"), Math.max(1.2, p.h * 0.28));
  };

// ───────────────────────────── level links (local: ascent toward −y) ─────────────────────────────

const stairs: Painter = (p) => {
  const { ctx, u } = p;
  const down = p.style === "link-down";
  const x = -p.w / 2;
  const y = -p.h / 2;
  ctx.beginPath();
  ctx.rect(x, y, p.w, p.h);
  fillStroke(p, c(p, down ? "stairwell" : "floor"), null);
  // shading: darker toward the low end (local bottom when going up; when seen from above, the far end is low)
  const bands = 6;
  for (let i = 0; i < bands; i++) {
    const t = (i + 1) / bands;
    ctx.beginPath();
    const by = down ? y + (i * p.h) / bands : y + (i * p.h) / bands;
    ctx.rect(x, by, p.w, p.h / bands);
    withAlpha(ctx, (down ? 0.32 * (1 - t) : 0.3 * t) * 0.9, () => {
      fillStroke(p, c(p, "ink"), null);
    });
  }
  ctx.beginPath();
  const step = 0.25 * u;
  for (let ty = y + step; ty < y + p.h - 1; ty += step) line(ctx, x, ty, x + p.w, ty);
  fillStroke(p, null, c(p, "ink"), p.lw * 0.9);
  ctx.beginPath();
  ctx.rect(x, y, p.w, p.h);
  fillStroke(p, null, c(p, "ink"), p.lw * 1.2);
  // chevron pointing up the stairs (or down when seen from the upper level)
  const cw = Math.min(p.w * 0.36, 0.36 * u);
  const cy = down ? y + p.h * 0.8 : y + Math.min(p.h * 0.2, 0.45 * u);
  const dir = down ? 1 : -1;
  ctx.beginPath();
  polyPath(
    ctx,
    [
      [-cw, cy - dir * cw * 0.55],
      [0, cy + dir * cw * 0.45],
      [cw, cy - dir * cw * 0.55],
    ],
    false,
  );
  ctx.lineJoin = "miter";
  ctx.lineCap = "round";
  fillStroke(p, null, c(p, "ink"), p.lw * 2);
};

const ramp: Painter = (p) => {
  const { ctx, u } = p;
  ctx.beginPath();
  ctx.rect(-p.w / 2, -p.h / 2, p.w, p.h);
  fillStroke(p, c(p, p.style === "link-down" ? "stairwell" : "floor"), c(p, "ink"), p.lw * 1.2);
  ctx.beginPath();
  const cw = Math.min(p.w * 0.3, 0.3 * u);
  for (let cy = -p.h / 2 + 0.4 * u; cy < p.h / 2; cy += 0.6 * u) {
    polyPath(
      ctx,
      [
        [-cw, cy + cw * 0.5],
        [0, cy - cw * 0.4],
        [cw, cy + cw * 0.5],
      ],
      false,
    );
  }
  fillStroke(p, null, c(p, "ink"), p.lw * 1.4);
};

const spiral: Painter = (p) => {
  const { ctx } = p;
  const r = Math.min(p.w, p.h) * 0.46;
  ctx.beginPath();
  circlePath(ctx, 0, 0, r);
  fillStroke(p, c(p, p.style === "link-down" ? "stairwell" : "floor"), c(p, "ink"), p.lw * 1.2);
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i * TAU) / 10;
    line(ctx, Math.cos(a) * r * 0.2, Math.sin(a) * r * 0.2, Math.cos(a) * r, Math.sin(a) * r);
  }
  fillStroke(p, null, c(p, "ink"), p.lw * 0.8);
  ctx.beginPath();
  circlePath(ctx, 0, 0, r * 0.2);
  fillStroke(p, c(p, "ink"), null);
};

const ladder: Painter = (p) => {
  const { ctx } = p;
  const w = Math.min(p.w, p.h) * 0.44;
  const h = p.h * 0.84;
  ctx.beginPath();
  if (p.style === "link-down") {
    ctx.rect(-p.w * 0.42, -p.h * 0.42, p.w * 0.84, p.h * 0.84);
    fillStroke(p, c(p, "stairwell"), null);
    ctx.beginPath();
  }
  line(ctx, -w / 2, -h / 2, -w / 2, h / 2);
  line(ctx, w / 2, -h / 2, w / 2, h / 2);
  for (let i = 1; i < 5; i++) line(ctx, -w / 2, -h / 2 + (h * i) / 5, w / 2, -h / 2 + (h * i) / 5);
  fillStroke(p, null, c(p, "ink"), p.lw * 1.1);
};

const trapdoor =
  (dark: boolean): Painter =>
  (p) => {
    const { ctx } = p;
    const s = Math.min(p.w, p.h) * 0.78;
    ctx.beginPath();
    ctx.rect(-s / 2, -s / 2, s, s);
    fillStroke(p, c(p, dark ? "chasm" : "floor"), c(p, "ink"), p.lw * 1.2);
    ctx.beginPath();
    line(ctx, -s / 2, -s / 2, s / 2, s / 2);
    line(ctx, s / 2, -s / 2, -s / 2, s / 2);
    fillStroke(p, null, c(p, dark ? "floor" : "ink"), p.lw);
  };

// ───────────────────────────── registry ─────────────────────────────

const table = box(0.1, 0.08);
const bench = (p: PaintArgs): void => {
  const inset = Math.max(0, (p.h - 0.4 * p.u) / 2 / p.u);
  box(0.06, 0.06)({ ...p, h: p.h - 2 * inset * p.u });
};

export const PAINTERS: Record<string, Painter> = {
  "feat-table": table,
  "feat-desk": box(0.08, 0.03, (p, x, y, w) => {
    line(p.ctx, x + w * 0.62, y, x + w * 0.62, y + p.h * 0.3);
  }),
  "feat-counter": box(0.06, 0.02),
  "feat-bar_counter": box(0.06, 0.02),
  "feat-bench": bench,
  "feat-round_table": roundTable,
  "feat-chair": chair,
  "feat-stool": stool,
  "feat-throne": throne,
  "feat-bed": bed(0),
  "feat-bunk_bed": bed(1),
  "feat-wardrobe": wardrobe,
  "feat-bookshelf": shelf(false),
  "feat-shelf": shelf(false),
  "feat-weapon_rack": shelf(true),
  "feat-armor_stand": armorStand,
  "feat-chest": chest,
  "feat-barrel": barrel,
  "feat-crate": crate,
  "feat-sack": sack,
  "feat-rug": rug,
  "feat-cauldron": cauldron,
  "feat-anvil": anvil,
  "feat-forge": forge,
  "feat-cage": cage,
  "feat-stocks": stocks,
  "feat-pillar": pillar,
  "feat-statue": statue,
  "feat-altar": altar,
  "feat-fountain": water("stone"),
  "feat-well": water("stone"),
  "feat-pool": water("stone"),
  "feat-brazier": light(0.16, 6, false),
  "feat-candelabra": light(0.1, 6, false),
  "feat-chandelier": light(0.1, 8, true),
  "feat-torch_wall": torchWall,
  "feat-banner_wall": wallHanging(true),
  "feat-painting_wall": wallHanging(false),
  "feat-sarcophagus": coffin(true, false),
  "feat-coffin": coffin(false, false),
  "feat-tomb": coffin(false, true),
  "feat-bones": bones,
  "feat-rubble": dots(7, 0.07, true),
  "feat-debris": dots(6, 0.045, false),
  "feat-web": web,
  "feat-lever": lever,
  "feat-trap": trap,
  "feat-trap_plate": trap,
  "feat-tree": tree,
  "feat-dead_tree": deadTree,
  "feat-pine_tree": pine,
  "feat-bush": bush,
  "feat-rock": rock(0.3),
  "feat-boulder": rock(0.44),
  "feat-stump": stump,
  "feat-log": log,
  "feat-mushroom": mushroom,
  "feat-flowers": sprigs(5, "forest", true),
  "feat-tall_grass": sprigs(7, "forest", false),
  "feat-reeds": sprigs(6, "forest", false),
  "feat-campfire": campfire,
  "feat-tent": tent,
  "feat-cart": cart,
  "feat-wagon": cart,
  "feat-fence_post": smallSquare,
  "feat-signpost": signpost,
  "feat-standing_stone": standingStone,
  "feat-grave": grave,
  "feat-custom": custom,
  // cave, ritual and light dressing (feature types added 2026-11-19): nearest existing cartographic symbol
  "feat-stalagmite": rock(0.3),
  "feat-stalactite": rock(0.25),
  "feat-rock_formation": rock(0.44),
  "feat-cave_in": dots(7, 0.07, true),
  "feat-crystal": rock(0.25),
  "feat-giant_mushroom": mushroom,
  "feat-root": log,
  "feat-root_large": log,
  "feat-roots_wall": log,
  "feat-vines": sprigs(6, "forest", false),
  "feat-tree_large": tree,
  "feat-candles": light(0.1, 6, false),
  "feat-skull_pile": bones,
  "feat-spawn_point": trap,
  "feat-torch_floor": light(0.12, 6, false),
  "feat-lantern": light(0.1, 6, false),
  "feat-magic_fire": campfire,
  "feat-lava_glow": light(0.14, 6, false),
  "feat-fire_pit": campfire,
  "feat-monolith": standingStone,
  "feat-cave_column": pillar,
  "feat-statue_large": statue,
  "feat-mine_cart": cart,
  "feat-rails": smallSquare,
  "feat-mine_support": pillar,
  "feat-chains": dots(5, 0.04, false),
  // theme-neutral dressing roles (2026-11-19): a generic glyph per role, whatever asset a theme puts there
  "feat-landmark": statue,
  "feat-tall_marker": standingStone,
  "feat-formation": rock(0.44),
  "feat-cluster_tall": tree,
  "feat-undergrowth": bush,
  "feat-ground_cover": sprigs(6, "forest", false),
  "feat-accent_light": light(0.12, 6, false),
  "feat-edge_dressing": rock(0.3),
  "feat-small_detail": dots(5, 0.045, false),
  "feat-wall_dressing": wallHanging(false),
  "feat-bank_dressing": sprigs(6, "forest", false),
  "feat-jetty": bench,
  // built places (2026-11-20): a parked vehicle, seating, a sign on a frontage
  "feat-vehicle": cart,
  "feat-seating": bench,
  "feat-signage": wallHanging(true),
  "feat-cliff_face": rock(0.46),
  "feat-cliff_crest": rock(0.38),
  "door-door": door(1, false),
  "door-double_door": door(2, false),
  "door-locked_door": door(1, true),
  "door-secret_door": secretDoor,
  "door-archway": archway,
  "door-portcullis": portcullis(4),
  "door-bars": portcullis(5),
  "door-window": windowSlit(1),
  "door-arrow_slit": windowSlit(0.4),
  "door-open": () => undefined,
  "link-stairs": stairs,
  "link-ramp": ramp,
  "link-spiral_stairs": spiral,
  "link-ladder": ladder,
  "link-trapdoor": trapdoor(false),
  "link-pit_drop": trapdoor(true),
};

/**
 * The painter for a symbol id. A feature type without its own painter (new types, slots) is drawn with the glyph of
 * the stand-in type the core catalog names for it, so a real feature never shows the "?" of a custom feature.
 */
export function painterFor(symbolId: string): Painter {
  const own = PAINTERS[symbolId];
  if (own) return own;
  const type = symbolId.startsWith("feat-") ? symbolId.slice(5) : "";
  if (Object.hasOwn(FEATURE_INFO, type)) return PAINTERS[`feat-${glyphType(type as FeatureType)}`] ?? custom;
  return custom;
}
