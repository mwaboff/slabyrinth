/**
 * What every verify check reads: the plan-wide inputs (`VerifyCtx`, built once by `createVerifyCtx`) and the one
 * writer of diagnostics (`VerifyReport`). A check never writes the context; what it finds for a later check is returned
 * and passed on by verify.ts (see the table there).
 */
import type { CompileDiagnostic, PaletteCatalog, PlacementSet } from "../../contracts/compiler";
import type { LevelId } from "../../contracts/plan";
import type { ResolvedFeature, ResolvedLevel, ResolvedPlan } from "../../contracts/resolved";
import { createRoleResolver } from "../../palette/resolve";
import { generatorProfile, type GeneratorProfile } from "../../plan/generator";
import { LevelGrid } from "../../resolve/levelGrid";
import { findWallFaces, type WallFaces } from "../../resolve/wallFaces";
import { areaReferenceHeights } from "../../resolve/wallspan";
import { structureClaims } from "../structure";
import type { VerifyOptions } from "./options";

/** A diagnostic as a check writes it (the stage is added by the report). */
export type Diag = Omit<CompileDiagnostic, "stage">;

/** The diagnostics in the order the checks emit them, and the number of repairs made. */
export class VerifyReport {
  readonly diagnostics: CompileDiagnostic[] = [];
  repairs = 0;

  add(d: Diag): void {
    this.diagnostics.push({ ...d, stage: "verify" });
  }
}

/** The walls of one level as realize builds them. */
export interface LevelWalls {
  /** Edges a building builds itself (compile/structure.ts). */
  readonly claims: ReturnType<typeof structureClaims>;
  /** Every wall and opening edge with its host, mass cell, style, theme and span (resolve/wallFaces.ts). */
  readonly faces: WallFaces;
}

export interface VerifyCtx {
  readonly resolved: ResolvedPlan;
  /** The build being checked. Repairs (dropped placements, nudged props) write it; nothing else does. */
  readonly set: PlacementSet;
  readonly opts: VerifyOptions;
  readonly profile: GeneratorProfile;
  /** Apply safe repairs (VerifyOptions.repair). */
  readonly repair: boolean;
  /** The resolved levels the build places (in resolved order). */
  readonly levels: readonly ResolvedLevel[];
  readonly levelOf: ReadonlyMap<LevelId, ResolvedLevel>;
  readonly grids: ReadonlyMap<LevelId, LevelGrid>;
  /** The wall check and the wall-style note read the same faces. */
  readonly walls: ReadonlyMap<LevelId, LevelWalls>;
  readonly resolveRole: ReturnType<typeof createRoleResolver>;
  /** `role_missing` diagnostics realize already wrote, as "level|element|role". */
  readonly reportedMissing: ReadonlySet<string>;
  /** Levels realize reported a missing floor.* role on: their missing floors are warnings, not errors. */
  readonly floorRoleMissing: ReadonlySet<string>;
  readonly report: VerifyReport;
  /** The resolved feature a placement belongs to (by level and element id). */
  featureOf(levelId: LevelId, elementId: string | undefined): ResolvedFeature | undefined;
}

export function createVerifyCtx(
  resolved: ResolvedPlan,
  set: PlacementSet,
  palettes: PaletteCatalog,
  opts: VerifyOptions,
): VerifyCtx {
  const profile = generatorProfile(resolved);
  const levels = resolved.levels.filter((l) => set.levels.some((s) => s.levelId === l.id));
  const grids = new Map(levels.map((l) => [l.id, new LevelGrid(l)]));
  const walls = new Map(
    levels.map((l) => {
      const claims = structureClaims(l);
      const faces = findWallFaces(grids.get(l.id) ?? new LevelGrid(l), {
        claimed: claims.edges,
        refHeights: areaReferenceHeights(l),
        boardEdgeIsExit: profile.boardEdgeExits,
      });
      return [l.id, { claims, faces }] as const;
    }),
  );
  const featureById = new Map<string, ResolvedFeature>();
  for (const l of levels) for (const f of l.features) featureById.set(`${l.id}|${f.id}`, f);
  const missing = set.diagnostics.filter((d) => d.code === "role_missing");
  return {
    resolved,
    set,
    opts,
    profile,
    repair: opts.repair ?? true,
    levels,
    levelOf: new Map(levels.map((l) => [l.id, l])),
    grids,
    walls,
    resolveRole: createRoleResolver(palettes),
    reportedMissing: new Set(missing.map((d) => `${d.levelId ?? ""}|${d.elementId ?? ""}|${d.role ?? ""}`)),
    floorRoleMissing: new Set(
      missing.filter((d) => (d.role ?? "").startsWith("floor.")).map((d) => d.levelId ?? ""),
    ),
    report: new VerifyReport(),
    featureOf: (levelId, elementId) => featureById.get(`${levelId}|${elementId ?? ""}`),
  };
}
