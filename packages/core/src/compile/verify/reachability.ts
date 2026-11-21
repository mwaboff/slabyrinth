/**
 * Movement: every area the plan reaches from the entry is still reached once the build is placed. What only the build
 * knows (obstructed cells, blocked doors, links that do not work) is laid over the plan's walk; an area the plan
 * reaches and the build does not is named with the first thing in the way.
 *
 * With the plan (VerifyOptions.plan) the resolver's WalkGraph is reused (`walkReachability`, the plan-level
 * playability rules); without it a walk of verify's own is run twice, plan-only and realized.
 *
 * Emits `verify_area_unreachable` (error), one per area, in level and area order.
 */
import type { CompileDiagnosticCode } from "../../contracts/compiler";
import type { LevelId, OpeningKind } from "../../contracts/plan";
import type { ResolvedPlan } from "../../contracts/resolved";
import { CELL_FLAG, EDGE } from "../../contracts/resolved";
import { OPPOSITE, SIDE_STEP, SIDES } from "../../gen/gridGeometry";
import { isPassage } from "../../gen/openingKinds";
import { walkReachability } from "../../resolve";
import type { VerifyCtx } from "./context";
import type { Solid } from "./grid";
import { STEP } from "./limits";
import type { LinkVerdicts } from "./links";
import type { ObstructedCells } from "./openFloor";
import { type BlockedOpenings, openingEdges } from "./openings";
import type { StairRuns } from "./runs";
import { fmt, planElements, solidLabel, uniq } from "./words";

/** The codes this file emits (VERIFY_CODES is the union of every check's list). */
export const REACH_CODES = ["verify_area_unreachable"] as const satisfies readonly CompileDiagnosticCode[];

type Link = ResolvedPlan["links"][number];

/** What the build adds to the plan's walk: the hand-offs of the open-floor, opening and link checks. */
export interface BuildBlocks {
  readonly runs: StairRuns;
  readonly obstructed: ObstructedCells;
  readonly doors: BlockedOpenings;
  readonly links: LinkVerdicts;
}

export function checkReachability(ctx: VerifyCtx, blocks: BuildBlocks): void {
  if (ctx.opts.plan) checkWalkGraphReach(ctx, blocks);
  else checkOwnWalkReach(ctx, blocks);
}

/** The resolver's walk with the build's blocks as `extraBlocked` / `extraBlockedOpenings`. */
function checkWalkGraphReach(ctx: VerifyCtx, { runs, obstructed, doors, links }: BuildBlocks): void {
  const plan = ctx.opts.plan;
  if (!plan) return;
  const { resolved } = ctx;
  const extraBlocked: Record<LevelId, number[]> = {};
  const block = (levelId: LevelId, x: number, y: number): void => {
    const g = ctx.grids.get(levelId);
    const i = g ? g.index(x, y) : -1;
    if (i >= 0) (extraBlocked[levelId] ??= []).push(i);
  };
  for (const o of obstructed.list()) block(o.levelId, o.cell[0], o.cell[1]);
  // stairs that do not arrive: their arrival cells cannot be reached by them
  for (const lk of resolved.links) {
    if (!links.broken(lk.id)) continue;
    for (const { arrival } of runs.arrivals(lk)) block(lk.toLevel, arrival[0], arrival[1]);
  }
  const extraBlockedOpenings: Record<LevelId, Array<{ openingId: string; side: 0 | 1 | "both" }>> = {};
  for (const d of doors.list())
    (extraBlockedOpenings[d.levelId] ??= []).push({
      openingId: d.openingId,
      side: d.sides.size > 1 ? "both" : ([...d.sides][0] ?? "both"),
    });
  const base = walkReachability(plan, resolved, {}, { secret: true });
  const real = walkReachability(plan, resolved, { extraBlocked, extraBlockedOpenings }, { secret: true });
  // what stands in the way: obstructed cells the plan reaches and the build does not, then the blocked doors
  const culprits: Array<{ cell: [number, number]; solids: readonly Solid[] }> = [];
  for (const o of obstructed.list()) {
    const i = ctx.grids.get(o.levelId)?.index(o.cell[0], o.cell[1]) ?? -1;
    if (i >= 0 && base.get(o.levelId)?.[i] && !real.get(o.levelId)?.[i])
      culprits.push({ cell: o.cell, solids: o.solids });
  }
  for (const d of doors.list()) culprits.push({ cell: d.start, solids: d.solids });
  for (const L of ctx.levels) {
    const bm = base.get(L.id);
    const rm = real.get(L.id);
    if (!bm || !rm) continue;
    for (const area of L.areas) {
      if (area.kind === "zone") continue;
      const ai = L.areaIds.indexOf(area.id) + 1;
      let inBase = false;
      let inReal = false;
      for (let i = 0; i < L.cells.area.length; i++) {
        if (L.cells.area[i] !== ai) continue;
        if (bm[i]) inBase = true;
        if (rm[i]) inReal = true;
      }
      if (!inBase || inReal) continue;
      const c = culprits[0];
      const b = c?.solids[0];
      const viaLink = b ? undefined : brokenLinkFor(ctx, links, L.id);
      ctx.report.add({
        severity: "error",
        code: "verify_area_unreachable",
        levelId: L.id,
        elementId: area.id,
        elementIds: planElements([area.id, ...(c?.solids.map((s) => s.p.source.elementId) ?? [])]),
        ...(c ? { cell: c.cell, assets: uniq(c.solids.map((s) => s.name)) } : {}),
        message: b
          ? `${area.name ?? area.id} on level ${L.id} cannot be reached once the build is placed: ${solidLabel(b)} blocks the way at ${fmt(c.cell)}.`
          : viaLink
            ? `${area.name ?? area.id} on level ${L.id} cannot be reached once the build is placed: ${viaLink.text}.`
            : `${area.name ?? area.id} on level ${L.id} cannot be reached once the build is placed, although the plan connects it (no link on the way to it is broken: check the openings leading to it).`,
        hint: b
          ? `Move ${b.p.source.elementId ?? b.name} or the opening it blocks, or add a second opening into ${area.id}.`
          : viaLink
            ? `${viaLink.fix.charAt(0).toUpperCase()}${viaLink.fix.slice(1)}.`
            : `Check the openings leading to ${area.id}; add another opening.`,
      });
    }
  }
}

