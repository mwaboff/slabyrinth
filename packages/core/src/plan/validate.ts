/**
 * validatePlan (architecture §2.8): every resolver-INDEPENDENT check, plus the checks the caller passes in
 * (`ValidateContext.checks`). The resolver's geometric checks (opening_no_boundary on real edges, feature_blocked,
 * area_empty, unreachable…) sit in a higher layer and need the palettes the plan is built with, so this module
 * cannot import them: the caller hands them over (resolve's `planRules(palettes).checks`), or passes `[]` to check
 * structure only. There is no process-wide registry: the same call gives the same answer in every process.
 *
 * Order: size limit → Zod structure → cross-element rules → the given checks. The given checks run only when
 * everything before produced no error, so they may assume a structurally sound plan with valid references.
 *
 * Every issue carries a stable code, a JSON-pointer path, the element/level ids and a model-facing hint.
 */
import type {
  Level,
  LevelLink,
  MapPlan,
  PlanIssue,
  PlanIssueCode,
  Severity,
  Shape,
  ValidationResult,
  Vec2,
} from "../contracts/plan";
import { BUILD_CONSTANTS, PLAN_LIMITS } from "../contracts/plan";
import { own } from "../palette/own";
import { utf8Length } from "../util/hash";
import { type GeneratorVocabulary, VOCABULARY_SINCE, generatorProfile } from "./generator";
import { listForHint, nearest } from "../util/strings";
import { KIND_LABEL, freeId, listElements } from "./elements";
import type { ElementLocation } from "./elements";
import { linkGeometry } from "./links";
import { withWings } from "./building";
import { MapPlanSchema } from "./schema";
import { boxesIntersect, polylineProblems, shapeCellBox, shapeProblems } from "./shapes";
import type { CellBox } from "./shapes";
import { zodIssueToPlanIssue } from "./zodIssues";

// ───────────────────────────── context and checks ─────────────────────────────

export interface ValidateContext {
  /**
   * The checks that run after the structural ones, in this order, on a plan with no structural error. Required so
   * that no caller leaves them out by accident: `planRules(palettes).checks` (resolve) adds the resolver's geometry
   * and playability checks for the palettes the plan is built with; `[]` checks structure only.
   */
  checks: readonly PlanCheck[];
  /** Theme ids known to the installed palettes. When given, unknown themes produce `theme_unknown` warnings. */
  themes?: readonly string[];
}

/**
 * A validation pass a higher layer supplies (the resolver's geometry and playability checks).
 * Must be pure and deterministic; receives only plans that passed every structural check.
 */
export interface PlanCheck {
  /** A name for tests and logs. */
  name: string;
  run(plan: MapPlan, ctx: ValidateContext): readonly PlanIssue[];
}

/** No checks beyond the structural ones: `validatePlan(plan, STRUCTURE_ONLY)`. */
export const STRUCTURE_ONLY: ValidateContext = Object.freeze({ checks: Object.freeze([]) });

// ───────────────────────────── entry points ─────────────────────────────

export type ParsePlanResult = { ok: true; plan: MapPlan } | { ok: false; issues: PlanIssue[] };

/** Size limit + Zod structure only. Use for untrusted JSON (imports, project files, tool input). */
export function parsePlan(input: unknown): ParsePlanResult {
  const sizeIssue = checkSize(input);
  if (sizeIssue !== null) return { ok: false, issues: [sizeIssue] };
  const parsed = MapPlanSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => zodIssueToPlanIssue(i, input, MapPlanSchema)),
    };
  }
  return { ok: true, plan: parsed.data };
}

/**
 * Validates a plan (or untrusted JSON). Pure and deterministic. `ok` is false iff an issue has severity "error".
 */
export function validatePlan(input: unknown, ctx: ValidateContext): ValidationResult {
  const parsed = parsePlan(input);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  const issues = structuralChecks(parsed.plan, ctx);
  if (!issues.some((i) => i.severity === "error")) {
    for (const check of ctx.checks) issues.push(...check.run(parsed.plan, ctx));
  }
  return { ok: !issues.some((i) => i.severity === "error"), issues };
}

