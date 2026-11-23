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
import { ROOF_KITS, nearKits, roofKitInfo } from "../../../resolve/roofKits";
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
 * Generator 5 (`roofPatches`): what a roof piece with a cell in the building's patch is re-laid in, by the roof-kit
 * facts (resolve/roofKits.ts): the roof's own kit in its weathered pieces when it has them, else a kit of the same tone
 * and family the theme has a slope of, else no patch at all (a piece of another colour reads as a fault); any other
 * piece, the roof's own kit. Generator 5 (`closedWornRoofs`): a worn roof shows its wear as patches, never holes, so
 * with neither it is patched in another pitched kit the theme has (what was to hand), in slopes only: a ridge cap or a
 * corner keeps its own kit (another kit's corner may be a spiked tip).
 */
function patchOf(b: StructureCtx, kit: string, p: RoofPiece): { kit: string; worn: boolean } {
  const { st } = b;
  const none = { kit, worn: false };
  if (!b.lv.ctx.profile.roofPatches || !st.roofPatch) return none;
  if (!st.roofPatch.some(([x, y]) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h)) return none;
  const has = (k: string): boolean => !!b.lookup([roofRole(k, "slope")], undefined, true);
  if (roofKitInfo(kit)?.weathered === true) return { kit, worn: true };
  const pitched = Object.keys(ROOF_KITS).filter((k) => k !== kit && ROOF_KITS[k]?.pitched === true && has(k));
  const near = pitched.find((k) => nearKits(k, kit));
  if (near !== undefined) return { kit: near, worn: false };
  const slope = p.kind === "slope" || p.kind === "slope2" || p.kind === "slope2x2";
  const other = b.lv.ctx.profile.closedWornRoofs && slope ? pitched[0] : undefined;
  return other !== undefined ? { kit: other, worn: false } : none;
}

/** Generator 5 (`ruinBays`): a ruin's roof piece over a lost bay (any cell it covers is a roof hole). */
export function openBay(b: StructureCtx, p: { x: number; y: number; w: number; h: number }): boolean {
  if (!hasOpenBays(b)) return false;
  return (b.st.ruin?.roofHoles ?? []).some(
    ([x, y]) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h,
  );
}

/** Generator 5 (`ruinBays`): a ruin that lost bays (its roof holes are open to the sky, eaves included). */
export const hasOpenBays = (b: StructureCtx): boolean =>
  b.lv.ctx.profile.ruinBays && b.st.condition === "ruined" && (b.st.ruin?.bays?.length ?? 0) > 0;

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
  const inPiece = ([x, y]: readonly [number, number]): boolean =>
    x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h;
  // the open cells under the piece: a weathered roof's fallen patch (the slope pieces above the eave course are gone,
  // the deck or room shows) and, generator 5, a ruin's lost bays (open to the sky, eaves and ridge included:
  // resolve/building/ruinBays.ts)
  const open = [
    ...(st.condition === "weathered" && p.course > 0 && p.kind !== "cap" ? (st.ruin?.roofHoles ?? []) : []),
    ...(openBay(b, p) ? (st.ruin?.roofHoles ?? []) : []),
  ].filter(inPiece);
  // generator 5 (`closedWornRoofs`): a piece over an open cell is laid cell by cell round it (the opening follows its
  // own ragged cells, not the piece's rectangle); before, the whole piece was left out
  const openCells =
    open.length > 0 &&
    b.lv.ctx.profile.closedWornRoofs &&
    p.w * p.h > 1 &&
    (p.kind === "slope2" || p.kind === "slope2x2")
      ? new Set(open.map(([x, y]) => `${x},${y}`))
      : null;
  if (open.length > 0 && openCells === null) return;
  // generator 5: a worn roof's patches are re-laid in its own kit's worn pieces or a near kit
  // (resolve/building/wear.ts)
  const patch = patchOf(b, kit, p);
  kit = patch.kit;
  const wantBroken =
    patch.worn || (!ring && st.roof.broken > 0 && hashUnitUtf16(pkey, "broken") < st.roof.broken);
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
  if (openCells === null && tryPlace(p.kind, p.x, p.y, p.w, p.h, p.course)) return;
  // fallbacks: a 2×2 as two 1-wide run-2 pieces; a run-2 piece as two one-cell slopes
  const runAlongY = p.eave === "N" || p.eave === "S";
  const singles = (x: number, y: number, w: number, h: number): void => {
    // the cell nearer the eave sits at the piece's course, the other one course higher
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        if (openCells?.has(`${xx},${yy}`) === true) continue;
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
  if (openCells !== null) {
    singles(p.x, p.y, p.w, p.h);
    return;
  }
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
