/**
 * Turns Zod issues into model-facing PlanIssues (architecture §2.8, §3.4): stable code, JSON-pointer path,
 * the element/level ids on that path, a plain message, and a concrete hint (expected value, valid enum values,
 * nearest valid value, valid keys).
 */
import { z } from "zod";
import type { PlanIssue, PlanIssueCode } from "../contracts/plan";
import { listForHint, nearest } from "../util/strings";
import { ID_PATTERN } from "./schema";

type Key = PropertyKey;

export function toPointer(path: readonly Key[]): string {
  return path.length === 0
    ? ""
    : "/" + path.map((k) => String(k).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Value inside `root` at `path`, or undefined. */
export function valueAt(root: unknown, path: readonly Key[]): unknown {
  let cur: unknown = root;
  for (const k of path) {
    if (Array.isArray(cur) && typeof k === "number") cur = cur[k];
    else if (isRecord(cur) && typeof k === "string") cur = cur[k];
    else return undefined;
  }
  return cur;
}

/** Nearest element id and level id along `path` in raw input (for issue.elementId / levelId). */
export function idsAlong(root: unknown, path: readonly Key[]): { elementId?: string; levelId?: string } {
  const out: { elementId?: string; levelId?: string } = {};
  if (path[0] === "levels" && typeof path[1] === "number") {
    const lv = valueAt(root, path.slice(0, 2));
    if (isRecord(lv) && typeof lv.id === "string") out.levelId = lv.id;
  }
  for (let n = path.length; n >= 1; n--) {
    const v = valueAt(root, path.slice(0, n));
    if (isRecord(v) && typeof v.id === "string") {
      out.elementId = v.id;
      break;
    }
  }
  return out;
}

/** Unwraps optional/readonly/nullable wrappers. */
function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema;
  for (;;) {
    if (
      s instanceof z.ZodExactOptional ||
      s instanceof z.ZodOptional ||
      s instanceof z.ZodNullable ||
      s instanceof z.ZodReadonly
    ) {
      s = s.def.innerType as z.ZodType;
    } else {
      return s;
    }
  }
}

/** Picks the union option matching the data (discriminator literal or first object option containing the keys). */
function pickOption(
  options: readonly z.ZodType[],
  data: unknown,
  discriminator?: string,
): z.ZodType | undefined {
  if (discriminator !== undefined && isRecord(data)) {
    const d = data[discriminator];
    for (const o of options) {
      const u = unwrap(o);
      if (u instanceof z.ZodObject) {
        const lit = (u.shape as Record<string, z.ZodType>)[discriminator];
        if (lit instanceof z.ZodLiteral && lit.values.has(d as never)) return u;
      }
    }
    return undefined;
  }
  for (const o of options) {
    const u = unwrap(o);
    if (u instanceof z.ZodObject && isRecord(data)) return u;
    if ((u instanceof z.ZodArray || u instanceof z.ZodTuple) && Array.isArray(data)) return u;
  }
  return undefined;
}

/** Walks `schema` along `path` (using `root` data to choose union options). */
export function schemaAt(schema: z.ZodType, root: unknown, path: readonly Key[]): z.ZodType | undefined {
  let s: z.ZodType | undefined = unwrap(schema);
  for (let i = 0; i <= path.length; i++) {
    const data = valueAt(root, path.slice(0, i));
    while (s instanceof z.ZodUnion) {
      const disc = s instanceof z.ZodDiscriminatedUnion ? s.def.discriminator : undefined;
      const picked = pickOption(s.options as readonly z.ZodType[], data, disc);
      s = picked === undefined ? undefined : unwrap(picked);
    }
    if (s === undefined || i === path.length) return s;
    const k = path[i];
    if (s instanceof z.ZodObject && typeof k === "string") {
      const next: z.ZodType | undefined = (s.shape as Record<string, z.ZodType | undefined>)[k];
      s = next === undefined ? undefined : unwrap(next);
    } else if (s instanceof z.ZodArray) {
      s = unwrap(s.element as z.ZodType);
    } else if (s instanceof z.ZodTuple && typeof k === "number") {
      const item = (s.def.items as readonly z.ZodType[])[k];
      s = item === undefined ? undefined : unwrap(item);
    } else {
      return undefined;
    }
  }
  return s;
}

const COORD_KEYS = new Set(["x", "y", "w", "h", "cx", "cy", "r", "rx", "ry"]);
const COORD_PARENTS = new Set(["at", "points", "labelAt", "size", "bounds", "from", "to"]);
const SHAPE_ARRAY_KEYS = new Set(["points", "rows"]);

function describe(v: unknown): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "string") return `"${v.length > 40 ? v.slice(0, 40) + "…" : v}"`;
  if (typeof v === "object") return "an object";
  return typeof v === "number" || typeof v === "boolean" ? String(v) : typeof v;
}

