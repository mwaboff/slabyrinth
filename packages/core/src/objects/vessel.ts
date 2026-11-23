/**
 * The vessel recipe: a boat, a river barge or a sailing ship from one recipe, general over length. Built along +x (bow
 * east), waterline at y = 0, then turned to face +z (objects/recipe.ts).
 *
 * Rules (each a parameter or a measured rule, never a per-vessel tweak):
 * - Hull side as a few bands, not many sticks: a heavy lower band (the `timber` stand-in when the vessel is wide enough
 *   that its wall should be thick: wall thickness about 6 % of the beam), plank courses above it to the deck line, a
 *   rubbing strake (wale) outside at the deck line, on a decked ship a level railing along the sheer as the bulwark, and
 *   one continuous cap rail on top. Courses run facet by facet and end at the facet joints (never past the stem or the
 *   stern line); a plug post stands at every joint where the side turns (technique C6).
 * - Stern form is a parameter: pointed (a second bow), round (facets to a half round) or transom (straight sides to a
 *   square stern, a short knuckle of one facet). Raised fore and aft decks carry the side up by one deck and are railed
 *   like the waist, not walled.
 * - Rig proportions are ratios: a ship's overall height `rig` x its length (0.8-1.4, default 1.0), masts by length at
 *   fixed stations, one straight yard per level shrinking upward (1.4, 0.98, 0.7 x beam: spars overhang the beam by
 *   40 %), a bowsprit forward and a boom aft (overhangs 0.42 x length together). A boat has no mast unless asked.
 * - Sails are one pale surface or furled: set sails only from a cloth piece the palette marks light (`paleCloth`),
 *   panels edge to edge in two staggered layers of one piece; otherwise every yard carries a furled roll. No banners.
 * - No line in the air: pieces cannot slope and level pieces stepping inward read as combs, so there are no ratlines
 *   or stays; the rig shows at the mast feet (fittings) instead.
 * - Budget goes to function: a deck kit about every 2 tiles along each side, fittings at every mast foot, lanterns on
 *   the rail aft and forward, a hatch, a ship's boat built as a whole small hull, one deck texture per deck.
 */
import { run } from "../arrange/along";
import { layer, mirror, ring, twin } from "../arrange/copies";
import { vary } from "../arrange/modifiers";
import { polyline } from "../arrange/path";
import {
  lengthwise,
  single,
  type ArrangePiece,
  type Arrangement,
  type Placed,
  type XZ,
  extent,
  placedBox,
} from "../arrange/piece";
import { rest } from "../arrange/support";
import { transform } from "../arrange/transform";
import { hashUnitMixed } from "../util/hash";
import { maxOf, minOf, pushAll } from "../util/lists";
import { floorOver } from "./deck";
import { kitOr, type ObjectKit } from "./kit";
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
export type SternForm = "pointed" | "round" | "transom";

export interface VesselParams extends ObjectParams {
  /** Default by length: under 9 a boat, under 20 a barge, else a ship. */
  readonly kind?: VesselKind;
  /** Beam (full width), default by kind. */
  readonly beam?: number;
  /** Masts, default by kind and length (a boat: none). */
  readonly masts?: number;
  /** Set falls back to furled when no pale cloth exists (`paleCloth`). */
  readonly sails?: SailState;
  /** Raised fore and aft decks (default: ships). */
  readonly raisedDecks?: boolean;
  /** How far the hull reaches below the waterline (default 0.3: into the floor it stands on). */
  readonly draft?: number;
  readonly stern?: SternForm;
  /** Overall height (deck foot to masthead plus freeboard) over hull length: ships 0.8-1.4 (default 1.0). */
  readonly rig?: number;
  /**
   * Rooms aboard (a barge or a ship placed as a site, resolve/objectSite.ts): the hull reaches down one storey under the
   * main deck to the hold's floor (sunk 0.3 into it), raised decks stand one storey above it (cabins under them), and
   * the decks' whole cells, the breaks' bulkheads, the steps, the hatch and the keel are left to the level (areas,
   * walls, links, the hold's floor). A boat has none.
   */
  readonly interior?: boolean;
  /**
   * Stations along the length (x from the stern -size/2 to the bow +size/2, the recipe's own frame) where deck props
   * leave the deck clear across: the hatches' ladders and the gangway (a site's lanes).
   */
  readonly clear?: readonly number[];
  /** A gangway port: the bulwark left open one cell wide at station `x` on the port (+1) or starboard (-1) side. */
  readonly gangway?: { readonly x: number; readonly side: 1 | -1 };
}

/** One storey: a level's floor (0.5) and its walls (2), the height between a vessel's decks when it has rooms. */
export const STOREY = 2.5;
/** How far a room's cells stand in from the hull's inside: the half cell its wall stands in (walls host outside). */
export const ROOM_WALL = 0.5;
/** How far the hull of a vessel with rooms is sunk into the hold's floor. */
const HOLD_SINK = 0.3;

/** The ranges of the rig ratio per kind (ships: hand-built range 0.8-1.4). */
export const RIG_RANGE: Readonly<Record<VesselKind, readonly [number, number, number]>> = {
  boat: [0.5, 1.0, 0.7],
  barge: [0.4, 1.0, 0.6],
  ship: [0.8, 1.4, 1.0],
};
/** Yard lengths over the beam, lowest first (overhang 40 %, then 0.7 and 0.5 of the longest). */
export const YARD_RATIOS = [1.4, 0.98, 0.7] as const;
/** Mast stations as shares of the length from the bow, by mast count. */
const MAST_STATIONS: Readonly<Record<number, readonly number[]>> = {
  1: [0.4],
  2: [0.28, 0.6],
  3: [0.2, 0.5, 0.77],
};

interface Mast {
  readonly x: number;
  readonly height: number;
  readonly yards: readonly { readonly y: number; readonly length: number }[];
}

interface Raised {
  readonly x: number;
  readonly y: number;
}

interface VesselDesign {
  readonly kind: VesselKind;
  readonly plan: BodyPlan;
  readonly stern: SternForm;
  readonly draft: number;
  readonly deck: number;
  /** Solid side above the deck (a coaming or gunwale) before the sheer's rise. */
  readonly above: number;
  /** A level railing along the sheer on the side's top (decked ships). */
  readonly railed: boolean;
  readonly sheerRise: number;
  readonly rake: number;
  readonly fore: Raised | null;
  readonly aft: Raised | null;
  readonly masts: readonly Mast[];
  readonly bowsprit: number;
  /** How far the aftmost boom reaches past the stern. */
  readonly boom: number;
  readonly sails: SailState;
  readonly condition: Condition;
  readonly seed: string;
  /** Rooms aboard (VesselParams.interior). */
  readonly interior: boolean;
  /** With rooms: the stretch (x from, to) where the hold lies open to the sky, no main deck over it (a barge). */
  readonly openHold?: readonly [number, number] | null;
  /** Stations deck props keep clear (VesselParams.clear). */
  readonly clear: readonly number[];
  readonly gangway: VesselParams["gangway"] | null;
}

