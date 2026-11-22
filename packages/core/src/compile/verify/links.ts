/**
 * Stairs and links: each link's pieces join its two levels where a player can use them.
 *
 * Per link, in plan order: a stair or ramp run arrives at the floor it climbs to (`verify_stairs_no_arrival`) on a cell
 * one can stand on (`verify_stairs_arrival_blocked`), every step climbs from the one behind it (generator 4, switch
 * `everyStepVerified`; `verify_stairs_no_arrival`) and its foot can be stepped onto (`verify_stairs_approach_blocked`);
 * a ladder or spiral stair reaches the upper floor (`verify_link_short`); a trapdoor has its hatch on the upper floor
 * (`verify_link_short`), every other link an open shaft through it (`verify_stairwell_closed`). All errors.
 *
 * Returns which links do not work and why (`LinkVerdicts`), which reachability reads.
 */
import type { CompileDiagnosticCode } from "../../contracts/compiler";
import type { ResolvedLevel, ResolvedPlan } from "../../contracts/resolved";
import { CELL_FLAG } from "../../contracts/resolved";
import { OPPOSITE, SIDE_STEP } from "../../gen/gridGeometry";
import { linkKindInfo } from "../../plan/links";
import type { LevelGrid } from "../../resolve/levelGrid";
import type { VerifyCtx } from "./context";
import type { Solid, SolidIndex } from "./grid";
import {
  HATCH_TOLERANCE,
  LADDER_REACH_TOLERANCE,
  SHAFT_FLOOR_PROBE,
  STAIR_ARRIVAL_TOLERANCE,
  STAIR_STEP_MAX,
  STAIR_STEP_MIN,
  STEP,
} from "./limits";
import type { ObstructedCells } from "./openFloor";
import { isRun, type StairRuns } from "./runs";
import { fmt, round2, uniq } from "./words";
import { maxOf, minOf } from "../../util/lists";

/** The codes this file emits (VERIFY_CODES is the union of every check's list). */
export const LINK_CODES = [
  "verify_stairs_no_arrival",
  "verify_stairs_arrival_blocked",
  "verify_stairs_approach_blocked",
  "verify_link_short",
  "verify_stairwell_closed",
] as const satisfies readonly CompileDiagnosticCode[];

type Link = ResolvedPlan["links"][number];

/** The links that do not work, with the first reason found (named by "area cannot be reached" with its fix). */
export class LinkVerdicts {
  private readonly brokenIds = new Set<string>();
  private readonly reasons = new Map<string, { why: string; fix: string }>();

  /** Marks the link broken; the first reason given is the one kept. */
  fail(id: string, why?: string, fix?: string): void {
    this.brokenIds.add(id);
    if (why !== undefined && fix !== undefined && !this.reasons.has(id)) this.reasons.set(id, { why, fix });
  }

  broken(id: string): boolean {
    return this.brokenIds.has(id);
  }

  reason(id: string): { why: string; fix: string } | undefined {
    return this.reasons.get(id);
  }
}

/** One link between its two levels, with what every check of it reads. */
interface LinkCase {
  readonly lk: Link;
  readonly lower: ResolvedLevel;
  readonly upper: ResolvedLevel;
  readonly gl: LevelGrid;
  readonly gu: LevelGrid;
}

export function checkLinks(
  ctx: VerifyCtx,
  solids: SolidIndex,
  runs: StairRuns,
  obstructed: ObstructedCells,
): LinkVerdicts {
  const verdicts = new LinkVerdicts();
  for (const lk of ctx.resolved.links) {
    const lower = ctx.levelOf.get(lk.fromLevel);
    const upper = ctx.levelOf.get(lk.toLevel);
    const gl = ctx.grids.get(lk.fromLevel);
    const gu = ctx.grids.get(lk.toLevel);
    if (!lower || !upper || !gl || !gu) continue;
    const c: LinkCase = { lk, lower, upper, gl, gu };
    if (isRun(lk)) {
      const parts = piecesOf(solids, lower.id, lk.id);
      checkStairArrival(ctx, solids, runs, obstructed, verdicts, c, parts);
      checkEveryStep(ctx, solids, runs, verdicts, c, parts);
      checkStairApproach(ctx, runs, obstructed, verdicts, c);
    }
    // a climb up through a stairwell onto an open cell (a ladder, a spiral stair) is a stack of pieces
    const info = linkKindInfo(lk.kind);
    if (info.arrival === "open") checkVerticalStack(ctx, solids, verdicts, c);
    if (info.hatch) checkTrapdoorHatch(ctx, solids, verdicts, c);
    else checkShaftOpen(ctx, solids, verdicts, c);
  }
  return verdicts;
}

