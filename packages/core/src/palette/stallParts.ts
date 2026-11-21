/**
 * The parts a covered market stall (generator 4) is built from, and the ONE answer to "can this theme build one?".
 *
 * Before this the resolver asked its own question of the bundled palettes (post, counter, canopy) and the compiler asked
 * another of the palettes it was given (base, counter, post, canopy, and a one-cell tile filter on two of them), so the
 * two could disagree: the resolver laid out a 3x3 covered stall (and skipped its goods and the lines past it) and the
 * compiler found a part missing and put a table on the footprint. Both stages now call `stallParts` / `coveredStallForms`
 * with a `RoleProbe` over the palettes they hold, and `resolve/` is handed the compiler's palettes through its
 * `PaletteView` (palette/view.ts), so they ask the same question of the same palettes.
 */
import type { ThemeId } from "../contracts/plan";
import type { StallForm } from "../contracts/resolved";
import type { ResolvedVariant, RoleResolution, VariantFilter } from "./resolve";

/** Resolves the first of `roles` the theme can supply (variants passing `filter`), or null. The theme is bound by the caller. */
export type RoleProbe = (roles: readonly string[], filter?: VariantFilter) => RoleResolution | null;

/** The probe over a role resolver (palette/resolve.ts `createRoleResolver`) for one theme. */
export function roleProbe(
  resolve: (theme: ThemeId, role: string, filter?: VariantFilter) => { resolution: RoleResolution | null },
  theme: ThemeId,
): RoleProbe {
  return (roles, filter) => {
    for (const role of roles) {
      const r = resolve(theme, role, filter).resolution;
      if (r) return r;
    }
    return null;
  };
}

/** A 1x1 tile standing on its cell (the platform and the counter blocks). */
export const ONE_CELL_TILE: VariantFilter = {
  key: "tile1x1",
  test: (v) => v.footprint[0] === 1 && v.footprint[1] === 1 && v.geom.originAt === "minCorner",
};

export const STALL_FORMS: readonly StallForm[] = ["gable", "flat"];

/** Where each part of a stall comes from: the roles tried in order, and the variants that qualify. */
export const STALL_PART_SPECS = {
  base: { roles: ["stall.base", "floor.wood_plank"], filter: ONE_CELL_TILE },
  counter: { roles: ["stall.counter"], filter: ONE_CELL_TILE },
  post: { roles: ["stall.post"], filter: undefined },
  canopy: (form: StallForm): { roles: string[]; filter: VariantFilter } => ({
    roles: ["stall.canopy"],
    filter: { key: `form:${form}`, test: (v: ResolvedVariant) => v.variant === form },
  }),
} as const;

export interface StallParts {
  base: RoleResolution;
  counter: RoleResolution;
  post: RoleResolution;
  canopy: RoleResolution;
}

/**
 * The theme's own resolution of the first role in the chain that exists, then only the variants that qualify. The filter
 * is applied HERE, not inside the probe: a filtered lookup that finds nothing in the theme's role would go on to the
 * generic theme's definition of it and hand a city stall a gable cloth the city palette never listed (it lists flat only).
 */
function part(
  probe: RoleProbe,
  roles: readonly string[],
  filter: VariantFilter | undefined,
): RoleResolution | null {
  const r = probe(roles);
  if (!r) return null;
  const variants = filter ? r.variants.filter(filter.test) : r.variants;
  return variants.some((v) => v.weight > 0) ? { ...r, variants } : null;
}

/** The parts of a stall of `form`, or the name of the first part the palette lacks. */
export function stallParts(
  probe: RoleProbe,
  form: StallForm,
): StallParts | { missing: "base" | "counter" | "post" | "canopy" } {
  const base = part(probe, STALL_PART_SPECS.base.roles, STALL_PART_SPECS.base.filter);
  if (!base) return { missing: "base" };
  const counter = part(probe, STALL_PART_SPECS.counter.roles, STALL_PART_SPECS.counter.filter);
  if (!counter) return { missing: "counter" };
  const post = part(probe, STALL_PART_SPECS.post.roles, STALL_PART_SPECS.post.filter);
  if (!post) return { missing: "post" };
  const c = STALL_PART_SPECS.canopy(form);
  const canopy = part(probe, c.roles, c.filter);
  if (!canopy) return { missing: "canopy" };
  return { base, counter, post, canopy };
}

/** The canopy forms a theme can build a covered stall in (none = the table stall of generator 3). */
export function coveredStallForms(probe: RoleProbe): StallForm[] {
  return STALL_FORMS.filter((form) => "base" in stallParts(probe, form));
}
