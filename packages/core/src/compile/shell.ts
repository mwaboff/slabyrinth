/**
 * The solid shell of a built interior, generator 4 (switch `solidShell`).
 *
 * A dungeon cut into rock reads from above as rooms in a mass with a flat cap flush with the wall tops. Generator 3
 * built the rooms and left the SOLID cells round them as nothing, so each room was a thin-walled box floating in the
 * void (outer shell 0.5 tiles, the reference interior has 2.5). This module plans the shell; compile/realize/solidShell.ts lays it:
 *
 *  - CAP: every SOLID cell within three cells of a room wall (a quarter of the outermost ring cut back by seeded noise,
 *    so the outline is not a ruled rectangle) takes a flat cap tile whose top is flush with the wall tops. Big tiles
 *    (the palette's largest square piece, 2x2) tile it. Nothing is stacked under the cap: a hollow under a roof of
 *    tiles cannot be seen from above, so the mass costs one tile per four cells.
 *  - SKIRT: the outer edge of the cap is closed by a thin wall of the level's own wall style from the lowest floor up
 *    to the cap, so from beside the board the shell reads as a solid block, not a plate on stilts.
 *
 * Shared mass (gen/solidMass.ts): the cave rock mass (gen/cavewall.ts) dresses the solid cells behind natural rock walls,
 * the shell those behind built walls. Each solid cell goes to the dresser of the nearest wall (`ownSolid`), so a level of
 * rooms and caves has no gutter between cap and rock and no cell with both; the shell tells the realizer which cells the
 * rock may take (`Shell.rockMayTake`). Outline cleanup (teeth, notches, lumps) is the shared helpers too.
 *
 * Levels stacked in one slab: a cap cell over an open cell of a level below is left out (it would hide that room, and
 * the lower level must stay visible where it sticks out or opens under a hole), and a cap cell under a higher level's
 * floor is left out (hidden, saves pieces).
 *
 * planShell is a list of steps over the level's cells (local indices): the wall faces, the cap top, the rings, the
 * blocks and the budget, the outline cleanup and the skirt, and the strips of a tidy interior.
 */
import type { Side, ThemeId } from "../contracts/plan";
import type { ResolvedLevel, ResolvedPlan } from "../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../contracts/resolved";
import { NEIGHBOURS4 as STEPS4, SIDES, SIDE_STEP } from "../gen/gridGeometry";
import { ValueNoise } from "../gen/noise";
import { OWNER, dropLumps, fillNotches, ownSolid, trimTeeth, type CellGrid } from "../gen/solidMass";
import { THEME_WALL_STYLE } from "../gen/wallStyles";
import { h32 } from "../util/hash";
import { cellIndex, sideEdgeIndex, sideOrient } from "../resolve/levelGrid";
import type { WallFaces } from "../resolve/wallFaces";
import { spanCellAt } from "../resolve/wallspan";
import { roughCells } from "../resolve/wallTops";

export const SHELL = {
  /** Rings of solid cells that may be capped (1 = the cells touching a wall). Generator 4: two, 2x2 blocks may add a third. */
  reach: 2,
  /** Chance a cell of ring 2 is reached (value noise above 1 - this); blocks then take whole 2x2 cells. */
  keep: [0.92] as const,
  /** A shell component (8-connected) under this many cells is an isolated lump and is dropped. */
  minComponent: 12,
  /** Fill one-cell notches and holes, trim one-cell teeth, drop lumps (off only to measure the older outline). */
  cleanup: true as boolean,
  /** Ring cells a 2x2 block must hold to be capped, tried in order until the level is within budget (5 = ring 1 only). */
  blockMin: [2, 3, 5] as readonly number[],
  /** Pieces one level's shell may take (cap tiles + skirt pieces): the shell must not swallow the board. */
  budget: 260,
  /** Tiles the cap stands above the wall tops it meets (no shared top face, so no z-fighting). */
  lift: 0.04,
} as const;

