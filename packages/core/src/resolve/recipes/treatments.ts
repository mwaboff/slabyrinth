/**
 * Treatments (generator 5): which detail recipes dress a subject, and how. A subject is what one hand would dress as a
 * whole: a building (its walls, every storey), else an area (a room's walls, a yard's or field's ground), else the
 * level. A treatment is one option per family from TREATMENTS, a weighted, deterministic choice named by the plan seed,
 * the level and the draw (`hashUnitMixed`), so the same plan always dresses the same building the same way. An option names the recipes of its family that apply and the variant
 * each takes ("bands at every floor line", "the first floor only", none); recipes declare their family (types.ts), and
 * the engine leaves a recipe out where its subject's option does not name it.
 *
 *   restraint  every family has a plain option with real weight: a bare wall is part of variety, and it saves budget.
 *   street     subjects of one kind next door to each other (buildings within NEXT_DOOR cells, areas beside each other,
 *              chained) form a neighbourhood. It draws a small set of treatments (two to MAX_SET, one per three subjects
 *              and one more, each unlike the others where the weights allow), and each subject takes one of the set
 *              (its own draw), so a street shows a few treatments with repetition, never one for all, never all
 *              different. Two subjects with one draw get the same options where their weights agree.
 *   next door  a subject never takes the treatment a neighbour already took when another of the set differs: it takes
 *              the next one.
 *   weights    read what the resolved plan already says of the subject (its wall styles, storeys, condition, kind, its
 *              ground's material and wear), never new plan words.
 *   jitter     `jitter(what)` is one draw per subject: a band's depth, a pilaster pitch. Two buildings of one treatment
 *              differ a little; one building stays consistent (every face and storey reads the same draw).
 *   material   the `trim` family sets the material trims are made in: the wall's own, or a contrasting family the wall
 *              style table allows (gen/wallStyles.ts FAMILY_TRIMS) that the theme has trim pieces for. A building whose
 *              walls already show two families takes its trims in one of those two (never a third material). A theme
 *              with one material has one value: its own.
 *   condition  (generator 5, round three) a subject's state, kept / worn / ramshackle / ruined (gen/buildingCondition.ts:
 *              the plan's condition refined by its words), shifts the weights of every family and opens a few of its
 *              own: growth at the wall feet, graded rubble at a ruin's breaches. It never forces an option (each
 *              family keeps a plain one) and never turns or darkens anything. Families that change a building's
 *              structure (STRUCTURE_TREATMENTS: roof patches, porch wear, ruin events) are drawn by the same rule, once
 *              per building, when the building is planned (resolve/building/), as `drawStructureOption`.
 *   style      a sacred or formal building (its words) may draw a threshold option: a mirrored guardian pair flanking
 *              its main door, a light pair at its approach, both, or plain.
 */
import type { ThemeId, Vec2 } from "../../contracts/plan";
import type { ResolvedLevel } from "../../contracts/resolved";
import {
  buildingState,
  wearOfState,
  type BuildingWords,
  type ConditionState,
} from "../../gen/buildingCondition";
import {
  FAMILY_TRIMS,
  FAMILY_TRIM_STYLE,
  THEME_WALL_STYLE,
  wallStyleInfo,
  type WallFamily,
} from "../../gen/wallStyles";
import { hashUnitMixed } from "../../util/hash";
import { maxOf } from "../../util/lists";
import type { ZoneAnchor } from "../anchors";
import { boxGap, cellsBox, type CellBox } from "../neighbours";
import { volumesOf } from "../structureFaces";

/** Buildings this close (cells between footprints) are next door; areas next door touch or are one cell apart. */
export const NEXT_DOOR = { building: 3, area: 1 } as const;
/** Draws a neighbourhood makes for a treatment unlike its others before it accepts a repeat. */
const ATTEMPTS = 8;
/** The most treatments one neighbourhood shows (a street: two to four, with repetition). */
const MAX_SET = 4;

