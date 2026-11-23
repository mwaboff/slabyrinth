/**
 * Placement of props (the pieces of features), per level: props that overlap each other, then each prop in index order:
 * inside the level, backed by a wall when wall-mounted, clear of wall pieces (pushed out when that is a safe repair),
 * and standing on something.
 *
 * Emits per level `verify_props_overlap` (warning when two built props overlap, info when one is organic), then per
 * prop `verify_prop_outside`, `verify_mount_no_wall`, `verify_prop_nudged` (info, repaired) or `verify_prop_in_wall`,
 * and one of `verify_prop_sunk`, `verify_prop_no_floor`, `verify_prop_floating` (warnings); `verify_line_unanchored`
 * comes from the floating test (lines.ts). A nudge moves the placement and its box (the set's `placed` box too).
 */
import type { CompileDiagnosticCode } from "../../contracts/compiler";
import type { ResolvedFeature, ResolvedLevel } from "../../contracts/resolved";
import { EDGE } from "../../contracts/resolved";
import { featureInfo, isBandRock } from "../../gen/catalog";
import { SIDE_STEP } from "../../gen/gridGeometry";
import type { LevelGrid } from "../../resolve/levelGrid";
import type { VerifyCtx } from "./context";
import { overlap1, type Solid, type SolidIndex } from "./grid";
import {
  FLOAT_TOLERANCE,
  MOUNT_BACKING_REACH,
  NUDGE_CLEARANCE,
  NUDGE_FOOTPRINT_SLACK,
  NUDGE_MAX,
  PROP_IN_WALL_HEIGHT,
  PROP_IN_WALL_MIN,
  PROP_OVERLAP_HEIGHT,
  PROP_OVERLAP_MIN_AREA,
  PROP_OVERLAP_SHARE,
  PROP_SAME_SPOT_SHARE,
  SEAM_REACH,
  SUPPORT_SLACK,
} from "./limits";
import { OverheadLines } from "./lines";
import { wallish } from "./walls";
import { elementRef, fmt, round2, round4, solidLabel } from "./words";
import { maxOf } from "../../util/lists";

/** The codes this file emits (VERIFY_CODES is the union of every check's list; lines.ts has its own). */
export const PROP_CODES = [
  "verify_props_overlap",
  "verify_prop_outside",
  "verify_mount_no_wall",
  "verify_prop_nudged",
  "verify_prop_in_wall",
  "verify_prop_sunk",
  "verify_prop_no_floor",
  "verify_prop_floating",
] as const satisfies readonly CompileDiagnosticCode[];

/** What every prop check of a level reads. */
interface PropLevel {
  readonly ctx: VerifyCtx;
  readonly solids: SolidIndex;
  readonly L: ResolvedLevel;
  readonly g: LevelGrid;
  /** Lowest base of each feature's pieces ("level|element"): the other pieces of an assembly stand on it. */
  readonly assemblyBase: ReadonlyMap<string, number>;
  readonly lines: OverheadLines;
}

export function checkProps(ctx: VerifyCtx, solids: SolidIndex): void {
  const assemblyBase = new Map<string, number>();
  for (const s of solids.all) {
    if (s.role !== "feature") continue;
    const k = `${s.levelId}|${s.p.source.elementId ?? ""}`;
    assemblyBase.set(k, Math.min(assemblyBase.get(k) ?? Infinity, s.p.y));
  }
  const lines = new OverheadLines(solids, ctx.report);
  for (const L of ctx.levels) {
    const g = ctx.grids.get(L.id);
    if (!g) continue;
    const lv: PropLevel = { ctx, solids, L, g, assemblyBase, lines };
    const props = solids.all.filter((s) => s.levelId === L.id && s.role === "feature");
    checkPropOverlaps(lv, props);
    for (const s of props) checkProp(lv, s);
  }
}

/**
 * `verify_props_overlap`: pairs of blocking or organic props of different features that share space (each pair once).
 * Generator 5 (`layeredProps`): pieces pasted in game survive overlapping (the engine-operators proof), so layering is
 * no fault: only two pieces of blocking furniture in one spot (sharing PROP_SAME_SPOT_SHARE of the smaller) are a
 * warning, a layout fault; every other overlap is info.
 */