export interface ShellEdge {
  orient: "h" | "v";
  /** Edge start vertex in plan coordinates (the realizer's `x, y` for the edge). */
  x: number;
  y: number;
  /** Cell the skirt stands in (the cap cell) and which side of it. */
  hostX: number;
  hostY: number;
  hostFirst: boolean;
  planSide: Side;
  /** Top of the cap cell the skirt closes (the skirt reaches up to a cap thickness below it). */
  top: number;
}

export interface Shell {
  /** Capped cells by cell index (resolve/levelGrid.ts `cellIndex`; the cell's plan coordinates are in the entry). */
  cells: Map<number, { x: number; y: number; theme: ThemeId; ring: number; top: number }>;
  /**
   * Absolute top of the flat cap (world tiles): the most common wall top of the level, a hair higher so a cap tile
   * never shares a top face with the wall piece standing in the same cell. The cells against a wall (ring 1) take the
   * top of their own wall instead, so a lowered stretch of wall shows as a lowered stretch of the shell's edge.
   */
  top: number;
  /** Absolute foot of the skirt (the lowest floor's underside). */
  base: number;
  edges: ShellEdge[];
  /**
   * Tidy interiors (timber, plaster) get no cap and no skirt, but a one-cell solid strip between two rooms (or a room and
   * the corridor), at least one of them tidy, is closed flush at wall-top height so the two rooms read as sharing one
   * thick wall: single tiles.
   * A strip is the top of the wall it closes: `style` and `theme` are that wall's (the tallest one it backs onto), and
   * the compiler lays the wall's top piece (palette/wallTop.ts), never a room's floor.
   */
  strips: Array<{ x: number; y: number; theme: ThemeId; top: number; style: string }>;
  /** Wall style of the skirt (the most common style of the walls that border the shell). */
  style: string;
  theme: ThemeId;
  /**
   * May the cave rock mass stand on this solid cell (plan coordinates)? False for the cells the shell owns, true for
   * the cells nearest a natural rock wall and for cells nearest no wall (gen/solidMass.ts `ownSolid`).
   */
  rockMayTake: (x: number, y: number) => boolean;
}

/**
 * A level carved into a solid mass: it has SOLID cells and no buildings (a building builds its own shell,
 * compile/structure.ts). Only such a level gets a shell, and only its rough interiors get broken wall tops.
 */
export function isCarvedLevel(L: ResolvedLevel): boolean {
  return !L.structures?.length && L.cells.state.some((s) => s === CELL.SOLID);
}

type Dir = readonly [dx: number, dy: number, side: Side];
/** The four sides of a cell with the step across each, in SIDES order (gen/gridGeometry.ts). */
const DIRS: readonly Dir[] = SIDES.map((s) => [SIDE_STEP[s][0], SIDE_STEP[s][1], s]);

/** One level's cells as the shell planner reads them: local indices, -1 for a cell outside the bounds. */
interface ShellGrid extends CellGrid {
  readonly L: ResolvedLevel;
  readonly defaultTheme: ThemeId;
  /** Local index of a cell, -1 outside the bounds. */
  at(lx: number, ly: number): number;
  /** CELL state of a local index, -1 for -1. */
  state(i: number): number;
}

function shellGrid(L: ResolvedLevel, defaultTheme: ThemeId): ShellGrid {
  const { w, h } = L.bounds;
  return {
    L,
    w,
    h,
    defaultTheme,
    at: (lx, ly) => cellIndex(L.bounds, lx, ly),
    state: (i) => (i < 0 ? -1 : (L.cells.state[i] ?? CELL.VOID)),
  };
}

/**
 * Plans the shell of one level, or null when it has none: no SOLID cells or no thin wall against rock. Only generators
 * with the `solidShell` switch have a shell; the realize pass that calls this checks it (compile/realize/solidShell.ts).
 * `walls` are the level's wall faces (resolve/wallFaces.ts); the ones a building claims are its own shell's.
 */
