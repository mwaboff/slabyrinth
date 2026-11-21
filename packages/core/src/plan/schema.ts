/**
 * Zod schemas mirroring contracts/plan.ts and contracts/ops.ts EXACTLY.
 *
 * - Objects are strict (unknown keys are errors: a misspelt "floorheight" must not be silently dropped).
 * - Optional fields use `exactOptional` so inferred types match the contract under exactOptionalPropertyTypes.
 * - Inferred types are assignable both ways to the contract types (compile-time check in ./schemaTypes.ts).
 * - Size limits come from PLAN_LIMITS and the contract comments. Where the contract gives no bound, a generous
 *   one is chosen so a plan can never grow unbounded (see UNSPECIFIED_LIMITS).
 *
 * Schemas check structure, types, ranges and 0.25 height steps. Cross-element rules (ids, references, keys,
 * shape degeneracy, link arithmetic…) are in validate.ts so they can carry their own issue codes and hints.
 */
import { z } from "zod";
import {
  ATTACHMENT_TYPES,
  DRESS_PRESETS,
  ROOF_TYPES,
  FEATURE_TYPES,
  GENERATOR_VERSIONS,
  LINK_KINDS,
  MATERIALS,
  OPENING_KINDS,
  PLAN_LIMITS,
  PLAN_SCHEMA,
  ROOM_PURPOSES,
  STALL_KINDS,
  WALL_STYLES,
} from "../contracts/plan";

/**
 * Bounds plan.ts leaves open; chosen by WP1 and accepted by the lead. Exported so tool descriptions can quote them.
 */
export const UNSPECIFIED_LIMITS = {
  /** |x|, |y| of any coordinate in the global grid. */
  coord: 4096,
  /** |elevation| in tiles (8 levels × 2.5 storeys fits easily). */
  elevation: 64,
  levelName: 80,
  levelNotes: 4000,
  elementLabel: 60,
  elementNotes: 2000,
  variant: 32,
  customHint: 80,
  themeId: 64,
  planId: 64,
  featureSide: 16,
  circleRadius: 80,
  minSpacing: 32,
  pathWidth: 16,
  smooth: 16,
  variants: 8,
  stampConnections: 32,
} as const;

// ───────────────────────────── primitives ─────────────────────────────

export const ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const IdSchema = z.string().regex(ID_PATTERN, { message: "id must match /^[a-z][a-z0-9_]{0,31}$/" });

const coord = z.int().min(-UNSPECIFIED_LIMITS.coord).max(UNSPECIFIED_LIMITS.coord);
export const Vec2Schema = z.tuple([coord, coord]).readonly();
export const SideSchema = z.enum(["N", "E", "S", "W"]);
export const RotationSchema = z.literal([0, 90, 180, 270]);
export const SeedSchema = z.int().min(0).max(0xffffffff);
export const ThemeIdSchema = z.string().min(1).max(UNSPECIFIED_LIMITS.themeId);
export const MapKindSchema = z.enum(["dungeon", "cave", "building", "tower", "town", "outdoor", "mixed"]);
export const MaterialSchema = z.enum(MATERIALS);
export const WallStyleSchema = z.enum(WALL_STYLES);
export const OpeningKindSchema = z.enum(OPENING_KINDS);
export const LinkKindSchema = z.enum(LINK_KINDS);
export const FeatureTypeSchema = z.enum(FEATURE_TYPES);
export const DressPresetSchema = z.enum(DRESS_PRESETS);
export const AreaKindSchema = z.enum(["room", "corridor", "cave", "building", "courtyard", "zone", "bridge"]);
export const WallModeSchema = z.enum(["auto", "perimeter", "none"]);
export const TerrainLayerSchema = z.enum(["under", "over"]);

/** Height in tiles, multiple of 0.25, in [min, max]. */
export const heightSchema = (min: number, max: number) => z.number().multipleOf(0.25).min(min).max(max);
/** Center coordinate: multiple of 0.5. */
const half = z.number().multipleOf(0.5).min(-UNSPECIFIED_LIMITS.coord).max(UNSPECIFIED_LIMITS.coord);
const unit = z.number().min(0).max(1);
const text = (max: number) => z.string().max(max);
const side = z.int().min(1).max(PLAN_LIMITS.levelSide);

// ───────────────────────────── shapes ─────────────────────────────

