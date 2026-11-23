/**
 * The vessel recipe: a boat, a river barge or a sailing ship from one recipe, general over length. Built along +x (bow
 * east), waterline at y = 0, then turned to face +z (objects/recipe.ts).
 *
 * Slots:
 * - mass (core): the hull, planked in strakes (thin boards laid in courses along the outline) that taper to the stem and
 *   narrow to the stern, the sides curved in 15° facets (C6, objects/outline.ts), the top following the sheer and the
 *   raised decks; at coarser detail fewer courses (every other one, then only the top one).
 * - supports (core): stem and stern posts (stacked poles), the keel.
 * - face (core): the cap rail on every top course (level along each deck), open rails on raised decks.
 * - top (core): masts (stacked poles; a 2 x 2 bundle low on a tall mast, F1), yards (crossed spars), the bowsprit.
 * - deck: the walkable decks (objects/deck.ts) and the bulkheads and steps at the raised decks' breaks.
 * - sails: set (cloth panels hung under the yards, two-faced) or furled (lashing along the yard), H12: the lowest
 *   course stays furled over the deck.
 * - rigging: ratlines stepping in from the rail to each mast's top, a stay between mastheads.
 * - stowage: hatch and coaming, a fighting top, cargo, a ship's boat (this recipe again, small), thwarts and oars,
 *   a deck shelter, a sweep, a pennant.
 * Proportions are ratios of the length (J1: a ship's rig 0.7 x its length; M12: vehicles about 1 : 0.3 : 0.15).
 */
import { run } from "../arrange/along";
import { mirror, twin } from "../arrange/copies";
import { vary } from "../arrange/modifiers";
import { polyline, type Path } from "../arrange/path";
import { lengthwise, single, type Arrangement, type Placed, type XZ } from "../arrange/piece";
import { rest } from "../arrange/support";
import { transform } from "../arrange/transform";
import { hashUnitMixed } from "../util/hash";
import { maxOf, minOf, pushAll } from "../util/lists";
import { floorOver } from "./deck";
import type { ObjectKit } from "./kit";
import {
  bodySide,
  clipPolygonX,
  clipX,
  closedOutline,
  halfWidthAt,
  insetConvex,
  intervals,
  type BodyPlan,
} from "./outline";
import {
  at,
  buildObject,
  part,
  piecesOf,
  turnDraft,
  type Condition,
  type Draft,
  type ObjectParams,
  type ObjectRecipe,
  type Part,
  type Space,
  type Surface,
} from "./recipe";

export type VesselKind = "boat" | "barge" | "ship";
export type SailState = "set" | "furled" | "none";

export interface VesselParams extends ObjectParams {
  /** Default by length: under 9 a boat, under 20 a barge, else a ship. */
  readonly kind?: VesselKind;
  /** Beam (full width), default by kind. */
  readonly beam?: number;
  /** Masts, default by kind and length. */
  readonly masts?: number;
  readonly sails?: SailState;
  /** Raised fore and aft decks (default: ships). */
  readonly raisedDecks?: boolean;
  /** How far the hull reaches below the waterline (default 0.3: into the floor it stands on). */
  readonly draft?: number;
}

interface Mast {
  readonly x: number;
  readonly height: number;
  /** Heights over the mast foot and lengths of its yards, lowest first. */
  readonly yards: readonly { readonly y: number; readonly length: number }[];
}

interface Raised {
  /** The break: where the raised deck starts (fore: from here forward; aft: from here back). */
  readonly x: number;
  readonly y: number;
}

/** The numbers a vessel is built from. */
interface VesselDesign {
  readonly kind: VesselKind;
  readonly plan: BodyPlan;
  readonly draft: number;
  /** Main deck top. */
  readonly deck: number;
  /** Bulwark: from a deck to the top of the cap rail. */
  readonly bulwark: number;
  /** Extra height of the sheer at the very ends (a boat's sweep). */
  readonly sheerRise: number;
  /** How far the stem leans forward per tile of height. */
  readonly rake: number;
  readonly fore: Raised | null;
  readonly aft: Raised | null;
  readonly masts: readonly Mast[];
  readonly bowsprit: number;
  readonly sails: SailState;
  readonly condition: Condition;
  readonly seed: string;
}

const KIND_OF = (length: number): VesselKind => (length < 9 ? "boat" : length < 20 ? "barge" : "ship");