export function planShell(
  resolved: ResolvedPlan,
  L: ResolvedLevel,
  seed: number,
  walls: WallFaces,
  defaultTheme: ThemeId,
): Shell | null {
  const g = shellGrid(L, defaultTheme);
  if (!L.cells.state.some((s, i) => i < g.w * g.h && s === CELL.SOLID)) return null;
  const faces = shellFaces(g, walls);
  if (faces.seeds.size === 0 && faces.tidy.size === 0) return null;
  // the solid cells are shared with the cave rock mass (gen/solidMass.ts): each belongs to the dresser of the nearest
  // wall, so the cap and the rock meet with no gutter between them and no cell is dressed twice
  const owner = ownSolid(g, (i) => g.state(i) === CELL.SOLID, faces.rockFace, [
    ...faces.seeds.keys(),
    ...faces.tidy.keys(),
  ]);
  const rockOwns = (k: number): boolean => owner[k] === OWNER.rock;
  // a one-cell gap between two rooms of a kept-up building is the top of their shared wall, not the cap's
  const strip = stripCells(g, faces, rockOwns);
  const cap: CapPlan = {
    g,
    faces,
    rockOwns,
    strip,
    ...capTop(faces, strip),
    theme: new Map(),
    stacked: stackedLevels(resolved, L),
  };
  const ring = reachRings(cap, seed);

  // the budget: the pieces the cap (2x2 tiles with singles at the rim, about 2.5 cells a piece) and the skirt (2 edges a
  // piece) take; a level over it gives up its outer blocks (blockMin 3, then 5 = only the ring against the walls)
  let assembled: { cells: Shell["cells"]; edges: ShellEdge[] } = { cells: new Map(), edges: [] };
  for (const blockMin of SHELL.blockMin) {
    const a = assemble(cap, blocks(cap, ring, blockMin));
    assembled = a;
    // cells that stand lower than the flat cap are single tiles; the rest tile about 3 cells to a piece
    const singles = [...a.cells.values()].filter((c) => c.top !== cap.top).length;
    const pieces = singles + Math.ceil((a.cells.size - singles) / 3) + Math.ceil(a.edges.length / 1.6);
    if (pieces <= SHELL.budget) break;
  }
  const { cells, edges } = assembled;
  const strips = tidyStrips(cap, cells);
  if (cells.size === 0 && strips.length === 0) return null;
  return {
    cells,
    top: Number.isFinite(cap.flat) ? cap.top : 0,
    base: L.elevation + Math.min(0, faces.floorLow),
    edges,
    strips,
    style: cap.style,
    theme: [...cells.values()][0]?.theme ?? strips[0]?.theme ?? defaultTheme,
    rockMayTake: (x, y) => {
      const k = g.at(x - L.bounds.x, y - L.bounds.y);
      return k < 0 || owner[k] !== OWNER.built;
    },
  };
}

// ── wall faces ──

/** The tallest thin wall a solid cell backs onto: its room's theme, its style and its top. */
interface BackedWall {
  theme: ThemeId;
  style: string;
  top: number;
}

/** What the thin walls round a level's rooms say about the solid cells behind them (local indices). */
interface ShellFaces {
  /** Solid cells against a thin wall of a rough room. */
  seeds: Map<number, BackedWall>;
  /** Solid cells against a thin wall of a tidy room: the tallest such wall's top, style and room theme. */
  tidy: Map<number, BackedWall>;
  /** Solid cells touching an open cell with no wall between (left uncapped). */
  bare: Set<number>;
  /** Solid cells behind a natural rock wall (the cave work owns them), once per face. */
  rockFace: number[];
  /** The lowest floor of the level (relative tiles, at most 0). */
  floorLow: number;
  /** Rough interior cells (1; resolve/wallTops.ts roughCells). */
  rough: Uint8Array;
}

/**
 * The level's wall faces (resolve/wallFaces.ts) as the shell reads them: the faces of WALL and OPENING edges between a
 * room and a SOLID mass cell that no building claims. Natural rock (the wall-style trait) is the cave work's; the rest
 * keep, per solid cell, the tallest wall it backs onto (the cap sits flush with it), in the faces' line order.
 * Also the bare cells (solid beside a room with no wall between) and the lowest floor, read from the cells.
 */
