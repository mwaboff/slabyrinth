/**
 * Items with geometry (rings), one function per layer: ground, floors and water, height shading, ledges (cliffs,
 * bridges, low steps), the grid, walls, area outlines (roofs, zones) and selection. The look of each display token
 * (a texture per floor material, a pattern per wall style) is the renderer's own table below.
 */
import { MATERIALS, type Material, type WallStyle } from "@slabyrinth/core/contracts/plan";
import type { DisplayItem, DisplayLayer } from "@slabyrinth/core/contracts/resolved";
import { withAlpha } from "../prims";
import type { Box, DrawCtx } from "./context";
import { hatch, texture, waves, type TextureKind } from "./fills";

type Geom = NonNullable<DisplayItem["geom"]>;
type GeomPainter = (d: DrawCtx, style: string, geom: Geom, b: Box) => void;

/**
 * The texture marks of each floor material (the kind of mark and its alpha), or null for a plain fill. Keyed by every
 * material of core's vocabulary: a new material is a compile error here until its look is chosen.
 */
export const MATERIAL_TEXTURE: Readonly<Record<Material, readonly [TextureKind, number] | null>> = {
  flagstone: null,
  stone_tile: null,
  marble: null,
  brick: null,
  cobble: ["cracks", 0.35],
  wood_plank: ["planks", 0.35],
  carpet: null,
  rock: ["cracks", 0.2],
  dirt: ["stipple", 0.25],
  grass: ["tufts", 0.3],
  sand: ["stipple", 0.22],
  gravel: ["stipple", 0.35],
  mud: ["stipple", 0.3],
  snow: ["stipple", 0.15],
  ice: ["cracks", 0.3],
  swamp: ["tufts", 0.35],
  water_shallow: null,
  water_deep: null,
  lava: ["cracks", 0.6],
  bridge_wood: ["planks", 0.5],
  asphalt: null,
  concrete: null,
};
/** The same, by display token ("mat-<material>"). */
const MAT_TEXTURE: ReadonlyMap<string, readonly [TextureKind, number] | null> = new Map(
  MATERIALS.map((m) => [`mat-${m}`, MATERIAL_TEXTURE[m]] as const),
);

/** How a wall style's strip looks over its fill: faded, hatched (ruined), dashed (fences, rails, bars) or edged. */
type WallLook = { alpha: number; pattern?: "hatch" | "dashed" | "edged" };
const PLAIN_WALL: WallLook = { alpha: 1 };
/** Every wall style of core's vocabulary has its look (a new style is a compile error here). */
export const WALL_LOOK: Readonly<Record<WallStyle, WallLook>> = {
  wall: PLAIN_WALL,
  stone: PLAIN_WALL,
  brick: PLAIN_WALL,
  wood: PLAIN_WALL,
  cave_rock: PLAIN_WALL,
  plaster: PLAIN_WALL,
  palisade: { alpha: 1, pattern: "dashed" },
  fence: { alpha: 1, pattern: "dashed" },
  hedge: { alpha: 1, pattern: "edged" },
  low_wall: { alpha: 0.7 },
  railing: { alpha: 1, pattern: "dashed" },
  iron_bars: { alpha: 1, pattern: "dashed" },
  ruined: { alpha: 0.8, pattern: "hatch" },
  railing_stone: PLAIN_WALL,
  concrete: PLAIN_WALL,
  metal: PLAIN_WALL,
  panel: PLAIN_WALL,
  marble: PLAIN_WALL,
  dark_stone: PLAIN_WALL,
  timber: PLAIN_WALL,
};
const wallLook = (style: string): WallLook =>
  Object.hasOwn(WALL_LOOK, style) ? WALL_LOOK[style as WallStyle] : PLAIN_WALL;

/** Below this scale (px per cell) the grid is not drawn. */
const GRID_MIN_SCALE = 6;

/** Fills the rings' area with a pattern drawn by `draw`, clipped to the rings. */
function clipped(d: DrawCtx, rings: number[][], draw: () => void): void {
  d.ctx.save();
  d.ringsPath(rings, true);
  d.ctx.clip();
  draw();
  d.ctx.restore();
}

