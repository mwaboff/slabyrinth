/**
 * Building variety (without it "all the buildings look the same"). A style profile may declare a DESIGN SPACE:
 * weighted choices on independent axes — massing archetype, storeys and storey heights, wall material (and a base
 * storey in another one), roof, parapet, rooftop sets, window pattern, base treatment, top treatment — and a map from
 * a building's `use` (shop, apartments, warehouse …) to weight multipliers. When the plan leaves a building's shape
 * and looks unset, a design is drawn from the space with the building's seed and EXPANDED into ordinary plan fields
 * (volumes, storeys, roof, windows, plinth, openings, furniture), so the rest of the pipeline is unchanged.
 *
 * Neighbour rule: designs are drawn in list order; a building re-rolls (deterministically) while it shares both
 * archetype and material, or the storey count, with a building standing within two cells of it.
 *
 * Everything here is generic: archetype names are geometric (box, setback, podium, twin, ell, stepped, shed, gabled,
 * tall), never tied to a theme; the style's data says which apply and how often.
 */
import type { Building, Roof, RoofType, Side, Storey, Volume, WallStyle } from "../contracts/plan";
import type { ResolvedStructure } from "../contracts/resolved";
import { OPPOSITE } from "../gen/gridGeometry";
import { OPENING_KIND_INFO, openingTests } from "../gen/openingKinds";
import type { GeneratorProfile } from "../plan/generator";
import { createPrng, type Prng } from "../util/prng";
import { defaultRidge, roofRise } from "./roof";
import { isFlatRoof, isPitchedRoof } from "./roofTypes";
import { structureStyle } from "./structureStyles";

export type Weights = Readonly<Record<string, number>>;

export interface DesignSpace {
  /** Massing archetypes by weight (see expandDesign). */
  archetypes: Weights;
  /** Storey count of the main mass (when the plan gives none). */
  storeys: readonly [number, number];
  /** Wall height of the ground storey and of the storeys above (tiles, drawn in 0.5 steps). */
  groundHeight: readonly [number, number];
  upperHeight: readonly [number, number];
  /** Wall material by weight; with `baseChance` the ground storey takes a material from `baseMaterials`. */
  materials: Weights;
  baseChance?: number;
  baseMaterials?: Weights;
  /** Roof of the top mass by weight ("flat", "gable", "hip", "shed", "skirt", "stepped" …). */
  roofs: Weights;
  /** Roof kit for sloped roofs when the style's own kit is flat-only (a city kit has no slopes). */
  pitchedKit?: string;
  /** Flat-roof parapet by weight: a wall style, "walls" (the building's own material) or "none". */
  parapets?: Weights;
  /** Rooftop sets by weight (hut, mast, plant, storage, terrace); `rooftopCount` of them are drawn. */
  rooftop?: Weights;
  rooftopCount?: readonly [number, number];
  /** Window pattern of the upper storeys by weight (punched, paired, ribbon, tall, sparse). */
  windows: Weights;
  /** Ground storey on the street face by weight (plain, shopfront, stoop, garage). */
  bases: Weights;
  /** Top storey by weight (same, attic: a lower top storey with fewer windows). */
  tops?: Weights;
  /** Facade details by weight (fire_escape, balconies, piers, canopy, services); `detailCount` of them are drawn. */
  details?: Weights;
  detailCount?: readonly [number, number];
  /** Parapet style for "walls" by wall material when the material has no parapet piece ("none" = no parapet). */
  parapetFor?: Readonly<Record<string, string>>;
  /** Chance of a service door on the rear face (when the rear looks onto open ground). */
  serviceDoor?: number;
  /** Footing course of the ground storey by weight (a wall style, or "none"). */
  footings?: Weights;
  /** Size class by weight: full plot, compact (a cell narrower and shallower), small (about 60%). */
  sizes?: Weights;
  /** Tone of each wall material (dark, mid, light): neighbours differ in tone, and dark is capped along a street. */
  tones?: Readonly<Record<string, "dark" | "mid" | "light">>;
  /** Most of a street that may be dark-walled (default 1/3). */
  darkShare?: number;
  /** Share of windows lit at least, on a dark-walled building (so its windows read). */
  darkLit?: number;
  /** Flat-roof surface kit by weight (palette roles roof.<kit>.flat; "default" = the style's kit). */
  roofSurfaces?: Weights;
  /** Parapet of the lower flat roofs (podiums, setbacks, steps) by weight: "walls", a wall style or "none". */
  lowerParapets?: Weights;
  /** Crown weights per wall material (a related material only: stone → darker stone or timber, marble → marble). */
  crownFor?: Readonly<Record<string, Weights>>;
  /** Walls of the top storey by weight ("same", or a wall style: a timber chamber on a stone tower). */
  crowns?: Weights;
  /**
   * Wall treatments as belonging sets, by weight (overrides materials, baseMaterials and crowns): the base tier and
   * trim, the shaft or main walls, and the crown storey's walls drawn from its own related weights ("same" = the
   * main walls). Two towers of one style differ in treatment, never in an unrelated pair of materials.
   */
  treatments?: Readonly<
    Record<string, { weight: number; base: WallStyle; material: WallStyle; crowns: Weights }>
  >;
  /** Roof kit for every pitched roof of the building by weight (one roof material per building). */
  roofKits?: Weights;
  /**
   * A tower's proportion: the drawn footprint is at most this many cells a side (a bigger plot gets the tower in
   * its middle on a stepped base), and the walls rise at least `minAspect` times the footprint's width.
   */
  maxFootprint?: number;
  minAspect?: number;
  /** Height of an attic top storey (default: the upper height less one, at least 2). */
  atticHeight?: number;
  /** Use → multipliers, keyed "axis:value" (e.g. shop: { "bases:shopfront": 6 }). Unknown uses change nothing. */
  uses?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /**
   * Generator 3 only: the share of the visible height a pitched roof makes, drawn per building from this range (the
   * study's cottages and inns: 55-65 %). The walls are lowered (the top storey into the roof) until the roof reaches it,
   * and cross wings and lean-tos stand a tile or more below the main ridge.
   */
  roofShare?: readonly [number, number];
  /**
   * Under the profile's `buildingVariety` switch (generator 3 on): axes replacing the ones above (shallow merge), so a
   * style's older output stays as it was.
   */
  buildingVariety?: Partial<Omit<DesignSpace, "buildingVariety">>;
}

