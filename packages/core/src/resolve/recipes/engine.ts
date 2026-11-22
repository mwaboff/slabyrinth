/**
 * The detail recipe engine (generator 5): one pass over a finished level that walks its anchors (resolve/anchors/),
 * instances every enabled recipe (table.ts; each behind its own switch) and attaches the instances
 * (resolve/level/arrangements.ts). Everything a recipe does not say is done here, once:
 *   - conditions: the recipe's `when` at each anchor of its kind, in anchor order;
 *   - pieces: each slot filled by the slot rule (slots.ts); a slot that must skip leaves the recipe out there;
 *   - seeds: every draw of a recipe at an anchor is named by the plan seed, the level, the anchor key and the recipe
 *     (`hashUnitMixed(seed, ...)`), so adding a recipe or an anchor never moves another's pieces;
 *   - frames: the arrangement composed in the anchor's frame, mirrored when the frame is, set where the frame stands;
 *   - keeping clear (keepClear.ts): a piece that would stand in a door's way, on stairs, across a lane, in a feature or a
 *     building's fixtures is left out (the rest of the instance stays);
 *   - the budget (budget.ts): what the level can spend, tier and focus deciding what goes first;
 *   - ownership: an instance's pieces are one element (its id names the recipe and the anchor); wall-mounted recipes are
 *     built as wall structure in the anchor's paste layer.
 */
import {
  ARRANGE_LIMITS,
  placedBox,
  planPointOf,
  toInstance,
  mirror,
  type Arrangement,
  type InstanceSpec,
} from "../../arrange";
import type { ResolvedArrangement, ResolvedFeature, ResolvedLevel } from "../../contracts/resolved";
import { isPassage, isWindow } from "../../gen/openingKinds";
import type { PaletteView } from "../../palette/view";
import { THEME_WALL_ROLE, partRole, postRole, wallRole } from "../../palette/roles";
import { THEME_WALL_STYLE } from "../../gen/wallStyles";
import type { GeneratorProfile } from "../../plan/generator";
import {
  LevelAnchors,
  framePoint,
  type Anchor,
  type AnchorFrame,
  type AnchorKind,
  type AnchorOf,
  type WallMount,
  type ZoneAnchor,
} from "../anchors";
import { LevelGrid } from "../levelGrid";
import type { ArrangementRecords } from "../level/arrangements";
import { spend, type Proposal } from "./budget";
import { KeepClear, type ClearReason, type PlanBox } from "./keepClear";
import { fillSlot } from "./slots";
import { RECIPES } from "./table";
import { drawTreatments, subjectIdOf, type Treatment, type TreatmentFamily } from "./treatments";
import type { AnyRecipe, ComposeCtx, FilledSlot, Recipe, RecipeCtx } from "./types";

export interface RecipeRunCtx {
  readonly planSeed: number;
  readonly profile: GeneratorProfile;
  readonly palette: PaletteView;
  /** Pieces this level's recipes may spend (budget.ts `detailBudgets`). */
  readonly budget: number;
  /** The recipes to run (default: the table); each still needs its switch. */
  readonly recipes?: readonly AnyRecipe[];
  /** The treatment families to draw from (default: treatments.ts TREATMENTS). */
  readonly families?: readonly TreatmentFamily[];
}

/** What a run did, for tests and proofs. */
export interface RecipeReport {
  readonly budget: number;
  readonly projected: number;
  readonly spent: number;
  readonly attached: readonly ResolvedArrangement[];
  readonly dropped: readonly string[];
  /** Instances or pieces left out: (recipe, anchor key, why). */
  readonly skipped: ReadonlyArray<{ recipe: string; anchor: string; why: string }>;
  /** Slot sources by recipe and slot (role, theme, borrowed, simplified), with counts. */
  readonly sources: ReadonlyMap<string, number>;
}

/** A recipe instance before the budget: its kept pieces in the anchor's frame and the element it becomes. */
interface Composed {
  readonly arr: Arrangement;
  readonly frame: AnchorFrame;
  /** Which way a coplanar flat piece is stepped: down for wall trims, up for loose cover. */
  readonly dir: 1 | -1;
  readonly spec: InstanceSpec;
}

interface Placed extends Proposal {
  readonly inst: Composed;
}