export const RectShapeSchema = z.strictObject({
  type: z.literal("rect"),
  x: coord,
  y: coord,
  w: side,
  h: side,
});
export const PolygonShapeSchema = z.strictObject({
  type: z.literal("polygon"),
  points: z.array(Vec2Schema).min(3).max(PLAN_LIMITS.polygonPoints),
});
export const CircleShapeSchema = z.strictObject({
  type: z.literal("circle"),
  cx: half,
  cy: half,
  r: z.number().positive().max(UNSPECIFIED_LIMITS.circleRadius),
});
export const EllipseShapeSchema = z.strictObject({
  type: z.literal("ellipse"),
  cx: half,
  cy: half,
  rx: z.number().positive().max(UNSPECIFIED_LIMITS.circleRadius),
  ry: z.number().positive().max(UNSPECIFIED_LIMITS.circleRadius),
});
export const BlobShapeSchema = z.strictObject({
  type: z.literal("blob"),
  cx: half,
  cy: half,
  r: z.number().positive().max(UNSPECIFIED_LIMITS.circleRadius),
  roughness: unit.exactOptional(),
  seed: SeedSchema.exactOptional(),
});
export const CaveShapeSchema = z.strictObject({
  type: z.literal("cave"),
  x: coord,
  y: coord,
  w: side,
  h: side,
  fill: z.number().min(0.3).max(0.7).exactOptional(),
  steps: z.int().min(0).max(8).exactOptional(),
  seed: SeedSchema.exactOptional(),
});
export const CellsShapeSchema = z.strictObject({
  type: z.literal("cells"),
  x: coord,
  y: coord,
  rows: z
    .array(
      z
        .string()
        .min(1)
        .max(PLAN_LIMITS.maskSide)
        .regex(/^[#.]+$/, { message: "mask rows may only contain '#' and '.'" }),
    )
    .min(1)
    .max(PLAN_LIMITS.maskSide),
});
export const PathShapeSchema = z.strictObject({
  type: z.literal("path"),
  points: z.array(Vec2Schema).min(1).max(PLAN_LIMITS.polygonPoints),
  width: z.int().min(1).max(5).exactOptional(),
});
const routeEnd = z.union([IdSchema, Vec2Schema]);
export const RouteShapeSchema = z.strictObject({
  type: z.literal("route"),
  from: routeEnd,
  to: routeEnd,
  width: z.literal([1, 2, 3]).exactOptional(),
  bend: z.enum(["hv", "vh"]).exactOptional(),
  openings: OpeningKindSchema.exactOptional(),
});
export const ShapeSchema = z.discriminatedUnion("type", [
  RectShapeSchema,
  PolygonShapeSchema,
  CircleShapeSchema,
  EllipseShapeSchema,
  BlobShapeSchema,
  CaveShapeSchema,
  CellsShapeSchema,
  PathShapeSchema,
  RouteShapeSchema,
]);
export const SHAPE_TYPES = [
  "rect",
  "polygon",
  "circle",
  "ellipse",
  "blob",
  "cave",
  "cells",
  "path",
  "route",
] as const;

// ───────────────────────────── elements ─────────────────────────────

export const BRIDGE_SPANS = ["arch", "flat", "plank", "natural"] as const;
export const AreaSchema = z.strictObject({
  id: IdSchema,
  kind: AreaKindSchema,
  name: text(80).exactOptional(),
  key: z.string().min(1).max(8).exactOptional(),
  labelAt: Vec2Schema.exactOptional(),
  shape: ShapeSchema,
  floor: z.union([MaterialSchema, z.literal("none")]).exactOptional(),
  floorHeight: heightSchema(-4, 4).exactOptional(),
  walls: WallModeSchema.exactOptional(),
  wallStyle: WallStyleSchema.exactOptional(),
  wallHeight: heightSchema(0.25, PLAN_LIMITS.maxHeight).exactOptional(),
  theme: ThemeIdSchema.exactOptional(),
  notes: text(2000).exactOptional(),
  readAloud: text(1500).exactOptional(),
  encounter: text(1000).exactOptional(),
  tags: z.array(z.string().min(1).max(24)).max(8).exactOptional(),
  // generator 4 vocabulary (plan/generator.ts VOCABULARY.areaFields): validation rejects it below
  purpose: z.enum(ROOM_PURPOSES).exactOptional(),
  railing: z.union([WallStyleSchema, z.literal("none")]).exactOptional(),
  broken: z.array(Vec2Schema).max(64).exactOptional(),
  crumble: z.number().min(0).max(0.6).exactOptional(),
  span: z.enum(BRIDGE_SPANS).exactOptional(),
  arch: z.number().multipleOf(0.25).min(0).max(2).exactOptional(),
});

const areaRef = z.string().min(1).max(32); // AreaId | "@outside" (checked in validate)
export const OpeningSchema = z.strictObject({
  id: IdSchema,
  kind: OpeningKindSchema,
  between: z.tuple([areaRef, areaRef]).exactOptional(),
  position: unit.exactOptional(),
  at: z.strictObject({ x: coord, y: coord, side: SideSchema }).exactOptional(),
  width: z.literal([1, 2, 3]).exactOptional(),
  label: text(UNSPECIFIED_LIMITS.elementLabel).exactOptional(),
  notes: text(UNSPECIFIED_LIMITS.elementNotes).exactOptional(),
  gmOnly: z.boolean().exactOptional(),
});

export const WallRunSchema = z.strictObject({
  id: IdSchema,
  op: z.enum(["add", "remove"]),
  points: z.array(Vec2Schema).min(2).max(PLAN_LIMITS.polygonPoints),
  style: WallStyleSchema.exactOptional(),
  height: heightSchema(0.25, PLAN_LIMITS.maxHeight).exactOptional(),
});

const featureSide = z.int().min(1).max(UNSPECIFIED_LIMITS.featureSide);
export const FeatureSchema = z.strictObject({
  id: IdSchema,
  type: FeatureTypeSchema,
  at: Vec2Schema,
  rot: RotationSchema.exactOptional(),
  size: z.tuple([featureSide, featureSide]).readonly().exactOptional(),
  wall: SideSchema.exactOptional(),
  lift: heightSchema(PLAN_LIMITS.minHeight, PLAN_LIMITS.maxHeight).exactOptional(),
  variant: z.string().min(1).max(UNSPECIFIED_LIMITS.variant).exactOptional(),
  hint: z.string().min(1).max(UNSPECIFIED_LIMITS.customHint).exactOptional(),
  label: text(UNSPECIFIED_LIMITS.elementLabel).exactOptional(),
  notes: text(UNSPECIFIED_LIMITS.elementNotes).exactOptional(),
  gmOnly: z.boolean().exactOptional(),
});

const terrainHeight = heightSchema(PLAN_LIMITS.minHeight, PLAN_LIMITS.maxHeight);
const layer = TerrainLayerSchema.exactOptional();
export const AVOID_VALUES = ["water", "paths", "areas", "walls", "features", "links"] as const;

export const PaintOpSchema = z.strictObject({
  id: IdSchema,
  op: z.literal("paint"),
  shape: ShapeSchema,
  material: MaterialSchema,
  layer,
});
export const HeightOpSchema = z.strictObject({
  id: IdSchema,
  op: z.literal("height"),
  shape: ShapeSchema,
  delta: terrainHeight.exactOptional(),
  set: terrainHeight.exactOptional(),
  smooth: z.int().min(0).max(UNSPECIFIED_LIMITS.smooth).exactOptional(),
  layer,
  edge: z.enum(["ragged", "clean"]).exactOptional(),
});
export const NoiseOpSchema = z.strictObject({
  id: IdSchema,
  op: z.literal("noise"),
  shape: ShapeSchema,
  material: MaterialSchema,
  coverage: unit,
  scale: z.number().min(2).max(32).exactOptional(),
  seed: SeedSchema.exactOptional(),
  layer,
});
export const PathOpSchema = z.strictObject({
  id: IdSchema,
  op: z.literal("path"),
  points: z.array(Vec2Schema).min(2).max(PLAN_LIMITS.polygonPoints).exactOptional(),
  connect: z
    .array(z.union([IdSchema, Vec2Schema]))
    .min(2)
    .max(16)
    .exactOptional(),
  kerb: z.boolean().exactOptional(),
  style: z.enum(["natural", "straight"]).exactOptional(),
  sidewalk: z
    .strictObject({
      width: z.int().min(1).max(6),
      material: MaterialSchema,
      raise: heightSchema(0, 1).exactOptional(),
    })
    .exactOptional(),
  crossings: z.array(unit).max(8).exactOptional(),
  width: z.int().min(1).max(UNSPECIFIED_LIMITS.pathWidth),
  material: MaterialSchema,
  jitter: unit.exactOptional(),
  seed: SeedSchema.exactOptional(),
  layer,
});
export const ScatterOpSchema = z.strictObject({
  id: IdSchema,
  op: z.literal("scatter"),
  feature: FeatureTypeSchema,
  shape: ShapeSchema.exactOptional(),
  exclude: z.array(ShapeSchema).max(8).exactOptional(),
  density: unit,
  minSpacing: z.number().min(0).max(UNSPECIFIED_LIMITS.minSpacing).exactOptional(),
  avoid: z.array(z.enum(AVOID_VALUES)).max(AVOID_VALUES.length).exactOptional(),
  variants: z
    .array(z.string().min(1).max(UNSPECIFIED_LIMITS.variant))
    .max(UNSPECIFIED_LIMITS.variants)
    .exactOptional(),
  randomRotation: z.boolean().exactOptional(),
  seed: SeedSchema.exactOptional(),
});
export const DressOpSchema = z.strictObject({
  id: IdSchema,
  op: z.literal("dress"),
  area: IdSchema.exactOptional(),
  preset: DressPresetSchema,
  density: unit.exactOptional(),
  seed: SeedSchema.exactOptional(),
});
export const ChasmBridgeSchema = z.strictObject({
  at: unit.exactOptional(),
  width: z.int().min(1).max(4).exactOptional(),
  floor: MaterialSchema.exactOptional(),
  railing: z.union([WallStyleSchema, z.literal("none")]).exactOptional(),
  crumble: z.number().min(0).max(0.6).exactOptional(),
  span: z.enum(BRIDGE_SPANS).exactOptional(),
  arch: z.number().multipleOf(0.25).min(0).max(2).exactOptional(),
});
export const ChasmOpSchema = z.strictObject({
  id: IdSchema,
  op: z.literal("chasm"),
  points: z.array(Vec2Schema).min(2).max(PLAN_LIMITS.polygonPoints),
  width: z.number().min(1).max(12),
  depth: heightSchema(0.5, -PLAN_LIMITS.minHeight).exactOptional(),
  meander: unit.exactOptional(),
  floor: z.union([MaterialSchema, z.literal("none")]).exactOptional(),
  bridges: z.array(ChasmBridgeSchema).max(4).exactOptional(),
  seed: SeedSchema.exactOptional(),
});
export const PlatformOpSchema = z.strictObject({
  id: IdSchema,
  op: z.literal("platform"),
  shape: ShapeSchema,
  tiers: z.int().min(1).max(5).exactOptional(),
  rise: heightSchema(-2, 2)
    .refine((v) => v !== 0, { message: "rise must not be 0" })
    .exactOptional(),
  inset: z.int().min(1).max(4).exactOptional(),
  material: MaterialSchema.exactOptional(),
  topMaterial: MaterialSchema.exactOptional(),
  stairs: z.array(SideSchema).max(4).exactOptional(),
  edge: z.enum(["ragged", "clean"]).exactOptional(),
});
export const StairsOpSchema = z.strictObject({
  id: IdSchema,
  op: z.literal("stairs"),
  from: Vec2Schema,
  to: Vec2Schema,
  width: z.int().min(1).max(6).exactOptional(),
  style: z.enum(["stairs", "ramp"]).exactOptional(),
});
export const UnevenOpSchema = z.strictObject({
  id: IdSchema,
  op: z.literal("uneven"),
  shape: ShapeSchema.exactOptional(),
  exclude: z.array(ShapeSchema).max(8).exactOptional(),
  amount: heightSchema(0.25, 1).exactOptional(),
  scale: z.number().min(3).max(12).exactOptional(),
  seed: SeedSchema.exactOptional(),
});
export const OutcropOpSchema = z.strictObject({
  id: IdSchema,
  op: z.literal("outcrop"),
  shape: ShapeSchema,
  height: heightSchema(0.5, 4).exactOptional(),
  material: MaterialSchema.exactOptional(),
});
export const FloorOpeningOpSchema = z.strictObject({
  id: IdSchema,
  op: z.literal("floor_opening"),
  shape: ShapeSchema,
  kind: z.enum(["collapse", "shaft", "balcony"]).exactOptional(),
  edge: z.enum(["ragged", "clean"]).exactOptional(),
  rim: z.union([WallStyleSchema, z.literal("none")]).exactOptional(),
  rubble: z.boolean().exactOptional(),
});
export const TerrainOpSchema = z.discriminatedUnion("op", [
  FloorOpeningOpSchema,
  PaintOpSchema,
  HeightOpSchema,
  NoiseOpSchema,
  PathOpSchema,
  ScatterOpSchema,
  DressOpSchema,
  ChasmOpSchema,
  PlatformOpSchema,
  StairsOpSchema,
  UnevenOpSchema,
  OutcropOpSchema,
]);
export const TERRAIN_OP_KINDS = [
  "paint",
  "height",
  "noise",
  "path",
  "scatter",
  "dress",
  "chasm",
  "platform",
  "stairs",
  "uneven",
  "outcrop",
  "floor_opening",
] as const;

export const LevelBaseSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("solid") }),
  z.strictObject({ type: z.literal("void") }),
  z.strictObject({ type: z.literal("ground"), material: MaterialSchema }),
]);

