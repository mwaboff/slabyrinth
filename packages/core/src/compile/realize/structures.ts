/**
 * Realize, buildings and enclosures: hands the level's structures to compile/structure.ts, which builds their own
 * shells, floors, roofs and doors.
 * Reads: the level's structures and cells. Writes: placements (through `emit`); structure info diagnostics.
 */
import type { CompileDiagnostic } from "../../contracts/compiler";
import { realizeStructures } from "../structure";
import type { LevelWork } from "./work";

// ── buildings and enclosures ──
export function layStructures(w: LevelWork): void {
  const { L, V, elev, topOf, emit } = w;
  const { seed, frame, lookup, pick, facingOf, addDiag } = w.ctx;
  if (L.structures?.length)
    realizeStructures({
      L,
      frame,
      seed,
      lookup: (theme, roles, filter, quiet) => lookup(L.id, theme, roles, filter, quiet),
      pick,
      facingOf,
      emit,
      groundTop: (x, y) => {
        const c = V.cell(x, y);
        return c.open ? topOf(c) : elev + 0.5;
      },
      info: (code, message, role) => {
        addDiag({
          severity: "info",
          code: code as CompileDiagnostic["code"],
          message,
          levelId: L.id,
          ...(role ? { role } : {}),
        });
      },
    });
}
