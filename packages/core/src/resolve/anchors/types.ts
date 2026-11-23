/**
 * The anchors of a level: the places detail recipes attach to (resolve/recipes/), each a typed record with a local
 * frame (frame.ts) and what a recipe needs to decide whether and how it applies. Every anchor has a `key` that is
 * stable for the same plan (what a recipe's seed hashes), the plan element its pieces belong to, its theme, storey, the
 * room it is seen from and whether it is seen at all.
 *
 *   face        a straight run of wall seen from one side (a level wall from each open side, a building storey's walls
 *               from outside and the ground storey's from inside), with its openings as gaps along it and what its
 *               ends meet
 *   opening     a door, window or arch in a face: its centre on the wall surface, width, sill and head, both jambs as a
 *               mirrored pair of frames
 *   corner      where two faces meet: convex (an outer corner) or concave, with both faces' frames
 *   storeyLine  a building's floor line on its outside (the base and every upper floor), split where the wall does not
 *               run through the line
 *   bays        (a function of a face, not a list) a face cut into bays at a pitch, phase-locked to its openings
 *   zone        a room's floor, cell by cell: the wall band, the door aprons, the clear lanes from each door to the
 *               room's focal point, the middle and the ends, and a focal score per cell
 *   surface     the top of a piece of furniture something can rest on (a table, a counter)
 *   point       a room's centre, a focal feature, a floor opening, with the ceiling above
 *   path        a line between two points (overhead lines, road axes)
 *   boundary    a run of edges where the floor changes: a ledge, a step, a change of floor material
 */
import type { AreaId, ElementId, FeatureType, OpeningKind, Side, ThemeId, Vec2 } from "../../contracts/plan";
import type { AnchorFrame } from "./frame";

export type AnchorKind =
  "face" | "opening" | "corner" | "storeyLine" | "zone" | "surface" | "point" | "path" | "boundary";

/** What every anchor carries. */
export interface AnchorBase {
  readonly kind: AnchorKind;
  /** Stable within the level for the same plan: recipes hash it for their draws. */
  readonly key: string;
  readonly frame: AnchorFrame;
  /** The theme its pieces are built in (resolve/levelGrid.ts `elementTheme` rules). */
  readonly theme: ThemeId;
  /** The plan element its pieces belong to (a building, an area, an opening): verify treats them as that element's. */
  readonly element: ElementId;
  /** The building it belongs to, or null for the level's own walls and floors. */
  readonly structure: ElementId | null;
  /** A building's storey (0 the ground), 0 for the level's own. */
  readonly storey: number;
  /** The area it is seen from (the room a wall faces into), or null outside every area. */
  readonly room: AreaId | null;
  /** Seen from outside a building (a facade), not from inside a room. */
  readonly outside: boolean;
  /** Someone can see it (false: the far side of a party wall, a face against another building). */
  readonly seen: boolean;
  /** The paste layer of a building's pieces ("storey:<n>"), absent on the level's own. */
  readonly layer?: string;
}

/** An opening along a face, in the face's local frame. */
export interface FaceGap {
  readonly id: ElementId;
  readonly kind: OpeningKind;
  /** Local x of its near and far side. */
  readonly from: number;
  readonly to: number;
}

/** What a face's end meets: an outer corner, an inner corner, or nothing (a free end, a wall continuing elsewhere). */
export type FaceEnd = "convex" | "concave" | "open";

