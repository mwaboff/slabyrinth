/**
 * How to move in the 3D tab, in one table: the tab's Controls card, the first-use hint, the shortcut sheet and the
 * canvas's accessible description all read it, so they never disagree. The keys are input.ts's KEYS (canvas focused)
 * plus the tab's own: R (roofs) and the level keys the Map uses too.
 */
export interface ControlRow {
  /** What to press or do, as the GM reads it. */
  keys: string;
  does: string;
}

export const MOUSE_CONTROLS: readonly ControlRow[] = [
  { keys: "Drag", does: "Turn around the map" },
  { keys: "Right-drag or Shift+drag", does: "Move across the map" },
  { keys: "Wheel", does: "Zoom toward the pointer" },
  { keys: "Click a piece", does: "See what it is" },
];

export const KEY_CONTROLS: readonly ControlRow[] = [
  { keys: "W A S D", does: "Fly forward, left, back, right (hold Shift: faster)" },
  { keys: "Q · E", does: "Fly down · up" },
  { keys: "Arrows", does: "Turn and tilt" },
  { keys: "Shift+arrows", does: "Move across the map" },
  { keys: "+ · −", does: "Zoom in · out" },
  { keys: "0 or Home", does: "Frame the whole map" },
  { keys: "T", does: "Look straight down" },
  { keys: "F", does: "Frame the clicked piece" },
  { keys: "Esc", does: "Clear the clicked piece" },
  { keys: "R", does: "Roofs on or off" },
  { keys: "PgUp · PgDn", does: "Show more or fewer levels" },
];

/** The short version, for the canvas's accessible description and the hint. */
export const MOVE_SUMMARY =
  "Drag to turn, right-drag to move, wheel to zoom, click a piece to see what it is. With the view focused: W A S D to fly, arrows to turn, R for roofs.";