export const LabelSchema = z.strictObject({
  id: IdSchema,
  text: z.string().min(1).max(60),
  at: Vec2Schema,
  size: z.enum(["s", "m", "l"]).exactOptional(),
});

export const StampRefSchema = z.strictObject({
  id: IdSchema,
  stampId: z.string().min(1).max(128),
  at: Vec2Schema,
  rot: RotationSchema,
  lift: terrainHeight.exactOptional(),
  name: z.string().max(80),
  description: text(1000).exactOptional(),
  connections: z
    .array(z.strictObject({ at: Vec2Schema, side: SideSchema, label: text(60).exactOptional() }))
    .max(UNSPECIFIED_LIMITS.stampConnections)
    .exactOptional(),
  notes: text(UNSPECIFIED_LIMITS.elementNotes).exactOptional(),
});

// ───────────────────────────── structures (generator 2) ─────────────────────────────

const windowDensity = z.enum(["none", "sparse", "regular", "dense"]);
const wallOrNone = z.union([WallStyleSchema, z.literal("none")]);
export const StoreySchema = z.strictObject({
  walls: wallOrNone.exactOptional(),
  footing: wallOrNone.exactOptional(),
  floor: MaterialSchema.exactOptional(),
  windows: windowDensity.exactOptional(),
  inset: z.int().min(0).max(2).exactOptional(),
  height: z.number().multipleOf(0.25).min(1).max(8).exactOptional(),
  seam: z.enum(["skirt", "plain", "crenellated"]).exactOptional(),
});
const roofStyle = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/)
  .exactOptional();