const KIND_OF = (length: number): VesselKind => (length < 9 ? "boat" : length < 20 ? "barge" : "ship");
const TAN15 = Math.tan((15 * Math.PI) / 180);

/** The stern's plan by its form (half-beam `hb`, the transom's half-width share `share`, a pointed end's taper). */
function sternPlan(form: SternForm, hb: number, share: number, taper: number): Partial<BodyPlan> {
  if (form === "pointed") return { sternHalf: 0, sternTaper: taper, sternFacets: 2 };
  if (form === "round") return { sternHalf: 0, sternTaper: hb, sternFacets: 5 };
  const sh = share * hb;
  // one 15° knuckle (asked a little long, so the taper keeps to one facet and no short facet is overhung)
  return { sternHalf: sh, sternTaper: Math.max(0.05, (1.2 * (hb - sh)) / TAN15), sternFacets: 1 };
}

/** Masts at their stations, heights from the rig ratio, yards shrinking upward. */
function rigOf(L: number, B: number, deck: number, n: number, rig: number): Mast[] {
  const stations = MAST_STATIONS[Math.min(3, n)] ?? [];
  const main = Math.max(3, rig * L - deck);
  const mainIndex = stations.length >= 2 ? 1 : 0;
  return stations.map((s, i) => {
    const H = i === mainIndex ? main : 0.9 * main;
    const levels = H >= 12 ? [0.35, 0.6, 0.82] : [0.82];
    return {
      x: Math.round(L / 2 - s * L),
      height: H,
      yards: levels.map((f, k) => ({ y: f * H, length: (YARD_RATIOS[k] ?? 0.7) * B })),
    };
  });
}

/** The design of a vessel from its parameters (all ratios of the length). */
export function vesselDesign(p: VesselParams): VesselDesign {
  const L = Math.max(4, p.size);
  const kind = p.kind ?? KIND_OF(L);
  const seed = String(p.seed);
  const condition = p.condition ?? "new";
  const draft = p.draft ?? 0.3;
  const [lo, hi, dflt] = RIG_RANGE[kind];
  const rig = Math.min(hi, Math.max(lo, p.rig ?? dflt));
  const interior = p.interior === true && kind !== "boat";
  const common = {
    kind,
    draft,
    condition,
    seed,
    rake: kind === "boat" ? 0.2 : 0.12,
    interior: false,
    clear: p.clear ?? [],
    gangway: p.gangway ?? null,
  };
  if (interior) {
    // rooms aboard: the hull down to the bottom of the hold's floor, one storey under the main deck; raised decks one
    // storey up (their cabins under them)
    const base = vesselDesign({ ...p, interior: false });
    const deck = base.deck;
    const up = (r: Raised | null): Raised | null => (r ? { x: r.x, y: deck + STOREY } : null);
    // a barge: a cabin aft under a raised deck, the hold open to the sky from it to a short foredeck
    const aft = kind === "barge" ? { x: Math.round(-0.25 * L), y: deck + STOREY } : up(base.aft);
    const openHold: readonly [number, number] | null =
      kind === "barge" && aft ? [aft.x, Math.round(0.06 * L)] : null;
    // a mast never stands over the open hold (no deck there): it steps on the foredeck just forward of it
    const masts = base.masts.map((m) =>
      openHold && m.x > openHold[0] - 1 && m.x < openHold[1] + 1 ? { ...m, x: openHold[1] + 1 } : m,
    );
    return {
      ...base,
      interior: true,
      draft: STOREY + HOLD_SINK - deck,
      fore: up(base.fore),
      aft,
      masts,
      openHold,
    };
  }
  if (kind === "boat") {
    const hb = (p.beam ?? 0.36 * L) / 2;
    const deck = 0.3;
    return {
      ...common,
      plan: {
        length: L,
        halfBeam: hb,
        bowTaper: 0.36 * L,
        bowFacets: 3,
        ...stern(p.stern ?? "transom", hb, 0.45, 0.3 * L),
      },
      stern: p.stern ?? "transom",
      // a light open boat: a shallow keel course into the water, a low gunwale (few courses)
      draft: p.draft ?? 0.15,
      deck,
      above: 0.35,
      railed: false,
      sheerRise: 0.3,
      fore: null,
      aft: null,
      masts: rigOf(L, 2 * hb, deck, p.masts ?? 0, rig),
      bowsprit: 0,
      boom: 0,
      sails: p.sails ?? "furled",
    };
  }
  if (kind === "barge") {
    const hb = (p.beam ?? 0.34 * L) / 2;
    const deck = 0.65;
    return {
      ...common,
      plan: {
        length: L,
        halfBeam: hb,
        bowTaper: 0.14 * L,
        bowFacets: 4,
        ...stern(p.stern ?? "transom", hb, 0.85, 0.2 * L),
      },
      stern: p.stern ?? "transom",
      deck,
      above: 0.3,
      railed: false,
      sheerRise: 0.15,
      fore: null,
      aft: null,
      masts: rigOf(L, 2 * hb, deck, p.masts ?? 1, rig),
      bowsprit: 0,
      boom: 0,
      sails: p.sails ?? "furled",
    };
  }
  const hb = (p.beam ?? 0.27 * L) / 2;
  const deck = 1.25;
  const raised = p.raisedDecks ?? true;
  return {
    ...common,
    plan: {
      length: L,
      halfBeam: hb,
      bowTaper: 0.3 * L,
      bowFacets: 2,
      ...stern(p.stern ?? "transom", hb, 0.62, 0.3 * L),
    },
    stern: p.stern ?? "transom",
    deck,
    above: 0.15,
    railed: true,
    sheerRise: 0.2,
    fore: raised ? { x: Math.round(0.3 * L), y: deck + 1 } : null,
    aft: raised ? { x: Math.round(-0.3 * L), y: deck + 1 } : null,
    masts: rigOf(L, 2 * hb, deck, p.masts ?? (L < 22 ? 1 : L < 34 ? 2 : 3), rig),
    bowsprit: 0.3 * L,
    boom: 0.12 * L,
    sails: p.sails ?? "set",
  };
}

const stern = (form: SternForm, hb: number, share: number, taper: number) =>
  sternPlan(form, hb, share, taper) as Pick<BodyPlan, "sternHalf" | "sternTaper">;

/** The deck top at x (raised decks over their breaks). */
function deckAt(d: VesselDesign, x: number): number {
  if (d.fore && x >= d.fore.x) return d.fore.y;
  if (d.aft && x <= d.aft.x) return d.aft.y;
  return d.deck;
}

