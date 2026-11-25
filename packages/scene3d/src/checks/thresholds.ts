/**
 * Every number the scene checks decide by, in one table, each with its reason. Units are tiles (1 tile = 5 ft in game)
 * unless the name says otherwise. Change a number here, never in a check.
 */
export const CHECK_THRESHOLDS = {
  // ── support (floating, sunk) ──
  /** A piece resting this far above the surface under it still rests on it (the game's 0.25 snap leaves no less). */
  floatGap: 0.06,
  /** A piece may sit this deep into what it stands on and still count as standing on it (feet sunk in a rug). */
  restDepth: 0.35,
  /** Pieces whose boxes come this close touch (structural pieces carry each other through such a touch). */
  touch: 0.06,
  /** Two floor pieces side by side carry each other when their tops differ by less than one 0.25 snap step. */
  flushStep: 0.26,
  /** A piece that hangs on a wall touches one within this reach (a torch's bracket stands off the wall's face). */
  mountReach: 0.25,
  /** A loose piece more than this share of whose height is below the floor it stands on is sunk. */
  sunkShare: 0.5,
  /** Pieces lower than this are cover (rugs, decals) and are never sunk. */
  sunkMinHeight: 0.2,
  /** A piece whose bottom is within this of its level's base with nothing at all under it is the ground itself. */
  groundSlack: 0.3,

  // ── surfaces (deck_hole, floor_over_open, roof_open) ──
  /** Samples per side of a planned cell (3: a 3 × 3 grid, inset so wall strips at the edges are not read). */
  cellSamples: 3,
  /** Inset of the samples from the cell's sides. */
  cellInset: 0.2,
  /** A floor's surface is looked for this far above and below the planned walkable top. */
  floorBand: 0.3,
  /** A cell is holed when at least this many of its samples meet no floor (a missing tile, not a crack). */
  holeSamples: 3,
  /** A roofed cell is open to the sky when at least this many of its samples see the sky. */
  skySamples: 3,
  /** Anything this far above a storey's floor covers it (a roof, the floor of the storey above). */
  coverAbove: 1.2,

  // ── shells (shell_gap) ──
  /** Samples along a run, apart. */
  runStep: 0.1,
  /** A clear stretch narrower than this is a crack between pieces (the game's own seams), not a gap. */
  gapMin: 0.25,
  /** A gap at least this wide is a fault (a person sees through it); narrower ones are warnings. */
  gapFault: 0.5,
  /** Heights above a building storey's floor its walls are probed at (all below the lowest wall's top). */
  wallHeights: [0.3, 0.9, 1.5],
  /** Heights above a deck its rail or bulwark is probed at (a ship's bulwark is about a tile high). */
  railHeights: [0.25, 0.55],
  /** A boundary ray starts this far inside the planned edge and ends this far outside it (a wall's band). */
  rayInside: 0.55,
  rayOutside: 0.75,
  /** An object's rail or hull may stand this far out from its deck's square cells (a bow's curve round them). */
  railOutside: 4,

  // ── clashes ──
  /** Sample spacing over two pieces' shared plan area. */
  clashStep: 0.1,
  /** Two pieces clash when their columns overlap by this share of the smaller piece's own columns. */
  clashShare: 0.3,
  /** And by at least this volume (cubic tiles): two candles touching are not a clash. */
  clashVolume: 0.02,
  /** A piece lower than this is flat cover (a rug, a decal): things stand on it by design. */
  flatCover: 0.15,

  // ── facing ──
  /** A front points away from the body when its cosine with the outward direction is above this (60 degrees). */
  facingCos: 0.5,
  /** A piece this close to the body's centre line has no outward direction to face. */
  facingCentre: 0.25,

  // ── ways ──
  /** Inset from a passage's ends (its jambs). */
  wayInset: 0.15,
  /** A walker needs this clear width ... */
  walkerWidth: 0.5,
  /** ... and this clear height above the floor (a medium creature is a tile tall; 1.4 with its head). */
  walkerHeight: 1.4,
  /** Heights above the floor a passage is probed at, apart. */
  wayStep: 0.2,
  /** A passage ray reaches this far either side of its edge (through the wall's band). */
  wayReach: 0.6,
} as const;

export type CheckThresholds = typeof CHECK_THRESHOLDS;
