/**
 * applyOps (contracts/ops.ts): the ONE edit language for model, UI, CLI and tests.
 *
 * - Pure and deterministic: the input plan is never mutated; ops apply in order to a deep-cloned draft.
 * - Transactional: if any op fails, or the resulting plan has validation errors, nothing is committed and EVERY
 *   error is returned (op errors carry opIndex, path and a model-facing hint). Ops after a failed op still run
 *   against the draft so all problems surface in one round trip; "unknown id" errors caused only by an earlier
 *   failed op are suppressed.
 * - Id-addressed. Automatic room keys for room/cave/building/courtyard areas added without one.
 * - Cascades: removing an area removes openings whose `between` names it and dress ops on it (unless
 *   keepDependents); removing a level removes its contents and the links touching it (and clears entryLevel).
 */
import type {
  Area,
  ElementId,
  Feature,
  Level,
  LevelId,
  LevelLink,
  MapPlan,
  PlanIssue,
  Structure,
  Vec2,
} from "../contracts/plan";
import { BUILD_CONSTANTS } from "../contracts/plan";
import type { ApplyResult, NewElement, OpError, PlanOp } from "../contracts/ops";
import type { z } from "zod";
import { cloneJson } from "../util/canonical";
import { listForHint, nearest } from "../util/strings";
import { KIND_LABEL, LEVEL_LIST_KINDS, LEVEL_LIST_OF, freeId, listElements } from "../plan/elements";
import type { ElementKind, ElementLocation } from "../plan/elements";
import {
  AreaSchema,
  FeatureSchema,
  ID_PATTERN,
  LabelSchema,
  LevelLinkSchema,
  LevelSchema,
  OpeningSchema,
  PlanOpSchema,
  StampRefSchema,
  StructureSchema,
  TerrainOpSchema,
  WallRunSchema,
} from "../plan/schema";
import { KEYED_AREA_KINDS, validatePlan } from "../plan/validate";
import type { ValidateContext } from "../plan/validate";
import { zodIssueToPlanIssue } from "../plan/zodIssues";
import { across, shapeHasCell, tr, translateShape, translateStructure, translateTerrain } from "./geometry";
import type { SizeLimits } from "../plan/sizeTiers";
import { maxOf } from "../util/lists";

// ───────────────────────────── rules (the resolver supplies them) ─────────────────────────────

/**
 * Returns the features a scatter/dress op generates on the given plan (ids "<opId>#<n>", rot rounded to a
 * multiple of 90). The resolver provides it (resolve's `planRules`); applyOps renames ids to "<opId>_<n>".
 */
export type Materializer = (
  plan: MapPlan,
  levelId: LevelId,
  opId: ElementId,
) => { ok: true; features: Feature[] } | { ok: false; message: string };

/**
 * What applyOps needs from the layers above it, passed by every caller: the checks validation runs after the
 * structural ones, and the generator behind `materialize` (and behind removing generated features by their shown
 * id). Both resolve the plan, so both belong to the palettes the plan is built with: resolve's `planRules(palettes)`
 * builds them. `STRUCTURAL_RULES` has neither (structure-only validation; materializing fails with a message).
 * A `PlanRules` is also a `ValidateContext`, so `validatePlan(plan, rules)` checks what applyOps checks.
 */
export interface PlanRules {
  readonly checks: ValidateContext["checks"];
  readonly materialize: Materializer | null;
  /** The size tier plans are held to (plan/sizeTiers.ts); the standard one when absent. */
  readonly limits?: SizeLimits;
}

/** No resolver: structural validation only, and `materialize` fails with a message. */
export const STRUCTURAL_RULES: PlanRules = Object.freeze({ checks: Object.freeze([]), materialize: null });

export interface ApplyOptions {
  /** Theme ids known to the installed palettes (validation warns on unknown themes). */
  themes?: readonly string[];
  /**
   * false skips validation of the resulting plan (op errors still fail). Only for replaying history, where the
   * plan was validated when the version was committed and newer checks must not make old versions unreadable.
   */
  validate?: boolean;
}

// ───────────────────────────── state ─────────────────────────────

type Found = { loc: ElementLocation; level: Level | undefined };
type OpErrorCode = OpError["code"];

class Draft {
  readonly added = new Set<ElementId>();
  readonly updated = new Set<ElementId>();
  readonly removed = new Set<ElementId>();
  readonly dirty = new Set<LevelId>();
  readonly removedLevels: LevelId[] = [];
  readonly errors: OpError[] = [];
  /** Ids that a failed op tried to introduce (suppresses follow-on unknown_id errors). */
  readonly failedIds = new Set<ElementId>();
  opIndex = 0;

  constructor(
    readonly plan: MapPlan,
    readonly materialize: Materializer | null,
  ) {}

  err(code: OpErrorCode, path: string, message: string, hint?: string): void {
    const e: OpError = { opIndex: this.opIndex, code, message, path: `/ops/${this.opIndex}${path}` };
    if (hint !== undefined) e.hint = hint;
    this.errors.push(e);
  }

