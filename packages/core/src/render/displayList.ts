/**
 * buildDisplayList (architecture §5.1): ResolvedLevel → renderer-agnostic DisplayList in cell units.
 * Geometry is traced from cell masks (outer rings clockwise, holes counter-clockwise in screen orientation, so
 * non-zero and even-odd fills agree). Walls are filled half-cell strips in the HOST cell (EdgeGrid.host), traced
 * on a half-cell grid with corner posts, so the 2D view shows exactly the usable floor the compiler builds.
 * No colours here: DisplayItem.style is a semantic token resolved by a MapTheme at draw time.
 */
import type { LevelId, Side } from "../contracts/plan";
import type {
  DisplayContext,
  DisplayItem,
  DisplayLayer,
  DisplayList,
  DisplayOptions,
  ResolvedArea,
  ResolvedLevel,
  ResolvedOpening,
  ResolvedPlan,
} from "../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../contracts/resolved";
import { featureInfo } from "../gen/catalog";
import { gableRoof, hipRoof, ringLayer, shedRoof, spireShell } from "../resolve/roof";
import { traceRings } from "../resolve/trace";

/** Contract DisplayContext (links + level labels), re-exported for existing importers. */
export type { DisplayContext };

export const LAYER_ORDER: readonly DisplayLayer[] = [
  "ground",
  "floor",
  "water",
  "height_shade",
  "ledge",
  "grid",
  "wall",
  "opening",
  "link",
  "feature",
  "area_outline",
  "label",
  "selection",
];

export const DEFAULT_DISPLAY_OPTIONS: DisplayOptions = {
  grid: true,
  roomNumbers: true,
  roomNames: false,
  furniture: true,
  gmLayer: true,
  legend: false,
};

const SIDE_ROT: Record<Side, number> = { N: 0, E: 90, S: 180, W: 270 };
const DIR_ROT: Record<Side, number> = { N: 0, E: 90, S: 180, W: 270 };
/** Openings drawn as wall (with an overlay symbol) rather than as a gap. */
const WALL_LIKE_OPENINGS = new Set(["window", "arrow_slit"]);

/** "L1", "L2"… in tab order: entry level first, then by distance in elevation (ties: higher first). */
export function levelLabels(
  resolved: Pick<ResolvedPlan, "levels">,
  entryLevel?: LevelId,
): Record<LevelId, string> {
  const levels = resolved.levels;
  const entry =
    levels.find((l) => l.id === entryLevel) ??
    levels.slice().sort((a, b) => Math.abs(a.elevation) - Math.abs(b.elevation))[0];
  const e0 = entry?.elevation ?? 0;
  const ordered = levels
    .map((l, i) => ({ l, i }))
    .sort((a, b) => {
      if (a.l === entry) return -1;
      if (b.l === entry) return 1;
      return (
        Math.abs(a.l.elevation - e0) - Math.abs(b.l.elevation - e0) ||
        b.l.elevation - a.l.elevation ||
        a.i - b.i
      );
    });
  const out: Record<LevelId, string> = {};
  ordered.forEach(({ l }, k) => (out[l.id] = `L${k + 1}`));
  return out;
}

const flat = (ring: Array<[number, number]>): number[] => {
  const out: number[] = [];
  for (const [x, y] of ring) out.push(x, y);
  return out;
};

/** Rings of the cells selected by `pred`, restricted to the bbox of those cells (cell units, global). */
function cellRings(level: ResolvedLevel, pred: (i: number) => boolean): number[][] {
  const { x: bx, y: by, w, h } = level.bounds;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < w * h; i++) {
    if (!pred(i)) continue;
    const lx = i % w;
    const ly = (i - lx) / w;
    if (lx < x0) x0 = lx;
    if (lx > x1) x1 = lx;
    if (ly < y0) y0 = ly;
    if (ly > y1) y1 = ly;
  }
  if (x1 < 0) return [];
  return traceRings(
    x1 - x0 + 1,
    y1 - y0 + 1,
    (ux, uy) => pred((y0 + uy) * w + x0 + ux),
    bx + x0,
    by + y0,
  ).map(flat);
}

