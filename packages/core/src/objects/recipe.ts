/**
 * Object recipes (generator 5; techniques M1, M2, M12): a vessel, a stall or a machine is built as one object in its own
 * frame, then turned and placed whole (objects/place.ts).
 *
 * - Frame: origin at the footprint centre, the object's front along local +z, y = 0 its datum (a vessel's waterline, a
 *   stall's ground). Units are tiles. Every piece is placed by the arrangement engine (arrange/).
 * - Slots: every recipe fills the four core slots (mass, supports, face, top), always built; any other slot is optional.
 *   A slot is filled by parts; a part is one arrangement-engine composition over stand-ins (objects/lexicon.ts), which
 *   find their pieces through roles and trait pools and fall back (borrow, simplify, skip) on their own.
 * - Parts carry what the budget needs: the rung (25 / 50 / 100 / 200) that adds them, whether they are silhouette,
 *   interior mass or detail, and how they are held (resting on what is under them, or fastened to a neighbour: spars,
 *   rigging, rails, hung cloth).
 * - Budget (`buildObject`): the recipe builds at its finest level of detail; optional parts are cut, interior mass
 *   first, then detail, the highest rung first; core and silhouette parts are never cut. When even those exceed the
 *   budget, the recipe builds again at a coarser level of detail (a hull of fewer courses). The result reports whether it
 *   is still over. Last, flat pieces whose tops would flicker against an overlapping one are lifted (`unflicker`).
 * - Surfaces: the walkable tops the object declares (a deck, a raised deck, a counter) as polygons at a height, and the
 *   spaces under them (a hold), so a later integration can stand rooms, props and minis on them.
 * Deterministic: everything follows from the parameters, the seed and the palettes.
 */
import {
  placedBox,
  snapYaw,
  type ArrangePiece,
  type Arrangement,
  type Placed,
  type XZ,
} from "../arrange/piece";
import { transform } from "../arrange/transform";
import { rotateXZ } from "../util/turn";
import type { ObjectKit } from "./kit";
import { footprintOf, overlapArea } from "./outline";

export const CORE_SLOTS = ["mass", "supports", "face", "top"] as const;
export type CoreSlot = (typeof CORE_SLOTS)[number];

/** The budget ladder (M12): the piece budget at which a part is added. */
export const RUNGS = [25, 50, 100, 200] as const;
export type Rung = (typeof RUNGS)[number];

/** What a part is to the object: its outline, mass inside it, or detail on it. */
export type PartKind = "silhouette" | "interior" | "detail";

/**
 * How a part's pieces are held: each resting on what is under it, fastened to a neighbouring piece (a spar, a rail), or
 * strung as a line held at its ends (ratlines and stays: pieces cannot tilt, so a sloping line is a stepped row of
 * level pieces, its anchors at the ends).
 */
export type Hold = "rest" | "fastened" | "line";

export interface Part {
  readonly name: string;
  readonly slot: string;
  readonly rung: Rung;
  readonly kind: PartKind;
  readonly hold: Hold;
  readonly pieces: Arrangement;
}

/** A walkable top: a polygon in the object's frame (x, z) at the height `y` a mini stands on. */
export interface Surface {
  readonly id: string;
  readonly y: number;
  readonly polygon: readonly XZ[];
}

/** An enclosed space under a surface (a hold): its floor and ceiling heights and its outline. */
export interface Space {
  readonly id: string;
  readonly floorY: number;
  readonly ceilingY: number;
  readonly polygon: readonly XZ[];
}

/** The parameters every object takes; a recipe adds its own. */
export interface ObjectParams {
  /** The object's main size (tiles): a vessel's length, a stall's width. */
  readonly size: number;
  /** Names every draw. */
  readonly seed: string | number;
  /** Piece budget (default: the recipe's own). */
  readonly budget?: number;
  readonly condition?: Condition;
}

export type Condition = "new" | "worn" | "derelict";

/** What one build of a recipe at one level of detail produces. */
export interface Draft {
  readonly parts: readonly Part[];
  /** The outline the object stands in (frame), and how far round it is kept clear. */
  readonly footprint: readonly XZ[];
  readonly clearance: number;
  readonly surfaces: readonly Surface[];
  readonly spaces: readonly Space[];
}

export interface SlotDef {
  readonly doc: string;
}