export interface FaceAnchor extends AnchorBase {
  readonly kind: "face";
  /** Local x runs 0..length along the face. */
  readonly length: number;
  /** Height of the wall above `frame.base` (the face's top). */
  readonly height: number;
  readonly style: string;
  /** Natural rock (gen/wallStyles.ts trait). */
  readonly natural: boolean;
  /** How far the surface stands from the grid line toward the viewer (a building's outside: 0.5). */
  readonly plane: number;
  /**
   * How deep the wall reaches behind its surface: its inner face stands at local z = -depth (a half-cell wall: 0.5;
   * a whole-cell one: 1). Past it is the room on the other side; no trim reaches there (recipes/walls.ts `seated`).
   */
  readonly depth: number;
  readonly gaps: readonly FaceGap[];
  /** What the start (local x = 0) and end meet. */
  readonly ends: readonly [FaceEnd, FaceEnd];
  /**
   * How far past each end the surface it meets stands (before local x = 0, after `length`): 0.5 at a building's outer
   * corner (its surfaces stand half a cell out), negative short of an inner one, 0 at an open end.
   */
  readonly beyond: readonly [number, number];
  /** A building's ground storey standing on a footing course or a plinth (false for any other face). */
  readonly footed: boolean;
}

export interface OpeningAnchor extends AnchorBase {
  readonly kind: "opening";
  /** The opening's id (a building's upper opening: its synthetic id). */
  readonly id: ElementId;
  readonly openingKind: OpeningKind;
  /** Frame origin: the opening's centre on the wall surface, at the floor of its storey. */
  readonly width: number;
  /** Local heights of its bottom and of the top of the wall it is cut in. */
  readonly sill: number;
  readonly head: number;
  /** The jambs as a mirrored pair: [right (local x = +width/2, u pointing away), left (x = -width/2, mirrored)]. */
  readonly jambs: readonly [AnchorFrame, AnchorFrame];
  /** The face it is cut in (its key), that face's wall style and whether it is natural rock. */
  readonly face: string;
  readonly style: string;
  readonly natural: boolean;
  /** Blank wall beside it along the face, [left (before `from`), right (after `to`)]. */
  readonly clear: readonly [number, number];
  /** Whether that blank ends at another opening (true) or at the face's end (false), [left, right]. */
  readonly between: readonly [boolean, boolean];
  /** How deep its face's wall reaches behind the surface (FaceAnchor.depth). */
  readonly depth: number;
}

export interface CornerAnchor extends AnchorBase {
  readonly kind: "corner";
  /** An outer corner (the walls turn away from the viewer) or an inner one. */
  readonly convex: boolean;
  /**
   * Frame origin: where the two surfaces meet; turn = the second face's, so local +x runs away from the corner along
   * it and local -x is the first face's normal.
   */
  readonly height: number;
  /** Both faces' frames, each with its origin at the corner and `u` pointing away from it along its face. */
  readonly faces: readonly [AnchorFrame, AnchorFrame];
  /** The keys of the two faces. */
  readonly faceKeys: readonly [string, string];
  /** The first face's wall style, and whether either face is natural rock. */
  readonly style: string;
  readonly natural: boolean;
  /** How deep the thinner of the two walls reaches behind its surface (FaceAnchor.depth). */
  readonly depth: number;
}

export interface StoreyLineAnchor extends AnchorBase {
  readonly kind: "storeyLine";
  /** The ground line (the foot of the ground storey) or a floor line (the floor of an upper storey). */
  readonly line: "base" | "floor";
  /** Frame base: the floor top of the storey the line starts; local x runs 0..length along the outside. */
  readonly length: number;
  /** Floor thickness under the line (the wall closes it there). */
  readonly band: number;
  /** How deep the storey's wall reaches behind its outer surface (FaceAnchor.depth). */
  readonly depth: number;
  /** Openings crossing the line (a door on the base line), local x. */
  readonly gaps: readonly FaceGap[];
  readonly ends: readonly [FaceEnd, FaceEnd];
  /** How far past each end the line it meets stands (as FaceAnchor.beyond). */
  readonly beyond: readonly [number, number];
  /** The storey's wall style, the floor material of the storey above the line. */
  readonly style: string;
  readonly floor: string;
  /** Whether the ground storey stands on a footing course or a plinth (base line only). */
  readonly footed: boolean;
}