const merged = new WeakMap<DesignSpace, DesignSpace>();
/** The design space a generator uses: with `buildingVariety` on, the style's `buildingVariety` overrides (one object per space). */
export function designSpaceFor(space: DesignSpace, buildingVariety: boolean): DesignSpace {
  if (!buildingVariety || !space.buildingVariety) return space;
  let m = merged.get(space);
  if (!m) {
    m = { ...space, ...space.buildingVariety };
    merged.set(space, m);
  }
  return m;
}

export interface BuildingDesign {
  use: string;
  archetype: string;
  storeys: number;
  groundHeight: number;
  upperHeight: number;
  material: WallStyle;
  baseMaterial: WallStyle;
  roof: string;
  parapet: string;
  rooftop: string[];
  windows: string;
  base: string;
  top: string;
  details: string[];
  serviceDoor: boolean;
  footing: string;
  size: string;
  roofSurface: string;
  parapetLower: string;
  crown: string;
  character: string[];
  /** The wall treatment drawn ("" when the style has none) and the roof kit of every pitched roof ("" = the style's). */
  treatment?: string;
  roofKit?: string;
  /** Generator 3: the share of the visible height the roof is drawn to make (see DesignSpace.roofShare). */
  roofShare?: number;
}

const pickW = (prng: Prng, w: Weights, mul: Readonly<Record<string, number>>, axis: string): string => {
  const entries = Object.entries(w)
    .map(([k, v]) => [k, v * (mul[`${axis}:${k}`] ?? 1)] as const)
    .filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let r = prng.next() * total;
  for (const [k, v] of entries) {
    r -= v;
    if (r < 0) return k;
  }
  return entries[entries.length - 1]?.[0] ?? Object.keys(w)[0] ?? "";
};
const range = (prng: Prng, r: readonly [number, number], step: number): number =>
  r[0] + Math.round((prng.next() * (r[1] - r[0])) / step) * step;