/** One-line description of a link, with the ends spelled out: "stairs "a" (from l2 (9,26) climbing N to l1)". */
function linkWords(lk: Link): string {
  const f = lk.lowerCells[0];
  const run =
    lk.kind === "stairs" || lk.kind === "ramp"
      ? ` climbing ${lk.dir} to ${lk.toLevel}, landing at ${fmt(lk.arrival)}`
      : ` up to ${lk.toLevel}`;
  return `${lk.kind.replace("_", " ")} "${lk.id}" (from ${lk.fromLevel} ${f ? fmt([f[0], f[1]]) : ""}${run})`;
}

/** The broken link a player on level `target` would have had to use: first failing link on the way from the entry. */
function brokenLinkFor(
  ctx: VerifyCtx,
  links: LinkVerdicts,
  target: LevelId,
): { text: string; fix: string } | undefined {
  const { resolved } = ctx;
  const entry =
    ctx.opts.entryLevelId ??
    ctx.opts.plan?.entryLevel ??
    [...ctx.levels].sort((a, b) => b.elevation - a.elevation)[0]?.id;
  if (!entry || entry === target) return undefined;
  const prev = new Map<LevelId, { from: LevelId; link: Link }>();
  const q: LevelId[] = [entry];
  const seen = new Set<LevelId>([entry]);
  while (q.length) {
    const cur = q.shift() as LevelId;
    for (const lk of resolved.links) {
      const nxt = lk.fromLevel === cur ? lk.toLevel : lk.toLevel === cur ? lk.fromLevel : undefined;
      if (nxt === undefined || seen.has(nxt)) continue;
      seen.add(nxt);
      prev.set(nxt, { from: cur, link: lk });
      q.push(nxt);
    }
  }
  const path: Link[] = [];
  for (let at: LevelId | undefined = target; at !== undefined && prev.has(at); at = prev.get(at)?.from)
    path.unshift((prev.get(at) as { link: Link }).link);
  const bad = path.find((lk) => links.broken(lk.id)) ?? resolved.links.find((lk) => links.broken(lk.id));
  if (!bad) return undefined;
  const w = links.reason(bad.id);
  return {
    text: `the way there is ${linkWords(bad)}, which does not work${w ? `: ${w.why}` : ""}`,
    fix: w?.fix ?? `check link ${bad.id}`,
  };
}

/**
 * What the own walk steps over besides cells: the opening on each side of a cell ("level|x,y|side"), and the jumps a
 * link makes between cells ("level|x,y" → cells; a stair run from its top step to its arrival, a pit drop one way
 * down, other links between their lower and upper cells both ways).
 */
