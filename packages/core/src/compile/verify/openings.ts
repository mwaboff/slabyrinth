/**
 * Doors and openings: each opening has its piece, in its wall's half cell and not walled up, and a passage leads from
 * floor to floor with room to stand in front of it on both sides.
 *
 * Emits, per opening in level order: `verify_door_missing` (error, unless realize reported the role missing), then per
 * door piece `verify_door_misplaced` and `verify_door_buried` (errors); for passages, `verify_door_no_floor` (error, per
 * side cell), `verify_door_leads_nowhere` (warning) and `verify_door_blocked` (error). Returns the blocked openings
 * (`BlockedOpenings`), which reachability reads.
 */
import type { CompileDiagnosticCode } from "../../contracts/compiler";
import type { LevelId, Side } from "../../contracts/plan";
import type { ResolvedLevel } from "../../contracts/resolved";
import { CELL_FLAG } from "../../contracts/resolved";
import { OPPOSITE, SIDE_STEP } from "../../gen/gridGeometry";
import { isGap, isPassage } from "../../gen/openingKinds";
import type { LevelGrid } from "../../resolve/levelGrid";
import type { VerifyCtx } from "./context";
import { overlap1, type Solid, type SolidIndex } from "./grid";
import {
  DOOR_MIN_OVERLAP,
  DOOR_SUGGEST_REACH,
  DOOR_ZONE_MARGIN,
  HEAD,
  STEP,
  WIDE_DOOR_SLACK,
} from "./limits";
import { fmt, planElements, solidLabel, uniq } from "./words";

/** The codes this file emits (VERIFY_CODES is the union of every check's list). */
export const OPENING_CODES = [
  "verify_door_missing",
  "verify_door_misplaced",
  "verify_door_buried",
  "verify_door_no_floor",
  "verify_door_leads_nowhere",
  "verify_door_blocked",
] as const satisfies readonly CompileDiagnosticCode[];

type Opening = ResolvedLevel["openings"][number];

/** One edge of an opening: cell `a` (north or west of it) and cell `b`, on whose `sideOfB` side the edge lies. */
export interface OpeningEdge {
  a: [number, number];
  b: [number, number];
  sideOfB: Side;
}

/** The edges an opening spans, from its start along the wall. */
export function openingEdges(op: Opening): OpeningEdge[] {
  const edges: OpeningEdge[] = [];
  for (let k = 0; k < op.width; k++) {
    if (op.orientation === "h") {
      const x = op.start[0] + k;
      const y = op.start[1];
      edges.push({ a: [x, y - 1], b: [x, y], sideOfB: "N" });
    } else {
      const x = op.start[0];
      const y = op.start[1] + k;
      edges.push({ a: [x - 1, y], b: [x, y], sideOfB: "W" });
    }
  }
  return edges;
}

/** A passage something stands in front of, on one side or both. */
export interface BlockedOpening {
  readonly levelId: LevelId;
  readonly openingId: string;
  /** Where the opening starts (the cell reachability names). */
  readonly start: [number, number];
  readonly solids: Solid[];
  /** The blocked sides: 0 = the north or west cell, 1 = the other. */
  readonly sides: Set<0 | 1>;
}

/** The blocked passages, in the order found. */
export class BlockedOpenings {
  private readonly byId = new Map<string, BlockedOpening>();

  /** The record of the opening, made on first use. */
  open(levelId: LevelId, op: Opening): BlockedOpening {
    const k = `${levelId}|${op.id}`;
    let b = this.byId.get(k);
    if (!b) {
      b = { levelId, openingId: op.id, start: [op.start[0], op.start[1]], solids: [], sides: new Set() };
      this.byId.set(k, b);
    }
    return b;
  }

  at(levelId: LevelId, openingId: string): BlockedOpening | undefined {
    return this.byId.get(`${levelId}|${openingId}`);
  }

  list(): Iterable<BlockedOpening> {
    return this.byId.values();
  }
}