function checkPropOverlaps({ ctx, solids, L }: PropLevel, props: readonly Solid[]): void {
  const layered = ctx.profile.layeredProps;
  const furniture = (s: Solid): boolean => {
    const f = ctx.featureOf(L.id, s.p.source.elementId);
    return f !== undefined && f.blocking && featureInfo(f.type).category === "furniture";
  };
  let pairs = 0;
  let builtPairs = 0;
  let sameSpot = 0;
  const examples: string[] = [];
  const spotExamples: string[] = [];
  const seenPair = new Set<string>();
  for (const a of props) {
    if (!a.blocking && !a.organic) continue;
    for (const b of solids.overlapping(a.box)) {
      if (b === a || b.role !== "feature" || b.levelId !== L.id || (!b.blocking && !b.organic)) continue;
      const ida = a.p.source.elementId ?? "";
      const idb = b.p.source.elementId ?? "";
      const key = ida < idb ? `${ida}|${idb}` : `${idb}|${ida}`;
      if (seenPair.has(key) || a.p.source.elementId === b.p.source.elementId) continue;
      const ox = overlap1(a.box.min.x, a.box.max.x, b.box.min.x, b.box.max.x);
      const oz = overlap1(a.box.min.z, a.box.max.z, b.box.min.z, b.box.max.z);
      const oy = overlap1(a.box.min.y, a.box.max.y, b.box.min.y, b.box.max.y);
      const areaA = (a.box.max.x - a.box.min.x) * (a.box.max.z - a.box.min.z);
      const areaB = (b.box.max.x - b.box.min.x) * (b.box.max.z - b.box.min.z);
      if (
        oy > PROP_OVERLAP_HEIGHT &&
        ox * oz > PROP_OVERLAP_SHARE * Math.min(areaA, areaB) &&
        ox * oz > PROP_OVERLAP_MIN_AREA
      ) {
        seenPair.add(key);
        pairs++;
        // natural pieces (tree canopies, rock piles) overhang what stands beside them by design: only two built
        // pieces overlapping is a warning
        if (!a.organic && !b.organic) builtPairs++;
        const spot = furniture(a) && furniture(b) && ox * oz > PROP_SAME_SPOT_SHARE * Math.min(areaA, areaB);
        const label = `${solidLabel(a)} and ${solidLabel(b)}`;
        if (spot) {
          sameSpot++;
          if (spotExamples.length < 3) spotExamples.push(label);
        }
        if (examples.length < 3) examples.push(label);
      }
    }
  }
  if (pairs > 0 && layered)
    ctx.report.add({
      severity: sameSpot > 0 ? "warning" : "info",
      code: "verify_props_overlap",
      levelId: L.id,
      count: sameSpot > 0 ? sameSpot : pairs,
      message:
        sameSpot > 0
          ? `${sameSpot} pair${sameSpot > 1 ? "s" : ""} of furniture stand in the same spot on level ${L.id} (e.g. ${spotExamples.join("; ")}).`
          : `${pairs} pair${pairs > 1 ? "s" : ""} of props overlap on level ${L.id} (e.g. ${examples.join("; ")}), layered on purpose or touching.`,
      ...(sameSpot > 0 ? { hint: "Move one of the two pieces of furniture to its own spot." } : {}),
    });
  else if (pairs > 0)
    ctx.report.add({
      severity: builtPairs > 0 ? "warning" : "info",
      code: "verify_props_overlap",
      levelId: L.id,
      count: pairs,
      message: `${pairs} pair${pairs > 1 ? "s" : ""} of props overlap on level ${L.id} (e.g. ${examples.join("; ")}); TaleSpire can silently drop overlapping props when pasting.`,
      hint: "Space these features at least one cell apart (scatter: raise minSpacing).",
    });
}

