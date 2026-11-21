/**
 * Growth that climbs (generator 3; the study's temple and keep ruins): a weathered or ruined building is overgrown
 * from the structure, not only by heaps at the wall foot. Vines run up wall faces in masses that start at the ground
 * and thin upward, roots grip the base, small growth sits on cut wall tops, and a ruined interior may hold trees.
 * Decided here as data (`ResolvedStructure.growth`); the compiler fills it through palette roles (ruin_climber.default,
 * ruin_root.default, ruin_cap.default, ruin_tree.default, each with a feature fallback) and a theme without them gets
 * nothing.
 *
 * How much is a level (`GrowthLevel`: none, light, medium, heavy), and it is measured as COVERAGE OF WALL CELLS (the
 * share of the building's wall columns a vine or root mass covers), never as a share of growth pieces: the study's
 * overgrown ruins are green on a third to half of their exterior wall. `growthCoverage` reads it back for the review.
 */
import type { Side } from "../contracts/plan";
import type { ResolvedStructure } from "../contracts/resolved";
import { SIDE_STEP as STEP } from "../gen/gridGeometry";
import { h32 } from "../util/hash";

/** Shaded faces grow more (the sun is taken from the south). */
const SHADE: Record<Side, number> = { N: 1.35, W: 1.15, E: 0.9, S: 0.65 };

export type GrowthLevel = "none" | "light" | "medium" | "heavy";

/** What each level builds towards, and the coverage the review demands of it (data, one place). */
export const GROWTH_LEVELS: Readonly<
  Record<
    GrowthLevel,
    {
      /** Share of the wall columns that get a vine mass. */
      faces: number;
      /** Strands side by side at the foot. */
      thick: number;
      /** Chance a mass climbs another step (1.6 tiles) up. */
      climb: number;
      /** Chance a cut wall top carries a plant. */
      cap: number;
      /** Chance a bare face gets roots at its base. */
      root: number;
      /** Length of a patch (faces along a wall that grow together). */
      patch: number;
      /** Coverage (vine and root fill over wall columns) below which the review says the building is not what it was asked to be. */
      min: number;
    }
  >
> = {
  none: { faces: 0, thick: 1, climb: 0, cap: 0, root: 0, patch: 2, min: 0 },
  light: { faces: 0.14, thick: 1, climb: 0.6, cap: 0.1, root: 0.07, patch: 2, min: 0.06 },
  medium: { faces: 0.3, thick: 2, climb: 0.7, cap: 0.18, root: 0.12, patch: 3, min: 0.16 },
  heavy: { faces: 0.85, thick: 3, climb: 0.86, cap: 0.45, root: 0.2, patch: 4, min: 0.3 },
};

export interface GrowthInput {
  seed: number;
  ruined: boolean;
  level: GrowthLevel;
  /** Wall columns (heights relative to the ground floor top). */
  columns: ReadonlyArray<{ at: readonly [number, number]; side: Side; top: number; full: number }>;
  anchor: readonly [number, number];
  /** Footprint cells ("x,y"). */
  cellSet: ReadonlySet<string>;
  /** Faces ("x,y,side") where nothing may grow: doorways, windows, breaches, arches, chimneys, and their neighbours. */
  blocked: ReadonlySet<string>;
  /** Faces with an upper-storey opening: growth stops at the ground storey's top there. */
  upperFaces: ReadonlySet<string>;
  /** Top of the ground storey above the ground floor top. */
  groundTop: number;
  /** Is the ring cell outside a face free (inside the level, no party wall, no door path)? */
  ringFree: (x: number, y: number) => boolean;
  /** Faces whose cut top already carries a block or rubble ("x,y,side"). */
  topTaken: ReadonlySet<string>;
  /** Footprint cells whose roof has gone and that nothing lies on: where a tree may stand ("x,y"). */
  open: ReadonlySet<string>;
}

export type GrowthItem = NonNullable<ResolvedStructure["growth"]>[number];

