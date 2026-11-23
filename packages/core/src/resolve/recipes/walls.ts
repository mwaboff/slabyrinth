/**
 * Wall recipes (plan Wave 1, W7 and W8): posts at the jambs of openings and at outer corners (D6), pilasters on long
 * blank runs phase-locked to the openings (D6), the band course along a building's floor lines (D3) and a plinth where
 * a wall meets the ground with no footing (D3, D5). Composed in the anchor's frame (resolve/anchors/frame.ts: x along
 * the wall, z out of it, y up from the storey's floor), from measures of the chosen piece, never from constants of one
 * kit. Which of them a building (or a room's walls) gets, in which variant and material, is its treatment
 * (treatments.ts: families "frame" and "courses", and "trim" for the material).
 *
 * Pieces, in the slot order of slots.ts, in the trim style `t` (the wall's own style, or a contrasting one the
 * treatment drew):
 *   post   the theme's own slender pillar (feature.pillar, its own palette only; not for a contrasting trim) → the trim
 *          style's post (facade_post.<t> → wall_post.<t>) → the theme's own post (wall_post.wall) → the theme's own
 *          structural posts; at most storey high, no thicker than 0.62 (corners: 0.35, so a corner never doubles its
 *          wall's own corner filler). None: the recipe is left out.
 *   band   (a) the theme's own thin structural beam (0.9-2.6 long, at most 0.5 high and deep); (b) none: a thin beam
 *          borrowed from the trait pool in the trim's material (wood on a timber wall, stone on masonry); (c) none: a
 *          floor slab showing its edge (floor.<surface of t>), only on a floor line whose upper floor hides its inner
 *          part (never a single-storey wall, an eave, or a ruin open to the sky); (d) else no band.
 *
 * One rule for every trim (`seated`) but (c): no piece reaches behind the wall's inner face (the anchor's `depth`, less
 * a margin); a deep piece is pushed out until its back is inside the wall, and a piece that would then stand prouder
 * than its recipe allows is simplified or left out. A building's rooms behind its walls never see a trim.
 *   plinth the trim style's footing course (footing.<t>) → the theme's own thin beam, sunk to show a low course and
 *          never deeper behind the surface than the wall is thick; none: no plinth (a 1-tile floor slab would show
 *          through the wall inside).
 *
 * Variety (one rule for every recipe here): one subject, one set of pieces. A piece is chosen per subject (the
 * treatment's seed), so every jamb and corner of one building shows the same post and both posts of an opening match.
 * Along a run (a band, a plinth) the pieces mix within the chosen piece's own family (the same palette and role, about
 * the same size: one material, one kit) with no three alike in a row (`pick` mix, noRun 2). Two buildings with the same
 * treatment still differ by their own draws: band depth, plinth height, pilaster pitch.
 */
import {
  fromPool,
  mirror,
  pick,
  repeat,
  single,
  stack,
  transform,
  type Arrangement,
  type ArrangePiece,
} from "../../arrange";
import { isGap, isPassage, isSecret } from "../../gen/openingKinds";
import { THEME_WALL_STYLE, isLowWallStyle, wallStyleInfo } from "../../gen/wallStyles";
import { THEME_POST_ROLE, floorRole, partRole, postRole } from "../../palette/roles";
import type { TraitQuery } from "../../palette/traitPools";
import { hashUnitMixed } from "../../util/hash";
import { baysOf, blankStretches, type FaceEnd, type FaceGap, type StoreyLineAnchor } from "../anchors";
import type { ComposeCtx, FilledSlot, Recipe, RecipeCtx, SlotRole } from "./types";

/** Role families structure may borrow from (no furniture, signs or rubble of the right shape). */
const STRUCTURE = [
  "wall",
  "wall_post",
  "facade",
  "facade_post",
  "footing",
  "pier",
  "porch_post",
  "corner_pier",
  "stall",
];

