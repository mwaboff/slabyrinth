/**
 * Cave rock mass (generator 3): what the built wall looks like from above and from inside, measured on the
 * realized pieces (the owner's first cave proof read as a fence of identical posts round a ring of separate rock
 * lumps, with the solid rock behind them empty). Four advisory notes, each a measure with a threshold
 * (REVIEW.caveMass):
 *   cave_rock_uncovered  share of solid cells that show no rock from above
 *   cave_mass_gaps       share of the wall length where neighbouring mass pieces do not touch
 *   cave_rock_tones      rock families of different tone in one cave
 *   cave_wall_row        longest run of identical wall pieces seen from inside
 * The measures are pure functions of plan-space pieces so tests can feed them hand-made layouts; `massPiecesOf` turns
 * a realized placement set into pieces (it needs the build: the review's shared one, review/reviewBuild.ts).
 */
import type { PaletteCatalog, PlacementSet } from "../contracts/compiler";
import type { MapPlan } from "../contracts/plan";
import { CELL, type ResolvedLevel, type ResolvedPlan } from "../contracts/resolved";
import { placementBox, rotateXZ } from "../compile/geometry";
import { NEIGHBOURS4 as D4 } from "../gen/gridGeometry";
import { hasNaturalWallStyle } from "../gen/wallStyles";
import { massDepth, massFoot } from "../gen/solidMass";
import { generatorProfile } from "../plan/generator";
import { loadOrientation } from "../palette/load";
import type { DesignNote } from "./review";
import type { ReviewBuild } from "./reviewBuild";
import { REVIEW, ROCK_FAMILIES, ROCK_TONE_GROUPS } from "./thresholds";

export type MassRole = "column" | "mass" | "cap" | "toe";

/** One piece of the cave wall mass in plan space: its outline (4 corners), height range and identity. */
export interface MassPiece {
  poly: ReadonlyArray<readonly [number, number]>;
  base: number;
  top: number;
  asset: string;
  /** Plan degrees (multiple of 15) as built, folded by the piece's own symmetry (90 for a square piece, else 180). */
  rot: number;
  family: string;
  role: MassRole;
}

export interface MassInput {
  w: number;
  h: number;
  /** Plan position of cell (0, 0). */
  x0: number;
  y0: number;
  /** Cell state (CELL.*) at a plan cell; -1 outside the level. */
  state: (x: number, y: number) => number;
  pieces: ReadonlyArray<MassPiece>;
  /** Floor top (absolute tiles) of an open cell; when given, `hollow` is measured. */
  floor?: (x: number, y: number) => number;
}

export interface MassMeasures {
  solidCells: number;
  /** Share of solid cells whose area shows no rock piece from above (under UNCOVERED_FILL of the cell covered). */
  uncovered: number;
  /** Cells of wall (solid cells beside open floor), and the share of neighbouring pairs whose mass pieces do not touch. */
  faceCells: number;
  separated: number;
  /** Rock tone groups used by the wall (families under REVIEW.caveMass.minFamilyShare of the pieces are ignored). */
  families: string[];
  /** Longest run of identical front pieces along a straight stretch of wall, and where it starts. */
  longestRun: number;
  longestRunAt: [number, number] | null;
  mass: number;
  columns: number;
  /**
   * Share of solid cells that are hollow seen from the side: at one of five points of the cell a gap of
   * REVIEW.caveMass.hole tiles or more between the foot of the rock (the lowest floor beside it, less a quarter, never
   * above a shallower neighbour's) and its top. 0 when the input has no floor heights.
   */
  hollow: number;
}

/** Rock family of an asset name (thresholds.ts ROCK_FAMILIES). */
export function rockFamily(name: string): string {
  for (const [re, fam] of ROCK_FAMILIES) if (re.test(name)) return fam;
  return "other";
}

/** The tone group of a family: families listed together read as one tone. */
export function toneGroup(family: string): string {
  const g = ROCK_TONE_GROUPS.find((l) => l.includes(family));
  return g ? (g[0] as string) : family;
}

function inPoly(poly: MassPiece["poly"], px: number, py: number): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as readonly [number, number];
    const b = poly[(i + 1) % poly.length] as readonly [number, number];
    const cr = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
    if (Math.abs(cr) < 1e-9) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** True when the plan outlines of two pieces lie within `gap` of each other (separating axes; a lower bound of the distance). */