/** Groups cells by a string key (null = skip) and traces each group. Keys are returned in first-seen order. */
function groupRings(level: ResolvedLevel, keyOf: (i: number) => string | null): Array<[string, number[][]]> {
  const n = level.bounds.w * level.bounds.h;
  const keys: string[] = [];
  const idx = new Int32Array(n).fill(-1);
  const map = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = keyOf(i);
    if (k === null) continue;
    let j = map.get(k);
    if (j === undefined) {
      j = keys.length;
      keys.push(k);
      map.set(k, j);
    }
    idx[i] = j;
  }
  return keys.map((k, j) => [k, cellRings(level, (i) => idx[i] === j)]);
}

export function buildDisplayList(
  level: ResolvedLevel,
  opts: DisplayOptions,
  ctx: DisplayContext = {},
): DisplayList {
  const items: DisplayItem[] = [];
  const { x: bx, y: by, w, h } = level.bounds;
  const st = level.cells.state;
  const fl = level.cells.flags;
  const isFloor = (i: number): boolean =>
    st[i] === CELL.OPEN && ((fl[i] as number) & CELL_FLAG.NO_FLOOR) === 0;
  // broken bridge cells show the ground below them (lava, the chasm floor), not a black hole
  const underBroken = new Map<number, { material: string | null; height: number }>();
  for (const b of level.bridges ?? []) {
    const brokenSet = new Set(b.broken.map(([x, y]) => `${x},${y}`));
    b.cells.forEach(([x, y], j) => {
      if (!brokenSet.has(`${x},${y}`)) return;
      underBroken.set((y - by) * w + (x - bx), {
        material: b.underMaterial[j] ?? null,
        height: b.under[j] ?? 0,
      });
    });
  }

  // ── ground: rock + void ──
  for (const [k, rings] of groupRings(level, (i) =>
    st[i] === CELL.SOLID ? "rock" : st[i] === CELL.VOID ? "void" : null,
  ))
    if (rings.length > 0) items.push({ layer: "ground", style: k, geom: { rings, closed: true } });
  if (opts.ghostLevel) {
    const g = opts.ghostLevel;
    const gw = g.bounds.w;
    const rings = traceRings(
      gw,
      g.bounds.h,
      (ux, uy) => g.cells.state[uy * gw + ux] === CELL.OPEN,
      g.bounds.x,
      g.bounds.y,
    ).map(flat);
    if (rings.length > 0) items.push({ layer: "ground", style: "ghost", geom: { rings, closed: true } });
  }

  // ── floor (by material), chasms, stairwells; water separately ──
  const mats = level.materials;
  const floorKey = (i: number): string | null => {
    if (st[i] !== CELL.OPEN) return null;
    const f = fl[i] as number;
    if (f & CELL_FLAG.STAIRWELL) return "stairwell";
    const ub = underBroken.get(i);
    if (ub) return ub.material === null ? "chasm" : `mat-${ub.material}`;
    if (f & CELL_FLAG.NO_FLOOR) return "chasm";
    const m = level.cells.material[i] as number;
    const name = m > 0 ? (mats[m - 1] as string) : "floor";
    return name === "water_shallow" || name === "water_deep"
      ? null
      : name === "floor"
        ? "floor"
        : `mat-${name}`;
  };
  for (const [k, rings] of groupRings(level, floorKey))
    items.push({ layer: "floor", style: k, geom: { rings, closed: true } });
  const waterKey = (i: number): string | null => {
    if (!isFloor(i)) return null;
    const m = level.cells.material[i] as number;
    const name = m > 0 ? mats[m - 1] : undefined;
    return name === "water_shallow" ? "water-shallow" : name === "water_deep" ? "water-deep" : null;
  };
  for (const [k, rings] of groupRings(level, waterKey))
    items.push({ layer: "water", style: k, geom: { rings, closed: true } });

  // ── height shading ──
  const heightKey = (i: number): string | null => {
    const ub = underBroken.get(i);
    if (!isFloor(i) && !(ub && ub.material !== null)) return null;
    const q = ub ? ub.height : (level.cells.height[i] as number);
    if (q === 0) return null;
    return q > 0 ? `height-up-${Math.min(16, q)}` : `height-down-${Math.min(16, -q)}`;
  };
  for (const [k, rings] of groupRings(level, heightKey))
    items.push({ layer: "height_shade", style: k, geom: { rings, closed: true } });

  // ── edges: ledges and grid (merged into runs) ──
  const H = level.hEdges;
  const V = level.vEdges;
  const ledgeRings: number[][] = [];
  const gridRings: number[][] = [];
  const cellAt = (lx: number, ly: number): number =>
    lx < 0 || ly < 0 || lx >= w || ly >= h ? -1 : ly * w + lx;
  const gridOk = (a: number, b: number, kind: number): boolean => {
    if (kind === EDGE.WALL || kind === EDGE.OPENING) return false;
    const fa = a >= 0 && isFloor(a);
    const fb = b >= 0 && isFloor(b);
    return (fa && fb) || (fa && b < 0) || (fb && a < 0);
  };
  for (let ly = 0; ly <= h; ly++) {
    let gStart = -1;
    let lStart = -1;
    for (let lx = 0; lx <= w; lx++) {
      const inRow = lx < w;
      const e = ly * w + lx;
      const kind = inRow ? (H.kind[e] as number) : -1;
      const g = inRow && gridOk(cellAt(lx, ly - 1), cellAt(lx, ly), kind);
      const l = inRow && kind === EDGE.LEDGE && (H.height[e] as number) < 1;
      if (g && gStart < 0) gStart = lx;
      if (!g && gStart >= 0) {
        gridRings.push([bx + gStart, by + ly, bx + lx, by + ly]);
        gStart = -1;
      }
      if (l && lStart < 0) lStart = lx;
      if (!l && lStart >= 0) {
        ledgeRings.push([bx + lStart, by + ly, bx + lx, by + ly]);
        lStart = -1;
      }
    }
  }
  for (let lx = 0; lx <= w; lx++) {
    let gStart = -1;
    let lStart = -1;
    for (let ly = 0; ly <= h; ly++) {
      const inCol = ly < h;
      const e = ly * (w + 1) + lx;
      const kind = inCol ? (V.kind[e] as number) : -1;
      const g = inCol && gridOk(cellAt(lx - 1, ly), cellAt(lx, ly), kind);
      const l = inCol && kind === EDGE.LEDGE && (V.height[e] as number) < 1;
      if (g && gStart < 0) gStart = ly;
      if (!g && gStart >= 0) {
        gridRings.push([bx + lx, by + gStart, bx + lx, by + ly]);
        gStart = -1;
      }
      if (l && lStart < 0) lStart = ly;
      if (!l && lStart >= 0) {
        ledgeRings.push([bx + lx, by + lStart, bx + lx, by + ly]);
        lStart = -1;
      }
    }
  }
  if (ledgeRings.length > 0)
    items.push({ layer: "ledge", style: "ledge", geom: { rings: ledgeRings, closed: false } });
  // cliffs (drops of a tile or more): one segment per edge, directed so the LOW side is on its right (screen
  // coordinates, y down); the renderer draws the cliff line with hachures toward the low side.
  const hq = (i: number): number => {
    const ub = underBroken.get(i);
    return ub ? ub.height : (level.cells.height[i] as number);
  };
  const cliffRings: number[][] = [];
  for (let ly = 1; ly < h; ly++)
    for (let lx = 0; lx < w; lx++) {
      const e = ly * w + lx;
      if (H.kind[e] !== EDGE.LEDGE || (H.height[e] as number) < 1) continue;
      const northLow = hq((ly - 1) * w + lx) < hq(ly * w + lx);
      cliffRings.push(
        northLow ? [bx + lx + 1, by + ly, bx + lx, by + ly] : [bx + lx, by + ly, bx + lx + 1, by + ly],
      );
    }
  for (let ly = 0; ly < h; ly++)
    for (let lx = 1; lx < w; lx++) {
      const e = ly * (w + 1) + lx;
      if (V.kind[e] !== EDGE.LEDGE || (V.height[e] as number) < 1) continue;
      const westLow = hq(ly * w + lx - 1) < hq(ly * w + lx);
      cliffRings.push(
        westLow ? [bx + lx, by + ly, bx + lx, by + ly + 1] : [bx + lx, by + ly + 1, bx + lx, by + ly],
      );
    }
  if (cliffRings.length > 0)
    items.push({ layer: "ledge", style: "cliff", geom: { rings: cliffRings, closed: false } });
  // bridges: the deck outline with planks across it ("bridge-h" runs east–west, "bridge-v" north–south)
  for (const b of level.bridges ?? []) {
    const set = new Set(b.cells.map(([x, y]) => (y - by) * w + (x - bx)));
    const rings = cellRings(level, (i) => set.has(i));
    if (rings.length === 0) continue;
    const xs = b.cells.map((c) => c[0]);
    const ys = b.cells.map((c) => c[1]);
    const ew = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
    items.push({
      layer: "ledge",
      style: ew ? "bridge-h" : "bridge-v",
      geom: { rings, closed: true },
      ref: b.id,
    });
  }
  if (opts.grid && gridRings.length > 0)
    items.push({ layer: "grid", style: "grid", geom: { rings: gridRings, closed: false } });

  // ── walls: half-cell strips in the host cell, traced on a quarter grid ──
  const openings = level.openings;
  const openingAsWall = (o: ResolvedOpening | undefined): boolean =>
    !!o &&
    (WALL_LIKE_OPENINGS.has(o.kind) || (!opts.gmLayer && (o.gmOnly === true || o.kind === "secret_door")));
  const styleKeys: string[] = [""];
  const styleKey = (style: string): number => {
    const tok = style === "wall" ? "wall" : `wall-${style}`;
    let k = styleKeys.indexOf(tok);
    if (k < 0) {
      k = styleKeys.length;
      styleKeys.push(tok);
    }
    return k;
  };
  const QW = 2 * w;
  const QH = 2 * h;
  const quarters = new Uint8Array(QW * QH);
  const setQ = (qx: number, qy: number, k: number): void => {
    if (qx < 0 || qy < 0 || qx >= QW || qy >= QH) return;
    quarters[qy * QW + qx] = k;
  };
  /** Style key if the edge is drawn as wall (0 if not); `posts` also counts real openings. */
  const edgeWall = (g: ResolvedLevel["hEdges"], e: number, posts: boolean): number => {
    const kind = g.kind[e];
    if (kind === EDGE.WALL) return styleKey(level.wallStyles[g.ref[e] as number] ?? "wall");
    if (kind === EDGE.OPENING) {
      const o = openings[g.ref[e] as number];
      if (openingAsWall(o) || (posts && o)) return styleKey(o?.wallStyle ?? "wall");
    }
    return 0;
  };
  for (let ly = 0; ly <= h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      const e = ly * w + lx;
      const k = edgeWall(H, e, false);
      if (!k) continue;
      const qy = H.host[e] === 1 ? 2 * ly : 2 * ly - 1;
      setQ(2 * lx, qy, k);
      setQ(2 * lx + 1, qy, k);
    }
  }
  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx <= w; lx++) {
      const e = ly * (w + 1) + lx;
      const k = edgeWall(V, e, false);
      if (!k) continue;
      const qx = V.host[e] === 1 ? 2 * lx : 2 * lx - 1;
      setQ(qx, 2 * ly, k);
      setQ(qx, 2 * ly + 1, k);
    }
  }
  // corner posts: for each perpendicular pair of wall-ish edges at a vertex, fill the quarter on both hosts' sides
  for (let vy = 0; vy <= h; vy++) {
    for (let vx = 0; vx <= w; vx++) {
      const hs: Array<[number, number]> = [];
      for (const ex of [vx - 1, vx]) {
        if (ex < 0 || ex >= w) continue;
        const e = vy * w + ex;
        const k = edgeWall(H, e, false);
        if (k) hs.push([k, H.host[e] === 1 ? 2 * vy : 2 * vy - 1]);
      }
      if (hs.length === 0) continue;
      for (const ey of [vy - 1, vy]) {
        if (ey < 0 || ey >= h) continue;
        const e = ey * (w + 1) + vx;
        if (!edgeWall(V, e, false)) continue;
        const qx = V.host[e] === 1 ? 2 * vx : 2 * vx - 1;
        for (const [k, qy] of hs)
          if (qx >= 0 && qy >= 0 && qx < QW && qy < QH && quarters[qy * QW + qx] === 0) setQ(qx, qy, k);
      }
    }
  }
  for (let k = 1; k < styleKeys.length; k++) {
    const rings = traceRings(QW, QH, (qx, qy) => quarters[qy * QW + qx] === k, bx, by, 0.5).map(flat);
    if (rings.length > 0)
      items.push({ layer: "wall", style: styleKeys[k] as string, geom: { rings, closed: true } });
  }

  // ── openings ──
  openings.forEach((o) => {
    if (o.kind === "open") return;
    if (!opts.gmLayer && (o.gmOnly === true || o.kind === "secret_door")) return;
    const g = o.orientation === "h" ? H : V;
    const lx = o.start[0] - bx;
    const ly = o.start[1] - by;
    const e = o.orientation === "h" ? ly * w + lx : ly * (w + 1) + lx;
    const host = g.host[e] === 1 ? 1 : 0;
    let sym: NonNullable<DisplayItem["symbol"]>;
    if (o.orientation === "h") {
      sym = {
        id: `door-${o.kind}`,
        x: o.start[0],
        y: host === 1 ? o.start[1] : o.start[1] - 0.5,
        w: o.width,
        h: 0.5,
        rot: host === 1 ? 0 : 180,
      };
    } else {
      sym = {
        id: `door-${o.kind}`,
        x: host === 1 ? o.start[0] : o.start[0] - 0.5,
        y: o.start[1],
        w: 0.5,
        h: o.width,
        rot: host === 1 ? 90 : 270,
      };
    }
    items.push({
      layer: "opening",
      style: o.kind === "secret_door" ? "secret" : "door",
      symbol: sym,
      ref: o.id,
    });
  });

  // ── steps (EDGE.STAIR): a stair symbol in the lower cell, climbing toward the higher one ──
  const stepSym = (orient: "h" | "v", e: number, lx: number, ly: number): void => {
    const g = orient === "h" ? H : V;
    if (g.kind[e] !== EDGE.STAIR) return;
    const a = orient === "h" ? cellAt(lx, ly - 1) : cellAt(lx - 1, ly);
    const b = cellAt(lx, ly);
    if (a < 0 || b < 0) return;
    const lowerIsA = (level.cells.height[a] as number) < (level.cells.height[b] as number);
    const lo = lowerIsA ? a : b;
    const dir: Side = orient === "h" ? (lowerIsA ? "S" : "N") : lowerIsA ? "E" : "W";
    const x = bx + (lo % w);
    const y = by + Math.floor(lo / w);
    items.push({
      layer: "link",
      style: "steps",
      symbol: { id: "link-stairs", x, y, w: 1, h: 1, rot: DIR_ROT[dir] },
    });
  };
  for (let ly = 0; ly <= h; ly++) for (let lx = 0; lx < w; lx++) stepSym("h", ly * w + lx, lx, ly);
  for (let ly = 0; ly < h; ly++) for (let lx = 0; lx <= w; lx++) stepSym("v", ly * (w + 1) + lx, lx, ly);

  // ── links ──
  const labels = ctx.levelLabels ?? {};
  for (const link of ctx.links ?? []) {
    const lower = link.fromLevel === level.id;
    const upper = link.toLevel === level.id;
    if (!lower && !upper) continue;
    const cells = lower ? link.lowerCells : link.upperCells;
    if (cells.length === 0) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [cx, cy] of cells) {
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx + 1);
      y1 = Math.max(y1, cy + 1);
    }
    const rot = DIR_ROT[link.dir];
    items.push({
      layer: "link",
      style: lower ? "link-up" : "link-down",
      symbol: { id: `link-${link.kind}`, x: x0, y: y0, w: x1 - x0, h: y1 - y0, rot },
      ref: link.id,
    });
    const other = lower ? link.toLevel : link.fromLevel;
    // lower level: tag at the top of the run (where it goes up); upper level: at the bottom of the hole
    const at = lower
      ? (link.lowerCells[link.lowerCells.length - 1] ?? [x0, y0])
      : (link.upperCells[0] ?? [x0, y0]);
    items.push({
      layer: "label",
      style: lower ? "link-badge-up" : "link-badge-down",
      text: { value: labels[other] ?? other, x: at[0] + 0.5, y: at[1] + 0.5, size: "s", anchor: "middle" },
      ref: link.id,
    });
  }

  // ── features (non-blocking first, so rugs lie under tables) ──
  const feats = level.features.filter((f) => {
    if (!opts.gmLayer && f.gmOnly) return false;
    if (!opts.furniture && featureInfo(f.type).category === "furniture") return false;
    return true;
  });
  const ordered = [...feats.filter((f) => !f.blocking), ...feats.filter((f) => f.blocking)];
  for (const f of ordered) {
    const info = featureInfo(f.type);
    const rot = info.wallMounted && f.wall ? SIDE_ROT[f.wall] : f.rotFine;
    // generator 4: a covered stall is drawn as its canopy, upright, with the front eave on the side the customer stands
    const covered = f.stall !== undefined;
    items.push({
      layer: "feature",
      style: f.gmOnly ? "feat-gm" : "feat",
      symbol: covered
        ? { id: `feat-stall_cover_${f.stall?.front ?? "S"}`, x: f.at[0], y: f.at[1], w: f.size[0], h: f.size[1], rot: 0 }
        : { id: `feat-${f.type}`, x: f.at[0], y: f.at[1], w: f.size[0], h: f.size[1], rot },
      ref: f.id,
    });
  }

  // ── roof plan of buildings (structures): roof outline dashed, ridge lines solid, chimneys and porch roofs ──
  for (const st of level.structures ?? []) {
    if (st.kind !== "building" || st.roof.type === "none") continue;
    const box = (x: number, y: number, w: number, h: number): number[] => [
      x,
      y,
      x + w,
      y,
      x + w,
      y + h,
      x,
      y + h,
      x,
      y,
    ];
    const rings: number[][] = [];
    const ridges: number[][] = [];
    const multi = (st.volumes?.length ?? 0) > 1 || (st.volumes ?? []).some((v) => v.roof.layers.length > 1);
    if (st.volumes && (multi || st.roof.type !== "gable")) {
      // volumes: each set-in storey's wall line, then each roof layer's plan (layers step in from the top storey)
      for (const v of st.volumes) {
        let prev: { x: number; y: number; w: number; h: number } | null = null;
        for (const s of v.storeys) {
          const r = s.rect;
          if (!prev || r.x !== prev.x || r.y !== prev.y || r.w !== prev.w || r.h !== prev.h)
            rings.push(box(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1));
          prev = r;
        }
        const top = v.storeys[v.storeys.length - 1];
        if (!top) continue;
        let rect = { ...top.rect };
        v.roof.layers.forEach((layer, li) => {
          if (layer.type === "gable") {
            for (const wg of li === 0 ? v.rects : [{ ...rect, ridge: layer.ridge }]) {
              const g = gableRoof(wg);
              rings.push(box(g.outline.x, g.outline.y, g.outline.w, g.outline.h));
              ridges.push([...g.ridge]);
            }
          } else if (layer.type === "hip" || layer.type === "shed") {
            const g = layer.type === "hip" ? hipRoof(rect) : shedRoof(rect, layer.low);
            rings.push(box(g.outline.x, g.outline.y, g.outline.w, g.outline.h));
            for (const rg of g.ridges) ridges.push([...rg]);
          } else if (layer.type === "skirt" || layer.type === "stepped") {
            const g = ringLayer(rect, layer.courses, layer.type === "stepped" ? "step" : "slope", li === 0);
            rings.push(box(g.outline.x, g.outline.y, g.outline.w, g.outline.h));
            if (g.inner) {
              rings.push(box(g.inner.x, g.inner.y, g.inner.w, g.inner.h));
              rect = g.inner;
            }
          } else if (layer.type === "spire") {
            const sh = spireShell({ x: rect.x - 0.5, y: rect.y - 0.5, w: rect.w + 1, h: rect.h + 1 });
            for (const c of sh.courses) rings.push(box(c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0));
            const f = sh.finial;
            ridges.push([f.x - 0.3, f.y, f.x + 0.3, f.y], [f.x, f.y - 0.3, f.x, f.y + 0.3]);
          } else if (layer.type === "flat")
            rings.push(box(rect.x - 0.5, rect.y - 0.5, rect.w + 1, rect.h + 1));
        });
      }
    } else if (st.roof.type === "gable" && st.wings.length > 0) {
      for (const wg of st.wings) {
        const g = gableRoof(wg);
        rings.push(box(g.outline.x, g.outline.y, g.outline.w, g.outline.h));
        ridges.push([...g.ridge]);
      }
    } else {
      const a = level.areas.find((ar) => ar.id === st.id);
      for (const r of a?.outline ?? []) rings.push(flat(r.map((p) => [p[0], p[1]])));
    }
    for (const p of st.porches) {
      if (!p.roof || p.cells.length === 0) continue;
      const xs = p.cells.map((c) => c[0]);
      const ys = p.cells.map((c) => c[1]);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      rings.push(box(x0, y0, Math.max(...xs) - x0 + 1, Math.max(...ys) - y0 + 1));
    }
    for (const c of st.chimneys) rings.push(box(c.at[0] + 0.2, c.at[1] + 0.2, 0.6, 0.6));
    items.push({ layer: "area_outline", style: "roof-outline", geom: { rings, closed: true }, ref: st.id });
    if (ridges.length > 0)
      items.push({
        layer: "area_outline",
        style: "roof-ridge",
        geom: { rings: ridges, closed: false },
        ref: st.id,
      });
  }

  // ── zone outlines ──
  for (const a of level.areas) {
    if (a.kind !== "zone" || a.cellCount === 0) continue;
    items.push({
      layer: "area_outline",
      style: "zone-outline",
      geom: { rings: a.outline.map((r) => flat(r.map((p) => [p[0], p[1]]))), closed: true },
      ref: a.id,
    });
  }

  // ── labels: room numbers / names, plan labels ──
  const covered = new Set<number>();
  for (const f of level.features)
    for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
      for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) covered.add((y - by) * w + (x - bx));
  /** Text strip of `len` characters centred on cell column x (generous: the font has a pixel minimum). */
  const stripHalf = (len: number): number => len * 0.13 + 0.2;
  // plan labels ("Up to the abbey") occupy their row too: room badges and names keep off them
  const texted = new Set<number>();
  for (const l of level.labels) {
    const cx = l.at[0] + 0.5;
    const half = stripHalf(l.text.length);
    for (let x = Math.floor(cx - half); x <= Math.floor(cx + half - 1e-9); x++)
      if (x >= bx && x < bx + w && l.at[1] >= by && l.at[1] < by + h)
        texted.add((l.at[1] - by) * w + (x - bx));
  }
  /** Cell is clear of features, link runs and plan labels (inside the level). */
  const clear = (x: number, y: number): boolean => {
    if (x < bx || y < by || x >= bx + w || y >= by + h) return false;
    const i = (y - by) * w + (x - bx);
    return !covered.has(i) && !texted.has(i) && ((fl[i] as number) & CELL_FLAG.LINK) === 0;
  };
  /**
   * Badge cell: labelAt, else the nearest cell of the area (anchor first, then rings out to 4) whose badge cell is
   * free floor of the area AND whose name strip (when a name is drawn) is clear of features and links — so the
   * name is never overprinted by furniture or by a plan-check marker (markers sit on the feature's cell). Falls
   * back to the nearest free badge cell, then the anchor.
   */
  const badgeCell = (
    a: ResolvedArea,
    ai: number,
    name: { row: 0 | 1; half: number } | null,
  ): readonly [number, number] => {
    if (a.labelAt) return a.labelAt;
    const free = (x: number, y: number): boolean => {
      if (x < bx || y < by || x >= bx + w || y >= by + h) return false;
      const i = (y - by) * w + (x - bx);
      return level.cells.area[i] === ai + 1 && isFloor(i) && clear(x, y);
    };
    const nameClear = (x: number, y: number): boolean => {
      if (!name) return true;
      const cx = x + 0.5;
      for (let c = Math.floor(cx - name.half); c <= Math.floor(cx + name.half - 1e-9); c++)
        if (!clear(c, y + name.row)) return false;
      return true;
    };
    const [ax, ay] = a.anchor;
    const search = (ok: (x: number, y: number) => boolean, max: number): readonly [number, number] | null => {
      if (ok(ax, ay)) return a.anchor;
      for (let r = 1; r <= max; r++)
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++)
            if (Math.max(Math.abs(dx), Math.abs(dy)) === r && ok(ax + dx, ay + dy)) return [ax + dx, ay + dy];
      return null;
    };
    return (name ? search((x, y) => free(x, y) && nameClear(x, y), 4) : null) ?? search(free, 3) ?? a.anchor;
  };
  for (const [ai, a] of level.areas.entries()) {
    if (a.cellCount === 0) continue;
    const drawName = opts.roomNames && a.name !== undefined && (a.key !== undefined || a.kind !== "corridor");
    const numbered = opts.roomNumbers && a.key !== undefined;
    // name plate half-width in cells (generous: the font has a pixel minimum when zoomed out)
    const at = badgeCell(
      a,
      ai,
      drawName && a.name !== undefined ? { row: numbered ? 1 : 0, half: stripHalf(a.name.length) } : null,
    );
    if (opts.roomNumbers && a.key !== undefined) {
      items.push({
        layer: "label",
        style: "room-number",
        text: { value: a.key, x: at[0] + 0.5, y: at[1] + 0.5, size: "m", anchor: "middle" },
        ref: a.id,
      });
    }
    if (drawName && a.name !== undefined) {
      const dy = numbered ? 1.15 : 0.5;
      items.push({
        layer: "label",
        style: "room-name",
        text: { value: a.name, x: at[0] + 0.5, y: at[1] + dy, size: "s", anchor: "middle" },
        ref: a.id,
      });
    }
  }
  if (level.waterLevel !== undefined) {
    // TaleSpire water is a board-wide plane the slab cannot carry: same wording as the paste note (above the bottom
    // of the slab, which is the level's foundation or its lowest floor, whichever is lower)
    let lowest = 0;
    for (let i = 0; i < w * h; i++)
      if (st[i] === CELL.OPEN) lowest = Math.min(lowest, (level.cells.height[i] as number) / 4);
    for (const b of level.bridges ?? []) for (const q of b.under) lowest = Math.min(lowest, q / 4);
    const bottom = level.elevation + Math.min(lowest, -(level.foundation ?? 0));
    const rel = level.waterLevel - bottom;
    items.push({
      layer: "label",
      style: "label",
      text: {
        value: `Water: set to about ${rel} tiles above the slab bottom`,
        x: bx + 0.5,
        y: by + 0.5,
        size: "s",
        anchor: "start",
      },
      ref: "water-level",
    });
  }
  for (const l of level.labels) {
    items.push({
      layer: "label",
      style: "label",
      text: { value: l.text, x: l.at[0] + 0.5, y: l.at[1] + 0.5, size: l.size, anchor: "middle" },
      ref: l.id,
    });
  }

  // stable sort into paint order
  const rank = new Map(LAYER_ORDER.map((l, i) => [l, i]));
  const sorted = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (rank.get(a.it.layer) ?? 0) - (rank.get(b.it.layer) ?? 0) || a.i - b.i)
    .map((x) => x.it);
  return { levelId: level.id, viewBox: { x: bx, y: by, w, h }, items: sorted };
}