const drawGround: GeomPainter = (d, st, { rings }, b) => {
  const { ctx, col } = d;
  if (st === "ghost") {
    d.ringsPath(rings, true);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = col("accent");
    ctx.lineWidth = d.baseLw;
    withAlpha(ctx, 0.4, () => {
      ctx.stroke();
    });
    ctx.setLineDash([]);
    return;
  }
  d.ringsPath(rings, true);
  // VOID cells are "nothing here" (open air around a building on an upper floor): plain background, no
  // hatch. Only a real drop (NO_FLOOR, the "chasm" floor style) gets the dark fill and a legend entry.
  ctx.fillStyle = col("paper");
  ctx.fill();
  if (st === "rock")
    clipped(d, rings, () => {
      hatch(d, b, Math.max(4, d.u * 0.27), col("hatch"), Math.max(0.8, d.u / 22) * d.ls);
    });
};

/** Floors and water: holes (chasm, stairwell), water with waves, a floor material with its texture. */
const drawFloor =
  (layer: "floor" | "water"): GeomPainter =>
  (d, st, { rings }, b) => {
    const { ctx, col } = d;
    d.ringsPath(rings, true);
    if (st === "chasm" || st === "stairwell") {
      ctx.fillStyle = col(st);
      ctx.fill();
      if (st === "chasm") {
        ctx.strokeStyle = col("ink");
        ctx.lineWidth = d.baseLw * 1.3;
        ctx.stroke();
      }
      return;
    }
    if (layer === "water") {
      ctx.fillStyle = col("floor");
      ctx.fill();
      const deep = st === "water-deep";
      ctx.fillStyle = col(st);
      withAlpha(ctx, deep ? 0.55 : 0.3, () => {
        ctx.fill();
      });
      clipped(d, rings, () => {
        waves(
          d,
          b,
          Math.max(4, d.u * (deep ? 0.2 : 0.33)),
          col(st),
          Math.max(0.8, d.baseLw * 0.7),
          deep ? 0.95 : 0.8,
        );
      });
      return;
    }
    ctx.fillStyle = col(st);
    ctx.fill();
    const tex = MAT_TEXTURE.get(st);
    if (tex)
      clipped(d, rings, () => {
        texture(d, b, tex[0], st.length);
        ctx.strokeStyle = col("texture");
        ctx.fillStyle = col("texture");
        ctx.lineWidth = Math.max(0.6, d.baseLw * 0.5);
        withAlpha(ctx, tex[1], () => {
          if (tex[0] === "stipple") ctx.fill();
          else ctx.stroke();
        });
      });
  };

const drawHeightShade: GeomPainter = (d, st, { rings }) => {
  const up = st.startsWith("height-up");
  const q = Number(st.slice(st.lastIndexOf("-") + 1)) || 1;
  d.ringsPath(rings, true);
  d.ctx.fillStyle = d.col(up ? "height-up" : "height-down");
  // graded: every quarter tile deeper is visibly darker, up to a 4-tile drop (raised floors stay subtle)
  withAlpha(d.ctx, up ? Math.min(0.3, 0.05 * q + 0.03) : Math.min(0.62, 0.035 * q + 0.06), () => {
    d.ctx.fill();
  });
};

const drawLedge: GeomPainter = (d, st, geom, b) => {
  if (st === "cliff") drawCliff(d, geom.rings);
  else if (st === "bridge-h" || st === "bridge-v") drawBridge(d, st, geom.rings, b);
  else {
    const { ctx, u } = d;
    d.ringsPath(geom.rings, false);
    ctx.setLineDash([Math.max(2, u * 0.12), Math.max(2, u * 0.08)]);
    ctx.strokeStyle = d.col("ledge");
    ctx.lineWidth = d.baseLw * 1.1;
    ctx.stroke();
    ctx.setLineDash([]);
  }
};

/** Solid ink line on the cliff top, hachures hanging toward the low side (right of each segment). */
function drawCliff(d: DrawCtx, rings: number[][]): void {
  const { ctx, X, Y } = d;
  d.ringsPath(rings, false);
  ctx.strokeStyle = d.col("ink");
  ctx.lineWidth = d.baseLw * 2;
  ctx.stroke();
  ctx.beginPath();
  const tick = Math.max(3, d.u * 0.3);
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
  ctx.lineWidth = Math.max(1, d.baseLw);
  ctx.stroke();
}

