/**
 * The edges and openings a level's structures build themselves (compile/buildFacts.ts records them per level; the wall
 * and opening passes and verify leave them to the structure builders).
 * Reads: the level's structures. Writes: nothing.
 */
import type { ResolvedLevel } from "../../../contracts/resolved";
import { SIDE_STEP, SIDES } from "../../../gen/gridGeometry";
import { sideEdgeIndex, sideOrient } from "../../../resolve/levelGrid";
import { key } from "./pieces";

/** Shell edges and structure openings realize must leave to the structure builders. */
export function structureClaims(L: ResolvedLevel): {
  edges: Set<string>;
  openings: Set<string>;
  /** Shell edges of ruined buildings: their walls may break off a tile above the floor. */
  ruined: Set<string>;
} {
  const edges = new Set<string>();
  const ruined = new Set<string>();
  const openings = new Set<string>();
  for (const st of L.structures ?? []) {
    for (const id of st.openingIds) openings.add(id);
    if (st.kind !== "building") continue;
    const cells = new Set(st.cells.map(([x, y]) => key(x, y)));
    const out = st.condition === "ruined" ? ruined : null;
    for (const [x, y] of st.cells) {
      const lx = x - L.bounds.x;
      const ly = y - L.bounds.y;
      for (const face of SIDES) {
        const [dx, dy] = SIDE_STEP[face];
        if (cells.has(key(x + dx, y + dy))) continue;
        const e = `${sideOrient(face)}${sideEdgeIndex(L.bounds, lx, ly, face)}`;
        edges.add(e);
        out?.add(e);
      }
    }
  }
  return { edges, openings, ruined };
}
