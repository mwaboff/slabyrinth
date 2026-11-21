/**
 * The solid shell of a built interior, generator 4 (interior round, item 5, 2026-11-20).
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
 */
import type { Material, Side, ThemeId } from "../contracts/plan";
import type { ResolvedLevel, ResolvedPlan } from "../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../contracts/resolved";
import { ValueNoise } from "../gen/noise";
import { OWNER, dropLumps, fillNotches, ownSolid, trimTeeth, type CellGrid } from "../gen/solidMass";
import { isNaturalWallStyle } from "../gen/wallStyles";
import { h32 } from "../util/hash";
import { areaReferenceHeights, wallSpan, type SpanCell } from "../resolve/wallspan";
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
  /** Capped cells, "x,y" -> theme of the wall they back onto. */
  cells: Map<string, { x: number; y: number; theme: ThemeId; ring: number; top: number }>;
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
   * the corridor) is closed flush at wall-top height so the two rooms read as sharing one thick wall: single tiles.
   */
  strips: Array<{ x: number; y: number; theme: ThemeId; top: number; material: Material | null }>;
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
const DIRS: readonly Dir[] = [
  [0, -1, "N"],
  [1, 0, "E"],
  [0, 1, "S"],
  [-1, 0, "W"],
];

/**
 * Plans the shell of one level, or null when it has none: no SOLID cells or no thin wall against rock. Only generators
 * with the `solidShell` switch have a shell; the realize pass that calls this checks it (compile/realize/solidShell.ts).
 * `claimed` tells which wall edges belong to buildings (their shells are their own).
 */
