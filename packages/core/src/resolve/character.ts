/**
 * Character (generator 5, switch `characterCascade`; build plan §12, package CH1): one reading of how lit, how kept and
 * how rich every scope of a level is, resolved once and read by every consumer through `characterAt` (during resolve)
 * and `elementCharacter` (after it, from `ResolvedLevel.character`). No consumer reads the words again.
 *
 *   axes     light dark · dim · moderate · bright · flooded (how many accents mark the places in use, never the
 *            scene's brightness); condition intact · weathered · ramshackle · ruined (a ruin's severity and stage);
 *            wealth poor · modest · wealthy · lavish; plus the light tone (warm, cold, coloured).
 *   scopes   the level (the scene: the map's title, summary and kind and the level's name and notes), a zone area (a
 *            district), a building, any other area (a room, a yard). A subject's parent is the smallest building or
 *            zone holding most of its cells (a building's: a zone; a zone's: a larger zone), else the level.
 *   precedence, per axis and subject:
 *            1 a stated value (today only `Building.condition` and a style's ruin; the phase-1 plan fields `light`,
 *              `condition` and `ramshackle` feed this slot, `statedOf`, once the owner signs them off);
 *            2 the subject's own words (gen/lightLevels.ts, gen/buildingCondition.ts, WEALTH_WORDS), then its mood
 *              words (MOODS: presets that fill only the axes its words left open);
 *            3 the parent's value, drawn with spread: light the same 60 %, a step either way 20 % each; wealth 65 % and
 *              17.5 %; condition 60 %, a step better 15 %, a step worse 25 %; never two steps; a share past the end of
 *              the scale, or into a ruin the parent is not, stays on the parent's value (ruins are never invented). A
 *              building that drew its neighbour's exact triple redraws once. A room's light is its kind's default
 *              shifted by the parent's distance from moderate (gen/rooms4/regimes.ts `roomLightLevel`);
 *            4 the default: the theme's light (dungeons and caves dim, the city bright), intact, modest.
 * Words never make a building a ruin (its plan condition or style does). Deterministic: every draw is named by the plan
 * seed, the level, the subject and the axis.
 */
import type { Area, Building, Level, MapPlan, Shape } from "../contracts/plan";
import type {
  CharacterCondition,
  CharacterLight,
  CharacterSource,
  CharacterTone,
  CharacterWealth,
  ResolvedCharacter,
  ResolvedLevel,
} from "../contracts/resolved";
import { conditionNamedBy, ruinNamedBy } from "../gen/buildingCondition";
import { lightNamedBy } from "../gen/lightLevels";
import { colourTheme, themeLight } from "./themes";
import { forEachMaskCell } from "../gen/mask";
import { classifyRoom } from "../gen/roomPurpose";
import { roomLightLevel } from "../gen/rooms4/regimes";
import type { LightLevel } from "../gen/roomTraits";
import { rasterizeShape } from "../gen/shapes";
import { generatorProfile } from "../plan/generator";
import { elementSeed, hashUnitMixed, subSeed } from "../util/hash";
import { structureStyle } from "./structureStyles";

export const CHARACTER_LIGHTS = [
  "dark",
  "dim",
  "moderate",
  "bright",
  "flooded",
] as const satisfies readonly CharacterLight[];
export const CHARACTER_CONDITIONS = [
  "intact",
  "weathered",
  "ramshackle",
  "ruined",
] as const satisfies readonly CharacterCondition[];
export const CHARACTER_WEALTHS = [
  "poor",
  "modest",
  "wealthy",
  "lavish",
] as const satisfies readonly CharacterWealth[];

/** The draw round a parent's value, per axis: [one step down, the same, one step up] shares. */
export const CHARACTER_SPREAD = {
  light: [0.2, 0.6, 0.2],
  wealth: [0.175, 0.65, 0.175],
  /** (down is better: intact is index 0) */
  condition: [0.15, 0.6, 0.25],
} as const;

/** Buildings this close (cells between plots) are next door: one with a neighbour's exact triple redraws once. */
const NEXT_DOOR = 3;

/** Wealth words, by value (whole words, lower case). */
const WEALTH_WORDS: Readonly<Record<CharacterWealth, readonly string[]>> = {
  poor: [
    "poor",
    "poverty",
    "slum",
    "slums",
    "impoverished",
    "destitute",
    "beggar",
    "beggars",
    "pauper",
    "paupers",
    "humble",
    "meagre",
    "meager",
  ],
  modest: ["modest", "ordinary", "working-class"],
  wealthy: ["wealthy", "rich", "prosperous", "affluent", "well-to-do", "noble", "nobles", "upscale", "grand"],
  lavish: [
    "lavish",
    "opulent",
    "luxurious",
    "luxury",
    "palatial",
    "sumptuous",
    "gilded",
    "extravagant",
    "royal",
  ],
};

