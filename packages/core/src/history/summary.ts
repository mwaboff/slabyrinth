/**
 * Local change summaries for versions (UX §7.1 History rows, §8.9 "Where we left off", architecture §3.6 context
 * items): a one-line summary plus ≤ 6 bullets, computed from diffPlans without any AI call.
 * Examples: "Added Cistern Depths level", "You edited notes for 4", "Restored v4".
 */
import type { MapPlan } from "../contracts/plan";
import type { PlanDiff, VersionAuthor } from "../contracts/ops";
import { diffPlans } from "../ops/diff";

export interface ChangeDescription {
  summary: string;
  bullets: string[];
}

const FIELD_WORDS: Record<string, string> = {
  notes: "notes",
  readAloud: "read-aloud text",
  encounter: "encounter",
  name: "name",
  key: "key",
  shape: "shape",
  floor: "floor",
  floorHeight: "floor height",
  walls: "walls",
  wallStyle: "wall style",
  wallHeight: "wall height",
  theme: "theme",
  tags: "tags",
  labelAt: "label position",
  level: "level",
  order: "order",
  kind: "kind",
};

function areaLabel(plan: MapPlan | null, id: string): string {
  for (const l of plan?.levels ?? []) {
    const a = l.areas.find((x) => x.id === id);
    if (a !== undefined) return a.key ?? a.name ?? id;
  }
  return id;
}

function levelLabel(plan: MapPlan | null, id: string): string {
  return plan?.levels.find((l) => l.id === id)?.name ?? id;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function list(items: string[], max = 3): string {
  return items.length <= max
    ? items.join(", ")
    : `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

/** Describes the change from `before` to `after` (diff computed if not supplied). */
export function describeChanges(
  before: MapPlan | null,
  after: MapPlan,
  author: VersionAuthor,
  diff?: PlanDiff,
): ChangeDescription {
  if (before === null) {
    const rooms = after.levels.reduce(
      (n, l) => n + l.areas.filter((a) => a.kind !== "corridor" && a.kind !== "zone").length,
      0,
    );
    return {
      summary: `Created "${after.title}"`,
      bullets: [`${plural(after.levels.length, "level")}, ${plural(rooms, "room")}`],
    };
  }
  const d = diff ?? diffPlans(before, after);
  const phrases: string[] = [];
  const kinds = (arr: PlanDiff["added"], kind: string) => arr.filter((e) => e.kind === kind);

  const addedLevels = kinds(d.added, "level").map((e) => levelLabel(after, e.id));
  const removedLevels = kinds(d.removed, "level").map((e) => levelLabel(before, e.id));
  if (addedLevels.length > 0)
    phrases.push(`added ${list(addedLevels)} level${addedLevels.length > 1 ? "s" : ""}`);
  if (removedLevels.length > 0)
    phrases.push(`removed ${list(removedLevels)} level${removedLevels.length > 1 ? "s" : ""}`);

  const addedAreas = d.areas.added.map((id) => areaLabel(after, id));
  const removedAreas = d.areas.removed.map((id) => areaLabel(before, id));
  if (addedAreas.length > 0) phrases.push(`added ${list(addedAreas)}`);
  if (removedAreas.length > 0) phrases.push(`removed ${list(removedAreas)}`);

  for (const c of d.changed.filter((e) => e.kind === "area")) {
    const words = c.fields.map((f) => FIELD_WORDS[f] ?? f);
    phrases.push(`edited ${list(words)} for ${areaLabel(after, c.id)}`);
  }
  for (const kind of ["structure", "feature", "opening", "link", "terrain", "label", "wall_run"] as const) {
    const word = {
      structure: "building",
      feature: "feature",
      opening: "opening",
      link: "level link",
      terrain: "terrain op",
      label: "label",
      wall_run: "wall run",
    }[kind];
    const a = kinds(d.added, kind).length;
    const r = kinds(d.removed, kind).length;
    const c = d.changed.filter((e) => e.kind === kind).length;
    if (a > 0) phrases.push(`added ${plural(a, word)}`);
    if (r > 0) phrases.push(`removed ${plural(r, word)}`);
    if (c > 0) phrases.push(`changed ${plural(c, word)}`);
  }
  for (const c of d.changed.filter((e) => e.kind === "level"))
    phrases.push(`edited ${list(c.fields.map((f) => FIELD_WORDS[f] ?? f))} of ${levelLabel(after, c.id)}`);
  const meta = d.changed.find((e) => e.kind === "meta");
  if (meta !== undefined) phrases.push(`edited map ${list(meta.fields)}`);

  if (phrases.length === 0)
    return { summary: author === "user" ? "You made no changes" : "No changes", bullets: [] };
  const first = phrases[0] as string;
  const summary = author === "user" ? `You ${first}` : first.charAt(0).toUpperCase() + first.slice(1);
  const bullets = phrases.slice(0, 6).map((p) => p.charAt(0).toUpperCase() + p.slice(1));
  return { summary: phrases.length > 1 ? `${summary} (+${phrases.length - 1} more)` : summary, bullets };
}