function polysNear(a: MassPiece["poly"], b: MassPiece["poly"], gap: number): boolean {
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i] as readonly [number, number];
      const q = poly[(i + 1) % poly.length] as readonly [number, number];
      const nx = q[1] - p[1];
      const ny = p[0] - q[0];
      const len = Math.hypot(nx, ny) || 1;
      const proj = (pl: MassPiece["poly"]): [number, number] => {
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of pl) {
          const d = (v[0] * nx + v[1] * ny) / len;
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
        return [lo, hi];
      };
      const [al, ah] = proj(a);
      const [bl, bh] = proj(b);
      if (al - bh > gap || bl - ah > gap) return false;
    }
  return true;
}

export function touches(a: MassPiece, b: MassPiece): boolean {
  const T = REVIEW.caveMass;
  if (Math.max(a.base - b.top, b.base - a.top) > T.touchGap) return false;
  return polysNear(a.poly, b.poly, T.touchGap);
}

class Bucket {
  private cells = new Map<number, number[]>();
  constructor(private readonly pieces: ReadonlyArray<MassPiece>) {
    pieces.forEach((p, i) => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [x, y] of p.poly) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      for (let y = Math.floor(y0); y <= Math.floor(y1); y++)
        for (let x = Math.floor(x0); x <= Math.floor(x1); x++) {
          const k = Bucket.key(x, y);
          const l = this.cells.get(k);
          if (l) l.push(i);
          else this.cells.set(k, [i]);
        }
    });
  }
  private static key(x: number, y: number): number {
    return (x + 4096) * 8192 + (y + 4096);
  }
  /** Indices of pieces containing the point. */
  at(px: number, py: number): number[] {
    const out: number[] = [];
    for (const i of this.cells.get(Bucket.key(Math.floor(px), Math.floor(py))) ?? [])
      if (inPoly((this.pieces[i] as MassPiece).poly, px, py)) out.push(i);
    return out;
  }
}

