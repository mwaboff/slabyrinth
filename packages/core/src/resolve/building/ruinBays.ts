/**
 * Ruin by bays (generator 5, switch `ruinBays`; plan §11.1, P7-P11): a ruin is a sound building that lost a few whole
 * bays, not a building nibbled evenly. The building is planned intact; then collapse events are drawn on it:
 *
 *   count     about one per 25-35 tiles of long wall (a building's draw), one at severity 1 ("crumbling"); every ruin
 *             has at least one.
 *   where     a stretch of a straight face away from every doorway (and its neighbours), a party wall and a porch, on a
 *             face not used yet where one is left; two events on one face stand well apart.
 *   breach    one to three cells of the ground storey fall open (an empty opening, walkable); the wall either side steps
 *             down toward it over one or two cells (a ragged U), every top on the half-tile grid.
 *   bay       the cells from the breach face across the building to the opposite wall, over the breach and its taper:
 *             the roof is open above them and the upper floors are gone there.
 *   notch     the opposite wall of the same bay loses a smaller notch (a tile or a tile and a half, never to its foot).
 *   the rest  every other wall stands to its full height under its roof (a level top). At severity 3 ("collapsed") the
 *             roof has gone and about half the runs of STEP_RUN or more with no event take one big step down (two
 *             tiles, or what the storey allows) from one end.
 *
 * Rubble graded from the breach is a detail recipe (resolve/recipes/condition.ts `breachRubble`). Which events a ruin
 * draws is a treatment family (treatments.ts STRUCTURE_TREATMENTS `ruinEvents`), with its parameters (pitch, widths,
 * taper, notch depth, positions) drawn per building, so a ruined street never shows the same breach twice. Structure
 * stays on the grid: nothing turns, every wall column keeps its cell.
 */
import type { Side } from "../../contracts/plan";
import { SIDE_STEP as STEP, SIDES } from "../../gen/gridGeometry";
import { openingTests } from "../../gen/openingKinds";
import { hashUnitMixed } from "../../util/hash";
import { drawStructureOption, type Subject } from "../recipes/treatments";
import { lossOf, type RuinProfile, wallColumns } from "../ruin";
import type { BuildingCtx } from "./context";
import { type BuildingFaces, GROUND_FACES, party } from "./faces";
import { alongFace, faceKey, faceRuns, key, type FaceRun } from "./footprint";
import type { GroundOpening, Porch, VolumePlan } from "./types";
import type { GroundFootprint } from "./volumes";

/** One event per this many tiles of long wall (a building's draw within the range). */
const PITCH = [25, 35] as const;
/** A run shorter than this takes no event (it has no bay to lose beside its corners). */
const MIN_RUN = 5;
/** Events on one run stand at least this many cells apart (between their tapers). */
const APART = 3;
/** A breach is this wide (cells): 1 or 2, 3 for a wide event. */
const WIDE = 3;
/** The opposite wall's notch: this much lower at its middle (a building's draw), never below a tile over the floor. */
const NOTCH = [1, 1.5] as const;
/** At severity 3 a run this long or longer without an event may step down over this share of it from one end. */
const STEP_RUN = 6;
const STEP_SHARE = [0.25, 0.4] as const;
/** The share of wall columns that stand whole (a level top) the steps leave at least. */
const LEVEL_SHARE = 0.6;

/** A drawn event before it is applied. */
interface Event {
  readonly run: FaceRun;
  readonly a0: number;
  readonly width: number;
  readonly taper: number;
}

const half = (x: number): number => Math.round(x * 2) / 2;

/** The along coordinate of a cell on a face (x on N/S, y on E/W) and its line. */
const alongOf = (side: Side, c: readonly [number, number]): number =>
  side === "N" || side === "S" ? c[0] : c[1];

/**
 * Plans a ruin's collapse events on the intact building: the wall columns (relative to the ground floor top), the
 * breaches (added to `faces.ground`), the open bays (roof holes and fallen upper floors), and at severity 3 the fallen
 * roof (every volume's roof layers are emptied).
 */
