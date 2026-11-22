/**
 * The theme-wide pool of pieces of a shape: "this theme's thin long pieces about two tiles long", across every role the
 * theme's palette lists, so a builder (the motif layer) can borrow a piece for its shape without naming a role. Builds
 * ask it through `PlanRoles.pool` (palette/planRoles.ts), which hides later generators' roles and memoizes.
 *
 * The rules:
 *   - shape: the piece passes `traitFilter(query)` (palette/filters.ts over palette/traits.ts);
 *   - chain: the palettes of the theme's chain (itself, its `extends`, then `generic`) are asked in order and the first
 *     with any piece of the shape supplies the whole pool, so a theme's own pieces win and generic is the last resort,
 *     the same order a role falls back in. Pieces are never mixed across palettes in one pool;
 *   - roles: a palette's own roles, those the generator sees (`minGenerator`), aliases (no variants) skipped;
 *   - availability: a variant the game lacks is replaced by its alternate or skipped, as in role resolution;
 *   - borrow risk: a piece any role of the chain lists as a door, stairs, light, GM-only or marker piece is left out,
 *     unless the query allows that risk (`allow`). Assembly variants (`parts`) are left out: their geometry is only the
 *     base asset's;
 *   - order: role names in code-unit order, then the role's variant order; an asset listed by several roles is one
 *     piece (its first listing), with every role named. The order is a pure function of the palette data.
 * A pick from a pool (`pickFromPool`) is uniform over its distinct pieces and named by hash parts, so it is stable across
 * runs and seedable. Role weights are not used: they say how often a role shows a piece, not how good a borrow it is.
 */
import type { PaletteRole, RoleName } from "../contracts/compiler";
import type { ThemeId } from "../contracts/plan";
import { hashUnit } from "../util/hash";
import { own } from "../util/own";
import { traitFilter } from "./filters";
import { themeChain, usableVariants, type ResolvedVariant, type ResolvePalettes } from "./resolve";
import {
  borrowRisk,
  measurePiece,
  shapeKey,
  type BorrowRisk,
  type PieceMeasures,
  type TraitShape,
} from "./traits";

/** A shape to pool, and which borrow risks the caller accepts (none by default). */
export interface TraitQuery extends TraitShape {
  readonly allow?: readonly BorrowRisk[];
}

/** One piece of a pool. */
export interface TraitPiece {
  /** The variant as role resolution would hand it (uuid after availability, geometry, correction rot and offset). */
  readonly variant: ResolvedVariant;
  /** The roles of the supplying palette that list the asset, in pool order (the first supplied `variant`). */
  readonly roles: readonly RoleName[];
  readonly measures: PieceMeasures;
}

export interface TraitPool {
  /** The query's memo key (also the hash namespace of `pickFromPool`). */
  readonly key: string;
  /** The palette that supplied the pieces, or null when no palette of the chain has the shape. */
  readonly paletteId: ThemeId | null;
  /** The palettes asked, in order, up to the supplying one. */
  readonly path: readonly ThemeId[];
  readonly pieces: readonly TraitPiece[];
}

/** The memo key of a query: its shape key and its allowed risks in name order. */
export function traitQueryKey(query: TraitQuery): string {
  const allow = [...new Set(query.allow ?? [])].sort();
  return allow.length > 0 ? `${shapeKey(query)}+allow:${allow.join(",")}` : shapeKey(query);
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The pool of `query` in `theme` (asked as is: a theme with no palette walks generic only; `PlanRoles.pool` first maps
 * it to the catalog's default theme). `generator` hides roles introduced after it; omitted, every role is visible.
 */
export function traitPool(
  cat: ResolvePalettes,
  theme: ThemeId,
  query: TraitQuery,
  generator?: number,
): TraitPool {
  const key = traitQueryKey(query);
  const chain = themeChain(cat.palettes, theme);
  const visibleRoles = (id: ThemeId): [RoleName, PaletteRole][] => {
    const roles = own(cat.palettes, id)?.roles;
    return Object.keys(roles ?? {})
      .sort(byCodeUnit)
      .flatMap((r): [RoleName, PaletteRole][] => {
        const def = own(roles, r);
        return def !== undefined && (generator === undefined || (def.minGenerator ?? 1) <= generator)
          ? [[r, def]]
          : [];
      });
  };

  // assets some role of the chain lists with a risk the query does not accept
  const allowed = new Set(query.allow ?? []);
  const risky = new Set<string>();
  for (const id of chain) {
    for (const [role, def] of visibleRoles(id)) {
      const risk = borrowRisk(role);
      if (risk === null || allowed.has(risk)) continue;
      for (const v of def.variants) {
        risky.add(v.asset.toLowerCase());
        for (const alt of v.alternates ?? []) risky.add(alt.toLowerCase());
      }
    }
  }

  const fits = traitFilter(query);
  const path: ThemeId[] = [];
  for (const id of chain) {
    path.push(id);
    const pieces = new Map<string, { variant: ResolvedVariant; roles: RoleName[] }>();
    for (const [role, def] of visibleRoles(id)) {
      for (const v of usableVariants(def, role, cat, [])) {
        if (v.parts !== undefined || risky.has(v.uuid) || risky.has(v.wanted) || !fits.test(v)) continue;
        const seen = pieces.get(v.uuid);
        if (seen === undefined) pieces.set(v.uuid, { variant: v, roles: [role] });
        else if (!seen.roles.includes(role)) seen.roles.push(role);
      }
    }
    if (pieces.size > 0) {
      return {
        key,
        paletteId: id,
        path,
        pieces: [...pieces.values()].map((p) => ({ ...p, measures: measurePiece(p.variant.geom) })),
      };
    }
  }
  return { key, paletteId: null, path, pieces: [] };
}

/**
 * A piece of the pool, uniform over its pieces and named by `parts` (a seed and what the piece is for:
 * `pickFromPool(pool, seed, "rail", i)`); undefined for an empty pool. The same pool and parts always give the same piece.
 */
export function pickFromPool(
  pool: TraitPool,
  ...parts: ReadonlyArray<string | number>
): TraitPiece | undefined {
  if (pool.pieces.length === 0) return undefined;
  return pool.pieces[Math.floor(hashUnit(pool.key, ...parts) * pool.pieces.length)];
}
