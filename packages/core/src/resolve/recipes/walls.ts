/**
 * Wall recipes (plan Wave 1, W7 and W8): posts at the jambs of openings and at outer corners (D6), and the band course
 * along a building's floor lines (D3). Composed in the anchor's frame (resolve/anchors/frame.ts: x along the wall, z out
 * of it, y up from the storey's floor), from measures of the chosen piece, never from constants of one kit.
 *
 * Pieces, in the slot order of slots.ts:
 *   post   the theme's own slender pillar (feature.pillar, its own palette only) → the wall style's post
 *          (facade_post.<style> → wall_post.<style> → wall_post.wall, the piece its corners are built with) → the
 *          theme's own structural posts; at most storey high, no thicker than 0.62 (corners: 0.35, so a corner never
 *          doubles its wall's own corner filler). None: the recipe is left out.
 *   band   the theme's own thin structural beam (0.9-2.6 long, at most 0.5 high and deep); none: simplified to the
 *          storey's own floor slab showing its edge (floor.<material>, 1 x 1 tiles, 0.25 proud), which every theme has.
 */
import { mirror, repeat, single, stack, transform, type Arrangement, type ArrangePiece } from "../../arrange";
import { isGap, isPassage, isSecret } from "../../gen/openingKinds";
import { THEME_POST_ROLE, floorRole, partRole, postRole } from "../../palette/roles";
import type { TraitQuery } from "../../palette/traitPools";
import { hashUnit } from "../../util/hash";
import { blankStretches } from "../anchors";
import type { FilledSlot, Recipe, SlotRole } from "./types";

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
/** A band's projection when it is the floor slab's edge. */
const SLAB_PROUD = 0.25;
/** A band lies this much under the floor line, so its top never meets the floor's own. */
const UNDER_FLOOR = 0.02;
/** A post this much shorter than its storey still reads storey high; a taller one would poke past the wall. */
const POST_SLACK = 0.05;

/** The post roles of a wall style: the theme's own slender pillar, then the style's own post chain. */
const postRoles = (style: string): SlotRole[] => [
  { role: "feature.pillar", own: true },
  { role: partRole("facade_post", style) },
  { role: postRole(style) },
  { role: THEME_POST_ROLE },
];

/** A post up to `height` tall and at most `thick` across. */
const postShape = (height: number, thick: number): TraitQuery => ({
  trait: "post",
  where: { height: [1, height + POST_SLACK], length: [0.12, thick] },
  families: STRUCTURE,
});

/** One piece of a filled slot, the same for every place this recipe uses it at the anchor (a pair stays a pair). */
function choose(slot: FilledSlot | undefined, seed: string, what: string): ArrangePiece | undefined {
  const ps = slot?.pieces ?? [];
  return ps[Math.floor(hashUnit(seed, what) * ps.length)];
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

/** Its depth across the wall (local z at yaw 0) and how far its centre stands from the surface (`PROUD` at most). */
function proudOf(post: ArrangePiece): { across: number; along: number; z: number } {
  const across = post.variant.geom.size.z;
  const along = post.variant.geom.size.x;
  return { across, along, z: Math.min(across, PROUD) - across / 2 };
}

export const jambPosts: Recipe<"opening"> = {
  id: "jambPosts",
  doc: "a slender post at each jamb of a door or window on a seen wall, storey high (D6)",
  switch: "jambPosts",
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
    post: { roles: (a) => postRoles(a.style), shape: (a) => postShape(a.head, 0.62), fallback: "skip" },
  },
  compose: (a, slots, ctx) => {
    const post = choose(slots.post, ctx.seed, "post");
    if (!post) return null;
    const { along, z } = proudOf(post);
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
      roles: (a) => postRoles(a.style),
      shape: (a) => postShape(a.height, 0.35),
      fallback: "skip",
    },
  },
  compose: (a, slots, ctx) => {
    const post = choose(slots.post, ctx.seed, "post");
    if (!post) return null;
    const { across, z } = proudOf(post);
    // diagonally off the corner: as proud of the first face (local -x) as of the second (local +z)
    const o = Math.max(z, across / 2 - PROUD);
    return transform(postColumn(post, a.height), { dx: -o, dz: o });
  },
};

export const bandCourses: Recipe<"storeyLine"> = {
  id: "bandCourses",
  doc: "a band course along every floor line of a building's outside, and its foot when it has no footing (D3)",
  switch: "bandCourses",
  anchor: "storeyLine",
  tier: (a) => (a.line === "floor" ? 1 : 2),
  mount: "wall",
  blocking: false,
  thinnable: false,
  when: (a) => a.seen && a.length >= 1 && (a.line === "floor" || !a.footed),
  slots: {
    band: {
      shape: () => ({
        trait: "beam",
        where: { height: [0.06, 0.5], width: [0.06, 0.5], length: [0.9, 2.6] },
        families: STRUCTURE,
      }),
      fallback: "simplify",
    },
    slab: {
      roles: (a) => [{ role: floorRole(a.floor) }],
      shape: () => ({ trait: "slab", kind: "tile", where: { length: [0.99, 1.01], width: [0.99, 1.01] } }),
      fallback: "skip",
    },
  },
  compose: (a, slots, ctx) => {
    const beam = choose(slots.band, ctx.seed, "band");
    const slab = choose(slots.slab, ctx.seed, "slab");
    const out: Arrangement[] = [];
    const proud = beam ? Math.min(PROUD, beam.measures.width) : SLAB_PROUD;
    const stretches = blankStretches(a.length, a.gaps);
    stretches.forEach(([from, to], i) => {
      // past an outer corner the band runs on to meet the other face's; short of an inner one it stops at its surface
      const endOf = (end: 0 | 1, at: boolean): number =>
        !at ? 0 : a.ends[end] === "convex" ? proud : a.ends[end] === "concave" ? -proud : 0;
      const x0 = from - endOf(0, i === 0 && from === 0);
      const x1 = to + endOf(1, i === stretches.length - 1 && to === a.length);
      const len = x1 - x0;
      if (len <= 0.2) return;
      if (beam) {
        const m = beam.measures;
        const module = single(beam, m.runAxis === "z" ? 90 : 0);
        // centred in the floor's thickness under the line
        const y = -0.25 - m.height / 2;
        const row = repeat(transform(module, { dx: x0 + m.length / 2, dz: proud - m.width / 2, dy: y }), {
          axis: "x",
          pitch: m.length * 0.97,
          length: len,
        });
        out.push(row);
      } else if (slab) {
        const g = slab.variant.geom.size;
        const row = repeat(
          transform(single(slab), { dx: x0 + g.x / 2, dz: proud - g.z / 2, dy: -g.y - UNDER_FLOOR }),
          {
            axis: "x",
            length: len,
          },
        );
        out.push(row);
      }
    });
    const arr = out.flat();
    return arr.length > 0 ? arr : null;
  },
};