/** What the resolved plan says of a subject, all a weight may read. */
export interface Subject {
  readonly id: string;
  readonly kind: "building" | "area" | "level";
  readonly box: CellBox;
  readonly theme: ThemeId;
  /** Storeys of its tallest volume (buildings), 1 for an area. */
  readonly storeys: number;
  /** The wall styles it shows (a building's storeys and footing; an area's own walls are not known here: empty). */
  readonly walls: readonly string[];
  readonly condition: "intact" | "weathered" | "ruined";
  /** A room, corridor or building floor (not open ground). */
  readonly indoor: boolean;
  /** Its floor is mostly natural ground (grass, dirt, rock ...). */
  readonly natural: boolean;
  /** 0 kept up, 1 worn (a rough interior, a weathered building), 2 abandoned or ruined. */
  readonly wear: 0 | 1 | 2;
  /** Its condition state (gen/buildingCondition.ts); an area's follows its wear. */
  readonly state: ConditionState;
  /** A ruin's severity 1..3, else 0. */
  readonly severity: 0 | 1 | 2 | 3;
  /** A sacred or formal building (its words): the threshold options apply. */
  readonly role: "sacred" | "formal" | null;
  /**
   * Generator 5 (`readableTrims`): its theme makes a contrasting trim for its walls itself (not borrowed), so contrast
   * is drawn more often. Absent: not asked.
   */
  readonly contrastOwn?: boolean;
}

export interface TreatmentOption {
  readonly id: string;
  readonly weight: (s: Subject) => number;
  /** The recipes of the family it applies, each with its variant. */
  readonly recipes: Readonly<Record<string, string>>;
  /** For the trim family: trims in a contrasting material. */
  readonly contrast?: boolean;
}

export interface TreatmentFamily {
  readonly id: string;
  readonly doc: string;
  readonly options: readonly TreatmentOption[];
}

const masonry = (s: Subject): boolean =>
  s.walls.some((w) => {
    const f = wallStyleInfo(w)?.family;
    return f === "stone" || f === "brick" || f === "theme";
  });
const ruined = (s: Subject): boolean => s.condition === "ruined";
const building = (s: Subject): boolean => s.kind === "building";

/**
 * The families, their options and weights (the one table). Recipe ids are the table entries' (table.ts); a recipe in
 * no option of its family is never applied.
 */