export function climbingGrowth(inp: GrowthInput): GrowthItem[] {
  const P = GROWTH_LEVELS[inp.level];
  const out: GrowthItem[] = [];
  if (inp.level === "none") return out;
  const u = (s: string): number => h32(`${inp.seed}:grow:${s}`) / 4294967296;
  const key = (c: { at: readonly [number, number]; side: Side }): string => `${c.at[0]},${c.at[1]},${c.side}`;
  const dist = (c: { at: readonly [number, number] }): number =>
    Math.hypot(c.at[0] - inp.anchor[0], c.at[1] - inp.anchor[1]);
  const D = Math.max(1, ...inp.columns.map(dist));
  const list = [...inp.columns].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const heavy = inp.level === "heavy";

  // faces a plant can use: nothing in the way, a free ring cell, and some wall to climb
  const faces = list.filter((c) => {
    const [dx, dy] = STEP[c.side];
    const k = key(c);
    if (inp.blocked.has(k)) return false;
    if (inp.cellSet.has(`${c.at[0] + dx},${c.at[1] + dy}`)) return false;
    return inp.ringFree(c.at[0] + dx, c.at[1] + dy);
  });
  const capOf = (c: (typeof faces)[number]): number =>
    inp.upperFaces.has(key(c)) ? Math.min(c.top, inp.groundTop) : c.top;
  const usable = faces.filter((c) => capOf(c) >= 1.5);

  // patches: runs of faces along a wall that grow together (masses, not single strands); shaded and fallen sides first
  const alongOf = (c: (typeof faces)[number]): number =>
    c.side === "N" || c.side === "S" ? c.at[0] : c.at[1];
  const lineOf = (c: (typeof faces)[number]): number =>
    c.side === "N" || c.side === "S" ? c.at[1] : c.at[0];
  const patches = new Map<string, { w: number; faces: typeof faces }>();
  for (const c of usable) {
    const pk = `${c.side}:${lineOf(c)}:${Math.floor(alongOf(c) / P.patch)}`;
    const p = patches.get(pk) ?? { w: 0, faces: [] };
    p.faces.push(c);
    patches.set(pk, p);
  }
  for (const [pk, p] of patches) {
    const mean =
      p.faces.reduce((t, c) => t + SHADE[c.side] * (inp.ruined ? 0.7 + 0.8 * (dist(c) / D) : 1), 0) /
      p.faces.length;
    p.w = (0.35 + u(`patch:${pk}`)) * mean;
  }
  const want = Math.max(
    2,
    Math.round(
      P.faces *
        list.filter((c) => {
          const [dx, dy] = STEP[c.side];
          return c.top >= 1 && !inp.cellSet.has(`${c.at[0] + dx},${c.at[1] + dy}`);
        }).length,
    ),
  );
  const vined = new Set<string>();
  for (const [, p] of [...patches.entries()].sort((a, b) => b[1].w - a[1].w || (a[0] < b[0] ? -1 : 1))) {
    if (vined.size >= want) break;
    for (const c of p.faces) if (u(`col:${key(c)}`) < (heavy ? 0.95 : 0.85)) vined.add(key(c));
  }
  // never bare: at least two vined faces
  if (vined.size < 2) {
    for (const c of usable) {
      if (vined.size >= 2) break;
      vined.add(key(c));
    }
  }

  const vinedFaces = faces.filter((c) => vined.has(key(c)));
  const byKey = new Set(vinedFaces.map(key));
  for (const c of vinedFaces) {
    const k = key(c);
    const cap = capOf(c);
    // a tall cut top may have a strand hanging from it (not on a heavy building: its masses start at the ground)
    if (!heavy && cap >= 4 && u(`hang:${k}`) < 0.22) {
      const len = Math.min(cap - 0.5, 1.6 + 1.6 * u(`hlen:${k}`));
      out.push({ kind: "vine", at: [c.at[0], c.at[1]], side: c.side, from: cap - len, to: cap, thick: 1 });
      continue;
    }
    let n = 1;
    while (n < 5 && u(`n:${k}:${n}`) < P.climb) n++;
    const [ux, uy] = c.side === "N" || c.side === "S" ? [1, 0] : [0, 1];
    // a face with vined faces on both sides along the wall may take the broad batch over its middle
    const both =
      byKey.has(`${c.at[0] - ux},${c.at[1] - uy},${c.side}`) &&
      byKey.has(`${c.at[0] + ux},${c.at[1] + uy},${c.side}`);
    out.push({
      kind: "vine",
      at: [c.at[0], c.at[1]],
      side: c.side,
      from: 0,
      to: Math.min(cap, 1.6 * n),
      thick: P.thick,
      ...(heavy && both && u(`wide:${k}`) < 0.5 ? { wide: true } : {}),
    });
  }

  // roots grip the base of a few faces the vines left alone
  for (const c of faces) {
    const k = key(c);
    if (vined.has(k) || capOf(c) < 1 || u(`root:${k}`) >= P.root) continue;
    out.push({
      kind: "root",
      at: [c.at[0], c.at[1]],
      side: c.side,
      from: 0,
      to: Math.min(capOf(c), 1.5),
      thick: heavy ? 2 : 1,
    });
  }

  // small growth on the cut wall tops (bushes, ferns, moss), none where a block already lies
  for (const c of faces) {
    const k = key(c);
    if (c.top >= c.full - 1e-6 || inp.topTaken.has(k) || c.top < 1.5) continue;
    if (u(`cap:${k}`) >= P.cap * (0.6 + 0.4 * SHADE[c.side])) continue;
    out.push({ kind: "cap", at: [c.at[0], c.at[1]], side: c.side, from: c.top, to: c.top });
  }

  // a ruin with room keeps trees in its roofless middle (a cell with every neighbour in the open part): one, and on a
  // heavy building as many as fit three cells apart (two at most)
  if (inp.ruined) {
    const spots = [...inp.open].sort().filter((k) => {
      const [x, y] = k.split(",").map(Number) as [number, number];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) if (!inp.open.has(`${x + dx},${y + dy}`)) return false;
      return true;
    });
    const trees = heavy ? 2 : 1;
    const placed: Array<[number, number]> = [];
    for (let t = 0; t < trees; t++) {
      const free = spots.filter((k) => {
        const [x, y] = k.split(",").map(Number) as [number, number];
        return placed.every(([px, py]) => Math.hypot(px - x, py - y) >= 4);
      });
      if (free.length === 0) break;
      const chance = heavy ? (t === 0 ? 1 : 0.8) : inp.open.size >= 40 ? 0.85 : 0.55;
      if (u(`tree${t}`) >= chance) continue;
      const k = free[Math.floor(u(`treeAt${t}`) * free.length)] as string;
      const [x, y] = k.split(",").map(Number) as [number, number];
      placed.push([x, y]);
      out.push({ kind: "tree", at: [x, y], from: 0, to: 0 });
    }
  }
  return out;
}