/** Draw one design from a space (pure: the same seed gives the same design). */
export function drawDesign(
  space: DesignSpace,
  seed: number,
  use: string | undefined,
  w: number,
  h: number,
  character?: readonly string[],
): BuildingDesign {
  const prng = createPrng(seed);
  const u = use ?? "default";
  const mul = space.uses?.[u] ?? {};
  let archetype = pickW(prng, space.archetypes, mul, "archetypes");
  // a shape-bending character makes a tower a single shaft that can twist, lean or go crooked
  if (space.maxFootprint !== undefined && (character ?? []).some((c) => c !== "squat" && c !== "slender"))
    archetype = "shaft";
  // the footprint decides what fits: a narrow plot is a tall infill, a small one a plain box
  const short = Math.min(w, h);
  if (short <= 3 && archetype !== "shed" && archetype !== "shaft") archetype = "tall";
  else if (short < 5 && ["podium", "setback", "stepped", "ell", "twin"].includes(archetype))
    archetype = "box";
  let storeys = Math.round(range(prng, space.storeys, 1));
  if (archetype === "tall") storeys = Math.min(space.storeys[1] + 1, storeys + 1);
  if (archetype === "shed") storeys = 1;
  // squat and slender bend any style's height (a shaft also narrows or widens)
  if ((character ?? []).includes("squat") && archetype !== "shaft") storeys = Math.max(1, storeys - 1);
  if ((character ?? []).includes("slender") && archetype !== "shaft") storeys = storeys + 1;
  if (space.minAspect !== undefined) {
    // tall for its footprint: enough storeys to stand minAspect times as tall as it is wide
    const tw = Math.min(space.maxFootprint ?? Math.min(w, h), w, h);
    const need =
      Math.ceil((space.minAspect * tw - space.groundHeight[0]) / Math.max(1, space.upperHeight[0])) + 1;
    storeys = Math.min(8, Math.max(storeys, need));
  }
  const material = pickW(prng, space.materials, mul, "materials") as WallStyle;
  const baseMaterial =
    space.baseMaterials && prng.chance(space.baseChance ?? 0)
      ? (pickW(prng, space.baseMaterials, mul, "baseMaterials") as WallStyle)
      : material;
  let roof = pickW(prng, space.roofs, mul, "roofs");
  if (archetype === "shed" && roof !== "flat") roof = "shed";
  const parapet = space.parapets ? pickW(prng, space.parapets, mul, "parapets") : "none";
  const rooftop: string[] = [];
  if (space.rooftop) {
    const n = Math.round(range(prng, space.rooftopCount ?? [1, 1], 1));
    for (let i = 0; i < n * 3 && rooftop.length < n; i++) {
      const s = pickW(prng, space.rooftop, mul, "rooftop");
      if (!rooftop.includes(s)) rooftop.push(s);
    }
  }
  const windows = pickW(prng, space.windows, mul, "windows");
  const base = pickW(prng, space.bases, mul, "bases");
  const top = space.tops ? pickW(prng, space.tops, mul, "tops") : "same";
  // an attic top on a one-storey house is a storey and a half: the attic is the second storey
  // (generator 3: no, the attic of a one-storey house is the roof itself, its floor on the eave line)
  if (top === "attic" && storeys === 1 && archetype !== "shed" && !space.roofShare) storeys = 2;
  // later axes (drawn after the first ones, so adding them kept the earlier draws)
  const details: string[] = [];
  if (space.details) {
    const n = Math.round(range(prng, space.detailCount ?? [1, 1], 1));
    for (let i = 0; i < n * 3 && details.length < n; i++) {
      const s = pickW(prng, space.details, mul, "details");
      if (!details.includes(s)) details.push(s);
    }
  }
  const serviceDoor = prng.chance(space.serviceDoor ?? 0);
  const footing = space.footings ? pickW(prng, space.footings, mul, "footings") : "style";
  const size = space.sizes ? pickW(prng, space.sizes, mul, "sizes") : "full";
  const sw = sizeOf(size, w, h);
  if (Math.min(sw.w, sw.h) < 5 && ["podium", "setback", "stepped", "ell", "twin", "lean"].includes(archetype))
    archetype = Math.min(sw.w, sw.h) >= 4 && archetype === "lean" ? "lean" : "box";
  const roofSurface = space.roofSurfaces ? pickW(prng, space.roofSurfaces, mul, "roofSurfaces") : "default";
  const parapetLower = space.lowerParapets ? pickW(prng, space.lowerParapets, mul, "lowerParapets") : parapet;
  // the crown keeps to a material related to the walls (the same, or one the style pairs with it)
  const crownSpace = space.crownFor?.[material] ?? space.crowns;
  let crown = crownSpace ? pickW(prng, crownSpace, mul, "crowns") : "same";
  // a treatment replaces the materials drawn above with a set that belongs together (drawn last: the other styles'
  // earlier draws stay as they were)
  let treatment = "";
  let mat = material;
  let baseMat = baseMaterial;
  if (space.treatments) {
    const tw: Record<string, number> = {};
    for (const [k, t] of Object.entries(space.treatments)) tw[k] = t.weight;
    treatment = pickW(prng, tw, mul, "treatments");
    const t = space.treatments[treatment];
    if (t) {
      mat = t.material;
      baseMat = t.base;
      crown = pickW(prng, t.crowns, mul, "crowns");
    }
  }
  const roofKit = space.roofKits ? pickW(prng, space.roofKits, mul, "roofKits") : "";
  // generator 3 (the last draw, so every earlier one stays as it was): the roof share this building aims for
  const roofShare = space.roofShare
    ? Math.round((space.roofShare[0] + (space.roofShare[1] - space.roofShare[0]) * prng.next()) * 100) / 100
    : undefined;
  return {
    ...(roofShare !== undefined ? { roofShare } : {}),
    treatment,
    roofKit,
    character: [...(character ?? [])],
    crown,
    roofSurface,
    parapetLower,
    details,
    serviceDoor,
    footing,
    size,
    use: u,
    archetype,
    storeys,
    groundHeight: range(prng, space.groundHeight, 0.5),
    upperHeight: range(prng, space.upperHeight, 0.5),
    material: mat,
    baseMaterial: baseMat,
    roof,
    parapet,
    rooftop,
    windows,
    base,
    top,
  };
}

/** A building's signature (the variety metric): every axis of its design. */
export const designSignature = (d: BuildingDesign): string =>
  [
    d.archetype,
    d.storeys,
    d.material,
    d.baseMaterial,
    d.roof,
    d.parapet,
    d.rooftop.join("+"),
    d.windows,
    d.base,
    d.top,
    d.details.join("+"),
    d.footing,
    d.size,
    d.roofSurface,
    d.parapetLower,
    d.crown,
    d.character.join("+"),
    d.treatment ?? "",
    d.roofKit ?? "",
  ].join("|");

/** The plot a size class keeps (anchored on the street face by expandDesign). */
export function sizeOf(size: string, w: number, h: number): { w: number; h: number } {
  if (size === "compact") return { w: Math.max(3, w - 1), h: Math.max(3, h - 1) };
  if (size === "small") return { w: Math.max(3, Math.ceil(w * 0.6)), h: Math.max(3, Math.ceil(h * 0.7)) };
  return { w, h };
}

const WINDOW_PATTERNS: Record<string, { density: Storey["windows"]; width: 1 | 2 }> = {
  punched: { density: "regular", width: 1 },
  paired: { density: "regular", width: 2 },
  ribbon: { density: "dense", width: 2 },
  tall: { density: "dense", width: 1 },
  sparse: { density: "sparse", width: 1 },
};
export const windowPattern = (p: string): { density: Storey["windows"]; width: 1 | 2 } =>
  WINDOW_PATTERNS[p] ?? { density: "regular", width: 1 };

/** Can the plan's spec take a drawn design? Only when shape and looks are left to the style. */
export function designable(st: Building): { x: number; y: number; w: number; h: number } | null {
  if (
    st.volumes !== undefined ||
    st.footprint !== undefined ||
    Array.isArray(st.storeys) ||
    st.roof !== undefined
  )
    return null;
  if (!st.wings || st.wings.length !== 1) return null;
  const r = st.wings[0];
  return r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
}