export function massMeasures(input: MassInput): MassMeasures {
  const T = REVIEW.caveMass;
  const { w, h, x0, y0 } = input;
  const body = input.pieces.filter((p) => p.role !== "toe");
  const bucket = new Bucket(body);
  const solid = (x: number, y: number): boolean => input.state(x, y) === CELL.SOLID;
  const open = (x: number, y: number): boolean => input.state(x, y) === CELL.OPEN;

  // ── cover from above: a 3 × 3 sample grid per solid cell ──
  let solidCells = 0;
  let bare = 0;
  for (let ly = 0; ly < h; ly++)
    for (let lx = 0; lx < w; lx++) {
      const x = x0 + lx;
      const y = y0 + ly;
      if (!solid(x, y)) continue;
      solidCells++;
      let hit = 0;
      for (const fy of [1 / 6, 0.5, 5 / 6])
        for (const fx of [1 / 6, 0.5, 5 / 6]) if (bucket.at(x + fx, y + fy).length > 0) hit++;
      if (hit / 9 < T.coverFill) bare++;
    }

  // ── the wall: solid cells beside open floor, the pieces that back each ──
  const mass = input.pieces.filter((p) => p.role === "mass" || p.role === "cap");
  const mb = new Bucket(mass);
  const faces: Array<[number, number]> = [];
  const faceSet = new Set<number>();
  const fk = (x: number, y: number): number => (x + 4096) * 8192 + (y + 4096);
  for (let ly = 0; ly < h; ly++)
    for (let lx = 0; lx < w; lx++) {
      const x = x0 + lx;
      const y = y0 + ly;
      if (solid(x, y) && D4.some(([dx, dy]) => open(x + dx, y + dy))) {
        faces.push([x, y]);
        faceSet.add(fk(x, y));
      }
    }
  const backing = new Map<number, number[]>();
  for (const [x, y] of faces) backing.set(fk(x, y), mb.at(x + 0.5, y + 0.5));
  let pairs = 0;
  let apart = 0;
  for (const [x, y] of faces)
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
    ] as const) {
      if (!faceSet.has(fk(x + dx, y + dy))) continue;
      pairs++;
      const a = backing.get(fk(x, y)) ?? [];
      const b = backing.get(fk(x + dx, y + dy)) ?? [];
      let joined = false;
      for (const i of a) {
        for (const j of b)
          if (i === j || touches(mass[i] as MassPiece, mass[j] as MassPiece)) {
            joined = true;
            break;
          }
        if (joined) break;
      }
      if (!joined) apart++;
    }

  // ── tone groups ──
  const famCount = new Map<string, number>();
  for (const p of input.pieces)
    famCount.set(toneGroup(p.family), (famCount.get(toneGroup(p.family)) ?? 0) + 1);
  const total = input.pieces.length;
  const families = [...famCount]
    .filter(([, n]) => n / Math.max(1, total) >= T.minFamilyShare)
    .map(([f]) => f)
    .sort();

  // ── longest run of identical front pieces along a straight stretch ──
  // identical = same asset turned the same way (a post is a post at any height); a stone lying at the foot is
  // always its own piece and breaks the run
  const front = (x: number, y: number, n: readonly [number, number]): { idx: string; key: string } => {
    const toe = input.pieces.findIndex(
      (p) => p.role === "toe" && inPoly(p.poly, x + 0.5 + n[0] * 0.75, y + 0.5 + n[1] * 0.75),
    );
    if (toe >= 0) return { idx: `t${toe}`, key: `toe${toe}` };
    const ids = bucket.at(x + 0.5 + n[0] * 0.42, y + 0.5 + n[1] * 0.42);
    let best = -1;
    for (const i of ids) if (best < 0 || (body[i] as MassPiece).top > (body[best] as MassPiece).top) best = i;
    if (best < 0) return { idx: `n${x},${y}`, key: `none${x},${y}` };
    const p = body[best] as MassPiece;
    return { idx: String(best), key: `${p.asset}|${p.rot}` };
  };
  let longest = 0;
  let longestAt: [number, number] | null = null;
  const lines = new Map<string, Array<{ t: number; x: number; y: number; idx: string; key: string }>>();
  for (const [x, y] of faces) {
    const opens = D4.filter(([dx, dy]) => open(x + dx, y + dy));
    if (opens.length !== 1) continue;
    const n = opens[0] as readonly [number, number];
    const along = n[0] !== 0 ? y : x;
    const line = n[0] !== 0 ? x : y;
    const k = `${n[0]},${n[1]},${line}`;
    const l = lines.get(k) ?? [];
    l.push({ t: along, x, y, ...front(x, y, n) });
    lines.set(k, l);
  }
  for (const l of lines.values()) {
    l.sort((a, b) => a.t - b.t);
    let run = 0;
    let prevKey = "";
    let prevPiece = "";
    let prevT = -99;
    let startAt: [number, number] = [0, 0];
    for (const c of l) {
      // a piece standing in front of several cells is one piece
      if (c.t === prevT + 1 && c.key === prevKey) {
        if (c.idx !== prevPiece) run++;
      } else {
        run = 1;
        startAt = [c.x, c.y];
      }
      prevKey = c.key;
      prevPiece = c.idx;
      prevT = c.t;
      if (run > longest) {
        longest = run;
        longestAt = startAt;
      }
    }
  }

  // ── hollow from the side: the foot of each solid cell, then gaps between the foot and the top ──
  let hollowCells = 0;
  if (input.floor) {
    const floor = input.floor;
    // the same foot rule the mass is built to (gen/solidMass.ts): a cell's foot is the lowest floor beside it, a quarter
    // tile down, and deeper rock stands no higher than the shallower rock beside it
    const grid = { w, h };
    const at = (i: number): [number, number] => [x0 + (i % w), y0 + Math.floor(i / w)];
    const lowest = new Map<number, number>();
    for (let i = 0; i < w * h; i++) {
      const [x, y] = at(i);
      if (!solid(x, y)) continue;
      let lo = Infinity;
      for (const [dx, dy] of D4) if (open(x + dx, y + dy)) lo = Math.min(lo, floor(x + dx, y + dy));
      if (lo < Infinity) lowest.set(i, lo - 0.25);
    }
    const { depth } = massDepth(grid, (i) => solid(...at(i)), [...lowest.keys()]);
    const footOf = massFoot(grid, depth, (i) => lowest.get(i) ?? Infinity);
    for (let i = 0; i < w * h; i++) {
      if ((depth[i] as number) === 0) continue;
      const [x, y] = at(i);
      const f = footOf[i] as number;
      let hollowHere = false;
      for (const [fx, fy] of [
        [0.5, 0.5],
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ] as const) {
        const iv = bucket
          .at(x + fx, y + fy)
          .map((i) => body[i] as MassPiece)
          .sort((a, b) => a.base - b.base);
        let reach = f;
        for (const p of iv) {
          if (p.base > reach + T.hole - 1e-9) {
            hollowHere = true;
            break;
          }
          reach = Math.max(reach, p.top);
        }
        if (hollowHere) break;
      }
      if (hollowHere) hollowCells++;
    }
  }

  return {
    hollow: solidCells > 0 ? hollowCells / solidCells : 0,
    solidCells,
    uncovered: solidCells > 0 ? bare / solidCells : 0,
    faceCells: faces.length,
    separated: pairs > 0 ? apart / pairs : 0,
    families,
    longestRun: longest,
    longestRunAt: longestAt,
    mass: mass.length,
    columns: input.pieces.filter((p) => p.role === "column").length,
  };
}