/** What the review and the tests read off a building's growth. */
export interface GrowthMeasures {
  vines: number;
  roots: number;
  caps: number;
  trees: number;
  /** Climbing pieces (vines and roots) as a share of all growth including the foot heaps (kept for old proofs; not what is judged). */
  climbingShare: number;
  /** Wall faces of the footprint. */
  faces: number;
  /** Wall columns at least a tile tall. */
  columns: number;
  /** Share of those columns covered by a vine or root mass, partly covered counting by how much (the number the review judges). */
  coverage: number;
  /** Share of the columns with any climbing piece at all. */
  facesCovered: number;
  /** Foot and interior growth heaps (bushes). */
  heaps: number;
}

/** How much of a face a mass fills: one strand a little under half, two nearly all, three or a broad batch all of it. */
const fill = (g: { thick?: number; wide?: boolean }): number =>
  g.wide ? 1 : Math.min(1, 0.45 * (g.thick ?? 1) + 0.05);

export function growthMeasures(st: ResolvedStructure): GrowthMeasures {
  const g = st.growth ?? [];
  const count = (k: string): number => g.filter((x) => x.kind === k).length;
  const cells = new Set(st.cells.map(([x, y]) => `${x},${y}`));
  let faces = 0;
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    for (const [dx, dy] of Object.values(STEP)) if (!cells.has(`${x + dx},${y + dy}`)) faces++;
  }
  const heaps = (st.debris ?? []).filter((d) => d.kind === "growth").length;
  const climbing = count("vine") + count("root");
  const all = g.length + heaps;
  const floor0 = st.storeys[0]?.floorTop ?? 0;
  // exterior wall columns at least a tile tall (a face between two volumes of the building is no outside wall)
  const columns = (st.ruin?.columns ?? []).filter((c) => {
    const [dx, dy] = STEP[c.side];
    return c.top - floor0 >= 1 - 1e-6 && !cells.has(`${c.at[0] + dx},${c.at[1] + dy}`);
  });
  const best = new Map<string, number>();
  for (const x of g) {
    if ((x.kind !== "vine" && x.kind !== "root") || !x.side) continue;
    const k = `${x.at[0]},${x.at[1]},${x.side}`;
    best.set(k, Math.max(best.get(k) ?? 0, fill(x)));
  }
  let covered = 0;
  let any = 0;
  for (const c of columns) {
    const f = best.get(`${c.at[0]},${c.at[1]},${c.side}`) ?? 0;
    covered += f;
    if (f > 0) any++;
  }
  const round = (x: number): number => Math.round(x * 1000) / 1000;
  return {
    vines: count("vine"),
    roots: count("root"),
    caps: count("cap"),
    trees: count("tree"),
    climbingShare: all > 0 ? climbing / all : 0,
    faces,
    columns: columns.length,
    coverage: columns.length ? round(covered / columns.length) : 0,
    facesCovered: columns.length ? round(any / columns.length) : 0,
    heaps,
  };
}

/** The level a building was built at (generator 3, weathered or ruined), or null. */
export function growthLevelOf(st: ResolvedStructure): GrowthLevel | null {
  return st.growthLevel ?? null;
}