/** How far a post or band stands proud of the wall at most (the rest is bedded in it). */
const PROUD = 0.3;
/** A band's projection when it is a floor slab's edge: between these (a subject's draw). */
const SLAB_PROUD = [0.18, 0.3] as const;
/** A band lies this much under the floor line, so its top never meets the floor's own (≥ 0.02 after quantising). */
const UNDER_FLOOR = 0.03;
/** A post this much shorter than its storey still reads storey high; a taller one would poke past the wall. */
const POST_SLACK = 0.05;
/** A plinth shows this much above the ground (a subject's draw) and stands this proud. */
const PLINTH_SHOW = [0.18, 0.35] as const;
const PLINTH_PROUD = [0.08, 0.18] as const;
/** A trim's back stops this far short of its wall's inner face (it never shows in the room behind the wall). */
const TRIM_MARGIN = 0.08;

/**
 * The one rule every wall trim keeps (posts, bands, plinths): its piece, `depth` across the wall, stands `wanted` proud
 * of the surface, pushed out until its back is no deeper behind the surface than the wall reaches (the anchor's
 * `depth`, its inner face, less TRIM_MARGIN), and never more than wholly proud; null when that leaves it more than
 * `most` proud (a slab deeper than the wall is thick): the course is simplified or skipped.
 */
function seated(
  depth: number,
  wanted: number,
  most: number,
  wall: { readonly depth: number },
): number | null {
  const proud = Math.min(depth, Math.max(wanted, depth - (wall.depth - TRIM_MARGIN)));
  return proud > most + 1e-9 ? null : proud;
}
/** A blank run longer than this gets pilasters, at this pitch (a subject's draw), phase-locked to its openings. */
const PILASTER_RUN = 4;
const PILASTER_PITCH = [2, 3] as const;

/** A subject's draw `what` within [lo, hi]. */
const within = (ctx: ComposeCtx, what: string, [lo, hi]: readonly [number, number]): number =>
  lo + (hi - lo) * ctx.treatment.jitter(what);

/**
 * The post roles of a trim style: the theme's own slender pillar (own trims only), then the style's post chain. A
 * setting-kit style's posts (gen/wallStyles.ts) come from the theme's own palettes only (`ownWallsFirst`: its walls are
 * then the theme's own, and so are its posts).
 */
const postRoles = (style: string, trim: string, ctx?: RecipeCtx): SlotRole[] => {
  const own = ctx?.profile.ownWallsFirst === true && wallStyleInfo(trim)?.settingKit === true;
  return [
    ...(trim === style ? [{ role: "feature.pillar", own: true }] : []),
    { role: partRole("facade_post", trim), ...(own ? { own } : {}) },
    { role: postRole(trim), ...(own ? { own } : {}) },
    { role: THEME_POST_ROLE },
  ];
};

/** Readable trims (generator 5, `readableTrims`): how far a post or band of the wall's own piece family stands proud. */
const RELIEF_PROUD = 0.42;
/**
 * A corner post is at most this thick (so it never doubles its wall's own corner filler, and its box keeps clear of the
 * free centre of the outside cells next to the corner, which a thicker one covers: keepClear "open").
 */
const CORNER_THICK = 0.35;
/** ... a doubled band's second course: stepped back this much under the first, with this shadow gap between them. */
const BAND_STEP = 0.12;
const BAND_GAP = 0.04;
/** ... a plinth shows this much and stands this proud. */
const PLINTH_SHOW_RELIEF = [0.35, 0.5] as const;
const PLINTH_PROUD_RELIEF = [0.18, 0.28] as const;

const readable = (ctx: RecipeCtx | undefined): boolean => ctx?.profile.readableTrims === true;

/**
 * A trim piece of the wall's own piece family (its style's post, or the theme's post on the theme's wall or a wall
 * built in it): at a street's distance it reads only by relief.
 */
function sameFamily(piece: ArrangePiece, style: string): boolean {
  const suffix = piece.role.split(".").pop();
  if (piece.role === THEME_POST_ROLE)
    return style === THEME_WALL_STYLE || wallStyleInfo(style)?.settingKit === true;
  return suffix === style && (piece.role.startsWith("facade_post.") || piece.role.startsWith("wall_post."));
}

