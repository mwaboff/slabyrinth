/**
 * Slabyrinth — plan edit operations and version history.
 * NORMATIVE CONTRACT. Copy verbatim into packages/core/src/contracts/ops.ts.
 *
 * ONE edit language for everyone: the model (via the `edit_plan` tool), the UI (drag/rename/delete),
 * the CLI and tests all mutate plans only through `applyOps(plan, ops)`.
 * A batch is a transaction: ops apply in order to a draft; if any op fails, or the resulting plan
 * has validation errors, nothing is committed.
 */
import type {
  Area, Feature, FeatureType, Label, Level, LevelId, LevelLink, MapKind, MapPlan, Opening, PlanIssue,
  Seed, Shape, Structure, TerrainOp, ThemeId, ElementId, WallRun,
} from "./plan";

/** Element union addressable by id. `kind` discriminates the element type for `add`. */
export type NewElement =
  | { kind: "area"; level: LevelId; value: Area; /** insert index in painter order; default end */ index?: number }
  | { kind: "opening"; level: LevelId; value: Opening }
  | { kind: "wall_run"; level: LevelId; value: WallRun }
  | { kind: "feature"; level: LevelId; value: Feature }
  | { kind: "terrain"; level: LevelId; value: TerrainOp; index?: number }
  | { kind: "label"; level: LevelId; value: Label }
  | { kind: "structure"; level: LevelId; value: Structure }
  | { kind: "link"; value: LevelLink }
  | { kind: "level"; value: Omit<Level, "areas" | "openings" | "walls" | "features" | "terrain" | "labels"> & Partial<Pick<Level, "areas" | "openings" | "walls" | "features" | "terrain" | "labels">> };

export type PlanOp =
  /** Add one element (ids must be new). */
  | { op: "add"; element: NewElement }
  /** Add many features at once (common case, saves tokens). */
  | { op: "add_features"; level: LevelId; features: Feature[] }
  /**
   * Shallow-merge `set` into the element with this id (any kind incl. level). Fields set to null are
   * deleted (optional fields only). `id`, `kind` of areas and `op` of terrain ops cannot change.
   * Nested objects (shape, bounds, from/to) are replaced wholesale, not merged.
   */
  | { op: "update"; id: ElementId; set: Record<string, unknown> }
  /** Remove elements. Removing an area also removes openings whose `between` references it, unless keepDependents. Removing a level removes its contents and links touching it. */
  /**
   * `ids` may name generated features as shown ("rocks#5"): their scatter/dress op is materialized first. `where`
   * removes every feature that matches all its fields (`generatedBy` a scatter/dress op id, `type`, `rect`
   * containing the anchor cell, `level`) in one op; `ids` may then be empty.
   */
  | {
      op: "remove";
      ids: ElementId[];
      where?: {
        generatedBy?: ElementId;
        type?: FeatureType;
        rect?: { x: number; y: number; w: number; h: number };
        level?: LevelId;
      };
      keepDependents?: boolean;
    }
  /**
   * Translate elements by (dx,dy) cells. For areas with withContents=true (default), features whose
   * anchor lies inside the area, openings with explicit `at` on its boundary, and labels inside move too.
   * toLevel moves elements to another level (same x,y unless dx/dy given).
   */
  | { op: "move"; ids: ElementId[]; dx: number; dy: number; withContents?: boolean; toLevel?: LevelId }
  /** Copy elements (with contents for areas) offset by dx,dy; new ids = old id + idSuffix (must be unique). */
  | { op: "duplicate"; ids: ElementId[]; dx: number; dy: number; idSuffix: string; toLevel?: LevelId }
  /** Reorder an area or terrain op within its level list (painter order). */
  | { op: "reorder"; id: ElementId; index: number }
  /** Convert generated features of a scatter/dress op into explicit features (op is removed unless keepOp). */
  | { op: "materialize"; id: ElementId; keepOp?: boolean }
  /** Plan-level fields. */
  | { op: "set_meta"; title?: string; summary?: string | null; kind?: MapKind; seed?: Seed; theme?: ThemeId; notes?: string | null }
  /** Replace an area's shape (sugar for update {set:{shape}}). */
  | { op: "reshape"; id: ElementId; shape: Shape }
  /** Reassign numeric room keys 1..n in (level elevation, painter) order. Only on explicit user request. */
  | { op: "renumber" };