  find(id: ElementId): Found | undefined {
    const all = listElements(this.plan);
    // a generated feature is shown as "rocks#5" until it is materialized as "rocks_5": either spelling finds it
    const loc =
      all.find((e) => e.id === id) ??
      (id.includes("#") ? all.find((e) => e.id === id.replace(/#/g, "_")) : undefined);
    if (loc === undefined) return undefined;
    return { loc, level: loc.levelIndex >= 0 ? this.plan.levels[loc.levelIndex] : undefined };
  }

  ids(): Set<ElementId> {
    return new Set(listElements(this.plan).map((e) => e.id));
  }

  level(id: LevelId): Level | undefined {
    return this.plan.levels.find((l) => l.id === id);
  }

  markAdded(id: ElementId): void {
    if (this.removed.delete(id)) this.updated.add(id);
    else this.added.add(id);
  }
  markRemoved(id: ElementId): void {
    if (this.added.delete(id)) return;
    this.updated.delete(id);
    this.removed.add(id);
  }
  markUpdated(id: ElementId): void {
    if (!this.added.has(id)) this.updated.add(id);
  }

  unknownId(path: string, id: string, expected?: string): void {
    if (this.failedIds.has(id) || this.removed.has(id)) {
      if (this.removed.has(id))
        this.err(
          "unknown_id",
          path,
          `"${id}" was removed earlier in this batch`,
          "drop this op or re-add the element first",
        );
      return;
    }
    this.err("unknown_id", path, `no ${expected ?? "element"} "${id}"`, unknownIdHint(this.plan, id));
  }

  unknownLevel(path: string, id: string): void {
    const ids = this.plan.levels.map((l) => l.id);
    const near = nearest(id, ids);
    this.err(
      "unknown_level",
      path,
      `no level "${id}"`,
      `${near !== undefined ? `did you mean "${near}"? ` : ""}levels: ${listForHint(ids)}`,
    );
  }
}

function unknownIdHint(plan: MapPlan, id: string): string {
  const all = listElements(plan);
  const near = nearest(
    id,
    all.map((e) => e.id),
  );
  if (near === undefined) {
    const areas = all.filter((e) => e.kind === "area").map((e) => e.id);
    return `no element has a similar id; areas: ${areas.length > 0 ? listForHint(areas) : "(none)"}`;
  }
  const loc = all.find((e) => e.id === near) as ElementLocation;
  const peers = all.filter((e) => e.kind === loc.kind && e.levelId === loc.levelId).map((e) => e.id);
  const where = loc.kind === "link" || loc.kind === "level" ? "" : ` on ${loc.levelId ?? "?"}`;
  return `did you mean "${near}"? ${KIND_LABEL[loc.kind]}s${where}: ${listForHint(peers)}`;
}

/** Next free numeric key in the draft (max numeric key + 1). */
function nextKey(plan: MapPlan): string {
  let max = 0;
  for (const l of plan.levels)
    for (const a of l.areas)
      if (a.key !== undefined && /^\d+$/.test(a.key)) max = Math.max(max, Number(a.key));
  return String(max + 1);
}

function withAutoKey(plan: MapPlan, area: Area): Area {
  if (area.key !== undefined || !KEYED_AREA_KINDS.has(area.kind)) return area;
  return { ...area, key: nextKey(plan) };
}

/** Ids contained in a level (not the level itself). */
function levelContentIds(level: Level): ElementId[] {
  const out: ElementId[] = [];
  for (const kind of LEVEL_LIST_KINDS) for (const el of level[LEVEL_LIST_OF[kind]] ?? []) out.push(el.id);
  return out;
}

function zodToOpErrors(
  d: Draft,
  issues: readonly z.core.$ZodIssue[],
  root: unknown,
  schema: z.ZodType,
  prefix: string,
): void {
  for (const issue of issues) {
    const pi: PlanIssue = zodIssueToPlanIssue(issue, root, schema);
    d.err("invalid_value", `${prefix}${pi.path ?? ""}`, pi.message, pi.hint);
  }
}

// ───────────────────────────── entry point ─────────────────────────────

export function applyOps(
  plan: MapPlan,
  ops: readonly PlanOp[],
  rules: PlanRules,
  options: ApplyOptions = {},
): ApplyResult {
  const d = new Draft(cloneJson(plan), rules.materialize);
  ops.forEach((raw: unknown, i) => {
    d.opIndex = i;
    const parsed = PlanOpSchema.safeParse(raw);
    if (!parsed.success) {
      zodToOpErrors(d, parsed.error.issues, raw, PlanOpSchema, "");
      for (const id of introducedIds(raw)) d.failedIds.add(id);
      return;
    }
    const before = d.errors.length;
    applyOne(d, parsed.data);
    if (d.errors.length > before) for (const id of introducedIds(raw)) d.failedIds.add(id);
  });
  if (d.errors.length > 0) return { ok: false, opErrors: d.errors, issues: [] };

  const v: { ok: boolean; issues: PlanIssue[] } =
    options.validate === false
      ? { ok: true, issues: [] }
      : validatePlan(d.plan, {
          checks: rules.checks,
          ...(options.themes !== undefined ? { themes: options.themes } : {}),
        });
  if (!v.ok) return { ok: false, opErrors: [], issues: v.issues.filter((i) => i.severity === "error") };

  const dirtyLevels = [
    ...d.plan.levels.map((l) => l.id).filter((id) => d.dirty.has(id)),
    ...d.removedLevels.filter((id) => !d.plan.levels.some((l) => l.id === id)),
  ];
  return {
    ok: true,
    plan: d.plan,
    changed: {
      added: [...d.added],
      updated: [...d.updated].filter((id) => !d.added.has(id)),
      removed: [...d.removed],
    },
    dirtyLevels,
    issues: v.issues,
  };
}

/** Ids an op would introduce (best effort on raw input; used to suppress follow-on errors). */
function introducedIds(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const r = raw as { op?: unknown; element?: { value?: { id?: unknown } }; features?: unknown };
  if (r.op === "add" && typeof r.element?.value?.id === "string") return [r.element.value.id];
  if (r.op === "add_features" && Array.isArray(r.features)) {
    return (r.features as unknown[]).flatMap((f) =>
      typeof f === "object" && f !== null && typeof (f as { id?: unknown }).id === "string"
        ? [(f as { id: string }).id]
        : [],
    );
  }
  return [];
}

function applyOne(d: Draft, op: PlanOp): void {
  switch (op.op) {
    case "add":
      opAdd(d, op.element);
      return;
    case "add_features":
      opAddFeatures(d, op.level, op.features);
      return;
    case "update":
      opUpdate(d, op.id, op.set);
      return;
    case "remove":
      opRemove(d, removalIds(d, op.ids, op.where), op.keepDependents ?? false);
      return;
    case "move":
      opMove(d, op);
      return;
    case "duplicate":
      opDuplicate(d, op);
      return;
    case "reorder":
      opReorder(d, op.id, op.index);
      return;
    case "materialize":
      opMaterialize(d, op.id, op.keepOp ?? false);
      return;
    case "set_meta":
      opSetMeta(d, op);
      return;
    case "reshape":
      opReshape(d, op.id, op.shape);
      return;
    case "renumber":
      opRenumber(d);
      return;
  }
}

// ───────────────────────────── add ─────────────────────────────

function checkNewId(d: Draft, id: string, path: string, used: Set<string>): boolean {
  if (!used.has(id)) return true;
  const existing = d.find(id);
  const what =
    existing !== undefined
      ? `${KIND_LABEL[existing.loc.kind]}${existing.loc.levelId !== undefined && existing.loc.kind !== "level" ? ` on ${existing.loc.levelId}` : ""}`
      : "another element in this op";
  d.err(
    "duplicate_id",
    path,
    `id "${id}" is already used by ${what}`,
    `pick a new id such as "${freeId(id, used)}", or use update to change the existing element`,
  );
  return false;
}

function opAdd(d: Draft, el: NewElement): void {
  const used = d.ids();
  if (el.kind === "level") {
    const level: Level = {
      ...el.value,
      areas: el.value.areas ?? [],
      openings: el.value.openings ?? [],
      walls: el.value.walls ?? [],
      features: el.value.features ?? [],
      terrain: el.value.terrain ?? [],
      labels: el.value.labels ?? [],
    };
    let ok = checkNewId(d, level.id, "/element/value/id", used);
    used.add(level.id);
    for (const kind of LEVEL_LIST_KINDS) {
      const field = LEVEL_LIST_OF[kind];
      (level[field] ?? []).forEach((c, i) => {
        if (!checkNewId(d, c.id, `/element/value/${field}/${i}/id`, used)) ok = false;
        used.add(c.id);
      });
    }
    if (!ok) return;
    d.plan.levels.push(level);
    for (let i = 0; i < level.areas.length; i++) level.areas[i] = withAutoKey(d.plan, level.areas[i] as Area);
    d.markAdded(level.id);
    for (const id of levelContentIds(level)) d.markAdded(id);
    d.dirty.add(level.id);
    return;
  }
  if (el.kind === "link") {
    if (!checkNewId(d, el.value.id, "/element/value/id", used)) return;
    for (const end of ["from", "to"] as const) {
      if (d.level(el.value[end].level) === undefined) {
        d.unknownLevel(`/element/value/${end}/level`, el.value[end].level);
        return;
      }
    }
    d.plan.links.push(el.value);
    d.markAdded(el.value.id);
    d.dirty.add(el.value.from.level);
    d.dirty.add(el.value.to.level);
    return;
  }
  const level = d.level(el.level);
  if (level === undefined) {
    d.unknownLevel("/element/level", el.level);
    return;
  }
  if (!checkNewId(d, el.value.id, "/element/value/id", used)) return;
  switch (el.kind) {
    case "area": {
      const area = withAutoKey(d.plan, el.value);
      insertAt(level.areas, area, el.index);
      break;
    }
    case "terrain":
      insertAt(level.terrain, el.value, el.index);
      break;
    case "opening":
      level.openings.push(el.value);
      break;
    case "wall_run":
      level.walls.push(el.value);
      break;
    case "feature":
      level.features.push(el.value);
      break;
    case "label":
      level.labels.push(el.value);
      break;
    case "structure":
      (level.structures ??= []).push(el.value);
      break;
  }
  d.markAdded(el.value.id);
  d.dirty.add(level.id);
}

function insertAt<T>(list: T[], item: T, index: number | undefined): void {
  if (index === undefined || index >= list.length) list.push(item);
  else list.splice(Math.max(0, index), 0, item);
}

function opAddFeatures(d: Draft, levelId: LevelId, features: readonly Feature[]): void {
  const level = d.level(levelId);
  if (level === undefined) {
    d.unknownLevel("/level", levelId);
    return;
  }
  const used = d.ids();
  let ok = true;
  for (const [i, f] of features.entries()) {
    if (!checkNewId(d, f.id, `/features/${i}/id`, used)) ok = false;
    used.add(f.id);
  }
  if (!ok) return;
  for (const f of features) {
    level.features.push(f);
    d.markAdded(f.id);
  }
  d.dirty.add(level.id);
}

// ───────────────────────────── update / reshape ─────────────────────────────

const LEVEL_LIST_FIELDS = new Set<string>([
  "areas",
  "openings",
  "walls",
  "features",
  "terrain",
  "labels",
  "stamps",
  "structures",
]);

function schemaFor(kind: ElementKind): z.ZodType {
  switch (kind) {
    case "level":
      return LevelSchema;
    case "area":
      return AreaSchema;
    case "opening":
      return OpeningSchema;
    case "wall_run":
      return WallRunSchema;
    case "feature":
      return FeatureSchema;
    case "terrain":
      return TerrainOpSchema;
    case "label":
      return LabelSchema;
    case "link":
      return LevelLinkSchema;
    case "stamp":
      return StampRefSchema;
    case "structure":
      return StructureSchema;
  }
}

function elementAt(plan: MapPlan, loc: ElementLocation): Record<string, unknown> {
  if (loc.kind === "link") return plan.links[loc.index] as unknown as Record<string, unknown>;
  const level = plan.levels[loc.levelIndex] as Level;
  if (loc.kind === "level") return level as unknown as Record<string, unknown>;
  const list = (level[LEVEL_LIST_OF[loc.kind]] ?? []) as unknown as Array<Record<string, unknown>>;
  return list[loc.index] as Record<string, unknown>;
}

/** Writes a schema-validated value back into its slot. */
function writeElement(plan: MapPlan, loc: ElementLocation, value: unknown): void {
  if (loc.kind === "link") {
    plan.links[loc.index] = value as LevelLink;
    return;
  }
  if (loc.kind === "level") {
    plan.levels[loc.levelIndex] = value as Level;
    return;
  }
  const level = plan.levels[loc.levelIndex] as Level;
  const list = (level[LEVEL_LIST_OF[loc.kind]] ?? []) as unknown[];
  list[loc.index] = value;
}

function dirtyFor(d: Draft, found: Found, value?: Record<string, unknown>): void {
  if (found.loc.kind === "link") {
    const links = [
      elementAt(d.plan, found.loc),
      ...(value !== undefined ? [value] : []),
    ] as unknown as LevelLink[];
    for (const l of links) {
      d.dirty.add(l.from.level);
      d.dirty.add(l.to.level);
    }
  } else if (found.loc.levelId !== undefined) {
    d.dirty.add(found.loc.levelId);
  }
}

function opUpdate(d: Draft, id: ElementId, set: Record<string, unknown>): void {
  const found = d.find(id);
  if (found === undefined) {
    d.unknownId("/id", id);
    return;
  }
  const { loc } = found;
  const current = elementAt(d.plan, loc);
  let bad = false;
  if ("id" in set && set.id !== id) {
    d.err(
      "immutable_field",
      "/set/id",
      `ids cannot change ("${id}")`,
      "remove the element and add a new one with the new id",
    );
    bad = true;
  }
  if (loc.kind === "area" && "kind" in set && set.kind !== current.kind) {
    d.err(
      "immutable_field",
      "/set/kind",
      `the kind of area "${id}" cannot change`,
      `remove "${id}" and add a new area of kind ${JSON.stringify(set.kind)} (copy its notes)`,
    );
    bad = true;
  }
  if (loc.kind === "terrain" && "op" in set && set.op !== current.op) {
    d.err(
      "immutable_field",
      "/set/op",
      `the op of terrain op "${id}" cannot change`,
      "remove it and add a new terrain op",
    );
    bad = true;
  }
  if (loc.kind === "level") {
    for (const k of Object.keys(set)) {
      if (LEVEL_LIST_FIELDS.has(k)) {
        d.err(
          "not_applicable",
          `/set/${k}`,
          `level contents ("${k}") cannot be replaced with update`,
          "use add / add_features / remove ops for level contents",
        );
        bad = true;
      }
    }
  }
  if (bad) return;
  const merged: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(set)) {
    if (v === null) Reflect.deleteProperty(merged, k);
    else merged[k] = v;
  }
  const schema = schemaFor(loc.kind);
  const parsed = schema.safeParse(merged);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const pi = zodIssueToPlanIssue(issue, merged, schema);
      const top = String(issue.path[0] ?? "");
      const deletedRequired = top !== "" && set[top] === null && issue.code === "invalid_type";
      d.err(
        "invalid_value",
        `/set${pi.path ?? ""}`,
        deletedRequired
          ? `"${top}" is required on ${KIND_LABEL[loc.kind]} "${id}" and cannot be deleted`
          : pi.message,
        deletedRequired ? `set "${top}" to a new value instead of null` : pi.hint,
      );
    }
    return;
  }
  dirtyFor(d, found, parsed.data as Record<string, unknown>);
  writeElement(d.plan, loc, parsed.data);
  d.markUpdated(id);
}