/** How far a post stands proud at most: `RELIEF_PROUD` for one of the wall's own family under readableTrims. */
const postProud = (post: ArrangePiece, style: string, ctx: ComposeCtx): number =>
  readable(ctx) && sameFamily(post, style) ? RELIEF_PROUD : PROUD;

/** A post up to `height` tall and at most `thick` across. */
const postShape = (height: number, thick: number): TraitQuery => ({
  trait: "post",
  where: { height: [1, height + POST_SLACK], length: [0.12, thick] },
  families: STRUCTURE,
});

/** A thin structural beam: a band or a plinth course. */
const beamShape = (): TraitQuery => ({
  trait: "beam",
  where: { height: [0.06, 0.5], width: [0.06, 0.5], length: [0.9, 2.6] },
  families: STRUCTURE,
});

/** The floor material a trim style shows as a flat course (the wall table's surface), else `fallback`. */
const surfaceOf = (trim: string, fallback: string): string => wallStyleInfo(trim)?.surface ?? fallback;

/** A 1 x 1 floor slab (every theme has one per material). */
const slabShape = (): TraitQuery => ({
  trait: "slab",
  kind: "tile",
  where: { length: [0.99, 1.01], width: [0.99, 1.01] },
});

/**
 * The subject's piece of a filled slot: each candidate ranked by a draw named by the subject and the piece, the best
 * taken. A piece that wins once wins wherever it is a candidate, so a building shows one post on every jamb, corner and
 * pilaster (a storey too low for it, or a corner too narrow, takes the next best).
 */
function choose(slot: FilledSlot | undefined, ctx: ComposeCtx, what: string): ArrangePiece | undefined {
  let best: ArrangePiece | undefined;
  let rank = -1;
  for (const p of slot?.pieces ?? []) {
    const r = hashUnitMixed(ctx.treatment.seed, what, p.palette, p.role, p.variant.wanted);
    if (r > rank) {
      rank = r;
      best = p;
    }
  }
  return best;
}

/** The chosen piece's own family in a slot: the same palette and role, about its size (one material, one kit). */
function kin(slot: FilledSlot | undefined, c: ArrangePiece): ArrangePiece[] {
  const m = c.measures;
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.1 * Math.max(a, b) + 0.02;
  const others = (slot?.pieces ?? []).filter(
    (p) =>
      p !== c &&
      p.palette === c.palette &&
      p.role === c.role &&
      near(p.measures.length, m.length) &&
      near(p.measures.width, m.width) &&
      near(p.measures.height, m.height),
  );
  return [c, ...others];
}

/**
 * A post standing `height` tall from y = 0, its centre at (x, z): one piece, or pieces stacked to the height with the
 * last one flush with the top.
 */
function postColumn(post: ArrangePiece, height: number): Arrangement {
  const h = post.variant.geom.size.y;
  // (a piece within POST_SLACK of the height is the height: no second piece a hair above the first)
  const n = Math.max(1, Math.ceil((height - POST_SLACK) / h));
  if (n === 1) return single(post);
  const col = stack(single(post), { count: n - 1 });
  return [...col, ...transform(single(post), { dy: height - h })];
}

/**
 * Its depth across the wall (local z at yaw 0) and how far its centre stands from the surface: `max` proud at most, its
 * back within the wall (`seated`); null when a post that deep cannot keep both.
 */
function proudOf(
  post: ArrangePiece,
  max: number,
  wall: { readonly depth: number },
): { across: number; along: number; z: number } | null {
  const across = post.variant.geom.size.z;
  const along = post.variant.geom.size.x;
  const proud = seated(across, Math.min(across, max), max, wall);
  return proud === null ? null : { across, along, z: proud - across / 2 };
}

/** A straight run along a wall: a face or a storey line. */
interface Run {
  readonly length: number;
  readonly gaps: readonly FaceGap[];
  readonly ends: readonly [FaceEnd, FaceEnd];
  readonly beyond: readonly [number, number];
}