export const RoofLayerSchema = z.strictObject({
  type: z.enum(ROOF_TYPES),
  style: roofStyle,
  ridge: z.enum(["ew", "ns"]).exactOptional(),
  courses: z.int().min(1).max(6).exactOptional(),
  low: SideSchema.exactOptional(),
  parapet: wallOrNone.exactOptional(),
});
export const RoofSchema = z.strictObject({
  type: z.enum(ROOF_TYPES),
  layers: z.array(RoofLayerSchema).max(4).exactOptional(),
  courses: z.int().min(1).max(6).exactOptional(),
  low: SideSchema.exactOptional(),
  ridge: z.enum(["ew", "ns"]).exactOptional(),
  style: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/)
    .exactOptional(),
  deck: z.boolean().exactOptional(),
  broken: z.number().min(0).max(0.6).exactOptional(),
  parapet: wallOrNone.exactOptional(),
});
export const StructureOpeningSchema = z.strictObject({
  kind: OpeningKindSchema,
  side: SideSchema,
  position: unit.exactOptional(),
  storey: z.int().min(0).max(11).exactOptional(),
  width: z.literal([1, 2, 3]).exactOptional(),
});
export const AttachmentSchema = z.strictObject({
  type: z.enum(ATTACHMENT_TYPES),
  side: SideSchema,
  position: unit.exactOptional(),
  width: z.int().min(1).max(8).exactOptional(),
  depth: z.int().min(1).max(3).exactOptional(),
  floor: MaterialSchema.exactOptional(),
  roof: z.enum(["flat", "none"]).exactOptional(),
});
const storeysSchema = z.union([z.int().min(1).max(12), z.array(StoreySchema).min(1).max(12)]);
export const VolumeSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,15}$/),
  x: coord,
  y: coord,
  w: side,
  h: side,
  on: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,15}$/)
    .exactOptional(),
  storeys: storeysSchema.exactOptional(),
  storeyHeight: z.number().multipleOf(0.25).min(1).max(8).exactOptional(),
  corners: z.enum(["square", "chamfer"]).exactOptional(),
  roof: z.union([RoofSchema, z.literal("none")]).exactOptional(),
  ridge: z.enum(["ew", "ns"]).exactOptional(),
});
export const PlinthSchema = z.strictObject({
  height: z.number().multipleOf(0.25).min(0.5).max(6),
  margin: z.int().min(1).max(4).exactOptional(),
  sides: z.array(SideSchema).min(1).max(4).exactOptional(),
  face: MaterialSchema.exactOptional(),
  rim: wallOrNone.exactOptional(),
  approach: z.enum(["steps", "none"]).exactOptional(),
});
const structureText = {
  name: text(80).exactOptional(),
  key: z.string().min(1).max(8).exactOptional(),
  theme: ThemeIdSchema.exactOptional(),
  notes: text(UNSPECIFIED_LIMITS.elementNotes).exactOptional(),
};
export const BuildingSchema = z.strictObject({
  id: IdSchema,
  kind: z.literal("building").exactOptional(),
  ...structureText,
  style: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/)
    .exactOptional(),
  seed: SeedSchema.exactOptional(),
  condition: z.enum(["intact", "weathered", "ruined"]).exactOptional(),
  growth: z.enum(["none", "light", "medium", "heavy"]).exactOptional(),
  character: z
    .array(z.enum(["twisted", "leaning", "crooked", "top_heavy", "squat", "slender"]))
    .max(4)
    .exactOptional(),
  // shorthand for one wing
  x: coord.exactOptional(),
  y: coord.exactOptional(),
  w: side.exactOptional(),
  h: side.exactOptional(),
  wings: z
    .array(
      z.strictObject({ x: coord, y: coord, w: side, h: side, ridge: z.enum(["ew", "ns"]).exactOptional() }),
    )
    .min(1)
    .max(8)
    .exactOptional(),
  footprint: ShapeSchema.exactOptional(),
  storeys: storeysSchema.exactOptional(),
  storeyHeight: z.number().multipleOf(0.25).min(1).max(8).exactOptional(),
  volumes: z.array(VolumeSchema).min(1).max(8).exactOptional(),
  plinth: PlinthSchema.exactOptional(),
  corners: z.enum(["square", "chamfer"]).exactOptional(),
  roof: z.union([RoofSchema, z.literal("none")]).exactOptional(),
  openings: z.array(StructureOpeningSchema).max(32).exactOptional(),
  windows: windowDensity.exactOptional(),
  chimneys: z
    .array(z.strictObject({ side: SideSchema, position: unit.exactOptional() }))
    .max(4)
    .exactOptional(),
  attachments: z.array(AttachmentSchema).max(8).exactOptional(),
  roofFurniture: z
    .strictObject({
      dormers: z.boolean().exactOptional(),
      clutter: z.number().min(0).max(0.5).exactOptional(),
      mast: z.boolean().exactOptional(),
      finial: z.boolean().exactOptional(),
      hut: z.boolean().exactOptional(),
    })
    .exactOptional(),
  front: SideSchema.exactOptional(),
  use: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,23}$/)
    .exactOptional(),
  shopfront: z.boolean().exactOptional(),
  lighting: z
    .strictObject({
      windows: z.enum(["none", "warm", "glow"]).exactOptional(),
      colour: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,23}$/)
        .exactOptional(),
      doors: z.boolean().exactOptional(),
      strips: z.boolean().exactOptional(),
    })
    .exactOptional(),
  readAloud: text(1500).exactOptional(),
  encounter: text(1000).exactOptional(),
  tags: z.array(z.string().min(1).max(24)).max(8).exactOptional(),
});
export const EnclosureSchema = z.strictObject({
  id: IdSchema,
  kind: z.literal("enclosure"),
  ...structureText,
  shape: ShapeSchema,
  wall: wallOrNone.exactOptional(),
  gates: z
    .array(
      z.strictObject({
        side: SideSchema,
        position: unit.exactOptional(),
        width: z.literal([1, 2, 3]).exactOptional(),
      }),
    )
    .max(8)
    .exactOptional(),
  floor: MaterialSchema.exactOptional(),
});
/** A building (kind omitted or "building") or an enclosure (kind "enclosure"). */
export const StructureSchema = z.union([EnclosureSchema, BuildingSchema]);