function opReshape(d: Draft, id: ElementId, shape: Area["shape"]): void {
  const found = d.find(id);
  if (found === undefined) {
    d.unknownId("/id", id, "area");
    return;
  }
  if (found.loc.kind !== "area") {
    d.err(
      "wrong_kind",
      "/id",
      `"${id}" is a ${KIND_LABEL[found.loc.kind]}, not an area`,
      `use update {id: "${id}", set: {shape: …}} for terrain shapes`,
    );
    return;
  }
  const area = elementAt(d.plan, found.loc) as unknown as Area;
  writeElement(d.plan, found.loc, { ...area, shape });
  d.markUpdated(id);
  dirtyFor(d, found);
}

// ───────────────────────────── remove ─────────────────────────────

/**
 * The ids a remove op names: generated features as shown ("rocks#5") materialize their op first, and a `where`
 * filter adds every matching feature (generated ones of a still-live op are materialized for it).
 */
function removalIds(
  d: Draft,
  ids: readonly ElementId[],
  where: Extract<PlanOp, { op: "remove" }>["where"],
): ElementId[] {
  const live = (opId: string): boolean => {
    const f = d.find(opId);
    return f !== undefined && f.loc.kind === "terrain";
  };
  for (const id of ids) {
    const hash = id.indexOf("#");
    if (hash > 0 && d.find(id) === undefined && live(id.slice(0, hash)))
      opMaterialize(d, id.slice(0, hash), false);
  }
  if (!where) return [...ids];
  if (where.generatedBy !== undefined && live(where.generatedBy)) opMaterialize(d, where.generatedBy, false);
  const out = [...ids];
  for (const level of d.plan.levels) {
    if (where.level !== undefined && level.id !== where.level) continue;
    for (const f of level.features) {
      if (where.type !== undefined && f.type !== where.type) continue;
      if (where.generatedBy !== undefined && !f.id.startsWith(`${where.generatedBy}_`)) continue;
      const r = where.rect;
      if (r && (f.at[0] < r.x || f.at[1] < r.y || f.at[0] >= r.x + r.w || f.at[1] >= r.y + r.h)) continue;
      out.push(f.id);
    }
  }
  return out;
}