/** Runs the enabled recipes over a finished level and attaches what the budget keeps. */
export function runRecipes(
  level: ResolvedLevel,
  records: ArrangementRecords,
  run: RecipeRunCtx,
): RecipeReport {
  const empty: RecipeReport = {
    budget: run.budget,
    projected: 0,
    spent: 0,
    attached: [],
    dropped: [],
    skipped: [],
    sources: new Map(),
  };
  const { profile, palette } = run;
  if (!profile.arrangements) return empty;
  const recipes = (run.recipes ?? RECIPES).filter((r) => profile[r.switch]);
  if (recipes.length === 0) return empty;
  const roles = palette.roles;
  const mountOf = (theme: string, style: string): WallMount =>
    (roles.resolve(theme, wallRole(style)).resolution ?? roles.resolve(theme, THEME_WALL_ROLE).resolution)
      ?.def.mount ?? "half-cell";
  const grid = new LevelGrid(level, palette.defaultTheme);
  const heightOf = (f: ResolvedFeature): number | null =>
    palette.pieceSize(grid.themeAt(f.theme, f.at[0], f.at[1]), f.type, true)?.h ?? null;
  const anchors = new LevelAnchors(level, {
    mountOf,
    topOf: (f) => {
      const h = heightOf(f);
      // (baseHeight is absolute: it holds the level's elevation already)
      return h === null ? null : f.baseHeight + h;
    },
    defaultTheme: palette.defaultTheme,
    boardEdgeIsExit: profile.boardEdgeExits,
  });
  const clear = new KeepClear(level, anchors.grid, anchors.of("zone"), heightOf);
  const rctx: RecipeCtx = { level, anchors, roles };
  const treatments = drawTreatments({
    planSeed: run.planSeed,
    level,
    defaultTheme: palette.defaultTheme,
    zones: anchors.of("zone"),
    areaWalls: areaWallStyles(anchors),
    hasTrim: (theme, style) => {
      const t = roles.paletteTheme(theme);
      return [partRole("facade_post", style), postRole(style)].some(
        (role) => !!roles.resolve(t, role).resolution,
      );
    },
    ...(run.families ? { families: run.families } : {}),
  });
  const skipped: Array<{ recipe: string; anchor: string; why: string }> = [];
  const sources = new Map<string, number>();
  const proposals: Placed[] = [];
  const zoneOf = new Map(anchors.of("zone").map((z) => [z.area, z]));
  for (const r of recipes)
    proposeAny(r, {
      rctx,
      anchors,
      clear,
      run,
      skipped,
      sources,
      proposals,
      level,
      zoneOf,
      treatments,
    });
  const s = spend(proposals, run.budget);
  const attached: ResolvedArrangement[] = [];
  const tops = new Map<string, PlanBox[]>();
  for (const p of s.kept) {
    const own = tops.get(p.inst.spec.recipe) ?? [];
    tops.set(p.inst.spec.recipe, own);
    const kept = records.attach(profile, toInstance(separate(p.inst, own), p.inst.spec));
    if (kept) attached.push(kept);
  }
  return {
    budget: run.budget,
    projected: s.projected,
    spent: s.spent,
    attached,
    dropped: s.dropped.map((p) => p.key),
    skipped,
    sources,
  };
}

interface ProposeCtx {
  readonly rctx: RecipeCtx;
  readonly anchors: LevelAnchors;
  readonly clear: KeepClear;
  readonly run: RecipeRunCtx;
  readonly level: ResolvedLevel;
  readonly skipped: Array<{ recipe: string; anchor: string; why: string }>;
  readonly sources: Map<string, number>;
  readonly proposals: Placed[];
  readonly zoneOf: ReadonlyMap<string, ZoneAnchor>;
  readonly treatments: ReadonlyMap<string, Treatment>;
}

/** The wall styles of the level's own walls each area sees (its faces'). */
function areaWallStyles(anchors: LevelAnchors): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of anchors.of("face")) {
    if (f.structure !== null || f.room === null) continue;
    const list = out.get(f.room) ?? [];
    if (!list.includes(f.style)) list.push(f.style);
    out.set(f.room, list);
  }
  return out;
}

/** A table entry: each member of the union is a Recipe<K> of its own K, which the generic body takes whole. */
const proposeAny = propose as (r: AnyRecipe, c: ProposeCtx) => void;

