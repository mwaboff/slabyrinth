/**
 * Honour the brief: the request's own words, put back in front of the model when it decides whether it is done,
 * and a few words that map to something measurable (BRIEF_WORDS, data). Theme-neutral; no language analysis beyond
 * splitting the brief into words.
 */
import type { DesignBrief, MapPlan } from "../contracts/plan";
import { CELL, CELL_FLAG, type ResolvedPlan, type ResolvedStructure } from "../contracts/resolved";
import type { DesignNote } from "./review";

/** The brief as one line of its listed parts (empty when there is no brief and no title). */
export function briefCheckLine(brief: DesignBrief | undefined, plan: MapPlan): string {
  const parts: string[] = [];
  if (brief?.mapType) parts.push(`map: ${brief.mapType.value}`);
  if (brief?.tone) parts.push(`tone: ${brief.tone.value}`);
  if (brief?.mustInclude && brief.mustInclude.value.length > 0)
    parts.push(`must include: ${brief.mustInclude.value.join("; ")}`);
  if (brief?.avoid && brief.avoid.value.length > 0) parts.push(`avoid: ${brief.avoid.value.join("; ")}`);
  if (parts.length === 0 && plan.title) parts.push(`title: ${plan.title}`);
  if (parts.length === 0) return "";
  return `BRIEF CHECK: confirm each of these is visibly true in the map, or tell the user plainly what could not be done — ${parts.join(" | ")}`;
}

/** The brief's words, lower case (for the word-to-measure table). */
export function briefWords(brief: DesignBrief | undefined, plan: MapPlan): Set<string> {
  const text = [brief?.mapType?.value, brief?.tone?.value, ...(brief?.mustInclude?.value ?? []), plan.title]
    .filter((s): s is string => typeof s === "string")
    .join(" ")
    .toLowerCase();
  return new Set(text.split(/[^a-z]+/).filter((w) => w.length > 2));
}

type Measure = (plan: MapPlan, r: ResolvedPlan) => string | null;

/** A tower is about this many times taller than wide. */
const TOWER_RATIO = 3;

const tallest = (r: ResolvedPlan): { s: ResolvedStructure; height: number; width: number } | null => {
  let best: { s: ResolvedStructure; height: number; width: number } | null = null;
  for (const L of r.levels)
    for (const s of L.structures ?? []) {
      if (s.kind !== "building") continue;
      const height = s.storeys.reduce((t, q) => t + q.wallHeight, 0);
      const xs = s.cells.map((p) => p[0]);
      const ys = s.cells.map((p) => p[1]);
      const width = Math.max(Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1);
      if (!best || height > best.height) best = { s, height, width };
    }
  return best;
};

const levelRange = (r: ResolvedPlan): number => {
  let range = 0;
  for (const L of r.levels) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < L.cells.state.length; i++) {
      if (L.cells.state[i] !== CELL.OPEN || ((L.cells.flags[i] as number) & CELL_FLAG.NO_FLOOR) !== 0)
        continue;
      const h = L.cells.height[i] as number;
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    if (hi > lo) range = Math.max(range, (hi - lo) / 4);
  }
  return range;
};

const waterEdges = (r: ResolvedPlan): number => {
  let best = 0;
  for (const L of r.levels) {
    const W = L.bounds.w;
    const H = L.bounds.h;
    const edges = new Set<string>();
    for (let i = 0; i < W * H; i++) {
      if (((L.cells.flags[i] as number) & CELL_FLAG.WATER) === 0) continue;
      const x = i % W;
      const y = Math.floor(i / W);
      if (x === 0) edges.add("W");
      if (y === 0) edges.add("N");
      if (x === W - 1) edges.add("E");
      if (y === H - 1) edges.add("S");
    }
    best = Math.max(best, edges.size);
  }
  return best;
};

/** Brief words → a measure that says what is missing (null = fine). Data: add rows as the vocabulary grows. */
export const BRIEF_WORDS: ReadonlyArray<{ words: readonly string[]; measure: Measure; action: string }> = [
  {
    words: ["tower", "spire", "minaret", "watchtower"],
    measure: (_p, r) => {
      const t = tallest(r);
      if (!t) return "the brief names a tower but there is no building";
      if (t.height < t.width)
        return `the brief names a tower but the tallest building (${t.s.id}) is ${t.height} tiles tall and ${t.width} wide: wider than tall`;
      return t.height < TOWER_RATIO * t.width
        ? `the brief names a tower but the tallest building (${t.s.id}) is only ${t.height} tiles tall for ${t.width} wide (a tower is about ${TOWER_RATIO}x taller than wide)`
        : null;
    },
    action:
      "make it a tower: a narrow footprint (3–6 cells) with more storeys, about three times taller than wide",
  },
  {
    words: ["cliff", "gorge", "chasm", "ravine", "canyon", "precipice", "crag"],
    measure: (_p, r) => {
      const range = levelRange(r);
      return range < 3
        ? `the brief names a cliff or gorge but the largest level change is ${range} tiles`
        : null;
    },
    action:
      "make the drop bold: 3 tiles or more (platform rise, area floorHeight, or a chasm op with depth 3+)",
  },
  {
    words: ["ruined", "ruin", "ruins", "derelict", "abandoned", "crumbling"],
    measure: (_p, r) => {
      const any = r.levels.some(
        (L) =>
          (L.structures ?? []).some((s) => /ruin/.test(s.style) || s.condition === "ruined") ||
          // a map without buildings can show a ruin with rubble alone
          ((L.structures ?? []).length === 0 &&
            L.features.some((f) => f.type === "rubble" || f.type === "cave_in")),
      );
      return any
        ? null
        : "the brief says ruined but no structure has condition ruined: everything stands whole";
    },
    action: 'set condition: "ruined" on the structure (broken walls, roof and rubble follow)',
  },
  {
    words: ["twisted", "crooked", "leaning", "slender", "squat"],
    measure: (_p, r) =>
      r.levels.some((L) => (L.structures ?? []).some((s) => (s.design?.character ?? []).length > 0))
        ? null
        : "the brief gives the building a character (twisted, crooked, leaning…) but no structure carries one",
    action: 'set character on the structure (e.g. character: ["twisted"]) so its shape shows the word',
  },
  {
    words: ["river", "stream", "brook", "creek"],
    measure: (_p, r) =>
      waterEdges(r) >= 2
        ? null
        : "the brief names a river but the water does not run from one map edge to another",
    action:
      "run the water across the map: enter on one edge, leave on another, meandering through the play space",
  },
];

/** Notes for brief words whose measure finds them missing. */
export function briefNotes(
  brief: DesignBrief | undefined,
  plan: MapPlan,
  r: ResolvedPlan,
  weight: number,
): DesignNote[] {
  const words = briefWords(brief, plan);
  const out: DesignNote[] = [];
  for (const row of BRIEF_WORDS) {
    if (!row.words.some((w) => words.has(w))) continue;
    const msg = row.measure(plan, r);
    if (msg === null) continue;
    out.push({
      code: "brief_not_met",
      levelId: r.levels[0]?.id ?? "",
      score: weight,
      message: msg,
      action: row.action,
    });
  }
  return out;
}