function ownWalkGraph(
  { levels, resolved }: VerifyCtx,
  runs: StairRuns,
): {
  openingAt: Map<string, { id: string; kind: OpeningKind }>;
  jumps: Map<string, Array<{ to: string; link: string }>>;
} {
  const openingAt = new Map<string, { id: string; kind: OpeningKind }>();
  for (const L of levels)
    for (const op of L.openings)
      for (const e of openingEdges(op)) {
        openingAt.set(`${L.id}|${e.b[0]},${e.b[1]}|${e.sideOfB}`, { id: op.id, kind: op.kind });
        openingAt.set(`${L.id}|${e.a[0]},${e.a[1]}|${OPPOSITE[e.sideOfB]}`, { id: op.id, kind: op.kind });
      }
  const jumps = new Map<string, Array<{ to: string; link: string }>>();
  const addJump = (a: string, b: string, link: string, both = true): void => {
    (jumps.get(a) ?? jumps.set(a, []).get(a) ?? []).push({ to: b, link });
    if (both) (jumps.get(b) ?? jumps.set(b, []).get(b) ?? []).push({ to: a, link });
  };
  for (const lk of resolved.links) {
    if (lk.kind === "stairs" || lk.kind === "ramp") {
      for (const { top, arrival } of runs.arrivals(lk))
        addJump(`${lk.fromLevel}|${top[0]},${top[1]}`, `${lk.toLevel}|${arrival[0]},${arrival[1]}`, lk.id);
    } else if (lk.kind === "pit_drop") {
      lk.upperCells.forEach((c, i) => {
        const lo = lk.lowerCells[i] ?? c;
        addJump(`${lk.toLevel}|${c[0]},${c[1]}`, `${lk.fromLevel}|${lo[0]},${lo[1]}`, lk.id, false);
      });
    } else {
      lk.lowerCells.forEach((c, i) => {
        const up = lk.upperCells[i] ?? lk.arrival;
        addJump(`${lk.fromLevel}|${c[0]},${c[1]}`, `${lk.toLevel}|${up[0]},${up[1]}`, lk.id);
      });
    }
  }
  return { openingAt, jumps };
}

/**
 * Without the plan: a breadth-first walk from the largest area of the entry level over cells, openings and links, once
 * as the plan has it and once with the build's blocks; steps the realized walk refuses are kept to name the culprit.
 */
