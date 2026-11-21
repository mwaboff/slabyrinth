/**
 * What each opening kind IS, as data: one row per kind of the plan's OPENING_KINDS, read through the helpers below by
 * every stage that once kept its own list of kind names (the plan's walk and checks, the building planner, the compiler,
 * verify, the 2D map). A new kind gets one row here and every rule answers for it.
 */
import type { OpeningKind } from "../contracts/plan";

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
}

const row = (flags: Partial<OpeningKindInfo> = {}): OpeningKindInfo => ({
  passage: true,
  leaf: false,
  window: false,
  secret: false,
  fullHeight: false,
  ...flags,
});

export const OPENING_KIND_INFO: Record<OpeningKind, OpeningKindInfo> = {
  door: row({ leaf: true }),
  double_door: row({ leaf: true }),
  locked_door: row({ leaf: true }),
  secret_door: row({ leaf: true, secret: true }),
  portcullis: row({ leaf: true }),
  archway: row({ fullHeight: true }),
  open: row(),
  window: row({ passage: false, window: true, fullHeight: true }),
  arrow_slit: row({ passage: false, window: true, fullHeight: true }),
  bars: row({ passage: false }),
};

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