export function planShell(
  resolved: ResolvedPlan,
  L: ResolvedLevel,
  seed: number,
  claimed: (orient: "h" | "v", edge: number) => boolean,
  defaultTheme: ThemeId,
): Shell | null {
  const { w, h } = L.bounds;
  const at = (lx: number, ly: number): number => (lx < 0 || ly < 0 || lx >= w || ly >= h ? -1 : ly * w + lx);
  const state = (i: number): number => (i < 0 ? -1 : (L.cells.state[i] ?? CELL.VOID));
  let anySolid = false;
  for (let i = 0; i < w * h; i++)
    if (L.cells.state[i] === CELL.SOLID) {
      anySolid = true;
      break;
    }
  if (!anySolid) return null;

  const ref = areaReferenceHeights(L);
  const spanCell = (i: number): SpanCell => {
    if (i < 0) return { open: false, floor: false, height: 0, area: 0, flags: 0 };
    const flags = L.cells.flags[i] ?? 0;
    const open = L.cells.state[i] === CELL.OPEN;
    return {
      open,
      floor: open && (flags & CELL_FLAG.NO_FLOOR) === 0 && (L.cells.material[i] ?? 0) > 0,
      height: (L.cells.height[i] ?? 0) / 4,
      area: L.cells.area[i] ?? 0,
      flags,
    };
  };
  const edgeOf = (lx: number, ly: number, side: Side): { orient: "h" | "v"; e: number } => {
    switch (side) {
      case "N":
        return { orient: "h", e: ly * w + lx };
      case "S":
        return { orient: "h", e: (ly + 1) * w + lx };
      case "W":
        return { orient: "v", e: ly * (w + 1) + lx };
      case "E":
        return { orient: "v", e: ly * (w + 1) + lx + 1 };
    }
  };

  // ── seeds: solid cells that stand against a thin wall of a room ──
  const seeds = new Map<number, { theme: ThemeId; style: string; top: number }>();
  const rough = roughCells(L);
  const tidyTop = new Map<number, number>(); // solid cells against a thin wall of a tidy room -> tallest wall top
  const bare = new Set<number>(); // solid cells touching an open cell with no wall between (left uncapped)
  const rockFace: number[] = [];
  let floorLow = 0;
  for (let ly = 0; ly < h; ly++)
    for (let lx = 0; lx < w; lx++) {
      const i = ly * w + lx;
      if (state(i) !== CELL.OPEN) continue;
      const sc = spanCell(i);
      if (sc.floor) floorLow = Math.min(floorLow, sc.height);
      for (const [dx, dy, side] of DIRS) {
        const j = at(lx + dx, ly + dy);
        if (state(j) !== CELL.SOLID) continue;
        const { orient, e } = edgeOf(lx, ly, side);
        const grid = orient === "h" ? L.hEdges : L.vEdges;
        const kind = grid.kind[e] ?? EDGE.NONE;
        if (kind !== EDGE.WALL && kind !== EDGE.OPENING) {
          bare.add(j);
          continue;
        }
        if (claimed(orient, e)) continue;
        const style =
          kind === EDGE.WALL
            ? (L.wallStyles[grid.ref[e] ?? 0] ?? "wall")
            : (L.openings[grid.ref[e] ?? -1]?.wallStyle ?? "wall");
        // natural rock (gen/wallStyles.ts): the cave work owns the solid cells behind it
        if (isNaturalWallStyle(style)) {
          rockFace.push(j);
          continue;
        }
        const first = side === "S" || side === "E" ? sc : spanCell(j);
        const second = side === "S" || side === "E" ? spanCell(j) : sc;
        const hostFirst = (grid.host[e] ?? 1) === 0;
        const hgt = (grid.height[e] ?? 0) > 0 ? (grid.height[e] ?? 2) : 2;
        const span = wallSpan(L.elevation, first, second, hostFirst, hgt, ref);
        const theme = L.themes[L.cells.theme[i] ?? 0] ?? defaultTheme;
        // a tidy interior (ResolvedArea.finish, read through resolve/wallTops.ts roughCells) gets no cap and no skirt
        if (rough[i] !== 1) {
          tidyTop.set(j, Math.max(tidyTop.get(j) ?? -Infinity, span.top));
          continue;
        }
        const prev = seeds.get(j);
        // the cap sits flush with the tallest wall it backs onto
        if (!prev || span.top > prev.top) seeds.set(j, { theme, style, top: span.top });
      }
    }
  if (seeds.size === 0 && tidyTop.size === 0) return null;
  // the solid cells are shared with the cave rock mass (gen/solidMass.ts): each belongs to the dresser of the nearest
  // wall, so the cap and the rock meet with no gutter between them and no cell is dressed twice
  const grid: CellGrid = { w, h };
  const owner = ownSolid(grid, (i) => state(i) === CELL.SOLID, rockFace, [
    ...seeds.keys(),
    ...tidyTop.keys(),
  ]);
  const clear = { has: (k: number): boolean => owner[k] === OWNER.rock };

  // the cap top: the most common wall top among the seeds (ties: the higher), so a lowered run sits below the cap
  const tally = new Map<number, number>();
  const styles = new Map<string, number>();
  for (const s of seeds.values()) {
    tally.set(s.top, (tally.get(s.top) ?? 0) + 1);
    styles.set(s.style, (styles.get(s.style) ?? 0) + 1);
  }
  let flat = -Infinity;
  let best = -1;
  for (const [t, c] of tally) if (c > best || (c === best && t > flat)) [flat, best] = [t, c];
  const top = flat + SHELL.lift;
  let style = "wall";
  let sBest = -1;
  for (const [s, c] of [...styles].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    if (c > sBest) [style, sBest] = [s, c];

  // ── rings ──
  const noise = new ValueNoise(h32(`${seed}:${L.id}:shell`));
  const ring = new Map<number, number>();
  const theme = new Map<number, ThemeId>();
  for (const [j, s] of seeds) {
    if (bare.has(j) || clear.has(j)) continue;
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
          const k = at(x + dx, y + dy);
          if (k < 0 || ring.has(k) || state(k) !== CELL.SOLID || bare.has(k) || clear.has(k)) continue;
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

  // ── blocks: outer rings are laid in 2x2 blocks on the level's own even lattice (a block is kept when at least two of
  // its four cells reached by the rings are solid and the other two are solid too), so the outline steps in twos and
  // the cap needs big tiles; the ring-1 cells against the walls are always capped, in tiles of their own ──
  const blocksFor = (blockMin: number): Map<number, number> => {
    const capRing = new Map<number, number>();
    for (const [i, r] of ring) if (r === 1) capRing.set(i, 1);
    for (let by = 0; by < h; by += 2)
      for (let bx = 0; bx < w; bx += 2) {
        const ks = [at(bx, by), at(bx + 1, by), at(bx, by + 1), at(bx + 1, by + 1)];
        if (ks.some((k) => k < 0 || state(k) !== CELL.SOLID || bare.has(k) || clear.has(k))) continue;
        const reached = ks.filter((k) => ring.has(k));
        if (reached.length < blockMin) continue;
        const near = theme.get(reached[0] as number) ?? defaultTheme;
        for (const k of ks) {
          if (!capRing.has(k)) capRing.set(k, ring.get(k) ?? SHELL.reach + 1);
          if (!theme.has(k)) theme.set(k, near);
        }
      }
    return capRing;
  };

  // ── other levels in the slab ──
  const above = resolved.levels.filter((o) => o.id !== L.id && o.elevation > L.elevation);
  const below = resolved.levels.filter((o) => o.id !== L.id && o.elevation < L.elevation);
  const otherAt = (o: ResolvedLevel, gx: number, gy: number): number => {
    const lx = gx - o.bounds.x;
    const ly = gy - o.bounds.y;
    return lx < 0 || ly < 0 || lx >= o.bounds.w || ly >= o.bounds.h ? -1 : ly * o.bounds.w + lx;
  };
  const hiddenAbove = (gx: number, gy: number): boolean =>
    above.some((o) => {
      const k = otherAt(o, gx, gy);
      if (k < 0 || o.cells.state[k] !== CELL.OPEN || ((o.cells.flags[k] ?? 0) & CELL_FLAG.NO_FLOOR) !== 0)
        return false;
      // within four tiles: a higher floor further up still hides the cap, but a gap that big is a different map
      return o.elevation - top <= 4;
    });
  const hidesBelow = (gx: number, gy: number): boolean =>
    below.some((o) => {
      const k = otherAt(o, gx, gy);
      return k >= 0 && o.cells.state[k] === CELL.OPEN;
    });

  // the budget: the pieces the cap (2x2 tiles with singles at the rim, about 2.5 cells a piece) and the skirt (2 edges a
  // piece) take; a level over it gives up its outer blocks (blockMin 3, then 5 = only the ring against the walls)
  let assembled: { cells: Shell["cells"]; edges: ShellEdge[] } = { cells: new Map(), edges: [] };
  for (const blockMin of SHELL.blockMin) {
    const a = assemble(blocksFor(blockMin));
    assembled = a;
    // cells that stand lower than the flat cap are single tiles; the rest tile about 3 cells to a piece
    const singles = [...a.cells.values()].filter((c) => c.top !== top).length;
    const pieces = singles + Math.ceil((a.cells.size - singles) / 3) + Math.ceil(a.edges.length / 1.6);
    if (pieces <= SHELL.budget) break;
  }
  const { cells, edges } = assembled;

  // ── tidy strips: a one-cell solid strip between two tidy rooms (or a room and the corridor) ──
  const tidyOpen = (k: number): boolean => k >= 0 && state(k) === CELL.OPEN && rough[k] !== 1;
  const strip = new Set<number>();
  for (let pass = 0; pass < 4; pass++) {
    for (let k = 0; k < w * h; k++) {
      if (strip.has(k) || state(k) !== CELL.SOLID || bare.has(k) || clear.has(k)) continue;
      const x = k % w;
      const y = (k - x) / w;
      const pairs: Array<[number, number]> = [
        [at(x - 1, y), at(x + 1, y)],
        [at(x, y - 1), at(x, y + 1)],
      ];
      const ok = pairs.some(([a, b]) => {
        const sa = a >= 0 && strip.has(a);
        const sb = b >= 0 && strip.has(b);
        return (tidyOpen(a) || sa) && (tidyOpen(b) || sb) && (pass === 0 ? tidyOpen(a) && tidyOpen(b) : true);
      });
      if (ok) strip.add(k);
    }
  }
  const stripTopFallback = tidyTop.size > 0 ? Math.max(...tidyTop.values()) : 0;
  const strips: Shell["strips"] = [];
  for (const k of [...strip].sort((a, b) => a - b)) {
    const x = k % w;
    const y = (k - x) / w;
    const gx = L.bounds.x + x;
    const gy = L.bounds.y + y;
    if (cells.has(`${gx},${gy}`) || hiddenAbove(gx, gy) || hidesBelow(gx, gy)) continue;
    // the tallest wall top among this cell's own walls, else its strip neighbours' (a junction of two strips)
    let t = tidyTop.get(k) ?? -Infinity;
    if (t === -Infinity)
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const q = at(x + dx, y + dy);
        if (q >= 0 && tidyTop.has(q)) t = Math.max(t, tidyTop.get(q) as number);
      }
    if (t === -Infinity) t = stripTopFallback;
    // the strip is laid with the floor of the room it joins (the compiler asks the palette for that floor's role)
    const room = nearestOpen(k);
    const mat = L.cells.material[room] ?? 0;
    strips.push({
      x: gx,
      y: gy,
      theme: L.themes[L.cells.theme[room] ?? 0] ?? defaultTheme,
      top: t + SHELL.lift,
      material: mat > 0 ? (L.materials[mat - 1] ?? null) : null,
    });
  }
  if (cells.size === 0 && strips.length === 0) return null;
  return {
    cells,
    top: seeds.size > 0 ? top : 0,
    base: L.elevation + Math.min(0, floorLow),
    edges,
    strips,
    style,
    theme: [...cells.values()][0]?.theme ?? strips[0]?.theme ?? defaultTheme,
    rockMayTake: (x, y) => {
      const k = at(x - L.bounds.x, y - L.bounds.y);
      return k < 0 || owner[k] !== OWNER.built;
    },
  };

  function nearestOpen(k: number): number {
    const x = k % w;
    const y = (k - x) / w;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const q = at(x + dx, y + dy);
      if (q >= 0 && state(q) === CELL.OPEN) return q;
    }
    return k;
  }

  function assemble(capRing: Map<number, number>): { cells: Shell["cells"]; edges: ShellEdge[] } {
    const hiddenNeighbour = new Set<number>();
    // eligible cells: solid, not bare, clear of rock, not hidden (cells under a higher floor or over a lower room)
    const eligible = (i: number): boolean => {
      if (i < 0 || state(i) !== CELL.SOLID || bare.has(i) || clear.has(i)) return false;
      const x = i % w;
      const y = (i - x) / w;
      return !hiddenAbove(L.bounds.x + x, L.bounds.y + y) && !hidesBelow(L.bounds.x + x, L.bounds.y + y);
    };
    const set = new Map<number, number>(); // local index -> ring
    for (const [i, r] of capRing) {
      const x = i % w;
      const y = (i - x) / w;
      if (hiddenAbove(L.bounds.x + x, L.bounds.y + y)) {
        hiddenNeighbour.add(i);
        continue;
      }
      if (hidesBelow(L.bounds.x + x, L.bounds.y + y)) continue;
      set.set(i, r);
    }
    // outline cleanup (gen/solidMass.ts, shared with the cave outline): teeth of the outer rings, notches and holes,
    // and isolated lumps (components with no cell against a wall, or under minComponent cells)
    if (SHELL.cleanup) {
      trimTeeth(grid, set, (_i, r) => r > 1);
      fillNotches(grid, set, eligible, (k, near) => {
        theme.set(k, theme.get(near) ?? defaultTheme);
        return 2;
      });
      dropLumps(grid, set, (_i, r) => r === 1, SHELL.minComponent);
    }
    const cells: Shell["cells"] = new Map();
    for (const [i, r] of set) {
      const x = i % w;
      const y = (i - x) / w;
      const gx = L.bounds.x + x;
      const gy = L.bounds.y + y;
      cells.set(`${gx},${gy}`, {
        x: gx,
        y: gy,
        theme: theme.get(i) ?? defaultTheme,
        ring: r,
        top: r === 1 ? (seeds.get(i)?.top ?? flat) + SHELL.lift : top,
      });
    }
    return { cells, edges: skirtOf(cells, hiddenNeighbour) };
  }

  // ── skirt: the outer edge of the cap ──
  function skirtOf(cells: Shell["cells"], hiddenNeighbour: Set<number>): ShellEdge[] {
    const edges: ShellEdge[] = [];
    for (const c of [...cells.values()].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const lx = c.x - L.bounds.x;
      const ly = c.y - L.bounds.y;
      for (const [dx, dy, side] of DIRS) {
        const j = at(lx + dx, ly + dy);
        if (j < 0) continue; // the board's own edge: slabs are tiled beside each other
        if (cells.has(`${c.x + dx},${c.y + dy}`) || state(j) === CELL.OPEN || hiddenNeighbour.has(j))
          continue;
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
}