/** The checks of one prop, in order; the first that settles where the prop stands ends them. */
function checkProp(lv: PropLevel, s: Solid): void {
  const { ctx, solids, L, g } = lv;
  const f = ctx.featureOf(L.id, s.p.source.elementId);
  // generator 3: the rock band skirts the board's edge from the base plane, partly outside the level and over no floor
  // by design (cliffband.ts checks every piece rests on something)
  if (ctx.profile.restingCliffBand && f !== undefined && isBandRock(f.type)) return;
  // the prop's centre before any nudge: the support tests below measure there
  const cx = (s.box.min.x + s.box.max.x) / 2;
  const cz = (s.box.min.z + s.box.max.z) / 2;
  const pc = solids.toPlan(cx, cz);
  if (!g.cell(Math.floor(pc.px), Math.floor(pc.py)).inBounds) {
    ctx.report.add({
      severity: "warning",
      code: "verify_prop_outside",
      levelId: L.id,
      ...elementRef(s.p.source.elementId),
      assets: [s.name],
      message: `${solidLabel(s)} sits outside the bounds of level ${L.id}.`,
      hint: `Move feature ${s.p.source.elementId ?? ""} inside the level bounds.`,
    });
    return;
  }
  if (s.wallMounted && f?.wall) {
    checkWallMount(lv, s, f, f.wall, pc);
    return;
  }
  // organic dressing (rocks, mushrooms, trees) at random 15° turns may clip a corner into rock walls: harmless. An
  // arrangement's piece is set as part of its instance (a trim may touch a wall on purpose) and never moved alone.
  if (!s.isTileFeature && !s.organic && !s.arranged) pushOutOfWall(lv, s, f, cx, cz);
  checkSupport(lv, s, cx, cz, pc);
}

/** `verify_mount_no_wall`: a wall-mounted prop needs a wall or opening edge on its side with a wall piece behind it. */
function checkWallMount(
  { ctx, solids, L, g }: PropLevel,
  s: Solid,
  f: ResolvedFeature,
  wall: NonNullable<ResolvedFeature["wall"]>,
  pc: { px: number; py: number },
): void {
  const kind = g.edgeKind(f.at[0], f.at[1], wall);
  const backing = solids
    .near(pc.px, pc.py)
    .concat(
      solids.near(f.at[0], f.at[1]),
      solids.near(f.at[0] + SIDE_STEP[wall][0], f.at[1] + SIDE_STEP[wall][1]),
    )
    .some(
      (q) =>
        q.levelId === L.id &&
        wallish(q) &&
        boxDist(q, s.p.x, s.p.z) < MOUNT_BACKING_REACH &&
        overlap1(q.box.min.y, q.box.max.y, s.box.min.y, s.box.max.y) > 0,
    );
  if ((kind === EDGE.WALL || kind === EDGE.OPENING) && backing) return;
  ctx.report.add({
    severity: "warning",
    code: "verify_mount_no_wall",
    levelId: L.id,
    ...elementRef(s.p.source.elementId),
    cell: [f.at[0], f.at[1]],
    side: wall,
    assets: [s.name],
    message: `${solidLabel(s)} is wall-mounted on the ${wall} side of ${fmt([f.at[0], f.at[1]])}, but there is no wall piece there.`,
    hint: `Set wall of feature ${s.p.source.elementId ?? ""} to a side of its cell that has a wall.`,
  });
}

/**
 * Prop and wall penetration, for the first wall piece the prop pokes into: moved out across the thinner overlap when it
 * pokes in no further than `NUDGE_MAX` and stays on its feature's footprint (repair, `verify_prop_nudged`), else
 * `verify_prop_in_wall`.
 */