function shellFaces(g: ShellGrid, walls: WallFaces): ShellFaces {
  const { L, w, h } = g;
  const faces: ShellFaces = {
    seeds: new Map(),
    tidy: new Map(),
    bare: new Set(),
    rockFace: [],
    floorLow: 0,
    rough: roughCells(L),
  };
  const { seeds, tidy, bare, rockFace, rough } = faces;
  for (let ly = 0; ly < h; ly++)
    for (let lx = 0; lx < w; lx++) {
      const i = ly * w + lx;
      if (g.state(i) !== CELL.OPEN) continue;
      const sc = spanCellAt(L, i);
      if (sc.floor) faces.floorLow = Math.min(faces.floorLow, sc.height);
      for (const [dx, dy, side] of DIRS) {
        const j = g.at(lx + dx, ly + dy);
        if (g.state(j) !== CELL.SOLID) continue;
        const kind = (sideOrient(side) === "h" ? L.hEdges : L.vEdges).kind[sideEdgeIndex(g, lx, ly, side)];
        if (kind !== EDGE.WALL && kind !== EDGE.OPENING) bare.add(j);
      }
    }
  for (const f of walls.list) {
    const mass = f.mass;
    if (f.claimed || !mass?.solid) continue;
    const room = mass === f.host ? f.other : f.host;
    if (!room.open) continue;
    // natural rock (gen/wallStyles.ts): the cave work owns the solid cells behind it
    if (f.natural) {
      rockFace.push(mass.index);
      continue;
    }
    // the cap sits flush with the tallest wall it backs onto; a tidy interior (ResolvedArea.finish, read through
    // resolve/wallTops.ts roughCells) gets no cap and no skirt, only the strips, which are that wall's top
    const faced = rough[room.index] === 1 ? seeds : tidy;
    const prev = faced.get(mass.index);
    if (!prev || f.top > prev.top) faced.set(mass.index, { theme: f.theme, style: f.style, top: f.top });
  }
  return faces;
}

// ── the cap ──

/** Everything the cap steps share. */
interface CapPlan {
  g: ShellGrid;
  faces: ShellFaces;
  /** The cave rock mass owns this solid cell (gen/solidMass.ts ownSolid): the shell leaves it. */
  rockOwns: (k: number) => boolean;
  /** The tidy strips (stripCells): tops of shared walls, never capped. */
  strip: ReadonlySet<number>;
  /** The most common wall top among the seeds (ties: the higher). */
  flat: number;
  /** The flat cap's top: `flat` plus the lift. */
  top: number;
  /** The skirt's wall style: the most common style among the seeds (ties: the first by name). */
  style: string;
  /** Theme of each capped cell; the ring, block and notch steps add to it as they reach cells. */
  theme: Map<number, ThemeId>;
  stacked: StackedLevels;
}

/** May the shell dress this solid cell (not bare, not the rock's)? */
const dressable = (g: ShellGrid, faces: ShellFaces, rockOwns: (k: number) => boolean, k: number): boolean =>
  k >= 0 && g.state(k) === CELL.SOLID && !faces.bare.has(k) && !rockOwns(k);

/** May the cap take this solid cell (dressable and not a strip)? */
const cappable = (cap: CapPlan, k: number): boolean =>
  dressable(cap.g, cap.faces, cap.rockOwns, k) && !cap.strip.has(k);