export const TREATMENTS: readonly TreatmentFamily[] = [
  {
    id: "frame",
    doc: "posts: at jambs and corners, at doors only, at corners only, pilasters on blank runs, or none",
    options: [
      {
        id: "framed",
        weight: (s) => (ruined(s) ? 0 : building(s) ? 3 : 1),
        recipes: { jambPosts: "all", cornerPosts: "all" },
      },
      {
        id: "doors",
        weight: (s) => (ruined(s) ? 0 : 1.5),
        recipes: { jambPosts: "doors", cornerPosts: "all" },
      },
      { id: "corners", weight: (s) => (ruined(s) ? 0 : 2), recipes: { cornerPosts: "all" } },
      {
        id: "pilasters",
        weight: (s) => (ruined(s) ? 0 : building(s) ? 2 : 1.5),
        recipes: { pilasters: "bays", cornerPosts: "all" },
      },
      {
        id: "plain",
        weight: (s) => (ruined(s) ? 1 : s.state === "ramshackle" ? 4 : s.state === "worn" ? 3 : 2),
        recipes: {},
      },
    ],
  },
  {
    id: "courses",
    doc: "horizontal courses: bands at every floor line, at the first floor only, a plinth at the foot, both, or none",
    options: [
      {
        id: "banded",
        weight: (s) => (ruined(s) || s.storeys < 2 ? 0 : 3),
        recipes: { bandCourses: "every", plinths: "base" },
      },
      {
        id: "bands",
        weight: (s) => (ruined(s) || s.storeys < 2 ? 0 : 2),
        recipes: { bandCourses: "every" },
      },
      {
        id: "firstFloor",
        weight: (s) => (ruined(s) || s.storeys < 3 ? 0 : 2),
        recipes: { bandCourses: "first", plinths: "base" },
      },
      {
        id: "plinth",
        weight: (s) => (ruined(s) ? 0 : building(s) ? 2 : masonry(s) || s.indoor ? 1.5 : 0.5),
        recipes: { plinths: "base" },
      },
      { id: "plain", weight: (s) => (ruined(s) ? 1 : building(s) ? 2 : 3), recipes: {} },
    ],
  },
  {
    id: "trim",
    doc: "the material trims are made in: the wall's own, or a contrasting one the theme has",
    options: [
      // (where the theme makes a contrast itself, contrast is the likelier: own-material trim vanishes at a distance)
      { id: "own", weight: (s) => (s.contrastOwn === true ? 2 : 3), recipes: {} },
      {
        id: "contrast",
        weight: (s) => (ruined(s) ? 0 : s.contrastOwn === true ? 3 : 1.5),
        recipes: {},
        contrast: true,
      },
    ],
  },
  {
    id: "ground",
    doc: "ground cover: layered cover, cover gathered at the edges, a sparse scatter, or bare ground",
    options: [
      {
        id: "layered",
        weight: (s) => (s.kind === "building" ? 0 : s.indoor ? (s.wear > 0 ? 1.5 : 0) : s.natural ? 3 : 1.5),
        recipes: { layeredGround: "layered" },
      },
      {
        id: "edges",
        weight: (s) => (s.kind === "building" ? 0 : s.indoor ? (s.wear > 0 ? 2 : 0.5) : 2),
        recipes: { layeredGround: "edges" },
      },
      {
        id: "sparse",
        weight: (s) => (s.kind === "building" ? 0 : s.indoor ? 1 : 1.5),
        recipes: { layeredGround: "sparse" },
      },
      { id: "plain", weight: (s) => (s.indoor && s.wear === 0 ? 4 : 1), recipes: {} },
    ],
  },
  {
    id: "growth",
    doc: "growth at a building's wall feet, on faces with no door, more toward the back: a fringe, thick, or none",
    options: [
      // (a kept building is weeded, a ruin mostly grown)
      { id: "feet", weight: onBuildings(perState(0, 3, 3, 2)), recipes: { wallFootGrowth: "feet" } },
      { id: "thick", weight: onBuildings(perState(0, 0.5, 1.5, 3)), recipes: { wallFootGrowth: "thick" } },
      { id: "plain", weight: (s) => (building(s) ? perState(6, 1.5, 1, 1)(s) : 1), recipes: {} },
    ],
  },
  {
    id: "rubble",
    doc: "a ruin's rubble graded by distance from each breach (big blocks near, piles, small stones far), or none",
    options: [
      { id: "graded", weight: onBuildings(perState(0, 0, 0, 4)), recipes: { breachRubble: "graded" } },
      { id: "plain", weight: () => 1, recipes: {} },
    ],
  },
  {
    id: "threshold",
    doc: "a sacred or formal building's threshold: a guardian pair flanking its main door, lights at its approach, both, or none",
    options: [
      {
        id: "guardians",
        weight: (s) => (s.role === "sacred" ? 3 : s.role === "formal" ? 1.5 : 0),
        recipes: { guardianPair: "pair" },
      },
      {
        id: "lights",
        weight: (s) => (ruined(s) ? 0 : s.role === "sacred" ? 2 : s.role === "formal" ? 1.5 : 0),
        recipes: { approachLights: "pair" },
      },
      {
        id: "both",
        weight: (s) => (ruined(s) ? 0 : s.role === "sacred" ? 2 : s.role === "formal" ? 0.5 : 0),
        recipes: { guardianPair: "pair", approachLights: "pair" },
      },
      { id: "plain", weight: (s) => (s.role === null ? 1 : 1.5), recipes: {} },
    ],
  },
];

/**
 * The families that change a building's structure, drawn once per building when it is planned (resolve/building/), by
 * the same weighted rule as the families above (`drawStructureOption`). Each has a plain option of real weight; the
 * switch named in each doc builds it.
 */
export const STRUCTURE_TREATMENTS: readonly TreatmentFamily[] = [
  {
    id: "roofPatch",
    doc: "switch roofPatches: patches of a worn roof re-laid in a second roof kit (worn about 15 %, ramshackle 30-45 %)",
    options: [
      { id: "patched", weight: perState(0, 0.4, 0.8, 0), recipes: {} },
      { id: "plain", weight: perState(1, 0.6, 0.2, 1), recipes: {} },
    ],
  },
  {
    id: "porchSag",
    doc: "switch porchWear: a porch roof whose outer edge has sagged one step (0.25), never the building's own eave",
    options: [
      { id: "sag", weight: perState(0, 0.3, 0.6, 0), recipes: {} },
      { id: "plain", weight: perState(1, 0.7, 0.4, 1), recipes: {} },
    ],
  },
  {
    id: "porchPosts",
    doc: "switch porchWear: a porch held up by posts of two kinds (a post replaced with what was to hand)",
    options: [
      { id: "mixed", weight: perState(0, 0.3, 0.7, 0), recipes: {} },
      { id: "matched", weight: perState(1, 0.7, 0.3, 1), recipes: {} },
    ],
  },
  {
    id: "ruinEvents",
    doc: "switch ruinBays: how a ruin lost its bays: single bays (its plain option), or a first event three cells wide",
    options: [
      { id: "bays", weight: (s) => (ruined(s) ? 3 : 1), recipes: {} },
      { id: "wide", weight: (s) => (ruined(s) && s.severity >= 2 ? 1.5 : 0), recipes: {} },
    ],
  },
];