/**
 * Box around what is actually drawn on the level (floors, walls, openings, links, features; not the rock/void
 * ground or the grid), padded by `pad` cells and clamped to the level's viewBox. Used to fit small previews to
 * the content: a level whose rooms sit on one edge of a big level should not be a sliver in a sea of nothing.
 * Falls back to the full viewBox when nothing but ground is drawn.
 */
export function contentViewBox(list: DisplayList, pad = 1): DisplayList["viewBox"] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (ax: number, ay: number, bx2: number, by2: number): void => {
    x0 = Math.min(x0, ax);
    y0 = Math.min(y0, ay);
    x1 = Math.max(x1, bx2);
    y1 = Math.max(y1, by2);
  };
  for (const it of list.items) {
    if (it.layer === "ground" || it.layer === "grid" || it.layer === "selection") continue;
    if (it.geom) {
      for (const r of it.geom.rings)
        for (let i = 0; i + 1 < r.length; i += 2)
          add(r[i] as number, r[i + 1] as number, r[i] as number, r[i + 1] as number);
    } else if (it.symbol) {
      const s = it.symbol;
      add(s.x, s.y, s.x + s.w, s.y + s.h);
    }
  }
  const vb = list.viewBox;
  if (!Number.isFinite(x0)) return { ...vb };
  const nx0 = Math.max(vb.x, Math.floor(x0) - pad);
  const ny0 = Math.max(vb.y, Math.floor(y0) - pad);
  const nx1 = Math.min(vb.x + vb.w, Math.ceil(x1) + pad);
  const ny1 = Math.min(vb.y + vb.h, Math.ceil(y1) + pad);
  return { x: nx0, y: ny0, w: Math.max(1, nx1 - nx0), h: Math.max(1, ny1 - ny0) };
}

/** Convenience: display list of one level of a resolved plan, with links and level labels filled in. */
export function buildPlanDisplayList(
  resolved: ResolvedPlan,
  levelId: LevelId,
  opts: Partial<DisplayOptions> = {},
  entryLevel?: LevelId,
): DisplayList | null {
  const level = resolved.levels.find((l) => l.id === levelId);
  if (!level) return null;
  return buildDisplayList(
    level,
    { ...DEFAULT_DISPLAY_OPTIONS, ...opts },
    { links: resolved.links, levelLabels: levelLabels(resolved, entryLevel) },
  );
}
