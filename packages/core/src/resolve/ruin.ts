/**
 * Ruins and weathering (owner's condition line-up, 2026-11-20, and the community ruined keep the reference study
 * measured): a ruin is not a building with its top courses nibbled evenly. It falls away from one standing corner
 * along a diagonal; its wall tops vary cell by cell (six neighbours in ten differ, one in four by two tiles or
 * more); about half its masonry is low stubs tracing lost rooms while a tower mass stands about three times as tall;
 * its upper floors have holes; its rubble lies mostly inside. A weathered building keeps its shape but shows chipped
 * tops and a broken roof.
 *
 * `ruinProfile` decides, from the seed and the massing alone, the surviving top of every wall column and the holes
 * in every upper floor; the compiler builds to it. `structureRuinMeasures` reads a resolved building back for tests
 * and the design review (`ruin_flat_top`, `ruin_uniform`).
 */
import type { Side } from "../contracts/plan";
import type { ResolvedArrangement, ResolvedStructure } from "../contracts/resolved";
import { SIDE_STEP as STEP, SIDES } from "../gen/gridGeometry";
import { h32, hashUnit } from "../util/hash";
import { maxOf, minOf } from "../util/lists";

export interface RuinVolumeIn {
  id: string;
  on: string | null;
  storeys: ReadonlyArray<{
    cells: ReadonlyArray<readonly [number, number]>;
    relFloor: number;
    relTop: number;
  }>;
}

export interface RuinProfile {
  /** Surviving and intact top of each wall column, relative to the ground floor top. */
  columns: Array<{ at: [number, number]; side: Side; top: number; full: number }>;
  holes: Array<{ volume: string; storey: number; cells: Array<[number, number]> }>;
  anchor: [number, number];
  loss: number;
  /** The gable end that stays standing (ruins with a gable roof). */
  gable?: Side;
  /** Weathered: the roof patch that has fallen in (cells of the top mass). */
  roofHoles?: Array<[number, number]>;
  /** Generator 3 weathering decisions (boarded windows, bitten parapets, lost details); filled by the resolver. */
  weather?: { boarded: string[]; parapetBites: string[]; lost: string[]; windows: number };
  /** Generator 3 ruins: openings whose frame and arch stand on after the wall beside them fell. */
  arches?: Array<{ at: [number, number]; side: Side; width: number }>;
  /** Generator 3 ruins: blocks and rubble on cut wall tops (top relative to the ground floor top). */
  topRubble?: Array<{ at: [number, number]; side: Side; top: number; kind: "block" | "rubble" }>;
  /** Generator 3 ruins: the volume that stays whole under its roof, the anchor the rest decays away from. */
  keep?: string;
  /**
   * Generator 5 ruins (switch `ruinBays`, resolve/building/ruinBays.ts): the bays the building lost, each its breach
   * (first face cell, side, width) and the cells of the bay (the roof and upper floors are open over them).
   */
  bays?: Array<{ at: [number, number]; side: Side; width: number; cells: Array<[number, number]> }>;
}

/** What the generator-3 rules need to know about the building's openings. */
export interface RuinOptions {
  /** The generator profile's `legibleCondition` switch: ruins that read from the game camera (generator 3 on). */
  legibleCondition: boolean;
  /**
   * Generator 3: one roofed volume (of those in `roofed`, nearest the standing corner, with nothing standing on it)
   * keeps its walls and roof whole as the anchor of the ruin; the rest decays away from it.
   */
  keepRoofed?: boolean;
  /** Volumes under a pitched roof: they are preferred as the anchor (a standing gable reads at once). */
  pitched?: ReadonlySet<string>;
  /** Ground-storey openings (doors, windows, archways) by their first face cell. */
  openings?: ReadonlyArray<{ at: readonly [number, number]; side: Side; width: number }>;
}

/** Share of masonry height given up per column: 0 (35 %), ½ (25 %), 1 (15 %), 2 (15 %), 3 (10 %). */
const NOISE: ReadonlyArray<readonly [number, number]> = [
  [0.35, 0],
  [0.6, 0.5],
  [0.75, 1],
  [0.9, 2],
  [1, 3],
];

/** Generator 3 (`legibleCondition`): fewer columns keep their full height (15 %), more lose a half tile or a tile. */
const NOISE_LEGIBLE: ReadonlyArray<readonly [number, number]> = [
  [0.15, 0],
  [0.45, 0.5],
  [0.7, 1],
  [0.88, 2],
  [1, 3],
];

