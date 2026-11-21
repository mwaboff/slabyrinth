/**
 * resolvePlan (architecture §2.4–§2.7): MapPlan → ResolvedPlan, the single geometric source of truth for the 2D
 * view and the slab compiler. Pure and deterministic: the same plan gives byte-identical canonical JSON.
 */
import type { LevelId, MapPlan, PlanIssue, ThemeId } from "../contracts/plan";
import { generatorProfile } from "../plan/generator";
import { linkGeometry } from "../plan/links";
import type { ResolvedLink, ResolvedPlan } from "../contracts/resolved";
import { CELL, CELL_FLAG } from "../contracts/resolved";
import { canonicalJson } from "../util/canonical";
import { h64hex } from "../util/hash";
import { LevelSteps } from "./level";
import { linkOpenings } from "./level/floorOpenings";
import { type ThemeDefaults, builtinThemeDefaults } from "./themes";
import { type PaletteView, bundledPaletteView } from "../palette/view";

export interface ResolveOptions {
  /** Restrict the output to these levels (all levels are still resolved, because links span levels). */
  levels?: LevelId[];
  /** Version number recorded in ResolvedPlan.planVersion (default 0). */
  planVersion?: number;
  /** Theme defaults lookup (default: the built-in table mirroring the bundled palettes). */
  themeDefaults?: (theme: ThemeId) => ThemeDefaults;
  /**
   * What the resolver asks of the palette (piece sizes, room pieces, covered-stall forms, floor tile sizes); default
   * the bundled palettes. A caller that goes on to compile passes a view of the compiler's palettes
   * (`paletteOptionsFor`), so both stages decide from the same palettes.
   */
  palette?: PaletteView;
}

export function resolvePlan(plan: MapPlan, opts: ResolveOptions = {}): ResolvedPlan {
  const issues: PlanIssue[] = [];
  const themeDefaults = opts.themeDefaults ?? builtinThemeDefaults;
  const palette = opts.palette ?? bundledPaletteView();
  const works: LevelSteps[] = plan.levels.map(
    (_, levelIndex) =>
      new LevelSteps({
        plan,
        levelIndex,
        themeDefaults,
        issues,
        palette,
      }),
  );
  const byId = new Map<string, LevelSteps>();
  for (const w of works) if (!byId.has(w.level.id)) byId.set(w.level.id, w);

  for (const w of works) w.runPhase1();
  const links = resolveLinks(plan, byId, issues);
  if (generatorProfile(plan).floorOpenings) {
    // floor openings look into the next level down (rubble heaps and checks happen on both sides)
    const byElev = [...works].sort((a, b) => a.level.elevation - b.level.elevation);
    for (const w of works)
      linkOpenings(w, byElev.filter((o) => o.level.elevation < w.level.elevation).pop());
  }
  for (const w of works) w.runPhase2();

  const levels = works
    .map((w, i) => ({ r: w.toResolved(), i }))
    .sort((a, b) => a.r.elevation - b.r.elevation || a.i - b.i)
    .map((x) => x.r);

  const keep = opts.levels ? new Set(opts.levels) : null;
  const out: ResolvedPlan = {
    planId: plan.id,
    planVersion: opts.planVersion ?? 0,
    generator: plan.generator,
    levels: keep ? levels.filter((l) => keep.has(l.id)) : levels,
    links: keep ? links.filter((l) => keep.has(l.fromLevel) || keep.has(l.toLevel)) : links,
    issues: keep ? issues.filter((is) => is.levelId === undefined || keep.has(is.levelId)) : issues,
    hash: "",
  };
  out.hash = resolvedHash(out);
  return out;
}

/** FNV-1a 64 of the canonical JSON of the resolved plan without its hash field. */
export function resolvedHash(r: ResolvedPlan): string {
  return h64hex(canonicalJson({ ...r, hash: undefined }));
}

/** Canonical bytes of a resolved plan (what determinism tests compare). */
export function canonicalResolved(r: ResolvedPlan): string {
  return canonicalJson(r);
}

