/**
 * Geometric validation (architecture §2.8) — the checks that need the resolver. WP1's `validatePlan` owns schema,
 * ids, refs and limits; callers pass `geometryChecks` to it as a check (resolve/rules.ts `planRules`) and it merges the
 * issues.
 *
 * Errors reported here: opening_no_boundary, opening_overlap, link_mismatch, link_blocked, feature_blocked,
 * area_empty, shape_invalid (wall runs), bounds_exceeded (openings out of bounds).
 * Warnings: area_disconnected, unreachable, bounds_exceeded (clipping), limit_exceeded (scatter cap),
 * opening_no_boundary (an `at` opening not on a wall), narrow corridors (code "shape_invalid", warning).
 */
import type { MapPlan, PlanIssue, PlanIssueCode, Vec2 } from "../contracts/plan";
import type { ResolvedLevel, ResolvedPlan } from "../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../contracts/resolved";
import { isPassage } from "../gen/openingKinds";
import type { ResolvePalettes } from "../palette/resolve";
import { entryLevelId, linkKindInfo } from "../plan/links";
import { edgeIndex, sideEdgeIndex } from "./levelGrid";
import { type PlayabilityOptions, checkPlayability } from "./playability";
import { resolvePlan } from "./resolvePlan";

/** Codes the resolver may emit that WP1's own (structural) checks already cover — dropped to avoid duplicates. */
const WP1_CODES = new Set<PlanIssueCode>(["ref_unknown", "link_mismatch"]);
/** Error-severity codes WP1 reports structurally (shape/wall-run axis checks, out-of-bounds elements). */
const WP1_ERROR_CODES = new Set<PlanIssueCode>(["bounds_exceeded"]);
const fromWp1 = (i: PlanIssue): boolean =>
  WP1_CODES.has(i.code) ||
  (i.severity === "error" && WP1_ERROR_CODES.has(i.code)) ||
  (i.code === "shape_invalid" && i.message.includes("not axis-aligned")) ||
  (i.code === "opening_no_boundary" && i.message.includes("needs two different sides"));

export interface GeometryCheckContext {
  /** Extra blocked cells / openings (e.g. from realized geometry) for the playability pass. */
  playability?: PlayabilityOptions;
  /** A resolved plan for this exact plan and palettes, when the caller already has one (avoids resolving twice). */
  resolved?: ResolvedPlan;
}

/**
 * The checks validatePlan runs when given `planRules(palettes)` (resolve/rules.ts), on the plan resolved against
 * `palettes`. Pure; never
 * throws for bad content.
 */
