/**
 * What a building's condition and role read as (generator 5): the plan says `Building.condition` (intact, weathered,
 * ruined); its name, tags, notes and use may say more. This table refines the three plan values into the four
 * condition states the treatments weigh (resolve/recipes/treatments.ts), a ruin's severity, and whether the building
 * is sacred or formal (the style options: a guardian pair at its threshold, lights at its approach). Words only refine:
 * they never make a kept building a ruin.
 *
 *   plan says                                                  state
 *   condition intact (or none)                                 kept
 *   condition weathered                                        worn
 *   condition ruined                                           ruined, severity 2
 *   words "ramshackle, shanty, shack, dilapidated, run-down"   ramshackle (unless ruined)
 *   ruined, and "collapsed, rubble, razed"                     severity 3
 *   ruined, and "crumbling, decayed, decaying"                 severity 1
 *   ruined, and "squatters, occupied, bandit camp, hideout"    reoccupied (recorded; nothing builds it yet)
 */

export const CONDITION_STATES = ["kept", "worn", "ramshackle", "ruined"] as const;
export type ConditionState = (typeof CONDITION_STATES)[number];

/** What the plan says of a building, all this table reads. */
export interface BuildingWords {
  readonly condition?: "intact" | "weathered" | "ruined" | undefined;
  readonly name?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly notes?: string | undefined;
  readonly use?: string | undefined;
}

export interface BuildingState {
  readonly state: ConditionState;
  /** A ruin's severity 1 (crumbling) .. 3 (collapsed); 0 for any other state. */
  readonly severity: 0 | 1 | 2 | 3;
  /** A ruin someone lives in again (words); recorded for the owner, not built. */
  readonly reoccupied: boolean;
  /** A temple, shrine, chapel ... (its words). */
  readonly sacred: boolean;
  /** A palace, guildhall, town hall ... (its words): the style options apply, a little less often. */
  readonly formal: boolean;
}

const RAMSHACKLE =
  /\b(ramshackle|shanty|shanties|shacks?|dilapidated|run-?down|squalid|hovels?|tumbledown|makeshift)\b/;
const COLLAPSED = /\b(collapsed|rubble|razed|caved[- ]in)\b/;
const CRUMBLING = /\b(crumbling|decayed|decaying)\b/;
const REOCCUPIED = /\b(squatters?|occupied|bandit camp|hideout|lair)\b/;
const SACRED =
  /\b(temples?|shrines?|chapels?|church|sanctuary|sanctum|monastery|abbey|cathedral|basilica|oratory|pagoda|mausoleum|reliquary)\b/;
const FORMAL = /\b(palace|guild ?hall|town ?hall|courthouse|manor|mansion|embassy|civic|council)\b/;

/** The words a building's plan entry says of it, lower-cased in one string. */
const textOf = (w: BuildingWords): string =>
  [w.name ?? "", ...(w.tags ?? []), w.notes ?? "", w.use ?? ""].join(" ").toLowerCase();

/** The state a building reads as (`condition` is the resolved one: the plan's, else its style's). */
export function buildingState(w: BuildingWords): BuildingState {
  const text = textOf(w);
  const ruined = w.condition === "ruined";
  const state: ConditionState = ruined
    ? "ruined"
    : RAMSHACKLE.test(text)
      ? "ramshackle"
      : w.condition === "weathered"
        ? "worn"
        : "kept";
  const severity = !ruined ? 0 : COLLAPSED.test(text) ? 3 : CRUMBLING.test(text) ? 1 : 2;
  return {
    state,
    severity,
    reoccupied: ruined && REOCCUPIED.test(text),
    sacred: SACRED.test(text),
    formal: FORMAL.test(text),
  };
}

/** Upkeep words other than ramshackle's (generator 5, the character resolver, resolve/character.ts). */
const WEATHERED = /\b(weathered|worn|shabby|faded|neglected|grimy|peeling|battered|timeworn|downtrodden)\b/;
const INTACT =
  /\b(pristine|immaculate|spotless|well-kept|well-tended|tidy|polished|restored|well-maintained)\b/;
const RUINED = /\b(ruined|ruins)\b/;

/**
 * The upkeep words name, worst first (ruined only when `ruins` allows: a building's words never make it a ruin),
 * undefined when they name none.
 */
export function conditionNamedBy(
  texts: ReadonlyArray<string | undefined>,
  opts: { readonly ruins: boolean },
): "intact" | "weathered" | "ramshackle" | "ruined" | undefined {
  const text = texts.join(" ").toLowerCase();
  if (opts.ruins && RUINED.test(text)) return "ruined";
  if (RAMSHACKLE.test(text)) return "ramshackle";
  if (WEATHERED.test(text)) return "weathered";
  if (INTACT.test(text)) return "intact";
  return undefined;
}

/** A ruin's severity and stage as its words say (severity 2 and no stage when they say neither). */
export function ruinNamedBy(texts: ReadonlyArray<string | undefined>): {
  readonly severity: 1 | 2 | 3;
  readonly reoccupied: boolean;
} {
  const text = texts.join(" ").toLowerCase();
  return {
    severity: COLLAPSED.test(text) ? 3 : CRUMBLING.test(text) ? 1 : 2,
    reoccupied: REOCCUPIED.test(text),
  };
}

/** The coarse wear a state stands for (0 kept up, 1 worn or ramshackle, 2 ruined). */
export const wearOfState = (s: ConditionState): 0 | 1 | 2 => (s === "ruined" ? 2 : s === "kept" ? 0 : 1);