export function ruinProfile(
  vols: readonly RuinVolumeIn[],
  condition: "weathered" | "ruined",
  seed: number,
  gableRoof?: { x: number; y: number; w: number; h: number; ridge: "ew" | "ns" },
  /** Volumes with a roof: a weathered building's walls under a roof stay whole (no gap under the eaves). */
  roofed: ReadonlySet<string> = new Set(),
  opts: RuinOptions = { legibleCondition: false },
): RuinProfile {
  const u = (s: string): number => hashUnit(seed, "ruin", s);
  const cols = wallColumns(vols);
  const list = [...cols.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (list.length === 0) return { columns: [], holes: [], anchor: [0, 0], loss: 0 };
  if (condition === "weathered") return weatheredProfile(list, roofed, opts, u);
  const fall = ruinFall({ vols, seed, gableRoof, roofed, opts, u, cols, list });
  const columns = fallenColumns(fall);
  const byKey = new Map(columns.map((c) => [`${c.at[0]},${c.at[1]},${c.side}`, c]));
  const arches = standingArches(fall, byKey);
  const holes = floorHoles(fall, byKey);
  return {
    columns,
    holes,
    anchor: fall.anchor,
    loss: lossOf(columns, fall.lows),
    ...(fall.gable ? { gable: fall.gable } : {}),
    ...(arches.length ? { arches } : {}),
    ...(fall.keep !== undefined ? { keep: fall.keep } : {}),
  };
}

/** A wall column of the massing: its face cell and side, intact top, lowest floor, and the volumes that own it. */
export interface WallColumn {
  at: [number, number];
  side: Side;
  full: number;
  /** The volume of its lowest storey (lost rooms go by volume). */
  vol: string;
  low: number;
  /** The volume of its highest storey. */
  topVol: string;
}

/** A ruin's columns as decided: surviving and intact top. */
type RuinColumn = RuinProfile["columns"][number];

/**
 * Wall columns ("x,y,side"): the outer face of every storey cell whose neighbour is not in that storey; its intact top
 * is the highest storey with that face; the volume of its lowest storey owns it (lost rooms go by volume).
 */
export function wallColumns(vols: readonly RuinVolumeIn[]): Map<string, WallColumn> {
  const cols = new Map<string, WallColumn>();
  for (const v of vols)
    for (const s of v.storeys) {
      const own = new Set(s.cells.map(([x, y]) => `${x},${y}`));
      for (const [x, y] of s.cells)
        for (const side of SIDES) {
          const [dx, dy] = STEP[side];
          if (own.has(`${x + dx},${y + dy}`)) continue;
          const k = `${x},${y},${side}`;
          const c = cols.get(k);
          if (!c) cols.set(k, { at: [x, y], side, full: s.relTop, vol: v.id, low: s.relFloor, topVol: v.id });
          else {
            if (s.relTop > c.full) c.topVol = v.id;
            c.full = Math.max(c.full, s.relTop);
            if (s.relFloor < c.low) {
              c.low = s.relFloor;
              c.vol = v.id;
            }
          }
        }
    }
  return cols;
}

/** The columns in key order ("x,y,side"). */
type ColumnList = Array<[string, WallColumn]>;

/** Weathered: the shape stays whole, with chipped tops where nothing roofs them. */
function weatheredProfile(
  list: ColumnList,
  roofed: ReadonlySet<string>,
  opts: RuinOptions,
  u: (s: string) => number,
): RuinProfile {
  const xs = list.map(([, c]) => c.at[0]);
  const ys = list.map(([, c]) => c.at[1]);
  // chipped tops where nothing roofs them: one column in five loses half a tile or a tile; the shape stays whole
  const columns = list.map(([k, c]) => {
    const r = roofed.has(c.topVol) ? 1 : u(`chip:${k}`);
    // generator 3: a third of the open tops are bitten, so a weathered wall reads as neglected from the game camera
    const chip = opts.legibleCondition
      ? r < 0.2
        ? 0.5
        : r < 0.35
          ? 1
          : 0
      : r < 0.12
        ? 0.5
        : r < 0.2
          ? 1
          : 0;
    return {
      at: c.at,
      side: c.side,
      full: c.full,
      top: Math.max(Math.min(c.full, c.low + 1), c.full - chip),
    };
  });
  return {
    columns,
    holes: [],
    anchor: [minOf(xs), minOf(ys)],
    loss: lossOf(
      columns,
      list.map(([, c]) => c.low),
    ),
  };
}

/** What the fall of a ruin is decided from. */
interface RuinFallIn {
  vols: readonly RuinVolumeIn[];
  seed: number;
  gableRoof: { x: number; y: number; w: number; h: number; ridge: "ew" | "ns" } | undefined;
  roofed: ReadonlySet<string>;
  opts: RuinOptions;
  u: (s: string) => number;
  cols: ReadonlyMap<string, WallColumn>;
  list: ColumnList;
}

/**
 * How a ruin falls: the standing corner it falls away from, the volume kept whole (generator 3), the gable wall that
 * stands, the rooms lost to stubs, the stub height and the bite out of each column's top.
 */
function ruinFall({ vols, seed, gableRoof, roofed, opts, u, cols, list }: RuinFallIn) {
  const bbox = (cs: ColumnList): [number, number, number, number] => [
    minOf(cs.map(([, c]) => c.at[0])),
    minOf(cs.map(([, c]) => c.at[1])),
    maxOf(cs.map(([, c]) => c.at[0])),
    maxOf(cs.map(([, c]) => c.at[1])),
  ];
  // the standing corner: a corner of the tall mass when one stands out (a tower over its hall), else of the whole
  const hmax = maxOf(list.map(([, c]) => c.full));
  const tall = list.filter(([, c]) => c.full >= 0.75 * hmax);
  const region = tall.length <= 0.5 * list.length && hmax >= 5 ? tall : list;
  const [x0, y0, x1, y1] = bbox(region);
  const corner = h32(`${seed}:ruin:anchor`) % 4;
  const anchor: [number, number] = [corner % 2 === 0 ? x0 : x1, corner < 2 ? y0 : y1];
  const dist = (c: { at: [number, number] }): number => Math.hypot(c.at[0] - anchor[0], c.at[1] - anchor[1]);
  const D = Math.max(1, maxOf(list.map(([, c]) => dist(c))));

  // generator 3: one roofed volume stays whole (the reference ruins keep most of a roof: the anchor), the nearest to
  // the standing corner among those nothing stands on
  let keep: string | undefined;
  if (opts.legibleCondition && opts.keepRoofed) {
    const hosts = new Set(vols.map((v) => v.on).filter((o): o is string => o !== null));
    let best = Infinity;
    for (const v of vols) {
      if (!roofed.has(v.id) || hosts.has(v.id) || v.on !== null) continue;
      const d =
        minOf(v.storeys.flatMap((s) => s.cells.map(([x, y]) => Math.hypot(x - anchor[0], y - anchor[1])))) -
        (opts.pitched?.has(v.id) ? 6 : 0);
      if (d < best - 1e-9) {
        best = d;
        keep = v.id;
      }
    }
  }
  const kept = (c: { vol: string; topVol: string }): boolean =>
    keep !== undefined && (c.vol === keep || c.topVol === keep);

  // a gable roof keeps the gable wall nearest the standing corner (its columns stand whole)
  let gable: Side | undefined;
  if (gableRoof) {
    if (gableRoof.ridge === "ew")
      gable =
        Math.abs(anchor[0] - gableRoof.x) <= Math.abs(anchor[0] - (gableRoof.x + gableRoof.w - 1))
          ? "W"
          : "E";
    else
      gable =
        Math.abs(anchor[1] - gableRoof.y) <= Math.abs(anchor[1] - (gableRoof.y + gableRoof.h - 1))
          ? "N"
          : "S";
  }
  const gableLine =
    gable === "W"
      ? (gableRoof?.x ?? 0)
      : gable === "E"
        ? (gableRoof?.x ?? 0) + (gableRoof?.w ?? 1) - 1
        : gable === "N"
          ? (gableRoof?.y ?? 0)
          : (gableRoof?.y ?? 0) + (gableRoof?.h ?? 1) - 1;
  const onGable = (c: { at: [number, number]; side: Side }): boolean =>
    gable !== undefined &&
    c.side === gable &&
    (gable === "W" || gable === "E" ? c.at[0] : c.at[1]) === gableLine;

  // rooms lost to stubs: ground volumes away from the standing corner (when there are several)
  const ground = vols.filter((v) => v.on === null);
  const onGround = new Set(ground.map((v) => v.id));
  const lost = new Set<string>();
  if (ground.length > 1)
    for (const v of ground) {
      const holds = v.storeys.some((s) =>
        s.cells.some(([x, y]) => Math.abs(x - anchor[0]) + Math.abs(y - anchor[1]) <= 1),
      );
      if (!holds && v.id !== keep && u(`lost:${v.id}`) < 0.6) lost.add(v.id);
    }
  // stub height: two and a half to four tiles above the floor (the reference keep's stubs: median 3.25; lower on a
  // low building)
  const stub = Math.min(2.5 + 1.5 * u("stub"), Math.max(1, hmax * 0.4));
  const noiseOf = (k: string, c?: { at: [number, number]; side: Side }): number => {
    const draw = (s: string): number => {
      const r = u(s);
      return ((opts.legibleCondition ? NOISE_LEGIBLE : NOISE).find(([p]) => r < p) ?? [1, 0])[1];
    };
    if (!opts.legibleCondition || !c) return draw(`noise:${k}`);
    // generator 3: the bite varies smoothly along a wall (a collapse has slopes and long runs, not teeth): drawn at a
    // knot every three columns and interpolated, with a half-tile of per-column grain on a fifth of the columns
    const along = c.side === "N" || c.side === "S" ? c.at[0] : c.at[1];
    const line = c.side === "N" || c.side === "S" ? c.at[1] : c.at[0];
    const i = Math.floor(along / 2);
    const t = (along - i * 2) / 2;
    const a = draw(`knot:${c.side}:${line}:${i}`);
    const b = draw(`knot:${c.side}:${line}:${i + 1}`);
    return a + (b - a) * t + (u(`grain:${k}`) < 0.45 ? 0.5 + (u(`grainH:${k}`) < 0.3 ? 0.5 : 0) : 0);
  };
  // generator 3: broken, not trimmed. A stretch of three columns may fall together (a notch), and the end of a wall or a
  // corner (a tower stub's edge) is bitten, so no cut top is a clean step or a long level run
  const rag = (k: string, c: { at: [number, number]; side: Side }): number => {
    if (!opts.legibleCondition) return 0;
    const along = c.side === "N" || c.side === "S" ? c.at[0] : c.at[1];
    const line = c.side === "N" || c.side === "S" ? c.at[1] : c.at[0];
    const [ux, uy] = c.side === "N" || c.side === "S" ? [1, 0] : [0, 1];
    const notch =
      u(`notch:${c.side}:${line}:${Math.floor(along / 3)}`) < 0.3
        ? 1 + 1.5 * u(`notchH:${c.side}:${line}:${Math.floor(along / 3)}`)
        : 0;
    const end =
      (!cols.has(`${c.at[0] - ux},${c.at[1] - uy},${c.side}`) ||
        !cols.has(`${c.at[0] + ux},${c.at[1] + uy},${c.side}`)) &&
      u(`end:${k}`) < 0.4
        ? 0.5 + u(`endH:${k}`)
        : 0;
    return notch + end;
  };
  const lows = list.map(([, c]) => c.low);
  return {
    vols,
    u,
    opts,
    cols,
    list,
    anchor,
    dist,
    D,
    keep,
    kept,
    gable,
    onGable,
    onGround,
    lost,
    stub,
    noiseOf,
    rag,
    lows,
  };
}

type RuinFall = ReturnType<typeof ruinFall>;

/**
 * The fallen columns: a standing plateau, then a diagonal fall a third of the building wide down to the stubs, each top
 * bitten; the fall reaches as far as it must to lose the building's drawn share of masonry (bisection).
 */
function fallenColumns(r: RuinFall): RuinColumn[] {
  const { list, onGable, kept, stub, dist, D, lost, u, opts, noiseOf, rag, onGround, lows } = r;
  const shape = (t: number) =>
    list.map(([k, c]) => {
      const floor = c.low;
      const full = c.full;
      if (onGable(c) || kept(c)) return { at: c.at, side: c.side, full, top: full };
      const sb = Math.min(full, floor + stub);
      // a standing plateau out to t, then a diagonal fall a third of the building wide down to the stubs
      const f = Math.max(0, Math.min(1, 1 - (dist(c) / D - t) / 0.35));
      const env = lost.has(c.vol)
        ? floor + (sb - floor) * (0.5 + 0.5 * u(`lostH:${k}`))
        : sb + (full - sb) * f ** 1.5;
      // the bite out of each top, cell by cell (never below a tile above the floor)
      // and now and then a fragment standing two tiles proud of the stubs round it (a pier, a door jamb)
      const proud = f < 1 && u(`proud:${k}`) < (opts.legibleCondition ? 0.05 : 0.12) ? 2 : 0;
      let top = Math.round((env + proud - noiseOf(k, c) - rag(k, c)) * 2) / 2;
      // a ground wall keeps a stub a tile tall; a mass standing on another may be gone to its floor
      // (generator 3: the lowest stubs are a tile or a tile and a half, so they are not one level line)
      const least = onGround.has(c.vol)
        ? Math.min(
            full,
            floor +
              (opts.legibleCondition &&
              u(
                `least:${c.side}:${c.side === "N" || c.side === "S" ? c.at[1] : c.at[0]}:${Math.floor((c.side === "N" || c.side === "S" ? c.at[0] : c.at[1]) / 2)}`,
              ) < 0.4
                ? 1.5
                : 1),
          )
        : floor;
      top = Math.max(least, Math.min(full, top));
      // generator 3: where the fall reached the lowest stubs, some are a half tile proud (no long level line at the foot)
      if (opts.legibleCondition && top <= least + 1e-6 && u(`stubup:${k}`) < 0.3)
        top = Math.min(full, top + 0.5);
      return { at: c.at, side: c.side, full, top };
    });
  // the share lost: 45–70 % of the masonry, drawn per building, reached by how far the fall reaches (bisection)
  const target = 0.45 + 0.25 * u("loss");
  let lo = -0.4;
  let hi = 1.2;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (lossOf(shape(mid), lows) > target) lo = mid;
    else hi = mid;
  }
  return shape(hi);
}

