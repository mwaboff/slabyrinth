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
import type { ResolvedStructure } from "../contracts/resolved";
import { h32 } from "../util/hash";

const STEP: Record<Side, readonly [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const SIDES: readonly Side[] = ["N", "E", "S", "W"];

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
}

/** Share of masonry height given up per column: 0 (35 %), ½ (25 %), 1 (15 %), 2 (15 %), 3 (10 %). */
const NOISE: ReadonlyArray<readonly [number, number]> = [
  [0.35, 0],
  [0.6, 0.5],
  [0.75, 1],
  [0.9, 2],
  [1, 3],
];

export function ruinProfile(
  vols: readonly RuinVolumeIn[],
  condition: "weathered" | "ruined",
  seed: number,
  gableRoof?: { x: number; y: number; w: number; h: number; ridge: "ew" | "ns" },
  /** Volumes with a roof: a weathered building's walls under a roof stay whole (no gap under the eaves). */
  roofed: ReadonlySet<string> = new Set(),
): RuinProfile {
  const u = (s: string): number => h32(`${seed}:ruin:${s}`) / 4294967296;
  // wall columns: the outer face of every storey cell whose neighbour is not in that storey; its intact top is the
  // highest storey with that face; the volume of its lowest storey owns it (lost rooms go by volume)
  const cols = new Map<
    string,
    { at: [number, number]; side: Side; full: number; vol: string; low: number; topVol: string }
  >();
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
  const list = [...cols.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const xs = list.map(([, c]) => c.at[0]);
  const ys = list.map(([, c]) => c.at[1]);
  const bbox = (cs: typeof list): [number, number, number, number] => [
    Math.min(...cs.map(([, c]) => c.at[0])),
    Math.min(...cs.map(([, c]) => c.at[1])),
    Math.max(...cs.map(([, c]) => c.at[0])),
    Math.max(...cs.map(([, c]) => c.at[1])),
  ];
  if (list.length === 0) return { columns: [], holes: [], anchor: [0, 0], loss: 0 };

  if (condition === "weathered") {
    // chipped tops where nothing roofs them: one column in five loses half a tile or a tile; the shape stays whole
    const columns = list.map(([k, c]) => {
      const r = roofed.has(c.topVol) ? 1 : u(`chip:${k}`);
      const chip = r < 0.12 ? 0.5 : r < 0.2 ? 1 : 0;
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
      anchor: [Math.min(...xs), Math.min(...ys)],
      loss: lossOf(
        columns,
        list.map(([, c]) => c.low),
      ),
    };
  }

  // the standing corner: a corner of the tall mass when one stands out (a tower over its hall), else of the whole
  const hmax = Math.max(...list.map(([, c]) => c.full));
  const tall = list.filter(([, c]) => c.full >= 0.75 * hmax);
  const region = tall.length <= 0.5 * list.length && hmax >= 5 ? tall : list;
  const [x0, y0, x1, y1] = bbox(region);
  const corner = h32(`${seed}:ruin:anchor`) % 4;
  const anchor: [number, number] = [corner % 2 === 0 ? x0 : x1, corner < 2 ? y0 : y1];
  const dist = (c: { at: [number, number] }): number => Math.hypot(c.at[0] - anchor[0], c.at[1] - anchor[1]);
  const D = Math.max(1, ...list.map(([, c]) => dist(c)));

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
      if (!holds && u(`lost:${v.id}`) < 0.6) lost.add(v.id);
    }
  // stub height: two and a half to four tiles above the floor (the reference keep's stubs: median 3.25; lower on a
  // low building)
  const stub = Math.min(2.5 + 1.5 * u("stub"), Math.max(1, hmax * 0.4));
  const noiseOf = (k: string): number => {
    const r = u(`noise:${k}`);
    return (NOISE.find(([p]) => r < p) ?? [1, 0])[1];
  };
  const shape = (t: number) =>
    list.map(([k, c]) => {
      const floor = c.low;
      const full = c.full;
      if (onGable(c)) return { at: c.at, side: c.side, full, top: full };
      const sb = Math.min(full, floor + stub);
      // a standing plateau out to t, then a diagonal fall a third of the building wide down to the stubs
      const f = Math.max(0, Math.min(1, 1 - (dist(c) / D - t) / 0.35));
      const env = lost.has(c.vol)
        ? floor + (sb - floor) * (0.5 + 0.5 * u(`lostH:${k}`))
        : sb + (full - sb) * f ** 1.5;
      // the bite out of each top, cell by cell (never below a tile above the floor)
      // and now and then a fragment standing two tiles proud of the stubs round it (a pier, a door jamb)
      const proud = f < 1 && u(`proud:${k}`) < 0.12 ? 2 : 0;
      let top = Math.round((env + proud - noiseOf(k)) * 2) / 2;
      // a ground wall keeps a stub a tile tall; a mass standing on another may be gone to its floor
      const least = onGround.has(c.vol) ? Math.min(full, floor + 1) : floor;
      top = Math.max(least, Math.min(full, top));
      return { at: c.at, side: c.side, full, top };
    });
  const lows = list.map(([, c]) => c.low);
  // the share lost: 45–70 % of the masonry, drawn per building, reached by how far the fall reaches (bisection)
  const target = 0.45 + 0.25 * u("loss");
  let lo = -0.4;
  let hi = 1.2;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (lossOf(shape(mid), lows) > target) lo = mid;
    else hi = mid;
  }
  const columns = shape(hi);
  const byKey = new Map(columns.map((c) => [`${c.at[0]},${c.at[1]},${c.side}`, c]));

  // holes in upper floors: gone where the walls round them fell below the floor, else a fifth to a third of the floor
  // falls in, from the far side of the standing corner and in ragged holes
  const holes: RuinProfile["holes"] = [];
  for (const v of vols)
    v.storeys.forEach((s, si) => {
      if (si === 0 && v.on === null) return;
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

  return { columns, holes, anchor, loss: lossOf(columns, lows), ...(gable ? { gable } : {}) };
}

function lossOf(columns: ReadonlyArray<{ top: number; full: number }>, lows: readonly number[]): number {
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
  };
}

/** What the review reads off a weathered building: it must differ measurably from the same building intact. */
export interface WeatherMeasures {
  /** Share of the main roof's cells under a fallen patch (minimum 0.05). */
  roofMissing: number;
  /** Share of wall columns whose top differs from the intact top (unroofed walls only; may be 0). */
  wallsChipped: number;
  /** Share of the windows left dark (minimum 0.5 where the style lights its windows). */
  darkWindows: number;
}

/** Minimums the review holds a weathered building to (roof patch, dark windows). */
export const WEATHER_MINIMUMS: Readonly<{ roofMissing: number; darkWindows: number }> = {
  roofMissing: 0.05,
  darkWindows: 0.5,
};

export function weatherMeasures(st: ResolvedStructure): WeatherMeasures | null {
  if (st.condition !== "weathered" || !st.ruin) return null;
  const cols = st.ruin.columns;
  const round = (x: number): number => Math.round(x * 1000) / 1000;
  return {
    roofMissing: st.cells.length ? round((st.ruin.roofHoles ?? []).length / st.cells.length) : 0,
    wallsChipped: cols.length ? round(cols.filter((c) => c.top < c.full - 1e-6).length / cols.length) : 0,
    darkWindows: round(st.lighting && st.lighting.windows !== "none" ? 1 - st.lighting.lit : 1),
  };
}