/** The pieces placed for a link on a level. */
function piecesOf(solids: SolidIndex, levelId: string, linkId: string): Solid[] {
  return solids.all.filter((s) => s.levelId === levelId && s.p.source.elementId === linkId);
}

/** The top of the highest piece over the centre of cell c (-Infinity when none stands there). */
function topOfPieces(solids: SolidIndex, parts: readonly Solid[], c: readonly [number, number]): number {
  const pc = solids.toWorld(c[0] + 0.5, c[1] + 0.5);
  return Math.max(
    -Infinity,
    maxOf(
      parts
        .filter((s) => s.box.min.x < pc.x && s.box.max.x > pc.x && s.box.min.z < pc.z && s.box.max.z > pc.z)
        .map((s) => s.box.max.y),
    ),
  );
}

/** Each top step meets the upper floor's height, and the cell it arrives at is open floor one can step onto. */
function checkStairArrival(
  ctx: VerifyCtx,
  solids: SolidIndex,
  runs: StairRuns,
  obstructed: ObstructedCells,
  verdicts: LinkVerdicts,
  { lk, lower, upper, gu }: LinkCase,
  parts: readonly Solid[],
): void {
  for (const { top: c, arrival: arr } of runs.arrivals(lk)) {
    const upTop = gu.top(arr[0], arr[1]);
    const runTop = topOfPieces(solids, parts, c);
    if (!Number.isFinite(runTop) || Math.abs(runTop - upTop) > STAIR_ARRIVAL_TOLERANCE) {
      verdicts.fail(
        lk.id,
        Number.isFinite(runTop)
          ? `its top step is at height ${round2(runTop)} but the floor it should meet on ${upper.id} is at ${round2(upTop)}`
          : `it has no step or landing at ${fmt(c)}`,
        `check the elevations of ${lower.id} and ${upper.id} (one storey = 2.5) and that the theme has a stairs asset`,
      );
      ctx.report.add({
        severity: "error",
        code: "verify_stairs_no_arrival",
        levelId: lower.id,
        elementId: lk.id,
        cell: c,
        message: Number.isFinite(runTop)
          ? `Stairs ${lk.id} end at height ${round2(runTop)} but the floor they lead to on level ${upper.id} is at ${round2(upTop)}.`
          : `Stairs ${lk.id} have no step or landing at ${fmt(c)}.`,
        hint: `Check the elevations of ${lower.id} and ${upper.id} (one storey = 2.5) and that link ${lk.id} has a stairs asset in its theme.`,
      });
    }
    const ac = gu.cell(arr[0], arr[1]);
    const wallBetween = gu.wallOn(c[0], c[1], lk.dir);
    const arrHits = ac.floor ? obstructed.at(upper.id, arr[0], arr[1]) : undefined;
    if (ac.open && ac.floor && !wallBetween && !arrHits) continue;
    verdicts.fail(
      lk.id,
      `it lands at ${fmt(arr)} on ${upper.id}, which ${!ac.open ? "is solid rock or void" : !ac.floor ? "has no floor (a hole or the stair well itself)" : wallBetween ? "is behind a wall" : `is filled by ${arrHits?.[0]?.name ?? "a solid"}`}`,
      `make ${fmt(arr)} open floor of an area on ${upper.id} (the run climbs from ${fmt(lk.lowerCells[0] ?? c)} in direction ${lk.dir} and lands one cell past its last step), or change from.at or dir`,
    );
    ctx.report.add({
      severity: "error",
      code: "verify_stairs_arrival_blocked",
      levelId: upper.id,
      elementId: lk.id,
      cell: arr,
      ...(arrHits ? { assets: uniq(arrHits.map((s) => s.name)) } : {}),
      message: `Stairs ${lk.id} arrive at ${fmt(arr)} on level ${upper.id}, which ${!ac.open || !ac.floor ? "has no floor" : wallBetween ? "is behind a wall" : `is filled by ${arrHits?.[0]?.name ?? "a solid"}`}.`,
      hint: `Make ${fmt(arr)} open floor of an area on ${upper.id} with no wall toward the stairs, or turn link ${lk.id}.`,
    });
  }
}

/**
 * Generator 4 (switch `everyStepVerified`): every step of the run, not only the last: each cell's top stands above the
 * one behind it by no more than a step (1 tile), so no gap or drop breaks the climb (a missing piece, a step of another
 * height). One diagnostic for the first broken step.
 */
