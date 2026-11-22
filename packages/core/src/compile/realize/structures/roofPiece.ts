/**
 * Realize, one roof piece of a building's kit (roofs, spires, seams' skirts and lips lay them all through here):
 *   slope / slope2 / slope2x2   roof.<kit>.<kind>; a missing 2×2 as two run-2 pieces, a missing run-2 as one-cell slopes
 *   cap                         roof.<kit>.cap → roof.<kit>.flat → roof.default.cap
 *   corner                      roof.<kit>.corner → roof.<kit>.slope
 *   step                        roof.<kit>.step → roof.default.step → roof.<kit>.slope
 * Reads: the piece (resolve/roof.ts), the building's condition and broken share. Writes: roof placements (layer
 * "roof"); role_missing info for a piece with no fallback left.
 */
import type { RoleName } from "../../../contracts/compiler";
import type { Side } from "../../../contracts/plan";
import { BROKEN, INTACT } from "../../../palette/filters";
import { DEFAULT_PART, roofRole } from "../../../palette/roles";
import type { RoofPiece } from "../../../resolve/roof";
import { hashUnitUtf16 } from "../../../util/hash";
import { info, type StructureCtx } from "./context";

/** The corner piece of a kit: it is turned onto its corner, not by its eave. */
const CORNER = "corner";

/** The roles a roof piece of a kind is asked from. */
function roofPieceRoles(kit: string, kind: RoofPiece["kind"]): RoleName[] {
  switch (kind) {
    case "cap":
      // a kit with no cap or flat piece (village) falls to the palette's default cap (an alias of the slate cap,
      // generator 4 only: the role is hidden from earlier generators), so the ridge row is never bare
      return [roofRole(kit, "cap"), roofRole(kit, "flat"), roofRole(DEFAULT_PART, "cap")];
    case "corner":
      return [roofRole(kit, CORNER), roofRole(kit, "slope")];
    case "step":
      return [roofRole(kit, "step"), roofRole(DEFAULT_PART, "step"), roofRole(kit, "slope")];
    default:
      return [roofRole(kit, kind)];
  }
}

/**
 * One roof piece: rotation from the kit's eave facing, position = min corner of the covered cells. A 2×2 slope the kit
 * lacks is laid as two run-2 pieces, a run-2 piece as one-cell slopes.
 */
export function layRoofPiece(b: StructureCtx, kit: string, p: RoofPiece, base: number, tag: string): void {
  const { st } = b;
  const { emit } = b.lv;
  const { seed, frame, pick, facingOf } = b.lv.ctx;
  const ring = p.kind !== "slope2" && p.kind !== "slope2x2"; // eaves rows and ridge stay intact
  const pkey = `${seed}:${st.id}:${p.x},${p.y}:${p.kind}`;
  // a weathered roof's fallen patch: the slope pieces above the eave course are gone, the deck or room shows
  if (st.condition === "weathered" && p.course > 0 && p.kind !== "cap" && st.ruin?.roofHoles) {
    const holes = st.ruin.roofHoles;
    if (holes.some(([x, y]) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h)) return;
  }
  const wantBroken = !ring && st.roof.broken > 0 && hashUnitUtf16(pkey, "broken") < st.roof.broken;
  const tryPlace = (
    kind: RoofPiece["kind"],
    x: number,
    y: number,
    w: number,
    h: number,
    course: number,
  ): boolean => {
    const roles = roofPieceRoles(kit, kind);
    let r = wantBroken ? b.lookup(roles, BROKEN, true) : null;
    if (!r || r.variants.length === 0) r = b.lookup(roles, INTACT, true);
    if (!r) return false;
    const v = pick(r.variants, `${pkey}:${x},${y}`);
    if (!v) return false;
    if (kind === "cap") {
      const m = frame.rectMin(x, y, 1, 1);
      emit(
        v,
        "wall",
        m.x,
        base + course - v.geom.size.y,
        m.z,
        v.rot,
        { cell: [x, y], elementId: `${tag}~roof` },
        "roof",
      );
      return true;
    }
    const front = facingOf(v, "roof", r.role).front ?? "N";
    // a corner piece at rot 0 has its low sides N and W (front N): turn it clockwise onto its corner (UNVERIFIED)
    const toward: Side =
      r.role.endsWith(`.${CORNER}`) && p.corner
        ? ({ NW: "N", NE: "E", SE: "S", SW: "W" } as const)[p.corner]
        : p.eave;
    const steps = frame.stepsToFace(front, frame.worldSide(toward));
    const quarter = Math.round(steps / 6) % 2 === 1;
    const [fw, fh] = v.footprint;
    const rw = quarter ? fh : fw;
    const rh = quarter ? fw : fh;
    if (rw !== w || rh !== h) return false;
    const m = frame.rectMin(x, y, w, h);
    emit(
      v,
      "wall",
      m.x,
      base + course,
      m.z,
      steps * 15 + v.rot,
      { cell: [x, y], elementId: `${tag}~roof` },
      "roof",
    );
    return true;
  };
  if (tryPlace(p.kind, p.x, p.y, p.w, p.h, p.course)) return;
  // fallbacks: a 2×2 as two 1-wide run-2 pieces; a run-2 piece as two one-cell slopes
  const runAlongY = p.eave === "N" || p.eave === "S";
  const singles = (x: number, y: number, w: number, h: number): void => {
    // the cell nearer the eave sits at the piece's course, the other one course higher
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        const nearEave =
          p.eave === "N"
            ? yy === y
            : p.eave === "S"
              ? yy === y + h - 1
              : p.eave === "W"
                ? xx === x
                : xx === x + w - 1;
        if (!tryPlace("slope", xx, yy, 1, 1, p.course + (nearEave ? 0 : 1)))
          info(
            b.lv,
            "role_missing",
            `No ${roofRole(kit, "slope")} piece for ${st.id}`,
            roofRole(kit, "slope"),
          );
      }
  };
  if (p.kind === "slope2x2") {
    const halves: Array<[number, number, number, number]> = runAlongY
      ? [
          [p.x, p.y, 1, 2],
          [p.x + 1, p.y, 1, 2],
        ]
      : [
          [p.x, p.y, 2, 1],
          [p.x, p.y + 1, 2, 1],
        ];
    for (const [x, y, w, h] of halves) if (!tryPlace("slope2", x, y, w, h, p.course)) singles(x, y, w, h);
    return;
  }
  if (p.kind === "slope2") singles(p.x, p.y, p.w, p.h);
  else info(b.lv, "role_missing", `No ${roofRole(kit, p.kind)} piece for ${st.id}`, roofRole(kit, p.kind));
}