// ───────────────────────────── checks ─────────────────────────────

function checkSize(input: unknown): PlanIssue | null {
  // JSON.stringify returns undefined for these; Zod reports the type error.
  if (input === undefined || typeof input === "function" || typeof input === "symbol") return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch (e) {
    return {
      severity: "error",
      code: "schema",
      path: "",
      message: `plan is not JSON-serializable: ${e instanceof Error ? e.message : String(e)}`,
      hint: "send plain JSON (no cycles or BigInt values)",
    };
  }
  const bytes = utf8Length(json);
  if (bytes > PLAN_LIMITS.planJsonBytes) {
    return {
      severity: "error",
      code: "limit_exceeded",
      path: "",
      message: `plan JSON is ${bytes} bytes; the limit is ${PLAN_LIMITS.planJsonBytes}`,
      hint: "shorten notes/readAloud text or replace explicit features with scatter/dress terrain ops",
    };
  }
  return null;
}

/** Where an issue points beyond its path. */
interface IssueExtra {
  elementId?: string;
  levelId?: string;
  cell?: Vec2;
}

class IssueSink {
  readonly issues: PlanIssue[] = [];
  add(
    severity: Severity,
    code: PlanIssueCode,
    path: string,
    message: string,
    hint: string,
    extra: IssueExtra = {},
  ): void {
    const issue: PlanIssue = { severity, code, message, path, hint };
    if (extra.elementId !== undefined) issue.elementId = extra.elementId;
    if (extra.levelId !== undefined) issue.levelId = extra.levelId;
    if (extra.cell !== undefined) issue.cell = extra.cell;
    this.issues.push(issue);
  }
  error(code: PlanIssueCode, path: string, message: string, hint: string, extra?: IssueExtra): void {
    this.add("error", code, path, message, hint, extra);
  }
}

const levelBox = (l: Level): CellBox => ({
  x0: l.bounds.x,
  y0: l.bounds.y,
  x1: l.bounds.x + l.bounds.w,
  y1: l.bounds.y + l.bounds.h,
});
const cellIn = (b: CellBox, c: Vec2): boolean => c[0] >= b.x0 && c[0] < b.x1 && c[1] >= b.y0 && c[1] < b.y1;
const vertexIn = (b: CellBox, v: Vec2): boolean =>
  v[0] >= b.x0 && v[0] <= b.x1 && v[1] >= b.y0 && v[1] <= b.y1;
const boundsText = (l: Level): string =>
  `x ${l.bounds.x}..${l.bounds.x + l.bounds.w - 1}, y ${l.bounds.y}..${l.bounds.y + l.bounds.h - 1}`;
const clampCell = (b: CellBox, c: Vec2): Vec2 => [
  Math.min(Math.max(c[0], b.x0), b.x1 - 1),
  Math.min(Math.max(c[1], b.y0), b.y1 - 1),
];

/** Area kinds that receive automatic room-key numbers when added without a key. */
export const KEYED_AREA_KINDS: ReadonlySet<string> = new Set(["room", "cave", "building", "courtyard"]);

/**
 * What the UI counts and lists as a "room": an enclosed/usable area of a room-like kind (room, cave, building,
 * courtyard), keyed or not, plus any other area the plan explicitly numbered. Corridors and zones without a key
 * are passages/annotations, not rooms. Plans made whole by create_plan may carry no keys at all, so the key alone
 * is not a reliable signal.
 */
export function isRoomArea(a: { kind: string; key?: string | undefined }): boolean {
  return KEYED_AREA_KINDS.has(a.kind) || a.key !== undefined;
}

/** Number of rooms (isRoomArea) on one level, or across the plan when levelId is omitted. */
export function countPlanRooms(plan: Pick<MapPlan, "levels"> | null | undefined, levelId?: string): number {
  if (!plan) return 0;
  let n = 0;
  for (const l of plan.levels) {
    if (levelId !== undefined && l.id !== levelId) continue;
    for (const a of l.areas) if (isRoomArea(a)) n += 1;
  }
  return n;
}