export interface OpError {
  opIndex: number;
  code: "unknown_id" | "duplicate_id" | "wrong_kind" | "immutable_field" | "invalid_value" | "unknown_level" | "not_applicable";
  message: string;
  path?: string;
  hint?: string;
}

export type ApplyResult =
  | {
      ok: true;
      plan: MapPlan;
      /** Ids added / changed / removed (after cascading). */
      changed: { added: ElementId[]; updated: ElementId[]; removed: ElementId[] };
      /** Levels whose resolved geometry may have changed. */
      dirtyLevels: LevelId[];
      /** Non-blocking issues of the NEW plan (warnings/info). */
      issues: PlanIssue[];
    }
  | {
      ok: false;
      /** Op application failures (structural). */
      opErrors: OpError[];
      /** Validation errors of the would-be plan (only if all ops applied). */
      issues: PlanIssue[];
    };

/** Pure: never mutates input. Deterministic. */
export type ApplyOps = (plan: MapPlan, ops: readonly PlanOp[]) => ApplyResult;

// ───────────────────────────── versions (semantics follow docs/ux-design.md §7) ─────────────────────────────

export type VersionAuthor = "ai" | "user" | "restore" | "system";

export interface PlanVersion {
  /** Monotonic, never reused, starts at 1. 0 = "no plan yet". */
  number: number;
  /** Version this one was derived from (the head at creation time; 0 for the first). */
  parentNumber: number;
  author: VersionAuthor;
  createdAt: string;         // ISO-8601
  /** One line: "Added crypt level", "Restored v4", "You edited notes for 4". */
  summary: string;
  /** ≤ 6 bullets written by the AI (edit_plan/create_plan `changes`); empty for user/restore. */
  changeSummary: string[];
  cause:
    | { type: "create" }                         // create_plan / import
    | { type: "ops"; ops: PlanOp[] }             // edit_plan tool or UI edit
    | { type: "restore"; from: number }          // copy of an older version as a NEW version
    | { type: "migrate"; fromSchema: string };
  /** Chat message that produced it (AI versions) — links Plan update cards to versions. */
  messageId?: string;
  /** Cost of the AI turn step that produced it (display only). */
  cost?: { currency: "USD"; amount: number } | null;
  /** Keyframe snapshot (first version, restores, migrations, every 20th); others are rebuilt by replaying ops from the nearest keyframe ancestor. */
  snapshot?: MapPlan;
}

/**
 * Versions are immutable. The HEAD is a pointer:
 *  - Undo: head ← head.parentNumber; the left version is added to `undone`.
 *  - Redo: head ← the most recent version in `undone` whose parentNumber == head; removed from `undone`.
 *  - New version while head is back: gets the next number, parentNumber = head; undone ones stay listed ("undone").
 *  - Restore vN: creates a NEW version (cause restore) whose content equals vN.
 * The model is told whenever head moved without its doing (context item, §3.6), and edit_plan.baseVersion is
 * always compared with the head NUMBER.
 */
export interface PlanHistory {
  head: number;
  versions: PlanVersion[];
  undone: number[];
  approvedVersion: number | null;
}

// ───────────────────────────── diff (Compare, Plan update cards, chunk change badges) ─────────────────────────────

export type DiffKind = "area" | "opening" | "wall_run" | "feature" | "terrain" | "label" | "link" | "level" | "meta" | "structure";

export interface PlanDiff {
  added: Array<{ id: ElementId; kind: DiffKind; levelId?: LevelId }>;
  removed: Array<{ id: ElementId; kind: DiffKind; levelId?: LevelId }>;
  /** fields = top-level field names that differ ("shape", "notes"…). */
  changed: Array<{ id: ElementId; kind: DiffKind; levelId?: LevelId; fields: string[] }>;
  /**
   * Room-level roll-up for the UI: an area counts as changed if its own fields changed OR any opening/feature/
   * label whose resolved containing area is it changed.
   */
  areas: { added: ElementId[]; changed: ElementId[]; removed: ElementId[] };
}

/** Pure: diff by id. */
export type DiffPlans = (before: MapPlan | null, after: MapPlan) => PlanDiff;
