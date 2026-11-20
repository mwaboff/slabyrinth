/**
 * Element addressing: every plan element (level, area, opening, wall run, feature, terrain op, label, link, stamp)
 * by its plan-wide id. Used by validation (duplicates, references, hints) and by applyOps (id-addressed edits).
 */
import type { ElementId, LevelId, MapPlan } from "../contracts/plan";
import type { DiffKind } from "../contracts/ops";

export type ElementKind =
  | "level"
  | "area"
  | "opening"
  | "wall_run"
  | "feature"
  | "terrain"
  | "label"
  | "link"
  | "stamp"
  | "structure";

/** Level list field that holds each per-level element kind. */
export const LEVEL_LIST_OF = {
  area: "areas",
  opening: "openings",
  wall_run: "walls",
  feature: "features",
  terrain: "terrain",
  label: "labels",
  stamp: "stamps",
  structure: "structures",
} as const;
export type LevelListKind = keyof typeof LEVEL_LIST_OF;
export type LevelListField = (typeof LEVEL_LIST_OF)[LevelListKind];

export const LEVEL_LIST_KINDS: readonly LevelListKind[] = [
  "area",
  "opening",
  "wall_run",
  "feature",
  "terrain",
  "label",
  "stamp",
  "structure",
];

export interface ElementLocation {
  id: ElementId;
  kind: ElementKind;
  /** Index of the containing level (levels: its own index; links: -1). */
  levelIndex: number;
  levelId?: LevelId;
  /** Index in its list (plan.levels, level.<list>, plan.links). */
  index: number;
  /** JSON pointer, e.g. "/levels/0/areas/3". */
  path: string;
}

/** Human-readable kind names for messages. */
export const KIND_LABEL: Record<ElementKind, string> = {
  level: "level",
  area: "area",
  opening: "opening",
  wall_run: "wall run",
  feature: "feature",
  terrain: "terrain op",
  label: "label",
  link: "link",
  stamp: "stamp",
  structure: "structure",
};

/** DiffKind for an element kind. DiffKind has no "stamp": a stamp change is reported as a change of its level. */
export function diffKindOf(kind: ElementKind): DiffKind {
  return kind === "stamp" ? "level" : kind;
}

/**
 * Lists every element in document order. Duplicated ids appear several times (validation reports them).
 * Order: plan.levels[i] then its areas, openings, walls, features, terrain, labels, stamps, structures; then links.
 */
export function listElements(plan: MapPlan): ElementLocation[] {
  const out: ElementLocation[] = [];
  plan.levels.forEach((level, li) => {
    out.push({
      id: level.id,
      kind: "level",
      levelIndex: li,
      levelId: level.id,
      index: li,
      path: `/levels/${li}`,
    });
    for (const kind of LEVEL_LIST_KINDS) {
      const field = LEVEL_LIST_OF[kind];
      const list: ReadonlyArray<{ id: string }> = level[field] ?? [];
      list.forEach((el, i) => {
        out.push({
          id: el.id,
          kind,
          levelIndex: li,
          levelId: level.id,
          index: i,
          path: `/levels/${li}/${field}/${i}`,
        });
      });
    }
  });
  plan.links.forEach((link, i) => {
    out.push({ id: link.id, kind: "link", levelIndex: -1, index: i, path: `/links/${i}` });
  });
  return out;
}

/** id → first location. */
export function indexElements(plan: MapPlan): Map<ElementId, ElementLocation> {
  const map = new Map<ElementId, ElementLocation>();
  for (const loc of listElements(plan)) if (!map.has(loc.id)) map.set(loc.id, loc);
  return map;
}

/** Returns `base` if unused, else the first of base_2, base_3 … not in `used` (kept within the 32-char id limit). */
export function freeId(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = base.slice(0, 32 - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
}