/** The design of a vessel from its parameters (all ratios of the length). */
export function vesselDesign(p: VesselParams): VesselDesign {
  const L = Math.max(4, p.size);
  const kind = p.kind ?? KIND_OF(L);
  const seed = String(p.seed);
  const condition = p.condition ?? "new";
  const draft = p.draft ?? 0.3;
  if (kind === "boat") {
    const hb = (p.beam ?? 0.36 * L) / 2;
    const masts = p.masts ?? (L >= 5 ? 1 : 0);
    const H = 0.75 * L;
    return {
      kind,
      plan: {
        length: L,
        halfBeam: hb,
        sternHalf: 0.4 * hb,
        bowTaper: 0.36 * L,
        sternTaper: 0.22 * L,
        bowFacets: 3,
      },
      draft,
      deck: 0.3,
      bulwark: 0.4,
      sheerRise: 0.3,
      rake: 0.2,
      fore: null,
      aft: null,
      masts: masts > 0 ? [{ x: 0.12 * L, height: H, yards: [{ y: 0.85 * H, length: 1.3 * 2 * hb }] }] : [],
      bowsprit: 0,
      sails: p.sails ?? "furled",
      condition,
      seed,
    };
  }
  if (kind === "barge") {
    const hb = (p.beam ?? 0.34 * L) / 2;
    const masts = p.masts ?? 1;
    const H = 0.6 * L;
    return {
      kind,
      plan: {
        length: L,
        halfBeam: hb,
        sternHalf: 0.85 * hb,
        bowTaper: 0.14 * L,
        sternTaper: 0.06 * L,
        bowFacets: 4,
      },
      draft,
      deck: 0.65,
      bulwark: 0.35,
      sheerRise: 0.2,
      rake: 0.1,
      fore: null,
      aft: null,
      masts: masts > 0 ? [{ x: 0.12 * L, height: H, yards: [{ y: 0.82 * H, length: 1.15 * 2 * hb }] }] : [],
      bowsprit: 0,
      sails: p.sails ?? "furled",
      condition,
      seed,
    };
  }
  const hb = (p.beam ?? 0.27 * L) / 2;
  const B = 2 * hb;
  const deck = 1.25;
  const raised = p.raisedDecks ?? true;
  const nMasts = p.masts ?? (L >= 22 ? 2 : 1);
  const yardsOf = (H: number): Mast["yards"] => [
    { y: 0.36 * H, length: 1.55 * B },
    { y: 0.6 * H, length: 1.2 * B },
    { y: 0.82 * H, length: 0.85 * B },
  ];
  const masts: Mast[] =
    nMasts >= 2
      ? [
          { x: Math.round(-0.06 * L), height: 0.74 * L, yards: yardsOf(0.74 * L) },
          { x: Math.round(0.22 * L), height: 0.66 * L, yards: yardsOf(0.66 * L) },
        ]
      : [{ x: Math.round(0.05 * L), height: 0.72 * L, yards: yardsOf(0.72 * L) }];
  return {
    kind,
    plan: {
      length: L,
      halfBeam: hb,
      sternHalf: 0.62 * hb,
      bowTaper: 0.3 * L,
      sternTaper: 0.14 * L,
      bowFacets: 2,
    },
    draft,
    deck,
    bulwark: 0.6,
    sheerRise: 0.15,
    rake: 0.12,
    fore: raised ? { x: Math.round(0.3 * L), y: deck + 1 } : null,
    aft: raised ? { x: Math.round(-0.3 * L), y: deck + 1 } : null,
    masts,
    bowsprit: 0.25 * L,
    sails: p.sails ?? "set",
    condition,
    seed,
  };
}

/** The deck top at x (raised decks over their breaks). */
function deckAt(d: VesselDesign, x: number): number {
  if (d.fore && x >= d.fore.x) return d.fore.y;
  if (d.aft && x <= d.aft.x) return d.aft.y;
  return d.deck;
}

/** The top of the hull (the cap rail's top) at x: deck + bulwark + the sheer's rise toward the ends. */
function topAt(d: VesselDesign, x: number): number {
  const half = d.plan.length / 2;
  const end = Math.min(1, Math.abs(x) / half);
  return deckAt(d, x) + d.bulwark + d.sheerRise * end ** 3;
}

/** The left side of the hull at height y: the stem leans forward with height (the stern stays put). */
function sideAt(d: VesselDesign, y: number): XZ[] {
  const lean = d.rake * (y - d.deck);
  const plan: BodyPlan = {
    ...d.plan,
    length: d.plan.length + lean,
    bowTaper: Math.max(0.3 * d.plan.bowTaper, d.plan.bowTaper + lean),
  };
  return bodySide(plan).map(([x, z]) => [x + lean / 2, z]);
}

/** The stem's x at height y. */
const stemAt = (d: VesselDesign, y: number): number => d.plan.length / 2 + d.rake * (y - d.deck);

/** The plank courses' bottoms, from below the waterline to the highest top. */
function courses(d: VesselDesign, pitch: number, h: number): number[] {
  const half = d.plan.length / 2;
  let highest = 0;
  for (let x = -half; x <= half; x += 0.25) highest = Math.max(highest, topAt(d, x));
  const out: number[] = [];
  for (let y = -d.draft; y + h <= highest + 0.02; y += pitch) out.push(y);
  return out;
}