/** Maps one Zod issue to a PlanIssue. `root` is the raw input; `rootSchema` the schema it was parsed with. */
export function zodIssueToPlanIssue(
  issue: z.core.$ZodIssue,
  root: unknown,
  rootSchema: z.ZodType,
  basePath: readonly Key[] = [],
): PlanIssue {
  const path = [...basePath, ...issue.path];
  const pointer = toPointer(path);
  const last = path[path.length - 1];
  const parent = path[path.length - 2];
  const actual = valueAt(root, path);
  const ids = idsAlong(root, path);
  let code: PlanIssueCode = "schema";
  let message = issue.message;
  let hint: string | undefined;

  switch (issue.code) {
    case "invalid_type": {
      if (actual === undefined) {
        message = `required field "${String(last)}" is missing`;
        hint = `add "${String(last)}" (${issue.expected})`;
      } else {
        message = `expected ${issue.expected} at ${pointer}, got ${describe(actual)}`;
        hint = issue.expected === "int" ? "use a whole number" : `use a value of type ${issue.expected}`;
      }
      break;
    }
    case "invalid_format": {
      const pattern = "pattern" in issue ? issue.pattern : "";
      if (pattern === String(ID_PATTERN)) {
        code = "id_format";
        const s = typeof actual === "string" ? actual : "";
        const fixed = s
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, "_")
          .replace(/^[^a-z]+/, "")
          .slice(0, 32);
        message = `invalid id ${describe(actual)}: ids are lowercase letters, digits and _, start with a letter, ≤ 32 chars`;
        hint = fixed.length > 0 ? `use "${fixed}"` : 'use an id like "room1"';
      } else {
        hint = `value must match ${pattern}`;
      }
      break;
    }
    case "not_multiple_of": {
      const divisor = issue.divisor;
      const n = typeof actual === "number" ? actual : 0;
      const snapped = Math.round(n / divisor) * divisor;
      code = divisor === 0.25 ? "height_step" : "shape_invalid";
      message =
        divisor === 0.25
          ? `height ${n} at ${pointer} is not a multiple of 0.25 tiles`
          : `${n} at ${pointer} must be a multiple of ${divisor}`;
      hint = `use ${snapped}`;
      break;
    }
    case "too_big":
    case "too_small": {
      const limit = issue.code === "too_big" ? issue.maximum : issue.minimum;
      const word = issue.code === "too_big" ? "at most" : "at least";
      if (issue.origin === "array") {
        const n = Array.isArray(actual) ? actual.length : 0;
        code = SHAPE_ARRAY_KEYS.has(String(last)) ? "shape_invalid" : "limit_exceeded";
        message = `${pointer} has ${n} items; ${word} ${String(limit)} allowed`;
        hint =
          issue.code === "too_big"
            ? `remove ${n - Number(limit)} item(s) or split across levels`
            : `add items to reach ${String(limit)}`;
      } else if (issue.origin === "string") {
        code = issue.code === "too_big" ? "limit_exceeded" : "schema";
        const n = typeof actual === "string" ? actual.length : 0;
        message =
          issue.code === "too_big"
            ? `text at ${pointer} is ${n} chars; at most ${String(limit)} allowed`
            : `text at ${pointer} must not be empty`;
        hint =
          issue.code === "too_big"
            ? `shorten it to ≤ ${String(limit)} characters`
            : "provide a non-empty value";
      } else {
        const isGeom =
          COORD_KEYS.has(String(last)) || COORD_PARENTS.has(String(parent)) || path.includes("bounds");
        code = isGeom ? "bounds_exceeded" : "schema";
        const inclusive = issue.inclusive !== false;
        message = `${describe(actual)} at ${pointer} is out of range: must be ${word} ${String(limit)}${inclusive ? "" : " (exclusive)"}`;
        hint = inclusive
          ? `use a value ${issue.code === "too_big" ? "≤" : "≥"} ${String(limit)}`
          : `use a value ${issue.code === "too_big" ? "<" : ">"} ${String(limit)}`;
      }
      break;
    }
    case "invalid_value": {
      const values = issue.values.map((v) => String(v));
      const near = typeof actual === "string" ? nearest(actual, values) : undefined;
      message = `${describe(actual)} is not a valid value at ${pointer}`;
      hint = `${near !== undefined ? `did you mean "${near}"? ` : ""}valid: ${listForHint(values, 30)}`;
      break;
    }
    case "invalid_union": {
      const disc = "discriminator" in issue ? issue.discriminator : undefined;
      const options =
        "options" in issue && Array.isArray(issue.options) ? issue.options.map((o) => String(o)) : [];
      if (disc !== undefined && options.length > 0) {
        const got = isRecord(actual) ? actual[disc] : actual;
        const near = typeof got === "string" ? nearest(got, options) : undefined;
        message = `unknown ${disc} ${describe(got)} at ${pointer}`;
        hint = `${near !== undefined ? `did you mean "${near}"? ` : ""}valid ${disc} values: ${listForHint(options, 30)}`;
      } else if (last === "from" || last === "to") {
        message = `route endpoint at ${pointer} must be an area id or a [x, y] cell, got ${describe(actual)}`;
        hint = 'use an area id like "hall" or a cell like [4, 7]';
      } else {
        message = `${describe(actual)} at ${pointer} does not match any allowed form`;
        hint = "check the field's type against the schema";
      }
      break;
    }
    case "unrecognized_keys": {
      const target = schemaAt(rootSchema, root, path);
      const valid = target instanceof z.ZodObject ? Object.keys(target.shape) : [];
      const parts = issue.keys.map((k) => {
        const near = nearest(k, valid);
        return near !== undefined ? `"${k}" → did you mean "${near}"?` : `"${k}"`;
      });
      message = `unknown field(s) ${issue.keys.map((k) => `"${k}"`).join(", ")} at ${pointer === "" ? "plan root" : pointer}`;
      hint = `${parts.join("; ")}${valid.length > 0 ? `; valid fields: ${valid.join(", ")}` : ""}`;
      break;
    }
    default: {
      hint = "fix the value to match the plan schema";
    }
  }

  const out: PlanIssue = { severity: "error", code, message, path: pointer, hint };
  if (ids.elementId !== undefined) out.elementId = ids.elementId;
  if (ids.levelId !== undefined) out.levelId = ids.levelId;
  return out;
}
