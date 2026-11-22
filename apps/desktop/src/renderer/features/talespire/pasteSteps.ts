/**
 * Every sentence the app shows about pasting a build of several slabs, in one table: the paste guide, the build page's
 * slab list and the "Send to TaleSpire" panel all read it, so they cannot disagree. Two rows:
 *
 * - beside the map (`pasteAnchor`, generator-4 builds): the cursor sits on one bare cell just outside the middle of the
 *   map's south edge, the same cell for every slab, and the far alignment pillar lands about a map's depth further
 *   south. The facts are core's (`pasteInstructions`, compile/chunk.ts) and the add-on's (`pasteAnchorText` in
 *   symbiotes/slabyrinth-helper/sequencer.js); pasteSteps.test.ts holds this table to core's text.
 * - plain (an older build, or one with no anchor): the same spot every time, and the two corner pillars.
 *
 * A one-slab build needs none of it.
 */
import type { ExportBundle } from "@slabyrinth/core";

export type PasteAnchor = NonNullable<ExportBundle["pasteAnchor"]>;

const OPPOSITE: Record<PasteAnchor["side"], PasteAnchor["side"]> = {
  north: "south",
  east: "west",
  south: "north",
  west: "east",
};
/** The near pillar stands just past the box's other end: beside the south or west edge, that is north-east. */
const NEAR_CORNER: Record<PasteAnchor["side"], string> = {
  south: "north-east",
  west: "north-east",
  north: "south-west",
  east: "south-west",
};
/** The far pillar stands one cell beyond this edge of the map (core: "one cell beyond its west edge"). */
const FAR_EDGE: Record<PasteAnchor["side"], string> = {
  south: "west",
  west: "south",
  north: "east",
  east: "north",
};

const cells = (n: number): string => `${String(n)} ${n === 1 ? "cell" : "cells"}`;
const slabs = (n: number): string => `${String(n)} ${n === 1 ? "slab" : "slabs"}`;

export interface PasteWords {
  /** Beside the map (an anchor is known). */
  beside: boolean;
  /** Raise the build plane first. */
  plane: string;
  /** The clear ground the paste needs. */
  ground: string;
  /** Where the cursor goes, the same spot for every slab. */
  spot: string;
  /** Slab 1, after Ctrl+V: where to put it. */
  first: string;
  /** Slab 1, after placing it: what came with it. */
  firstNote: string;
  /** Every later slab: where to point. */
  later: string;
  /** Every later slab: keep it steady. */
  steady: string;
  /** When every slab is placed. */
  pillars: string;
  /** A slab that landed wrong. */
  redo: string;
  /** The note over the slab list when some slabs changed since the last build. */
  changed: string;
  /** The foot of the slab list. */
  foot: (total: number) => string;
  /** The Send panel's short list, in order. */
  list: string[];
}

const PLANE = "In TaleSpire, press G first to raise the build plane, before you paste the first slab.";
const REDO =
  "If a slab landed wrong, select it in TaleSpire, delete it, and paste it again from the checklist.";

/** The paste sentences for a build: beside the map when its anchor is known, else the plain ones. */
export function pasteSteps(anchor: PasteAnchor | null | undefined): PasteWords {
  if (!anchor) {
    const spot =
      "Click one spot for the first slab, then click that same spot for every slab after it. Don't move the camera.";
    const pillars = "When every slab is placed, delete the two alignment pillars.";
    return {
      beside: false,
      plane: PLANE,
      ground:
        "Find a flat, empty area a little bigger than the map, with room for the two alignment pillars at its corners. Don't build anything on it yet.",
      spot,
      first: "Move it where you want the map.",
      firstNote: "Note the two alignment pillars at its corners. Every other slab lines up on them.",
      later:
        "Point at the same corner pillar you used for slab 1. This slab's pillars should sit exactly on top of the old ones.",
      steady:
        "Don't move the camera between slabs. Aim at the pillar or empty ground, not at walls you've already placed, or the paste can lift.",
      pillars,
      redo: REDO,
      changed:
        "In TaleSpire, delete the tiles in those slabs' areas, then paste the new slabs on the same alignment pillars. Unchanged slabs can stay.",
      foot: (n) =>
        `This map is too big for one slab, so it's split into ${slabs(n)} that share one bounding box: two small alignment pillars sit at its corners in every slab, so each slab is pasted on the same cell. Delete the pillars when you're done.`,
      list: [PLANE, spot, pillars],
    };
  }
  const { side, clearanceCells: gap, farMarkerCells: far } = anchor;
  const where =
    `one just past the map's ${NEAR_CORNER[side]} corner, and one about ${cells(far)} ${side} of the map, ` +
    `one cell beyond its ${FAR_EDGE[side]} edge`;
  const spot =
    `Put the cursor on bare ground just outside the middle of where the map's ${side} edge will be: ` +
    `${cells(gap + 1)} ${side} of it, with ${String(gap)} empty ${gap === 1 ? "cell" : "cells"} between it and the map. ` +
    `The map lands ${OPPOSITE[side]} of that spot. ` +
    "Click that same spot for every slab, never a pillar.";
  const pillars = `When every slab is placed, delete the two alignment pillars: ${where}.`;
  const ground =
    `Find flat, empty ground about twice the map's depth: where the map goes, plus about ${cells(far + 1)} more ` +
    `to its ${side}, where the far alignment pillar lands. Don't build anything on it yet.`;
  return {
    beside: true,
    plane: PLANE,
    ground,
    spot,
    first: spot,
    firstNote: `Two alignment pillars come with it: ${where}. Every other slab lines up on them.`,
    later:
      "Point at the same bare cell you clicked for slab 1, not at a pillar. This slab's pillars should land exactly on the ones already placed.",
    steady:
      `Don't move the camera between slabs. Keep the cursor on that bare cell ${side} of the map, not on a pillar ` +
      "or on walls you've already placed, or the paste can lift.",
    pillars,
    redo: REDO,
    changed:
      "In TaleSpire, delete the tiles in those slabs' areas, then paste the new slabs on the same spot. Unchanged slabs can stay.",
    foot: (n) =>
      `This map is too big for one slab, so it's split into ${slabs(n)} that share one paste spot. ${spot} ${pillars}`,
    list: [PLANE, ground, spot, pillars],
  };
}