function opRemove(d: Draft, ids: readonly ElementId[], keepDependents: boolean): void {
  const targets: Found[] = [];
  const seen = new Set<string>();
  ids.forEach((id, i) => {
    if (seen.has(id)) return;
    seen.add(id);
    const f = d.find(id);
    if (f === undefined) d.unknownId(`/ids/${i}`, id);
    else targets.push(f);
  });
  if (!keepDependents) {
    // A route endpoint must not silently dangle: ask for the corridor to be removed or reshaped too.
    for (const t of targets) {
      if (t.loc.kind !== "area" || t.level === undefined) continue;
      for (const a of t.level.areas) {
        if (a.shape.type !== "route" || seen.has(a.id)) continue;
        if (a.shape.from === t.loc.id || a.shape.to === t.loc.id) {
          d.err(
            "not_applicable",
            `/ids/${ids.indexOf(t.loc.id)}`,
            `area "${t.loc.id}" is an endpoint of route corridor "${a.id}"`,
            `also remove "${a.id}" in the same op, or reshape it to another endpoint first`,
          );
        }
      }
    }
  }
  if (d.errors.some((e) => e.opIndex === d.opIndex)) return;

  for (const t of targets) {
    const now = d.find(t.loc.id);
    if (now === undefined) continue; // already removed by a cascade in this op
    removeFound(d, now, keepDependents);
  }
}

