/**
 * The anchors of one resolved level (types.ts says what each kind gives), derived on first ask and kept: wall anchors
 * (faces, openings, corners, storey lines) from the shared wall walks (faces.ts), floor zones (zones.ts), and the
 * point-like ones (points.ts); bays are a function of a face (bays.ts). Pure and deterministic: the same level gives the
 * same anchors in the same order. What only the palette knows (how a theme mounts its walls, how tall a table's top
 * is) comes in through `AnchorOptions`, asked by the caller.
 *
 * Left out, with why:
 *   silhouette  roof ridges, eaves and flat tops are computed by the roof builders in compile/realize/structures
 *               (roofs.ts, roofPiece.ts), not in the resolved record; giving them as anchors means moving that walk to
 *               resolve/ first (as structureFaces.ts did for walls). No Wave-1 recipe needs it.
 *   boundary    wall foot and ceiling line: they are a face's base line and top (`face.frame.base`, `face.height`),
 *               not a separate anchor.
 */
import type { ThemeId } from "../../contracts/plan";
import type { ResolvedLevel } from "../../contracts/resolved";
import { GENERIC_THEME } from "../../palette/resolve";
import { LevelGrid } from "../levelGrid";
import { findWallFaces } from "../wallFaces";
import { structureClaims } from "../structureFaces";
import { wallAnchors, type MountOf, type WallAnchors } from "./faces";
import { boundaryAnchors, pathAnchors, pointAnchors, surfaceAnchors, type TopOf } from "./points";
import type { Anchor, AnchorKind, AnchorOf } from "./types";
import { zoneAnchors } from "./zones";

export * from "./types";
export * from "./frame";
export { baysOf, blankStretches, type Bay } from "./bays";
export type { MountOf, WallMount } from "./faces";
export type { TopOf } from "./points";

export interface AnchorOptions {
  /** How a theme mounts a wall style (default: a half-cell strip, the palette default). */
  readonly mountOf?: MountOf;
  /** The absolute top a feature offers (default: unknown). */
  readonly topOf?: TopOf;
  /** Absolute height of what is overhead at a cell (default: unknown). */
  readonly ceilingOf?: (x: number, y: number) => number | null;
  /** The theme of a cell with none. */
  readonly defaultTheme?: ThemeId;
  /** A passage reaching the board edge is an exit (resolve/wallFaces.ts). */
  readonly boardEdgeIsExit?: boolean;
}

export class LevelAnchors {
  readonly grid: LevelGrid;
  private walls?: WallAnchors;
  private readonly memo = new Map<AnchorKind, readonly Anchor[]>();

  constructor(
    readonly level: ResolvedLevel,
    private readonly opts: AnchorOptions = {},
  ) {
    this.grid = new LevelGrid(level, opts.defaultTheme ?? GENERIC_THEME);
  }

  /** Every anchor of a kind, in a fixed order. */
  of<K extends AnchorKind>(kind: K): readonly AnchorOf<K>[] {
    let list = this.memo.get(kind);
    if (!list) {
      list = this.derive(kind);
      this.memo.set(kind, list);
    }
    return list as readonly AnchorOf<K>[];
  }

  private wallsOf(): WallAnchors {
    if (!this.walls) {
      const L = this.level;
      const faces = findWallFaces(this.grid, {
        claimed: structureClaims(L).edges,
        boardEdgeIsExit: this.opts.boardEdgeIsExit ?? false,
      });
      this.walls = wallAnchors(L, this.grid, faces, this.opts.mountOf ?? (() => "half-cell"));
    }
    return this.walls;
  }

  private derive(kind: AnchorKind): readonly Anchor[] {
    const L = this.level;
    const g = this.grid;
    switch (kind) {
      case "face":
        return this.wallsOf().faces;
      case "opening":
        return this.wallsOf().openings;
      case "corner":
        return this.wallsOf().corners;
      case "storeyLine":
        return this.wallsOf().storeyLines;
      case "zone":
        return zoneAnchors(L, g);
      case "surface":
        return surfaceAnchors(L, g, this.opts.topOf ?? (() => null));
      case "point":
        return pointAnchors(L, g, this.opts.ceilingOf ?? (() => null));
      case "path":
        return pathAnchors(L, g);
      case "boundary":
        return boundaryAnchors(L, g);
    }
  }
}