export function ruinBays(
  b: BuildingCtx,
  fp: GroundFootprint,
  vplans: readonly VolumePlan[],
  main: VolumePlan,
  faces: BuildingFaces,
  porches: readonly Porch[],
  s: Subject,
): RuinProfile {
  // (named by the building's id too: two ruins built from one variety seed still lose different bays)
  const seed = `${b.seed}|${b.st.id}|ruinBays`;
  const u = (...what: Array<string | number>): number => hashUnitMixed(seed, ...what);
  const jit = (what: string, [lo, hi]: readonly [number, number]): number =>
    lo + (hi - lo) * u("jitter", what);
  const cols = wallColumns(vplans);
  const list = [...cols.entries()].sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
  const columns = list.map(([, c]) => ({ at: c.at, side: c.side, top: c.full, full: c.full }));
  const byKey = new Map(columns.map((c) => [faceKey(c.at[0], c.at[1], c.side), c]));
  const lowOf = new Map(list.map(([k, c]) => [k, c.low]));
  const gt = main.storeys[0]?.relTop ?? 2;
  const ground = faces.ground;
  const doorway = openingTests(b.gen).doorway;
  const wide = drawStructureOption("ruinEvents", s, seed) === "wide";

  // cells kept whole: a doorway with a cell either side and two more along, a porch's front, a party wall
  const keep = new Set<string>();
  for (const g of ground)
    if (doorway(g.kind))
      for (let k = -2; k <= g.width + 1; k++) keep.add(faceKey(...alongFace(g.at, g.side, k), g.side));
  const porchCells = new Set(porches.flatMap((p) => p.cells.map(([x, y]) => key(x, y))));
  // a volume standing on another keeps its host's cells whole (no bay opens under a tower)
  const under = new Set(
    vplans
      .filter((v) => v.on !== null)
      .flatMap((v) => (v.storeys[0]?.cells ?? []).map(([x, y]) => key(x, y))),
  );
  const free = (c: readonly [number, number], side: Side): boolean => {
    const [dx, dy] = STEP[side];
    return (
      !keep.has(faceKey(c[0], c[1], side)) &&
      !porchCells.has(key(c[0] + dx, c[1] + dy)) &&
      !under.has(key(c[0], c[1])) &&
      b.inBounds(c[0] + dx * 2, c[1] + dy * 2) &&
      !party(b, c[0] + dx, c[1] + dy)
    );
  };

  // how many events: one per PITCH tiles of long wall
  const runs = SIDES.flatMap((side) => faceRuns(fp.cellSet, side)).filter((r) => r.cells.length >= MIN_RUN);
  const longWall = runs.reduce((n, r) => n + r.cells.length, 0);
  const pitch = jit("pitch", PITCH);
  const count = s.severity === 1 ? 1 : Math.max(1, Math.round(longWall / pitch));

  const events: Event[] = [];
  const used = new Set<Side>();
  for (let i = 0; i < count; i++) {
    const width = wide && i === 0 ? WIDE : u("width", i) < 0.55 ? 2 : 1;
    const taper = u("taper", i) < 0.5 ? 1 : 2;
    let best: { e: Event; score: number } | null = null;
    for (const run of runs) {
      const n = run.cells.length;
      for (let a0 = taper; a0 + width + taper <= n; a0++) {
        const cells = run.cells.slice(a0 - taper, a0 + width + taper);
        if (!cells.every((c) => free(c, run.side))) continue;
        const clash = events.some(
          (o) =>
            o.run === run &&
            a0 - taper < o.a0 + o.width + o.taper + APART &&
            o.a0 - o.taper < a0 + width + taper + APART,
        );
        if (clash) continue;
        const line =
          run.side === "N" || run.side === "S" ? (run.cells[0]?.[1] ?? 0) : (run.cells[0]?.[0] ?? 0);
        const score = u("where", i, run.side, line, a0) - (used.has(run.side) ? 1 : 0);
        if (!best || score > best.score) best = { e: { run, a0, width, taper }, score };
      }
    }
    if (!best) break;
    events.push(best.e);
    used.add(best.e.run.side);
  }

  const holes: RuinProfile["holes"] = [];
  const bays: NonNullable<RuinProfile["bays"]> = [];
  const roofHoles = new Set<string>();
  events.forEach((e, i) => {
    const side = e.run.side;
    const cells = e.run.cells.slice(e.a0, e.a0 + e.width);
    // the breach: windows in it go, the wall falls open to the ground (an empty opening a ruin keeps open to the top)
    for (let j = ground.length - 1; j >= 0; j--) {
      const g = ground[j] as GroundOpening;
      if (doorway(g.kind)) continue;
      const hit = cells.some((c) =>
        Array.from({ length: g.width }, (_, k) => alongFace(g.at, g.side, k)).some(
          ([x, y]) => g.side === side && x === c[0] && y === c[1],
        ),
      );
      if (hit) ground.splice(j, 1);
    }
    for (const c of cells) faces.take(GROUND_FACES, 0, faceKey(c[0], c[1], side));
    const first = cells[0] as [number, number];
    ground.push({ id: faces.nextId("breach"), kind: "open", at: [first[0], first[1]], side, width: e.width });
    // its columns end at the ground storey's top; the wall either side steps down toward it (a ragged U)
    for (const c of cells) {
      const col = byKey.get(faceKey(c[0], c[1], side));
      if (col) col.top = Math.min(col.full, gt);
    }
    for (let k = 1; k <= e.taper; k++)
      for (const idx of [e.a0 - k, e.a0 + e.width - 1 + k]) {
        const c = e.run.cells[idx];
        const col = c ? byKey.get(faceKey(c[0], c[1], side)) : undefined;
        if (!c || !col) continue;
        const low = lowOf.get(faceKey(c[0], c[1], side)) ?? 0;
        const f = 1 - k / (e.taper + 1);
        const rag = (u("rag", i, idx) - 0.5) * 0.5;
        col.top = Math.max(
          low + 0.5,
          Math.min(col.full, half(col.full - (f + rag) * (col.full - low - 0.5))),
        );
      }
    // the bay: from each cell of the breach and its taper, inward across the building to the opposite wall
    const [dx, dy] = STEP[side];
    const bay: Array<[number, number]> = [];
    const span = e.run.cells.slice(e.a0 - e.taper, e.a0 + e.width + e.taper);
    for (const c of span) {
      let x = c[0];
      let y = c[1];
      let last: [number, number] = [x, y];
      while (fp.cellSet.has(key(x, y))) {
        bay.push([x, y]);
        last = [x, y];
        x -= dx;
        y -= dy;
      }
      // the notch in the opposite wall of the same bay: deepest at the breach's middle, half a tile at its edges
      const opp: Side = ({ N: "S", S: "N", E: "W", W: "E" } as const)[side];
      const col = byKey.get(faceKey(last[0], last[1], opp));
      if (!col) continue;
      const low = lowOf.get(faceKey(last[0], last[1], opp)) ?? 0;
      const a = alongOf(side, c);
      const mid =
        (alongOf(side, cells[0] as [number, number]) +
          alongOf(side, cells[cells.length - 1] as [number, number])) /
        2;
      const d = Math.abs(a - mid);
      const core = Math.max(0.5, (e.width - 1) / 2) + 0.01;
      const depth = d <= core ? jit(`notch${i}`, NOTCH) : d <= core + 1 ? 0.5 : 0;
      if (depth > 0) col.top = Math.max(low + 1, Math.min(col.top, half(col.full - depth)));
    }
    for (const [x, y] of bay) roofHoles.add(key(x, y));
    bays.push({ at: [first[0], first[1]], side, width: e.width, cells: bay });
  });

  // the open bays: the upper floors have fallen there
  for (const v of vplans)
    v.storeys.forEach((st, si) => {
      if (si === 0 && v.on === null) return;
      const cells = st.cells.filter(([x, y]) => roofHoles.has(key(x, y)));
      if (cells.length > 0) holes.push({ volume: v.id, storey: si, cells: cells.map(([x, y]) => [x, y]) });
    });

  // severity 3: the roof has gone; long runs with no event take one big step down from a free end
  if (s.severity === 3) {
    runs.forEach((run, ri) => {
      if (events.some((e) => e.run === run) || run.cells.length < STEP_RUN || u("step", ri) < 0.5) return;
      const n = run.cells.length;
      const len = Math.max(2, Math.round(n * jit(`stepLen${ri}`, STEP_SHARE)));
      // (the walls stay mostly level: a step that would leave less than LEVEL_SHARE of the columns whole is not taken)
      const whole = columns.filter((c) => c.top >= c.full - 1e-6).length;
      if (whole - len < LEVEL_SHARE * columns.length) return;
      const fromEnd = u("stepEnd", ri) < 0.5;
      for (let k = 0; k < len; k++) {
        const c = run.cells[fromEnd ? n - 1 - k : k] as [number, number];
        const fk = faceKey(c[0], c[1], run.side);
        const col = byKey.get(fk);
        if (!col || keep.has(fk)) continue;
        const low = lowOf.get(fk) ?? 0;
        col.top = Math.max(low + 1, Math.min(col.top, half(col.full - 2)));
      }
    });
  }

  const first = bays[0];
  return {
    columns,
    holes,
    anchor: first ? first.at : (fp.cells[0] ?? [0, 0]),
    loss: lossOf(
      columns,
      list.map(([, c]) => c.low),
    ),
    roofHoles: [...roofHoles].sort().map((k) => k.split(",").map(Number) as [number, number]),
    ...(bays.length > 0 ? { bays } : {}),
  };
}