/** A course of modules along a polyline (overlap varied per course so the butt joints never line up). */
function courseRun(module: Arrangement, pts: readonly XZ[], y: number, seed: string, k: number): Arrangement {
  if (pts.length < 2) return [];
  const overlap = 0.03 + 0.14 * hashUnitMixed(seed, "course", k);
  return transform(run(module, { path: polyline(pts), overlap }), { dy: y });
}

/** The hull's planking (mass), its cap rail and open rails (face). */
function hullParts(d: VesselDesign, kit: ObjectKit, lod: number): Part[] {
  const plank = kit.piece("plank");
  if (!plank) return [];
  const module = lengthwise(plank);
  const h = plank.variant.geom.size.y;
  const t = plank.measures.width;
  // courses overlap by more than `unflicker` may lift a plank, so a lifted plank still stands on the one under it
  const pitch = h - 0.037;
  const half = d.plan.length / 2;
  const all = courses(d, pitch, h);
  const hull: Placed[] = [];
  const cap: Placed[] = [];
  const top = all.length - 1;
  all.forEach((y, k) => {
    const exists = (x: number): boolean => y + h <= topAt(d, x) + 0.02;
    const capHere = (x: number): boolean => exists(x) && !(y + pitch + h <= topAt(d, x) + 0.02);
    // coarser detail: every other course (1), or only the sheer strake under the cap rail (0)
    const capped = intervals(capHere, -half - 1, half + 2);
    const keepCourse = lod >= 2 || (lod === 1 && (k % 2 === 0 || k === top)) || capped.length > 0;
    const side = sideAt(d, y);
    for (const [a, b] of lod === 0 ? capped : intervals(exists, -half - 1, half + 2)) {
      const pts = clipX(side, a, b);
      if (keepCourse) pushAll(hull, mirror(courseRun(module, pts, y, d.seed, k), { axis: "z", at: 0 }));
    }
    for (const [a, b] of capped) {
      const pts = clipX(side, a, b);
      pushAll(cap, mirror(courseRun(module, pts, y + h - 0.01, d.seed, k + 1000), { axis: "z", at: 0 }));
    }
    // the transom: a straight course across the square stern
    const sh = (side[0] ?? [0, 0])[1];
    if (sh >= 0.2 && exists(-half)) {
      const across: XZ[] = [
        [-half, -sh - t / 2],
        [-half, sh + t / 2],
      ];
      if (keepCourse && (lod > 0 || capHere(-half)))
        pushAll(hull, courseRun(module, across, y, d.seed, k + 500));
      if (capHere(-half)) pushAll(cap, courseRun(module, across, y + h - 0.01, d.seed, k + 1500));
    }
  });
  const worn = d.condition === "derelict" ? { empty: 0.06, maxEmptyRun: 1 } : {};
  const parts = [
    part(
      "hull",
      "mass",
      d.condition === "new" ? hull : vary(hull, { seed: `${d.seed}:hull`, along: 0.03, ...worn }),
    ),
    part("cap rail", "face", cap),
  ];
  if (lod >= 2)
    parts.push(
      part("wale", "trim", wale(d, kit, module, h), { rung: 100, kind: "detail", hold: "fastened" }),
    );
  parts.push(
    part("raised rails", "face", raisedRails(d, kit), { rung: 50, kind: "silhouette", hold: "fastened" }),
  );
  return parts;
}

/**
 * A band of two strakes against the outside of the hull below the deck line, round the whole outline (D3): a plank's
 * thickness out, so the band touches the planking without sharing its faces.
 */
function wale(d: VesselDesign, kit: ObjectKit, module: Arrangement, h: number): Arrangement {
  const out: Placed[] = [];
  const t = kit.piece("plank")?.measures.width ?? 0.13;
  for (const y of [d.deck - 0.45, d.deck - 0.45 + h - 0.007]) {
    const ring = insetConvex(closedOutline(sideAt(d, y)), -(t + 0.005));
    pushAll(out, transform(run(module, { path: { points: ring, closed: true }, overlap: 0.05 }), { dy: y }));
  }
  return kit.piece("plank") ? out : [];
}

/** Open rails along the raised decks' sides: stanchions sunk into the hull, a rail plank on their tops. */
function raisedRails(d: VesselDesign, kit: ObjectKit): Arrangement {
  const post = kit.piece("post");
  const plank = kit.piece("plank");
  if (!post || !plank) return [];
  const out: Placed[] = [];
  const half = d.plan.length / 2;
  for (const r of [d.fore, d.aft]) {
    if (!r) continue;
    const yTop = topAt(d, r.x) + 0.55;
    const side = sideAt(d, yTop);
    const [a, b] = r === d.fore ? [r.x, half + 2] : [-half - 1, r.x];
    const pts = clipX(side, a, b);
    if (pts.length < 2) continue;
    const path: Path = polyline(pts);
    const ph = post.variant.geom.size.y;
    const rail = transform(run(lengthwise(plank), { path, overlap: 0.05 }), { dy: yTop - 0.01 });
    // a stanchion under every rail plank's middle
    const stanchions = rail.map((q) => at(post, q.x, yTop - ph, q.z));
    pushAll(out, mirror([...stanchions, ...rail], { axis: "z", at: 0 }));
  }
  return out;
}