function pushOutOfWall(
  { ctx, solids, L }: PropLevel,
  s: Solid,
  f: ResolvedFeature | undefined,
  cx: number,
  cz: number,
): void {
  const walls = solids
    .overlapping(s.box)
    .filter(
      (q) =>
        q.levelId === L.id &&
        wallish(q) &&
        overlap1(q.box.min.y, q.box.max.y, s.box.min.y, s.box.max.y) > PROP_IN_WALL_HEIGHT,
    );
  for (const q of walls) {
    const ox = overlap1(q.box.min.x, q.box.max.x, s.box.min.x, s.box.max.x);
    const oz = overlap1(q.box.min.z, q.box.max.z, s.box.min.z, s.box.max.z);
    if (ox <= PROP_IN_WALL_MIN || oz <= PROP_IN_WALL_MIN) continue;
    const alongX = ox < oz;
    const pen = (alongX ? ox : oz) + NUDGE_CLEARANCE;
    const qc = alongX ? (q.box.min.x + q.box.max.x) / 2 : (q.box.min.z + q.box.max.z) / 2;
    const sc = alongX ? cx : cz;
    const dir = sc >= qc ? 1 : -1;
    const fp = f ? footprintWorld(solids, f) : null;
    const fits =
      fp !== null &&
      pen <= NUDGE_MAX &&
      (alongX
        ? s.box.min.x + dir * pen >= fp.x0 - NUDGE_FOOTPRINT_SLACK &&
          s.box.max.x + dir * pen <= fp.x1 + NUDGE_FOOTPRINT_SLACK
        : s.box.min.z + dir * pen >= fp.z0 - NUDGE_FOOTPRINT_SLACK &&
          s.box.max.z + dir * pen <= fp.z1 + NUDGE_FOOTPRINT_SLACK);
    if (ctx.repair && fits) {
      nudge(ctx, solids, s, alongX, dir * pen);
      const compass = alongX ? (dir > 0 ? "east" : "west") : dir > 0 ? "north" : "south";
      ctx.report.add({
        severity: "info",
        code: "verify_prop_nudged",
        levelId: L.id,
        ...elementRef(s.p.source.elementId),
        assets: [s.name, q.name],
        message: `${solidLabel(s)} poked ${round2(pen - NUDGE_CLEARANCE)} tiles into ${q.name}; it was moved ${round2(pen)} tiles ${compass}.`,
        repaired: `moved ${s.name} ${round2(pen)} tiles ${compass}`,
      });
    } else {
      ctx.report.add({
        severity: "warning",
        code: "verify_prop_in_wall",
        levelId: L.id,
        ...elementRef(s.p.source.elementId),
        assets: [s.name, q.name],
        message: `${solidLabel(s)} is ${round2(pen - NUDGE_CLEARANCE)} tiles inside ${q.name}; it is too big for its cell next to that wall.`,
        hint: `Move feature ${s.p.source.elementId ?? ""} one cell away from the wall, or use a smaller variant.`,
      });
    }
    return;
  }
}

/** Moves a prop by `d` along world x (`alongX`) or z: its placement, its box, the set's record of it, and the index. */
function nudge(ctx: VerifyCtx, solids: SolidIndex, s: Solid, alongX: boolean, d: number): void {
  solids.remove(s);
  if (alongX) {
    s.p.x = round4(s.p.x + d);
    s.box = { min: { ...s.box.min, x: s.box.min.x + d }, max: { ...s.box.max, x: s.box.max.x + d } };
  } else {
    s.p.z = round4(s.p.z + d);
    s.box = { min: { ...s.box.min, z: s.box.min.z + d }, max: { ...s.box.max, z: s.box.max.z + d } };
  }
  const known = ctx.set.placed?.get(s.p);
  if (known) known.box = s.box;
  solids.add(s);
  ctx.report.repairs++;
}

/**
 * What the prop stands on, measured under its centre: sunk into a floor (`verify_prop_sunk`), nothing under it
 * (`verify_prop_no_floor`), or raised above it (`verify_prop_floating`) unless it is an upper piece of an assembly,
 * hung from the ceiling or from an overhead line that holds.
 */