/** A weight by condition state: kept, worn, ramshackle, ruined. */
function perState(kept: number, worn: number, ramshackle: number, ruinedW: number): (s: Subject) => number {
  const w: Readonly<Record<ConditionState, number>> = { kept, worn, ramshackle, ruined: ruinedW };
  return (s) => w[s.state];
}

/** A weight that applies to buildings only (0 for an area or the level). */
function onBuildings(w: (s: Subject) => number): (s: Subject) => number {
  return (s) => (s.kind === "building" ? w(s) : 0);
}

/** The option of family `family` (STRUCTURE_TREATMENTS) a building draws, named by `seed` (its own). */
export function drawStructureOption(family: string, s: Subject, seed: string): string {
  const f = STRUCTURE_TREATMENTS.find((q) => q.id === family);
  if (!f) throw new Error(`unknown structure treatment family ${family}`);
  return pickOption(f, s, hashUnitMixed(seed, "structureTreatment", family))?.id ?? "plain";
}

/** The option a draw `u` (0..1) picks from a family's weights for a subject, null when every weight is 0. */
function pickOption(f: TreatmentFamily, s: Subject, u0: number): TreatmentOption | null {
  const ws = f.options.map((o) => Math.max(0, o.weight(s)));
  const total = ws.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let u = u0 * total;
  for (let i = 0; i < f.options.length; i++) {
    u -= ws[i] ?? 0;
    if (u < 0 && (ws[i] ?? 0) > 0) return f.options[i] as TreatmentOption;
  }
  return f.options[f.options.length - 1] as TreatmentOption;
}

/** A building's subject as the structure step knows it (its plan words read through gen/buildingCondition.ts). */
export function buildingSubject(
  id: string,
  cells: readonly Vec2[],
  theme: ThemeId,
  storeys: number,
  words: BuildingWords,
): Subject {
  const st = buildingState(words);
  const condition = words.condition ?? "intact";
  return {
    id,
    kind: "building",
    box: cellsBox(cells),
    theme,
    storeys,
    walls: [],
    condition,
    indoor: true,
    natural: false,
    wear: wearOfState(st.state),
    state: st.state,
    severity: st.severity,
    role: st.sacred ? "sacred" : st.formal ? "formal" : null,
  };
}

/** What one subject drew. */
export interface Treatment {
  readonly subject: Subject;
  /** Family id → option id. */
  readonly options: ReadonlyMap<string, string>;
  /** The options in table order, as one name ("frame:framed courses:plain ..."): what neighbours compare. */
  readonly key: string;
  /** The style trims are made in (the subject's own wall style when null). */
  readonly trim: string | null;
  /** Names the subject's draws (pieces, jitter): the same for every anchor of the subject. */
  readonly seed: string;
  /**
   * The variant of a recipe of `family`, or null when the drawn option leaves it out; "default" for a family the table
   * does not hold (a recipe outside the treatments applies everywhere).
   */
  variant(family: string, recipe: string): string | null;
  /** One draw 0..1 per subject and `what` (a parameter's jitter within its bounds). */
  jitter(what: string): number;
}

export interface TreatmentInput {
  readonly planSeed: number;
  readonly level: ResolvedLevel;
  readonly defaultTheme: ThemeId;
  /** Whether a theme has trim pieces of a wall style (its post roles answer). */
  readonly hasTrim: (theme: ThemeId, style: string) => boolean;
  /**
   * Generator 5 (`readableTrims`): whether a theme makes trim pieces of a wall style itself (not borrowed). Given:
   * contrast is drawn more often where it does, and its contrast is taken in a material it makes when it can.
   */
  readonly hasOwnTrim?: (theme: ThemeId, style: string) => boolean;
  /** The level's floor zones (what each area's floor says of it). */
  readonly zones: readonly ZoneAnchor[];
  /** The wall styles of the level walls each area sees. */
  readonly areaWalls: ReadonlyMap<string, readonly string[]>;
  /** The families to draw (default TREATMENTS). */
  readonly families?: readonly TreatmentFamily[];
  /** What the plan says of each building, by id (its condition state and role read from them); none: its condition. */
  readonly words?: ReadonlyMap<string, BuildingWords>;
}