/** Stem and stern posts (stacked poles leaning with the stem, a short post on a small hull), and the keel. */
function supportParts(d: VesselDesign, kit: ObjectKit): Part[] {
  const parts: Part[] = [];
  const half = d.plan.length / 2;
  const stack = (xAt: (y: number) => number, from: number, to: number): Placed[] => {
    const pole = kit.piece("pole");
    const post = kit.piece("post");
    // the short post when one pole would stand far past the top
    const piece = post && pole && to - from < pole.variant.geom.size.y - 0.5 ? post : (pole ?? post);
    if (!piece) return [];
    const len = piece.variant.geom.size.y;
    const out: Placed[] = [];
    for (let y = from; y < to - 0.05; y += len - 0.3) out.push(at(piece, xAt(y + len / 2), y, 0));
    // the last section ends at `to`, never lower than the foot
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last && prev && last.y + len > to + 0.3) {
      const y = Math.max(from, to - len);
      if (y > prev.y + 0.3) out[out.length - 1] = { ...last, y };
      else out.pop();
    }
    return out;
  };
  const stemTop = topAt(d, half) + 0.45;
  parts.push(
    part(
      "stem",
      "supports",
      stack((y) => stemAt(d, y) + 0.05, -d.draft, stemTop),
      { hold: "fastened" },
    ),
  );
  const sternTop = topAt(d, -half) + 0.35;
  parts.push(
    part(
      "sternpost",
      "supports",
      stack(() => -half - 0.1, -d.draft, sternTop),
      { hold: "fastened" },
    ),
  );
  const timber = kit.piece("timber");
  if (timber) {
    // the keel along the bottom of the hull, its foot level with the lowest strake's
    const keel = transform(
      run(lengthwise(timber), {
        path: polyline([
          [-half + 0.3, 0],
          [half - 0.4, 0],
        ]),
        overlap: 0.05,
      }),
      { dy: -d.draft },
    );
    parts.push(part("keel", "frame", keel, { rung: 200, kind: "interior" }));
  }
  return parts;
}

/** The inner outline at deck height (inside the planking), cut to an x range. */
function deckOutline(d: VesselDesign, y: number, t: number, a: number, b: number): XZ[] {
  return clipPolygonX(insetConvex(closedOutline(sideAt(d, y)), t / 2 + 0.005), a, b);
}

/** The decks as surfaces, and the hold under the main deck. */
function decksOf(d: VesselDesign, t: number): { surfaces: Surface[]; spaces: Space[] } {
  const half = d.plan.length / 2;
  const fx = d.fore?.x ?? half + 2;
  const ax = d.aft?.x ?? -half - 2;
  const surfaces: Surface[] = [{ id: "deck", y: d.deck, polygon: deckOutline(d, d.deck, t, ax, fx) }];
  if (d.fore)
    surfaces.push({
      id: "forecastle",
      y: d.fore.y,
      polygon: deckOutline(d, d.fore.y, t, d.fore.x, half + 2),
    });
  if (d.aft)
    surfaces.push({ id: "quarterdeck", y: d.aft.y, polygon: deckOutline(d, d.aft.y, t, -half - 2, d.aft.x) });
  const spaces: Space[] =
    d.kind === "ship"
      ? [{ id: "hold", floorY: d.deck - 2.5, ceilingY: d.deck - 0.5, polygon: deckOutline(d, 0, t, ax, fx) }]
      : [];
  return { surfaces: surfaces.filter((s) => s.polygon.length >= 3), spaces };
}

/** The decks' tiles, the bulkheads across the breaks, and steps up to the raised decks. */
function deckParts(d: VesselDesign, kit: ObjectKit, surfaces: readonly Surface[]): Part[] {
  const tiles = surfaces.flatMap((s) => floorOver(s.polygon, s.y, kit, `${d.seed}:${s.id}`));
  const parts = [part("decks", "deck", tiles, { rung: 50, kind: "interior" })];
  const plank = kit.piece("plank");
  const step = kit.piece("deckSmall");
  const breaks: Placed[] = [];
  for (const r of [d.fore, d.aft]) {
    if (!r || !plank) continue;
    const w = halfWidthAt(deckOutline(d, d.deck, plank.measures.width, -1e3, 1e3), r.x);
    const h = plank.variant.geom.size.y;
    const across: XZ[] = [
      [r.x, -w],
      [r.x, w],
    ];
    for (let y = d.deck, k = 0; y + h <= r.y + 0.01; y += h - 0.007, k++)
      pushAll(breaks, courseRun(lengthwise(plank), across, y, d.seed, 2000 + k));
    if (step) {
      // two steps wide, half a tile high, on the main deck side of the break, off the centreline (fore to port,
      // aft to starboard)
      const dir = r === d.fore ? -1 : 1;
      const side = r === d.fore ? 1 : -1;
      for (const z of [0.5, 1.5]) breaks.push(at(step, r.x + dir * 0.5, d.deck, side * z));
    }
  }
  if (breaks.length > 0) parts.push(part("breaks", "deck", breaks, { rung: 50, kind: "silhouette" }));
  return parts;
}