function checkOwnWalkReach(ctx: VerifyCtx, { runs, obstructed, doors, links }: BuildBlocks): void {
  const { levels, grids } = ctx;
  if (!levels.length) return;
  const entry =
    levels.find((l) => l.id === ctx.opts.entryLevelId) ??
    [...levels].sort((a, b) => Math.abs(a.elevation) - Math.abs(b.elevation))[0];
  if (!entry) return;
  const { openingAt, jumps } = ownWalkGraph(ctx, runs);
  const rejected: Array<{ cell: string; solids: readonly Solid[] }> = [];
  const cellOf = (k: string): [LevelId, number, number] => {
    const [lv, xy] = k.split("|") as [string, string];
    const [x, y] = xy.split(",").map(Number) as [number, number];
    return [lv, x, y];
  };

  const walk = (realized: boolean): Map<string, number> => {
    const dist = new Map<string, number>();
    const q: string[] = [];
    let head = 0;
    const walkable = (lv: LevelId, x: number, y: number): boolean => {
      const g = grids.get(lv);
      if (!g) return false;
      const c = g.cell(x, y);
      if (!c.open || !c.floor || (c.flags & CELL_FLAG.FEATURE) !== 0) return false;
      if (realized && obstructed.at(lv, x, y)) return false;
      return true;
    };
    const g0 = grids.get(entry.id);
    if (!g0) return dist;
    // start: the largest area on the entry level
    const counts = new Map<number, number>();
    for (let i = 0; i < entry.cells.area.length; i++) {
      const a = entry.cells.area[i] ?? 0;
      if (a > 0) counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    const startArea = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
    for (let ly = 0; ly < g0.h; ly++)
      for (let lx = 0; lx < g0.w; lx++) {
        const x = entry.bounds.x + lx;
        const y = entry.bounds.y + ly;
        if ((startArea === undefined || g0.cell(x, y).area === startArea) && walkable(entry.id, x, y)) {
          const k = `${entry.id}|${x},${y}`;
          dist.set(k, 0);
          q.push(k);
        }
      }
    while (head < q.length) {
      const k = q[head++] as string;
      const d = dist.get(k) ?? 0;
      const [lv, x, y] = cellOf(k);
      const g = grids.get(lv);
      if (!g) continue;
      const run0 = runs.at(lv, x, y);
      for (const side of SIDES) {
        const [dx, dy] = SIDE_STEP[side];
        const nx = x + dx;
        const ny = y + dy;
        const nk = `${lv}|${nx},${ny}`;
        if (dist.has(nk)) continue;
        const kind = g.edgeKind(x, y, side);
        if (kind === EDGE.WALL) continue;
        if (kind === EDGE.OPENING) {
          const op = openingAt.get(`${lv}|${x},${y}|${side}`);
          if (op && !isPassage(op.kind)) continue;
          const blocked = realized && op ? doors.at(lv, op.id) : undefined;
          if (blocked) {
            rejected.push({ cell: nk, solids: blocked.solids });
            continue;
          }
        }
        const runN = runs.at(lv, nx, ny);
        // inside a stair run you move along the run; lateral entry only at the bottom step
        if (run0 && run0.k > 0 && !(runN && runN.linkId === run0.linkId)) continue;
        if (runN && runN.k > 0 && !(run0 && run0.linkId === runN.linkId)) continue;
        if (!walkable(lv, nx, ny)) {
          const there = realized ? obstructed.at(lv, nx, ny) : undefined;
          if (there) rejected.push({ cell: nk, solids: there });
          continue;
        }
        if (!(run0 && runN) && Math.abs(g.top(x, y) - g.top(nx, ny)) > STEP + 1e-6) continue;
        dist.set(nk, d + 1);
        q.push(nk);
      }
      for (const j of jumps.get(k) ?? []) {
        if (dist.has(j.to)) continue;
        if (realized && links.broken(j.link)) continue;
        const [tl, tx, ty] = cellOf(j.to);
        const tg = grids.get(tl);
        if (!tg) continue;
        const c = tg.cell(tx, ty);
        if (!c.open) continue;
        if (!c.floor && !runs.at(tl, tx, ty)) continue;
        if (realized && obstructed.at(tl, tx, ty)) continue;
        dist.set(j.to, d + 1);
        q.push(j.to);
      }
    }
    return dist;
  };

  const plan = walk(false);
  const real = walk(true);
  for (const L of levels) {
    for (const area of L.areas) {
      if (area.kind === "zone") continue;
      const ai = L.areaIds.indexOf(area.id) + 1;
      const cells: string[] = [];
      for (let i = 0; i < L.cells.area.length; i++) {
        if (L.cells.area[i] !== ai) continue;
        const x = L.bounds.x + (i % L.bounds.w);
        const y = L.bounds.y + Math.floor(i / L.bounds.w);
        cells.push(`${L.id}|${x},${y}`);
      }
      if (!cells.some((c) => plan.has(c)) || cells.some((c) => real.has(c))) continue;
      // the first rejected step that the plan-level path would have taken
      const cand = rejected
        .filter((r) => plan.has(r.cell) && !real.has(r.cell))
        .sort((a, b) => (plan.get(a.cell) ?? 0) - (plan.get(b.cell) ?? 0))[0];
      const at = cand ? (cand.cell.split("|")[1] ?? "").split(",").map(Number) : null;
      const b = cand?.solids[0];
      ctx.report.add({
        severity: "error",
        code: "verify_area_unreachable",
        levelId: L.id,
        elementId: area.id,
        elementIds: planElements([area.id, ...(cand?.solids.map((s) => s.p.source.elementId) ?? [])]),
        ...(at && at.length === 2 ? { cell: [at[0] ?? 0, at[1] ?? 0] as const } : {}),
        ...(cand ? { assets: uniq(cand.solids.map((s) => s.name)) } : {}),
        message: b
          ? `${area.name ?? area.id} on level ${L.id} cannot be reached once the build is placed: ${solidLabel(b)} blocks the way at ${cand.cell.split("|")[1] ?? "?"}.`
          : `${area.name ?? area.id} on level ${L.id} cannot be reached once the build is placed, although the plan connects it.`,
        hint: b
          ? `Move ${b.p.source.elementId ?? b.name} or the opening it blocks, or add a second opening into ${area.id}.`
          : `Check the stairs and openings leading to ${area.id}; add another opening.`,
      });
    }
  }
}
