/**
 * Realize, a structure as its builders see it (compile/realize/structures/*): the level (`RealizeLevel`: the grid,
 * `emit` and the plan-wide context), the structure and its role lookup, plus the few readers every builder shares.
 * Reads: the level and the structure. Writes: nothing itself; `lookup` writes the build's role diagnostics (through the
 * plan-wide `lookup`) and a building's style notes (info `structure_style_fallback`).
 */
import type { CompileDiagnostic, RoleName } from "../../../contracts/compiler";
import type { ThemeId } from "../../../contracts/plan";
import type { ResolvedStructure } from "../../../contracts/resolved";
import type { RoleResolution, VariantFilter } from "../../../palette/resolve";
import { isSettingKitRole } from "../../../gen/wallStyles";
import { GENERIC_THEME } from "../../../palette/resolve";
import { isStyleLookRole } from "../../../palette/roles";
import { structureStyle } from "../../../resolve/structureStyles";
import { hashUnitUtf16 } from "../../../util/hash";
import type { RealizeLevel } from "../level";

/** A structure's role lookup: the first of `roles` its theme's palette resolves (quiet: no role_missing warning). */
export type StructureLookup = (
  roles: readonly RoleName[],
  filter?: VariantFilter,
  quiet?: boolean,
) => RoleResolution | null;

export interface StructureCtx {
  readonly lv: RealizeLevel;
  readonly st: ResolvedStructure;
  /** The structure's theme: every part of it is asked in this theme. */
  readonly theme: ThemeId;
  readonly lookup: StructureLookup;
}

/** The plan-wide lookup, asked in the structure's theme on this level. */
const themeLookup =
  (lv: RealizeLevel, st: ResolvedStructure): StructureLookup =>
  (roles, filter, quiet) =>
    lv.ctx.lookup(lv.L.id, st.theme, [...roles], filter, quiet);

/** An enclosure's context: the plain lookup in its theme. */
export function enclosureCtx(lv: RealizeLevel, st: ResolvedStructure): StructureCtx {
  return { lv, st, theme: st.theme, lookup: themeLookup(lv, st) };
}

/**
 * A building's context. Its lookup keeps to the style's era: a style that declares which palette rows it accepts (its
 * own role families, or rows owned by its themes) never borrows a piece from another era's kit (a missing piece is left
 * out and named instead). And it notes, once per building and role, when a role the style's look depends on
 * (palette/roles.ts `isStyleLookRole`) is missing in the theme and the chain falls back to another role (a modern block
 * drawn with a town door).
 */
export function buildingCtx(lv: RealizeLevel, st: ResolvedStructure): StructureCtx {
  const base = ownWallsFirst(lv, st, themeLookup(lv, st));
  const seen = new Set<string>();
  const era = structureStyle(st.style)?.era;
  const eraRoles = era?.roles.map((p) => new RegExp(p));
  const accepts = (r: RoleResolution): boolean =>
    !era || era.themes.includes(r.paletteId) || (eraRoles ?? []).some((re) => re.test(r.role));
  const eraLookup = (roles: readonly RoleName[], filter?: VariantFilter): RoleResolution | null => {
    for (const role of roles) {
      const r = base([role], filter, true);
      if (!r) continue;
      if (accepts(r)) return r;
      if (!seen.has(`era:${r.role}`)) {
        seen.add(`era:${r.role}`);
        info(
          lv,
          "structure_style_fallback",
          `${st.id} (style ${st.style}): "${r.role}" in theme "${st.theme}" is not a piece of this style's era; left out`,
          r.role,
        );
      }
    }
    return null;
  };
  const lookup: StructureLookup = (roles, filter, quiet) => {
    const r = era ? eraLookup(roles, filter) : base(roles, filter, quiet);
    const want = roles[0];
    const suffix = want?.split(".").pop() ?? "";
    // another role of the same style (facade.stone → wall.stone) is the same look: not a fallback
    const same = r !== null && r.role.endsWith(`.${suffix}`);
    if (want && roles.length > 1 && isStyleLookRole(want) && r?.role !== want && !same && !seen.has(want)) {
      seen.add(want);
      // only when the preferred role has no piece at all in the theme (not just none of this length)
      if (base([want], undefined, true) === null)
        info(
          lv,
          "structure_style_fallback",
          `${st.id} (style ${st.style}): theme "${st.theme}" has no "${want}" piece; built with ${r ? `"${r.role}"` : "nothing"} instead`,
          want,
        );
    }
    return r;
  };
  return { lv, st, theme: st.theme, lookup };
}

/**
 * Generator 5 (`ownWallsFirst`): a kept-up building's lookup that passes over a role of a setting-kit style (gen/
 * wallStyles.ts `settingKit`) its theme only borrows from the generic palette, so the chain goes on to the theme's own
 * wall or post. A weathered or ruined building keeps the borrowed kit (an abandoned village's planks suit it).
 */
const OPENING_ROLE = /^(window|opening|door)\b/;

function ownWallsFirst(lv: RealizeLevel, st: ResolvedStructure, base: StructureLookup): StructureLookup {
  if (!lv.ctx.profile.ownWallsFirst || st.theme === GENERIC_THEME || (st.condition ?? "intact") !== "intact")
    return base;
  return (roles, filter, quiet) => {
    let passed = false;
    for (const role of roles) {
      const r = base([role], filter, true);
      if (!r) continue;
      // (asked for the kit's style: what the generic palette answers, its own fallback role included, is borrowed;
      // openings keep their chain: a window or door the theme lacks is better borrowed than missing)
      if (r.paletteId === GENERIC_THEME && isSettingKitRole(role) && !OPENING_ROLE.test(role)) {
        passed = true;
        continue;
      }
      return r;
    }
    // nothing but borrowed kit: none (the caller builds without it); nothing at all: the chain's own diagnostics
    return passed ? null : base(roles, filter, quiet);
  };
}

/** An info diagnostic of this level. */
export function info(
  lv: RealizeLevel,
  code: CompileDiagnostic["code"],
  message: string,
  role?: string,
): void {
  lv.ctx.addDiag({ severity: "info", code, message, levelId: lv.L.id, ...(role ? { role } : {}) });
}

/** Absolute floor top of a plan cell (the level grid's); the level's floor top outside the level. */
export function groundTop(lv: RealizeLevel, x: number, y: number): number {
  const c = lv.V.cell(x, y);
  return c.open ? lv.topOf(c) : lv.elev + 0.5;
}

/**
 * A weathered or ruined building whose condition the generator makes legible (generator 3, `legibleCondition`): its
 * porch roofs fall, its debris is of its own material and lies at its own angles, and the rubble on its broken walls
 * lies along them. (The resolver gives exactly these buildings a growth level.)
 */
export const legiblyWorn = (b: StructureCtx): boolean =>
  b.lv.ctx.profile.legibleCondition && (b.st.condition ?? "intact") !== "intact";

/** Deterministic 0..1 from a key (build-time choices: lit windows, clutter). */
export const unit01 = (lv: RealizeLevel, k: string): number => hashUnitUtf16(lv.ctx.seed, k);