/**
 * Generator 3: a doorway or window frame keeps standing, with its arch, where the wall beside it has gone (one or two
 * per building, drawn by seed); the columns of its jambs are raised to the arch (`byKey` holds the fallen columns).
 */
function standingArches(
  r: RuinFall,
  byKey: ReadonlyMap<string, RuinColumn>,
): NonNullable<RuinProfile["arches"]> {
  const { opts, cols, vols, onGable, kept, u } = r;
  const arches: NonNullable<RuinProfile["arches"]> = [];
  if (opts.legibleCondition) {
    const cands: Array<{ o: NonNullable<RuinOptions["openings"]>[number]; top: number; w: number }> = [];
    for (const o of opts.openings ?? []) {
      const k0 = `${o.at[0]},${o.at[1]},${o.side}`;
      const col = cols.get(k0);
      const vol = col ? vols.find((v) => v.id === col.vol) : undefined;
      const archTop = vol && vol.on === null ? vol.storeys[0]?.relTop : undefined;
      if (archTop === undefined || !col || onGable(col) || kept(col)) continue;
      const along = o.side === "N" || o.side === "S" ? [1, 0] : [0, 1];
      const at = (k: number): { top: number } | undefined =>
        byKey.get(`${o.at[0] + (along[0] ?? 0) * k},${o.at[1] + (along[1] ?? 0) * k},${o.side}`);
      const own = Array.from({ length: o.width }, (_, k) => at(k));
      if (own.some((c) => !c)) continue;
      // free-standing: the wall beside it is gone (half a tile or more below the arch's top) and nothing taller
      // stands one cell further out
      const beside = [at(-1), at(o.width)].filter((c): c is { top: number } => c !== undefined);
      const beyond = [at(-2), at(o.width + 1)].filter((c): c is { top: number } => c !== undefined);
      if (beside.length === 0 || beside.some((c) => c.top > archTop - 0.5 + 1e-6)) continue;
      if (beyond.some((c) => c.top > archTop + 1e-6)) continue;
      cands.push({ o, top: archTop, w: u(`arch:${k0}`) });
    }
    cands.sort((a, b) => a.w - b.w);
    for (const c of cands) {
      if (arches.length >= 2 || c.w > 0.6) break;
      const along = c.o.side === "N" || c.o.side === "S" ? [1, 0] : [0, 1];
      for (let k = -1; k <= c.o.width; k++) {
        const col = byKey.get(
          `${c.o.at[0] + (along[0] ?? 0) * k},${c.o.at[1] + (along[1] ?? 0) * k},${c.o.side}`,
        );
        if (col) col.top = Math.max(col.top, Math.min(col.full, c.top));
      }
      arches.push({ at: [c.o.at[0], c.o.at[1]], side: c.o.side, width: c.o.width });
    }
  }
  return arches;
}