/** Every subject of a level with its treatment, by subject id (buildings first, then areas, then the level). */
export function drawTreatments(input: TreatmentInput): Map<string, Treatment> {
  const { level: L, planSeed } = input;
  const families = input.families ?? TREATMENTS;
  const out = new Map<string, Treatment>();
  const own = input.hasOwnTrim;
  const subjects = subjectsOf(L, input.defaultTheme, input.zones, input.areaWalls, input.words).map((s) =>
    own ? { ...s, contrastOwn: contrastStyles(s, own).length > 0 } : s,
  );
  for (const group of neighbourhoods(subjects)) {
    const gid = group[0]?.id ?? "";
    // the neighbourhood's own few treatments: each a draw named by the group and its number, distinct where it can be
    const m = group.length <= 1 ? 1 : Math.min(MAX_SET, Math.max(2, Math.ceil(group.length / 3) + 1));
    const rep0 = group[0] as Subject;
    const draws: string[] = [];
    for (let c = 0; c < m; c++) {
      let key = `${gid}|${c}|0`;
      for (let k = 1; k < ATTEMPTS; k++) {
        const t = treat(rep0, families, planSeed, L.id, key, input);
        if (!draws.some((d) => treat(rep0, families, planSeed, L.id, d, input).key === t.key)) break;
        key = `${gid}|${c}|${k}`;
      }
      draws.push(key);
    }
    for (const s of group) {
      const near = group.filter((o) => o !== s && out.has(o.id) && boxGap(o.box, s.box) <= reach(s));
      const first = Math.floor(hashUnitMixed(planSeed, L.id, s.id, "set") * m);
      let t = treat(s, families, planSeed, L.id, draws[first] ?? "", input);
      for (let i = 1; i < m && near.some((o) => out.get(o.id)?.key === t.key); i++)
        t = treat(s, families, planSeed, L.id, draws[(first + i) % m] ?? "", input);
      out.set(s.id, t);
    }
  }
  return out;
}

/** How near another subject of its kind must be to be next door. */
const reach = (s: Subject): number => (s.kind === "building" ? NEXT_DOOR.building : NEXT_DOOR.area);

/** The subjects in neighbourhoods: chains of one kind next door to each other, in subject order. */
function neighbourhoods(subjects: readonly Subject[]): Subject[][] {
  const seen = new Set<Subject>();
  const out: Subject[][] = [];
  for (const s of subjects) {
    if (seen.has(s)) continue;
    const group = [s];
    seen.add(s);
    for (let i = 0; i < group.length; i++)
      for (const o of subjects)
        if (!seen.has(o) && o.kind === s.kind && boxGap((group[i] as Subject).box, o.box) <= reach(s)) {
          seen.add(o);
          group.push(o);
        }
    out.push(group.sort((p, q) => subjects.indexOf(p) - subjects.indexOf(q)));
  }
  return out;
}

/** The subject an anchor belongs to: its building, else its area, else the level. */
export const subjectIdOf = (L: ResolvedLevel, a: { structure: string | null; room: string | null }): string =>
  a.structure ?? a.room ?? L.id;

function treat(
  s: Subject,
  families: readonly TreatmentFamily[],
  planSeed: number,
  levelId: string,
  draw: string,
  input: TreatmentInput,
): Treatment {
  const options = new Map<string, string>();
  const byFamily = new Map<string, TreatmentOption>();
  let contrast = false;
  for (const f of families) {
    const pick = pickOption(f, s, hashUnitMixed(planSeed, levelId, draw, "treatment", f.id));
    if (!pick) continue;
    byFamily.set(f.id, pick);
    options.set(f.id, pick.id);
    if (pick.contrast === true) contrast = true;
  }
  const seed = `${planSeed}|${levelId}|${s.id}`;
  const trim = contrast ? contrastTrim(s, `${planSeed}|${levelId}|${draw}`, input) : null;
  // a contrast with no material to contrast in is the subject's own
  if (contrast && trim === null) options.set("trim", "own");
  return {
    subject: s,
    options,
    key: [...options].map(([f, o]) => `${f}:${o}`).join(" "),
    trim,
    seed,
    variant: (family, recipe) =>
      families.some((f) => f.id === family) ? (byFamily.get(family)?.recipes[recipe] ?? null) : "default",
    jitter: (what) => hashUnitMixed(seed, "jitter", what),
  };
}