/** The cap top: the most common wall top among the seeds (ties: the higher), so a lowered run sits below the cap. */
function capTop(faces: ShellFaces, strip: ReadonlySet<number>): { flat: number; top: number; style: string } {
  const tally = new Map<number, number>();
  const styles = new Map<string, number>();
  for (const [j, s] of faces.seeds) {
    if (strip.has(j)) continue;
    tally.set(s.top, (tally.get(s.top) ?? 0) + 1);
    styles.set(s.style, (styles.get(s.style) ?? 0) + 1);
  }
  let flat = -Infinity;
  let best = -1;
  for (const [t, c] of tally) if (c > best || (c === best && t > flat)) [flat, best] = [t, c];
  let style: string = THEME_WALL_STYLE;
  let sBest = -1;
  for (const [s, c] of [...styles].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    if (c > sBest) [style, sBest] = [s, c];
  return { flat, top: flat + SHELL.lift, style };
}

/** The rings: ring 1 is every seed the cap may take, each further ring the noisy part of the cells round the last. */
function reachRings(cap: CapPlan, seed: number): Map<number, number> {
  const { g, faces, theme } = cap;
  const { L, w, defaultTheme } = g;
  const noise = new ValueNoise(h32(`${seed}:${L.id}:shell`));
  const ring = new Map<number, number>();
  for (const [j, s] of faces.seeds) {
    if (faces.bare.has(j) || cap.rockOwns(j) || cap.strip.has(j)) continue;
    ring.set(j, 1);
    theme.set(j, s.theme);
  }
  for (let r = 2; r <= SHELL.reach; r++) {
    const add: Array<[number, ThemeId]> = [];
    for (const [i, rr] of ring) {
      if (rr !== r - 1) continue;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const k = g.at(x + dx, y + dy);
          if (ring.has(k) || !cappable(cap, k)) continue;
          const kx = k % w;
          const ky = (k - kx) / w;
          const n =
            noise.sample(kx / 2.5, ky / 2.5) * 0.7 +
            (h32(`${seed}:${L.id}:shellcell:${k}`) / 4294967296) * 0.3;
          if (n >= 1 - (SHELL.keep[r - 2] ?? 0.5)) add.push([k, theme.get(i) ?? defaultTheme]);
        }
    }
    for (const [k, t] of add) {
      if (ring.has(k)) continue;
      ring.set(k, r);
      theme.set(k, t);
    }
  }
  return ring;
}

/**
 * The blocks: outer rings are laid in 2x2 blocks on the level's own even lattice (a block is kept when at least
 * `blockMin` of its four cells were reached by the rings and all four may be capped), so the outline steps in twos and the
 * cap needs big tiles; the ring-1 cells against the walls are always capped, in tiles of their own.
 */
function blocks(cap: CapPlan, ring: ReadonlyMap<number, number>, blockMin: number): Map<number, number> {
  const { g, theme } = cap;
  const capRing = new Map<number, number>();
  for (const [i, r] of ring) if (r === 1) capRing.set(i, 1);
  for (let by = 0; by < g.h; by += 2)
    for (let bx = 0; bx < g.w; bx += 2) {
      const ks = [g.at(bx, by), g.at(bx + 1, by), g.at(bx, by + 1), g.at(bx + 1, by + 1)];
      if (ks.some((k) => !cappable(cap, k))) continue;
      const reached = ks.filter((k) => ring.has(k));
      if (reached.length < blockMin) continue;
      const near = theme.get(reached[0] as number) ?? g.defaultTheme;
      for (const k of ks) {
        if (!capRing.has(k)) capRing.set(k, ring.get(k) ?? SHELL.reach + 1);
        if (!theme.has(k)) theme.set(k, near);
      }
    }
  return capRing;
}