/** Next free integer key: max numeric key + 1. */
export function nextFreeKey(plan: MapPlan): string {
  let max = 0;
  for (const l of plan.levels)
    for (const a of [...l.areas, ...(l.structures ?? [])])
      if (a.key !== undefined && /^\d+$/.test(a.key)) max = Math.max(max, Number(a.key));
  return String(max + 1);
}

export function structuralChecks(plan: MapPlan, ctx: Pick<ValidateContext, "themes">): PlanIssue[] {
  const sink = new IssueSink();
  const elements = listElements(plan);
  checkIds(plan, elements, sink);
  checkLevels(plan, sink);
  checkKeys(plan, sink);
  plan.levels.forEach((level, li) => {
    checkLevelContents(plan, level, li, sink);
  });
  checkLinks(plan, sink);
  if (ctx.themes !== undefined) checkThemes(plan, ctx.themes, sink);
  return sink.issues;
}

function checkIds(plan: MapPlan, elements: readonly ElementLocation[], sink: IssueSink): void {
  const first = new Map<string, ElementLocation>();
  const used = new Set(elements.map((e) => e.id));
  for (const el of elements) {
    const prev = first.get(el.id);
    if (prev === undefined) {
      first.set(el.id, el);
      continue;
    }
    const suggestion = freeId(`${el.id}_2`, used);
    used.add(suggestion);
    sink.error(
      "id_duplicate",
      `${el.path}/id`,
      `id "${el.id}" is used by ${KIND_LABEL[prev.kind]} ${prev.path} and again by ${KIND_LABEL[el.kind]} ${el.path}`,
      `ids are unique across the whole plan; rename this one, e.g. "${suggestion}"`,
      { elementId: el.id, ...(el.levelId !== undefined ? { levelId: el.levelId } : {}) },
    );
  }
  if (plan.entryLevel !== undefined && !plan.levels.some((l) => l.id === plan.entryLevel)) {
    const ids = plan.levels.map((l) => l.id);
    const near = nearest(plan.entryLevel, ids);
    sink.error(
      "ref_unknown",
      "/entryLevel",
      `entryLevel "${plan.entryLevel}" is not a level`,
      `${near !== undefined ? `did you mean "${near}"? ` : ""}levels: ${listForHint(ids)}`,
    );
  }
}

function checkLevels(plan: MapPlan, sink: IssueSink): void {
  const seen = new Map<number, string>();
  const elevations = new Set(plan.levels.map((l) => l.elevation));
  plan.levels.forEach((level, li) => {
    const other = seen.get(level.elevation);
    if (other !== undefined) {
      let free = level.elevation + BUILD_CONSTANTS.storeyHeight;
      while (elevations.has(free)) free += BUILD_CONSTANTS.storeyHeight;
      sink.error(
        "level_order",
        `/levels/${li}/elevation`,
        `levels "${other}" and "${level.id}" both have elevation ${level.elevation}`,
        `each level needs its own elevation; stack storeys ${BUILD_CONSTANTS.storeyHeight} apart, e.g. ${free}`,
        { elementId: level.id, levelId: level.id },
      );
    } else {
      seen.set(level.elevation, level.id);
    }
    if (level.stamps !== undefined && level.stamps.length > 0) {
      sink.error(
        "stamp_unsupported",
        `/levels/${li}/stamps`,
        `level "${level.id}" has ${level.stamps.length} stamp(s); stamps are reserved and not supported in v1`,
        "remove the stamps field (or set it to [])",
        { elementId: level.id, levelId: level.id },
      );
    }
  });
}

function checkKeys(plan: MapPlan, sink: IssueSink): void {
  const seen = new Map<string, string>();
  let next = Number(nextFreeKey(plan));
  plan.levels.forEach((level, li) => {
    const keyed: Array<{ key?: string | undefined; id: string; path: string }> = [
      ...level.areas.map((a, ai) => ({ key: a.key, id: a.id, path: `/levels/${li}/areas/${ai}/key` })),
      ...(level.structures ?? []).map((st, si) => ({
        key: st.key,
        id: st.id,
        path: `/levels/${li}/structures/${si}/key`,
      })),
    ];
    keyed.forEach((area) => {
      if (area.key === undefined) return;
      const other = seen.get(area.key);
      if (other !== undefined) {
        sink.error(
          "key_duplicate",
          area.path,
          `room key "${area.key}" is used by "${other}" and "${area.id}"`,
          `keys are unique across the plan; use "${next}" (next free number) or omit key to auto-number`,
          { elementId: area.id, levelId: level.id },
        );
        next++;
      } else {
        seen.set(area.key, area.id);
      }
    });
  });
}