function removeFound(d: Draft, f: Found, keepDependents: boolean): void {
  const { loc } = f;
  if (loc.kind === "level") {
    const level = d.plan.levels[loc.levelIndex] as Level;
    d.plan.levels.splice(loc.levelIndex, 1);
    d.markRemoved(level.id);
    d.removedLevels.push(level.id);
    for (const id of levelContentIds(level)) d.markRemoved(id);
    const keep: LevelLink[] = [];
    for (const l of d.plan.links) {
      if (l.from.level === level.id || l.to.level === level.id) {
        d.markRemoved(l.id);
        d.dirty.add(l.from.level);
        d.dirty.add(l.to.level);
      } else {
        keep.push(l);
      }
    }
    d.plan.links = keep;
    if (d.plan.entryLevel === level.id) delete d.plan.entryLevel;
    return;
  }
  if (loc.kind === "link") {
    const link = d.plan.links[loc.index] as LevelLink;
    d.plan.links.splice(loc.index, 1);
    d.markRemoved(link.id);
    d.dirty.add(link.from.level);
    d.dirty.add(link.to.level);
    return;
  }
  const level = f.level as Level;
  const list = (level[LEVEL_LIST_OF[loc.kind]] ?? []) as Array<{ id: string }>;
  list.splice(loc.index, 1);
  d.markRemoved(loc.id);
  d.dirty.add(level.id);
  if (loc.kind === "area" && !keepDependents) {
    level.openings = level.openings.filter((o) => {
      const dep = o.between !== undefined && (o.between[0] === loc.id || o.between[1] === loc.id);
      if (dep) d.markRemoved(o.id);
      return !dep;
    });
    level.terrain = level.terrain.filter((t) => {
      const dep = t.op === "dress" && t.area === loc.id;
      if (dep) d.markRemoved(t.id);
      return !dep;
    });
  }
}

// ───────────────────────────── move / duplicate ─────────────────────────────

/** Elements (on `level`) that travel with `area`: features and labels inside, `at` openings on its boundary. */
function areaContents(level: Level, area: Area): ElementId[] {
  const inside = (c: Vec2): boolean => shapeHasCell(area.shape, c[0], c[1]);
  const out: ElementId[] = [];
  for (const f of level.features) if (inside(f.at)) out.push(f.id);
  for (const l of level.labels) if (inside(l.at)) out.push(l.id);
  for (const o of level.openings) {
    if (o.at === undefined) continue;
    const a = inside([o.at.x, o.at.y]);
    const b = inside(across(o.at.x, o.at.y, o.at.side));
    if (a !== b) out.push(o.id);
  }
  return out;
}

/**
 * Expands a selection: explicit ids plus (for areas, when withContents) their contents, `between` openings
 * whose areas are all in the set (or @outside), and dress ops on them. Returns ids in document order.
 */
function expandSelection(
  d: Draft,
  explicit: readonly Found[],
  withContents: boolean,
  includeBetween: boolean,
): Found[] {
  const ids = new Set(explicit.map((f) => f.loc.id));
  if (withContents) {
    for (const f of explicit) {
      if (f.loc.kind !== "area" || f.level === undefined) continue;
      const area = f.level.areas[f.loc.index] as Area;
      for (const id of areaContents(f.level, area)) ids.add(id);
    }
    for (const f of explicit) {
      if (f.loc.kind !== "area" || f.level === undefined) continue;
      for (const t of f.level.terrain) if (t.op === "dress" && t.area === f.loc.id) ids.add(t.id);
      if (!includeBetween) continue;
      for (const o of f.level.openings) {
        if (o.between === undefined) continue;
        const [a, b] = o.between;
        const okA = a === "@outside" || ids.has(a);
        const okB = b === "@outside" || ids.has(b);
        if (okA && okB) ids.add(o.id);
      }
    }
  }
  return listElements(d.plan)
    .filter((e) => ids.has(e.id))
    .map((loc) => ({ loc, level: loc.levelIndex >= 0 ? d.plan.levels[loc.levelIndex] : undefined }));
}

