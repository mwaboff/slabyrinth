/**
 * Realize, an enclosure's gates (its fence runs are the level's own walls, built by the wall passes): a gate piece on
 * each gateway, gate.<fence style> → opening.door.<fence style>, of the gateway's width else one-wide pieces along it,
 * placed on the edge's half cell or centred on the edge line as the role's mount says.
 * Reads: the enclosure's fence and the level's gate openings. Writes: opening placements; role_missing info for a
 * gateway with no gate piece.
 */
import type { Side } from "../../../contracts/plan";
import type { ResolvedOpening } from "../../../contracts/resolved";
import { lenFilter, lengthOf } from "../../../palette/filters";
import { partRole, styledOpeningRole } from "../../../palette/roles";
import { placeEdgeCenterPiece, sideLine } from "../edges";
import { groundTop, info, type StructureCtx } from "./context";
import { edgePiece, key } from "./pieces";

export function layEnclosure(b: StructureCtx): void {
  const { st, lv } = b;
  const { L } = lv;
  const { pick } = lv.ctx;
  const fence = st.fence?.style ?? null;
  if (!fence) return;
  const cells = new Set(st.cells.map(([x, y]) => key(x, y)));
  const roles = [partRole("gate", fence), styledOpeningRole("door", fence)];
  for (const g of st.fence?.gates ?? []) {
    const o = L.openings.find((op) => op.id.startsWith(`${st.id}~gate`) && gateOn(op, g.at, g.side));
    const width = o?.width ?? 1;
    const r = b.lookup(roles, lenFilter(width), true) ?? b.lookup(roles, lenFilter(1), true);
    const v = r ? pick(r.variants, `${L.id}:${st.id}:gate:${g.at[0]},${g.at[1]}`) : undefined;
    if (!v || !r) {
      info(lv, "role_missing", `No gate piece for a ${fence} fence; ${st.id} has an open gateway`, roles[0]);
      continue;
    }
    const len = lengthOf(v);
    const n = Math.max(1, Math.floor(width / len));
    const elementId = o?.id ?? st.id;
    for (let k = 0; k < n; k++) {
      const x = g.side === "N" || g.side === "S" ? g.at[0] + k * len : g.at[0];
      const y = g.side === "N" || g.side === "S" ? g.at[1] : g.at[1] + k * len;
      if (!cells.has(key(x, y))) continue;
      const floor = groundTop(lv, x, y);
      if ((r.def.mount ?? "half-cell") === "edge-center")
        placeEdgeCenterPiece(lv, v, "opening", sideLine(x, y, g.side, floor), len, {
          cell: [x, y],
          elementId,
        });
      else edgePiece(b, v, "opening", { x, y, face: g.side }, len, floor, { id: elementId }, r.role);
    }
  }
}

/** Is the opening the gateway on side `side` of yard cell `at` (the resolver records it by its edge's start vertex)? */
function gateOn(o: ResolvedOpening, at: readonly [number, number], side: Side): boolean {
  if (side === "N") return o.orientation === "h" && o.start[0] === at[0] && o.start[1] === at[1];
  if (side === "S") return o.orientation === "h" && o.start[0] === at[0] && o.start[1] === at[1] + 1;
  if (side === "W") return o.orientation === "v" && o.start[0] === at[0] && o.start[1] === at[1];
  return o.orientation === "v" && o.start[0] === at[0] + 1 && o.start[1] === at[1];
}