function checkShape(
  shape: Shape,
  path: string,
  level: Level,
  allowRoute: boolean,
  sink: IssueSink,
  elementId: string,
  mustTouchLevel: boolean,
): void {
  const extra = { elementId, levelId: level.id };
  for (const p of shapeProblems(shape, allowRoute))
    sink.error("shape_invalid", path + p.subPath, `${elementId}: ${p.message}`, p.hint, extra);
  if (shape.type === "cells" && !shape.rows.some((r) => r.includes("#"))) {
    sink.error(
      "area_empty",
      `${path}/rows`,
      `${elementId}: mask has no '#' cells`,
      "mark the covered cells with '#'",
      extra,
    );
  }
  const box = shapeCellBox(shape);
  const lb = levelBox(level);
  if (mustTouchLevel && box !== null && !boxesIntersect(box, lb)) {
    sink.error(
      "bounds_exceeded",
      path,
      `${elementId}: shape covers x ${box.x0}..${box.x1 - 1}, y ${box.y0}..${box.y1 - 1}, entirely outside level "${level.id}" (${boundsText(level)})`,
      `move the shape inside ${boundsText(level)} or enlarge the level bounds`,
      extra,
    );
  }
}

function areaRefCheck(
  ref: string,
  path: string,
  level: Level,
  plan: MapPlan,
  sink: IssueSink,
  elementId: string,
  what: string,
): boolean {
  if (level.areas.some((a) => a.id === ref)) return true;
  // a building or enclosure is also an area of its level (its ground storey / its yard)
  if ((level.structures ?? []).some((s) => s.id === ref)) return true;
  const elsewhere = plan.levels.find((l) => l.areas.some((a) => a.id === ref));
  const ids = level.areas.map((a) => a.id);
  const near = nearest(ref, ids);
  sink.error(
    "ref_unknown",
    path,
    elsewhere !== undefined
      ? `${what} "${elementId}" refers to area "${ref}", which is on level "${elsewhere.id}", not "${level.id}"`
      : `${what} "${elementId}" refers to unknown area "${ref}"`,
    `${near !== undefined ? `did you mean "${near}"? ` : ""}areas on ${level.id}: ${ids.length > 0 ? listForHint(ids) : "(none)"}${what === "dress op" && generatorProfile(plan).dressWholeLevel ? "; or leave area out to dress the whole level" : ""}`,
    { elementId, levelId: level.id },
  );
  return false;
}

/**
 * Plan vocabulary a later generator added (plan/generator.ts VOCABULARY), used below that generator: refused, code
 * `schema`, the same for every kind of word. The schema accepts the word for every generator (one schema serves every
 * plan), so this is where a released generator's plan is held to the words its own release knew.
 */
