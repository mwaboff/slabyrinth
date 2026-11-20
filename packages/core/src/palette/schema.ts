/**
 * Zod schemas for palette files (`slabyrinth/palette@1`), user overrides and the orientation calibration
 * (`slabyrinth/orientation@1`). Unknown extra keys are tolerated (and kept) so data files can carry notes.
 */
import { z } from "zod";
import type { OrientationCalibration, Palette, PaletteOverride } from "../contracts/compiler";

const vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });
const dir = z.enum(["N", "E", "S", "W"]);
const guid = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
const quarter = z
  .number()
  .refine((v) => Math.abs(v * 4 - Math.round(v * 4)) < 1e-9, "must be a multiple of 0.25");

export const facingSchema = z.looseObject({
  front: dir.optional(),
  ascendsToward: dir.optional(),
  handleEnd: dir.optional(),
  mountsOn: dir.optional(),
});

export const geomSchema = z.looseObject({
  size: vec3,
  originAt: z.enum(["minCorner", "center", "other"]),
  boundsCenter: vec3,
  lengthAxis: z.enum(["x", "z", "square"]).optional(),
});

const footprint = z.tuple([z.number().int().min(1).max(16), z.number().int().min(1).max(16)]);

export const variantSchema = z.looseObject({
  asset: guid,
  alternates: z.array(guid).optional(),
  alternateGeom: z.record(z.string(), geomSchema).optional(),
  geom: geomSchema,
  name: z.string().optional(),
  weight: z.number().min(0).optional(),
  variant: z.string().optional(),
  tone: z.enum(["dark", "mid", "light"]).optional(),
  hue: z.string().max(24).optional(),
  footprint: footprint.optional(),
  rot: z.number().multipleOf(15).optional(),
  offset: z
    .looseObject({ x: z.number().optional(), y: z.number().optional(), z: z.number().optional() })
    .optional(),
  stack: z.looseObject({ unitHeight: quarter.refine((v) => v > 0, "must be > 0") }).optional(),
  facing: facingSchema.optional(),
  parts: z
    .array(
      z.looseObject({
        asset: guid,
        name: z.string().optional(),
        geom: geomSchema,
        offset: z
          .looseObject({ x: z.number().optional(), y: z.number().optional(), z: z.number().optional() })
          .optional(),
      }),
    )
    .optional(),
});

/**
 * `variants` may be empty only when `fallback` is set: an "alias role" that redirects to another role
 * (e.g. floor.marble → floor.stone_tile). Allowed by the contract (ruling 2026-11-18).
 */
export const roleSchema = z
  .looseObject({
    variants: z.array(variantSchema),
    footprint: footprint.optional(),
    rotation: z.enum(["fixed", "facing", "random90", "random15", "inherit"]).optional(),
    mount: z.enum(["half-cell", "full-cell", "edge-center"]).optional(),
    lengthAxis: z.enum(["x", "z", "square"]).optional(),
    height: quarter.optional(),
    greedyTiling: z.boolean().optional(),
    fallback: z.string().min(1).optional(),
    facing: facingSchema.optional(),
  })
  .refine(
    (r) => r.variants.length > 0 || r.fallback !== undefined,
    "a role needs at least one variant or a fallback",
  );

const themeId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

export const paletteSchema = z.looseObject({
  schema: z.literal("slabyrinth/palette@1"),
  id: themeId,
  name: z.string(),
  description: z.string().optional(),
  extends: themeId.optional(),
  defaults: z.looseObject({ floor: z.string(), wallStyle: z.string(), caveFloor: z.string().optional() }),
  roles: z.record(z.string(), roleSchema),
  source: z
    .looseObject({
      generatedBy: z.string().optional(),
      generatedAt: z.string().optional(),
      editedByUser: z.boolean().optional(),
    })
    .optional(),
});

export const paletteOverrideSchema = z.looseObject({
  schema: z.literal("slabyrinth/palette@1"),
  id: themeId,
  overrides: z.literal(true),
  name: z.string().optional(),
  defaults: z
    .looseObject({
      floor: z.string().optional(),
      wallStyle: z.string().optional(),
      caveFloor: z.string().optional(),
    })
    .optional(),
  roles: z.record(z.string(), roleSchema.nullable()),
});

const edge = z.object({
  rotSteps: z.tuple([z.number().int(), z.number().int()]),
  offset: z.object({ x: z.number(), z: z.number() }),
});

export const orientationSchema = z.looseObject({
  schema: z.literal("slabyrinth/orientation@1"),
  flipZ: z.boolean(),
  rotSense: z.union([z.literal(1), z.literal(-1)]),
  edgePlacement: z.object({ N: edge, E: edge, S: edge, W: edge }),
  defaultFacing: z.record(z.string(), facingSchema),
  wallFacingFeatures: z.array(z.string()).optional(),
  doorHandlePreference: z.object({ eastWestEdge: dir.optional(), northSouthEdge: dir.optional() }).optional(),
  pasteAnchor: z.enum(["min-corner", "center", "unknown"]),
  verified: z.array(z.object({ item: z.string(), by: z.string(), date: z.string() })),
});

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType, data: unknown): ParseResult<T> {
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, value: r.data as T };
  return { ok: false, error: z.prettifyError(r.error) };
}

export const parsePalette = (data: unknown): ParseResult<Palette> => parseWith<Palette>(paletteSchema, data);
export const parsePaletteOverride = (data: unknown): ParseResult<PaletteOverride> =>
  parseWith<PaletteOverride>(paletteOverrideSchema, data);
export const parseOrientation = (data: unknown): ParseResult<OrientationCalibration> =>
  parseWith<OrientationCalibration>(orientationSchema, data);