export const BoundsSchema = z.strictObject({ x: coord, y: coord, w: side, h: side });

/** Generator 3: a row or cluster of market stalls. */
export const StallRowSchema = z.strictObject({
  id: IdSchema,
  area: BoundsSchema,
  goods: z.array(z.enum(STALL_KINDS)).min(1).max(11).exactOptional(),
  facing: SideSchema.exactOptional(),
  count: z.int().min(1).max(60).exactOptional(),
  aisle: z.int().min(1).max(4).exactOptional(),
  seed: SeedSchema.exactOptional(),
});
/** Generator 3: a line strung overhead between two walls or posts. */
export const OverheadLineSchema = z.strictObject({
  id: IdSchema,
  from: Vec2Schema,
  to: Vec2Schema,
  kind: z.enum(["lanterns", "lights", "flags"]).exactOptional(),
  height: z.number().min(2).max(3).exactOptional(),
  spacing: z.int().min(2).max(6).exactOptional(),
});

const levelFields = {
  id: IdSchema,
  name: z.string().min(1).max(UNSPECIFIED_LIMITS.levelName),
  elevation: heightSchema(-UNSPECIFIED_LIMITS.elevation, UNSPECIFIED_LIMITS.elevation),
  wallHeight: heightSchema(0.25, PLAN_LIMITS.maxHeight).exactOptional(),
  foundation: heightSchema(0, 4).exactOptional(),
  outline: z.enum(["natural", "rect"]).exactOptional(),
  cliffBands: z.literal(false).exactOptional(),
  roomDress: z.literal(false).exactOptional(),
  bounds: BoundsSchema,
  base: LevelBaseSchema,
  theme: ThemeIdSchema.exactOptional(),
  stamps: z.array(StampRefSchema).exactOptional(),
  structures: z.array(StructureSchema).max(PLAN_LIMITS.structuresPerLevel).exactOptional(),
  stalls: z.array(StallRowSchema).max(8).exactOptional(),
  lines: z.array(OverheadLineSchema).max(12).exactOptional(),
  notes: text(UNSPECIFIED_LIMITS.levelNotes).exactOptional(),
};
const levelLists = {
  areas: z.array(AreaSchema).max(PLAN_LIMITS.areasPerLevel),
  openings: z.array(OpeningSchema).max(PLAN_LIMITS.openingsPerLevel),
  walls: z.array(WallRunSchema).max(PLAN_LIMITS.wallRunsPerLevel),
  features: z.array(FeatureSchema).max(PLAN_LIMITS.featuresPerLevel),
  terrain: z.array(TerrainOpSchema).max(PLAN_LIMITS.terrainOpsPerLevel),
  labels: z.array(LabelSchema).max(PLAN_LIMITS.labelsPerLevel),
};
export const LevelSchema = z.strictObject({ ...levelFields, ...levelLists });