export function checkOpenings(ctx: VerifyCtx, solids: SolidIndex): BlockedOpenings {
  const blocked = new BlockedOpenings();
  for (const L of ctx.levels) {
    const g = ctx.grids.get(L.id);
    if (!g) continue;
    for (const op of L.openings) {
      const pieces = solids.all.filter(
        (s) =>
          s.levelId === L.id && s.p.source.elementId === op.id && (s.role === "opening" || s.role === "wall"),
      );
      const edges = openingEdges(op);
      checkDoorPieces(ctx, solids, L, g, op, edges, pieces);
      if (isPassage(op.kind)) checkPassage(ctx, solids, L, g, op, edges, blocked);
    }
  }
  return blocked;
}

/** `verify_door_missing`, then per door piece `verify_door_misplaced` and `verify_door_buried`. */
function checkDoorPieces(
  ctx: VerifyCtx,
  solids: SolidIndex,
  L: ResolvedLevel,
  g: LevelGrid,
  op: Opening,
  edges: readonly OpeningEdge[],
  pieces: readonly Solid[],
): void {
  if (!isGap(op.kind) && pieces.length === 0) {
    const known = [...ctx.reportedMissing].some((k) => k.startsWith(`${L.id}|${op.id}|`));
    if (!known)
      ctx.report.add({
        severity: "error",
        code: "verify_door_missing",
        levelId: L.id,
        elementId: op.id,
        cell: edges[0]?.b ?? [op.start[0], op.start[1]],
        side: edges[0]?.sideOfB ?? "N",
        message: `Opening ${op.id} (${op.kind}) has no door or arch piece in the build.`,
        hint: `Change opening ${op.id} to a kind the theme has assets for (door, double_door, archway width 2) or to "open".`,
      });
  }
  // pieces in the host half-cell, and not buried by wall pieces
  for (const s of pieces.filter((q) => q.role === "opening")) {
    if (!edges.some((e) => inHostHalfCell(solids, g, op, e, s)))
      ctx.report.add({
        severity: "error",
        code: "verify_door_misplaced",
        levelId: L.id,
        elementId: op.id,
        cell: edges[0]?.b ?? [0, 0],
        side: edges[0]?.sideOfB ?? "N",
        assets: [s.name],
        message: `The ${s.name} for opening ${op.id} is not inside its wall's half-cell.`,
        hint: "Check the palette geometry (size, originAt, lengthAxis) of this door asset.",
      });
    const pc = solids.toPlan((s.box.min.x + s.box.max.x) / 2, (s.box.min.z + s.box.max.z) / 2);
    const buried = solids
      .near(pc.px, pc.py)
      .filter((q) => q !== s && q.levelId === L.id && q.role === "wall" && q.p.source.elementId !== op.id)
      .filter(
        (q) =>
          overlap1(q.box.min.x, q.box.max.x, s.box.min.x, s.box.max.x) > 0.1 &&
          overlap1(q.box.min.z, q.box.max.z, s.box.min.z, s.box.max.z) > 0.1 &&
          overlap1(q.box.min.y, q.box.max.y, s.box.min.y, s.box.max.y) > 0.2,
      );
    if (buried.length)
      ctx.report.add({
        severity: "error",
        code: "verify_door_buried",
        levelId: L.id,
        elementId: op.id,
        assets: [s.name, ...uniq(buried.map((b) => b.name))],
        message: `Opening ${op.id}: its ${s.name} overlaps ${buried[0]?.name ?? "a wall piece"}, so the doorway is walled up.`,
        hint: `Remove the wall run crossing opening ${op.id} or move the opening; if neither applies, check the palette geometry of ${s.name}.`,
      });
  }
}