/** A mast: poles stacked (a 2 x 2 bundle for its lower 40 % when it is tall), a top, its yards. */
function mastParts(d: VesselDesign, kit: ObjectKit, m: Mast, i: number): Part[] {
  const pole = kit.piece("pole");
  const plank = kit.piece("plank");
  if (!pole) return [];
  const foot = deckAt(d, m.x);
  const len = pole.variant.geom.size.y;
  const w = pole.measures.length;
  const broken = d.condition === "derelict";
  const height = broken ? 0.5 * m.height : m.height;
  const lowTop = m.height >= 8 ? 0.4 * m.height : 0;
  const mast: Placed[] = [];
  const section = (x: number, z: number, y: number): Placed => at(pole, x, y, z);
  let y = 0;
  const pitch = 1.15 * w;
  for (; y < lowTop - 0.3; y += len - 0.35)
    for (const [dx, dz] of [
      [-0.5, -0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
      [0.5, 0.5],
    ] as const)
      mast.push(section(m.x + dx * pitch, dz * pitch, foot + y));
  // the single upper mast starts inside the bundle, standing on its fore pole (a doubled joint, F1)
  const [ux, uz] = y > 0 ? [m.x + pitch / 2, pitch / 2] : [m.x, 0];
  if (y > 0) y -= 0.6;
  for (; y < height - 0.3; y += len - 0.35) mast.push(section(ux, uz, foot + y));
  const name = `mast ${i + 1}`;
  const parts: Part[] = [part(name, "top", mast)];
  // a pennant flying aft from the head of the tallest mast (the top's accent)
  const cloth = kit.piece("cloth");
  const head = mast[mast.length - 1];
  const tallest = d.masts.findIndex((q) => q.height === maxOf(d.masts.map((r) => r.height))) === i;
  if (cloth && head && tallest && !broken) {
    const pennant = transform(lengthwise(cloth), {
      dx: head.x - cloth.measures.length / 2 - w / 2,
      dz: head.z,
      dy: head.y + len - cloth.variant.geom.size.y - 0.3,
    });
    parts.push(part("pennant", "rigging", pennant, { rung: 200, kind: "detail", hold: "fastened" }));
  }
  const hatch = kit.piece("hatch");
  if (hatch && lowTop > 0)
    parts.push(
      part(`${name} top`, "stowage", [at(hatch, ux, foot + lowTop, uz)], { rung: 100, kind: "detail" }),
    );
  if (plank) {
    const yards = (broken ? m.yards.slice(0, 1) : m.yards).map((yd) => {
      const path = polyline([
        [m.x, -yd.length / 2],
        [m.x, yd.length / 2],
      ]);
      const spar = run(lengthwise(plank), { path, overlap: 0.1 });
      const ph = plank.variant.geom.size.y;
      return [
        ...transform(spar, { dy: foot + yd.y }),
        ...transform(spar, { dy: foot + yd.y + ph - 0.02, dx: 0.12 }),
      ];
    });
    parts.push(part(`${name} yards`, "top", yards.flat(), { hold: "fastened" }));
    pushAll(parts, sailParts(d, kit, m, foot, broken ? [] : m.yards, name));
  }
  return parts;
}

/** Sails under the yards: the lowest furled over the deck (H12), the upper set when the vessel sets sail. */
function sailParts(
  d: VesselDesign,
  kit: ObjectKit,
  m: Mast,
  foot: number,
  yards: Mast["yards"],
  name: string,
): Part[] {
  if (d.sails === "none" || yards.length === 0) return [];
  const cloth = kit.piece("cloth");
  const rope = kit.piece("rope");
  const set: Placed[] = [];
  const furled: Placed[] = [];
  yards.forEach((yd, i) => {
    const below = i === 0 ? topAt(d, m.x) + 1.2 - foot : (yards[i - 1]?.y ?? 0) + 0.35;
    const gap = yd.y - below;
    const furl = d.sails === "furled" || (i === 0 && yards.length > 1) || !cloth || gap < 1.2;
    if (furl) {
      if (!rope) return;
      const path = polyline([
        [m.x + 0.12, -0.42 * yd.length],
        [m.x + 0.12, 0.42 * yd.length],
      ]);
      const rh = rope.variant.geom.size.y;
      const lash = run(lengthwise(rope), { path, overlap: 0.08 });
      pushAll(
        furled,
        transform(lash, { dy: foot + yd.y - rh + 0.02 }),
        transform(lash, { dy: foot + yd.y - 2 * rh + 0.04, dx: 0.1 }),
      );
      return;
    }
    const ch = cloth.variant.geom.size.y;
    const cw = cloth.measures.length;
    const rows = Math.max(1, Math.min(2, Math.floor((gap - 0.1) / (ch - 0.05))));
    const across = Math.max(1, Math.floor((0.88 * yd.length) / (0.95 * cw)));
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < across; c++) {
        const z = (c - (across - 1) / 2) * 0.95 * cw;
        // along z: the panel's long side across the ship; just fore of the mast; hung from the yard
        const panel = transform(lengthwise(cloth), {
          turn: 90,
          dx: m.x + 0.3,
          dz: z,
          dy: foot + yd.y - (r + 1) * (ch - 0.05),
        });
        pushAll(set, twin(panel, { turn: 180 }));
      }
  });
  const parts: Part[] = [];
  const worn = d.condition === "worn" ? { empty: 0.2, maxEmptyRun: 1 } : {};
  if (set.length > 0)
    parts.push(
      part(`${name} sails`, "sails", vary(set, { seed: `${d.seed}:${name}:sails`, ...worn }), {
        rung: 100,
        kind: "detail",
        hold: "fastened",
      }),
    );
  if (furled.length > 0)
    parts.push(
      part(`${name} furled sails`, "sails", furled, { rung: 100, kind: "detail", hold: "fastened" }),
    );
  return parts;
}