/**
 * The style a subject's contrasting trims are made in: one of the families its walls' table row allows that the theme
 * has trim pieces for; a building already showing two wall families trims in the other of the two. Null: none.
 */
function contrastTrim(s: Subject, seed: string, input: TreatmentInput): string | null {
  const styles = contrastStyles(s, input.hasTrim);
  // (readableTrims: a material the theme makes itself before a borrowed one)
  const own = input.hasOwnTrim ? contrastStyles(s, input.hasOwnTrim) : [];
  const from = own.length > 0 ? own : styles;
  if (from.length === 0) return null;
  return from[Math.floor(hashUnitMixed(seed, "trim") * from.length)] ?? null;
}

/** The styles a subject's walls may be trimmed in by contrast (the wall table's row) that `has` says the theme has. */
function contrastStyles(s: Subject, has: (theme: ThemeId, style: string) => boolean): string[] {
  const fams = [...new Set(s.walls.map((w) => wallStyleInfo(w)?.family).filter((f): f is WallFamily => !!f))];
  const own = fams[0] ?? wallStyleInfo(THEME_WALL_STYLE)?.family ?? "theme";
  const allowed: readonly WallFamily[] = fams.length >= 2 ? fams.slice(1) : FAMILY_TRIMS[own];
  return allowed
    .map((f) => FAMILY_TRIM_STYLE[f])
    .filter((st): st is NonNullable<typeof st> => st !== null && has(s.theme, st));
}

/**
 * The subjects of a level: its buildings, its areas with open floor (what their floor zones say of them, and the styles
 * of the level walls they see), and the level itself.
 */
function subjectsOf(
  L: ResolvedLevel,
  defaultTheme: ThemeId,
  zones: readonly ZoneAnchor[],
  areaWalls: ReadonlyMap<string, readonly string[]>,
  words: ReadonlyMap<string, BuildingWords> | undefined,
): Subject[] {
  const out: Subject[] = [];
  const stateOfArea = (wear: 0 | 1 | 2): ConditionState =>
    wear === 2 ? "ruined" : wear === 1 ? "worn" : "kept";
  for (const st of L.structures ?? []) {
    if (st.kind !== "building" || st.cells.length === 0) continue;
    const vols = volumesOf(st);
    const walls = [
      ...new Set(
        [
          ...st.storeys.flatMap((q) => [q.walls, q.footing?.style ?? null]),
          ...vols.flatMap((v) => v.storeys.map((q) => q.walls)),
        ].filter((w): w is NonNullable<typeof w> => w !== null),
      ),
    ];
    const condition = st.condition ?? "intact";
    out.push({
      ...buildingSubject(
        st.id,
        st.cells,
        st.theme,
        Math.max(st.storeys.length, maxOf(vols.map((v) => v.storeys.length))),
        { ...words?.get(st.id), condition },
      ),
      walls,
    });
  }
  const built = new Set(out.map((s) => s.id));
  for (const z of zones) {
    const area = L.areas.find((q) => q.id === z.area);
    // (generator 5, buildingRooms: a building's ground-storey rooms are the building's, as its area was)
    if (!area || built.has(area.id) || (area.building !== undefined && built.has(area.building))) continue;
    const bb = area.bbox;
    out.push({
      id: area.id,
      kind: "area",
      box: { x0: bb.x, y0: bb.y, x1: bb.x + bb.w - 1, y1: bb.y + bb.h - 1 },
      theme: area.theme,
      storeys: 1,
      walls: areaWalls.get(area.id) ?? [],
      condition: z.wear === 2 ? "ruined" : "intact",
      indoor: z.indoor,
      natural: z.natural,
      wear: z.wear,
      state: stateOfArea(z.wear),
      severity: z.wear === 2 ? 2 : 0,
      role: null,
    });
  }
  out.push({
    id: L.id,
    kind: "level",
    box: { x0: L.bounds.x, y0: L.bounds.y, x1: L.bounds.x + L.bounds.w - 1, y1: L.bounds.y + L.bounds.h - 1 },
    theme: defaultTheme,
    storeys: 1,
    walls: [],
    condition: "intact",
    indoor: false,
    natural: false,
    wear: 0,
    state: "kept",
    severity: 0,
    role: null,
  });
  return out;
}