/** Does door piece `s` stand in the half cell of edge `e` its wall is hosted in (a wide opening's piece may run along)? */
function inHostHalfCell(solids: SolidIndex, g: LevelGrid, op: Opening, e: OpeningEdge, s: Solid): boolean {
  const host = g.hostedOn(e.b[0], e.b[1], e.sideOfB) ? e.b : e.a;
  const sideInHost: Side = host === e.b ? e.sideOfB : OPPOSITE[e.sideOfB];
  const r = halfCellRect(host, sideInHost);
  const p0 = solids.toWorld(r.x0, r.y1);
  const p1 = solids.toWorld(r.x1, r.y0);
  const zx0 = Math.min(p0.x, p1.x) - DOOR_ZONE_MARGIN,
    zx1 = Math.max(p0.x, p1.x) + DOOR_ZONE_MARGIN;
  const zz0 = Math.min(p0.z, p1.z) - DOOR_ZONE_MARGIN,
    zz1 = Math.max(p0.z, p1.z) + DOOR_ZONE_MARGIN;
  const slack = op.width > 1 ? WIDE_DOOR_SLACK : 0;
  const inX = overlap1(s.box.min.x, s.box.max.x, zx0, zx1) > DOOR_MIN_OVERLAP;
  const inZ = s.box.min.z >= zz0 - slack && s.box.max.z <= zz1 + slack;
  const inX2 = s.box.min.x >= zx0 - slack && s.box.max.x <= zx1 + slack;
  return inX && inZ && inX2;
}

/**
 * A passage: both side cells open with floor (`verify_door_no_floor` per floorless cell, `verify_door_leads_nowhere`
 * when one is closed), and nothing blocking where one stands in front of it (`verify_door_blocked`, recorded in
 * `blocked`).
 */
function checkPassage(
  ctx: VerifyCtx,
  solids: SolidIndex,
  L: ResolvedLevel,
  g: LevelGrid,
  op: Opening,
  edges: readonly OpeningEdge[],
  blocked: BlockedOpenings,
): void {
  let nowhere = false;
  const blockers: Solid[] = [];
  let blockedCell: [number, number] | null = null;
  for (const e of edges) {
    for (const [cell, sideTowardEdge] of [
      [e.a, OPPOSITE[e.sideOfB]],
      [e.b, e.sideOfB],
    ] as Array<[[number, number], Side]>) {
      const c = g.cell(cell[0], cell[1]);
      if (!c.open) {
        nowhere = true;
        continue;
      }
      if (!c.floor) {
        ctx.report.add({
          severity: "error",
          code: "verify_door_no_floor",
          levelId: L.id,
          elementId: op.id,
          cell,
          message: `Opening ${op.id} opens onto ${fmt(cell)}, which has no floor (hole or stairwell).`,
          hint: `Move opening ${op.id} so both sides have floor, or give ${fmt(cell)} a floor.`,
        });
        continue;
      }
      // where one stands in front of the door: the middle of the cell's half beside the edge, past the door's strip
      const d = g.hostedOn(cell[0], cell[1], sideTowardEdge) ? 0.75 : 0.25;
      const mx =
        sideTowardEdge === "W" ? cell[0] + d : sideTowardEdge === "E" ? cell[0] + 1 - d : cell[0] + 0.5;
      const my =
        sideTowardEdge === "N" ? cell[1] + d : sideTowardEdge === "S" ? cell[1] + 1 - d : cell[1] + 0.5;
      const pt = solids.toWorld(mx, my);
      const top = g.top(cell[0], cell[1]);
      const hits = solids
        .at(pt.x, pt.z, top + STEP, top + HEAD)
        .filter((s) => s.levelId === L.id && s.p.source.elementId !== op.id && s.blocking);
      if (hits.length) {
        blockers.push(...hits);
        blockedCell ??= cell;
        blocked.open(L.id, op).sides.add(cell === e.a ? 0 : 1);
      }
    }
  }
  if (nowhere)
    ctx.report.add({
      severity: "warning",
      code: "verify_door_leads_nowhere",
      levelId: L.id,
      elementId: op.id,
      cell: edges[0]?.b ?? [0, 0],
      side: edges[0]?.sideOfB ?? "N",
      message: `Opening ${op.id} leads into solid rock or empty space on one side, so nobody can come through it.`,
      hint: `Connect opening ${op.id} to an area on both sides (e.g. add a corridor behind it), use between: [area, "@outside"] only where the outside is open ground, or remove it.`,
    });
  if (!blockers.length || !blockedCell) return;
  blocked.open(L.id, op).solids.push(...blockers);
  const b = blockers[0] as Solid;
  const alt = suggestDoorCell(L, g, op, solids);
  ctx.report.add({
    severity: "error",
    code: "verify_door_blocked",
    levelId: L.id,
    elementId: op.id,
    elementIds: uniq([op.id, ...planElements(blockers.map((q) => q.p.source.elementId))]),
    cell: blockedCell,
    assets: uniq(blockers.map((q) => q.name)),
    message: `Opening ${op.id} cannot be used: ${solidLabel(b)} fills the space in front of it at ${fmt(blockedCell)} on level ${L.id}.`,
    hint: alt
      ? `Move opening ${op.id} to ${alt} (clear on both sides), or move ${b.p.source.elementId ?? b.name} so ${fmt(blockedCell)} stays free.`
      : `Move opening ${op.id} along the wall away from ${b.p.source.elementId ?? b.name}, or move that element so ${fmt(blockedCell)} stays free.`,
  });
}