/**
 * A course along a run's blank stretches: `module` (one piece, lengthwise, its back at local z = proud - depth) repeated
 * end to end at `pitch`, its pieces mixed by `from`. At an outer corner the run's end goes on past the meeting surface by
 * its own projection, and its start begins where the other run's course (the same depth) ends, so the two meet
 * without lying over each other; at an inner corner the end stops short of the other course and the start at its wall.
 */
function course(
  run: Run,
  module: Arrangement,
  p: { proud: number; depth: number; pitch: number; from: readonly ArrangePiece[]; seed: string },
): Arrangement {
  const out: Arrangement[] = [];
  const stretches = blankStretches(run.length, run.gaps);
  const size = module[0]?.piece.variant.geom.size;
  if (!size) return [];
  const along = module[0]?.yaw === 90 ? size.z : size.x;
  stretches.forEach(([from, to], i) => {
    const first = i === 0 && from === 0;
    const last = i === stretches.length - 1 && to === run.length;
    const x0 = !first
      ? from
      : run.ends[0] === "convex"
        ? -run.beyond[0] - p.proud + p.depth
        : run.ends[0] === "concave"
          ? -run.beyond[0]
          : 0;
    const x1 = !last
      ? to
      : run.ends[1] === "convex"
        ? run.length + run.beyond[1] + p.proud
        : run.ends[1] === "concave"
          ? run.length + run.beyond[1] - p.proud
          : run.length;
    const len = x1 - x0;
    if (len <= 0.2) return;
    out.push(repeat(transform(module, { dx: x0 + along / 2 }), { axis: "x", pitch: p.pitch, length: len }));
  });
  return pick(out.flat(), { from: p.from, policy: { kind: "mix", noRun: 2 }, seed: p.seed });
}

export const jambPosts: Recipe<"opening"> = {
  id: "jambPosts",
  doc: "a slender post at each jamb of a door or window on a seen wall, storey high (D6); variant doors: doors only",
  switch: "jambPosts",
  family: "frame",
  anchor: "opening",
  tier: (a) => (isPassage(a.openingKind) ? 1 : 2),
  mount: "wall",
  blocking: false,
  thinnable: false,
  // a building's rooms are left to the interior recipes: posts frame its outside
  when: (a) =>
    a.seen &&
    !a.natural &&
    (a.structure === null || a.outside) &&
    !isSecret(a.openingKind) &&
    !isGap(a.openingKind) &&
    a.head >= 1.2,
  slots: {
    post: {
      roles: (a, trim, ctx) => postRoles(a.style, trim, ctx),
      shape: (a) => postShape(a.head, 0.62),
      fallback: "skip",
    },
  },
  compose: (a, slots, ctx) => {
    if (ctx.variant === "doors" && !isPassage(a.openingKind)) return null;
    const post = choose(slots.post, ctx, "post");
    const fitted = post ? proudOf(post, postProud(post, a.style, ctx), a) : null;
    if (!post || !fitted) return null;
    const { along, z } = fitted;
    const column = postColumn(post, a.head);
    // a jamb gets its post when the blank beside it takes one; a narrow pier between two openings takes one post,
    // the one of the opening on its left
    const fits = (clear: number, between: boolean, right: boolean): boolean =>
      clear >= along + 0.02 && (!between || right || clear >= 2 * along + 0.1);
    const right = fits(a.clear[1], a.between[1], true)
      ? transform(column, { dx: a.width / 2 + along / 2, dz: z })
      : [];
    const left = fits(a.clear[0], a.between[0], false)
      ? mirror(transform(column, { dx: a.width / 2 + along / 2, dz: z }), { axis: "x", keep: false })
      : [];
    const out = [...right, ...left];
    return out.length > 0 ? out : null;
  },
};

