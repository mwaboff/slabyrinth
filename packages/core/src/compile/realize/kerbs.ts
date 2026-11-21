/**
 * Realize, kerb pass: kerb pieces along kerbed paths, a half-cell piece on the verge side of the edge.
 * Reads: the level's kerbs and cells. Writes: ledge placements; one info diagnostic when the palette has no kerb.
 */
import { lenFilter, outsideHost, placeEdgePiece } from "./edges";
import { KERB_DEFAULT_ROLE, kerbRole } from "../../palette/roles";
import type { RealizeLevel } from "./level";

// kerbs along kerbed paths: kerb.<material> / kerb.default, a half-cell piece on the path side of the edge
export function layKerbs(lv: RealizeLevel): void {
  const { L, V, topOf } = lv;
  const { lookup, pick, addDiag } = lv.ctx;
  let kerbNoted = false;
  for (const kb of L.kerbs ?? []) {
    const c = V.cell(kb.at[0], kb.at[1]);
    const res = lookup(L.id, c.theme, [kerbRole(kb.material), KERB_DEFAULT_ROLE], lenFilter(1), true);
    const v = res ? pick(res.variants, `${L.id}:kerb:${kb.at[0]}:${kb.at[1]}:${kb.side}`) : undefined;
    if (!v || !res) {
      if (!kerbNoted) {
        kerbNoted = true;
        addDiag({
          severity: "info",
          code: "role_missing",
          message: `No kerb piece (${kerbRole(kb.material)}, ${KERB_DEFAULT_ROLE}) in theme "${c.theme}"; paths are built without kerbs`,
          levelId: L.id,
          role: kerbRole(kb.material),
        });
      }
      continue;
    }
    // the kerb stands on the verge, beside the path, never on the path cell itself
    placeEdgePiece(lv, v, "ledge", outsideHost(kb.at[0], kb.at[1], kb.side), 1, {
      yBase: topOf(c),
      count: 1,
      source: { cell: [kb.at[0], kb.at[1]], elementId: "kerb" },
    });
  }
}
