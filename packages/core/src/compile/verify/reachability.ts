/**
 * Movement: every area the plan reaches from the entry is still reached once the build is placed. What only the build
 * knows (obstructed cells, blocked doors, links that do not work) is laid over the plan's walk (the resolver's
 * WalkGraph, resolve/playability.ts `walkPathsFrom`: one pathfinder, one entry-level rule, plan/links.ts
 * `entryLevelId`); an area the plan reaches and the build does not is named with what stands in the way.
 *
 * What is named (generator switch `reachBlamesPathBlocker`): the first blocked cell, blocked door or broken link on the
 * plan's walk to that area. Released generators name the first blocker found anywhere, and look for a broken link from
 * the highest level when the plan names no entry.
 *
 * Emits `verify_area_unreachable` (error), one per area, in level and area order.
 */
import type { CompileDiagnosticCode } from "../../contracts/compiler";
import type { LevelId } from "../../contracts/plan";
import type { ResolvedPlan } from "../../contracts/resolved";
import { entryLevelId, isRunLink } from "../../plan/links";
import { walkPathsFrom, type WalkCell, type WalkPaths } from "../../resolve";
import type { VerifyCtx } from "./context";
import type { Solid } from "./grid";
import type { LinkVerdicts } from "./links";
import type { ObstructedCells } from "./openFloor";
import { type BlockedOpening, type BlockedOpenings, openingEdges } from "./openings";
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

/** What stands in the way of an area: pieces at a cell (an obstructed cell, a blocked door), or a broken link. */
type Culprit = { cell: [number, number]; solids: readonly Solid[] } | { link: Link };

/** The level the party enters on: VerifyOptions.entryLevelId, else the plan's rule over the plan's (or the built) levels. */
function verifyEntryLevel({ opts, resolved }: VerifyCtx): LevelId | undefined {
  return entryLevelId({
    entryLevel: opts.entryLevelId ?? opts.plan?.entryLevel,
    levels: opts.plan?.levels ?? resolved.levels,
  });
}