export const LevelLinkSchema = z.strictObject({
  id: IdSchema,
  kind: LinkKindSchema,
  from: z.strictObject({ level: IdSchema, at: Vec2Schema }),
  to: z.strictObject({ level: IdSchema, at: Vec2Schema.exactOptional() }),
  dir: SideSchema.exactOptional(),
  width: z.literal([1, 2]).exactOptional(),
  label: text(UNSPECIFIED_LIMITS.elementLabel).exactOptional(),
  notes: text(UNSPECIFIED_LIMITS.elementNotes).exactOptional(),
});

export const MapPlanSchema = z.strictObject({
  schema: z.literal(PLAN_SCHEMA),
  generator: z.literal(GENERATOR_VERSIONS),
  id: z.string().min(1).max(UNSPECIFIED_LIMITS.planId),
  title: z.string().min(1).max(80),
  summary: text(1000).exactOptional(),
  kind: MapKindSchema,
  seed: SeedSchema,
  theme: ThemeIdSchema,
  levels: z.array(LevelSchema).min(1).max(PLAN_LIMITS.levels),
  entryLevel: IdSchema.exactOptional(),
  links: z.array(LevelLinkSchema).max(PLAN_LIMITS.links),
  notes: text(4000).exactOptional(),
});

// ───────────────────────────── ops (contracts/ops.ts) ─────────────────────────────