/** The top of the solid side at x: the deck there, the coaming or gunwale above it, the sheer's rise to the ends. */
function shellTop(d: VesselDesign, x: number): number {
  const end = Math.min(1, Math.abs(x) / (d.plan.length / 2));
  return deckAt(d, x) + d.above + d.sheerRise * end ** 3;
}

/** The left side of the hull at height y: the stem leans forward with height (the stern stays put). */
function sideAt(d: VesselDesign, y: number): XZ[] {
  const lean = d.rake * (y - d.deck);
  // above the deck the sides draw in (tumblehome), so raised ends rise up and in instead of standing as boxes
  const tumble = 1 - TUMBLEHOME * Math.max(0, y - d.deck);
  const plan: BodyPlan = {
    ...d.plan,
    halfBeam: d.plan.halfBeam * tumble,
    sternHalf: d.plan.sternHalf * tumble,
    length: d.plan.length + lean,
    bowTaper: Math.max(0.3 * d.plan.bowTaper, d.plan.bowTaper + lean),
  };
  return bodySide(plan).map(([x, z]) => [x + lean / 2, z]);
}

/** How much the side draws in per tile of height above the deck (a share of the half-beam). */
const TUMBLEHOME = 0.04;

const stemAt = (d: VesselDesign, y: number): number => d.plan.length / 2 + d.rake * (y - d.deck);

/** The wall piece for a vessel's lower band: the timber when the wall should be thick (about 6 % of the beam). */
function bandPiece(d: VesselDesign, kit: ObjectKit): ArrangePiece | null {
  const plank = kit.piece("plank");
  const timber = kit.piece("timber");
  const want = 0.06 * 2 * d.plan.halfBeam;
  if (!timber || !plank) return plank ?? timber;
  return Math.abs(timber.measures.width - want) < Math.abs(plank.measures.width - want) ? timber : plank;
}

interface Course {
  readonly y: number;
  readonly piece: ArrangePiece;
}

/**
 * The side's courses, bottom up: the lower band's piece up to 0.35 under the deck line, planks above. Courses overlap
 * by a little more than `unflicker` may lift a plank.
 */
function coursesOf(d: VesselDesign, kit: ObjectKit): Course[] {
  const plank = kit.piece("plank");
  if (!plank) return [];
  const band = bandPiece(d, kit) ?? plank;
  const highest = maxOf(
    Array.from({ length: 81 }, (_, i) => shellTop(d, -d.plan.length / 2 + (i * d.plan.length) / 80)),
  );
  const out: Course[] = [];
  for (let y = -d.draft; ;) {
    const bh = band.variant.geom.size.y;
    const piece = band !== plank && y + bh <= d.deck - 0.35 ? band : plank;
    const h = piece.variant.geom.size.y;
    if (y + h > highest + 0.02) break;
    out.push({ y, piece });
    y += h - 0.037;
  }
  return out;
}

/** Modules along one polyline, facet by facet, ending at the joints (overlap varied so butt joints never line up). */
function courseRun(module: Arrangement, pts: readonly XZ[], y: number, seed: string, k: number): Arrangement {
  if (pts.length < 2) return [];
  const overlap = 0.03 + 0.14 * hashUnitMixed(seed, "course", k);
  const pieces = run(module, { path: polyline(pts), overlap, extendJoints: false });
  return transform(trimEnds(pieces, pts, extent(module, "x")), { dy: y });
}

/**
 * Modules pulled back inside the ends of a path: a module centred on an end stretch shorter than itself would stand
 * past the end (the stem, the stern line); it is moved along its stretch until its end is flush with the path's.
 */
function trimEnds(a: Arrangement, pts: readonly XZ[], len: number): Arrangement {
  const ends = [
    { at: pts[0], to: pts[1] },
    { at: pts[pts.length - 1], to: pts[pts.length - 2] },
  ];
  return a.map((q) => {
    let { x, z } = q;
    for (const { at: e, to } of ends) {
      if (!e || !to) continue;
      const l = Math.hypot(to[0] - e[0], to[1] - e[1]);
      if (l < 1e-9) continue;
      const ux = (to[0] - e[0]) / l;
      const uz = (to[1] - e[1]) / l;
      // how far along the end stretch (inward) the module's centre is, and how close to its line
      const t = (x - e[0]) * ux + (z - e[1]) * uz;
      const off = Math.abs((x - e[0]) * uz - (z - e[1]) * ux);
      if (off < 0.05 && t > -1e-6 && t < len / 2 - 1e-6) {
        x += (len / 2 - t) * ux;
        z += (len / 2 - t) * uz;
      }
    }
    return x === q.x && z === q.z ? q : { ...q, x, z };
  });
}