function checkVocabulary(plan: MapPlan, level: Level, li: number, sink: IssueSink): void {
  const known = generatorProfile(plan).vocabulary;
  const base = `/levels/${li}`;
  const refuse = (
    kind: keyof GeneratorVocabulary,
    word: string,
    path: string,
    what: string,
    instead: string,
    extra: IssueExtra,
  ): void => {
    const since = own(VOCABULARY_SINCE[kind], word);
    if (since === undefined || known[kind].has(word)) return;
    sink.error(
      "schema",
      path,
      `${what} needs generator ${since}; this plan is generator ${plan.generator}`,
      `set the plan generator to ${since} (new plans have it), or ${instead}`,
      extra,
    );
  };
  const fields = (
    kind: "levelFields" | "areaFields",
    element: object,
    path: string,
    label: string,
    extra: IssueExtra,
  ): void => {
    for (const field of Object.keys(element))
      refuse(kind, field, `${path}/${field}`, `${label}: ${field}`, `remove ${field}`, extra);
  };
  fields("levelFields", level, base, `level "${level.id}"`, { elementId: level.id, levelId: level.id });
  level.areas.forEach((a, ai) => {
    fields("areaFields", a, `${base}/areas/${ai}`, `area "${a.id}"`, { elementId: a.id, levelId: level.id });
  });
  level.features.forEach((f, fi) => {
    refuse(
      "featureTypes",
      f.type,
      `${base}/features/${fi}/type`,
      `feature "${f.id}": type ${f.type}`,
      "use another feature type",
      { elementId: f.id, levelId: level.id, cell: f.at },
    );
  });
  level.terrain.forEach((t, ti) => {
    if (t.op === "scatter")
      refuse(
        "featureTypes",
        t.feature,
        `${base}/terrain/${ti}/feature`,
        `scatter "${t.id}": feature ${t.feature}`,
        "scatter another feature type",
        { elementId: t.id, levelId: level.id },
      );
  });
}