// ───────────────────────── from a realized build ─────────────────────────

const ROLE_OF: Record<string, MassRole> = {
  "wall.cave_rock": "column",
  cave_mass: "mass",
  cave_cap: "cap",
  cave_foot: "toe",
};

/** Pieces of the cave wall of one level, from the realized placements (ids by source.elementId). */
export function massPiecesOf(
  set: PlacementSet,
  resolved: ResolvedPlan,
  palettes: PaletteCatalog,
  levelId: string,
  orientation = loadOrientation().orientation,
): MassPiece[] {
  const geoms = new Map<string, { geom: PaletteVariantGeom; name: string }>();
  for (const p of Object.values(palettes.palettes))
    for (const r of Object.values(p.roles))
      for (const v of r.variants) {
        if (!geoms.has(v.asset)) geoms.set(v.asset, { geom: v.geom, name: v.name ?? v.asset });
        for (const [u, g] of Object.entries(v.alternateGeom ?? {}))
          if (!geoms.has(u)) geoms.set(u, { geom: g, name: v.name ?? u });
      }
  const hg = resolved.levels.reduce((m, l) => Math.max(m, l.bounds.y + l.bounds.h), 0);
  const out: MassPiece[] = [];
  for (const lv of set.levels) {
    if (lv.levelId !== levelId) continue;
    for (const p of lv.placements) {
      const role = p.source.elementId ? ROLE_OF[p.source.elementId] : undefined;
      if (!role) continue;
      const g = geoms.get(p.asset);
      if (!g) continue;
      const cw = p.rot * orientation.rotSense;
      // generator 4: a fill column is a corner-origin block turned in quarter turns, which stays on its own cell
      // (compile/geometry.ts placementBox); turning it about its corner would put it on the neighbouring cell
      if (role === "column" && generatorProfile(resolved).solidCaveRock && g.geom.originAt === "minCorner") {
        const box = placementBox(g.geom, p.x, p.y, p.z, cw);
        const corner = (wx: number, wz: number): readonly [number, number] => [
          wx,
          orientation.flipZ ? hg - wz : wz,
        ];
        out.push({
          poly: [
            corner(box.min.x, box.min.z),
            corner(box.max.x, box.min.z),
            corner(box.max.x, box.max.z),
            corner(box.min.x, box.max.z),
          ],
          base: box.min.y,
          top: box.max.y,
          asset: p.asset,
          rot: p.rot % (Math.abs(g.geom.size.x - g.geom.size.z) < 0.08 ? 90 : 180),
          family: rockFamily(g.name),
          role,
        });
        continue;
      }
      const c = rotateXZ(g.geom.boundsCenter.x, g.geom.boundsCenter.z, cw);
      const hx = g.geom.size.x / 2;
      const hz = g.geom.size.z / 2;
      const poly = (
        [
          [-hx, -hz],
          [hx, -hz],
          [hx, hz],
          [-hx, hz],
        ] as const
      ).map(([lx, lz]) => {
        const r = rotateXZ(lx, lz, cw);
        const wx = p.x + c.x + r.x;
        const wz = p.z + c.z + r.z;
        // world → plan (WorldFrame.point is its own inverse about hg)
        return [wx, orientation.flipZ ? hg - wz : wz] as const;
      });
      out.push({
        poly,
        base: p.y + g.geom.boundsCenter.y - g.geom.size.y / 2,
        top: p.y + g.geom.boundsCenter.y + g.geom.size.y / 2,
        asset: p.asset,
        rot: p.rot % (Math.abs(g.geom.size.x - g.geom.size.z) < 0.08 ? 90 : 180),
        family: rockFamily(g.name),
        role,
      });
    }
  }
  return out;
}

type PaletteVariantGeom = import("../contracts/compiler").PaletteVariant["geom"];

export function massInputOf(L: ResolvedLevel, pieces: ReadonlyArray<MassPiece>): MassInput {
  const { w, h } = L.bounds;
  return {
    w,
    h,
    x0: L.bounds.x,
    y0: L.bounds.y,
    state: (x, y) => {
      const lx = x - L.bounds.x;
      const ly = y - L.bounds.y;
      return lx < 0 || ly < 0 || lx >= w || ly >= h ? -1 : (L.cells.state[ly * w + lx] ?? CELL.VOID);
    },
    pieces,
    floor: (x, y) => L.elevation + 0.5 + (L.cells.height[(y - L.bounds.y) * w + (x - L.bounds.x)] ?? 0) / 4,
  };
}

// ───────────────────────── notes ─────────────────────────