function resolveLinks(plan: MapPlan, byId: Map<string, LevelSteps>, issues: PlanIssue[]): ResolvedLink[] {
  const out: ResolvedLink[] = [];
  plan.links.forEach((link, k) => {
    const path = `/links/${k}`;
    const push = (is: Omit<PlanIssue, "path" | "elementId">): void => {
      issues.push({ ...is, path, elementId: link.id });
    };
    const lo = byId.get(link.from.level);
    const up = byId.get(link.to.level);
    if (!lo || !up) {
      push({
        severity: "error",
        code: "ref_unknown",
        message: `link "${link.id}" names unknown level ${!lo ? link.from.level : link.to.level}`,
        hint: `levels: ${plan.levels.map((l) => l.id).join(", ")}`,
      });
      return;
    }
    const rise = up.level.elevation - lo.level.elevation;
    if (rise <= 0) {
      push({
        severity: "error",
        code: "link_mismatch",
        message: `link "${link.id}" (${link.kind}) goes from ${lo.level.id} (elev ${lo.level.elevation}) to ${up.level.id} (elev ${up.level.elevation}); rise must be > 0`,
        hint: "from is the LOWER end: swap from and to",
      });
      return;
    }
    const dir = link.dir ?? "N";
    const geo = linkGeometry(link, lo.level.elevation, up.level.elevation);
    if (link.to.at && (link.to.at[0] !== geo.arrival[0] || link.to.at[1] !== geo.arrival[1])) {
      push({
        severity: "error",
        code: "link_mismatch",
        message: `${link.kind} from ${lo.level.id} ${link.from.at[0]},${link.from.at[1]} dir ${dir} rise ${rise} arrive at ${geo.arrival[0]},${geo.arrival[1]}`,
        hint: `omit to.at or set it to [${geo.arrival[0]},${geo.arrival[1]}]`,
      });
    }
    // lower cells: OPEN, floor, not already a link
    for (const c of geo.lowerCells) {
      const i = lo.idx(c[0], c[1]);
      let why: string | null = null;
      if (i < 0) why = "is outside the level bounds";
      else if (lo.state[i] !== CELL.OPEN) why = lo.state[i] === CELL.SOLID ? "is solid rock" : "is void";
      else if ((lo.flags[i] as number) & CELL_FLAG.NO_FLOOR) why = "has no floor";
      else if ((lo.flags[i] as number) & CELL_FLAG.LINK) why = "is already used by another link";
      if (why) {
        push({
          severity: "error",
          code: "link_blocked",
          message: `${link.kind} "${link.id}" needs ${lo.level.id} cell ${c[0]},${c[1]}, which ${why}`,
          levelId: lo.level.id,
          cell: c,
          hint:
            !generatorProfile(plan).explainedLinkRuns
              ? `the run covers ${geo.lowerCells.map((p) => `${p[0]},${p[1]}`).join(" ")}; move from.at or change dir`
              : link.kind === "stairs" || link.kind === "ramp"
              ? `a rise of ${rise} needs a straight run of ${geo.length} cells (1 per tile of rise) from from.at ${link.from.at[0]},${link.from.at[1]} in direction ${dir}: ${geo.lowerCells.map((p) => `${p[0]},${p[1]}`).join(" ")}; it does not fit, so move from.at to where ${geo.length} free floor cells lie in a line, change dir, or space the levels closer (not under 3.5) or use a ladder for a short link`
              : `the cells it needs: ${geo.lowerCells.map((p) => `${p[0]},${p[1]}`).join(" ")}; move from.at`,
        });
        break;
      }
    }
    const needFloor = link.kind === "stairs" || link.kind === "ramp" || link.kind === "trapdoor";
    const badArrival = geo.arrivalCells.find((c) => {
      const ai = up.idx(c[0], c[1]);
      return ai < 0 || up.state[ai] !== CELL.OPEN || (needFloor && !up.isFloor(ai));
    });
    if (link.kind !== "pit_drop" && badArrival) {
      push({
        severity: "error",
        code: "link_blocked",
        message: `${link.kind} "${link.id}" arrives at ${up.level.id} ${badArrival[0]},${badArrival[1]}, which is not open floor`,
        levelId: up.level.id,
        cell: badArrival,
        hint: `make ${badArrival[0]},${badArrival[1]} on ${up.level.id} part of a room, or move the link`,
      });
    }
    for (const c of geo.lowerCells) {
      const i = lo.idx(c[0], c[1]);
      if (i >= 0) lo.flags[i] = (lo.flags[i] as number) | CELL_FLAG.LINK;
    }
    if (link.kind !== "trapdoor") {
      for (const c of geo.upperCells) {
        const i = up.idx(c[0], c[1]);
        if (i < 0 || up.state[i] !== CELL.OPEN) continue;
        const bits = link.kind === "pit_drop" ? CELL_FLAG.NO_FLOOR : CELL_FLAG.NO_FLOOR | CELL_FLAG.STAIRWELL;
        up.flags[i] = (up.flags[i] as number) | bits;
      }
    }
    const fromIdx = lo.idx(link.from.at[0], link.from.at[1]);
    const rl: ResolvedLink = {
      id: link.id,
      kind: link.kind,
      fromLevel: lo.level.id,
      toLevel: up.level.id,
      lowerCells: geo.lowerCells,
      upperCells: geo.upperCells,
      arrival: geo.arrival,
      dir,
      rise,
      theme: lo.themes[fromIdx >= 0 ? (lo.theme[fromIdx] as number) : 0] ?? lo.levelTheme,
    };
    if (link.label !== undefined) rl.label = link.label;
    out.push(rl);
  });
  return out;
}