/** Translated copy of a level-scoped element (by kind). */
function translated(
  kind: ElementKind,
  el: Record<string, unknown>,
  dx: number,
  dy: number,
): Record<string, unknown> {
  switch (kind) {
    case "area": {
      const a = el as unknown as Area;
      const out: Area = { ...a, shape: translateShape(a.shape, dx, dy) };
      if (a.labelAt !== undefined) out.labelAt = tr(a.labelAt, dx, dy);
      if (a.broken !== undefined) out.broken = a.broken.map((c) => tr(c, dx, dy));
      return out as unknown as Record<string, unknown>;
    }
    case "opening": {
      const at = el.at as { x: number; y: number; side: string } | undefined;
      return at === undefined ? { ...el } : { ...el, at: { ...at, x: at.x + dx, y: at.y + dy } };
    }
    case "wall_run":
      return { ...el, points: (el.points as Vec2[]).map((p) => tr(p, dx, dy)) };
    case "feature":
    case "label":
    case "stamp":
      return { ...el, at: tr(el.at as Vec2, dx, dy) };
    case "terrain":
      return translateTerrain(el as unknown as Parameters<typeof translateTerrain>[0], dx, dy);
    case "link": {
      const l = el as unknown as LevelLink;
      const out: LevelLink = { ...l, from: { ...l.from, at: tr(l.from.at, dx, dy) }, to: { ...l.to } };
      if (l.to.at !== undefined) out.to.at = tr(l.to.at, dx, dy);
      return out as unknown as Record<string, unknown>;
    }
    case "structure":
      return translateStructure(el as unknown as Structure, dx, dy) as unknown as Record<string, unknown>;
    case "level":
      return { ...el };
  }
}

function translateLevel(d: Draft, level: Level, dx: number, dy: number): void {
  level.bounds = { ...level.bounds, x: level.bounds.x + dx, y: level.bounds.y + dy };
  for (const kind of LEVEL_LIST_KINDS) {
    const field = LEVEL_LIST_OF[kind];
    const list = level[field] as unknown as Array<Record<string, unknown>> | undefined;
    if (list === undefined) continue;
    for (let i = 0; i < list.length; i++)
      list[i] = translated(kind, list[i] as Record<string, unknown>, dx, dy);
  }
  d.plan.links = d.plan.links.map((l) => {
    const out: LevelLink = { ...l, from: { ...l.from }, to: { ...l.to } };
    if (l.from.level === level.id) out.from.at = tr(l.from.at, dx, dy);
    if (l.to.level === level.id && l.to.at !== undefined) out.to.at = tr(l.to.at, dx, dy);
    if (out.from.at !== l.from.at || out.to.at !== l.to.at) d.markUpdated(l.id);
    return out;
  });
}

function resolveTargets(d: Draft, ids: readonly ElementId[]): Found[] | null {
  const out: Found[] = [];
  const seen = new Set<string>();
  let ok = true;
  for (const [i, id] of ids.entries()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const f = d.find(id);
    if (f === undefined) {
      d.unknownId(`/ids/${i}`, id);
      ok = false;
    } else {
      out.push(f);
    }
  }
  return ok ? out : null;
}

function opMove(d: Draft, op: Extract<PlanOp, { op: "move" }>): void {
  const targets = resolveTargets(d, op.ids);
  const toLevel = op.toLevel !== undefined ? d.level(op.toLevel) : undefined;
  if (op.toLevel !== undefined && toLevel === undefined) d.unknownLevel("/toLevel", op.toLevel);
  if (targets === null || (op.toLevel !== undefined && toLevel === undefined)) return;
  let bad = false;
  for (const t of targets) {
    const i = op.ids.indexOf(t.loc.id);
    if (toLevel !== undefined && (t.loc.kind === "level" || t.loc.kind === "link")) {
      d.err(
        "not_applicable",
        `/ids/${i}`,
        `${KIND_LABEL[t.loc.kind]} "${t.loc.id}" cannot move to another level`,
        t.loc.kind === "link" ? "update its from/to levels instead" : "omit toLevel to translate the level",
      );
      bad = true;
    }
    if (t.loc.kind === "opening" && t.level !== undefined) {
      const o = t.level.openings[t.loc.index];
      if (o?.between !== undefined) {
        d.err(
          "not_applicable",
          `/ids/${i}`,
          `opening "${t.loc.id}" is placed by "between"; it follows its areas`,
          "move the areas instead, or update the opening's position (0..1)",
        );
        bad = true;
      }
    }
  }
  if (bad) return;
  const selection = expandSelection(d, targets, op.withContents ?? true, toLevel !== undefined);

  for (const f of selection) {
    if (f.loc.kind === "level") {
      const level = d.plan.levels[f.loc.levelIndex] as Level;
      translateLevel(d, level, op.dx, op.dy);
      d.markUpdated(level.id);
      d.dirty.add(level.id);
      continue;
    }
    const el = elementAt(d.plan, f.loc);
    const moved = translated(f.loc.kind, el, op.dx, op.dy);
    if (f.loc.kind === "link") {
      writeElement(d.plan, f.loc, moved);
      dirtyFor(d, f);
    } else {
      writeElement(d.plan, f.loc, moved);
      if (f.loc.levelId !== undefined) d.dirty.add(f.loc.levelId);
    }
    d.markUpdated(f.loc.id);
  }
  if (toLevel === undefined) return;
  // Re-home level-scoped elements (document order keeps painter order stable).
  for (const f of selection) {
    if (f.loc.kind === "level" || f.loc.kind === "link" || f.loc.levelId === toLevel.id) continue;
    const src = d.level(f.loc.levelId ?? "");
    if (src === undefined) continue;
    const field = LEVEL_LIST_OF[f.loc.kind];
    const list = (src[field] ?? []) as unknown as Array<{ id: string }>;
    const idx = list.findIndex((e) => e.id === f.loc.id);
    if (idx < 0) continue;
    const [el] = list.splice(idx, 1);
    if (toLevel[field] === undefined) toLevel[field] = [];
    (toLevel[field] as unknown as Array<{ id: string }>).push(el as { id: string });
    d.dirty.add(src.id);
    d.dirty.add(toLevel.id);
  }
}

