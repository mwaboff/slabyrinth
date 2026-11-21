/**
 * PaletteView: the questions the resolver asks of a palette, answered by ONE role resolver over ONE catalog.
 *
 * The resolver lays things out before any asset exists, so it needs a few facts the palette owns: how big a rock
 * band's pieces really are (`pieceSize`), how tall the piece a room recipe stands on is (`roomPiece`), whether a theme can
 * build a covered stall (`stallForms`), how large a floor tile is (`floorTileArea`), and what a theme's floor, wall
 * style and interior character default to (`themeDefaults`). Asking them here, of the palettes the plan is compiled
 * with, is what keeps the resolver and the compiler on one answer, a user's palette included.
 *
 * Every caller hands `resolvePlan` the palettes the plan is compiled with; `resolveView` picks the view the plan's
 * generator decides from, and `paletteView` builds one view per catalog, so the resolver and the design review of
 * one build ask the same memoized questions.
 */
import type { FeatureType, Material, MapPlan, ThemeId } from "../contracts/plan";
import { GENERATOR_VERSION } from "../contracts/plan";
import type { StallForm, ThemeInterior } from "../contracts/resolved";
import { featureInfo } from "../gen/catalog";
import { featureRoles } from "../gen/surfaces";
import { generatorProfile } from "../plan/generator";
import { bundledPalettes } from "./load";
import { createPlanRoles } from "./planRoles";
import { themeChain, type ResolveOutcome, type ResolvePalettes, type VariantFilter } from "./resolve";
import { CLIFF_CREST_ROLE, CLIFF_FACE_ROLE } from "./roles";
import { coveredStallForms, roleProbe, type RoleProbe } from "./stallParts";
import { OBSERVED_TONES, TONE_RANK, type Tone } from "./tones";

export type PieceSizeFn = (
  theme: ThemeId,
  type: FeatureType,
  /** True: the asset's real outline in tiles, not its footprint in cells. */
  real?: boolean,
  /** Only the variants of this name (a market stall's bare table: `stall` + "empty"). */
  variant?: string,
) => { w: number; d: number; h: number } | undefined;

/** Generator 4, room recipes: the smallest variant of a feature type's piece (of one variant name when given) in a theme. */
export type RoomPieceFn = (
  theme: ThemeId,
  type: FeatureType,
  variant?: string,
) =>
  | {
      w: number;
      d: number;
      h: number;
      wMax: number;
      dMax: number;
      hMax: number;
      tile: boolean;
      mixed: boolean;
    }
  | undefined;

/** The canopy forms a theme can build a covered stall in (generator 4; none = the table stall of generator 3). */
export type StallFormsFn = (theme: ThemeId) => StallForm[];

export interface PaletteView {
  /** The theme a theme with no palette is asked as, and a cell with no theme reads as (palette/planRoles.ts). */
  readonly defaultTheme: ThemeId;
  /** Generator 2+: real sizes of palette-shaped generated pieces (the rock band, the pieces a small prop rests on). */
  pieceSize: PieceSizeFn;
  /** Generator 4: the piece a room recipe stands (small things resolve through gen/surfaces.ts SMALL_THINGS_ROLES). */
  roomPiece: RoomPieceFn;
  /** Generator 4: the same answer the compiler gets (palette/stallParts.ts). */
  stallForms: StallFormsFn;
  /** Largest piece of a floor role in a theme, in cells (a 1x1-only tile costs four times the pieces of a 2x2 one). */
  floorTileArea: (theme: ThemeId, material: Material) => number | undefined;
  /** The role probe the stall capability check uses, bound to a theme. */
  probe: (theme: ThemeId) => RoleProbe;
  /**
   * The defaults a theme's palette declares (`Palette.defaults`): its floor and wall style, and its cave floor and
   * interior character, each its own or the nearest along `extends`. Undefined for a theme with no palette of its own
   * (resolve/themes.ts then has them).
   */
  themeDefaults: (theme: ThemeId) => PaletteThemeDefaults | undefined;
  /**
   * How pale a theme's floor of `material` is: the tone most of its pieces carry, by weight (a variant's `tone`, else
   * what was observed of its asset, palette/tones.ts); undefined when none of its pieces has a known tone.
   */
  floorTone: (theme: ThemeId, material: Material) => Tone | undefined;
}

/** What a palette says about its theme (Palette.defaults, the optional fields read along `extends`). */
export interface PaletteThemeDefaults {
  readonly floor: string;
  readonly wallStyle: string;
  readonly caveFloor?: string;
  readonly interior?: ThemeInterior;
}

/** Feature types whose size comes from a palette role. */
const ROLE_OF: Partial<Record<FeatureType, string>> = {
  cliff_face: CLIFF_FACE_ROLE,
  cliff_crest: CLIFF_CREST_ROLE,
};

/**
 * A view of `catalog` as `generator` sees it: roles introduced after it (`minGenerator`) are hidden, and a theme with no
 * palette is asked as the catalog's default theme, the rules realize builds by (palette/planRoles.ts).
 */
