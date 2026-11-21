/**
 * Realize, kerb pass: kerb pieces along kerbed paths, a half-cell piece on the verge side of the edge.
 * Reads: the level's kerbs and cells. Writes: ledge placements; one info diagnostic when the palette has no kerb.
 */
import { lenFilter, placeEdgePiece, type EdgeCtx } from "./edges";
import { OPPOSITE } from "../../gen/gridGeometry";
import type { RealizeLevel } from "./level";

// kerbs along kerbed paths: kerb.<material> / kerb.default, a half-cell piece on the path side of the edge
export function layKerbs(lv: RealizeLevel): void {
  const { L, V, topOf } = lv;
  const { lookup, pick, addDiag } = lv.ctx;
  let kerbNoted = false;
  for (const kb of L.kerbs ?? []) {
    const c = V.cell(kb.at[0], kb.at[1]);
    const res = lookup(L.id, c.theme, [`kerb.${kb.material}`, "kerb.default"], lenFilter(1), true);
    const v = res ? pick(res.variants, `${L.id}:kerb:${kb.at[0]}:${kb.at[1]}:${kb.side}`) : undefined;
    if (!v || !res) {
      if (!kerbNoted) {
        kerbNoted = true;
        addDiag({
          severity: "info",
          code: "role_missing",
          message: `No kerb piece (kerb.${kb.material}, kerb.default) in theme "${c.theme}"; paths are built without kerbs`,
          levelId: L.id,
          role: `kerb.${kb.material}`,
        });
      }
      continue;
    }
    const s = kb.side;
    const ex = s === "E" ? kb.at[0] + 1 : kb.at[0];
    const ey = s === "S" ? kb.at[1] + 1 : kb.at[1];
    const orient: "h" | "v" = s === "N" || s === "S" ? "h" : "v";
    const ctx: EdgeCtx = {
      orient,
      x: ex,
      y: ey,
      // the kerb stands on the verge, beside the path, never on the path cell itself
      hostFirst: s === "N" || s === "W",
      hostX: s === "E" ? kb.at[0] + 1 : s === "W" ? kb.at[0] - 1 : kb.at[0],
      hostY: s === "S" ? kb.at[1] + 1 : s === "N" ? kb.at[1] - 1 : kb.at[1],
      otherX: kb.at[0],
      otherY: kb.at[1],
      otherOpen: true,
      planSide: OPPOSITE[s],
      base: topOf(c),
      top: topOf(c) + v.unitHeight,
      theme: c.theme,
      hostOpen: true,
    };
    placeEdgePiece(
      lv,
      v,
      "ledge",
      res.role,
      ctx,
      1,
      topOf(c),
      1,
      { cell: [kb.at[0], kb.at[1]], elementId: "kerb" },
      false,
    );
  }
}