/** Ratlines from the rail in to each mast's top, both sides; a stay between mastheads. */
function riggingParts(d: VesselDesign, kit: ObjectKit): Part[] {
  const rope = kit.piece("rope");
  if (!rope || d.masts.length === 0) return [];
  const out: Placed[] = [];
  const rh = rope.variant.geom.size.y;
  for (const m of d.masts) {
    const foot = deckAt(d, m.x);
    const from = topAt(d, m.x) + 0.1;
    const to = foot + (m.height >= 8 ? 0.4 * m.height : 0.6 * m.height);
    const w0 = halfWidthAt(closedOutline(sideAt(d, from)), m.x);
    // the top rung against the mast's side (a 2 x 2 bundle on a tall mast)
    const w = kit.piece("pole")?.measures.length ?? 0.3;
    const w1 = (m.height >= 8 ? (1.15 * w) / 2 : 0) + w / 2 + rope.measures.width / 2;
    const n = Math.max(2, Math.floor((to - from) / 0.55));
    for (let k = 0; k < n; k++) {
      const f = k / (n - 1);
      const z = w0 + (w1 - w0) * f;
      const y = from + (to - from) * f;
      const rung = transform(lengthwise(rope), { dx: m.x, dz: z, dy: y - rh / 2 });
      pushAll(out, mirror(rung, { axis: "z", at: 0 }));
    }
  }
  if (d.masts.length >= 2) {
    const [a, b] = d.masts;
    if (a && b) {
      const y = Math.min(deckAt(d, a.x) + a.height, deckAt(d, b.x) + b.height) - 0.6;
      pushAll(
        out,
        transform(
          run(lengthwise(rope), {
            path: polyline([
              [a.x, 0],
              [b.x, 0],
            ]),
            overlap: 0.05,
          }),
          { dy: y },
        ),
      );
    }
  }
  const worn = d.condition === "derelict" ? { empty: 0.45, maxEmptyRun: 2 } : {};
  return [
    part("rigging", "rigging", vary(out, { seed: `${d.seed}:rigging`, ...worn }), {
      rung: 100,
      kind: "detail",
      hold: "line",
    }),
  ];
}

/** The bowsprit: heavy timbers stepping up out over the stem, a lighter boom beyond. */
function bowspritParts(d: VesselDesign, kit: ObjectKit): Part[] {
  if (d.bowsprit <= 0) return [];
  const timber = kit.piece("timber");
  const plank = kit.piece("plank");
  if (!timber) return [];
  const half = d.plan.length / 2;
  const y0 = topAt(d, half) - 0.35;
  const x0 = stemAt(d, y0) - 1.2;
  const heavy = run(lengthwise(timber), {
    path: polyline([
      [x0, 0],
      [x0 + 0.65 * d.bowsprit + 1.2, 0],
    ]),
    overlap: 0.1,
  });
  const boomStart = x0 + 0.65 * d.bowsprit + 0.6;
  const boom = plank
    ? run(lengthwise(plank), {
        path: polyline([
          [boomStart, 0],
          [x0 + d.bowsprit + 1.2, 0],
        ]),
        overlap: 0.1,
      })
    : [];
  // each piece a little higher than the one behind it: the spar rises (pieces cannot tilt)
  const rise = (a: Arrangement, base: number): Placed[] =>
    a.map((q) => ({ ...q, y: base + 0.1 * (q.x - x0) }));
  return [part("bowsprit", "top", [...rise(heavy, y0), ...rise(boom, y0 + 0.3)], { hold: "fastened" })];
}