function opDuplicate(d: Draft, op: Extract<PlanOp, { op: "duplicate" }>): void {
  const targets = resolveTargets(d, op.ids);
  const toLevel = op.toLevel !== undefined ? d.level(op.toLevel) : undefined;
  if (op.toLevel !== undefined && toLevel === undefined) d.unknownLevel("/toLevel", op.toLevel);
  if (targets === null || (op.toLevel !== undefined && toLevel === undefined)) return;
  for (const t of targets) {
    if (toLevel !== undefined && (t.loc.kind === "level" || t.loc.kind === "link")) {
      d.err(
        "not_applicable",
        `/ids/${op.ids.indexOf(t.loc.id)}`,
        `${KIND_LABEL[t.loc.kind]} "${t.loc.id}" cannot be duplicated onto another level`,
        "omit toLevel",
      );
      return;
    }
  }
  // Levels: duplicate the whole level (with contents) above the highest one.
  const levelTargets = targets.filter((t) => t.loc.kind === "level");
  const others = targets.filter((t) => t.loc.kind !== "level");
  const selection = [
    ...levelTargets,
    ...expandSelection(d, others, true, true).filter(
      (f) => !levelTargets.some((l) => l.loc.levelId === f.loc.levelId),
    ),
  ];
  const idMap = new Map<string, string>();
  for (const f of selection) {
    idMap.set(f.loc.id, f.loc.id + op.idSuffix);
    if (f.loc.kind === "level")
      for (const id of levelContentIds(f.level as Level)) idMap.set(id, id + op.idSuffix);
  }
  const used = d.ids();
  let ok = true;
  for (const [, nid] of idMap) {
    if (!ID_PATTERN.test(nid)) {
      d.err(
        "invalid_value",
        "/idSuffix",
        `new id "${nid}" is not a valid id (≤ 32 chars of a-z, 0-9, _)`,
        'use a shorter idSuffix such as "_2"',
      );
      ok = false;
    } else if (used.has(nid)) {
      d.err(
        "duplicate_id",
        "/idSuffix",
        `new id "${nid}" already exists`,
        `use another idSuffix, e.g. "${op.idSuffix}b"`,
      );
      ok = false;
    }
    used.add(nid);
  }
  if (!ok) return;

  const remap = <T extends Record<string, unknown>>(kind: ElementKind, el: T): T => {
    const out: Record<string, unknown> = { ...el, id: idMap.get(el.id as string) ?? el.id };
    if (kind === "opening" && Array.isArray(el.between))
      out.between = (el.between as string[]).map((r) => idMap.get(r) ?? r);
    if (kind === "terrain" && el.op === "dress" && typeof el.area === "string")
      out.area = idMap.get(el.area) ?? el.area;
    if (kind === "area") {
      const a = el as unknown as Area;
      if (a.shape.type === "route") {
        const from = a.shape.from;
        const to = a.shape.to;
        out.shape = {
          ...a.shape,
          from: typeof from === "string" ? (idMap.get(from) ?? from) : from,
          to: typeof to === "string" ? (idMap.get(to) ?? to) : to,
        };
      }
      // Room keys are plan-unique: copies get fresh numbers (assigned below).
      delete out.key;
    }
    return out as T;
  };

  for (const f of selection) {
    if (f.loc.kind === "level") {
      const src = f.level as Level;
      const top = maxOf(d.plan.levels.map((l) => l.elevation));
      const copy = cloneJson(src);
      copy.id = idMap.get(src.id) ?? src.id;
      copy.elevation = top + BUILD_CONSTANTS.storeyHeight;
      translateLevel(d, copy, op.dx, op.dy); // copy has no links yet; translateLevel only maps matching links
      for (const kind of LEVEL_LIST_KINDS) {
        const field = LEVEL_LIST_OF[kind];
        const list = copy[field] as unknown as Array<Record<string, unknown>> | undefined;
        if (list === undefined) continue;
        for (let i = 0; i < list.length; i++) list[i] = remap(kind, list[i] as Record<string, unknown>);
      }
      d.plan.levels.push(copy);
      for (let i = 0; i < copy.areas.length; i++) {
        const original = src.areas[i] as Area;
        if (original.key !== undefined || KEYED_AREA_KINDS.has(original.kind)) {
          copy.areas[i] = { ...(copy.areas[i] as Area), key: nextKey(d.plan) };
        }
      }
      d.markAdded(copy.id);
      for (const id of levelContentIds(copy)) d.markAdded(id);
      d.dirty.add(copy.id);
      continue;
    }
    const el = elementAt(d.plan, f.loc);
    const copy = remap(f.loc.kind, translated(f.loc.kind, el, op.dx, op.dy));
    if (f.loc.kind === "link") {
      d.plan.links.push(copy as unknown as LevelLink);
      d.markAdded(copy.id as string);
      d.dirty.add((copy as unknown as LevelLink).from.level);
      d.dirty.add((copy as unknown as LevelLink).to.level);
      continue;
    }
    const level = toLevel ?? f.level;
    if (level === undefined) continue;
    const field = LEVEL_LIST_OF[f.loc.kind];
    if (level[field] === undefined) level[field] = [];
    const list = level[field] as unknown as Array<Record<string, unknown>>;
    if (f.loc.kind === "area") {
      const original = el as unknown as Area;
      const keyed =
        original.key !== undefined || KEYED_AREA_KINDS.has(original.kind)
          ? { ...copy, key: nextKey(d.plan) }
          : copy;
      list.push(keyed);
    } else {
      list.push(copy);
    }
    d.markAdded(copy.id as string);
    d.dirty.add(level.id);
  }
}

// ───────────────────────────── reorder / materialize / meta / renumber ─────────────────────────────

