/**
 * The ship kit's geometry as measured from the game's own meshes (spike, 2026-11-23: the installed game's bundles read
 * by a mesh reader; its render of the round-1 calibration slab reproduced the owner's screenshots piece by piece).
 * Data only, the measured facts the vessel recipe's `SHIP_KIT_FRAME` must agree with (test/unit/objects/
 * shipKitFrame.test.ts); no mesh is stored.
 *
 * Rotations are TaleSpire's 15° steps for a ship whose bow points NORTH (F = 0; bow east is F + 6). "Seam" is the
 * cross-section mismatch in tiles where two hull tiles meet, best placement against the next best (lower is better).
 */
export interface MeasuredHullSlot {
  /** The piece's name in the catalog. */
  readonly piece: string;
  /** Its rotation in steps for a bow-north ship. */
  readonly steps: number;
  /** Which side of the centreline, or the centre strip. */
  readonly side: "port" | "starboard" | "centre";
  /** Seam score against its neighbours (the hull side, or the halves), and the next best placement's. */
  readonly seam: number;
  /** Absent where the spike did not report it. */
  readonly nextBest?: number;
}

/** The closed hull (beam 8: halves and sides; beam 10 adds the centre strips at the bow and the stern). */
export const MEASURED_HULL: readonly MeasuredHullSlot[] = [
  // (two sides seam 0.008 against each other, the measurement's floor)
  { piece: "Ship bottom side 4x2_Port and Starboard", steps: 6, side: "port", seam: 0.008 },
  { piece: "Ship bottom side 4x2_Port and Starboard", steps: 18, side: "starboard", seam: 0.008 },
  { piece: "Ship bottom front L_Bow", steps: 12, side: "port", seam: 0.122, nextBest: 0.207 },
  { piece: "Ship bottom front R_Bow", steps: 12, side: "starboard", seam: 0.122, nextBest: 0.207 },
  { piece: "Ship bottom back L_Stern", steps: 12, side: "port", seam: 0.124, nextBest: 0.184 },
  { piece: "Ship bottom back R_Stern", steps: 12, side: "starboard", seam: 0.125, nextBest: 0.185 },
  { piece: "Ship bottom front filler 4x2_Bow", steps: 12, side: "centre", seam: 0.072, nextBest: 0.6 },
  { piece: "Ship bottom back Fin 4x2_Rudder", steps: 0, side: "centre", seam: 0.047, nextBest: 0.6 },
];

/** The curved bow bulwark on each half's rim (one piece, turned). */
export const MEASURED_BOW_FENCE = { port: 12, starboard: 18, seam: 0.08, nextBest: 0.64 } as const;

/**
 * Props and rig at rot 0 (directions in the slab frame: +z north). Where a measurement left a face unsettled, it says
 * so (`settled: false`) and the recipe keeps its reading.
 */
export const MEASURED_PROPS = {
  /** The bowsprit sections rise toward +z; each from its low end to its high end, relative to its origin (z, y). */
  bowsprit: {
    base: { low: [0, 0], high: [3.38, 2.47] },
    mid: { low: [-0.14, -0.2], high: [3.4, 2.49] },
    top: { low: [-0.13, -0.19], high: [3.32, 2.35] },
  },
  /** The shroud ladder climbs toward +z: 2.03 up over a run of about 1. */
  shroudsClimb: "+z",
  /** A set sail's belly (convex side) faces +z. */
  sailBelly: "+z",
  /**
   * The cannon's muzzle points +z: the narrow end of its long axis, raised off the floor (round 5; the spike's first
   * reading, -z, turned the round-4 cannons inboard in the owner's 231). Held in gen/pieceFacts.ts `front`.
   */
  cannonBarrel: "+z",
  /** The kit boat's front section points +z. */
  boatBow: "+z",
  /** The helm's operator stands at the wheel (north edge of its tile) facing its box: -z. */
  helmOperator: "-z",
  /** The stern gallery's outer face (cap and glass) is -z; its "L" corner is rounded at the south-west (port aft). */
  galleryFace: "-z",
  /** The gallery's full-height wall is this deep from its -z edge; behind it only a low sill. */
  galleryWallDepth: 0.7,
  /** A side fence's base lip protrudes -z; which face is outboard is not settled by the mesh. */
  fenceLip: { side: "-z", settled: false },
  /** A plain ship wall's buttress posts and the porthole and window mouldings stick out +z (an inner face). */
  wallPosts: { side: "+z", settled: false },
} as const;