const roofOf = (
  kind: string,
  front: Side,
  parapet: string | null,
  kit: string | undefined,
): Roof | "none" => {
  const p = parapet === null ? "none" : (parapet as WallStyle);
  const k = kit !== undefined ? { style: kit } : {};
  switch (kind) {
    case "flat":
      return { type: "flat", parapet: p };
    case "shed":
      return { type: "shed", low: front, ...k };
    case "skirt":
      return {
        type: "skirt",
        ...k,
        layers: [
          { type: "skirt", ...k },
          { type: "flat", parapet: "none" },
        ],
      };
    case "skirt_spire":
      // a skirt round the top storey with a spire standing on it (a mage's tower)
      return {
        type: "skirt",
        ...k,
        layers: [
          { type: "skirt", ...k },
          { type: "spire", ...k },
        ],
      };
    case "stepped":
      return {
        type: "stepped",
        courses: 1,
        ...k,
        layers: [
          { type: "stepped", courses: 1, ...k },
          { type: "flat", parapet: p },
        ],
      };
    default:
      return { type: kind as RoofType, ...k };
  }
};

/**
 * Expand a design into plan fields on the building (volumes with storeys and roofs, windows, plinth, openings,
 * furniture). `front` is the street face; masses step back from it, never toward it.
 */