function checkLevelContents(plan: MapPlan, level: Level, li: number, sink: IssueSink): void {
  const base = `/levels/${li}`;
  const lb = levelBox(level);

  checkVocabulary(plan, level, li, sink);
  const gen = generatorProfile(plan);

  (level.structures ?? []).map(withWings).forEach((st, si) => {
    const p = `${base}/structures/${si}`;
    const extra = { elementId: st.id, levelId: level.id };
    if (!gen.buildings)
      sink.error(
        "structure_invalid",
        p,
        `structure "${st.id}": buildings and enclosures need generator 2`,
        "set the plan generator to 2 (new plans have it), or draw the building as an area of kind building",
        extra,
      );
    if (st.kind === "enclosure") checkShape(st.shape, `${p}/shape`, level, false, sink, st.id, true);
    else {
      if (st.footprint !== undefined)
        checkShape(st.footprint, `${p}/footprint`, level, false, sink, st.id, true);
      if (st.footprint === undefined && st.wings === undefined && (st.volumes ?? []).length === 0)
        sink.error(
          "structure_invalid",
          p,
          `building "${st.id}" has no wings, volumes or footprint`,
          "give wings: [{x,y,w,h}] (rectangles), volumes [{id,x,y,w,h,storeys}] or a footprint shape",
          extra,
        );
      (st.wings ?? []).forEach((w, wi) => {
        if (!cellIn(lb, [w.x, w.y]) || !cellIn(lb, [w.x + w.w - 1, w.y + w.h - 1]))
          sink.error(
            "bounds_exceeded",
            `${p}/wings/${wi}`,
            `building "${st.id}": wing ${w.x},${w.y} ${w.w}x${w.h} leaves level "${level.id}" (${boundsText(level)})`,
            "keep the building and one ring of cells around it inside the level",
            extra,
          );
      });
      (st.volumes ?? []).forEach((v, vi) => {
        if (!cellIn(lb, [v.x, v.y]) || !cellIn(lb, [v.x + v.w - 1, v.y + v.h - 1]))
          sink.error(
            "bounds_exceeded",
            `${p}/volumes/${vi}`,
            `building "${st.id}": volume ${v.id} ${v.x},${v.y} ${v.w}x${v.h} leaves level "${level.id}" (${boundsText(level)})`,
            "keep the building and one ring of cells around it inside the level",
            extra,
          );
      });
    }
  });

  level.areas.forEach((area, ai) => {
    const p = `${base}/areas/${ai}`;
    checkShape(area.shape, `${p}/shape`, level, true, sink, area.id, true);
    if (area.shape.type === "route") {
      for (const end of ["from", "to"] as const) {
        const ref = area.shape[end];
        if (typeof ref === "string") {
          if (areaRefCheck(ref, `${p}/shape/${end}`, level, plan, sink, area.id, "route")) {
            const target = level.areas.find((a) => a.id === ref);
            if (target?.shape.type === "route") {
              sink.error(
                "shape_invalid",
                `${p}/shape/${end}`,
                `route "${area.id}" ends at "${ref}", which is itself a route`,
                "route between rooms (or explicit [x,y] cells); connect corridors with a cell endpoint",
                { elementId: area.id, levelId: level.id },
              );
            }
          }
        } else if (!cellIn(lb, ref)) {
          sink.error(
            "bounds_exceeded",
            `${p}/shape/${end}`,
            `route "${area.id}" endpoint [${ref.join(",")}] is outside level "${level.id}" (${boundsText(level)})`,
            `use a cell inside the level, e.g. [${clampCell(lb, ref).join(",")}]`,
            { elementId: area.id, levelId: level.id, cell: ref },
          );
        }
      }
    }
    if (area.labelAt !== undefined && !cellIn(lb, area.labelAt)) {
      sink.error(
        "bounds_exceeded",
        `${p}/labelAt`,
        `labelAt [${area.labelAt.join(",")}] of "${area.id}" is outside level "${level.id}" (${boundsText(level)})`,
        "omit labelAt to use the area anchor, or pick a cell inside the area",
        { elementId: area.id, levelId: level.id, cell: area.labelAt },
      );
    }
  });

  level.openings.forEach((op, oi) => {
    const p = `${base}/openings/${oi}`;
    const extra = { elementId: op.id, levelId: level.id };
    const hasBetween = op.between !== undefined;
    const hasAt = op.at !== undefined;
    if (hasBetween === hasAt) {
      sink.error(
        "schema",
        p,
        `opening "${op.id}" needs exactly one of "between" or "at"${hasAt ? " (it has both)" : ""}`,
        hasAt
          ? 'remove "at" (prefer between) or remove "between"'
          : 'add between: ["areaA", "areaB"] (or "@outside"), or at: {x, y, side}',
        extra,
      );
    }
    if (op.between !== undefined) {
      const [a, b] = op.between;
      if (a === b) {
        sink.error(
          "opening_no_boundary",
          `${p}/between`,
          `opening "${op.id}" joins "${a}" to itself`,
          a === "@outside"
            ? 'one side must be an area id, e.g. ["hall", "@outside"]'
            : `use between: ["${a}", "<neighbouring area>"] or "@outside"`,
          extra,
        );
      }
      op.between.forEach((ref, k) => {
        if (ref !== "@outside") areaRefCheck(ref, `${p}/between/${k}`, level, plan, sink, op.id, "opening");
      });
    }
    if (op.at !== undefined) {
      const cell: Vec2 = [op.at.x, op.at.y];
      if (!cellIn(lb, cell)) {
        sink.error(
          "bounds_exceeded",
          `${p}/at`,
          `opening "${op.id}" is on cell [${cell.join(",")}], outside level "${level.id}" (${boundsText(level)})`,
          `use a cell inside the level next to the wall, e.g. [${clampCell(lb, cell).join(",")}]`,
          { ...extra, cell },
        );
      }
    }
  });

  level.walls.forEach((run, wi) => {
    const p = `${base}/walls/${wi}`;
    for (const prob of polylineProblems(run.points, true, `wall run "${run.id}"`)) {
      sink.error("shape_invalid", p + prob.subPath, prob.message, prob.hint, {
        elementId: run.id,
        levelId: level.id,
      });
    }
    const out = run.points.findIndex((v) => !vertexIn(lb, v));
    if (out >= 0) {
      const v = run.points[out] as Vec2;
      sink.error(
        "bounds_exceeded",
        `${p}/points/${out}`,
        `wall run "${run.id}" vertex [${v.join(",")}] is outside level "${level.id}"`,
        `wall vertices must lie within x ${lb.x0}..${lb.x1}, y ${lb.y0}..${lb.y1}`,
        { elementId: run.id, levelId: level.id },
      );
    }
  });

  level.features.forEach((f, fi) => {
    const p = `${base}/features/${fi}`;
    const extra = { elementId: f.id, levelId: level.id, cell: f.at };
    if (f.type === "custom" && (f.hint === undefined || f.hint.trim() === "")) {
      sink.error(
        "schema",
        `${p}/hint`,
        `custom feature "${f.id}" has no hint`,
        'add hint: a short asset description, e.g. "giant mushroom"',
        extra,
      );
    }
    const [w, h] = f.size ?? [1, 1];
    const turned = f.rot === 90 || f.rot === 270;
    const fw = turned ? h : w;
    const fh = turned ? w : h;
    const far: Vec2 = [f.at[0] + fw - 1, f.at[1] + fh - 1];
    if (!cellIn(lb, f.at) || !cellIn(lb, far)) {
      sink.error(
        "bounds_exceeded",
        `${p}/at`,
        `feature "${f.id}" footprint [${f.at.join(",")}]..[${far.join(",")}] is outside level "${level.id}" (${boundsText(level)})`,
        `move it to e.g. [${clampCell({ ...lb, x1: lb.x1 - fw + 1, y1: lb.y1 - fh + 1 }, f.at).join(",")}]`,
        extra,
      );
    }
  });

  level.terrain.forEach((t, ti) => {
    const p = `${base}/terrain/${ti}`;
    const extra = { elementId: t.id, levelId: level.id };
    switch (t.op) {
      case "paint":
      case "noise":
        checkShape(t.shape, `${p}/shape`, level, false, sink, t.id, true);
        break;
      case "height":
        checkShape(t.shape, `${p}/shape`, level, false, sink, t.id, true);
        if ((t.delta === undefined) === (t.set === undefined)) {
          sink.error(
            "schema",
            p,
            `height op "${t.id}" needs exactly one of "delta" or "set"`,
            t.delta === undefined
              ? "add delta (relative) or set (absolute), e.g. set: 0.5"
              : "remove one of delta/set",
            extra,
          );
        }
        break;
      case "path":
        if ((t.points === undefined) === (t.connect === undefined))
          sink.error(
            "schema",
            p,
            `path "${t.id}" needs exactly one of "points" or "connect"`,
            "connect: [areaId, featureId or [x,y], …] joins things in order; points: cell centres",
            extra,
          );
        for (const prob of polylineProblems(t.points ?? [], false, `terrain path "${t.id}"`)) {
          sink.error("shape_invalid", p + prob.subPath, prob.message, prob.hint, extra);
        }
        break;
      case "scatter":
        if (t.shape !== undefined) checkShape(t.shape, `${p}/shape`, level, false, sink, t.id, true);
        (t.exclude ?? []).forEach((s, si) => {
          checkShape(s, `${p}/exclude/${si}`, level, false, sink, t.id, false);
        });
        break;
      case "dress":
        // generator 2: no area (or the level's own id) dresses the whole level
        if (t.area === undefined || t.area === level.id) {
          if (!generatorProfile(plan).dressWholeLevel)
            sink.error(
              "ref_unknown",
              `${p}/area`,
              `dress op "${t.id}" needs an area on generator 1`,
              `write area: one of ${level.areas.map((a) => `"${a.id}"`).join(", ") || "(no areas: add a zone area)"}`,
              { elementId: t.id, levelId: level.id },
            );
          break;
        }
        areaRefCheck(t.area, `${p}/area`, level, plan, sink, t.id, "dress op");
        break;
    }
  });

  level.labels.forEach((lab, i) => {
    if (!cellIn(lb, lab.at)) {
      sink.error(
        "bounds_exceeded",
        `${base}/labels/${i}/at`,
        `label "${lab.id}" at [${lab.at.join(",")}] is outside level "${level.id}" (${boundsText(level)})`,
        `move it to e.g. [${clampCell(lb, lab.at).join(",")}]`,
        { elementId: lab.id, levelId: level.id, cell: lab.at },
      );
    }
  });
}