export function caveMassNotes(
  plan: MapPlan,
  resolved: ResolvedPlan,
  set: PlacementSet,
  palettes: PaletteCatalog,
): DesignNote[] {
  const gen = generatorProfile(plan);
  if (!gen.caveRockMass) return [];
  const out: DesignNote[] = [];
  for (const L of resolved.levels) {
    if (!hasNaturalWallStyle(L.wallStyles)) continue;
    const pieces = massPiecesOf(set, resolved, palettes, L.id);
    if (pieces.length === 0) continue;
    const m = massMeasures(massInputOf(L, pieces));
    out.push(...caveMassNotesOf(L.id, m));
    if (gen.naturalCaveReview) out.push(...caveHollowNotesOf(L.id, m));
  }
  return out;
}

/**
 * The rock-mass notes in any review: with the build when the review has one (the CLI), else (generator 4: the in-app
 * model review) the review's shared build (review/reviewBuild.ts: one realizer run for every note that needs it) for
 * a plan with a cave-rock level. Generator 3 keeps its released behaviour: no build, no notes.
 */
export function caveMassReviewNotes(
  plan: MapPlan,
  resolved: ResolvedPlan,
  build: ReviewBuild,
  palettes: PaletteCatalog,
): DesignNote[] {
  if (
    !build.given &&
    (!generatorProfile(plan).naturalCaveReview ||
      !resolved.levels.some((L) => hasNaturalWallStyle(L.wallStyles)))
  )
    return [];
  return caveMassNotes(plan, resolved, build.get(), palettes);
}

/** Generator 4: rock that is hollow seen from the side (a cap or course over nothing, towers with gaps between). */
export function caveHollowNotesOf(levelId: string, m: MassMeasures): DesignNote[] {
  const T = REVIEW.caveMass;
  if (m.solidCells < T.minSolid || m.hollow <= T.hollow) return [];
  return [
    {
      code: "cave_mass_hollow",
      levelId,
      score: T.weight * Math.min(3, m.hollow / T.hollow),
      message: `${Math.round(m.hollow * 100)}% of the rock behind the cave wall is hollow seen from the side: pieces stand over empty space, so from the low side the rock reads as lace with the floor or the water showing through`,
      action:
        "leave whole cells of solid rock behind the wall (3 or more deep, and the cave 3 or more cells from the level edge) so the mass can stand on the ground everywhere; a thin or broken band of rock cannot be filled",
    },
  ];
}

export function caveMassNotesOf(levelId: string, m: MassMeasures): DesignNote[] {
  const T = REVIEW.caveMass;
  const out: DesignNote[] = [];
  const over = (v: number, t: number): number => Math.min(3, v / Math.max(1e-9, t));
  if (m.solidCells >= T.minSolid && m.uncovered > T.uncovered)
    out.push({
      code: "cave_rock_uncovered",
      levelId,
      score: T.weight * over(m.uncovered, T.uncovered),
      message: `${Math.round(m.uncovered * 100)}% of the solid rock cells show no rock from above: the ground behind the cave wall is empty, so the cave stands as a fenced raft over the void (or over the water plane)`,
      action:
        "keep solid rock where the cave needs a backdrop and let the cave wall build mass over it; where the rock band is thin or cut by other areas, widen it, or let the level edge close the cave instead",
    });
  if (m.faceCells >= T.minFaces && m.separated > T.gaps)
    out.push({
      code: "cave_mass_gaps",
      levelId,
      score: T.weight * over(m.separated, T.gaps),
      message: `along ${Math.round(m.separated * 100)}% of the cave wall the rock pieces behind the face do not touch their neighbours: the wall is a row of separate lumps`,
      action:
        "leave 3 or more cells of solid rock behind the wall so the mass can overlap, and keep neighbouring areas two cells of rock apart",
    });
  if (m.families.length > T.families)
    out.push({
      code: "cave_rock_tones",
      levelId,
      score: T.weight * over(m.families.length, T.families),
      message: `the cave wall mixes ${m.families.length} rock tones (${m.families.join(", ")}): they clash`,
      action: "build the wall from one rock family that sits with the floor tone",
    });
  if (m.faceCells >= T.minFaces && m.longestRun > T.run)
    out.push({
      code: "cave_wall_row",
      levelId,
      score: T.weight * over(m.longestRun, T.run),
      message: `the cave wall shows ${m.longestRun} identical pieces in a row${m.longestRunAt ? ` from ${m.longestRunAt[0]},${m.longestRunAt[1]}` : ""}: a palisade of posts`,
      action: "break the row: rock in front of and between the pieces, varied heights and pieces",
      ...(m.longestRunAt ? { cell: m.longestRunAt } : {}),
    });
  return out;
}
