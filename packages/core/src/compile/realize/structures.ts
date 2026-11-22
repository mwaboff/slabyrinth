/**
 * Realize, buildings and enclosures: each structure of the level, in the level's order (a building earlier in the list
 * builds a wall it shares with a later one), built by compile/realize/structures/: a building's storeys, roofs and what
 * it carries (structures/building.ts lists the steps), an enclosure's gates (its fences are the level's walls).
 *
 *   structures/context.ts      the structure's context and role lookup (a building's era and style-fallback notes)
 *   structures/pieces.ts       edge pieces (realize/edges.ts), stacked courses, tiles, props, face cells
 *   structures/openings.ts     which storey faces each opening takes
 *   structures/courses.ts      a storey's walls, openings and corner posts
 *   structures/seams.ts        set-in storeys' seams, overhanging volumes' lips
 *   structures/roofs.ts        roof layers, decks, gable fill, flat tops, dormers (roofPiece.ts, spire.ts)
 *   structures/attachments.ts  chimneys, porches, door and window lights, entrance strips, sign bands
 *   structures/details.ts      a designed building's facade details
 *   structures/dressing.ts     debris, wall-top rubble, growth, ruin remnants
 *   structures/rooftop.ts      roof huts, masts, rooftop sets and clutter
 *   structures/enclosures.ts   gates
 *   structures/claims.ts       the edges and openings structures build themselves (compile/buildFacts.ts)
 *
 * What a part is built of where the building does not say (the door family of its use, a storey with no walls, the
 * last floor or kit of a chain) is resolve/building/parts.ts; role names are palette/roles.ts.
 * Reads: the level's structures, cells and openings. Writes: placements (through `emit`); structure info diagnostics.
 */
import type { RealizeLevel } from "./level";
import { layBuilding } from "./structures/building";
import { enclosureCtx } from "./structures/context";
import { layEnclosure } from "./structures/enclosures";

// ── buildings and enclosures ──
export function layStructures(lv: RealizeLevel): void {
  for (const st of lv.L.structures ?? []) {
    if (st.kind === "enclosure") layEnclosure(enclosureCtx(lv, st));
    else layBuilding(lv, st);
  }
}