/** A mood word is a preset: values for the axes the subject's own words left open, and a light tone. */
interface Mood {
  readonly light?: CharacterLight;
  readonly condition?: CharacterCondition;
  readonly wealth?: CharacterWealth;
  readonly tone?: CharacterTone;
}
const MOODS: Readonly<Record<string, Mood>> = {
  cosy: { light: "dim", tone: "warm" },
  cozy: { light: "dim", tone: "warm" },
  snug: { light: "dim", tone: "warm" },
  grim: { light: "dim", condition: "weathered", tone: "cold" },
  bleak: { light: "dim", condition: "weathered", tone: "cold" },
  dreary: { light: "dim", condition: "weathered", tone: "cold" },
  clinical: { light: "flooded", condition: "intact", tone: "cold" },
  sterile: { light: "flooded", condition: "intact", tone: "cold" },
  festive: { light: "bright", tone: "coloured" },
  carnival: { light: "bright", tone: "coloured" },
  sinister: { light: "dark", tone: "coloured" },
  eerie: { light: "dark", tone: "coloured" },
  sacred: { tone: "warm" },
  holy: { tone: "warm" },
  downtrodden: { light: "dim", condition: "weathered", wealth: "poor" },
  destitute: { light: "dim", condition: "weathered", wealth: "poor" },
  opulent: { light: "bright", condition: "intact", wealth: "lavish" },
  palatial: { light: "bright", condition: "intact", wealth: "lavish" },
};
const ABANDONED = /\b(abandoned|derelict|deserted|forsaken)\b/;

const wordsOf = (texts: ReadonlyArray<string | undefined>): string[] =>
  texts.flatMap((t) => (t ?? "").toLowerCase().split(/[^a-z-]+/)).filter((w) => w.length > 0);

/** The wealth the words name (the middle one when they name several). */
function wealthNamedBy(texts: ReadonlyArray<string | undefined>): CharacterWealth | undefined {
  const named = wordsOf(texts)
    .map((w) => CHARACTER_WEALTHS.findIndex((v) => WEALTH_WORDS[v].includes(w)))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  const i = named[Math.floor((named.length - 1) / 2)];
  return i === undefined ? undefined : CHARACTER_WEALTHS[i];
}

/** The mood presets the words name, merged in text order (the first word to set an axis keeps it). */
function moodOf(texts: ReadonlyArray<string | undefined>): Mood {
  let out: Mood = {};
  for (const w of wordsOf(texts)) {
    const m = MOODS[w];
    if (m) out = { ...m, ...out };
  }
  return out;
}

/** A level's characters by element id (the level's own id: the scene). */
export interface CharacterMap extends ReadonlyMap<string, ResolvedCharacter> {
  /**
   * The character of an area made during resolve (a building's ground-storey rooms, resolve/building/rooms.ts), drawn
   * from `parentId` (its building) by the same rules, and recorded with the rest.
   */
  addArea(area: Area, parentId: string): ResolvedCharacter;
}

/** What a stated field says of a subject (the phase-1 fields will add `light` and level/area `condition` here). */
interface Stated {
  readonly light?: CharacterLight;
  readonly condition?: CharacterCondition;
  readonly wealth?: CharacterWealth;
}

/** The stated slot: `Building.condition`, else a style that is a ruin. Nothing else is stated yet (plan §12.3). */
function statedOf(subject: { readonly building?: Building }): Stated {
  const st = subject.building;
  if (!st) return {};
  const c = st.condition ?? structureStyle(st.style)?.condition;
  return c !== undefined && c !== "intact"
    ? { condition: c }
    : st.condition === "intact"
      ? { condition: "intact" }
      : {};
}

interface SubjectIn {
  readonly id: string;
  readonly scope: "zone" | "building" | "area";
  readonly cells: ReadonlySet<string>;
  readonly texts: ReadonlyArray<string | undefined>;
  /** Setting words (dungeon, hospital ...) read for its light: everything but a room or a corridor. */
  readonly settings: boolean;
  /** Its words may name a ruin (never a building's). */
  readonly ruins: boolean;
  readonly building?: Building;
  readonly area?: Area;
}

