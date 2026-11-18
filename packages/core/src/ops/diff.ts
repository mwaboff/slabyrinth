/**
 * diffPlans (contracts/ops.ts DiffPlans): structural diff by id for change reports, Plan update cards, the
 * Compare view and chunk change badges. Pure and deterministic (document order of `after`, then `before`).
 *
 * - Elements are matched by id across the whole plan. `changed.fields` lists top-level fields whose canonical
 *   JSON differs, plus two pseudo-fields: "level" (element moved to another level) and "order" (painter order of
 *   an area / terrain op changed relative to the elements present in both plans).
 * - Levels compare their own fields only (contents are diffed as elements); `stamps` counts as a level field.
 * - Plan-level fields appear as one entry {id: plan.id, kind: "meta", fields}.
 * - `areas` roll-up: an area is "changed" if its own fields changed or an opening/feature/label/dress op inside
 *   it was added, removed or changed. Containment is approximated from shapes (see ops/geometry.ts) unless the
 *   caller passes `containingArea` (WP2 can supply the resolver's exact answer).
 */
import type { Area, AreaId, ElementId, Level, LevelId, MapPlan, Vec2 } from "../contracts/plan";
import type { DiffKind, PlanDiff } from "../contracts/ops";
import { canonicalJson } from "../util/canonical";
import { LEVEL_LIST_OF, listElements } from "../plan/elements";
import type { ElementKind, ElementLocation } from "../plan/elements";
import { across, shapeHasCell } from "./geometry";

export interface DiffOptions {
  /** Area that owns `cell` on `levelId` in `plan` (display owner), if any. */
  containingArea?: (plan: MapPlan, levelId: LevelId, cell: Vec2) => AreaId | undefined;
}

const META_FIELDS = [
  "schema",
  "generator",
  "title",
  "summary",
  "kind",
  "seed",
  "theme",
  "entryLevel",
  "notes",
] as const;
const LEVEL_FIELDS = [
  "name",
  "elevation",
  "wallHeight",
  "bounds",
  "base",
  "theme",
  "notes",
  "stamps",
] as const;

type Entry = { loc: ElementLocation; el: Record<string, unknown> };

function entries(plan: MapPlan): Map<ElementId, Entry> {
  const map = new Map<ElementId, Entry>();
  for (const loc of listElements(plan)) {
    if (loc.kind === "stamp" || map.has(loc.id)) continue;
    map.set(loc.id, { loc, el: elementRecord(plan, loc) });
  }
  return map;
}

function elementRecord(plan: MapPlan, loc: ElementLocation): Record<string, unknown> {
  if (loc.kind === "link") return plan.links[loc.index] as unknown as Record<string, unknown>;
  const level = plan.levels[loc.levelIndex] as Level;
  if (loc.kind === "level") return level as unknown as Record<string, unknown>;
  const list = (level[LEVEL_LIST_OF[loc.kind]] ?? []) as unknown as Array<Record<string, unknown>>;
  return list[loc.index] as Record<string, unknown>;
}

function diffKind(kind: ElementKind): DiffKind {
  return kind === "stamp" ? "level" : kind;
}

function ref(e: Entry): { id: ElementId; kind: DiffKind; levelId?: LevelId } {
  const out: { id: ElementId; kind: DiffKind; levelId?: LevelId } = {
    id: e.loc.id,
    kind: diffKind(e.loc.kind),
  };
  if (e.loc.levelId !== undefined && e.loc.kind !== "level") out.levelId = e.loc.levelId;
  if (e.loc.kind === "level") out.levelId = e.loc.id;
  return out;
}

function changedFields(a: Entry, b: Entry): string[] {
  const keys =
    a.loc.kind === "level"
      ? [...LEVEL_FIELDS]
      : [...new Set([...Object.keys(a.el), ...Object.keys(b.el)])].sort();
  return keys.filter((k) => canonicalJson(a.el[k] ?? null) !== canonicalJson(b.el[k] ?? null));
}

/** Rank of each id among the ids present in both lists. */
function commonRanks(list: ReadonlyArray<{ id: string }>, common: ReadonlySet<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of list) if (common.has(e.id)) m.set(e.id, m.size);
  return m;
}

function defaultContaining(plan: MapPlan, levelId: LevelId, cell: Vec2): AreaId | undefined {
  const level = plan.levels.find((l) => l.id === levelId);
  if (level === undefined) return undefined;
  let owner: Area | undefined;
  for (const a of level.areas) if (shapeHasCell(a.shape, cell[0], cell[1])) owner = a;
  return owner?.id;
}