export function checkReachability(ctx: VerifyCtx, blocks: BuildBlocks): void {
  const { runs, obstructed, doors, links } = blocks;
  const { resolved } = ctx;
  const entry = verifyEntryLevel(ctx);
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
  const base = walkPathsFrom(resolved, entry, {}, { secret: true });
  const real = walkPathsFrom(
    resolved,
    entry,
    { extraBlocked, extraBlockedOpenings },
    { secret: true },
  ).reached;
  const blame = ctx.profile.reachBlamesPathBlocker
    ? pathBlame(ctx, blocks, base)
    : firstFoundBlame(ctx, blocks, base.reached, real);
  for (const L of ctx.levels) {
    const bm = base.reached.get(L.id);
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
      const culprit = blame(L.id, ai);
      const c = culprit && "solids" in culprit ? culprit : undefined;
      const b = c?.solids[0];
      const viaLink = b
        ? undefined
        : culprit && "link" in culprit
          ? linkFailure(links, culprit.link)
          : brokenLinkFor(ctx, links, L.id, entry);
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

/** Names the culprit for an area (level id, 1-based area index), or undefined when nothing is found in the way. */
type Blame = (levelId: LevelId, areaIndex: number) => Culprit | undefined;

/**
 * Released generators: one culprit for every area, the first found: an obstructed cell the plan reaches and the build
 * does not, else the first blocked door.
 */
function firstFoundBlame(
  ctx: VerifyCtx,
  { obstructed, doors }: BuildBlocks,
  base: ReadonlyMap<LevelId, Uint8Array>,
  real: ReadonlyMap<LevelId, Uint8Array>,
): Blame {
  const culprits: Culprit[] = [];
  for (const o of obstructed.list()) {
    const i = ctx.grids.get(o.levelId)?.index(o.cell[0], o.cell[1]) ?? -1;
    if (i >= 0 && base.get(o.levelId)?.[i] && !real.get(o.levelId)?.[i])
      culprits.push({ cell: o.cell, solids: o.solids });
  }
  for (const d of doors.list()) culprits.push({ cell: d.start, solids: d.solids });
  return () => culprits[0];
}

/**
 * Generator 4: the first thing in the way on the plan's walk to the area (to its nearest cell): a blocked door the walk
 * crosses, an obstructed cell it enters, or a broken link it arrives by.
 */
function pathBlame(ctx: VerifyCtx, { runs, obstructed, doors, links }: BuildBlocks, base: WalkPaths): Blame {
  const key = (a: WalkCell, b: WalkCell): string => `${a.levelId}|${a.cell.join(",")}|${b.cell.join(",")}`;
  const doorBetween = new Map<string, BlockedOpening>();
  for (const d of doors.list()) {
    const op = ctx.levelOf.get(d.levelId)?.openings.find((o) => o.id === d.openingId);
    for (const e of op ? openingEdges(op) : []) {
      const a = { levelId: d.levelId, cell: e.a };
      const b = { levelId: d.levelId, cell: e.b };
      doorBetween.set(key(a, b), d);
      doorBetween.set(key(b, a), d);
    }
  }
  const brokenArrival = new Map<string, Link>();
  for (const lk of ctx.resolved.links)
    if (links.broken(lk.id))
      for (const { arrival } of runs.arrivals(lk))
        brokenArrival.set(`${lk.toLevel}|${arrival.join(",")}`, lk);
  return (levelId, areaIndex) => {
    const L = ctx.levelOf.get(levelId);
    if (!L) return undefined;
    let path: WalkCell[] = [];
    for (let i = 0; i < L.cells.area.length; i++) {
      if (L.cells.area[i] !== areaIndex) continue;
      const p = base.pathTo(levelId, i);
      if (p.length > 0 && (path.length === 0 || p.length < path.length)) path = p;
    }
    for (let k = 0; k < path.length; k++) {
      const here = path[k] as WalkCell;
      const prev = path[k - 1];
      const door = prev && prev.levelId === here.levelId ? doorBetween.get(key(prev, here)) : undefined;
      if (door) return { cell: door.start, solids: door.solids };
      const solids = obstructed.at(here.levelId, here.cell[0], here.cell[1]);
      if (solids) return { cell: [here.cell[0], here.cell[1]], solids };
      const link =
        prev && prev.levelId !== here.levelId
          ? brokenArrival.get(`${here.levelId}|${here.cell.join(",")}`)
          : undefined;
      if (link) return { link };
    }
    return undefined;
  };
}

/** One-line description of a link, with the ends spelled out: "stairs "a" (from l2 (9,26) climbing N to l1)". */
function linkWords(lk: Link): string {
  const f = lk.lowerCells[0];
  const run = isRunLink(lk.kind)
    ? ` climbing ${lk.dir} to ${lk.toLevel}, landing at ${fmt(lk.arrival)}`
    : ` up to ${lk.toLevel}`;
  return `${lk.kind.replace("_", " ")} "${lk.id}" (from ${lk.fromLevel} ${f ? fmt([f[0], f[1]]) : ""}${run})`;
}

/** What a broken link says in the message and the hint. */
function linkFailure(links: LinkVerdicts, bad: Link): { text: string; fix: string } {
  const w = links.reason(bad.id);
  return {
    text: `the way there is ${linkWords(bad)}, which does not work${w ? `: ${w.why}` : ""}`,
    fix: w?.fix ?? `check link ${bad.id}`,
  };
}

/**
 * The broken link a player on level `target` would have had to use: first failing link on the way from the entry level
 * (released generators: VerifyOptions.entryLevelId or the plan's entryLevel, else the highest level).
 */
function brokenLinkFor(
  ctx: VerifyCtx,
  links: LinkVerdicts,
  target: LevelId,
  planEntry: LevelId | undefined,
): { text: string; fix: string } | undefined {
  const { resolved } = ctx;
  const entry = ctx.profile.reachBlamesPathBlocker
    ? planEntry
    : (ctx.opts.entryLevelId ??
      ctx.opts.plan?.entryLevel ??
      [...ctx.levels].sort((a, b) => b.elevation - a.elevation)[0]?.id);
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
  return bad ? linkFailure(links, bad) : undefined;
}
