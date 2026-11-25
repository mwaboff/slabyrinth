/** What a scene check reports: one finding per fault, as data (code, where, which pieces, the measure, plain words). */
import type { Box3, Scene } from "../types/index";
import type { PlanFacts } from "./plan";
import type { SceneSpace } from "./space";

export const CHECK_CODES = [
  "shell_gap",
  "deck_hole",
  "floor_over_open",
  "roof_open",
  "floating",
  "sunk",
  "clash",
  "facing",
  "way_blocked",
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

/** "fault": the build is wrong as built; "warn": worth a look, often acceptable. */
export type Severity = "fault" | "warn";

export interface FindingPiece {
  /** Index into Scene.instances. */
  index: number;
  name: string;
  uuid: string;
  elementId: string | null;
}

export interface Finding {
  code: CheckCode;
  severity: Severity;
  where: {
    levelId: string;
    levelIndex: number;
    /** World box of the fault. */
    box: Box3;
    /** Plan cells, when the fault is on planned cells. */
    cells: Array<readonly [number, number]>;
    /** The plan element, when one owns the fault. */
    elementId: string | null;
  };
  pieces: FindingPiece[];
  /** The measurement that decided it (tiles, fractions), by name. */
  measure: Record<string, number>;
  message: string;
}

/** What every check reads. */
export interface CheckInput {
  scene: Scene;
  space: SceneSpace;
  /** What the build planned; absent for a bare slab (checks that need it are skipped). */
  plan: PlanFacts | null;
}

export interface SceneCheck {
  code: CheckCode;
  /** Needs the plan (skipped for a bare slab). */
  needsPlan: boolean;
  run(input: CheckInput): Finding[];
}