function checkEveryStep(
  ctx: VerifyCtx,
  solids: SolidIndex,
  runs: StairRuns,
  verdicts: LinkVerdicts,
  { lk, lower, gl }: LinkCase,
  parts: readonly Solid[],
): void {
  if (!ctx.profile.everyStepVerified) return;
  const [dx, dy] = SIDE_STEP[lk.dir];
  let bad: { c: readonly [number, number]; text: string } | undefined;
  for (const c of lk.lowerCells) {
    const run = runs.at(lower.id, c[0], c[1]);
    if (!run) continue;
    const top = topOfPieces(solids, parts, c);
    const behindCell: [number, number] = [c[0] - dx, c[1] - dy];
    const behindRun = runs.at(lower.id, behindCell[0], behindCell[1]);
    const behind =
      behindRun?.linkId === lk.id
        ? topOfPieces(solids, parts, behindCell)
        : run.k === 0
          ? gl.top(behindCell[0], behindCell[1])
          : -Infinity;
    if (!Number.isFinite(top)) {
      bad = {
        c,
        text: `step ${run.k + 1} of ${lk.lowerCells.length} at ${fmt(c)} has no piece, so the climb has a gap`,
      };
      break;
    }
    if (Number.isFinite(behind) && (top - behind > STAIR_STEP_MAX || top - behind < STAIR_STEP_MIN)) {
      bad = {
        c,
        text: `step ${run.k + 1} of ${lk.lowerCells.length} at ${fmt(c)} stands at height ${round2(top)}, ${round2(top - behind)} from the one behind it (${round2(behind)})`,
      };
      break;
    }
  }
  if (!bad) return;
  verdicts.fail(
    lk.id,
    `its climb is broken: ${bad.text}`,
    `check that link ${lk.id} has a stairs asset in its theme and that the run of ${lk.lowerCells.length} cells fits the rise of ${lk.rise}`,
  );
  ctx.report.add({
    severity: "error",
    code: "verify_stairs_no_arrival",
    levelId: lower.id,
    elementId: lk.id,
    cell: [bad.c[0], bad.c[1]],
    message: `Stairs ${lk.id} do not climb all the way: ${bad.text}.`,
    hint: `Check that link ${lk.id} has a stairs asset in its theme and that the run of ${lk.lowerCells.length} cells fits the rise of ${lk.rise}.`,
  });
}

/** The cell before each bottom step is open floor of the same height, with no wall, feature or solid in the way. */
function checkStairApproach(
  ctx: VerifyCtx,
  runs: StairRuns,
  obstructed: ObstructedCells,
  verdicts: LinkVerdicts,
  { lk, lower, gl }: LinkCase,
): void {
  const [dx, dy] = SIDE_STEP[lk.dir];
  for (const c of lk.lowerCells.filter((q) => runs.at(lower.id, q[0], q[1])?.k === 0)) {
    const ap: [number, number] = [c[0] - dx, c[1] - dy];
    const a = gl.cell(ap[0], ap[1]);
    const wall = gl.wallOn(c[0], c[1], OPPOSITE[lk.dir]);
    const hits = obstructed.at(lower.id, ap[0], ap[1]);
    const featureThere = (a.flags & CELL_FLAG.FEATURE) !== 0;
    if (
      a.open &&
      a.floor &&
      !wall &&
      !hits &&
      !featureThere &&
      !(Math.abs(gl.top(ap[0], ap[1]) - gl.top(c[0], c[1])) > STEP)
    )
      continue;
    verdicts.fail(
      lk.id,
      `nobody can step onto its first step at ${fmt(c)} on ${lower.id}: the cell before it, ${fmt(ap)}, ${!a.open ? "is solid rock or void" : !a.floor ? "has no floor" : wall ? "is behind a wall" : featureThere ? "holds a feature" : hits ? `is filled by ${hits[0]?.name ?? "a solid"}` : "is at a different height"}`,
      `the run starts at from.at ${fmt(lk.lowerCells[0] ?? c)} and climbs in direction ${lk.dir}, so the walkway must reach the foot from the opposite side (${fmt(ap)}); move from.at to the other end of the corridor and flip dir, or lengthen the area behind the foot`,
    );
    ctx.report.add({
      severity: "error",
      code: "verify_stairs_approach_blocked",
      levelId: lower.id,
      elementId: lk.id,
      cell: ap,
      ...(hits ? { assets: uniq(hits.map((s) => s.name)) } : {}),
      message: `Nobody can step onto the bottom of stairs ${lk.id}: the cell before it, ${fmt(ap)}, ${!a.open || !a.floor ? "has no floor" : wall ? "is behind a wall" : featureThere ? "holds a feature" : hits ? `is filled by ${hits[0]?.name ?? "a solid"}` : "is at a different height"}.`,
      hint: `Move link ${lk.id} so the cell before its first step (opposite its dir ${lk.dir}) is open floor in the same area.`,
    });
  }
}