/** The hull side: courses (mass), plug posts at the facet joints, the cap rail and the bulwark railing (face), wale. */
function hullParts(d: VesselDesign, kit: ObjectKit, lod: number): Part[] {
  const plank = kit.piece("plank");
  const courses = coursesOf(d, kit);
  if (!plank || courses.length === 0) return [];
  const half = d.plan.length / 2;
  const hull: Placed[] = [];
  const capped: { y: number; pts: XZ[] }[] = [];
  const top = courses.length - 1;
  courses.forEach((c, k) => {
    const h = c.piece.variant.geom.size.y;
    const next = courses[k + 1];
    const exists = (x: number): boolean => c.y + h <= shellTop(d, x) + 0.02;
    const capHere = (x: number): boolean =>
      exists(x) && !(next && next.y + next.piece.variant.geom.size.y <= shellTop(d, x) + 0.02);
    const caps = intervals(capHere, -half - 1, half + 2);
    const keep = lod >= 2 || (lod === 1 && (k % 2 === 0 || k === top)) || caps.length > 0;
    const side = sideAt(d, c.y);
    const module = lengthwise(c.piece);
    for (const [a, b] of lod === 0 ? caps : intervals(exists, -half - 1, half + 2))
      if (keep)
        pushAll(hull, mirror(courseRun(module, clipX(side, a, b), c.y, d.seed, k), { axis: "z", at: 0 }));
    for (const [a, b] of caps) capped.push({ y: c.y + h, pts: clipX(side, a, b) });
    const sh = (side[0] ?? [0, 0])[1];
    if (sh >= 0.2 && exists(-half) && keep && (lod > 0 || capHere(-half))) {
      const t = c.piece.measures.width;
      pushAll(
        hull,
        courseRun(
          module,
          [
            [-half, -sh + t / 2],
            [-half, sh - t / 2],
          ],
          c.y,
          d.seed,
          k + 500,
        ),
      );
      if (capHere(-half))
        capped.push({
          y: c.y + h,
          pts: [
            [-half, -sh],
            [-half, sh],
          ],
        });
    }
  });
  // on the side's top: a level railing along the sheer (decked ships), then one continuous cap rail
  const rail = d.railed ? kit.piece("rail") : null;
  const railing: Placed[] = [];
  const cap: Placed[] = [];
  capped.forEach((c, k) => {
    const across = Math.abs((c.pts[0]?.[0] ?? 0) - (c.pts[c.pts.length - 1]?.[0] ?? 0)) < 1e-6;
    const runs = (a: Arrangement): Arrangement => (across ? a : mirror(a, { axis: "z", at: 0 }));
    let y = c.y - 0.01;
    if (rail) {
      pushAll(railing, runs(courseRun(lengthwise(rail), c.pts, y, d.seed, 3000 + k)));
      y += rail.variant.geom.size.y - 0.02;
    }
    pushAll(cap, runs(courseRun(lengthwise(plank), c.pts, y, d.seed, 1000 + k)));
  });
  // no plank end past the stern line or the stem: a module that a short end stretch could not hold is left out
  const inside = (q: Placed): boolean => {
    const b = placedBox(q);
    return b.min.x >= -half - 0.3 && b.max.x <= stemAt(d, q.y) + 0.3;
  };
  const open = (q: Placed): boolean => inside(q) && !inGangway(d, q);
  const kept = hull.filter(open);
  hull.length = 0;
  pushAll(hull, kept);
  const keptCap = cap.filter(open);
  cap.length = 0;
  pushAll(cap, keptCap);
  const keptRail = railing.filter(open);
  railing.length = 0;
  pushAll(railing, keptRail);
  const worn = d.condition === "derelict" ? { empty: 0.06, maxEmptyRun: 1 } : {};
  const parts = [
    part(
      "hull",
      "mass",
      d.condition === "new" ? hull : vary(hull, { seed: `${d.seed}:hull`, along: 0.03, ...worn }),
    ),
    part("cap rail", "face", cap),
    part("joint plugs", "mass", lod > 0 ? plugs(d, kit).filter((q) => !inGangway(d, q)) : []),
  ];
  if (railing.length > 0) parts.push(part("bulwark rail", "face", railing));
  if (lod >= 2)
    parts.push(
      part(
        "wale",
        "trim",
        wale(d, kit, courses).filter((q) => !inGangway(d, q)),
        { rung: 100, kind: "detail", hold: "fastened" },
      ),
    );
  return parts;
}

/**
 * Whether a piece of the side stands in the gangway port: within the port's cell along the length, on its side of
 * the hull, and reaching above the bottom of the deck's floor (the gangway's floor runs through there).
 */
function inGangway(d: VesselDesign, q: Placed): boolean {
  const g = d.gangway;
  if (!g) return false;
  const b = placedBox(q);
  const w = halfWidthAt(closedOutline(sideAt(d, d.deck)), g.x);
  return (
    b.max.x > g.x - 0.5 &&
    b.min.x < g.x + 0.5 &&
    g.side * (b.min.z + b.max.z) > w &&
    b.max.y > d.deck - 0.5 - 0.01
  );
}

/** A post at every joint where the side turns (the C6 plug), from the waterline to the side's top. */
function plugs(d: VesselDesign, kit: ObjectKit): Placed[] {
  const post = kit.piece(kitOr(kit, "shipSpar", "post"));
  if (!post) return [];
  const side = sideAt(d, d.deck);
  const ph = post.variant.geom.size.y;
  const out: Placed[] = [];
  for (let i = 1; i < side.length - 1; i++) {
    const [x, z] = side[i] as XZ;
    const y = Math.max(-d.draft, shellTop(d, x) - ph);
    pushAll(out, mirror([at(post, x, y, z)], { axis: "z", at: 0 }));
  }
  return out;
}

/** A rubbing strake: one plank course just outside the side at the deck line, round the whole outline (D3). */
function wale(d: VesselDesign, kit: ObjectKit, courses: readonly Course[]): Arrangement {
  const plank = kit.piece("plank");
  if (!plank) return [];
  const y = d.deck - 0.3;
  const at = courses.find((c) => c.y <= y && c.y + c.piece.variant.geom.size.y >= y) ?? courses[0];
  const out = (at?.piece.measures.width ?? plank.measures.width) / 2 + plank.measures.width / 2 + 0.005;
  const ringPts = insetConvex(closedOutline(sideAt(d, y)), -out);
  return transform(run(lengthwise(plank), { path: { points: ringPts, closed: true }, overlap: 0.05 }), {
    dy: y,
  });
}