/** The cells a shape covers inside the level (a route's cells are not known before the areas: none). */
function shapeCells(shape: Shape, planSeed: number, L: Level): Set<string> {
  const out = new Set<string>();
  if (shape.type === "route") return out;
  const b = L.bounds;
  const clip = { x0: b.x, y0: b.y, x1: b.x + b.w - 1, y1: b.y + b.h - 1 };
  forEachMaskCell(rasterizeShape(shape, { planSeed, clip }), (x, y) => {
    if (x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h) out.add(`${x},${y}`);
  });
  return out;
}

/** A building's plot as written: its ground volumes, wings, footprint or one-wing shorthand. */
function plotCells(st: Building, planSeed: number, L: Level): Set<string> {
  const rects =
    st.volumes?.filter((v) => v.on === undefined) ??
    st.wings ??
    (st.footprint === undefined &&
    st.x !== undefined &&
    st.y !== undefined &&
    st.w !== undefined &&
    st.h !== undefined
      ? [{ x: st.x, y: st.y, w: st.w, h: st.h }]
      : []);
  const out = new Set<string>();
  for (const r of rects)
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.add(`${x},${y}`);
  if (rects.length === 0 && st.footprint) for (const c of shapeCells(st.footprint, planSeed, L)) out.add(c);
  return out;
}

/** Cells between two plots' boxes (0: touching or overlapping). */
function plotGap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const box = (s: ReadonlySet<string>) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const k of s) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return { x0, y0, x1, y1 };
  };
  const p = box(a);
  const q = box(b);
  return Math.max(0, q.x0 - p.x1 - 1, p.x0 - q.x1 - 1, q.y0 - p.y1 - 1, p.y0 - q.y1 - 1);
}

/** One step of the spread draw round index `p` of a scale of `n`, by draw `u` and shares [down, same, up]. */
function spread(
  p: number,
  n: number,
  u: number,
  shares: readonly [number, number, number],
  top = n - 1,
): number {
  const [down, same] = shares;
  const step = u < down ? -1 : u < down + same ? 0 : 1;
  const v = p + step;
  return v < 0 || v > top ? p : v;
}

/**
 * Every subject's character on level `li` of the plan, or null when the plan's generator has no `characterCascade`.
 * Pure: the same plan resolves the same characters.
 */