export interface ObjectRecipe<P extends ObjectParams> {
  readonly id: string;
  readonly doc: string;
  /** The recipe's slots: the four core slots and its optional ones. */
  readonly slots: Readonly<Record<CoreSlot, SlotDef>> & Readonly<Record<string, SlotDef>>;
  /** The default piece budget. */
  readonly budget: number;
  /** Levels of detail the recipe can build at (0 coarsest .. lods - 1 finest). */
  readonly lods: number;
  build(params: P, kit: ObjectKit, lod: number): Draft;
}

/** A built object: the kept parts, what was cut, its outline, surfaces and spaces, and its budget outcome. */
export interface BuiltObject {
  readonly recipe: string;
  readonly lod: number;
  readonly parts: readonly Part[];
  /** Names of the parts the budget cut, in cut order. */
  readonly cut: readonly string[];
  readonly footprint: readonly XZ[];
  readonly clearance: number;
  readonly surfaces: readonly Surface[];
  readonly spaces: readonly Space[];
  readonly budget: number;
  readonly count: number;
  /** Still over the budget with only core and silhouette parts left at the coarsest detail. */
  readonly over: boolean;
}

const isCore = (slot: string): boolean => (CORE_SLOTS as readonly string[]).includes(slot);
/** A part the budget may never cut. */
export const isKept = (p: Part): boolean => isCore(p.slot) || p.kind === "silhouette";

const KIND_CUT: Readonly<Record<PartKind, number>> = { interior: 0, detail: 1, silhouette: 2 };
/** The piece tier (arrange/budget.ts `thin`) of a part's pieces: kept parts 0, detail 2, interior mass 3. */
const KIND_TIER: Readonly<Record<PartKind, number>> = { silhouette: 0, detail: 2, interior: 3 };

const countOf = (parts: readonly Part[]): number => parts.reduce((n, p) => n + p.pieces.length, 0);

/** The parts kept within the budget and those cut (see the file header), in cut order. */
function cutToBudget(parts: readonly Part[], budget: number): { kept: Part[]; cut: Part[] } {
  const order = parts
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !isKept(p))
    .sort((a, b) => KIND_CUT[a.p.kind] - KIND_CUT[b.p.kind] || b.p.rung - a.p.rung || b.i - a.i);
  const cut = new Set<Part>();
  let n = countOf(parts);
  for (const { p } of order) {
    if (n <= budget) break;
    cut.add(p);
    n -= p.pieces.length;
  }
  return { kept: parts.filter((p) => !cut.has(p)), cut: order.map((o) => o.p).filter((p) => cut.has(p)) };
}

/** The object built within its budget (see the file header). */
export function buildObject<P extends ObjectParams>(
  recipe: ObjectRecipe<P>,
  params: P,
  kit: ObjectKit,
): BuiltObject {
  const budget = Math.max(1, params.budget ?? recipe.budget);
  let chosen: { draft: Draft; lod: number; kept: Part[]; cut: Part[] } | null = null;
  for (let lod = recipe.lods - 1; lod >= 0; lod--) {
    const draft = recipe.build(params, kit, lod);
    for (const p of draft.parts)
      if (!(p.slot in recipe.slots))
        throw new Error(`${recipe.id}: part ${p.name} fills unknown slot ${p.slot}`);
    const { kept, cut } = cutToBudget(draft.parts, budget);
    chosen = { draft, lod, kept, cut };
    if (countOf(kept) <= budget) break;
  }
  if (!chosen) throw new Error(`${recipe.id}: no level of detail`);
  const parts = unflicker(chosen.kept).map((p) => ({ ...p, pieces: tagTier(p.pieces, KIND_TIER[p.kind]) }));
  const count = countOf(parts);
  return {
    recipe: recipe.id,
    lod: chosen.lod,
    parts,
    cut: chosen.cut.map((p) => p.name),
    footprint: chosen.draft.footprint,
    clearance: chosen.draft.clearance,
    surfaces: chosen.draft.surfaces,
    spaces: chosen.draft.spaces,
    budget,
    count,
    over: count > budget,
  };
}

function tagTier(a: Arrangement, tier: number): Placed[] {
  return a.map((q) => (tier > 0 ? { ...q, tier } : q));
}

/**
 * A draft turned about its origin (degrees clockwise): every part, the footprint, surfaces and spaces. A recipe built
 * along +x turns −90 to face its front along +z.
 */