export const NewLevelSchema = z.strictObject({
  ...levelFields,
  areas: levelLists.areas.exactOptional(),
  openings: levelLists.openings.exactOptional(),
  walls: levelLists.walls.exactOptional(),
  features: levelLists.features.exactOptional(),
  terrain: levelLists.terrain.exactOptional(),
  labels: levelLists.labels.exactOptional(),
});

const index = z.int().min(0).max(10000);
export const NewElementSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("area"),
    level: IdSchema,
    value: AreaSchema,
    index: index.exactOptional(),
  }),
  z.strictObject({ kind: z.literal("opening"), level: IdSchema, value: OpeningSchema }),
  z.strictObject({ kind: z.literal("wall_run"), level: IdSchema, value: WallRunSchema }),
  z.strictObject({ kind: z.literal("feature"), level: IdSchema, value: FeatureSchema }),
  z.strictObject({
    kind: z.literal("terrain"),
    level: IdSchema,
    value: TerrainOpSchema,
    index: index.exactOptional(),
  }),
  z.strictObject({ kind: z.literal("label"), level: IdSchema, value: LabelSchema }),
  z.strictObject({ kind: z.literal("structure"), level: IdSchema, value: StructureSchema }),
  z.strictObject({ kind: z.literal("link"), value: LevelLinkSchema }),
  z.strictObject({ kind: z.literal("level"), value: NewLevelSchema }),
]);