export function resolveCharacters(plan: MapPlan, li: number): CharacterMap | null {
  const profile = generatorProfile(plan);
  if (!profile.characterCascade) return null;
  const L = plan.levels[li];
  if (!L) return null;
  const out = new Map<string, ResolvedCharacter>();
  const theme = L.theme ?? plan.theme;

  // the scene: the map's words with the level's (light as the scene light always read them), else the theme's
  const sceneTexts = [plan.title, plan.summary, plan.kind, L.name];
  // (upkeep, wealth and mood from the title and the level's own words: a summary lists what is on the map, "a ruined
  // chapel" among them, and says nothing of the whole)
  const fullTexts = [plan.title, L.name, L.notes];
  const sceneMood = moodOf(fullTexts);
  const sceneLight = lightNamedBy(sceneTexts, { settings: true });
  const sceneCond = conditionNamedBy(fullTexts, { ruins: true });
  const sceneWealth = wealthNamedBy(fullTexts);
  const scene: ResolvedCharacter = {
    light:
      sceneLight !== undefined
        ? CHARACTER_LIGHTS[sceneLight]
        : (sceneMood.light ?? CHARACTER_LIGHTS[themeLight(theme)]),
    condition: sceneCond ?? sceneMood.condition ?? "intact",
    wealth: sceneWealth ?? sceneMood.wealth ?? "modest",
    tone: sceneMood.tone ?? (colourTheme(theme) ? "coloured" : "warm"),
    sources: {
      light: sceneLight !== undefined || sceneMood.light !== undefined ? "words" : "default",
      condition: sceneCond !== undefined || sceneMood.condition !== undefined ? "words" : "default",
      wealth: sceneWealth !== undefined || sceneMood.wealth !== undefined ? "words" : "default",
    },
    ...ruinFields(sceneCond ?? sceneMood.condition ?? "intact", fullTexts, undefined),
  };
  out.set(L.id, scene);

  // the subjects: zones (largest first, so a zone inside another finds it), buildings, then every other area
  const zones: SubjectIn[] = L.areas
    .filter((a) => a.kind === "zone")
    .map((a) => ({
      id: a.id,
      scope: "zone" as const,
      cells: shapeCells(a.shape, plan.seed, L),
      texts: [a.name, ...(a.tags ?? []), a.notes],
      settings: true,
      ruins: true,
      area: a,
    }))
    .filter((s) => s.cells.size > 0)
    .sort((p, q) => q.cells.size - p.cells.size);
  const buildings: SubjectIn[] = (L.structures ?? [])
    .filter((st): st is Building => st.kind !== "enclosure")
    .map((st) => ({
      id: st.id,
      scope: "building" as const,
      cells: plotCells(st, plan.seed, L),
      texts: [st.name, ...(st.tags ?? []), st.notes, st.use],
      settings: true,
      ruins: false,
      building: st,
    }));
  const areas: SubjectIn[] = L.areas
    .filter((a) => a.kind !== "zone")
    .map((a) => ({
      id: a.id,
      scope: "area" as const,
      cells: shapeCells(a.shape, plan.seed, L),
      texts: [a.name, ...(a.tags ?? []), a.notes],
      settings: a.kind !== "room" && a.kind !== "corridor",
      ruins: true,
      area: a,
    }));

  const parentOf = (s: SubjectIn, containers: readonly SubjectIn[]): string => {
    let best: SubjectIn | null = null;
    if (s.cells.size > 0)
      for (const c of containers) {
        if (c.id === s.id || c.cells.size < s.cells.size) continue;
        let n = 0;
        for (const k of s.cells) if (c.cells.has(k)) n++;
        if (n * 2 > s.cells.size && (best === null || c.cells.size < best.cells.size)) best = c;
      }
    return best?.id ?? L.id;
  };

  const placed: Array<{ s: SubjectIn; c: ResolvedCharacter }> = [];
  const resolveOne = (s: SubjectIn, parentId: string): ResolvedCharacter => {
    const parent = out.get(parentId) ?? scene;
    const stated = statedOf(s);
    const mood = moodOf(s.texts);
    const named = {
      light: lightNamedBy(s.texts, { settings: s.settings }),
      condition: conditionNamedBy(s.texts, { ruins: s.ruins }),
      wealth: wealthNamedBy(s.texts),
    };
    const own = {
      light: stated.light ?? (named.light !== undefined ? CHARACTER_LIGHTS[named.light] : mood.light),
      // (the plan's condition has no ramshackle value yet: its words refine any stated value short of a ruin to it, as
      // gen/buildingCondition.ts always read them)
      condition:
        named.condition === "ramshackle" && stated.condition !== "ruined"
          ? named.condition
          : (stated.condition ?? named.condition ?? mood.condition),
      wealth: stated.wealth ?? named.wealth ?? mood.wealth,
    };
    // a value no scope set is the default all the way down: nothing to draw round (rule 4, not rule 3)
    const unset = (axis: keyof Stated): boolean => parent.sources[axis] === "default";
    const src = (axis: keyof Stated): CharacterSource =>
      stated[axis] !== undefined && stated[axis] === own[axis]
        ? "stated"
        : own[axis] !== undefined
          ? "words"
          : unset(axis)
            ? "default"
            : "inherited";
    const drawn = (axis: keyof Stated): boolean => own[axis] === undefined && !unset(axis);
    // a room of a kind takes its light by its kind (the draw is its own variety); anything else draws round the parent
    const cls =
      s.area && (s.area.kind === "room" || s.area.kind === "corridor")
        ? classifyRoom(s.area, { kinds: profile.roomKinds })
        : null;
    const draw = (salt: number) => {
      const u = (axis: string) => hashUnitMixed(plan.seed, L.id, s.id, "character", axis, salt);
      const pl = CHARACTER_LIGHTS.indexOf(parent.light);
      const roomSeed = subSeed(elementSeed(plan.seed, `${L.id}~${s.id}~room`, undefined), "room");
      const light: CharacterLight =
        own.light ??
        (cls?.kind !== undefined && salt === 0
          ? CHARACTER_LIGHTS[roomLightLevel(cls.kind, pl as LightLevel, roomSeed)]
          : unset("light")
            ? parent.light
            : (CHARACTER_LIGHTS[spread(pl, 5, u("light"), CHARACTER_SPREAD.light)] as CharacterLight));
      const pc = CHARACTER_CONDITIONS.indexOf(parent.condition);
      // a parent that is not a ruin never draws one: its worse share stays on its own value
      const condition: CharacterCondition =
        own.condition ??
        (unset("condition")
          ? parent.condition
          : (CHARACTER_CONDITIONS[
              spread(pc, 4, u("condition"), CHARACTER_SPREAD.condition, parent.condition === "ruined" ? 3 : 2)
            ] as CharacterCondition));
      const wealth: CharacterWealth =
        own.wealth ??
        (unset("wealth")
          ? parent.wealth
          : (CHARACTER_WEALTHS[
              spread(CHARACTER_WEALTHS.indexOf(parent.wealth), 4, u("wealth"), CHARACTER_SPREAD.wealth)
            ] as CharacterWealth));
      return { light, condition, wealth };
    };
    let v = draw(0);
    if (s.scope === "building" && (drawn("light") || drawn("condition") || drawn("wealth"))) {
      const twin = placed.some(
        (p) =>
          p.s.scope === "building" &&
          p.c.light === v.light &&
          p.c.condition === v.condition &&
          p.c.wealth === v.wealth &&
          plotGap(p.s.cells, s.cells) <= NEXT_DOOR,
      );
      if (twin) v = draw(1);
    }
    const c: ResolvedCharacter = {
      ...v,
      tone: mood.tone ?? parent.tone,
      parent: parentId,
      sources: { light: src("light"), condition: src("condition"), wealth: src("wealth") },
      ...ruinFields(v.condition, s.texts, parent),
    };
    return c;
  };

  const done: SubjectIn[] = [];
  for (const z of zones) {
    const c = resolveOne(z, parentOf(z, done));
    out.set(z.id, c);
    placed.push({ s: z, c });
    done.push(z);
  }
  for (const b of buildings) {
    const c = resolveOne(b, parentOf(b, zones));
    out.set(b.id, c);
    placed.push({ s: b, c });
  }
  for (const a of areas) {
    const c = resolveOne(a, parentOf(a, [...buildings, ...zones]));
    out.set(a.id, c);
  }
  const addArea = (a: Area, parentId: string): ResolvedCharacter => {
    const c = resolveOne(
      {
        id: a.id,
        scope: "area",
        cells: new Set(),
        texts: [a.name, ...(a.tags ?? []), a.notes],
        settings: a.kind !== "room" && a.kind !== "corridor",
        ruins: true,
        area: a,
      },
      parentId,
    );
    out.set(a.id, c);
    return c;
  };
  return Object.assign(out, { addArea });
}

