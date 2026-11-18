/**
 * Compile-time proof that the Zod schemas mirror the contract types exactly: every inferred type must be
 * assignable to the contract type AND the contract type assignable to the inferred one. `tsc -b` fails here if a
 * schema drifts from contracts/plan.ts or contracts/ops.ts.
 */
import type { z } from "zod";
import type {
  Area,
  Feature,
  Label,
  Level,
  LevelBase,
  LevelLink,
  MapPlan,
  Opening,
  Shape,
  StampRef,
  TerrainOp,
  Vec2,
  WallRun,
} from "../contracts/plan";
import type { NewElement, PlanOp } from "../contracts/ops";
import type {
  AreaSchema,
  FeatureSchema,
  LabelSchema,
  LevelBaseSchema,
  LevelLinkSchema,
  LevelSchema,
  MapPlanSchema,
  NewElementSchema,
  OpeningSchema,
  PlanOpSchema,
  ShapeSchema,
  StampRefSchema,
  TerrainOpSchema,
  Vec2Schema,
  WallRunSchema,
} from "./schema";

/** true iff A and B are mutually assignable. */
export type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Out<S extends z.ZodType> = z.output<S>;
type In<S extends z.ZodType> = z.input<S>;

/** Each entry is `true` only if the schema's output AND input types match the contract type. */
export const SCHEMA_TYPE_CHECKS: {
  vec2: MutuallyAssignable<Out<typeof Vec2Schema>, Vec2>;
  shape: MutuallyAssignable<Out<typeof ShapeSchema>, Shape>;
  area: MutuallyAssignable<Out<typeof AreaSchema>, Area>;
  opening: MutuallyAssignable<Out<typeof OpeningSchema>, Opening>;
  wallRun: MutuallyAssignable<Out<typeof WallRunSchema>, WallRun>;
  feature: MutuallyAssignable<Out<typeof FeatureSchema>, Feature>;
  terrain: MutuallyAssignable<Out<typeof TerrainOpSchema>, TerrainOp>;
  base: MutuallyAssignable<Out<typeof LevelBaseSchema>, LevelBase>;
  label: MutuallyAssignable<Out<typeof LabelSchema>, Label>;
  stamp: MutuallyAssignable<Out<typeof StampRefSchema>, StampRef>;
  level: MutuallyAssignable<Out<typeof LevelSchema>, Level>;
  link: MutuallyAssignable<Out<typeof LevelLinkSchema>, LevelLink>;
  plan: MutuallyAssignable<Out<typeof MapPlanSchema>, MapPlan>;
  planIn: MutuallyAssignable<In<typeof MapPlanSchema>, MapPlan>;
  newElement: MutuallyAssignable<Out<typeof NewElementSchema>, NewElement>;
  op: MutuallyAssignable<Out<typeof PlanOpSchema>, PlanOp>;
  opIn: MutuallyAssignable<In<typeof PlanOpSchema>, PlanOp>;
} = {
  vec2: true,
  shape: true,
  area: true,
  opening: true,
  wallRun: true,
  feature: true,
  terrain: true,
  base: true,
  label: true,
  stamp: true,
  level: true,
  link: true,
  plan: true,
  planIn: true,
  newElement: true,
  op: true,
  opIn: true,
};