/** What a vessel carries: a hatch with its coaming, cargo, a boat, thwarts and oars, a shelter, a sweep, a pennant. */
function stowageParts(d: VesselDesign, kit: ObjectKit, decks: readonly Surface[]): Part[] {
  const parts: Part[] = [];
  const half = d.plan.length / 2;
  const L = d.plan.length;
  const onDeck = (a: Arrangement, x: number, z: number): Arrangement =>
    transform(a, { dx: x, dz: z, dy: deckAt(d, x) });
  const plank = kit.piece("plank");
  const hatch = kit.piece("hatch");
  const tilt = { seed: `${d.seed}:cargo`, yaw: 15, along: 0.08, across: 0.08 };
  if (d.kind === "ship") {
    const [main, fore] = d.masts;
    if (hatch && plank && main && fore) {
      const hx = Math.round((main.x + fore.x) / 2);
      const cover = [-0.5, 0.5].flatMap((dz) => onDeck(single(hatch), hx, dz));
      const coaming = transform(
        run(lengthwise(plank), {
          path: polyline(
            [
              [hx - 1.15, -1.15],
              [hx + 1.15, -1.15],
              [hx + 1.15, 1.15],
              [hx - 1.15, 1.15],
            ],
            true,
          ),
          overlap: 0.05,
        }),
        { dy: d.deck },
      );
      parts.push(part("hatch", "stowage", [...coaming, ...cover], { rung: 100, kind: "detail" }));
    }
    const cargo: Placed[] = [];
    const barrel = kit.piece("barrel");
    const crate = kit.piece("crate");
    if (main && barrel)
      for (const [dx, dz] of [
        [1.1, -1.6],
        [1.6, -1.1],
        [1.1, 1.7],
      ] as const)
        pushAll(cargo, onDeck(single(barrel), main.x + dx, dz));
    if (fore && crate) {
      const stack = rest(single(crate), single(crate));
      pushAll(cargo, onDeck(stack, fore.x - 1.6, 1.5), onDeck(single(crate), fore.x - 1.6, -1.6));
    }
    if (cargo.length > 0)
      parts.push(part("deck cargo", "stowage", vary(cargo, tilt), { rung: 200, kind: "detail" }));
    if (main && d.aft) {
      const boatLength = Math.min(6, Math.max(4.5, 0.17 * L));
      const room = main.x - 1 - (d.aft.x + 0.5);
      if (room >= boatLength) {
        // a stowed boat at a small budget: its bottom boards (interior mass) are the first thing cut
        const boat = buildObject(
          vessel,
          {
            size: boatLength,
            kind: "boat",
            masts: 0,
            seed: `${d.seed}:boat`,
            budget: 80,
            condition: d.condition,
          },
          kit,
        );
        // the boat's own frame faces +z; turn it back along the ship and set its keel course on the deck
        const lowest = minOf(piecesOf(boat).map((q) => q.y));
        const bx = (main.x - 1 + d.aft.x + 0.5) / 2;
        // two parts, as its own parts are held: what rests (hull, thwarts) and what is fastened (the oars)
        const fastened = boat.parts.filter((p) => p.hold === "fastened").flatMap((p) => p.pieces);
        const resting = boat.parts.filter((p) => p.hold !== "fastened").flatMap((p) => p.pieces);
        const set = (a: Arrangement) => transform(a, { turn: 90, dx: bx, dy: d.deck - lowest });
        parts.push(part("ship's boat", "stowage", set(resting), { rung: 200, kind: "detail" }));
        if (fastened.length > 0)
          parts.push(
            part("ship's boat oars", "stowage", set(fastened), {
              rung: 200,
              kind: "detail",
              hold: "fastened",
            }),
          );
      }
    }
  }
  if (d.kind === "barge") {
    const crate = kit.piece("crate");
    const sack = kit.piece("sack");
    const barrel = kit.piece("barrel");
    const cargo: Placed[] = [];
    const span = 0.5 * L;
    for (let x = -0.3 * L; x < -0.3 * L + span * 0.55; x += 1.2)
      for (const z of [-0.65, 0.65]) {
        const i = Math.round(x * 10 + z * 3);
        if (crate && hashUnitMixed(d.seed, "crate", i) < 0.75) {
          const stack =
            hashUnitMixed(d.seed, "stack", i) < 0.45 ? rest(single(crate), single(crate)) : single(crate);
          pushAll(cargo, onDeck(stack, x, z));
        }
      }
    if (sack)
      for (let k = 0; k < 4; k++)
        pushAll(cargo, onDeck(single(sack), 0.05 * L + 0.45 * k, -0.9 + 0.3 * (k % 2)));
    if (barrel) for (let k = 0; k < 3; k++) pushAll(cargo, onDeck(single(barrel), 0.05 * L + 0.7 * k, 1.0));
    if (cargo.length > 0)
      parts.push(part("cargo", "stowage", vary(cargo, tilt), { rung: 100, kind: "detail" }));
    const shelter = kit.piece("shelter");
    if (shelter)
      parts.push(
        part("shelter", "stowage", onDeck(single(shelter, 90), -half + 2.2, 0), {
          rung: 200,
          kind: "detail",
        }),
      );
    if (plank) {
      const y = topAt(d, -half) - 0.02;
      const sweep = run(lengthwise(plank), {
        path: polyline([
          [-half + 1.2, 0.35],
          [-half - 2, 0.35],
        ]),
        overlap: 0.05,
      });
      parts.push(
        part("sweep", "stowage", transform(sweep, { dy: y }), {
          rung: 100,
          kind: "detail",
          hold: "fastened",
        }),
      );
    }
  }
  if (d.kind === "boat") {
    const bench = kit.piece("bench");
    const deck = decks[0];
    if (bench && deck) {
      const seats = [-0.12 * L, 0.12 * L].flatMap((x) => {
        const w = 2 * halfWidthAt(deck.polygon, x);
        return w >= bench.measures.length + 0.05
          ? onDeck(single(bench, bench.measures.runAxis === "z" ? 0 : 90), x, 0)
          : [];
      });
      if (seats.length > 0) parts.push(part("thwarts", "stowage", seats, { rung: 50, kind: "detail" }));
    }
    if (plank) {
      const oars: Placed[] = [];
      for (const x of [-0.12 * L, 0.12 * L]) {
        const y = topAt(d, x);
        const z = halfWidthAt(closedOutline(sideAt(d, y - 0.3)), x);
        // across the gunwale, half outboard, raked aft by one step
        pushAll(
          oars,
          mirror(transform(lengthwise(plank), { turn: -75, dx: x, dz: z, dy: y - 0.03 }), {
            axis: "z",
            at: 0,
          }),
        );
      }
      parts.push(part("oars", "stowage", oars, { rung: 100, kind: "detail", hold: "fastened" }));
    }
  }
  return parts;
}