/** A ruin's severity and stage: its own words, else its parent's, else severity 2. */
function ruinFields(
  condition: CharacterCondition,
  texts: ReadonlyArray<string | undefined>,
  parent: ResolvedCharacter | undefined,
): Pick<ResolvedCharacter, "severity" | "stage"> {
  if (condition !== "ruined") return {};
  const r = ruinNamedBy(texts);
  const words = texts.join(" ").toLowerCase();
  const stage = r.reoccupied ? "reoccupied" : ABANDONED.test(words) ? "abandoned" : parent?.stage;
  const severity = r.severity !== 2 ? r.severity : (parent?.severity ?? 2);
  return { severity, ...(stage !== undefined ? { stage } : {}) };
}

/** During resolve: the character of a subject of the level being resolved (null: the switch is off). */
export function characterAt(
  work: { readonly characters: CharacterMap | null },
  id: string,
): ResolvedCharacter | null {
  return work.characters?.get(id) ?? null;
}

/** After resolve: the character a resolved level records for an element (null: none recorded). */
export function elementCharacter(
  level: Pick<ResolvedLevel, "character">,
  id: string,
): ResolvedCharacter | null {
  return level.character?.[id] ?? null;
}

/** An axis value as its index on its scale (light 0 dark .. 4 flooded; condition 0 intact .. 3; wealth 0 poor .. 3). */
export const lightIndex = (c: ResolvedCharacter): LightLevel =>
  CHARACTER_LIGHTS.indexOf(c.light) as LightLevel;
export const wealthIndex = (c: ResolvedCharacter): 0 | 1 | 2 | 3 =>
  CHARACTER_WEALTHS.indexOf(c.wealth) as 0 | 1 | 2 | 3;

/** The resolved structure's condition a character stands for (ramshackle builds as weathered, worse in its treatments). */
export const structureCondition = (c: ResolvedCharacter): "intact" | "weathered" | "ruined" =>
  c.condition === "ramshackle" ? "weathered" : c.condition;

/** The coarse wear a character stands for (0 intact, 1 weathered or ramshackle, 2 ruined; 0 for none). */
export const characterWear = (c: ResolvedCharacter | null): 0 | 1 | 2 =>
  c === null || c.condition === "intact" ? 0 : c.condition === "ruined" ? 2 : 1;

/** The treatments' condition state a character stands for. */
export const conditionState = (c: ResolvedCharacter): "kept" | "worn" | "ramshackle" | "ruined" =>
  c.condition === "intact" ? "kept" : c.condition === "weathered" ? "worn" : c.condition;