export const cornerPosts: Recipe<"corner"> = {
  id: "cornerPosts",
  doc: "a slender post standing at each outer corner of a seen wall (D6), where the theme has one",
  switch: "cornerPosts",
  family: "frame",
  anchor: "corner",
  tier: () => 2,
  mount: "wall",
  blocking: false,
  thinnable: false,
  when: (a, ctx) =>
    a.convex &&
    a.seen &&
    !a.natural &&
    (a.structure === null || a.outside) &&
    a.height >= 1.2 &&
    // a designed building with corner piers has its corners dressed already
    !(ctx.level.structures ?? []).some(
      (st) => st.id === a.structure && st.design?.details.includes("piers") === true,
    ),
  slots: {
    post: {
      roles: (a, trim, ctx) => postRoles(a.style, trim, ctx),
      shape: (a) => postShape(a.height, CORNER_THICK),
      fallback: "skip",
    },
  },
  compose: (a, slots, ctx) => {
    const post = choose(slots.post, ctx, "post");
    if (!post) return null;
    const max = postProud(post, a.style, ctx);
    const fitted = proudOf(post, max, a);
    if (!fitted) return null;
    const { across, z } = fitted;
    // diagonally off the corner: as proud of the first face (local -x) as of the second (local +z)
    const o = Math.max(z, across / 2 - max);
    // its back stays within both walls (as `seated`)
    if (across / 2 - o > a.depth - TRIM_MARGIN + 1e-9) return null;
    return transform(postColumn(post, a.height), { dx: -o, dz: o });
  },
};

export const pilasters: Recipe<"face"> = {
  id: "pilasters",
  doc: "pilasters on seen blank wall runs longer than 4 tiles, at the joints of bays phase-locked to its openings (D6)",
  switch: "pilasters",
  family: "frame",
  anchor: "face",
  tier: () => 2,
  mount: "wall",
  blocking: false,
  thinnable: true,
  when: (a) =>
    a.seen &&
    !a.natural &&
    !isLowWallStyle(a.style) &&
    (a.structure === null || a.outside) &&
    a.height >= 1.2 &&
    blankStretches(a.length, a.gaps).some(([f, t]) => t - f > PILASTER_RUN),
  slots: {
    post: {
      roles: (a, trim, ctx) => postRoles(a.style, trim, ctx),
      shape: (a) => postShape(a.height, 0.62),
      fallback: "skip",
    },
  },
  compose: (a, slots, ctx) => {
    const post = choose(slots.post, ctx, "post");
    const fitted = post ? proudOf(post, postProud(post, a.style, ctx), a) : null;
    if (!post || !fitted) return null;
    const { along, z } = fitted;
    const column = postColumn(post, a.height);
    const pitch = within(ctx, "pilasterPitch", PILASTER_PITCH) / ctx.density;
    const long = blankStretches(a.length, a.gaps).map(([f, t]) => t - f > PILASTER_RUN);
    const out: Arrangement[] = [];
    for (const b of baysOf(a, pitch)) {
      // a joint between two bays of a long stretch: never at an opening or an end (jambs and corners have theirs)
      if (!long[b.stretch] || b.index >= b.of - 1) continue;
      const x = b.x + b.width / 2;
      if (x - along / 2 < 0.3 || x + along / 2 > a.length - 0.3) continue;
      out.push(transform(column, { dx: x, dz: z }));
    }
    return out.length > 0 ? out.flat() : null;
  },
};