/** A ladder's or spiral stair's stack (or its fallback) reaches the upper floor top. */
function checkVerticalStack(
  ctx: VerifyCtx,
  solids: SolidIndex,
  verdicts: LinkVerdicts,
  { lk, lower, upper, gu }: LinkCase,
): void {
  const parts = piecesOf(solids, lower.id, lk.id);
  if (parts.length === 0) {
    verdicts.fail(lk.id);
    const known = [...ctx.reportedMissing].some(
      (k) => k.startsWith(`${lower.id}|`) && k.endsWith(`|link.${lk.kind}`),
    );
    if (!known)
      ctx.report.add({
        severity: "error",
        code: "verify_link_short",
        levelId: lower.id,
        elementId: lk.id,
        cell: lk.lowerCells[0] ?? lk.arrival,
        message: `Link ${lk.id} (${lk.kind}) has no pieces in the build, so nothing connects ${lower.id} to ${upper.id}.`,
        hint: `Use kind "stairs" or "ladder" for link ${lk.id}; this theme has no asset for ${lk.kind}.`,
      });
    return;
  }
  const top = maxOf(parts.map((s) => s.box.max.y));
  const cell = parts[0]?.p.source.cell ?? lk.lowerCells[0] ?? lk.arrival;
  const upTop = gu.top(cell[0], cell[1]);
  if (!(top < upTop - LADDER_REACH_TOLERANCE)) return;
  verdicts.fail(
    lk.id,
    `its ${lk.kind} reaches height ${round2(top)}, short of the floor of ${upper.id} at ${round2(upTop)}`,
    `check the level elevations (a ladder spans one storey, 2.5) or use stairs`,
  );
  ctx.report.add({
    severity: "error",
    code: "verify_link_short",
    levelId: lower.id,
    elementId: lk.id,
    cell,
    assets: uniq(parts.map((s) => s.name)),
    message: `${parts[0]?.name ?? "The link"} for ${lk.id} reaches height ${round2(top)}, short of the floor of ${upper.id} at ${round2(upTop)}.`,
    hint: `Check the elevations of ${lower.id} and ${upper.id} and the height of the ${lk.kind} asset in the palette.`,
  });
}

/** A trapdoor's hatch lies on the upper floor. */
function checkTrapdoorHatch(
  ctx: VerifyCtx,
  solids: SolidIndex,
  verdicts: LinkVerdicts,
  { lk, upper, gu }: LinkCase,
): void {
  const hatch = piecesOf(solids, upper.id, lk.id);
  const cell = lk.upperCells[0] ?? lk.arrival;
  const upTop = gu.top(cell[0], cell[1]);
  if (hatch.length && !(Math.abs(minOf(hatch.map((s) => s.box.min.y)) - upTop) > HATCH_TOLERANCE)) return;
  verdicts.fail(lk.id);
  ctx.report.add({
    severity: "error",
    code: "verify_link_short",
    levelId: upper.id,
    elementId: lk.id,
    cell,
    message: hatch.length
      ? `The hatch of trapdoor ${lk.id} is not on the floor of ${upper.id} at ${fmt(cell)}.`
      : `Trapdoor ${lk.id} has no hatch piece in the build.`,
    hint: `Give trapdoor ${lk.id} a floored cell on ${upper.id}, or use a theme with a link.trapdoor asset.`,
  });
}

/** Every other link needs an open shaft on the upper level (stairwell, ladder hole, pit): one diagnostic, first cell. */
function checkShaftOpen(
  ctx: VerifyCtx,
  solids: SolidIndex,
  verdicts: LinkVerdicts,
  { lk, upper, gu }: LinkCase,
): void {
  for (const c of lk.upperCells) {
    const pc = solids.toWorld(c[0] + 0.5, c[1] + 0.5);
    const floorsAbove = solids
      .at(pc.x, pc.z, upper.elevation - 0.01, upper.elevation + SHAFT_FLOOR_PROBE)
      .filter((s) => s.levelId === upper.id && (s.role === "floor" || s.role === "fill"));
    if (!gu.cell(c[0], c[1]).floor && !floorsAbove.length) continue;
    verdicts.fail(
      lk.id,
      `the floor of ${upper.id} closes its opening at ${fmt(c)}`,
      `leave ${fmt(c)} without floor on ${upper.id}`,
    );
    ctx.report.add({
      severity: "error",
      code: "verify_stairwell_closed",
      levelId: upper.id,
      elementId: lk.id,
      cell: c,
      message: `The floor of level ${upper.id} closes the opening of ${lk.id} (${lk.kind}) at ${fmt(c)}: there is no way through.`,
      hint: `Leave ${fmt(c)} without floor on ${upper.id} (it should be cut automatically; check overlapping areas there).`,
    });
    return;
  }
}