/** The cap cells (plan coordinates) and the skirt round them, from the cells the blocks chose. */
function assemble(cap: CapPlan, capRing: Map<number, number>): { cells: Shell["cells"]; edges: ShellEdge[] } {
  const { g, faces, theme, stacked } = cap;
  const { L, w, defaultTheme } = g;
  const hiddenNeighbour = new Set<number>();
  // eligible cells: solid, not bare, clear of rock, not hidden (cells under a higher floor or over a lower room)
  const eligible = (i: number): boolean => {
    if (!cappable(cap, i)) return false;
    const x = i % w;
    const y = (i - x) / w;
    return (
      !stacked.hiddenAbove(L.bounds.x + x, L.bounds.y + y, cap.top) &&
      !stacked.hidesBelow(L.bounds.x + x, L.bounds.y + y)
    );
  };
  const set = new Map<number, number>(); // local index -> ring
  for (const [i, r] of capRing) {
    const x = i % w;
    const y = (i - x) / w;
    if (stacked.hiddenAbove(L.bounds.x + x, L.bounds.y + y, cap.top)) {
      hiddenNeighbour.add(i);
      continue;
    }
    if (stacked.hidesBelow(L.bounds.x + x, L.bounds.y + y)) continue;
    set.set(i, r);
  }
  // outline cleanup (gen/solidMass.ts, shared with the cave outline): teeth of the outer rings, notches and holes, and
  // isolated lumps (components with no cell against a wall, or under minComponent cells)
  if (SHELL.cleanup) {
    trimTeeth(g, set, (_i, r) => r > 1);
    fillNotches(g, set, eligible, (k, near) => {
      theme.set(k, theme.get(near) ?? defaultTheme);
      return 2;
    });
    dropLumps(g, set, (_i, r) => r === 1, SHELL.minComponent);
  }
  const cells: Shell["cells"] = new Map();
  for (const [i, r] of set) {
    const x = i % w;
    const y = (i - x) / w;
    const gx = L.bounds.x + x;
    const gy = L.bounds.y + y;
    cells.set(i, {
      x: gx,
      y: gy,
      theme: theme.get(i) ?? defaultTheme,
      ring: r,
      top: r === 1 ? (faces.seeds.get(i)?.top ?? cap.flat) + SHELL.lift : cap.top,
    });
  }
  return { cells, edges: skirtOf(g, cells, hiddenNeighbour) };
}

/** The skirt: the outer edge of the cap (not the board's own edge, not toward an open or a hidden cell). */
function skirtOf(g: ShellGrid, cells: Shell["cells"], hiddenNeighbour: ReadonlySet<number>): ShellEdge[] {
  const { L } = g;
  const edges: ShellEdge[] = [];
  for (const c of [...cells.values()].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const lx = c.x - L.bounds.x;
    const ly = c.y - L.bounds.y;
    for (const [dx, dy, side] of DIRS) {
      const j = g.at(lx + dx, ly + dy);
      if (j < 0) continue; // the board's own edge: slabs are tiled beside each other
      if (cells.has(j) || g.state(j) === CELL.OPEN || hiddenNeighbour.has(j)) continue;
      const hostFirst = side === "S" || side === "E";
      const e = { hostX: c.x, hostY: c.y, hostFirst, planSide: side, top: c.top };
      if (side === "N") edges.push({ orient: "h", x: c.x, y: c.y, ...e });
      else if (side === "S") edges.push({ orient: "h", x: c.x, y: c.y + 1, ...e });
      else if (side === "W") edges.push({ orient: "v", x: c.x, y: c.y, ...e });
      else edges.push({ orient: "v", x: c.x + 1, y: c.y, ...e });
    }
  }
  return edges;
}

// ── other levels in the slab ──

/** What the other levels stacked in the slab hide or need to show (plan coordinates). */
interface StackedLevels {
  /** A higher level's floor stands over the cell within four tiles of the cap top (the cap would be hidden). */
  hiddenAbove(gx: number, gy: number, capTop: number): boolean;
  /** A lower level has an open cell under it (a cap there would hide that room). */
  hidesBelow(gx: number, gy: number): boolean;
}