export function expandDesign(
  st: Building,
  d: BuildingDesign,
  rect: { x: number; y: number; w: number; h: number },
  front: Side,
  profile: GeneratorProfile,
  pitchedKit?: string,
  opts: {
    parapetFor?: Readonly<Record<string, string>>;
    rearOpen?: boolean;
    atticHeight?: number;
    maxFootprint?: number;
    turret?: boolean;
    /** Generator 3: heights the roof-share balance needs from the style (footing course, attic deck). */
    roofBalance?: { footing: number; deck: boolean };
  } = {},
): Building {
  const pat = windowPattern(d.windows);
  // a way in that may be the main door (gen/openingKinds.ts openingTests: generator 4 asks the kind table)
  const entrance = openingTests(profile).entrance;
  const own = d.parapet === "walls" ? (opts.parapetFor?.[d.material] ?? d.material) : d.parapet;
  const parapet = own === "none" ? null : own;
  const storeyList = (n: number, first: boolean, roofStorey: boolean): Storey[] =>
    Array.from({ length: n }, (_, i) => {
      const s: Storey = {
        walls: i === 0 && first ? d.baseMaterial : d.material,
        height: i === 0 && first ? d.groundHeight : d.upperHeight,
      };
      if (!(i === 0 && first)) s.windows = pat.density as NonNullable<Storey["windows"]>;
      if (i === 0 && first && d.footing !== "style") s.footing = d.footing as WallStyle | "none";
      if (roofStorey && i === n - 1 && n > 1 && d.crown !== "same") s.walls = d.crown as WallStyle;
      if (roofStorey && i === n - 1 && n > 1 && d.top === "attic") {
        s.height = opts.atticHeight ?? Math.max(2, d.upperHeight - 1);
        // a knee wall under the roof (generator 3) has no room for a window
        s.windows = s.height < 1.5 ? "none" : "sparse";
      }
      return s;
    });
  const plot = { ...rect };
  // the size class keeps part of the plot, on the street face, centred along it
  const alongX = front === "N" || front === "S";
  const sz = sizeOf(d.size, alongX ? rect.w : rect.h, alongX ? rect.h : rect.w);
  const fw = alongX ? sz.w : sz.h;
  const fh = alongX ? sz.h : sz.w;
  const x = rect.x + (alongX ? Math.floor((rect.w - fw) / 2) : front === "E" ? rect.w - fw : 0);
  const y = rect.y + (alongX ? (front === "S" ? rect.h - fh : 0) : Math.floor((rect.h - fh) / 2));
  const w = fw;
  const h = fh;
  rect = { x, y, w, h };
  // a tower keeps its proportion on a big plot: it stands in the middle on a stepped base that fills the plot
  let towerBase: { margin: number } | null = null;
  if (opts.maxFootprint !== undefined && Math.min(rect.w, rect.h) > opts.maxFootprint) {
    const tw = opts.maxFootprint;
    const margin = Math.min(4, Math.floor((Math.min(rect.w, rect.h) - tw) / 2));
    rect = {
      x: rect.x + Math.floor((rect.w - tw) / 2),
      y: rect.y + Math.floor((rect.h - tw) / 2),
      w: tw,
      h: tw,
    };
    if (margin >= 1) towerBase = { margin };
  }
  // the depth axis runs away from the street; "back" is the far side
  const depth = alongX ? rect.h : rect.w;
  const width = alongX ? rect.w : rect.h;
  /** A sub-rect: `a0..a0+aw` along the frontage, `d0..d0+dd` cells back from the front face. */
  const sub = (
    a0: number,
    aw: number,
    d0: number,
    dd: number,
  ): { x: number; y: number; w: number; h: number } => {
    if (alongX)
      return { x: rect.x + a0, y: front === "S" ? rect.y + rect.h - d0 - dd : rect.y + d0, w: aw, h: dd };
    return { x: front === "E" ? rect.x + rect.w - d0 - dd : rect.x + d0, y: rect.y + a0, w: dd, h: aw };
  };
  // a gable across the plot (ridge on the short axis) instead of along it
  const crossRidge: "ew" | "ns" = w >= h ? "ns" : "ew";
  const top =
    d.roof === "gable_cross"
      ? ({
          type: "gable",
          ridge: crossRidge,
          ...(pitchedKit !== undefined ? { style: pitchedKit } : {}),
        } as Roof)
      : roofOf(d.roof, front, parapet, pitchedKit);
  // lower flat roofs (podium, setback, steps) take their own parapet; every flat roof the drawn surface kit
  const lowOwn = d.parapetLower === "walls" ? (opts.parapetFor?.[d.material] ?? d.material) : d.parapetLower;
  const surface = d.roofSurface === "default" ? {} : { style: d.roofSurface };
  const flat = {
    ...(roofOf("flat", front, lowOwn === "none" ? null : lowOwn, undefined) as Roof),
    ...surface,
  };
  if (top !== "none" && isFlatRoof(top.type)) Object.assign(top, surface);
  // a second mass beside the main one: pitched like it, or flat when the main roof is flat
  const second = ["flat", "skirt", "stepped", "spire", "skirt_spire"].includes(d.roof) ? flat : top;
  const n = d.storeys;
  let volumes: Volume[];
  switch (d.archetype) {
    case "setback": {
      // the top storey steps back from the street (and in from the sides on a wide plot)
      const lower = Math.max(1, n - 1);
      const side = width >= 7 ? 1 : 0;
      volumes = [
        { id: "main", ...rect, storeys: storeyList(lower, true, false), roof: flat },
        {
          id: "top",
          ...sub(side, width - 2 * side, 2, Math.max(2, depth - 2)),
          on: "main",
          storeys: storeyList(1, false, true),
          roof: top,
        },
      ];
      break;
    }
    case "podium": {
      const inset = width >= 9 ? 2 : 1;
      volumes = [
        { id: "podium", ...rect, storeys: storeyList(1, true, false), roof: flat },
        {
          id: "tower",
          ...sub(inset, width - 2 * inset, inset, Math.max(2, depth - 2 * inset)),
          on: "podium",
          storeys: storeyList(Math.max(2, n), false, true),
          roof: top,
        },
      ];
      break;
    }
    case "twin": {
      const a = Math.max(2, Math.floor(width / 2));
      volumes = [
        { id: "a", ...sub(0, a, 0, depth), storeys: storeyList(n, true, true), roof: top },
        {
          id: "b",
          ...sub(a, width - a, 0, depth),
          storeys: storeyList(Math.max(1, n - 1 - (n > 3 ? 1 : 0)), true, true),
          roof: second,
        },
      ];
      break;
    }
    case "ell": {
      const frontDepth = Math.max(2, Math.ceil(depth / 2));
      const wingW = Math.max(2, Math.ceil(width / 2));
      volumes = [
        { id: "front", ...sub(0, width, 0, frontDepth), storeys: storeyList(n, true, true), roof: top },
        {
          id: "wing",
          ...sub(0, wingW, frontDepth, depth - frontDepth),
          storeys: storeyList(Math.max(1, n - 1), true, true),
          roof: second,
        },
      ].filter((v) => v.w > 0 && v.h > 0);
      break;
    }
    case "stepped": {
      // storeys step back from the street, one band of two cells per step
      const steps = Math.min(n - 1, Math.floor((depth - 2) / 2));
      volumes = [
        {
          id: "s0",
          ...rect,
          storeys: storeyList(Math.max(1, n - steps), true, steps === 0),
          roof: steps === 0 ? top : flat,
        },
      ];
      for (let k = 1; k <= steps; k++)
        volumes.push({
          id: `s${k}`,
          ...sub(0, width, 2 * k, depth - 2 * k),
          on: `s${k - 1}`,
          storeys: storeyList(1, false, k === steps),
          roof: k === steps ? top : flat,
        });
      break;
    }
    case "lean": {
      // a main house with a lower lean-to along one side, its roof falling away from the house
      const lw = width >= 7 ? 2 : 1;
      const left = (h32ish(d) & 1) === 0;
      const mainR = sub(left ? lw : 0, width - lw, 0, depth);
      const leanR = sub(left ? 0 : width - lw, lw, 0, depth);
      const low: Side = alongX ? (left ? "W" : "E") : left ? "N" : "S";
      volumes = [
        { id: "main", ...mainR, storeys: storeyList(n, true, true), roof: top },
        {
          id: "lean",
          ...leanR,
          // (generator 3: never under two tiles, a window piece needs the height)
          storeys: [
            {
              walls: d.baseMaterial,
              height: Math.max(opts.roofBalance ? 2 : 1.5, d.groundHeight - 0.5),
              // generator 5 (`leanUnderMain`): on the house's own footing (it stood a course higher than a house with none)
              ...(profile.leanUnderMain && d.footing !== "style"
                ? { footing: d.footing as WallStyle | "none" }
                : {}),
            },
          ],
          // (generator 5, `leanUnderMain`: flat beside a flat-roofed house, as every second mass is)
          roof:
            profile.leanUnderMain && second === flat
              ? flat
              : { type: "shed", low, ...(pitchedKit !== undefined ? { style: pitchedKit } : {}) },
        },
      ];
      break;
    }
    case "shaft": {
      volumes = shaftVolumes(
        d,
        rect,
        front,
        storeyList,
        top,
        flat,
        opts.turret ?? d.details.includes("turret"),
        plot,
      );
      break;
    }
    case "shed":
      volumes = [
        {
          id: "main",
          ...rect,
          storeys: [{ walls: d.material, height: Math.max(3.5, d.groundHeight + 0.5), windows: "sparse" }],
          roof: top,
        },
      ];
      break;
    default:
      volumes = [{ id: "main", ...rect, storeys: storeyList(n, true, true), roof: top }];
  }
  if (d.roofShare !== undefined && opts.roofBalance) balanceRoofs(volumes, d, opts.roofBalance);
  const out: Building = { ...st, volumes, front };
  if (towerBase && st.plinth === undefined)
    out.plinth = { height: 1, margin: towerBase.margin, approach: "steps", rim: "none" };
  delete out.wings;
  out.windows = pat.density as NonNullable<Building["windows"]>;
  if (d.base === "shopfront") out.shopfront = st.shopfront ?? true;
  else if (st.shopfront === undefined) out.shopfront = false;
  if (d.base === "stoop" && st.plinth === undefined)
    out.plinth = { height: 1, margin: 1, sides: [front], approach: "steps", rim: "none" };
  // a garage needs a door a cart goes through: a kind that is wider than a cell (a double door)
  if (d.base === "garage" && !(st.openings ?? []).some((o) => OPENING_KIND_INFO[o.kind].defaultWidth >= 2))
    out.openings = [{ kind: "double_door", side: front, position: 0.5, width: 2 }, ...(st.openings ?? [])];
  // a service door at the back, when the back looks onto open ground
  const back = OPPOSITE[front];
  if (d.serviceDoor && opts.rearOpen && !(st.openings ?? []).some((o) => o.side === back)) {
    const list = out.openings ?? st.openings ?? [];
    // the main entrance is always on the street face: a service door must never stand in for it (the resolver
    // only adds a door when the building has none)
    const mainDoor = list.some((o) => (o.storey ?? 0) === 0 && entrance(o.kind));
    out.openings = [
      ...(mainDoor ? [] : [{ kind: "door" as const, side: front }]),
      ...list,
      { kind: "door", side: back, position: 0.3 },
    ];
  }
  const sets = new Set(d.rooftop);
  out.roofFurniture = {
    hut: sets.has("hut"),
    mast: sets.has("mast"),
    clutter: sets.has("plant") || sets.has("storage") || sets.has("terrace") ? 0.18 : 0,
    ...(st.roofFurniture ?? {}),
  };
  return out;
}

