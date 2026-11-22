/**
 * The paste steps of a build split into several slabs, from `ExportBundle.pasteAnchor` (the same facts the add-on is
 * sent: symbiotes/slabyrinth-helper/sequencer.js pasteAnchorText words them the same way). A one-slab build needs none.
 */
import type { ExportBundle } from "@slabyrinth/core";

type Anchor = NonNullable<ExportBundle["pasteAnchor"]>;

const OPPOSITE: Record<Anchor["side"], Anchor["side"]> = {
  north: "south",
  east: "west",
  south: "north",
  west: "east",
};
/** The near pillar stands just past the box's other end: beside the south or west edge, that is north-east. */
const NEAR_CORNER: Record<Anchor["side"], string> = {
  south: "north-east",
  west: "north-east",
  north: "south-west",
  east: "south-west",
};

const cells = (n: number): string => `${String(n)} ${n === 1 ? "cell" : "cells"}`;

/**
 * The steps in order. Without an anchor (an older build, or the bundle not in memory after a restart) the plain steps:
 * the same spot every time, and the two pillars.
 */
export function pasteSteps(anchor: Anchor | null | undefined): {
  plane: string;
  spot: string;
  pillars: string;
} {
  const plane = "In TaleSpire, press G to raise the build plane before the first slab.";
  if (!anchor)
    return {
      plane,
      spot: "Click one spot for the first slab, then click that same spot for every slab after it. Don't move the camera.",
      pillars: "When every slab is placed, delete the two alignment pillars.",
    };
  return {
    plane,
    spot:
      `Put the cursor just outside the middle of where the map's ${anchor.side} edge will be: the map lands ` +
      `${OPPOSITE[anchor.side]} of it, about ${cells(anchor.clearanceCells + 1)} away. Click that same spot for every slab.`,
    pillars:
      `When every slab is placed, delete the two alignment pillars: one just past the map's ` +
      `${NEAR_CORNER[anchor.side]} corner, and one about ${cells(anchor.farMarkerCells)} ${anchor.side} of the map.`,
  };
}
