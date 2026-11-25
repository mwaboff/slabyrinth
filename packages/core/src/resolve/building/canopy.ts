/**
 * A building's canopy or awning over its street front (its design's `details`: "canopy", a slab two cells deep over
 * the front, its ends left open; "awning", tent cloth one cell deep over the whole front): the cells it covers, the
 * roles it is laid from and the height it is laid at. The one answer the building realizer lays it by
 * (compile/realize/structures/details.ts) and the overhead lines keep clear of (resolve/level/market.ts). A ruin has
 * none; faces against another building get none.
 */
import type { RoleName } from "../../contracts/compiler";
import type { ThemeId } from "../../contracts/plan";
import type { ResolvedStructure } from "../../contracts/resolved";
import type { PlanRoles } from "../../palette/planRoles";
import { SIDE_STEP } from "../../gen/gridGeometry";
import { defaultPartRole, floorRole, partRole, roofRole } from "../../palette/roles";
import { maxOf, minOf } from "../../util/lists";
import { faceCells, key, setOf, type FaceCell } from "../structureFaces";
import { PART_FALLBACK_FLOORS, PART_FALLBACK_KITS, partWalls } from "./parts";

/** The flat piece a canopy and a balcony borrow, then the floor they fall back to. */
export const BORROWED_FLAT: readonly RoleName[] = [
  roofRole(PART_FALLBACK_KITS.flat, "flat"),
  floorRole(PART_FALLBACK_FLOORS.tile),
];

/** What the canopy is read from: the building's cells, front, condition, design details and ground storey. */
export type CanopyHost = Pick<ResolvedStructure, "cells" | "frontage" | "condition"> & {
  readonly design?: { readonly details: readonly string[] } | undefined;
  readonly storeys: ReadonlyArray<
    Pick<ResolvedStructure["storeys"][number], "floorTop" | "footing" | "walls">
  >;
};

export interface FrontCanopy {
  readonly detail: "canopy" | "awning";
  /** The cells it covers ("x,y"). */
  readonly cells: ReadonlySet<string>;
  /** Roles its tiles are asked from, in order (the first the theme's palette resolves is laid). */
  readonly roles: readonly RoleName[];
  /** The underside of its tiles (absolute tiles). */
  readonly y: number;
}

/**
 * The building's canopies and awnings, in its details' order (none: no such detail, a ruin, or no ground storey).
 * `foreign`: the cells of the level's other buildings.
 */
export function frontCanopies(st: CanopyHost, foreign: ReadonlySet<string>): FrontCanopy[] {
  const d = st.design;
  const s0 = st.storeys[0];
  if (!d || !s0 || st.condition === "ruined") return [];
  return d.details
    .filter((x): x is "canopy" | "awning" => x === "canopy" || x === "awning")
    .map((detail) => canopyOf(st, s0, detail, foreign));
}

function canopyOf(
  st: CanopyHost,
  s0: CanopyHost["storeys"][number],
  detail: "canopy" | "awning",
  foreign: ReadonlySet<string>,
): FrontCanopy {
  const awning = detail === "awning";
  const front = st.frontage?.side ?? "S";
  const cells = setOf(st.cells);
  const free = (f: FaceCell): boolean => {
    const [dx, dy] = SIDE_STEP[f.face];
    return !foreign.has(key(f.x + dx, f.y + dy));
  };
  const run = faceCells(cells).filter((f) => free(f) && f.face === front);
  const [dx, dy] = SIDE_STEP[front];
  const along = (f: FaceCell): number => (front === "N" || front === "S" ? f.x : f.y);
  const lo = minOf(run.map(along));
  const hi = maxOf(run.map(along));
  const slab = new Set<string>();
  for (const f of run) {
    if (!awning && (along(f) === lo || along(f) === hi)) continue;
    for (const k of awning ? [1] : [1, 2]) {
      const c = key(f.x + dx * k, f.y + dy * k);
      if (!cells.has(c) && !foreign.has(c)) slab.add(c);
    }
  }
  const walls = partWalls(s0.walls, "details");
  return {
    detail,
    cells: slab,
    roles: awning
      ? [partRole("canopy", "awning")]
      : [partRole("canopy", walls), defaultPartRole("canopy"), ...BORROWED_FLAT],
    y: s0.floorTop + (awning ? 2 : (s0.footing?.height ?? 0) + 2.25),
  };
}

/**
 * The top of a canopy as built in `theme` (absolute tiles): its underside plus the thickest piece of the first of its
 * roles the theme's palette resolves (the role realize lays it from); null when none resolves (nothing is laid).
 */
export function canopyTop(c: FrontCanopy, roles: PlanRoles, theme: ThemeId): number | null {
  for (const role of c.roles) {
    const vs = roles.resolve(theme, role).resolution?.variants ?? [];
    if (vs.length > 0) return c.y + maxOf(vs.map((v) => v.geom.size.y));
  }
  return null;
}