function stackedLevels(resolved: ResolvedPlan, L: ResolvedLevel): StackedLevels {
  const above = resolved.levels.filter((o) => o.id !== L.id && o.elevation > L.elevation);
  const below = resolved.levels.filter((o) => o.id !== L.id && o.elevation < L.elevation);
  const otherAt = (o: ResolvedLevel, gx: number, gy: number): number =>
    cellIndex(o.bounds, gx - o.bounds.x, gy - o.bounds.y);
  return {
    hiddenAbove: (gx, gy, capTop) =>
      above.some((o) => {
        const k = otherAt(o, gx, gy);
        if (k < 0 || o.cells.state[k] !== CELL.OPEN || ((o.cells.flags[k] ?? 0) & CELL_FLAG.NO_FLOOR) !== 0)
          return false;
        // within four tiles: a higher floor further up still hides the cap, but a gap that big is a different map
        return o.elevation - capTop <= 4;
      }),
    hidesBelow: (gx, gy) =>
      below.some((o) => {
        const k = otherAt(o, gx, gy);
        return k >= 0 && o.cells.state[k] === CELL.OPEN;
      }),
  };
}

// ── tidy strips ──

/**
 * The one-cell solid strips of a kept-up building: a cell between two rooms (or a room and the corridor) where at least
 * one of them is tidy, then the cells that join such strips. It is the top of the two rooms' shared wall: an abandoned
 * (rough) room beside a tidy one does not turn the wall they share into the earth cap of a carved dungeon. Two rough
 * rooms keep the cap between them (the rock mass of a carved level).
 */
function stripCells(g: ShellGrid, faces: ShellFaces, rockOwns: (k: number) => boolean): Set<number> {
  const { w, h } = g;
  const { rough } = faces;
  const open = (k: number): boolean => k >= 0 && g.state(k) === CELL.OPEN;
  const tidyOpen = (k: number): boolean => open(k) && rough[k] !== 1;
  const strip = new Set<number>();
  for (let pass = 0; pass < 4; pass++) {
    for (let k = 0; k < w * h; k++) {
      if (strip.has(k) || !dressable(g, faces, rockOwns, k)) continue;
      const x = k % w;
      const y = (k - x) / w;
      const pairs: Array<[number, number]> = [
        [g.at(x - 1, y), g.at(x + 1, y)],
        [g.at(x, y - 1), g.at(x, y + 1)],
      ];
      const ok = pairs.some(([a, b]) =>
        pass === 0
          ? (tidyOpen(a) && open(b)) || (open(a) && tidyOpen(b))
          : (tidyOpen(a) || strip.has(a)) && (tidyOpen(b) || strip.has(b)),
      );
      if (ok) strip.add(k);
    }
  }
  return strip;
}

/** The strips closed flush at wall-top height (the ones not hidden by a level above or hiding one below). */
function tidyStrips(cap: CapPlan, cells: Shell["cells"]): Shell["strips"] {
  const { g, faces, stacked, strip } = cap;
  const { L, w, defaultTheme } = g;
  const { tidy, seeds } = faces;
  const taller = (a: BackedWall | undefined, b: BackedWall | undefined): BackedWall | undefined =>
    b && (!a || b.top > a.top) ? b : a;
  const fallback: BackedWall = [...tidy.values()].reduce<BackedWall | undefined>(taller, undefined) ?? {
    theme: defaultTheme,
    style: THEME_WALL_STYLE,
    top: 0,
  };
  const strips: Shell["strips"] = [];
  for (const k of [...strip].sort((a, b) => a - b)) {
    const x = k % w;
    const y = (k - x) / w;
    const gx = L.bounds.x + x;
    const gy = L.bounds.y + y;
    if (cells.has(k) || stacked.hiddenAbove(gx, gy, cap.top) || stacked.hidesBelow(gx, gy)) continue;
    // the strip is the top of the tallest wall among this cell's own walls, else among its strip neighbours' (a
    // junction of two strips): its height, its style (the compiler asks the palette for that wall's top) and theme
    let face = taller(tidy.get(k), seeds.get(k));
    if (!face)
      for (const [dx, dy] of STEPS4) {
        const q = g.at(x + dx, y + dy);
        if (q >= 0) face = taller(face, tidy.get(q));
      }
    const { theme, style, top } = face ?? fallback;
    strips.push({ x: gx, y: gy, theme, top: top + SHELL.lift, style });
  }
  return strips;
}