/**
 * Holes in upper floors: gone where the walls round them fell below the floor, else a fifth to a third of the floor
 * falls in, from the far side of the standing corner and in ragged holes.
 */
function floorHoles(r: RuinFall, byKey: ReadonlyMap<string, RuinColumn>): RuinProfile["holes"] {
  const { vols, keep, u, anchor, D } = r;
  const holes: RuinProfile["holes"] = [];
  for (const v of vols)
    v.storeys.forEach((s, si) => {
      if ((si === 0 && v.on === null) || v.id === keep) return;
      const own = new Set(s.cells.map(([x, y]) => `${x},${y}`));
      const faces: Array<{ top: number }> = [];
      const fallen = new Set<string>();
      for (const [x, y] of s.cells)
        for (const side of SIDES) {
          const [dx, dy] = STEP[side];
          if (own.has(`${x + dx},${y + dy}`)) continue;
          const c = byKey.get(`${x},${y},${side}`);
          if (!c) continue;
          faces.push(c);
          if (c.top < s.relFloor + 0.5) fallen.add(`${x},${y}`);
        }
      const support = faces.length ? faces.filter((c) => c.top >= s.relFloor + 0.5).length / faces.length : 1;
      if (support < 0.35) {
        holes.push({ volume: v.id, storey: si, cells: s.cells.map(([x, y]) => [x, y] as [number, number]) });
        return;
      }
      const share = 0.2 + 0.1 * u(`holes:${v.id}:${si}`);
      const scored = s.cells
        .map(([x, y]) => ({
          c: [x, y] as [number, number],
          score:
            1.5 * (Math.hypot(x - anchor[0], y - anchor[1]) / D) +
            u(`hole:${v.id}:${si}:${x},${y}`) +
            (fallen.has(`${x},${y}`) ? 1 : 0),
        }))
        .sort((a, b) => b.score - a.score || a.c[0] - b.c[0] || a.c[1] - b.c[1]);
      const n = Math.round(share * s.cells.length);
      if (n > 0) holes.push({ volume: v.id, storey: si, cells: scored.slice(0, n).map((q) => q.c) });
    });
  return holes;
}