/** Every instance one recipe proposes on the level. */
function propose<K extends AnchorKind>(r: Recipe<K>, c: ProposeCtx): void {
  for (const a of c.anchors.of(r.anchor)) {
    if (!r.when(a, c.rctx)) continue;
    const t = c.treatments.get(subjectIdOf(c.level, a)) ?? c.treatments.get(c.level.id);
    const variant = t?.variant(r.family, r.id) ?? null;
    if (!t || variant === null) continue;
    const own = "style" in a ? a.style : THEME_WALL_STYLE;
    let trim = t.trim ?? own;
    const slots: Record<string, FilledSlot> = {};
    let missing: string | null = null;
    for (const name of Object.keys(r.slots).sort()) {
      const spec = r.slots[name];
      if (!spec) continue;
      let filled = fillSlot(c.rctx.roles, a.theme, spec, a, trim);
      // a contrast the theme cannot make in this slot falls back to the wall's own material, for the whole recipe
      if (!filled && trim !== own) {
        trim = own;
        filled = fillSlot(c.rctx.roles, a.theme, spec, a, trim);
      }
      if (!filled) {
        missing = name;
        break;
      }
      slots[name] = filled;
      const k = `${r.id}.${name}:${filled.source}`;
      c.sources.set(k, (c.sources.get(k) ?? 0) + 1);
    }
    if (missing !== null) {
      c.skipped.push({ recipe: r.id, anchor: a.key, why: `no piece for ${missing}` });
      continue;
    }
    const seed = `${c.run.planSeed}|${c.level.id}|${a.key}|${r.id}`;
    const f = a.frame;
    // the composed arrangement at a density, in the frame's own (unmirrored) axes, split into its blocks
    const memo = new Map<number, Map<string, Arrangement>>();
    const groups = (density: number): Map<string, Arrangement> => {
      let g = memo.get(density);
      if (!g) {
        const cctx: ComposeCtx = { ...c.rctx, seed, density, variant, treatment: t, trim };
        const arr = r.compose(a, slots, cctx) ?? [];
        const local = f.mirror === true ? mirror(arr, { axis: "x", keep: false }) : arr;
        g = blocksOf(local, f, r.block);
        memo.set(density, g);
      }
      return g;
    };
    const at = (density: number, block: string): Placed | null => {
      const arr = groups(density).get(block);
      if (!arr || arr.length === 0) return null;
      const inst = instanceOf(r, a, arr, c, block, density, t.key);
      if (!inst) return null;
      const p0 = inst.arr[0];
      return {
        key: inst.spec.id,
        tier: r.tier(a),
        focus: focusOf(a, c.zoneOf, block === "" || !p0 ? null : planPointOf(f.at, f.turn, p0.x, p0.z)),
        count: Math.min(inst.arr.length, ARRANGE_LIMITS.piecesPerInstance),
        thinned: r.thinnable && density > 0.25 ? () => at(density / 2, block) : null,
        inst,
      };
    };
    let any = false;
    for (const block of groups(1).keys()) {
      const p = at(1, block);
      if (!p) continue;
      c.proposals.push(p);
      any = true;
    }
    if (!any) c.skipped.push({ recipe: r.id, anchor: a.key, why: "nothing to place" });
  }
}

/**
 * An arrangement's pieces by the plan block (`block` cells square) their centre stands in, keyed "bx,by" in row order;
 * one group keyed "" without blocks.
 */
function blocksOf(local: Arrangement, f: AnchorFrame, block: number | undefined): Map<string, Arrangement> {
  if (block === undefined || block <= 0) return new Map(local.length > 0 ? [["", local]] : []);
  const by = new Map<string, { bx: number; by: number; ps: Arrangement[number][] }>();
  for (const p of local) {
    const [px, py] = planPointOf(f.at, f.turn, p.x, p.z);
    const bx = Math.floor(px / block);
    const byy = Math.floor(py / block);
    const k = `${bx},${byy}`;
    const g = by.get(k) ?? { bx, by: byy, ps: [] };
    g.ps.push(p);
    by.set(k, g);
  }
  return new Map(
    [...by.entries()].sort((p, q) => p[1].by - q[1].by || p[1].bx - q[1].bx).map(([k, g]) => [k, g.ps]),
  );
}

/**
 * A flat piece (at most this tall) is judged for coplanar tops: two within 0.02 over AREA flicker in game; GAP adds the
 * slab's 0.01 quantisation of each piece, and a piece is stepped STEP clear of it.
 */
const FLAT = 0.5;
const GAP = 0.035;
const AREA = 0.05;
const STEP = 0.04;

/**
 * A recipe instance (block `block`) at an anchor before the budget: the arrangement less the pieces the keep-clear rule
 * refuses (null when none is left), and the element it becomes.
 */
