/**
 * The detail recipe engine (generator 5): one pass over a finished level that walks its anchors (resolve/anchors/),
 * instances every enabled recipe (table.ts; each behind its own switch) and attaches the instances
 * (resolve/level/arrangements.ts). Everything a recipe does not say is done here, once:
 *   - conditions: the recipe's `when` at each anchor of its kind, in anchor order;
 *   - pieces: each slot filled by the slot rule (slots.ts); a slot that must skip leaves the recipe out there;
 *   - seeds: every draw of a recipe at an anchor is named by the plan seed, the level, the anchor key and the recipe
 *     (`hashUnit(seed, ...)`), so adding a recipe or an anchor never moves another's pieces;
 *   - frames: the arrangement composed in the anchor's frame, mirrored when the frame is, set where the frame stands;
 *   - keeping clear (keepClear.ts): a piece that would stand in a door's way, on stairs, across a lane, in a feature or a
 *     building's fixtures is left out (the rest of the instance stays);
 *   - the budget (budget.ts): what the level can spend, tier and focus deciding what goes first;
 *   - ownership: an instance's pieces are one element (its id names the recipe and the anchor); wall-mounted recipes are
 *     built as wall structure in the anchor's paste layer.
 */
import { placedBox, toInstance, mirror, type Arrangement } from "../../arrange";
import type { ResolvedArrangement, ResolvedFeature, ResolvedLevel } from "../../contracts/resolved";
import { isPassage, isWindow } from "../../gen/openingKinds";
import type { PaletteView } from "../../palette/view";
import { THEME_WALL_ROLE, wallRole } from "../../palette/roles";
import type { GeneratorProfile } from "../../plan/generator";
import {
  LevelAnchors,
  framePoint,
  type Anchor,
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
import type { AnyRecipe, ComposeCtx, FilledSlot, Recipe, RecipeCtx } from "./types";

export interface RecipeRunCtx {
  readonly planSeed: number;
  readonly profile: GeneratorProfile;
  readonly palette: PaletteView;
  /** Pieces this level's recipes may spend (budget.ts `detailBudgets`). */
  readonly budget: number;
  /** The recipes to run (default: the table); each still needs its switch. */
  readonly recipes?: readonly AnyRecipe[];
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

interface Placed extends Proposal {
  readonly inst: ResolvedArrangement;
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
      return h === null ? null : level.elevation + f.baseHeight + h;
    },
    defaultTheme: palette.defaultTheme,
    boardEdgeIsExit: profile.boardEdgeExits,
  });
  const clear = new KeepClear(level, anchors.grid, anchors.of("zone"), heightOf);
  const rctx: RecipeCtx = { level, anchors, roles };
  const skipped: Array<{ recipe: string; anchor: string; why: string }> = [];
  const sources = new Map<string, number>();
  const proposals: Placed[] = [];
  const zoneOf = new Map(anchors.of("zone").map((z) => [z.area, z]));
  for (const r of recipes)
    proposeAny(r, { rctx, anchors, clear, run, skipped, sources, proposals, level, zoneOf });
  const s = spend(proposals, run.budget);
  const attached: ResolvedArrangement[] = [];
  for (const p of s.kept) {
    const kept = records.attach(profile, p.inst);
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
}

/** A table entry: each member of the union is a Recipe<K> of its own K, which the generic body takes whole. */
const proposeAny = propose as (r: AnyRecipe, c: ProposeCtx) => void;

/** Every instance one recipe proposes on the level. */
function propose<K extends AnchorKind>(r: Recipe<K>, c: ProposeCtx): void {
  for (const a of c.anchors.of(r.anchor)) {
    if (!r.when(a, c.rctx)) continue;
    const slots: Record<string, FilledSlot> = {};
    let missing: string | null = null;
    for (const name of Object.keys(r.slots).sort()) {
      const spec = r.slots[name];
      if (!spec) continue;
      const filled = fillSlot(c.rctx.roles, a.theme, spec, a);
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
    const at = (density: number): Placed | null => {
      const cctx: ComposeCtx = { ...c.rctx, seed, density };
      const arr = r.compose(a, slots, cctx);
      if (!arr || arr.length === 0) return null;
      const inst = instanceOf(r, a, arr, c);
      if (!inst) return null;
      return {
        key: inst.id,
        tier: r.tier(a),
        focus: focusOf(a, c.zoneOf),
        count: inst.pieces.length,
        thinned: r.thinnable && density > 0.25 ? () => at(density / 2) : null,
        inst,
      };
    };
    const p = at(1);
    if (p) c.proposals.push(p);
    else c.skipped.push({ recipe: r.id, anchor: a.key, why: "nothing to place" });
  }
}

/** The instance of an arrangement at an anchor, less the pieces the keep-clear rule refuses (null when none is left). */
function instanceOf<K extends AnchorKind>(
  r: Recipe<K>,
  a: AnchorOf<K>,
  arr: Arrangement,
  c: ProposeCtx,
): ResolvedArrangement | null {
  const f = a.frame;
  const local = f.mirror === true ? mirror(arr, { axis: "x", keep: false }) : arr;
  const refused = new Map<ClearReason, number>();
  const kept = local.filter((p) => {
    const why = c.clear.refuse(planBox(f.at, f.turn, f.base, p));
    if (why) refused.set(why, (refused.get(why) ?? 0) + 1);
    return why === null;
  });
  for (const [why, n] of refused)
    c.skipped.push({ recipe: r.id, anchor: a.key, why: `${n} piece${n > 1 ? "s" : ""} in a ${why}` });
  if (kept.length === 0) return null;
  return toInstance(kept, {
    id: `${r.id}@${a.key}`,
    recipe: r.id,
    anchor: { at: [f.at[0], f.at[1]], base: f.base, turn: f.turn },
    blocking: r.blocking,
    ...(r.mount === "wall" ? { mount: "wall" as const } : {}),
    ...(a.layer !== undefined ? { layer: a.layer } : {}),
  });
}

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
 * where its frame stands; else 0.5.
 */
function focusOf(a: Anchor, zoneOf: ReadonlyMap<string, ZoneAnchor>): number {
  if (a.kind === "opening") return isPassage(a.openingKind) ? 1 : isWindow(a.openingKind) ? 0.6 : 0.5;
  if (a.room === null) return 0.5;
  const z = zoneOf.get(a.room);
  if (!z) return 0.5;
  const [x, y] = a.frame.at;
  return z.focalAt(Math.floor(x), Math.floor(y));
}