/**
 * Generator 3: broken blocks and small rubble on the cut tops of a ruin's walls. A share of the cut columns carries
 * one (uneven, not every cell, more toward the fallen side); never on a doorway, breach or window cell (`blocked`
 * holds their "x,y,side" keys), never on a crest that a battlement remnant may take.
 */
export function scatterTopRubble(profile: RuinProfile, blocked: ReadonlySet<string>, seed: number): void {
  const u = (s: string): number => hashUnit(seed, "wallrubble", s);
  const [ax, ay] = profile.anchor;
  const dist = (c: { at: [number, number] }): number => Math.hypot(c.at[0] - ax, c.at[1] - ay);
  const D = Math.max(1, maxOf(profile.columns.map(dist)));
  const at = new Map(profile.columns.map((c) => [`${c.at[0]},${c.at[1]},${c.side}`, c]));
  const out: NonNullable<RuinProfile["topRubble"]> = [];
  for (const c of profile.columns) {
    const k = `${c.at[0]},${c.at[1]},${c.side}`;
    if (c.top >= c.full - 1e-6 || blocked.has(k)) continue;
    const [ux, uy] = c.side === "N" || c.side === "S" ? [1, 0] : [0, 1];
    // a piece turned across its column is wider than the column: none beside an opening either
    if (
      blocked.has(`${c.at[0] - ux},${c.at[1] - uy},${c.side}`) ||
      blocked.has(`${c.at[0] + ux},${c.at[1] + uy},${c.side}`)
    )
      continue;
    const p = at.get(`${c.at[0] - ux},${c.at[1] - uy},${c.side}`);
    const q = at.get(`${c.at[0] + ux},${c.at[1] + uy},${c.side}`);
    if (p && q && p.top < c.top && q.top < c.top) continue; // a crest: the battlement remnant's place
    if (u(`on:${k}`) >= 0.12 + 0.5 * (dist(c) / D)) continue;
    out.push({ at: c.at, side: c.side, top: c.top, kind: u(`kind:${k}`) < 0.55 ? "block" : "rubble" });
  }
  if (out.length) profile.topRubble = out;
}