export const bandCourses: Recipe<"storeyLine"> = {
  id: "bandCourses",
  doc: "a band course along a building's outside floor lines (D3); variants: every floor line, the first floor only",
  switch: "bandCourses",
  family: "courses",
  anchor: "storeyLine",
  tier: () => 1,
  mount: "wall",
  blocking: false,
  thinnable: false,
  when: (a) => a.seen && a.length >= 1 && a.line === "floor",
  slots: {
    band: { shape: () => beamShape(), fallback: "simplify" },
    slab: {
      roles: (a, trim) => [{ role: floorRole(trim === a.style ? a.floor : surfaceOf(trim, a.floor)) }],
      shape: () => slabShape(),
      fallback: "skip",
    },
  },
  compose: (a, slots, ctx) => {
    if (ctx.variant === "first" && a.storey !== 1) return null;
    // (a) the theme's own thin beam; (b) else one borrowed from the pool in the trim's material (a wood beam on a
    // timber building, stone on stone); (c) else a floor slab's edge, only where an upper floor hides its inner part;
    // (d) else no band
    const borrowed = slots.band?.pieces.length ? undefined : borrowBeam(a, ctx);
    const beamSlot = borrowed ?? slots.band;
    const beam = choose(beamSlot, ctx, "band");
    const slab = choose(slots.slab, ctx, "slab");
    // readableTrims: a band in the wall's own material stands fully proud and is doubled (see `doubled`)
    const relief = readable(ctx) && ctx.trim === a.style;
    // a beam whose depth fits the wall first; a floor slab's edge only where the wall is deep enough to bed it
    const beamProud = beam
      ? seated(
          beam.measures.width,
          relief
            ? Math.min(PROUD, beam.measures.width)
            : Math.min(PROUD, beam.measures.width) * (0.7 + 0.3 * ctx.treatment.jitter("bandProud")),
          PROUD,
          a,
        )
      : null;
    if (beam && beamProud !== null) {
      const m = beam.measures;
      const proud = beamProud;
      const module = transform(single(beam, m.runAxis === "z" ? 90 : 0), {
        // centred in the floor's thickness under the line
        dz: proud - m.width / 2,
        dy: -0.25 - m.height / 2,
      });
      const p = {
        proud,
        depth: m.width,
        pitch: m.length * 0.97,
        from: kin(beamSlot, beam),
        seed: `${ctx.seed}|band`,
      };
      const arr = [...course(a, module, p), ...(relief ? doubled(a, module, p, m.height) : [])];
      return arr.length > 0 ? arr : null;
    }
    // (c) the one exception to `seated`: a floor slab's inner part lies under the upper floor (the floor's own edge
    // from outside, the ceiling's edge from below), so only on a floor line of a building whose floors stand
    if (!slab || !slabConcealed(a, ctx)) return null;
    const g = slab.variant.geom.size;
    const proud = relief ? SLAB_PROUD[1] : within(ctx, "bandProud", SLAB_PROUD);
    const module = transform(single(slab), { dz: proud - g.z / 2, dy: -g.y - UNDER_FLOOR });
    const p = { proud, depth: g.z, pitch: g.x, from: kin(slots.slab, slab), seed: `${ctx.seed}|band` };
    const arr = [...course(a, module, p), ...(relief ? doubled({ ...a, depth: g.z }, module, p, g.y) : [])];
    return arr.length > 0 ? arr : null;
  },
};

/** What a piece is made of, read from its roles and names: wood, stone, or neither known. */
function pieceMaterial(text: string): "wood" | "stone" | null {
  if (/stone|brick|marble|concrete|rock|granite|masonry/i.test(text)) return "stone";
  if (/wood|timber|plank|log|beam|harbou?r|rafter/i.test(text)) return "wood";
  return null;
}

/** The material a trim style's pieces should be: a timber wall's wood, a masonry wall's stone, either for the theme's. */
function trimMaterial(trim: string): "wood" | "stone" | null {
  const family = wallStyleInfo(trim)?.family;
  if (family === "timber") return "wood";
  if (family === "theme" || family === undefined) return null;
  return "stone";
}

/**
 * (b) A thin beam borrowed from the trait pool (generic included, structure families only) in the trim's material, for
 * a theme with no beam of its own; undefined when none matches.
 */
function borrowBeam(a: { readonly theme: string }, ctx: ComposeCtx): FilledSlot | undefined {
  const pool = ctx.roles.pool(ctx.roles.paletteTheme(a.theme), beamShape());
  const want = trimMaterial(ctx.trim);
  const pieces = pool.pieces
    .filter((p) => {
      const made = pieceMaterial(`${p.roles.join(" ")} ${p.variant.name ?? ""} ${p.variant.wanted}`);
      return made !== null && (want === null || made === want);
    })
    .map((p) => fromPool(pool, p));
  return pieces.length > 0 ? { pieces, source: "borrowed" } : undefined;
}