/**
 * Generator 3: the roof is the larger part of a cottage or inn, and roofs on one building stand at different heights.
 * 1. The highest pitched roof is brought to the building's drawn share of the visible height by lowering the walls:
 *    the top storey first (a knee wall under the roof, the storey inside it, down to a tile), then the ground storey.
 * 2. Every other pitched ground volume (a cross wing, a lean-to) has its ridge at least a tile below the main ridge: its
 *    top storey is lowered, and when it cannot go lower the main walls rise by half a tile (at most a tile).
 * The heights are those of the resolver (footing course, floor thickness, deck), the roof rise the roof module's own.
 */
/** A volume's wall top above the ground (its footing course, storeys and the floors between them). */
function wallTopOf(v: Volume, footing: number): number {
  const FLOOR = 0.5;
  let t = 0;
  (Array.isArray(v.storeys) ? v.storeys : []).forEach((s, i) => {
    const foot = i === 0 && v.on === undefined ? (s.footing === "none" ? 0 : footing) : 0;
    t += (i > 0 ? FLOOR : 0) + foot + (s.height ?? 2);
  });
  return t;
}

/** The pitched ground volumes of a design with their wall tops and ridges (tiles above the ground), highest first. */
function pitchedRidges(
  volumes: readonly Volume[],
  opts: { footing: number; deck: boolean },
): Array<{ v: Volume; wall: number; ridge: number }> {
  const wallOf = (v: Volume): number => wallTopOf(v, opts.footing);
  const riseOf = (v: Volume): number => {
    const r = v.roof;
    if (!r || r === "none") return -1;
    // only a pitched roof has a ridge to balance
    if (!isPitchedRoof(r.type)) return -1;
    const wing = { x: v.x, y: v.y, w: v.w, h: v.h, ridge: r.ridge ?? defaultRidge(v.w, v.h) };
    return roofRise(r.type, wing, { low: r.low ?? "S" });
  };
  return volumes
    .filter((v) => v.on === undefined)
    .map((v) => ({ v, wall: wallOf(v), rise: riseOf(v) }))
    .filter((m) => m.rise >= 0)
    .map((m) => ({ v: m.v, wall: m.wall, ridge: m.wall + (opts.deck ? 0.5 : 0) + m.rise }))
    .sort((a, b) => b.ridge - a.ridge);
}

/**
 * Generator 5 (`leanUnderMain`): whether a lower ground mass of a drawn building (a lean-to, an ell's wing, a twin's
 * second half: any ground volume after the first) has its ridge within a tile of the main mass's or above it. A
 * lean-to over the house's ridge shows its high edge and gable fill above the roofline (the workshop's "battlements").
 */
export function lowerMassReachesMain(b: Building, opts: { footing: number; deck: boolean }): boolean {
  const ground = (b.volumes ?? []).filter((v) => v.on === undefined);
  const main = ground[0];
  if (!main) return false;
  const ridges = pitchedRidges(ground, opts);
  // the main mass's ridge, or (a flat or open top) its wall top: a pitched lower mass must stay a tile under the one and
  // under the other
  const pitchedMain = ridges.find((m) => m.v === main);
  if (pitchedMain) return ridges.some((m) => m.v !== main && m.ridge > pitchedMain.ridge - 1 + 1e-9);
  const wall = wallTopOf(main, opts.footing);
  return ridges.some((m) => m.v !== main && m.ridge > wall + 1e-9);
}