/** Hint: a clear edge along the same wall for a blocked opening, as the plan's `at` of an opening. */
function suggestDoorCell(L: ResolvedLevel, g: LevelGrid, op: Opening, solids: SolidIndex): string | null {
  for (let d = 1; d <= DOOR_SUGGEST_REACH; d++) {
    for (const s of [d, -d]) {
      const x = op.orientation === "h" ? op.start[0] + s : op.start[0];
      const y = op.orientation === "h" ? op.start[1] : op.start[1] + s;
      const side: Side = op.orientation === "h" ? "N" : "W";
      if (!g.wallOn(x, y, side)) continue;
      const [dx, dy] = SIDE_STEP[side];
      const cells: Array<[number, number]> = [
        [x, y],
        [x + dx, y + dy],
      ];
      const ok = cells.every(([cx, cy]) => {
        const c = g.cell(cx, cy);
        if (!c.open) return true;
        if (!c.floor || (c.flags & (CELL_FLAG.FEATURE | CELL_FLAG.LINK)) !== 0) return false;
        const pc = solids.toWorld(cx + 0.5, cy + 0.5);
        const top = g.top(cx, cy);
        return (
          solids
            .at(pc.x, pc.z, top + STEP, top + HEAD)
            .filter((q) => q.levelId === L.id && q.blocking && q.role !== "wall" && q.role !== "wall_post")
            .length === 0
        );
      });
      if (ok) {
        const cellA: [number, number] = g.cell(x, y).open ? [x, y] : [x + dx, y + dy];
        const sideA: Side = g.cell(x, y).open ? side : OPPOSITE[side];
        return `at: {x: ${cellA[0]}, y: ${cellA[1]}, side: "${sideA}"}`;
      }
    }
  }
  return null;
}

/** The half of a cell on one side, in plan coordinates. */
function halfCellRect(
  cell: readonly [number, number],
  side: Side,
): { x0: number; x1: number; y0: number; y1: number } {
  const [x, y] = cell;
  switch (side) {
    case "N":
      return { x0: x, x1: x + 1, y0: y, y1: y + 0.5 };
    case "S":
      return { x0: x, x1: x + 1, y0: y + 0.5, y1: y + 1 };
    case "W":
      return { x0: x, x1: x + 0.5, y0: y, y1: y + 1 };
    default:
      return { x0: x + 0.5, x1: x + 1, y0: y, y1: y + 1 };
  }
}