/**
 * (c) Is a floor slab's edge concealed at this line: a floor line (an upper storey's floor stands on it, over the room
 * below) of a building whose floors stand whole (no ruin, no fallen floor or roof open to the sky)?
 */
export function slabConcealed(a: StoreyLineAnchor, ctx: Pick<ComposeCtx, "level">): boolean {
  if (a.line !== "floor" || a.storey < 1) return false;
  const st = (ctx.level.structures ?? []).find((s) => s.id === a.structure);
  return st !== undefined && st.condition !== "ruined" && st.ruin === undefined;
}

/**
 * A band's second course (readableTrims): the same module stepped BAND_STEP back and its own height and a shadow gap
 * lower, so a band in the wall's own material reads by its stepped profile.
 */
function doubled(
  run: Run & { readonly depth: number },
  module: Arrangement,
  p: { proud: number; depth: number; pitch: number; from: readonly ArrangePiece[]; seed: string },
  height: number,
): Arrangement {
  const proud = p.proud - BAND_STEP;
  // stepped back, its back must still stay within the wall (`seated`)
  if (proud <= 0.05 || seated(p.depth, proud, proud, run) === null) return [];
  return course(run, transform(module, { dz: -BAND_STEP, dy: -(height + BAND_GAP) }), {
    ...p,
    proud,
    seed: `${p.seed}|2`,
  });
}

export const plinths: Recipe<"face"> = {
  id: "plinths",
  doc: "a low course where a seen wall meets the ground and has no footing of its own (D3, D5), past windows, not doors",
  switch: "plinths",
  family: "courses",
  anchor: "face",
  tier: () => 2,
  mount: "wall",
  blocking: false,
  thinnable: false,
  when: (a) =>
    a.seen &&
    !a.natural &&
    !a.footed &&
    a.storey === 0 &&
    !isLowWallStyle(a.style) &&
    (a.structure === null || a.outside) &&
    a.height >= 1.2 &&
    a.length >= 1,
  slots: {
    footing: { roles: (_a, trim) => [{ role: partRole("footing", trim) }], fallback: "simplify" },
    course: { shape: () => beamShape(), fallback: "simplify" },
  },
  compose: (a, slots, ctx) => {
    const footing = choose(slots.footing, ctx, "plinth");
    const piece = footing ?? choose(slots.course, ctx, "plinth");
    if (!piece) return null;
    const from = footing ? slots.footing : slots.course;
    const m = piece.measures;
    const turned = m.runAxis === "z";
    const depth = turned ? piece.variant.geom.size.x : piece.variant.geom.size.z;
    // never through the wall to show inside: its back stays within the wall (`seated`) (readableTrims: a
    // taller, prouder step that changes the building's foot at a distance)
    const [proudRange, showRange] = readable(ctx)
      ? [PLINTH_PROUD_RELIEF, PLINTH_SHOW_RELIEF]
      : [PLINTH_PROUD, PLINTH_SHOW];
    const proud = seated(depth, within(ctx, "plinthProud", proudRange), proudRange[1] + 0.12, a);
    if (proud === null) return null;
    const show = Math.min(m.height, within(ctx, "plinthShow", showRange));
    const module = transform(single(piece, turned ? 90 : 0), { dz: proud - depth / 2, dy: show - m.height });
    // doors break it; windows sit on it
    const run: Run = { ...a, gaps: a.gaps.filter((g) => isPassage(g.kind)) };
    const along = turned ? piece.variant.geom.size.z : piece.variant.geom.size.x;
    const arr = course(run, module, {
      proud,
      depth,
      pitch: along * 0.97,
      from: kin(from, piece),
      seed: `${ctx.seed}|plinth`,
    });
    return arr.length > 0 ? arr : null;
  },
};