function balanceRoofs(volumes: Volume[], d: BuildingDesign, opts: { footing: number; deck: boolean }): void {
  const list = (v: Volume): Storey[] => (Array.isArray(v.storeys) ? v.storeys : []);
  const pitched = (): Array<{ v: Volume; wall: number; ridge: number }> => pitchedRidges(volumes, opts);
  // a storey a half tile lower (a tile at the least under a roof; a ground storey of one keeps `min`)
  const lower = (v: Volume, min: number): boolean => {
    const ss = list(v);
    const top = ss[ss.length - 1];
    if (!top) return false;
    const h = top.height ?? 2;
    const floor = ss.length > 1 ? 0.5 : min;
    if (h - 0.5 < floor - 1e-9) return false;
    top.height = h - 0.5;
    // a knee wall under the roof has no room for windows (dormers and the gable ends light the attic)
    if (ss.length > 1 && top.height < 1.5) top.windows = "none";
    else if (ss.length > 1 && top.height < 2) top.windows = "sparse";
    return true;
  };
  // 1. the share: the highest roof's rise over its visible height
  for (let guard = 0; guard < 12; guard++) {
    const m = pitched()[0];
    if (!m) return;
    const rise = m.ridge - m.wall;
    if (rise / m.ridge >= (d.roofShare ?? 0) - 0.02) break;
    if (!lower(m.v, 2)) {
      // the ground storey of a house of several storeys (never below a tile and a half)
      const g = list(m.v)[0];
      if (list(m.v).length > 1 && g && (g.height ?? 2) - 0.5 >= 2 - 1e-9) g.height = (g.height ?? 2) - 0.5;
      else break;
    }
  }
  // 2. cross wings and lean-tos below the main ridge
  for (let guard = 0; guard < 24; guard++) {
    const ms = pitched();
    const main = ms[0];
    if (!main) return;
    const clash = ms.slice(1).find((o) => main.ridge - o.ridge < 1 - 1e-9);
    if (!clash) return;
    if (lower(clash.v, 2)) continue;
    // cannot go lower: the main walls rise a little (once or twice), else the wing stays as it is
    const top = list(main.v)[list(main.v).length - 1];
    if (!top || (top.height ?? 2) >= d.upperHeight + 1.5) return;
    top.height = (top.height ?? 2) + 0.5;
  }
}

/** A stable bit from the design (which side a lean-to goes). */
function h32ish(d: BuildingDesign): number {
  let x = 0;
  for (const c of `${d.archetype}${d.material}${d.roof}${d.windows}${d.storeys}`)
    x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x;
}

// ───────────────────────────── measures for the design review ─────────────────────────────

/** Signature of a resolved building's drawn design (every variety axis), or null when the plan fixed its design. */
export function structureSignature(st: ResolvedStructure): string | null {
  return st.design ? designSignature(st.design) : null;
}

/**
 * Silhouette of a resolved building: each volume's footprint rect and wall-top height above the ground floor
 * (half tiles), ";"-joined. Two buildings with the same silhouette read alike from any side and from above.
 */
export function structureSilhouette(st: ResolvedStructure): string {
  const base = st.storeys[0]?.floorTop ?? 0;
  return (st.volumes ?? [])
    .map((v) => {
      const r = v.storeys[0]?.rect;
      const top = v.storeys[v.storeys.length - 1]?.wallTop ?? base;
      return `${r?.x},${r?.y},${r?.w}x${r?.h}@${Math.round((top - base) * 2) / 2}`;
    })
    .join(";");
}

/** Wall tone of a resolved building from its style's tone table (upper walls), or null when the style has none. */
export function structureTone(st: ResolvedStructure): "dark" | "mid" | "light" | null {
  const walls = st.design?.material ?? st.storeys[st.storeys.length - 1]?.walls ?? null;
  if (!walls) return null;
  return structureStyle(st.style)?.design?.tones?.[walls] ?? null;
}

/**
 * A tower shaft with character: a base storey, then one volume per storey standing on the one below, each moved by
 * the character (twisted: a corkscrew round a 2×2 circle; leaning: one cell further one way every second storey;
 * crooked: small seeded offsets), widened when top-heavy; a crown storey a cell wider on every side (overhanging on
 * its brackets) under the drawn roof; a stair turret beside the shaft on a big enough plot. Overhangs are intended.
 */
