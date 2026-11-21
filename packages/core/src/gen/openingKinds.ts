/**
 * What each opening kind IS, as data: one row per kind of the plan's OPENING_KINDS, read through the helpers below by
 * every stage that once kept its own list of kind names (the plan's walk and checks, the building planner, the compiler,
 * verify, the 2D map). A new kind gets one row here and every rule answers for it.
 */
import type { OpeningKind } from "../contracts/plan";
import type { GeneratorProfile } from "../plan/generator";

export interface OpeningKindInfo {
  /**
   * A person walks through it (a door, an arch, a gap): the walks step over it and a building takes it as its door.
   * Windows, arrow slits and bars let only light or sight through.
   */
  passage: boolean;
  /**
   * Closes with a leaf or a gate (a door, a portcullis): its piece has a front, which a building turns to face out. An
   * arch or a gap has none.
   */
  leaf: boolean;
  /**
   * A window in the wall (a pane or a slit): the wall stands below and above it, the 2D map draws it as wall, a
   * weathered building boards it and a ruin loses it with its stretch of wall.
   */
  window: boolean;
  /** Hidden: drawn only on the GM layer, never lit or used as the way in by the generators. */
  secret: boolean;
  /**
   * Its piece is a whole wall section (an arch, a window in its wall): the compiler closes nothing above it. A door's
   * piece is only the leaf and its frame, so the wall above it is closed with a lintel or wall pieces. Asked of the
   * kind whose role supplied the piece (a kind that falls back to another kind's role is built like that kind).
   */
  fullHeight: boolean;
  /**
   * A gap: nothing stands in the edge (the wall there is cleared, no piece is built), so it needs no wall to stand in
   * and leaves no jambs.
   */
  gap: boolean;
  /**
   * A door a building is entered by from the street, opened by hand (a plain, double or locked door; not a hidden door,
   * a gate or a gap): a trail to the building ends outside it.
   */
  frontDoor: boolean;
  /** How many cells wide it is when the plan gives no `width` (a double door is two). */
  defaultWidth: number;
}

const row = (flags: Partial<OpeningKindInfo> = {}): OpeningKindInfo => ({
  passage: true,
  leaf: false,
  window: false,
  secret: false,
  fullHeight: false,
  gap: false,
  frontDoor: false,
  defaultWidth: 1,
  ...flags,
});

export const OPENING_KIND_INFO: Record<OpeningKind, OpeningKindInfo> = {
  door: row({ leaf: true, frontDoor: true }),
  double_door: row({ leaf: true, frontDoor: true, defaultWidth: 2 }),
  locked_door: row({ leaf: true, frontDoor: true }),
  secret_door: row({ leaf: true, secret: true }),
  portcullis: row({ leaf: true }),
  archway: row({ fullHeight: true }),
  open: row({ gap: true }),
  window: row({ passage: false, window: true, fullHeight: true }),
  arrow_slit: row({ passage: false, window: true, fullHeight: true }),
  bars: row({ passage: false }),
};

/** How many cells wide an opening is: its own `width`, else its kind's default. */
export function openingWidth(o: { readonly kind: OpeningKind; readonly width?: number | undefined }): number {
  return o.width ?? OPENING_KIND_INFO[o.kind].defaultWidth;
}

/** Is an opening of this kind a gap (nothing stands in the edge; the wall there is cleared)? */
export function isGap(kind: OpeningKind): boolean {
  return OPENING_KIND_INFO[kind].gap;
}

/** Is an opening of this kind a door a building is entered by from the street (a trail ends outside it)? */
export function isFrontDoor(kind: OpeningKind): boolean {
  return OPENING_KIND_INFO[kind].frontDoor;
}

/** A test of an opening kind, as one generator answers it. */
export type OpeningTest = (kind: OpeningKind) => boolean;

/**
 * The opening tests of a plan's generator. Generator 4 (`openingKindTraits`) asks the table above; the released
 * generators named kinds, and their answers are frozen here, once, for every stage that asks (resolve, compile, text):
 *   - doorway: every kind but "window" (an arrow slit or bars counted as a way through);
 *   - window: the kind "window" alone (an arrow slit counted with the doors);
 *   - entrance (a building's main door): door, double door, archway, portcullis (no locked door, no plain gap).
 */
export interface OpeningTests {
  /** A person walks through it: rubble keeps clear of it, a breach spares it, the compiler opens the wall. */
  readonly doorway: OpeningTest;
  /** A window of the wall: counted and dressed with the windows. */
  readonly window: OpeningTest;
  /** A way into a building that may be its main door. */
  readonly entrance: OpeningTest;
}

const LEGACY_ENTRANCE: ReadonlySet<OpeningKind> = new Set(["door", "double_door", "archway", "portcullis"]);

const TRAIT_TESTS: OpeningTests = {
  doorway: isPassage,
  window: isWindow,
  entrance: (kind) => isPassage(kind) && !isSecret(kind),
};

const LEGACY_TESTS: OpeningTests = {
  doorway: (kind) => kind !== "window",
  window: (kind) => kind === "window",
  entrance: (kind) => LEGACY_ENTRANCE.has(kind),
};

/** The opening tests a generator answers with (see OpeningTests). */
export function openingTests(profile: Pick<GeneratorProfile, "openingKindTraits">): OpeningTests {
  return profile.openingKindTraits ? TRAIT_TESTS : LEGACY_TESTS;
}

/** Can a person walk through an opening of this kind? */
export function isPassage(kind: OpeningKind): boolean {
  return OPENING_KIND_INFO[kind].passage;
}

/** Does an opening of this kind close with a leaf or a gate (a door, a portcullis)? */
export function hasLeaf(kind: OpeningKind): boolean {
  return OPENING_KIND_INFO[kind].leaf;
}

/** Is an opening of this kind a window in the wall (window, arrow slit)? */
export function isWindow(kind: OpeningKind): boolean {
  return OPENING_KIND_INFO[kind].window;
}

/** Is an opening of this kind hidden (a secret door)? */
export function isSecret(kind: OpeningKind): boolean {
  return OPENING_KIND_INFO[kind].secret;
}

const KINDS: ReadonlySet<string> = new Set(Object.keys(OPENING_KIND_INFO));

/**
 * Is the piece of this opening role (`opening.<kind>`, the role that supplied it) a whole wall section, with nothing
 * closed above it? False for a role that names no kind.
 */
export function isFullHeightOpeningRole(role: string): boolean {
  const kind = role.startsWith("opening.") ? role.slice("opening.".length) : "";
  return KINDS.has(kind) && OPENING_KIND_INFO[kind as OpeningKind].fullHeight;
}