export function lossOf(
  columns: ReadonlyArray<{ top: number; full: number }>,
  lows: readonly number[],
): number {
  let all = 0;
  let kept = 0;
  columns.forEach((c, i) => {
    const lo = lows[i] ?? 0;
    all += Math.max(0, c.full - lo);
    kept += Math.max(0, c.top - lo);
  });
  return all > 0 ? Math.round((1 - kept / all) * 1000) / 1000 : 0;
}

/** What the review reads off a weathered or ruined building (null when it is intact or has no profile). */
export interface RuinMeasures {
  /** Share of neighbouring wall columns (along a face) whose tops differ (reference keep 0.60; flat-topped ≥ 0.6 equal). */
  topVariety: number;
  /** Share of neighbouring columns whose tops differ by 2 tiles or more (reference 0.27). */
  topJump2: number;
  /** 90th percentile ÷ median of wall-top height above the ground floor (reference 3.0; uniform < 1.8). */
  contrast: number;
  /** Share of wall columns 4 tiles tall or less (reference 0.52). */
  stubShare: number;
  /** Share of the upper floors still present (reference 0.68–0.80); 1 with no upper floors. */
  upperFloorShare: number;
  /** Share of the masonry lost (ruins 0.35–0.70; weathered a few per cent). */
  loss: number;
  /** Share of the rubble lying inside the walls (reference 0.60). */
  rubbleInside: number;
  /**
   * Generator 3: the same two measures over the cut wall tops only (a column that stands whole under a roof is not a
   * "flat top"): share of neighbouring cut columns whose tops differ, and share of the runs of equal-height cut
   * columns along a face that are two cells or shorter (the study's temple 0.67; a clean cut is one long run).
   */
  cutVariety: number;
  runShort: number;
  /** Share of the wall columns standing whole (the intact, roofed anchor), and whether a roof stands on the ruin. */
  intactShare: number;
  /**
   * Generator 3: share of the cut columns that are one-cell peaks or pits between their neighbours (half a tile or more
   * each side): battlement teeth. A collapse has long runs and slopes; teeth alternate along most of a wall.
   */
  teeth: number;
}