function shaftVolumes(
  d: BuildingDesign,
  rect: { x: number; y: number; w: number; h: number },
  front: Side,
  storeyList: (n: number, first: boolean, roofStorey: boolean) => Storey[],
  top: Roof | "none",
  flat: Roof | "none",
  turret: boolean,
  plot: { x: number; y: number; w: number; h: number },
): Volume[] {
  const ch = new Set(d.character);
  let n = d.storeys + (ch.has("slender") ? 1 : 0) - (ch.has("squat") ? 2 : 0);
  n = Math.max(2, Math.min(10, n));
  let tw = Math.min(rect.w, rect.h) - (ch.has("slender") ? 1 : 0);
  tw = Math.max(3, Math.min(tw, 5 + (ch.has("squat") ? 2 : 0)));
  const x0 = rect.x + Math.floor((rect.w - tw) / 2);
  const y0 = rect.y + Math.floor((rect.h - tw) / 2);
  let h = 0;
  for (const c of `${d.archetype}${d.material}${d.storeys}${d.windows}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const turn = h & 1 ? 1 : -1; // which way the corkscrew turns
  const lean: [number, number] = front === "N" || front === "S" ? [turn, 0] : [0, turn];
  const spiral: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const offsetAt = (k: number): [number, number] => {
    let ox = 0;
    let oy = 0;
    if (ch.has("twisted")) {
      const p = spiral[(((turn > 0 ? k : -k) % 4) + 4) % 4] as [number, number];
      ox += p[0];
      oy += p[1];
    }
    if (ch.has("leaning")) {
      ox += lean[0] * Math.floor(k / 2);
      oy += lean[1] * Math.floor(k / 2);
    }
    if (ch.has("crooked") && k > 0) {
      const r = (h >>> (k % 16)) & 3;
      ox += r === 1 ? 1 : r === 2 ? -1 : 0;
      oy += r === 3 ? 1 : 0;
    }
    return [ox, oy];
  };
  // a plain shaft tapers: a wider base tier (two cells wider) for the lower third, a skirt where it steps in
  const shapeBent = ch.has("twisted") || ch.has("leaning") || ch.has("crooked") || ch.has("top_heavy");
  const tierBase = shapeBent ? 0 : Math.max(1, Math.round(n * 0.3));
  const widthAt = (k: number): number =>
    tw + (k < tierBase ? 2 : 0) + (ch.has("top_heavy") ? Math.min(2, Math.floor(k / 2)) : 0);
  const volumes: Volume[] = [];
  for (let k = 0; k < n; k++) {
    const crownStorey = k === n - 1 && n > 2;
    // the lantern room keeps the shaft's width (the spire's eave band overhangs it); top-heavy crowns spread
    const w = widthAt(k) + (crownStorey && ch.has("top_heavy") ? 2 : 0);
    const [ox, oy] = offsetAt(k);
    const vx = x0 + ox - Math.floor((w - tw) / 2);
    const vy = y0 + oy - Math.floor((w - tw) / 2);
    const st = storeyList(1, k === 0, crownStorey);
    // the base tier is built of the base (trim) material: a stone foot under a brick shaft
    if (k < Math.max(1, tierBase) && !crownStorey) (st[0] as Storey).walls = d.baseMaterial;
    if (crownStorey) {
      // the lantern room: the crown material, big windows, a little taller
      if (d.crown !== "same") (st[0] as Storey).walls = d.crown as WallStyle;
      (st[0] as Storey).windows = "dense";
      (st[0] as Storey).height = Math.max((st[0] as Storey).height ?? 3, 3.5);
    }
    if (ch.has("crooked") && k > 0)
      (st[0] as Storey).height = Math.max(2, ((st[0] as Storey).height ?? 3) + ((h >>> k) & 1 ? 0.5 : -0.5));
    volumes.push({
      id: k === 0 ? "shaft" : crownStorey ? "crown" : `s${k}`,
      x: vx,
      y: vy,
      w,
      h: w,
      ...(k > 0 ? { on: volumes[k - 1]?.id as string } : {}),
      storeys: st,
      // inside the shaft no roof: the storey above stands on the wall top, its floor closes the band (no slab edge)
      roof: crownStorey || k === n - 1 ? top : "none",
    });
  }
  // a stair turret on one side of the shaft, about half its height (its finial clear of the shaft), under its own spire
  // a ground stair turret or bartizans, not both (bartizans win: they hang where the turret would stand)
  if (turret && !d.details.includes("bartizans")) {
    const side = turn > 0 ? 1 : -1;
    const tx = front === "N" || front === "S" ? (side > 0 ? x0 + tw : x0 - 2) : x0 + 1;
    const ty = front === "N" || front === "S" ? y0 + 1 : side > 0 ? y0 + tw : y0 - 2;
    if (tx >= plot.x && ty >= plot.y && tx + 2 <= plot.x + plot.w && ty + 2 <= plot.y + plot.h)
      volumes.push({
        id: "turret",
        x: tx,
        y: ty,
        w: 2,
        h: 2,
        // the shaft's own material from the ground up (no crown material), ending well below the crown
        storeys: storeyList(Math.max(2, Math.ceil(n * 0.5) - 1), true, false).map((x) => ({
          ...x,
          walls: d.material,
        })),
        roof: { type: "spire", ...(top !== "none" && top.style !== undefined ? { style: top.style } : {}) },
      });
  }
  // bartizans: little corbelled turrets hanging off the upper shaft at different heights on different faces, each
  // under its own spire in the tower's roof material (never on the street face)
  if (d.details.includes("bartizans")) {
    const faces = (["E", "W", "N", "S"] as Side[]).filter((sd) => sd !== front);
    const count = 1 + (h % 3);
    for (let b = 0; b < count && b < faces.length; b++) {
      const side = faces[(b + (h >>> 3)) % faces.length] as Side;
      const k = Math.min(n - 2, Math.max(tierBase + 1, Math.round(n * (0.45 + 0.15 * b))));
      const host = volumes[k - 1];
      const shaftAt = volumes[k];
      if (!host || !shaftAt) continue;
      const along = 1 + ((h >>> (5 + b)) % Math.max(1, shaftAt.w - 3));
      const bx = side === "E" ? shaftAt.x + shaftAt.w : side === "W" ? shaftAt.x - 2 : shaftAt.x + along;
      const by = side === "S" ? shaftAt.y + shaftAt.h : side === "N" ? shaftAt.y - 2 : shaftAt.y + along;
      volumes.push({
        id: `bartizan${b}`,
        x: bx,
        y: by,
        w: 2,
        h: 2,
        on: host.id,
        storeys: storeyList(Math.min(2, n - k), false, false).map((x) => ({
          ...x,
          walls: d.baseMaterial,
          windows: "sparse" as const,
        })),
        roof: { type: "spire", ...(top !== "none" && top.style !== undefined ? { style: top.style } : {}) },
      });
    }
  }
  // a turret against a chamfered shaft would meet it at a cut corner: the shaft stays square then
  if (volumes.some((v) => v.id === "turret" || v.id.startsWith("bartizan")))
    for (const v of volumes) v.corners = "square";
  return volumes;
}