const delta = z.int().min(-UNSPECIFIED_LIMITS.coord).max(UNSPECIFIED_LIMITS.coord);
const idList = z.array(z.string()).min(1).max(PLAN_LIMITS.featuresPerLevel);
export const PlanOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), element: NewElementSchema }),
  z.strictObject({
    op: z.literal("add_features"),
    level: IdSchema,
    features: z.array(FeatureSchema).min(1).max(PLAN_LIMITS.featuresPerLevel),
  }),
  z.strictObject({ op: z.literal("update"), id: z.string(), set: z.record(z.string(), z.unknown()) }),
  z
    .strictObject({
      op: z.literal("remove"),
      ids: z.array(z.string()).max(PLAN_LIMITS.featuresPerLevel),
      where: z
        .strictObject({
          generatedBy: IdSchema.exactOptional(),
          type: FeatureTypeSchema.exactOptional(),
          rect: z
            .strictObject({ x: coord, y: coord, w: z.int().min(1).max(512), h: z.int().min(1).max(512) })
            .exactOptional(),
          level: IdSchema.exactOptional(),
        })
        .exactOptional(),
      keepDependents: z.boolean().exactOptional(),
    })
    .refine((o) => o.ids.length > 0 || o.where !== undefined, { message: "give ids, or a where filter" }),
  z.strictObject({
    op: z.literal("move"),
    ids: idList,
    dx: delta,
    dy: delta,
    withContents: z.boolean().exactOptional(),
    toLevel: IdSchema.exactOptional(),
  }),
  z.strictObject({
    op: z.literal("duplicate"),
    ids: idList,
    dx: delta,
    dy: delta,
    idSuffix: z.string().regex(/^[a-z0-9_]{1,16}$/),
    toLevel: IdSchema.exactOptional(),
  }),
  z.strictObject({ op: z.literal("reorder"), id: z.string(), index }),
  z.strictObject({ op: z.literal("materialize"), id: z.string(), keepOp: z.boolean().exactOptional() }),
  z.strictObject({
    op: z.literal("set_meta"),
    title: z.string().min(1).max(80).exactOptional(),
    summary: text(1000).nullable().exactOptional(),
    kind: MapKindSchema.exactOptional(),
    seed: SeedSchema.exactOptional(),
    theme: ThemeIdSchema.exactOptional(),
    notes: text(4000).nullable().exactOptional(),
  }),
  z.strictObject({ op: z.literal("reshape"), id: z.string(), shape: ShapeSchema }),
  z.strictObject({ op: z.literal("renumber") }),
]);
export const PLAN_OP_KINDS = [
  "add",
  "add_features",
  "update",
  "remove",
  "move",
  "duplicate",
  "reorder",
  "materialize",
  "set_meta",
  "reshape",
  "renumber",
] as const;