function instanceOf<K extends AnchorKind>(
  r: Recipe<K>,
  a: AnchorOf<K>,
  local: Arrangement,
  c: ProposeCtx,
  block: string,
  density: number,
  treatment: string,
): Composed | null {
  const f = a.frame;
  const refused = new Map<ClearReason, number>();
  const kept = local.filter((p) => {
    const why = c.clear.refuse(planBox(f.at, f.turn, f.base, p), r.underfoot === true);
    if (why) refused.set(why, (refused.get(why) ?? 0) + 1);
    return why === null;
  });
  for (const [why, n] of refused)
    c.skipped.push({ recipe: r.id, anchor: a.key, why: `${n} piece${n > 1 ? "s" : ""} in a ${why}` });
  if (kept.length === 0) return null;
  return {
    arr: kept,
    frame: f,
    dir: r.mount === "wall" ? -1 : 1,
    spec: {
      id: block === "" ? `${r.id}@${a.key}` : `${r.id}@${a.key}#${block}`,
      recipe: r.id,
      anchor: { at: [f.at[0], f.at[1]], base: f.base, turn: f.turn },
      blocking: r.blocking,
      host: a.element,
      treatment,
      ...(r.mount === "wall" ? { mount: "wall" as const } : {}),
      ...(a.layer !== undefined ? { layer: a.layer } : {}),
    },
  };
}

/**
 * A kept proposal's pieces with no two flat tops of its recipe meeting: a flat piece whose top would lie within GAP of
 * a flat top it overlaps by AREA (its own instance's, or one of the same recipe kept before it) is stepped STEP down
 * (wall-mounted: a band stays under its floor line) or up (loose: a cover piece lies on the one under it) until clear.
 * Run on what the budget kept, in order, so a thinned or dropped instance never leaves a stale top behind.
 */
function separate(p: Composed, tops: PlanBox[]): Arrangement {
  const f = p.frame;
  return p.arr.map((piece) => {
    if (piece.piece.variant.geom.size.y > FLAT) return piece;
    let q = piece;
    for (let k = 0; k < 6; k++) {
      const b = planBox(f.at, f.turn, f.base, q);
      if (!tops.some((o) => Math.abs(o.z1 - b.z1) < GAP && overlapArea(o, b) >= AREA)) break;
      q = { ...q, y: q.y + p.dir * STEP };
    }
    tops.push(planBox(f.at, f.turn, f.base, q));
    return q;
  });
}

/** The plan area two boxes share. */
const overlapArea = (a: PlanBox, b: PlanBox): number =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
  Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** A placed piece's box in plan x/y and absolute height (its turned footprint, turned again into the plan). */
function planBox(at: readonly [number, number], turn: number, base: number, p: Arrangement[number]): PlanBox {
  const b = placedBox(p);
  const corners = [
    framePoint({ at, turn, base }, b.min.x, b.min.z),
    framePoint({ at, turn, base }, b.max.x, b.min.z),
    framePoint({ at, turn, base }, b.max.x, b.max.z),
    framePoint({ at, turn, base }, b.min.x, b.max.z),
  ];
  const xs = corners.map((q) => q[0]);
  const ys = corners.map((q) => q[1]);
  return {
    x0: Math.min(xs[0] ?? 0, xs[1] ?? 0, xs[2] ?? 0, xs[3] ?? 0),
    x1: Math.max(xs[0] ?? 0, xs[1] ?? 0, xs[2] ?? 0, xs[3] ?? 0),
    y0: Math.min(ys[0] ?? 0, ys[1] ?? 0, ys[2] ?? 0, ys[3] ?? 0),
    y1: Math.max(ys[0] ?? 0, ys[1] ?? 0, ys[2] ?? 0, ys[3] ?? 0),
    z0: base + b.min.y,
    z1: base + b.max.y,
  };
}

/**
 * How focal an anchor is, 0 (calm) .. 1: a door's opening 1, a window's 0.6; anything in a room the room's focal score
 * where its frame stands (or `where`: a block of a large anchor); else 0.5.
 */
function focusOf(
  a: Anchor,
  zoneOf: ReadonlyMap<string, ZoneAnchor>,
  where: readonly [number, number] | null = null,
): number {
  if (a.kind === "opening") return isPassage(a.openingKind) ? 1 : isWindow(a.openingKind) ? 0.6 : 0.5;
  if (a.room === null) return 0.5;
  const z = zoneOf.get(a.room);
  if (!z) return 0.5;
  const [x, y] = where ?? a.frame.at;
  return z.focalAt(Math.floor(x), Math.floor(y));
}