/** Stem and stern posts (stacked poles leaning with the stem, a short post on a small hull), and the keel. */
function supportParts(d: VesselDesign, kit: ObjectKit): Part[] {
  const parts: Part[] = [];
  const half = d.plan.length / 2;
  const stack = (xAt: (y: number) => number, from: number, to: number): Placed[] => {
    const pole = kit.piece("pole");
    const post = kit.piece("post");
    const piece = post && pole && to - from < pole.variant.geom.size.y - 0.5 ? post : (pole ?? post);
    if (!piece) return [];
    const len = piece.variant.geom.size.y;
    const out: Placed[] = [];
    for (let y = from; y < to - 0.05; y += len - 0.3) out.push(at(piece, xAt(y + len / 2), y, 0));
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last && prev && last.y + len > to + 0.3) {
      const y = Math.max(from, to - len);
      if (y > prev.y + 0.3) out[out.length - 1] = { ...last, y };
      else out.pop();
    }
    return out;
  };
  parts.push(
    part(
      "stem",
      "supports",
      stack((y) => stemAt(d, y) + 0.05, -d.draft, shellTop(d, half) + 0.4),
      {
        hold: "fastened",
      },
    ),
  );
  const sternX = d.plan.sternHalf >= 0.2 ? -half - 0.1 : -half - 0.05;
  parts.push(
    part(
      "sternpost",
      "supports",
      stack(() => sternX, -d.draft, shellTop(d, -half) + 0.3),
      { hold: "fastened" },
    ),
  );
  const timber = kit.piece("timber");
  // a keel timber is too heavy for an open boat (it would stand through the bottom boards)
  // with rooms aboard the hold's floor is the bottom (a keel would stand through it)
  if (timber && d.kind !== "boat" && !d.interior) {
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

function decksOf(d: VesselDesign, t: number): { surfaces: Surface[]; spaces: Space[] } {
  const half = d.plan.length / 2;
  const fx = d.fore?.x ?? half + 2;
  const ax = d.aft?.x ?? -half - 2;
  if (d.interior) return interiorDecks(d, t);
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

/**
 * The decks and spaces of a vessel with rooms (`interior`), each at the height its level stands at: the main deck
 * between the breaks (not over an open hold), the raised decks one storey up, the hold one storey down over the whole
 * hull, and a cabin under each raised deck. A space's outline is the hull's inside at its narrowest height (the hold's
 * floor, where the raked stem draws the ends in; a cabin's ceiling, where the tumblehome draws the sides in).
 */
function interiorDecks(d: VesselDesign, t: number): { surfaces: Surface[]; spaces: Space[] } {
  const half = d.plan.length / 2;
  const fx = d.fore?.x ?? half + 2;
  const ax = d.aft?.x ?? -half - 2;
  const from = d.openHold ? d.openHold[1] : ax;
  const surfaces: Surface[] = [{ id: "deck", y: d.deck, polygon: deckOutline(d, d.deck, t, from, fx) }];
  const spaces: Space[] = [
    {
      id: "hold",
      floorY: d.deck - STOREY,
      ceilingY: d.deck - 0.5,
      polygon: deckOutline(d, d.deck - STOREY, t + 2 * ROOM_WALL, -half - 2, half + 2),
    },
  ];
  if (d.fore) {
    surfaces.push({
      id: "forecastle",
      y: d.fore.y,
      polygon: deckOutline(d, d.fore.y, t, d.fore.x, half + 2),
    });
    spaces.push({
      id: "forecastle cabin",
      floorY: d.deck,
      ceilingY: d.fore.y - 0.5,
      polygon: deckOutline(d, d.fore.y - 0.5, t + 2 * ROOM_WALL, d.fore.x, half + 2),
    });
  }
  if (d.aft) {
    surfaces.push({ id: "quarterdeck", y: d.aft.y, polygon: deckOutline(d, d.aft.y, t, -half - 2, d.aft.x) });
    spaces.push({
      id: "stern cabin",
      floorY: d.deck,
      ceilingY: d.aft.y - 0.5,
      polygon: deckOutline(d, d.aft.y - 0.5, t + 2 * ROOM_WALL, -half - 2, d.aft.x),
    });
  }
  return {
    surfaces: surfaces.filter((s) => s.polygon.length >= 3),
    spaces: spaces.filter((s) => s.polygon.length >= 3),
  };
}

/** The decks' tiles (one texture each), the bulkheads across the breaks, and steps up to the raised decks. */
function deckParts(d: VesselDesign, kit: ObjectKit, surfaces: readonly Surface[]): Part[] {
  // one deck texture for the whole vessel: the ship kit's deck tiles, else the wooden floor tiles; with rooms aboard
  // the whole cells are the deck areas' floors (the level lays them) and the recipe lays the margins only
  const deckTiles = {
    small: kitOr(kit, "shipDeckSmall", "deckSmall"),
    big: kitOr(kit, "shipDeck", "deck"),
  };
  const tiles = surfaces
    .flatMap((s) => floorOver(s.polygon, s.y, kit, `${d.seed}:deck`, deckTiles, { wholeCells: !d.interior }))
    .filter((q) => !inGangway(d, q));
  const parts = [part("decks", "deck", tiles, { rung: 50, kind: "interior" })];
  // with rooms aboard, the breaks are the cabins' walls and the steps are the level's links
  if (d.interior) return parts;
  const plank = kit.piece("plank");
  const step = kit.piece("deckSmall");
  const breaks: Placed[] = [];
  for (const r of [d.fore, d.aft]) {
    if (!r || !plank) continue;
    const w = halfWidthAt(deckOutline(d, d.deck, plank.measures.width, -1e3, 1e3), r.x);
    const h = plank.variant.geom.size.y;
    for (let y = d.deck, k = 0; y + h <= r.y + 0.01; y += h - 0.037, k++)
      pushAll(
        breaks,
        courseRun(
          lengthwise(plank),
          [
            [r.x, -w],
            [r.x, w],
          ],
          y,
          d.seed,
          2000 + k,
        ),
      );
    if (step) {
      const dir = r === d.fore ? -1 : 1;
      const side = r === d.fore ? 1 : -1;
      for (const z of [0.5, 1.5]) breaks.push(at(step, r.x + dir * 0.5, d.deck, side * z));
    }
  }
  if (breaks.length > 0) parts.push(part("breaks", "deck", breaks, { rung: 50, kind: "silhouette" }));
  return parts;
}

/**
 * The cloth a set sail may be made of: a cloth piece the palette marks light-toned and not coloured (one pale
 * surface), else null (sails stay furled). Palettes without tone data have none.
 */
export function paleCloth(candidates: readonly ArrangePiece[]): ArrangePiece | null {
  const neutral = new Set(["white", "grey", "gray", "cream", "neutral", "beige"]);
  return (
    candidates.find(
      (p) => p.variant.tone === "light" && (p.variant.hue === undefined || neutral.has(p.variant.hue)),
    ) ?? null
  );
}

/**
 * A set sail of one cloth piece under a yard: panels edge to edge (8 % overlap) along the yard, `rows` deep, and a
 * second skin just behind shifted half a panel (the `layer` operator), so the joints of one layer fall on the middles of
 * the other and the surface reads as one. Built along local z, centred, its top at y = 0.
 */
export function sailPanels(cloth: ArrangePiece, length: number, rows: number): Arrangement {
  const cw = cloth.measures.length;
  const ch = cloth.variant.geom.size.y;
  const across = Math.max(1, Math.ceil((0.9 * length) / (0.92 * cw)));
  const one: Placed[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < across; c++)
      pushAll(
        one,
        transform(lengthwise(cloth), {
          turn: 90,
          dz: (c - (across - 1) / 2) * 0.92 * cw,
          dy: -(r + 1) * (ch - 0.05),
        }),
      );
  return layer(one, { normal: "x", proud: -0.04, shift: (0.92 * cw) / 2 });
}

/** A mast: poles stacked (a 2 x 2 bundle for its lower 40 % when tall), a top, one straight yard per level, sails. */
/** A mast of the ship kit's sections: the base at the foot, mid sections stacked, the top section last. */
function kitMast(kit: ObjectKit, x: number, foot: number, height: number): Placed[] | null {
  const pieces = kit.standIn("shipMast")?.pieces ?? [];
  const named = (v: string): ArrangePiece | undefined => pieces.find((p) => p.variant.variant === v);
  const mid = named("mid") ?? pieces[0];
  if (!mid) return null;
  const base = named("base") ?? mid;
  const top = named("top") ?? mid;
  const out: Placed[] = [at(base, x, foot, 0)];
  let y = base.variant.geom.size.y - 0.05;
  const topH = top.variant.geom.size.y;
  for (; y + topH < height - 0.05; y += mid.variant.geom.size.y - 0.05) out.push(at(mid, x, foot + y, 0));
  out.push(at(top, x, foot + y, 0));
  return out;
}

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
  // the ship kit's mast sections first; else poles stacked, a 2 x 2 bundle of them for the lower 40 % when tall
  const fromKit = kitMast(kit, m.x, foot, height);
  const mast: Placed[] = fromKit ?? [];
  let y = 0;
  const pitch = 1.15 * w;
  if (!fromKit)
    for (; y < lowTop - 0.3; y += len - 0.35)
      for (const [dx, dz] of [
        [-0.5, -0.5],
        [0.5, -0.5],
        [-0.5, 0.5],
        [0.5, 0.5],
      ] as const)
        mast.push(at(pole, m.x + dx * pitch, foot + y, dz * pitch));
  const [ux, uz] = y > 0 ? [m.x + pitch / 2, pitch / 2] : [m.x, 0];
  if (y > 0) y -= 0.6;
  if (!fromKit) for (; y < height - 0.3; y += len - 0.35) mast.push(at(pole, ux, foot + y, uz));
  const name = `mast ${i + 1}`;
  const parts: Part[] = [part(name, "top", mast)];
  const hatch = kit.piece("hatch");
  if (hatch && lowTop > 0)
    parts.push(
      part(`${name} top`, "stowage", [at(hatch, ux, foot + lowTop, uz)], { rung: 100, kind: "detail" }),
    );
  // a pennant (two-faced) flying aft from the tallest masthead
  const cloth = kit.piece("cloth");
  const head = mast[mast.length - 1];
  const tallest = d.masts.findIndex((q) => q.height === maxOf(d.masts.map((r) => r.height))) === i;
  if (cloth && head && tallest && !broken) {
    const pennant = transform(lengthwise(cloth), {
      dx: head.x - cloth.measures.length / 2 - head.piece.measures.length / 2,
      dz: head.z,
      dy: head.y + head.piece.variant.geom.size.y - cloth.variant.geom.size.y - 0.3,
    });
    parts.push(
      part("pennant", "rigging", twin(pennant, { turn: 180 }), {
        rung: 200,
        kind: "detail",
        hold: "fastened",
      }),
    );
  }
  if (plank) {
    const levels = broken ? m.yards.slice(0, 1) : m.yards;
    // one straight spar square across the ship, centred on the mast's axis
    const yards = levels.flatMap((yd) =>
      transform(
        run(lengthwise(plank), {
          path: polyline([
            [ux, -yd.length / 2],
            [ux, yd.length / 2],
          ]),
          // the fewest planks end to end, barely overlapping: their tops never flicker, so none is lifted and the
          // spar stays straight
          overlap: 0.005,
        }),
        {
          dy: foot + yd.y,
        },
      ),
    );
    parts.push(part(`${name} yards`, "top", yards, { hold: "fastened" }));
    pushAll(parts, sailParts(d, kit, ux, foot, broken ? [] : levels, name));
  }
  return parts;
}

/** Furled rolls lashed along every yard; set sails (one pale cloth, two layers) under all but the lowest. */
function sailParts(
  d: VesselDesign,
  kit: ObjectKit,
  x: number,
  foot: number,
  yards: readonly { y: number; length: number }[],
  name: string,
): Part[] {
  if (d.sails === "none" || yards.length === 0) return [];
  const rope = kit.piece(kitOr(kit, "shipRope", "rope"));
  // a sail of the ship kit is a sail whatever its tone; any other cloth only when the palette marks it pale
  const cloth = d.sails === "set" ? (kit.piece("shipSail") ?? paleCloth(kit.mix("cloth"))) : null;
  const furl = kit.piece("shipFurled");
  const set: Placed[] = [];
  const furled: Placed[] = [];
  yards.forEach((yd, i) => {
    const below = i === 0 ? null : yards[i - 1];
    if (cloth && below) {
      const gap = yd.y - below.y - 0.2;
      const rows = Math.min(2, Math.floor(gap / (cloth.variant.geom.size.y - 0.05)));
      if (rows >= 1) {
        pushAll(set, transform(sailPanels(cloth, yd.length, rows), { dx: x + 0.25, dy: foot + yd.y }));
        return;
      }
    }
    const path = polyline([
      [x, -0.45 * yd.length],
      [x, 0.45 * yd.length],
    ]);
    if (furl) {
      // the kit's furled sail hangs under the yard, end to end along it
      const fh = furl.variant.geom.size.y;
      pushAll(
        furled,
        transform(run(lengthwise(furl), { path, overlap: 0.05 }), { dy: foot + yd.y - fh + 0.02 }),
      );
      return;
    }
    if (!rope) return;
    const rh = rope.variant.geom.size.y;
    const rw = rope.measures.width;
    const lash = run(lengthwise(rope), { path, overlap: 0.08 });
    // a tight roll: two lines side by side just under the yard, a third under them
    pushAll(
      furled,
      transform(lash, { dx: -rw / 2, dy: foot + yd.y - rh + 0.02 }),
      transform(lash, { dx: rw / 2, dy: foot + yd.y - rh + 0.02 }),
      transform(lash, { dy: foot + yd.y - 2 * rh + 0.05 }),
    );
  });
  const parts: Part[] = [];
  if (set.length > 0)
    parts.push(part(`${name} sails`, "sails", set, { rung: 100, kind: "detail", hold: "fastened" }));
  if (furled.length > 0)
    parts.push(
      part(`${name} furled sails`, "sails", furled, { rung: 100, kind: "detail", hold: "fastened" }),
    );
  return parts;
}

/** The bowsprit forward (heavy timbers stepping up, a lighter boom beyond) and a boom aft over the stern. */
function sparParts(d: VesselDesign, kit: ObjectKit): Part[] {
  const timber = kit.piece("timber");
  const plank = kit.piece("plank");
  const half = d.plan.length / 2;
  const parts: Part[] = [];
  if (d.bowsprit > 0 && timber) {
    const y0 = shellTop(d, half) - 0.35;
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
    const rise = (a: Arrangement, base: number): Placed[] =>
      a.map((q) => ({ ...q, y: base + 0.1 * (q.x - x0) }));
    parts.push(part("bowsprit", "top", [...rise(heavy, y0), ...rise(boom, y0 + 0.3)], { hold: "fastened" }));
  }
  const aftmost = [...d.masts].sort((a, b) => a.x - b.x)[0];
  // with rooms aboard the quarterdeck stands a storey up, where the boom would run through it: no boom
  if (d.boom > 0 && plank && aftmost && !d.interior) {
    const y = deckAt(d, aftmost.x) + 2.2;
    const boom = run(lengthwise(plank), {
      path: polyline([
        [aftmost.x, 0],
        [-half - d.boom, 0],
      ]),
      overlap: 0.08,
    });
    parts.push(part("boom", "top", transform(boom, { dy: y }), { hold: "fastened" }));
  }
  return parts;
}

/**
 * What a vessel carries, spent on function: fittings at every mast foot, a deck kit about every 2 tiles along each
 * side, lanterns on the rail, a hatch, a ship's boat (this recipe, whole), cargo, thwarts and oars, a shelter, a sweep.
 */
function stowageParts(d: VesselDesign, kit: ObjectKit, decks: readonly Surface[]): Part[] {
  const parts: Part[] = [];
  const half = d.plan.length / 2;
  const L = d.plan.length;
  const onDeck = (a: Arrangement, x: number, z: number): Arrangement =>
    transform(a, { dx: x, dz: z, dy: deckAt(d, x) });
  const plank = kit.piece("plank");
  const tilt = { seed: `${d.seed}:cargo`, yaw: 15, along: 0.06, across: 0.06 };
  const fitting = kit.piece(kitOr(kit, "shipCoil", "fitting"));
  const pole = kit.piece("pole");
  if (fitting && pole && d.masts.length > 0) {
    // round each mast foot, clear of the bundle (or the kit mast's base): belaying fittings
    const kitFoot = kit.standIn("shipMast")?.pieces.find((p) => p.variant.variant === "base");
    const foot = kitFoot
      ? kitFoot.measures.length
      : d.kind === "ship"
        ? 1.15 * pole.measures.length
        : pole.measures.length;
    const r = foot / 2 + 0.45;
    const feet = d.masts.flatMap((m) =>
      onDeck(
        ring(single(fitting), { count: 3, radius: r, start: 30 + 60 * hashUnitMixed(d.seed, "foot", m.x) }),
        m.x,
        0,
      ),
    );
    parts.push(part("mast fittings", "stowage", feet, { rung: 100, kind: "detail" }));
  }
  const main = decks.find((s) => s.id === "deck");
  if (d.kind === "ship" && main) {
    const [mainMast, foreMast] = d.masts.length >= 2 ? [d.masts[1], d.masts[0]] : [d.masts[0], undefined];
    const hatch = kit.piece("hatch");
    // the boat stows in the longest clear stretch of the waist (between the masts, or aft of the main mast); the hatch
    // takes the other
    const boatLength = Math.min(6, Math.max(4.5, 0.17 * L));
    const stretches: [number, number][] = [];
    if (mainMast && foreMast) stretches.push([mainMast.x + 1.2, foreMast.x - 1.2]);
    if (mainMast) stretches.push([(d.aft?.x ?? -half + 2) + 0.6, mainMast.x - 1.2]);
    // never over a lane the site keeps clear (a hatch's ladder, the gangway)
    const boatAt =
      stretches.find(([a, b]) => b - a >= boatLength && !d.clear.some((c) => c > a - 1 && c < b + 1)) ?? null;
    const hatchAt = stretches.find((s) => s !== boatAt && s[1] - s[0] >= 2.6);
    const hx = hatchAt ? Math.round((hatchAt[0] + hatchAt[1]) / 2) : Math.round(0.1 * L);
    // with rooms aboard the hatch is the ladder's hole in the deck (a link of the level)
    const grating = kit.piece("shipGrating");
    if (hatch && plank && !d.interior) {
      // the ship kit's grating, else two flat covers
      const cover = grating
        ? onDeck(single(grating), hx, 0)
        : [-0.5, 0.5].flatMap((dz) => onDeck(single(hatch), hx, dz));
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
    // a kit every 2.2 tiles along each side of the waist, each side drawn on its own (dressing mirrors little)
    const kits: Placed[] = [];
    const choice = ["barrel", "smallCrate", "fitting", "crate"] as const;
    const busy = [hx, ...d.masts.map((m) => m.x), ...d.clear];
    const xs = main.polygon.map((p) => p[0]);
    for (let x = minOf(xs) + 1.3; x <= maxOf(xs) - 1.3; x += 2.2) {
      if (busy.some((b) => Math.abs(b - x) < 1.3)) continue;
      const w = halfWidthAt(main.polygon, x) - 0.55;
      for (const side of [-1, 1]) {
        const id = choice[Math.floor(hashUnitMixed(d.seed, "kit", x, side) * choice.length)] ?? "barrel";
        // the ship kit's cargo and coils first (seeded among its pieces), else today's stand-ins
        const own = id === "fitting" ? "shipCoil" : "shipCargo";
        const p = kit.standIn(own) ? kit.pick(own, d.seed, x, side) : kit.piece(id);
        if (p && w > 1)
          pushAll(
            kits,
            onDeck(single(p, 90 * Math.floor(4 * hashUnitMixed(d.seed, "kit-turn", x, side))), x, side * w),
          );
      }
    }
    if (kits.length > 0)
      parts.push(part("deck kits", "stowage", vary(kits, tilt), { rung: 100, kind: "detail" }));
    const kitBoat = kit.standIn("shipBoat")?.pieces ?? [];
    const section = (v: string): ArrangePiece | undefined => kitBoat.find((p) => p.variant.variant === v);
    const [bow, mid, aft] = [section("bow"), section("mid"), section("stern")];
    if (boatAt && bow && mid && aft) {
      // the ship kit's boat, its three sections end to end along the waist (ASSUMED: the sections' length runs along
      // their z, the bow section's open end toward -z)
      const bx = (boatAt[0] + boatAt[1]) / 2;
      const sections = [
        at(aft, bx - aft.measures.width + 0.02, d.deck, 0, 90),
        at(mid, bx, d.deck, 0, 90),
        at(bow, bx + mid.measures.width - 0.02, d.deck, 0, 90),
      ];
      parts.push(part("ship's boat", "stowage", sections, { rung: 200, kind: "detail" }));
    } else if (boatAt) {
      const [lo, hi] = boatAt;
      {
        // the stowed boat at full detail, so it reads as a small hull (bottom boards, thwarts), never a heap
        const boat = buildObject(
          vessel,
          {
            size: boatLength,
            kind: "boat",
            masts: 0,
            seed: `${d.seed}:boat`,
            budget: 400,
            condition: d.condition,
          },
          kit,
        );
        const lowest = minOf(piecesOf(boat).map((q) => q.y));
        const bx = (lo + hi) / 2;
        const set = (a: Arrangement) => transform(a, { turn: 90, dx: bx, dy: d.deck - lowest });
        const fastened = boat.parts.filter((p) => p.hold === "fastened").flatMap((p) => p.pieces);
        const resting = boat.parts.filter((p) => p.hold !== "fastened").flatMap((p) => p.pieces);
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
  // the ship kit's helm (on the quarterdeck just aft of its break, else aft on the main deck) and an anchor hung at
  // each bow; nothing stands in for either without the kit
  const helm = kit.piece("shipHelm");
  if (helm && d.kind === "ship") {
    const hx = d.aft ? d.aft.x - 1.5 : -half + 2.5;
    parts.push(part("helm", "stowage", [at(helm, hx, deckAt(d, hx), 0, 90)], { rung: 100, kind: "detail" }));
  }
  const anchor = kit.piece("shipAnchor");
  if (anchor && d.kind === "ship") {
    const ax = half - 0.35 * d.plan.bowTaper;
    const y = shellTop(d, ax) - anchor.variant.geom.size.y - 0.2;
    const z = halfWidthAt(closedOutline(sideAt(d, y)), ax) + anchor.measures.width / 2 + 0.03;
    parts.push(
      part("anchors", "stowage", mirror([at(anchor, ax, y, z)], { axis: "z", at: 0 }), {
        rung: 200,
        kind: "detail",
        hold: "fastened",
      }),
    );
  }
  // lanterns on the cap rail: one at each quarter aft, one at the bow
  const lantern = kit.piece(kitOr(kit, "shipLantern", "lantern"));
  if (lantern && d.kind !== "boat") {
    const capTop = (x: number): number =>
      shellTop(d, x) +
      (d.railed ? (kit.piece("rail")?.variant.geom.size.y ?? 0) - 0.02 : 0) +
      (plank?.variant.geom.size.y ?? 0.15) -
      0.02;
    const xs = [-half + 0.8, half - 0.25 * d.plan.bowTaper];
    const lights: Placed[] = [];
    xs.forEach((x, k) => {
      const z = halfWidthAt(closedOutline(sideAt(d, d.deck)), x);
      const sides = k === 0 ? [-1, 1] : [1];
      for (const s of sides) lights.push(at(lantern, x, capTop(x) - 0.02, s * z));
    });
    parts.push(part("lanterns", "stowage", lights, { rung: 100, kind: "detail" }));
  }
  // with rooms aboard a barge's cargo is in its hold and its shelter is the cabin (furnished by the level)
  if (d.kind === "barge" && !d.interior) {
    const crate = kit.piece("crate");
    const sack = kit.piece("sack");
    const barrel = kit.piece("barrel");
    const cargo: Placed[] = [];
    for (let x = -0.3 * L; x < -0.3 * L + 0.27 * L; x += 1.2)
      for (const z of [-0.65, 0.65]) {
        const i = Math.round(x * 10 + z * 3);
        if (crate && hashUnitMixed(d.seed, "crate", i) < 0.75)
          pushAll(
            cargo,
            onDeck(
              hashUnitMixed(d.seed, "stack", i) < 0.45 ? rest(single(crate), single(crate)) : single(crate),
              x,
              z,
            ),
          );
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
      const sweep = run(lengthwise(plank), {
        path: polyline([
          [-half + 1.2, 0.35],
          [-half - 2, 0.35],
        ]),
        overlap: 0.05,
      });
      parts.push(
        part(
          "sweep",
          "stowage",
          transform(sweep, { dy: shellTop(d, -half) + (plank.variant.geom.size.y - 0.04) }),
          {
            rung: 100,
            kind: "detail",
            hold: "fastened",
          },
        ),
      );
    }
  }
  if (d.kind === "boat") {
    const bench = kit.piece("bench");
    const deck = decks[0];
    if (bench && deck) {
      const seats = [-0.12 * L, 0.12 * L].flatMap((x) =>
        2 * halfWidthAt(deck.polygon, x) >= bench.measures.length + 0.05
          ? onDeck(single(bench, bench.measures.runAxis === "z" ? 0 : 90), x, 0)
          : [],
      );
      if (seats.length > 0) parts.push(part("thwarts", "stowage", seats, { rung: 50, kind: "detail" }));
    }
    if (plank) {
      const oars: Placed[] = [];
      const capH = plank.variant.geom.size.y;
      for (const x of [-0.12 * L, 0.12 * L]) {
        const y = shellTop(d, x) + capH - 0.04;
        const z = halfWidthAt(closedOutline(sideAt(d, y - 0.3)), x);
        pushAll(
          oars,
          mirror(transform(lengthwise(plank), { turn: -75, dx: x, dz: z, dy: y }), { axis: "z", at: 0 }),
        );
      }
      // a boat's top feature is its oars (no mast unless asked)
      parts.push(part("oars", d.masts.length === 0 ? "top" : "stowage", oars, { hold: "fastened" }));
    }
  }
  return parts;
}

/**
 * The parts listed first, in this order: `unflicker` settles the cap and railing before the courses, and the packing
 * (objects/place.ts) keeps the hull and the decks it carries in the first instance, the keel last of them so a second
 * instance can open on the ground.
 */
const PACK_FIRST = [
  "cap rail",
  "bulwark rail",
  "hull",
  "joint plugs",
  "stem",
  "sternpost",
  "decks",
  "breaks",
  "wale",
  "keel",
];

export const vessel: ObjectRecipe<VesselParams> = {
  id: "vessel",
  doc: "a boat, river barge or sailing ship: banded hull on 15° facets, decks, masts, straight yards, furled or pale sails",
  slots: {
    mass: { doc: "the hull side's bands and the plugs at its joints" },
    supports: { doc: "stem post, stern post" },
    face: { doc: "cap rail, bulwark railing" },
    top: { doc: "masts, yards, bowsprit, boom" },
    trim: { doc: "the wale" },
    frame: { doc: "the keel" },
    deck: { doc: "walkable decks, the breaks' bulkheads and steps" },
    sails: { doc: "set (pale cloth) or furled sails" },
    rigging: { doc: "a pennant" },
    stowage: {
      doc: "mast fittings, deck kits, lanterns, hatch, cargo, ship's boat, thwarts, oars, shelter, sweep",
    },
  },
  budget: 2000,
  lods: 3,
  build(params, kit, lod): Draft {
    const d = vesselDesign(params);
    const t = kit.piece("plank")?.measures.width ?? 0.13;
    const { surfaces, spaces } = decksOf(d, t);
    const parts = [
      ...hullParts(d, kit, lod),
      ...supportParts(d, kit),
      ...deckParts(d, kit, surfaces),
      ...d.masts.flatMap((m, i) => mastParts(d, kit, m, i)),
      ...sparParts(d, kit),
      ...stowageParts(d, kit, surfaces),
    ]
      .filter((p) => p.pieces.length > 0)
      .map((p, i) => ({ p, i, o: PACK_FIRST.indexOf(p.name) }))
      .sort((a, b) => (a.o < 0 ? 99 : a.o) - (b.o < 0 ? 99 : b.o) || a.i - b.i)
      .map(({ p }) => p);
    return turnDraft(
      { parts, footprint: closedOutline(sideAt(d, d.deck)), clearance: 1, surfaces, spaces },
      -90,
    );
  },
};