export function structureRuinMeasures(st: ResolvedStructure): RuinMeasures | null {
  const r = st.ruin;
  if (!r || st.condition === undefined || st.condition === "intact" || r.columns.length === 0) return null;
  const floor0 = st.storeys[0]?.floorTop ?? 0;
  const at = new Map(r.columns.map((c) => [`${c.at[0]},${c.at[1]},${c.side}`, c]));
  let pairs = 0;
  let differ = 0;
  let jump = 0;
  for (const c of r.columns) {
    const along = c.side === "N" || c.side === "S" ? [1, 0] : [0, 1];
    const o = at.get(`${c.at[0] + (along[0] ?? 0)},${c.at[1] + (along[1] ?? 0)},${c.side}`);
    if (!o) continue;
    pairs++;
    const d = Math.abs(o.top - c.top);
    if (d > 0.01) differ++;
    if (d >= 2 - 1e-6) jump++;
  }
  // cut columns only: runs of equal-height tops along a face (a column standing whole breaks the run)
  const isCut = (c: { top: number; full: number }): boolean => c.top < c.full - 1e-6;
  let cutPairs = 0;
  let cutDiffer = 0;
  let runs = 0;
  let shortRuns = 0;
  for (const c of r.columns) {
    const along = c.side === "N" || c.side === "S" ? [1, 0] : [0, 1];
    const prev = at.get(`${c.at[0] - (along[0] ?? 0)},${c.at[1] - (along[1] ?? 0)},${c.side}`);
    const o = at.get(`${c.at[0] + (along[0] ?? 0)},${c.at[1] + (along[1] ?? 0)},${c.side}`);
    if (o && (isCut(c) || isCut(o))) {
      cutPairs++;
      if (Math.abs(o.top - c.top) > 0.01) cutDiffer++;
    }
    if (!isCut(c)) continue;
    // a run starts here when the column before it is missing, whole, or at another height
    if (prev && isCut(prev) && Math.abs(prev.top - c.top) <= 0.01) continue;
    let len = 1;
    let q = o;
    while (q && isCut(q) && Math.abs(q.top - c.top) <= 0.01) {
      len++;
      q = at.get(`${q.at[0] + (along[0] ?? 0)},${q.at[1] + (along[1] ?? 0)},${c.side}`);
    }
    runs++;
    if (len <= 2) shortRuns++;
  }
  // teeth: a cut column that is a one-cell peak or pit between two neighbours (regular battlements, not a collapse)
  let cutCols = 0;
  let teethN = 0;
  for (const c of r.columns) {
    if (!isCut(c)) continue;
    const along = c.side === "N" || c.side === "S" ? [1, 0] : [0, 1];
    const p = at.get(`${c.at[0] - (along[0] ?? 0)},${c.at[1] - (along[1] ?? 0)},${c.side}`);
    const o = at.get(`${c.at[0] + (along[0] ?? 0)},${c.at[1] + (along[1] ?? 0)},${c.side}`);
    if (!p || !o) continue;
    cutCols++;
    const up = c.top - p.top >= 0.5 - 1e-6 && c.top - o.top >= 0.5 - 1e-6;
    const down = p.top - c.top >= 0.5 - 1e-6 && o.top - c.top >= 0.5 - 1e-6;
    if (up || down) teethN++;
  }
  const hs = r.columns.map((c) => c.top - floor0).sort((a, b) => a - b);
  const q = (p: number): number => hs[Math.min(hs.length - 1, Math.floor(p * hs.length))] ?? 0;
  let upper = 0;
  for (const v of st.volumes ?? [])
    v.storeys.forEach((s, i) => {
      if (i > 0 || v.on !== null) upper += s.cells.length;
    });
  const gone = r.holes.reduce((n, h) => n + h.cells.length, 0);
  const cells = new Set(st.cells.map(([x, y]) => `${x},${y}`));
  const rubble = (st.debris ?? []).filter((d) => d.kind === "rubble");
  const round = (x: number): number => Math.round(x * 1000) / 1000;
  return {
    topVariety: pairs ? round(differ / pairs) : 0,
    topJump2: pairs ? round(jump / pairs) : 0,
    contrast: q(0.5) > 0 ? round(q(0.9) / q(0.5)) : 0,
    stubShare: round(hs.filter((h) => h <= 4 + 1e-6).length / hs.length),
    upperFloorShare: upper ? round(1 - gone / upper) : 1,
    loss: r.loss,
    rubbleInside: rubble.length
      ? round(rubble.filter((d) => cells.has(`${d.at[0]},${d.at[1]}`)).length / rubble.length)
      : 0,
    cutVariety: cutPairs ? round(cutDiffer / cutPairs) : 0,
    runShort: runs ? round(shortRuns / runs) : 1,
    intactShare: round(r.columns.filter((c) => !isCut(c)).length / r.columns.length),
    teeth: cutCols ? round(teethN / cutCols) : 0,
  };
}

/**
 * Eave faces of roofed volumes whose wall column is cut below half a tile under its full height: a roof with no wall
 * under its edge (an eave hanging over a gap). A roof must always be held up: such a bay keeps its wall, or the roof
 * goes above it (generator 3). Roofs fallen in (a ruin's gable-only wall) are not roofs here.
 */
export function roofUnsupportedEdges(st: ResolvedStructure): Array<{ at: [number, number]; side: Side }> {
  const cols = st.ruin?.columns;
  if (!cols || cols.length === 0) return [];
  const at = new Map(cols.map((c) => [`${c.at[0]},${c.at[1]},${c.side}`, c]));
  // generator 5 (ruinBays): the roof is open over a lost bay, so a fallen wall under a roof hole holds up nothing
  const open = new Set(
    st.ruin?.bays !== undefined ? (st.ruin.roofHoles ?? []).map(([x, y]) => `${x},${y}`) : [],
  );
  const out: Array<{ at: [number, number]; side: Side }> = [];
  for (const v of st.volumes ?? []) {
    if (v.roof.layers.length === 0 || v.roof.gableOnly !== undefined) continue;
    const top = v.storeys[v.storeys.length - 1];
    if (!top) continue;
    const own = new Set(top.cells.map(([x, y]) => `${x},${y}`));
    for (const [x, y] of top.cells)
      for (const side of SIDES) {
        const [dx, dy] = STEP[side];
        if (own.has(`${x + dx},${y + dy}`) || open.has(`${x},${y}`)) continue;
        const c = at.get(`${x},${y},${side}`);
        if (c && c.top < c.full - 0.5 - 1e-6) out.push({ at: [x, y], side });
      }
  }
  return out;
}

