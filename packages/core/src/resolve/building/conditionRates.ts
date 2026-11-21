/**
 * The rates a building's condition is drawn with (resolve/building/condition.ts), grouped by condition. Data, not
 * code: each constant says what it stands for, and the condition steps read them by name. Changing one moves generator
 * 2-4 output (they are drawn on the released streams), so a change here is a deliberate new look.
 */

/** Roof brokenness of a weathered or ruined building (share of roof pieces gone). */
export const ROOF_BROKEN = { ruined: 0.45, weatheredLegible: 0.3, weathered: 0.2, keptAnchor: 0.12 } as const;

/** Weathered (generator 3 signs, each on a stream of its own). */
export const WEATHERED = {
  /** Share of the windows boarded up (at least one when there are any). */
  boardedShare: 0.34,
  /** Chance that each outer face of a flat roof's parapet is bitten away. */
  parapetBite: 0.28,
  /** The ragged roof hole: this share of the top storey's cells plus up to `roofHoleExtra` more (drawn), at least `roofHoleMin` cells. */
  roofHoleShare: 0.14,
  roofHoleExtra: 0.08,
  roofHoleMin: 5,
  /** Growth at the foot of the walls: a heap for every this many wall faces (`footFacesHeavy` when heavily grown), at least `footMin`. */
  footFaces: 7,
  footFacesHeavy: 3,
  footMin: 2,
} as const;

/** Ruined. */
export const RUINED = {
  /** Generator 3: chance that a ruin of several ground volumes keeps one of them whole under its roof. */
  keepRoofed: 0.65,
  /** Breaches in the ground storey: the fewest drawn and how many more may be (1 or 2), each 1 or 2 cells wide. */
  breachesMin: 1,
  breachesExtra: 2,
  breachWidthMin: 1,
  breachWidthExtra: 2,
  /** Faces tried for the breaches, and the shortest straight run of wall a breach is cut in. */
  breachTries: 12,
  breachMinRun: 4,
  /**
   * Rubble inside the walls: `insidePerOutside` heaps per rubble heap outside plus `insidePerCellLoss` per inside cell
   * times the share that fell, at least `insideMin`, on at most `insideMaxShare` of the inside cells. Heaps two and
   * three are story props when the inside has `insidePropsFrom` cells; later ones are rubble with `insideRubble`
   * (`insideRubbleHeavy` when heavily grown), else growth.
   */
  insidePerOutside: 1.5,
  insidePerCellLoss: 0.1,
  insideMin: 2,
  insideMaxShare: 0.5,
  insidePropsFrom: 12,
  insideRubble: 0.8,
  insideRubbleHeavy: 0.35,
  /**
   * Generator 3, fallen heaps beside fallen walls: a column counts once it lost `fallenDrop` tiles; the budget is
   * `fallenPerColumn` heaps per fallen column, at least `fallenMinBudget`; at most `fallenMaxPerColumn` per column;
   * each is rubble with `fallenRubble` (`fallenRubbleHeavy` when heavily grown), else growth.
   */
  fallenDrop: 1.5,
  fallenPerColumn: 0.8,
  fallenMinBudget: 6,
  fallenMaxPerColumn: 4,
  fallenRubble: 0.85,
  fallenRubbleHeavy: 0.35,
} as const;

/**
 * Heaps in the two rings round the walls (both conditions): the chance a free ring cell gets one, and the chance that a
 * heap is rubble rather than growth. A ruin's chance is `base + perLoss * loss` (loss = the share of its walls that fell).
 */
export const FOOT_DEBRIS = {
  ruined: { base: 0.06, perLoss: 0.15, rubble: 0.55 },
  ruinedHeavy: { base: 0.12, perLoss: 0.2, rubble: 0.25 },
  weathered: { chance: 0.15, rubble: 0.3 },
  weatheredHeavy: { chance: 0.3, rubble: 0.08 },
} as const;
