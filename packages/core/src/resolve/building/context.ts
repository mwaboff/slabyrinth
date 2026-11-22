/**
 * What every step of planning one building reads (`BuildingCtx`): the building as planned (a drawn design replaces the
 * written one), its style profile after the street variety, its seed and draw streams, and the level it stands on.
 *
 * Draw streams (each step draws from them in a fixed order; the order is part of the output):
 *   prng   "structure"   window density, default door, door positions, chimney, window offset, porch
 *   prng2  "structure2"  set-ins, upper wall heights, seams, spire bands, plinth, roof furniture, lighting
 *   prng3  "structure3"  street variety, storey count, shopfront, roof hut
 * The condition step and the generator 3 entrance draw from streams of their own (seeded by name).
 */
import type { Building, MapPlan, PlanIssue, Vec2 } from "../../contracts/plan";
import { generatorProfile, type GeneratorProfile } from "../../plan/generator";
import { elementSeed, subSeed } from "../../util/hash";
import { createPrng, type Prng } from "../../util/prng";
import {
  DEFAULT_STRUCTURE_STYLE,
  STRUCTURE_STYLES,
  type StructureStyleProfile,
  structureStyle,
} from "../structureStyles";
import { type BuildingDesign, windowPattern } from "../structureVariety";

/** What planning a building reads and writes of the level's structure work (resolve/structure.ts StructureWork). */
export interface BuildingWork {
  issue(
    severity: PlanIssue["severity"],
    si: number,
    id: string,
    message: string,
    hint: string,
    cell?: Vec2,
  ): void;
  /** Ground cells of every building in the level ("x,y" → building id). */
  readonly neighbours: ReadonlyMap<string, string>;
  /** Generator 3: the entrance kind each building drew, in list order (the porch step appends). */
  readonly entrances: string[];
  /** Drawn designs (the condition step drops a hung detail a weathered building lost). */
  readonly designs: Map<string, { design: BuildingDesign; building: Building }>;
  /** Footprint cells of the buildings planned so far ("x,y" → building id). */
  occupied(): Map<string, string>;
}

export interface BuildingCtx {
  readonly plan: MapPlan;
  readonly gen: GeneratorProfile;
  /** The building as planned: a drawn design's expansion when one was drawn for it. */
  readonly st: Building;
  readonly si: number;
  readonly work: BuildingWork;
  /** The style profile with the design's window width and the street variety applied. */
  readonly profile: StructureStyleProfile;
  readonly designed: { design: BuildingDesign; building: Building } | undefined;
  readonly seed: number;
  readonly prng: Prng;
  readonly prng2: Prng;
  readonly prng3: Prng;
  readonly levelTheme: string;
  inBounds(x: number, y: number): boolean;
  /** A `structure_invalid` issue about this building. */
  issue(severity: PlanIssue["severity"], message: string, hint: string, cell?: Vec2): void;
}

export function startBuilding(
  plan: MapPlan,
  written: Building,
  si: number,
  work: BuildingWork,
  levelTheme: string,
  inBounds: (x: number, y: number) => boolean,
): BuildingCtx {
  let st = written;
  let profile = structureStyle(st.style);
  if (!profile) {
    work.issue(
      "warning",
      si,
      st.id,
      `building "${st.id}": unknown style "${st.style ?? ""}"; built as "${DEFAULT_STRUCTURE_STYLE}"`,
      `styles: ${Object.keys(STRUCTURE_STYLES).join(", ")}`,
    );
    profile = STRUCTURE_STYLES[DEFAULT_STRUCTURE_STYLE] as StructureStyleProfile;
  }
  const designed = work.designs.get(st.id);
  if (designed) {
    st = designed.building;
    profile = { ...profile, windows: { width: windowPattern(designed.design.windows).width } };
  }
  const seed = elementSeed(plan.seed, st.id, st.seed);
  const prng = createPrng(subSeed(seed, "structure"));
  // phase-2 draws come from their own stream, so phase-1 buildings keep their exact variety
  const prng2 = createPrng(subSeed(seed, "structure2"));
  // street variety (material, parapet, window width, storey count, shopfront, roof hut) on a third stream, drawn only
  // for styles that declare those ranges
  const prng3 = createPrng(subSeed(seed, "structure3"));
  profile = streetVariety(profile, prng3);
  const id = st.id;
  return {
    plan,
    gen: generatorProfile(plan),
    st,
    si,
    work,
    profile,
    designed,
    seed,
    prng,
    prng2,
    prng3,
    levelTheme,
    inBounds,
    issue: (severity, message, hint, cell) => {
      work.issue(severity, si, id, message, hint, cell);
    },
  };
}

/** The style's wall material, parapet and window width drawn from the ranges it declares (unchanged when none). */
function streetVariety(profile: StructureStyleProfile, prng3: Prng): StructureStyleProfile {
  const pick = <T>(xs: readonly T[] | undefined): T | undefined =>
    xs && xs.length > 0 ? xs[prng3.int(xs.length)] : undefined;
  const wallVar = pick(profile.wallVariants);
  const parVar = pick(profile.parapets);
  const winVar = pick(profile.windowWidths);
  const walls = wallVar ?? profile.walls;
  if (wallVar === undefined && parVar === undefined && winVar === undefined) return profile;
  return {
    ...profile,
    walls,
    upperWalls: wallVar ?? profile.upperWalls,
    roof: {
      ...profile.roof,
      parapet: parVar === undefined ? profile.roof.parapet : parVar === "walls" ? walls : parVar,
    },
    windows: { width: winVar ?? profile.windows.width },
  };
}