export function createPaletteView(
  catalog: ResolvePalettes,
  generator: number = GENERATOR_VERSION,
): PaletteView {
  const roles = createPlanRoles(catalog, generator);
  const resolver = (theme: ThemeId, role: string, filter?: VariantFilter): ResolveOutcome =>
    roles.resolve(theme, role, filter);
  const probe = (theme: ThemeId): RoleProbe => roleProbe(resolver, theme);
  const variantsOf = (theme: ThemeId, roles: readonly string[], variant: string | undefined) => {
    for (const role of roles) {
      const vs = (resolver(theme, role).resolution?.variants ?? []).filter(
        (q) => q.weight > 0 && (variant === undefined || q.variant === variant),
      );
      if (vs.length > 0) return vs;
    }
    return [];
  };

  const roomPiece: RoomPieceFn = (theme, type, variant) => {
    const vs = variantsOf(theme, featureRoles(type), variant);
    if (vs.length === 0) return undefined;
    // a tile (a minCorner piece such as a bar counter block) stands exactly on its cell: a shift never moves it
    const tiles = vs.filter((q) => q.geom.originAt === "minCorner").length;
    return {
      w: Math.min(...vs.map((q) => q.geom.size.x)),
      d: Math.min(...vs.map((q) => q.geom.size.z)),
      h: Math.min(...vs.map((q) => q.geom.size.y)),
      wMax: Math.max(...vs.map((q) => q.geom.size.x)),
      dMax: Math.max(...vs.map((q) => q.geom.size.z)),
      hMax: Math.max(...vs.map((q) => q.geom.size.y)),
      tile: tiles === vs.length,
      mixed: tiles > 0 && tiles < vs.length,
    };
  };

  const pieceSize: PieceSizeFn = (theme, type, real, variant) => {
    // generator 3: a support a small prop rests on (gen/catalog.ts `support`; gen/place.ts toppers, `Part.on`): its real
    // outline, at the LOWEST of its variants' heights, so a prop never floats over a lower variant (one sunk into a
    // taller variant is hidden inside it)
    if (featureInfo(type).support === true && real === true) {
      const vs = variantsOf(theme, featureRoles(type), variant);
      if (vs.length === 0) return undefined;
      return {
        w: Math.min(...vs.map((q) => q.geom.size.x)),
        d: Math.min(...vs.map((q) => q.geom.size.z)),
        h: Math.min(...vs.map((q) => q.geom.size.y)),
      };
    }
    const role = ROLE_OF[type];
    if (role === undefined) return undefined;
    const res = resolver(theme, role).resolution;
    const v = res?.variants.find((q) => q.weight > 0) ?? res?.variants[0];
    if (!v) return undefined;
    if (real === true) return { w: v.geom.size.x, d: v.geom.size.z, h: v.geom.size.y };
    return { w: v.footprint[0], d: v.footprint[1], h: v.geom.size.y };
  };

  const stallForms: StallFormsFn = (theme) => coveredStallForms(probe(theme));

  const areas = new Map<string, number | undefined>();
  const floorTileArea = (theme: ThemeId, material: Material): number | undefined => {
    const key = `${theme}|${material}`;
    if (areas.has(key)) return areas.get(key);
    const vs = variantsOf(theme, [`floor.${material}`], undefined);
    const area = vs.length === 0 ? undefined : Math.max(...vs.map((v) => v.footprint[0] * v.footprint[1]));
    areas.set(key, area);
    return area;
  };

  const themeDefaults = (theme: ThemeId): PaletteThemeDefaults | undefined => {
    const own = Object.hasOwn(catalog.palettes, theme) ? catalog.palettes[theme] : undefined;
    if (own === undefined) return undefined;
    const chain = themeChain(catalog.palettes, theme).map((id) => catalog.palettes[id]?.defaults);
    const caveFloor = chain.find((d) => d?.caveFloor !== undefined)?.caveFloor;
    const interior = chain.find((d) => d?.interior !== undefined)?.interior;
    return {
      floor: own.defaults.floor,
      wallStyle: own.defaults.wallStyle,
      ...(caveFloor === undefined ? {} : { caveFloor }),
      ...(interior === undefined ? {} : { interior }),
    };
  };

  const tones = new Map<string, Tone | undefined>();
  const floorTone = (theme: ThemeId, material: Material): Tone | undefined => {
    const key = `${theme}|${material}`;
    if (tones.has(key)) return tones.get(key);
    const weight = new Map<Tone, number>();
    for (const v of variantsOf(theme, [`floor.${material}`], undefined)) {
      const t = v.tone ?? OBSERVED_TONES[v.uuid]?.tone;
      if (t !== undefined) weight.set(t, (weight.get(t) ?? 0) + v.weight);
    }
    // the heaviest tone; a tie goes to the darker one
    const tone = [...weight].sort((a, b) => b[1] - a[1] || TONE_RANK[a[0]] - TONE_RANK[b[0]])[0]?.[0];
    tones.set(key, tone);
    return tone;
  };

  return {
    defaultTheme: roles.defaultTheme,
    pieceSize,
    roomPiece,
    stallForms,
    floorTileArea,
    probe,
    themeDefaults,
    floorTone,
  };
}

const views = new WeakMap<ResolvePalettes, Map<number, PaletteView>>();

/**
 * The view of `palettes` as `generator` sees it (roles introduced after it hidden; default the newest), built once per
 * catalog object and generator (its answers are memoized), so every stage of one build shares it and a plan of one
 * generator never sees roles of a later one.
 */
export function paletteView(palettes: ResolvePalettes, generator: number = GENERATOR_VERSION): PaletteView {
  let byGenerator = views.get(palettes);
  if (!byGenerator) {
    byGenerator = new Map();
    views.set(palettes, byGenerator);
  }
  let view = byGenerator.get(generator);
  if (!view) {
    view = createPaletteView(palettes, generator);
    byGenerator.set(generator, view);
  }
  return view;
}

/**
 * The view a plan is resolved with, given the palettes it is compiled with, at the plan's own generator. From generator
 * 4 on the resolver decides from those palettes (user palettes, game availability), so a covered stall is only laid
 * out where the build can make it; the released generators decide from the bundled palettes whatever is compiled
 * (their output is frozen).
 */
export function resolveView(plan: Pick<MapPlan, "generator">, palettes: ResolvePalettes): PaletteView {
  const catalog = generatorProfile(plan).resolveWithCompilePalettes ? palettes : bundledPalettes();
  return paletteView(catalog, plan.generator);
}