export function geometryChecks(
  plan: MapPlan,
  palettes: ResolvePalettes,
  ctx: GeometryCheckContext = {},
): PlanIssue[] {
  let resolved: ResolvedPlan;
  try {
    resolved = ctx.resolved ?? resolvePlan(plan, palettes);
  } catch (err) {
    return [
      {
        severity: "error",
        code: "schema",
        message: `the plan could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }
  const issues = resolved.issues.filter((i) => !fromWp1(i));
  for (const lvl of resolved.levels) {
    issues.push(...disconnectedAreas(plan, lvl));
    issues.push(...narrowCorridors(plan, lvl));
  }
  issues.push(...checkPlayability(plan, resolved, ctx.playability));
  return issues;
}

function levelPath(plan: MapPlan, levelId: string): number {
  return plan.levels.findIndex((l) => l.id === levelId);
}

function areaCells(lvl: ResolvedLevel, ai: number): number[] {
  const out: number[] = [];
  lvl.cells.area.forEach((a, i) => {
    if (a === ai + 1) out.push(i);
  });
  return out;
}

function disconnectedAreas(plan: MapPlan, lvl: ResolvedLevel): PlanIssue[] {
  const out: PlanIssue[] = [];
  const li = levelPath(plan, lvl.id);
  const w = lvl.bounds.w;
  lvl.areaIds.forEach((id, ai) => {
    const cells = areaCells(lvl, ai);
    if (cells.length <= 1) return;
    const set = new Set(cells);
    const seen = new Set<number>([cells[0] as number]);
    const stack = [cells[0] as number];
    while (stack.length > 0) {
      const c = stack.pop() as number;
      const x = c % w;
      for (const k of [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, c - w, c + w]) {
        if (k >= 0 && set.has(k) && !seen.has(k)) {
          seen.add(k);
          stack.push(k);
        }
      }
    }
    if (seen.size < set.size) {
      const stray = cells.find((c) => !seen.has(c)) as number;
      const cell: Vec2 = [lvl.bounds.x + (stray % w), lvl.bounds.y + Math.floor(stray / w)];
      const areaIndex = plan.levels[li]?.areas.findIndex((a) => a.id === id) ?? -1;
      out.push({
        severity: "warning",
        code: "area_disconnected",
        message: `area "${id}" is split into separate pieces (${set.size - seen.size} of ${set.size} cells cut off, e.g. ${cell[0]},${cell[1]})`,
        levelId: lvl.id,
        elementId: id,
        cell,
        path: `/levels/${li}/areas/${areaIndex}`,
        hint: "a later area or corridor cuts through it; reorder areas or adjust the shapes",
      });
    }
  });
  return out;
}

/** A corridor cell with walls hosted on BOTH opposite sides keeps no clear floor (§2.8 warning). */
function narrowCorridors(plan: MapPlan, lvl: ResolvedLevel): PlanIssue[] {
  const out: PlanIssue[] = [];
  const { w, h } = lvl.bounds;
  const li = levelPath(plan, lvl.id);
  const hostedIn = (orient: "h" | "v", lx: number, ly: number, which: 0 | 1): boolean => {
    const g = orient === "h" ? lvl.hEdges : lvl.vEdges;
    const i = edgeIndex(lvl.bounds, orient, lx, ly);
    const k = g.kind[i];
    return (k === EDGE.WALL || k === EDGE.OPENING) && g.host[i] === which;
  };
  lvl.areas.forEach((a, ai) => {
    if (a.kind !== "corridor") return;
    for (let ly = 0; ly < h; ly++) {
      for (let lx = 0; lx < w; lx++) {
        if (lvl.cells.area[ly * w + lx] !== ai + 1) continue;
        const ns = hostedIn("h", lx, ly, 1) && hostedIn("h", lx, ly + 1, 0);
        const ew = hostedIn("v", lx, ly, 1) && hostedIn("v", lx + 1, ly, 0);
        if (ns || ew) {
          const cell: Vec2 = [lvl.bounds.x + lx, lvl.bounds.y + ly];
          out.push({
            severity: "warning",
            code: "shape_invalid",
            message: `corridor "${a.id}" has no clear floor at ${cell[0]},${cell[1]}: walls stand on both sides inside it`,
            levelId: lvl.id,
            elementId: a.id,
            cell,
            path: `/levels/${li}`,
            hint: "widen the corridor to 2 or make the neighbouring areas larger",
          });
          return;
        }
      }
    }
  });
  return out;
}

function keyOrder(a: string, b: string): number {
  const na = /^\d+$/.test(a) ? Number(a) : NaN;
  const nb = /^\d+$/.test(b) ? Number(b) : NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  if (!Number.isNaN(na)) return -1;
  if (!Number.isNaN(nb)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Flood fill over walkable cells (OPEN with floor), crossing NONE, passable OPENING and LEDGE ≤ 0.5 edges,
 * plus level links; from the entry level's lowest-key area and any "@outside" opening.
 */
export function reachableCells(plan: MapPlan, resolved: ResolvedPlan): Map<string, Uint8Array> {
  const levels = new Map(resolved.levels.map((l) => [l.id, l]));
  const reached = new Map<string, Uint8Array>();
  for (const l of resolved.levels) reached.set(l.id, new Uint8Array(l.bounds.w * l.bounds.h));
  const walk = (l: ResolvedLevel, i: number): boolean =>
    l.cells.state[i] === CELL.OPEN && ((l.cells.flags[i] as number) & CELL_FLAG.NO_FLOOR) === 0;
  const queue: Array<[string, number]> = [];
  const seed = (lid: string, i: number): void => {
    const l = levels.get(lid);
    const r = reached.get(lid);
    if (!l || !r || i < 0 || r[i] === 1 || !walk(l, i)) return;
    r[i] = 1;
    queue.push([lid, i]);
  };

  const entry = entryLevelId(plan);
  const el = entry ? levels.get(entry) : undefined;
  if (el) {
    const keyed = el.areas
      .map((a, ai) => ({ a, ai }))
      .filter((x) => x.a.key !== undefined && x.a.cellCount > 0)
      .sort((p, q) => keyOrder(p.a.key as string, q.a.key as string));
    const first = keyed[0];
    if (first) for (const i of areaCells(el, first.ai)) seed(el.id, i);
    else {
      // no keyed area: start from un-owned ground, else every open cell
      const found = { any: false };
      el.cells.area.forEach((a, i) => {
        if (a === 0 && walk(el, i)) {
          seed(el.id, i);
          found.any = true;
        }
      });
      if (!found.any) for (let i = 0; i < el.cells.state.length; i++) seed(el.id, i);
    }
  }
  // "@outside" openings: the outside side of the opening is a start
  for (const l of resolved.levels) {
    const w = l.bounds.w;
    for (const o of l.openings) {
      if (o.sides[0] !== null && o.sides[1] !== null) continue;
      const lx = o.start[0] - l.bounds.x;
      const ly = o.start[1] - l.bounds.y;
      const pair: Array<[number, number]> =
        o.orientation === "h"
          ? [
              [lx, ly - 1],
              [lx, ly],
            ]
          : [
              [lx - 1, ly],
              [lx, ly],
            ];
      pair.forEach(([cx, cy], side) => {
        if (o.sides[side] !== null) return;
        if (cx >= 0 && cy >= 0 && cx < w && cy < l.bounds.h) seed(l.id, cy * w + cx);
      });
    }
  }

  // link adjacency
  const linkNbrs = new Map<string, Array<[string, number]>>();
  const addN = (a: [string, number], b: [string, number]): void => {
    const key = `${a[0]}|${a[1]}`;
    const list = linkNbrs.get(key);
    if (list) list.push(b);
    else linkNbrs.set(key, [b]);
  };
  for (const link of resolved.links) {
    const lo = levels.get(link.fromLevel);
    const up = levels.get(link.toLevel);
    if (!lo || !up) continue;
    const idx = (l: ResolvedLevel, c: Vec2): number => {
      const lx = c[0] - l.bounds.x;
      const ly = c[1] - l.bounds.y;
      return lx < 0 || ly < 0 || lx >= l.bounds.w || ly >= l.bounds.h ? -1 : ly * l.bounds.w + lx;
    };
    const ar = idx(up, link.arrival);
    if (ar < 0) continue;
    for (const c of link.lowerCells) {
      const li = idx(lo, c);
      if (li < 0) continue;
      if (linkKindInfo(link.kind).climbsUp) addN([lo.id, li], [up.id, ar]);
      addN([up.id, ar], [lo.id, li]);
    }
  }

  while (queue.length > 0) {
    const [lid, i] = queue.pop() as [string, number];
    const l = levels.get(lid) as ResolvedLevel;
    const { w, h } = l.bounds;
    const lx = i % w;
    const ly = (i - lx) / w;
    const pass = (g: ResolvedLevel["hEdges"], e: number): boolean => {
      const k = g.kind[e];
      if (k === EDGE.NONE) return true;
      if (k === EDGE.LEDGE) return (g.height[e] as number) <= 0.5;
      if (k === EDGE.OPENING) {
        const o = l.openings[g.ref[e] as number];
        return !o || isPassage(o.kind);
      }
      return false;
    };
    if (ly > 0 && pass(l.hEdges, sideEdgeIndex(l.bounds, lx, ly, "N"))) seed(lid, i - w);
    if (ly < h - 1 && pass(l.hEdges, sideEdgeIndex(l.bounds, lx, ly, "S"))) seed(lid, i + w);
    if (lx > 0 && pass(l.vEdges, sideEdgeIndex(l.bounds, lx, ly, "W"))) seed(lid, i - 1);
    if (lx < w - 1 && pass(l.vEdges, sideEdgeIndex(l.bounds, lx, ly, "E"))) seed(lid, i + 1);
    for (const [nl, ni] of linkNbrs.get(`${lid}|${i}`) ?? []) seed(nl, ni);
  }
  return reached;
}