function checkSupport(
  { ctx, solids, L, assemblyBase, lines }: PropLevel,
  s: Solid,
  cx: number,
  cz: number,
  pc: { px: number; py: number },
): void {
  const supports = solids
    .at(cx, cz, -Infinity, s.p.y + SUPPORT_SLACK, -0.01)
    .filter(
      (q) =>
        q !== s &&
        q.levelId === L.id &&
        (q.role === "floor" ||
          q.role === "fill" ||
          q.role === "ledge" ||
          q.role === "link" ||
          q.role === "feature") &&
        q.box.max.y <= s.p.y + SUPPORT_SLACK,
    );
  const support = supports.length ? maxOf(supports.map((q) => q.box.max.y)) : null;
  // a floor or fill piece crossing the thin slice just above the support slack, starting below the prop's base
  // (generator 5, `groundClusters`: an arranged piece sunk with its centre on the seam between two ground tiles is in
  // the ground: the tiles are met within SEAM_REACH of the centre)
  const seam = s.arranged && ctx.profile.groundClusters ? -SEAM_REACH : 0;
  const inside = solids
    .at(cx, cz, s.p.y + SUPPORT_SLACK, s.p.y + 0.07, seam)
    .filter((q) => q.levelId === L.id && (q.role === "floor" || q.role === "fill") && q.box.min.y < s.p.y);
  const cell: [number, number] = [Math.floor(pc.px), Math.floor(pc.py)];
  // an arrangement's piece sunk into the floor on purpose (arrange/ `sink`) stands in what it is sunk into
  if (inside.length && s.arranged) return;
  if (inside.length) {
    ctx.report.add({
      severity: "warning",
      code: "verify_prop_sunk",
      levelId: L.id,
      ...elementRef(s.p.source.elementId),
      assets: [s.name],
      message: `${solidLabel(s)} is sunk into the floor (${inside[0]?.name ?? "floor"}) at ${fmt(cell)}.`,
      hint: `Move feature ${s.p.source.elementId ?? ""} fully onto one floor height, or give it a lift equal to the higher floor.`,
    });
    return;
  }
  if (support === null) {
    ctx.report.add({
      severity: "warning",
      code: "verify_prop_no_floor",
      levelId: L.id,
      ...elementRef(s.p.source.elementId),
      assets: [s.name],
      message: `${solidLabel(s)} has nothing under it at ${fmt(cell)}.`,
      hint: `Move feature ${s.p.source.elementId ?? ""} onto a cell with floor.`,
    });
    return;
  }
  const type = ctx.featureOf(L.id, s.p.source.elementId)?.type;
  if (
    s.p.y - support > FLOAT_TOLERANCE &&
    // an upper piece of an assembly (palette parts: trunk on stump, capital on shaft) stands on its lower piece
    !(s.p.y > (assemblyBase.get(`${L.id}|${s.p.source.elementId ?? ""}`) ?? Infinity) + 0.01) &&
    // a piece hung from the ceiling is raised on purpose
    !(type !== undefined && featureInfo(type).ceilingMounted === true) &&
    !(type === "overhead" && lines.held(L, s.p.source.elementId, s.p.y))
  )
    ctx.report.add({
      severity: "warning",
      code: "verify_prop_floating",
      levelId: L.id,
      ...elementRef(s.p.source.elementId),
      assets: [s.name],
      message: `${solidLabel(s)} floats ${round2(s.p.y - support)} tiles above what is under it.`,
      hint: `Reduce the lift of feature ${s.p.source.elementId ?? ""}, or place it on a supporting feature (e.g. a table).`,
    });
}

/** A feature's footprint in world x and z. */
function footprintWorld(
  solids: SolidIndex,
  f: ResolvedFeature,
): { x0: number; x1: number; z0: number; z1: number } {
  const a = solids.toWorld(f.at[0], f.at[1]);
  const b = solids.toWorld(f.at[0] + f.size[0], f.at[1] + f.size[1]);
  return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), z0: Math.min(a.z, b.z), z1: Math.max(a.z, b.z) };
}

/** Distance across the floor from world point (x, z) to a piece's box. */
function boxDist(s: Solid, x: number, z: number): number {
  const dx = Math.max(s.box.min.x - x, 0, x - s.box.max.x);
  const dz = Math.max(s.box.min.z - z, 0, z - s.box.max.z);
  return Math.hypot(dx, dz);
}
