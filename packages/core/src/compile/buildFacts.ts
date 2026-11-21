/**
 * What realize builds from and verify measures by, worked out once per build: the role answers (palette/planRoles.ts:
 * the plan's generator, theme fallback and default theme) and, per level, the read-only grid (with that default theme),
 * the reference floor heights, the edges buildings build themselves and the wall faces.
 *
 * Realize makes it (compile/realize/context.ts) and the realized set carries it (`RealizedSet.facts`); verify reads the
 * set's facts, so it judges the walls realize built by the same faces and the same pieces. A set realized for another
 * resolved plan, or built elsewhere, has none: verify then makes its own with the same function, from the palettes it
 * is given.
 */
import type { LevelId } from "../contracts/plan";
import type { ResolvedLevel, ResolvedPlan } from "../contracts/resolved";
import type { PlanRoles } from "../palette/planRoles";
import type { GeneratorProfile } from "../plan/generator";
import { LevelGrid } from "../resolve/levelGrid";
import { findWallFaces, type WallFaces } from "../resolve/wallFaces";
import { areaReferenceHeights } from "../resolve/wallspan";
import { structureClaims } from "./structure";

/** One level's facts (built on first ask). */
export interface LevelFacts {
  /** The resolved level's cells and edges, read-only, in plan coordinates, with the build's default theme. */
  readonly grid: LevelGrid;
  /** Reference floor height of each area (resolve/wallspan.ts), for wall spans. */
  readonly refHeights: ReadonlyMap<number, number>;
  /** Edges and openings buildings build themselves (compile/structure.ts): the wall passes leave them alone. */
  readonly claims: ReturnType<typeof structureClaims>;
  /** Every wall and opening edge with its host, mass cell, style, theme and span (resolve/wallFaces.ts). */
  readonly faces: WallFaces;
}

export class BuildFacts {
  private readonly grids = new Map<LevelId, LevelGrid>();
  private readonly levels = new Map<LevelId, LevelFacts>();

  constructor(
    readonly resolved: ResolvedPlan,
    /** The role answers realize builds from and verify judges by. */
    readonly roles: PlanRoles,
    readonly profile: GeneratorProfile,
  ) {}

  /** The grid of any level of the plan (links read the level above), undefined for an unknown id. */
  grid(levelId: LevelId): LevelGrid | undefined {
    let g = this.grids.get(levelId);
    if (!g) {
      const L = this.resolved.levels.find((l) => l.id === levelId);
      if (!L) return undefined;
      g = new LevelGrid(L, this.roles.defaultTheme);
      this.grids.set(levelId, g);
    }
    return g;
  }

  /** The facts of a level of this plan. */
  of(L: ResolvedLevel): LevelFacts {
    let f = this.levels.get(L.id);
    if (!f) {
      const grid = this.grid(L.id);
      if (!grid) throw new Error(`BuildFacts: level ${L.id} is not a level of plan ${this.resolved.planId}`);
      const refHeights = areaReferenceHeights(L);
      const claims = structureClaims(L);
      const faces = findWallFaces(grid, {
        claimed: claims.edges,
        refHeights,
        boardEdgeIsExit: this.profile.boardEdgeExits,
      });
      f = { grid, refHeights, claims, faces };
      this.levels.set(L.id, f);
    }
    return f;
  }
}