/** A room's zone classes, as bits of `ZoneAnchor.classAt`. */
export const ZONE = {
  /** Touches a boundary (a wall, an opening, the room's edge). */
  BAND1: 1,
  /** Within two cells of one. */
  BAND2: 2,
  /** On a clear lane from a door to the focal point or another door. */
  LANE: 4,
  /** In front of a door (its apron). */
  DOOR: 8,
  /** Neither in the wall band nor on a lane or apron. */
  MIDDLE: 16,
  /** At one end of a long room (a fifth of its length). */
  END: 32,
} as const;

export interface ZoneDoor {
  readonly id: ElementId;
  readonly kind: OpeningKind;
  /** The room's cells beside the opening. */
  readonly cells: readonly Vec2[];
  /** The side of those cells the opening is on. */
  readonly side: Side;
}

export interface ZoneAnchor extends AnchorBase {
  readonly kind: "zone";
  /** Frame origin: the focal point (the focal feature's centre, else the cell farthest from the doors). */
  readonly area: AreaId;
  readonly purpose?: string;
  readonly cells: readonly Vec2[];
  readonly doors: readonly ZoneDoor[];
  /** The focal feature, when the room has one. */
  readonly focalFeature: ElementId | null;
  /** The room's centroid (plan point) and the axis its bounding box is longer along (plan x, or y). */
  readonly centroid: readonly [number, number];
  readonly longAxis: "x" | "y";
  /**
   * What its floor says of the place: under a roof (a room or corridor), mostly natural ground (resolve/materials.ts),
   * and its wear (0 kept up, 1 a rough interior, 2 abandoned or a ruin).
   */
  readonly indoor: boolean;
  readonly natural: boolean;
  readonly wear: 0 | 1 | 2;
  /**
   * Steps (4-neighbour, inside the area) from a cell to the nearest one where its ground meets something: a wall or an
   * opening, a ledge, a step, another floor material, water, another area's floor, a building, a blocking feature. The
   * board's own edge is not one (slabs are tiled side by side). Infinity off the area or when nothing is met.
   */
  edgeAt(x: number, y: number): number;
  /** Zone bits (ZONE) of a cell of the room, 0 for any other cell. */
  classAt(x: number, y: number): number;
  /** Focal score 0..1 of a cell (1 at a door or the focal point, falling away from them), 0 off the room. */
  focalAt(x: number, y: number): number;
}

export interface SurfaceAnchor extends AnchorBase {
  readonly kind: "surface";
  readonly feature: ElementId;
  readonly type: FeatureType;
  /** Frame origin: the centre of its footprint, turned as the feature, base = the top it offers (when known). */
  readonly size: readonly [number, number];
  /** Absolute top height, or null when the palette was not asked. */
  readonly top: number | null;
  /** People sit at it (a table, a counter): its long sides are seat sides. */
  readonly seated: boolean;
}

export interface PointAnchor extends AnchorBase {
  readonly kind: "point";
  readonly what: "room" | "focal" | "floorOpening";
  /** Absolute height of what is overhead (the level above, a building storey's top), null when open to the sky. */
  readonly ceiling: number | null;
}

export interface PathAnchor extends AnchorBase {
  readonly kind: "path";
  readonly what: "line" | "road";
  readonly points: readonly (readonly [number, number])[];
}

export interface BoundaryAnchor extends AnchorBase {
  readonly kind: "boundary";
  readonly what: "ledge" | "step" | "material";
  /** Local x runs 0..length; the frame's normal points to the lower (ledge, step) or the second side. */
  readonly length: number;
  /** Height difference across it (tiles, ≥ 0). */
  readonly drop: number;
}

export type Anchor =
  | FaceAnchor
  | OpeningAnchor
  | CornerAnchor
  | StoreyLineAnchor
  | ZoneAnchor
  | SurfaceAnchor
  | PointAnchor
  | PathAnchor
  | BoundaryAnchor;

export type AnchorOf<K extends AnchorKind> = Extract<Anchor, { kind: K }>;