function checkLinks(plan: MapPlan, sink: IssueSink): void {
  const levelIds = plan.levels.map((l) => l.id);
  plan.links.forEach((link: LevelLink, i) => {
    const p = `/links/${i}`;
    const extra = { elementId: link.id };
    const from = plan.levels.find((l) => l.id === link.from.level);
    const to = plan.levels.find((l) => l.id === link.to.level);
    for (const [end, lvl] of [
      ["from", from],
      ["to", to],
    ] as const) {
      if (lvl === undefined) {
        const ref = link[end].level;
        const near = nearest(ref, levelIds);
        sink.error(
          "ref_unknown",
          `${p}/${end}/level`,
          `link "${link.id}" ${end}.level "${ref}" is not a level`,
          `${near !== undefined ? `did you mean "${near}"? ` : ""}levels: ${listForHint(levelIds)}`,
          extra,
        );
      }
    }
    if (from === undefined || to === undefined) return;
    if (from.id === to.id) {
      sink.error(
        "link_mismatch",
        `${p}/to/level`,
        `link "${link.id}" connects level "${from.id}" to itself`,
        "to.level must be a different (higher) level",
        extra,
      );
      return;
    }
    const geo = linkGeometry(link, from.elevation, to.elevation);
    if (geo.rise <= 0) {
      sink.error(
        "link_mismatch",
        `${p}/from/level`,
        `link "${link.id}": from.level "${from.id}" (elevation ${from.elevation}) must be BELOW to.level "${to.id}" (elevation ${to.elevation})`,
        `swap them: from {level: "${to.id}", …} is the lower end, to {level: "${from.id}"} the upper`,
        extra,
      );
      return;
    }
    const arrival = geo.arrival;
    if (link.to.at !== undefined && (link.to.at[0] !== arrival[0] || link.to.at[1] !== arrival[1])) {
      const why =
        link.kind === "stairs" || link.kind === "ramp"
          ? `${link.kind} from ${from.id} ${link.from.at.join(",")} dir ${link.dir ?? "N"} rise ${geo.rise} arrive at ${arrival.join(",")}`
          : `${link.kind} arrives directly above its start ${arrival.join(",")}`;
      sink.error(
        "link_mismatch",
        `${p}/to/at`,
        `link "${link.id}": ${why}, not ${link.to.at.join(",")}`,
        `omit to.at or set it to [${arrival.join(",")}]`,
        { ...extra, levelId: to.id, cell: arrival },
      );
    }
    const fb = levelBox(from);
    const outLow = geo.lowerCells.find((c) => !cellIn(fb, c));
    if (outLow !== undefined) {
      sink.error(
        "bounds_exceeded",
        `${p}/from/at`,
        `link "${link.id}" run cell [${outLow.join(",")}] is outside level "${from.id}" (${boundsText(from)})`,
        link.kind === "stairs" || link.kind === "ramp"
          ? `the run is ${geo.length} cells toward ${link.dir ?? "N"}; move from.at or change dir`
          : "move from.at inside the level",
        { ...extra, levelId: from.id, cell: outLow },
      );
    }
    const tb = levelBox(to);
    const outHigh = geo.arrivalCells.find((c) => !cellIn(tb, c));
    if (outHigh !== undefined) {
      sink.error(
        "bounds_exceeded",
        `${p}/to`,
        `link "${link.id}" arrives at [${outHigh.join(",")}], outside level "${to.id}" (${boundsText(to)})`,
        "move from.at or change dir so the arrival lies inside the upper level",
        { ...extra, levelId: to.id, cell: outHigh },
      );
    }
  });
}

function checkThemes(plan: MapPlan, themes: readonly string[], sink: IssueSink): void {
  const known = new Set(themes);
  const warn = (theme: string, path: string, extra: { elementId?: string; levelId?: string }): void => {
    if (known.has(theme)) return;
    const near = nearest(theme, themes);
    sink.add(
      "warning",
      "theme_unknown",
      path,
      `theme "${theme}" is not installed; the map theme is used instead`,
      `${near !== undefined ? `did you mean "${near}"? ` : ""}themes: ${listForHint([...themes])}`,
      extra,
    );
  };
  warn(plan.theme, "/theme", {});
  plan.levels.forEach((level, li) => {
    if (level.theme !== undefined)
      warn(level.theme, `/levels/${li}/theme`, { elementId: level.id, levelId: level.id });
    level.areas.forEach((a, ai) => {
      if (a.theme !== undefined)
        warn(a.theme, `/levels/${li}/areas/${ai}/theme`, { elementId: a.id, levelId: level.id });
    });
  });
}
