/**
 * The quality meter's hard rules (src/review/qualityMetrics.ts, `hard: true`) as test helpers. They are not enforced on
 * whole builds: a package that builds the technique behind a rule calls the helper on the pieces its recipe emitted
 * (picked out of a realized set by element id or role), so the rule holds where it is claimed. Each returns what broke
 * it, empty when it holds, so a test reads `expect(structureOnAxis(pieces)).toEqual([])`.
 *
 *   structureOnAxis   tiles at quarter turns only                         (structure_off_axis = 0)
 *   restContact       every prop rests on, or is bedded in, a piece        (prop_rest_contact ≥ 0.95 for recipe output)
 *   noCoplanarTops    no two flat tops within 0.02 over each other         (coplanar_share = 0, flicker)
 *   noStampedGroups   no 4+ identical dressing pieces at one heading       (stamped_groups = 0)
 *   noDuplicates      no two pieces of one asset at one place and yaw      (exact_duplicates = 0)
 *   laneClear         a room's lane share under blocking pieces ≤ 0.10    (lane_blocked)
 *   bandsCover        band coverage ≥ 0.80 on the buildings measured       (band_coverage)
 */
import type { PlacementSet } from "../../src/contracts/compiler";
import type { ResolvedPlan } from "../../src/contracts/resolved";
import { meterPieces, qualityMeter, slabMeter, type MeterPiece, type RoomQuality } from "../../src/review";

/** The pieces of a realized set whose element id passes `own` (a recipe's pieces), as the slab tier reads them. */
export function piecesOf(set: PlacementSet, own: (elementId: string) => boolean): MeterPiece[] {
  const keep = new Set(set.levels.flatMap((L) => L.placements.filter((p) => own(p.source.elementId ?? ""))));
  const all = set.levels.flatMap((L) => L.placements.filter((p) => p.role !== "marker"));
  const pieces = meterPieces(set);
  return pieces.filter((_, i) => keep.has(all[i] as (typeof all)[number]));
}

const turned = (rot: number): boolean => {
  const r = ((rot % 90) + 90) % 90;
  return Math.min(r, 90 - r) > 0.5;
};

/** Tiles that are not at a quarter turn. */
export function structureOnAxis(pieces: readonly MeterPiece[]): MeterPiece[] {
  return pieces.filter((p) => p.tile && turned(p.rot));
}

/**
 * Props of `subject` that rest on nothing: each is measured among `context` (the whole build, so a prop on the floor
 * counts as resting) and must rest on, or be bedded in, a piece under its centre. At most `allowed` share may fail
 * (0.05: the plan's ≥ 95 % for recipe output).
 */
export function restContact(
  subject: readonly MeterPiece[],
  context: readonly MeterPiece[],
  allowed = 0.05,
): MeterPiece[] {
  const props = subject.filter((p) => !p.tile);
  // the slab tier's rest test (review/qualitySlab.ts), asked of one prop among the context at a time
  const floating = props.filter((p) => {
    const others = context.filter((q) => q !== p).map((q) => ({ ...q, tile: true }));
    return slabMeter([{ ...p, tile: false }, ...others]).prop_rest_contact === 0;
  });
  return floating.length > allowed * props.length ? floating : [];
}

/** Coplanar flat tops among the pieces (their share; 0 holds). */
export function coplanarShare(pieces: readonly MeterPiece[]): number {
  return slabMeter(pieces).coplanar_share ?? 0;
}

/** Stamped groups among the pieces, treated as dressing (0 holds). */
export function stampedGroupCount(pieces: readonly MeterPiece[]): number {
  return slabMeter(pieces.map((p) => ({ ...p, tile: false, loose: true }))).stamped_groups;
}

/** Exact duplicates among the pieces (0 holds). */
export function duplicateCount(pieces: readonly MeterPiece[]): number {
  return slabMeter(pieces).exact_duplicates;
}

/** Rooms whose lane is more than `max` under blocking pieces. */
export function blockedLanes(resolved: ResolvedPlan, set: PlacementSet, max = 0.1): RoomQuality[] {
  return qualityMeter(resolved, set).rooms.filter((r) => r.laneBlocked !== null && r.laneBlocked > max);
}

/** Band course coverage of a build (null: no building of two storeys); the rule holds at 0.8 or more. */
export function bandCoverage(resolved: ResolvedPlan, set: PlacementSet): number | null {
  return qualityMeter(resolved, set).values.band_coverage;
}
