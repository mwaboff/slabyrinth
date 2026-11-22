/** What planning a building produces (the plan of one building, its volumes and storeys) and the specs it reads. */
import type {
  Building,
  Material,
  OpeningKind,
  Roof,
  Side,
  Storey,
  Vec2,
  WallStyle,
} from "../../contracts/plan";
import type { ResolvedStructure, ResolvedVolume } from "../../contracts/resolved";
import type { RoofWing } from "../roof";
import type { RuinProfile } from "../ruin";
import type { StructureStyleProfile, WindowDensity } from "../structureStyles";
import type { Rect } from "./footprint";

export interface StoreyPlan {
  walls: WallStyle | null;
  footing: { style: WallStyle; height: number } | null;
  wallHeight: number;
  floor: Material;
  density: WindowDensity;
}

/** A volume as written (or the single "main" volume of a phase-1 building). */
export interface VolumeSpec {
  id: string;
  on: string | null;
  cells: Array<[number, number]>;
  /** The volume rect, or null for a non-rectangular footprint. */
  rect: Rect | null;
  rects: RoofWing[];
  storeys: number | Storey[] | undefined;
  storeyHeight: number | undefined;
  corners: "square" | "chamfer";
  roof: Roof | "none" | undefined;
}

export interface VStorey extends StoreyPlan {
  cells: Array<[number, number]>;
  cellSet: Set<string>;
  rect: Rect;
  seam: "skirt" | "plain" | "crenellated" | null;
  /** Floor top and wall top relative to the ground floor top. */
  relFloor: number;
  relTop: number;
}

export interface VolumePlan {
  id: string;
  on: string | null;
  corners: "square" | "chamfer";
  rects: RoofWing[];
  storeys: VStorey[];
  roof: ResolvedVolume["roof"] & { summary: ResolvedStructure["roof"] };
  /** Top of the roof deck relative to the ground floor top (where a volume "on" this one stands). */
  relRoofTop: number;
}

/** A ground-storey opening: synthetic id, the face cell and side, kind and width. */
export type GroundOpening = { id: string; kind: OpeningKind; at: Vec2; side: Side; width: number };
export type UpperOpening = ResolvedStructure["upperOpenings"][number];
export type Chimney = { at: Vec2; side: Side; wall: Vec2 };
export type Porch = {
  id: string;
  cells: Vec2[];
  side: Side;
  floor: Material;
  roof: boolean;
  /** Generator 5 (porchWear): the outer row of its roof sits this much lower. */
  sag?: number;
  /** Generator 5 (porchWear): posts of two kinds. */
  posts?: "mixed";
};

export interface BuildingPlan {
  st: Building;
  si: number;
  profile: StructureStyleProfile;
  theme: string;
  seed: number;
  volumes: VolumePlan[];
  plinth: {
    height: number;
    margin: number;
    face: Material;
    rim: WallStyle | null;
    approach: "steps" | "none";
    cells: Vec2[];
  } | null;
  furniture: NonNullable<ResolvedStructure["furniture"]>;
  lighting: NonNullable<ResolvedStructure["lighting"]>;
  condition: NonNullable<ResolvedStructure["condition"]>;
  /** Generator 3: roofs that meet are merged into valleys (ResolvedStructure.valleys). */
  valleys: boolean;
  /** Generator 4: no open roof cell (ResolvedStructure.roofFill). */
  roofFill: boolean;
  debris: NonNullable<ResolvedStructure["debris"]>;
  /** Generator 3: growth attached to the walls (heights relative to the ground floor top). */
  growth: NonNullable<ResolvedStructure["growth"]>;
  /** Generator 3, weathered or ruined: how overgrown the building is (null otherwise). */
  growthLevel?: NonNullable<ResolvedStructure["growthLevel"]> | null;
  /** Wall tops and fallen floors of a weathered or ruined building, relative to the ground floor top. */
  ruin: RuinProfile | null;
  /** Generator 5 (roofPatches): roof cells re-laid in a second roof kit. */
  roofPatch?: Vec2[] | null;
  frontage: NonNullable<ResolvedStructure["frontage"]>;
  cells: Array<[number, number]>;
  cellSet: Set<string>;
  wings: ResolvedStructure["wings"];
  storeys: VStorey[];
  roof: ResolvedStructure["roof"];
  /** Ground-storey openings: synthetic ids, the face cell and side, kind and width. */
  ground: GroundOpening[];
  upper: ResolvedStructure["upperOpenings"];
  chimneys: Chimney[];
  porches: Porch[];
  lights: Array<{ at: Vec2; side: Side }>;
  /** Cells kept free of generated dressing. */
  reserve: Set<string>;
  /** Pad height (quarter tiles) once the terrain is known. */
  pad?: number;
  /** The pad before it was raised to the ground in front of its doors: the wall ring keeps this height. */
  ringPad?: number;
}