function opReorder(d: Draft, id: ElementId, index: number): void {
  const f = d.find(id);
  if (f === undefined) {
    d.unknownId("/id", id);
    return;
  }
  if (f.loc.kind !== "area" && f.loc.kind !== "terrain") {
    d.err(
      "wrong_kind",
      "/id",
      `"${id}" is a ${KIND_LABEL[f.loc.kind]}; only areas and terrain ops have an order`,
      "reorder an area or a terrain op",
    );
    return;
  }
  const level = f.level as Level;
  const list = (f.loc.kind === "area" ? level.areas : level.terrain) as unknown[];
  if (index >= list.length) {
    d.err(
      "invalid_value",
      "/index",
      `index ${index} is out of range for ${list.length} ${f.loc.kind === "area" ? "areas" : "terrain ops"} on ${level.id}`,
      `use 0..${list.length - 1}`,
    );
    return;
  }
  const [el] = list.splice(f.loc.index, 1);
  list.splice(index, 0, el);
  d.markUpdated(id);
  d.dirty.add(level.id);
}

function opMaterialize(d: Draft, id: ElementId, keepOp: boolean): void {
  const f = d.find(id);
  if (f === undefined) {
    d.unknownId("/id", id, "terrain op");
    return;
  }
  const level = f.level;
  const t = f.loc.kind === "terrain" && level !== undefined ? level.terrain[f.loc.index] : undefined;
  if (level === undefined || t === undefined || (t.op !== "scatter" && t.op !== "dress")) {
    d.err(
      "wrong_kind",
      "/id",
      `"${id}" is not a scatter or dress terrain op`,
      "materialize a scatter or dress op",
    );
    return;
  }
  if (d.materialize === null) {
    d.err(
      "not_applicable",
      "/id",
      "materialize needs the resolver, which this caller did not supply",
      "retry later; the generated features are unchanged",
    );
    return;
  }
  const res = d.materialize(d.plan, level.id, id);
  if (!res.ok) {
    d.err("not_applicable", "/id", res.message, "check the op's parameters");
    return;
  }
  const used = d.ids();
  const features: Feature[] = [];
  for (const g of res.features) {
    const nid = freeId(g.id.replace(/#/g, "_").slice(0, 32), used);
    used.add(nid);
    const parsed = FeatureSchema.safeParse({ ...g, id: nid });
    if (!parsed.success) {
      d.err(
        "invalid_value",
        "/id",
        `generated feature "${g.id}" is not a valid explicit feature`,
        parsed.error.issues[0]?.message ?? "",
      );
      return;
    }
    features.push(parsed.data);
  }
  for (const feat of features) {
    level.features.push(feat);
    d.markAdded(feat.id);
  }
  if (!keepOp) {
    level.terrain.splice(f.loc.index, 1);
    d.markRemoved(id);
  }
  d.dirty.add(level.id);
}

function opSetMeta(d: Draft, op: Extract<PlanOp, { op: "set_meta" }>): void {
  const p = d.plan;
  if (op.title !== undefined) p.title = op.title;
  if (op.kind !== undefined) p.kind = op.kind;
  if (op.summary === null) delete p.summary;
  else if (op.summary !== undefined) p.summary = op.summary;
  if (op.notes === null) delete p.notes;
  else if (op.notes !== undefined) p.notes = op.notes;
  const geometric =
    (op.seed !== undefined && op.seed !== p.seed) || (op.theme !== undefined && op.theme !== p.theme);
  if (op.seed !== undefined) p.seed = op.seed;
  if (op.theme !== undefined) p.theme = op.theme;
  if (geometric) for (const l of p.levels) d.dirty.add(l.id);
}

/**
 * Level order for renumbering (contract, Area.key): the entry level first (`plan.entryLevel`, else the level whose
 * elevation is nearest 0, ties → first in plan order), then the levels above it in ascending elevation, then the
 * levels below it in descending elevation. Equal elevations (only possible mid-batch) keep plan order.
 */
export function renumberLevelOrder(plan: MapPlan): Level[] {
  const indexed = plan.levels.map((l, i) => ({ l, i }));
  let entry = indexed.find((x) => x.l.id === plan.entryLevel);
  if (entry === undefined) {
    for (const x of indexed) {
      if (entry === undefined || Math.abs(x.l.elevation) < Math.abs(entry.l.elevation)) entry = x;
    }
  }
  if (entry === undefined) return [];
  const e = entry;
  const above = indexed
    .filter((x) => x !== e && x.l.elevation >= e.l.elevation)
    .sort((a, b) => a.l.elevation - b.l.elevation || a.i - b.i);
  const below = indexed
    .filter((x) => x !== e && x.l.elevation < e.l.elevation)
    .sort((a, b) => b.l.elevation - a.l.elevation || a.i - b.i);
  return [e, ...above, ...below].map((x) => x.l);
}

/**
 * Numbers every room/cave/building/courtyard area that has no key, the same way adding one does (withAutoKey:
 * next free integer), visiting levels in renumberLevelOrder and areas in painter order. Keys already present are
 * kept. Used for whole plans that never went through applyOps (create_plan), so a first draft comes out numbered.
 */
export function autoKeyRooms(plan: MapPlan): MapPlan {
  const out: MapPlan = { ...plan, levels: plan.levels.map((l) => ({ ...l, areas: [...l.areas] })) };
  for (const level of renumberLevelOrder(out))
    for (let i = 0; i < level.areas.length; i++) level.areas[i] = withAutoKey(out, level.areas[i] as Area);
  return out;
}

/** Reassigns numeric keys 1..n in renumberLevelOrder, then painter order; non-numeric keys are kept. */
function opRenumber(d: Draft): void {
  const levels = renumberLevelOrder(d.plan).map((l) => ({ l }));
  let n = 1;
  for (const { l } of levels) {
    l.areas = l.areas.map((a) => {
      const numeric = a.key !== undefined && /^\d+$/.test(a.key);
      if (!numeric && !(a.key === undefined && KEYED_AREA_KINDS.has(a.kind))) return a;
      const key = String(n++);
      if (key === a.key) return a;
      d.markUpdated(a.id);
      d.dirty.add(l.id);
      return { ...a, key };
    });
  }
}