/**
 * What the review reads off a building to tell a weathered one from the same building intact (owner's in-game test,
 * 2026-11-20: a weathered building looked like an intact one). Every figure is 0 or low on an intact building.
 */
export interface WeatherMeasures {
  /** Share of the footprint's cells under a fallen roof patch. */
  roofMissing: number;
  /** Share of wall columns whose top is lower than intact, plus bitten parapet cells (may be 0 under a roof). */
  wallsChipped: number;
  /** Share of the windows with no light behind them (boarded ones included). */
  darkWindows: number;
  /** Share of the windows built as boarded, plain wall. */
  boardedWindows: number;
  /** Growth heaps against the foot of the walls per wall face cell. */
  baseGrowth: number;
  /** Details that fell or were taken away (chimney, mast, canopy). */
  missingDetails: number;
}

/** Minimums the review holds a weathered building to (generator 3): the signs that must show at a glance. */
export const WEATHER_MINIMUMS: Readonly<{
  roofMissing: number;
  darkWindows: number;
  boardedWindows: number;
  baseGrowth: number;
  /** Signs (of the five above, wallsChipped and missingDetails counting as one) a weathered building must show. */
  signs: number;
}> = {
  roofMissing: 0.12,
  darkWindows: 0.7,
  boardedWindows: 0.25,
  baseGrowth: 0.1,
  signs: 3,
};

/**
 * `arrangements`: the level's detail instances. Generator 5 grows the wall foot of a worn building with the
 * `wallFootGrowth` recipe instead of growth heaps in `debris`; the cells its instances hosted by this building cover
 * beside a wall face count as growth heaps do.
 */
export function weatherMeasures(
  st: ResolvedStructure,
  arrangements: readonly ResolvedArrangement[] = [],
): WeatherMeasures | null {
  if (st.condition === "ruined") return null;
  const r = st.ruin;
  const w = r?.weather;
  const round = (x: number): number => Math.round(x * 1000) / 1000;
  const cols = r?.columns ?? [];
  const cells = new Set(st.cells.map(([x, y]) => `${x},${y}`));
  let faces = 0;
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    for (const [dx, dy] of Object.values(STEP)) if (!cells.has(`${x + dx},${y + dy}`)) faces++;
  }
  const atFoot = ([x, y]: readonly [number, number]): boolean =>
    !cells.has(`${x},${y}`) && Object.values(STEP).some(([dx, dy]) => cells.has(`${x + dx},${y + dy}`));
  const grown = new Set(
    arrangements
      .filter((a) => a.recipe === "wallFootGrowth" && a.host === st.id)
      .flatMap((a) => a.cells.filter(atFoot).map(([x, y]) => `${x},${y}`)),
  );
  const growth =
    (st.debris ?? []).filter(
      (d) => d.kind === "growth" && atFoot(d.at) && !grown.has(`${d.at[0]},${d.at[1]}`),
    ).length + grown.size;
  const windows = w?.windows ?? 0;
  const boarded = w ? (windows > 0 ? w.boarded.length / windows : 1) : 0;
  const lit = st.lighting && st.lighting.windows !== "none" ? st.lighting.lit : 0;
  return {
    roofMissing: st.cells.length ? round((r?.roofHoles ?? []).length / st.cells.length) : 0,
    wallsChipped: cols.length
      ? round(
          Math.min(
            1,
            (cols.filter((c) => c.top < c.full - 1e-6).length + (w?.parapetBites.length ?? 0)) / cols.length,
          ),
        )
      : 0,
    darkWindows: round(boarded + (1 - boarded) * (1 - lit)),
    boardedWindows: round(boarded),
    baseGrowth: faces ? round(growth / faces) : 0,
    missingDetails: w?.lost.length ?? 0,
  };
}

/** How many of the five weathering signs a building shows (0 for an intact one, at least WEATHER_MINIMUMS.signs wanted). */
export function weatherSigns(m: WeatherMeasures): number {
  const T = WEATHER_MINIMUMS;
  return (
    Number(m.roofMissing >= T.roofMissing) +
    Number(m.darkWindows >= T.darkWindows) +
    Number(m.boardedWindows >= T.boardedWindows) +
    Number(m.baseGrowth >= T.baseGrowth) +
    Number(m.wallsChipped >= 0.05 || m.missingDetails > 0)
  );
}