export function turnDraft(d: Draft, turn: number): Draft {
  const poly = (p: readonly XZ[]): XZ[] =>
    p.map(([x, z]) => {
      const r = rotateXZ(x, z, turn);
      return [r.x, r.z];
    });
  return {
    ...d,
    parts: d.parts.map((p) => ({ ...p, pieces: transform(p.pieces, { turn }) })),
    footprint: poly(d.footprint),
    surfaces: d.surfaces.map((s) => ({ ...s, polygon: poly(s.polygon) })),
    spaces: d.spaces.map((s) => ({ ...s, polygon: poly(s.polygon) })),
  };
}

/** Every piece of a built object, part after part. */
export function piecesOf(obj: BuiltObject): Arrangement {
  return obj.parts.flatMap((p) => p.pieces);
}

/** Flat pieces (box height at most this) are the ones whose tops can flicker (review/qualitySlab.ts `flatHeight`). */
const FLAT = 0.5;
/** Two flat tops closer than this over each other flicker; 0.02 in the meter, more here so the slab's 0.01 rounding of
 * either piece cannot bring them within it. */
const TOP_GAP = 0.035;
/** Overlap (tiles², of the boxes in plan) from which two tops count as over each other (the meter's 0.05, less). */
const TOP_AREA = 0.04;
/**
 * The lifts tried, in order, for a flat piece whose top would flicker; a resting prop (which must stay on what is under
 * it) only up to 0.08, tiles and fastened pieces any.
 */
const LIFTS = [0, 0.04, 0.08, -0.04, -0.08, 0.12, 0.16, -0.12] as const;
const PROP_LIFT = 0.08;

/**
 * Every flat piece, in part order, lifted by the first of `LIFTS` that keeps its top clear of the tops of the flat
 * pieces before it that it truly lies over, by their turned footprints (coplanar tops flicker in TaleSpire): neighbours
 * end to end in a course of planks, a spar's two runs. A lift of at most 0.08 keeps a course on the one under it when
 * courses overlap by more than 0.03. Deterministic; a piece that no lift clears keeps its height.
 */
export function unflicker(parts: readonly Part[]): Part[] {
  const kept: { box: ReturnType<typeof placedBox>; foot: XZ[] }[] = [];
  const cell = new Map<string, number[]>();
  const keys = (b: ReturnType<typeof placedBox>): string[] => {
    const out: string[] = [];
    for (let x = Math.floor(b.min.x); x <= Math.floor(b.max.x); x++)
      for (let z = Math.floor(b.min.z); z <= Math.floor(b.max.z); z++) out.push(`${x},${z}`);
    return out;
  };
  const clashes = (b: ReturnType<typeof placedBox>, foot: XZ[]): boolean => {
    const seen = new Set<number>();
    for (const k of keys(b))
      for (const i of cell.get(k) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        const o = kept[i];
        if (!o || Math.abs(o.box.max.y - b.max.y) >= TOP_GAP) continue;
        if (overlapArea(o.foot, foot) >= TOP_AREA) return true;
      }
    return false;
  };
  return parts.map((p) => ({
    ...p,
    pieces: p.pieces.map((q) => {
      if (q.piece.variant.geom.size.y > FLAT) return q;
      const base = placedBox(q);
      const { size } = q.piece.variant.geom;
      const foot = footprintOf(q.x, q.z, size.x, size.z, q.yaw);
      const free = q.piece.measures.kind === "tile" || p.hold === "fastened";
      const lift = LIFTS.find(
        (d) =>
          (free || Math.abs(d) <= PROP_LIFT) &&
          !clashes(
            { min: { ...base.min, y: base.min.y + d }, max: { ...base.max, y: base.max.y + d } },
            foot,
          ),
      );
      const moved = lift === undefined || lift === 0 ? q : { ...q, y: q.y + lift };
      const box = placedBox(moved);
      const i = kept.push({ box, foot }) - 1;
      for (const k of keys(box)) {
        const l = cell.get(k);
        if (l) l.push(i);
        else cell.set(k, [i]);
      }
      return moved;
    }),
  }));
}

/** One piece at a point of the frame (collider centre x, z; bottom y), turned `yaw`. */
export function at(piece: ArrangePiece, x: number, y: number, z: number, yaw = 0): Placed {
  return { piece, x, y, z, yaw: snapYaw(yaw) };
}

/** A part (the helper recipes use): pieces of one composition, in a slot, with its rung, kind and hold. */
export function part(
  name: string,
  slot: string,
  pieces: Arrangement,
  o: { rung?: Rung; kind?: PartKind; hold?: Hold } = {},
): Part {
  return { name, slot, rung: o.rung ?? 25, kind: o.kind ?? "silhouette", hold: o.hold ?? "rest", pieces };
}