/**
 * The parts listed first, in this order (objects/place.ts packs whole parts into instances in part order): the hull and
 * the decks it carries share the first instance; the keel, standing on the ground, comes last of them so the packing
 * can open a second instance with it.
 */
const PACK_FIRST = [
  "cap rail",
  "hull",
  "stem",
  "sternpost",
  "decks",
  "raised rails",
  "breaks",
  "wale",
  "keel",
];

export const vessel: ObjectRecipe<VesselParams> = {
  id: "vessel",
  doc: "a boat, river barge or sailing ship: planked hull on 15° facets, decks, masts, yards, sails, rigging",
  slots: {
    mass: { doc: "the planked hull" },
    supports: { doc: "stem post, stern post" },
    face: { doc: "cap rail, open rails on raised decks" },
    trim: { doc: "the wale" },
    top: { doc: "masts, yards, bowsprit" },
    frame: { doc: "the keel" },
    deck: { doc: "walkable decks, the breaks' bulkheads and steps" },
    sails: { doc: "set or furled sails" },
    rigging: { doc: "ratlines, stays, a pennant" },
    stowage: { doc: "hatch, cargo, ship's boat, thwarts, oars, shelter, sweep, fighting tops" },
  },
  budget: 2000,
  lods: 3,
  build(params, kit, lod): Draft {
    const d = vesselDesign(params);
    const plank = kit.piece("plank");
    const t = plank?.measures.width ?? 0.13;
    const { surfaces, spaces } = decksOf(d, t);
    const parts: Part[] = [
      ...hullParts(d, kit, lod),
      ...supportParts(d, kit),
      ...deckParts(d, kit, surfaces),
      ...d.masts.flatMap((m, i) => mastParts(d, kit, m, i)),
      ...bowspritParts(d, kit),
      ...riggingParts(d, kit),
      ...stowageParts(d, kit, surfaces),
    ]
      .filter((p) => p.pieces.length > 0)
      .map((p, i) => ({ p, i, o: PACK_FIRST.indexOf(p.name) }))
      .sort((a, b) => (a.o < 0 ? 99 : a.o) - (b.o < 0 ? 99 : b.o) || a.i - b.i)
      .map(({ p }) => p);
    const draft: Draft = {
      parts,
      footprint: closedOutline(sideAt(d, d.deck)),
      clearance: 1,
      surfaces,
      spaces,
    };
    return turnDraft(draft, -90);
  },
};