/** Areas an element belongs to (for the room-level roll-up). */
function ownersOf(plan: MapPlan, e: Entry, containing: NonNullable<DiffOptions["containingArea"]>): AreaId[] {
  const levelId = e.loc.levelId;
  if (levelId === undefined) return [];
  switch (e.loc.kind) {
    case "feature":
    case "label": {
      const id = containing(plan, levelId, e.el.at as Vec2);
      return id !== undefined ? [id] : [];
    }
    case "opening": {
      const between = e.el.between as [string, string] | undefined;
      if (between !== undefined) return between.filter((r) => r !== "@outside");
      const at = e.el.at as { x: number; y: number; side: "N" | "E" | "S" | "W" } | undefined;
      if (at === undefined) return [];
      const ids = [
        containing(plan, levelId, [at.x, at.y]),
        containing(plan, levelId, across(at.x, at.y, at.side)),
      ];
      return ids.filter((x): x is string => x !== undefined);
    }
    case "terrain":
      return e.el.op === "dress" && typeof e.el.area === "string" ? [e.el.area] : [];
    default:
      return [];
  }
}

export function diffPlans(before: MapPlan | null, after: MapPlan, opts: DiffOptions = {}): PlanDiff {
  const containing = opts.containingArea ?? defaultContaining;
  const a = before === null ? new Map<ElementId, Entry>() : entries(before);
  const b = entries(after);
  const diff: PlanDiff = {
    added: [],
    removed: [],
    changed: [],
    areas: { added: [], changed: [], removed: [] },
  };
  const touched = new Set<AreaId>();

  // Painter-order ranks among common elements, per level list.
  const common = new Set([...b.keys()].filter((id) => a.has(id)));
  const rankBefore = new Map<string, number>();
  const rankAfter = new Map<string, number>();
  if (before !== null) {
    for (const l of before.levels) {
      for (const [k, v] of commonRanks(l.areas, common)) rankBefore.set(k, v);
      for (const [k, v] of commonRanks(l.terrain, common)) rankBefore.set(k, v);
    }
  }
  for (const l of after.levels) {
    for (const [k, v] of commonRanks(l.areas, common)) rankAfter.set(k, v);
    for (const [k, v] of commonRanks(l.terrain, common)) rankAfter.set(k, v);
  }

  for (const [id, eb] of b) {
    const ea = a.get(id);
    if (ea === undefined) {
      diff.added.push(ref(eb));
      if (eb.loc.kind === "area") diff.areas.added.push(id);
      else for (const o of ownersOf(after, eb, containing)) touched.add(o);
      continue;
    }
    const fields = changedFields(ea, eb);
    if (ea.loc.kind !== "level" && ea.loc.levelId !== eb.loc.levelId) fields.push("level");
    else if (
      (eb.loc.kind === "area" || eb.loc.kind === "terrain") &&
      rankBefore.get(id) !== rankAfter.get(id)
    )
      fields.push("order");
    if (fields.length === 0) continue;
    diff.changed.push({ ...ref(eb), fields });
    if (eb.loc.kind === "area") touched.add(id);
    else {
      for (const o of ownersOf(after, eb, containing)) touched.add(o);
      if (before !== null) for (const o of ownersOf(before, ea, containing)) touched.add(o);
    }
  }
  for (const [id, ea] of a) {
    if (b.has(id)) continue;
    diff.removed.push(ref(ea));
    if (ea.loc.kind === "area") diff.areas.removed.push(id);
    else if (before !== null) for (const o of ownersOf(before, ea, containing)) touched.add(o);
  }

  const metaFields =
    before === null
      ? []
      : META_FIELDS.filter((k) => canonicalJson(before[k] ?? null) !== canonicalJson(after[k] ?? null));
  if (metaFields.length > 0) diff.changed.push({ id: after.id, kind: "meta", fields: [...metaFields] });

  const addedAreas = new Set(diff.areas.added);
  const removedAreas = new Set(diff.areas.removed);
  // Document order of `after`, then areas that only exist in `before`.
  const order = [...b.values(), ...a.values()].filter((e) => e.loc.kind === "area").map((e) => e.loc.id);
  const seen = new Set<string>();
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (touched.has(id) && !addedAreas.has(id) && !removedAreas.has(id) && b.has(id) && a.has(id))
      diff.areas.changed.push(id);
  }
  return diff;
}

/** One-line summary of a diff ("2 added · 1 changed · 0 removed rooms"). */
export function summarizeDiff(diff: PlanDiff): string {
  const n = (k: "added" | "changed" | "removed") => diff.areas[k].length;
  return `${n("added")} added · ${n("changed")} changed · ${n("removed")} removed`;
}