/** Planks across the deck, then a strong outline. */
function drawBridge(d: DrawCtx, st: string, rings: number[][], b: Box): void {
  const { ctx, X, Y } = d;
  clipped(d, rings, () => {
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
    ctx.strokeStyle = d.col("ink");
    ctx.lineWidth = Math.max(0.6, d.baseLw * 0.6);
    withAlpha(ctx, 0.45, () => {
      ctx.stroke();
    });
  });
  d.ringsPath(rings, true);
  ctx.strokeStyle = d.col("ink");
  ctx.lineWidth = d.baseLw * 1.8;
  ctx.stroke();
}

const drawGrid: GeomPainter = (d, _st, { rings }) => {
  if (d.u < GRID_MIN_SCALE) return;
  d.ringsPath(rings, false);
  d.ctx.strokeStyle = d.col("grid");
  d.ctx.lineWidth = Math.max(0.6, Math.min(1.2, d.u / 24)) * d.ls;
  d.ctx.stroke();
};

const drawWall: GeomPainter = (d, st, { rings }, b) => {
  const { ctx, col, u } = d;
  d.ringsPath(rings, true);
  ctx.fillStyle = col(st);
  const look = wallLook(st.startsWith("wall-") ? st.slice(5) : "wall");
  withAlpha(ctx, look.alpha, () => {
    ctx.fill();
  });
  if (look.pattern === "hatch")
    clipped(d, rings, () => {
      hatch(d, b, Math.max(5, u * 0.35), col("paper"), Math.max(1, u * 0.06));
    });
  else if (look.pattern === "dashed") {
    d.ringsPath(rings, true);
    ctx.setLineDash([Math.max(2, u * 0.1), Math.max(2, u * 0.1)]);
    ctx.strokeStyle = col("floor");
    ctx.lineWidth = Math.max(1, u * 0.05);
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (look.pattern === "edged") {
    d.ringsPath(rings, true);
    ctx.strokeStyle = col("ink");
    ctx.lineWidth = d.baseLw * 0.6;
    withAlpha(ctx, 0.5, () => {
      ctx.stroke();
    });
  }
};

const drawAreaOutline: GeomPainter = (d, st, { rings, closed }) => {
  const { ctx, u } = d;
  d.ringsPath(rings, closed);
  // building roof plans: the ridge solid in ink, the roof edge dashed in ink; zones dashed in the zone colour
  const roof = st === "roof-outline" || st === "roof-ridge";
  ctx.setLineDash(st === "roof-ridge" ? [] : [Math.max(4, u * 0.33), Math.max(3, u * 0.17)]);
  ctx.strokeStyle = d.col(roof ? "ink" : "zone");
  ctx.lineWidth = roof ? d.baseLw * 0.8 : d.baseLw;
  withAlpha(ctx, 0.75, () => {
    ctx.stroke();
  });
  ctx.setLineDash([]);
};

const drawSelection: GeomPainter = (d, st, { rings }) => {
  const { ctx, col } = d;
  d.ringsPath(rings, true);
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
    ctx.lineWidth = 2 * d.ls;
    ctx.stroke();
    ctx.setLineDash([]);
  }
};

/** Any other geometry: a plain line in the style's colour. */
const drawPlainLine: GeomPainter = (d, st, { rings, closed }) => {
  d.ringsPath(rings, closed);
  d.ctx.strokeStyle = d.col(st);
  d.ctx.lineWidth = d.baseLw;
  d.ctx.stroke();
};

const GEOM_PAINTERS: Partial<Record<DisplayLayer, GeomPainter>> = {
  ground: drawGround,
  floor: drawFloor("floor"),
  water: drawFloor("water"),
  height_shade: drawHeightShade,
  ledge: drawLedge,
  grid: drawGrid,
  wall: drawWall,
  area_outline: drawAreaOutline,
  selection: drawSelection,
};

/** Draws an item's geometry the way its layer draws. */
export function drawGeom(d: DrawCtx, it: DisplayItem, geom: Geom, b: Box): void {
  (GEOM_PAINTERS[it.layer] ?? drawPlainLine)(d, it.style, geom, b);
}
