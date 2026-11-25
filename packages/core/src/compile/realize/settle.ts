/**
 * Realize, settle pass (generator 6, `unevenTops`): every thing set on a piece of furniture (a candle on an altar, a
 * hammer on an anvil, papers on a chest, goods on a stall's table) stands on the part of the top under it, at that
 * part's measured height (compile/restOn.ts, palette/restGrid.ts), and a thing over a part that cannot hold it (a
 * rounded lid's side, a horn, past an edge) moves to the nearest part that can. The resolver set it at its support's
 * highest rest among the role's variants, before the support's variant and turn were known; this pass reads both from
 * the placement.
 *
 * What a thing stands on is the support relation the resolver made, not a height: every placer sets a thing on one of
 * its support's own cells (gen/rooms4/things.ts addToppers, lights.ts, groups.ts, regimes.ts), so a thing's support is
 * a raised piece of another feature whose footprint holds the thing's cell and whose height range (its bottom to its box
 * top and the spread of its role's variants) holds the thing's base: of those, the one whose rest is nearest the base,
 * then the one under most of the thing's outline, else the nearest beside it. Things are settled lowest first, so a
 * thing on a thing moves with what carries it: on a support never measured (no grid) it is carried by the support's own
 * move and set on its final top. Reads and writes: the level's feature placements and their boxes (`rebox`).
 */
import type { Placement } from "../../contracts/compiler";
import type { ResolvedFeature } from "../../contracts/resolved";
import { featureInfo, isBandRock } from "../../gen/catalog";
import { restTop } from "../../palette/restSurface";
import { restSpotAt } from "../restOn";
import type { RealizeLevel } from "./level";

/** A support's rest surface stands at least this high over its bottom (a rug's or a floor patch's does not). */
const RAISED = 0.15;
/** A thing set on something was lifted at least this far off its floor by the resolver. */
const LIFTED = 0.1;
/** A thing set beside its support's top at most this far is still set on it (tiles across the floor). */
const REACH = 0.5;
/**
 * On a support with no grid, a thing is set on its final top only when that is at most this far from where the
 * resolver set it: the resolver lifts to the highest of a role's variants and accepts variants up to 0.15 apart
 * (gen/rooms4/recipes.ts ROOM_DRESS.heightSpread); further off, the thing was meant for another surface.
 */
const VARIANT_SPREAD = 0.2;
/** A band rock whose base is this close to a rock's rest height was piled on it (tiles). */
const PILED_ON = 0.02;

export function settleOnSupports(lv: RealizeLevel): void {
  const { ctx, placements, rebox } = lv;
  if (!ctx.profile.unevenTops) return;
  const { placed, turns } = ctx;
  const measured = ctx.profile.restSurfaces;
  // each feature with its name, collider, box and the world turn it was placed with (realize/level.ts emit)
  const items = placements
    .filter((p) => p.role === "feature")
    .flatMap((p) => {
      const info = placed.get(p);
      const cw = turns.get(p);
      return info && cw !== undefined ? [{ p, info, cw }] : [];
    });
  type Item = (typeof items)[number];
  const features = new Map(lv.L.features.map((f) => [f.id, f]));
  // each feature's raised pieces (a rug or a floor patch carries nothing set on it)
  const raised = new Map<string, Item[]>();
  for (const it of items) {
    const id = it.p.source.elementId ?? "";
    const qb = it.info.box;
    if (!features.has(id) || restTop(it.p.asset, it.info.geom, qb, measured) - qb.min.y < RAISED) continue;
    const l = raised.get(id);
    if (l) l.push(it);
    else raised.set(id, [it]);
  }
  // the features over each cell, by their footprints (plan cells)
  const byCell = new Map<string, ResolvedFeature[]>();
  for (const f of lv.L.features) {
    if (!raised.has(f.id)) continue;
    for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++)
      for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++) {
        const k = `${String(x)},${String(y)}`;
        const l = byCell.get(k);
        if (l) l.push(f);
        else byCell.set(k, [f]);
      }
  }
  // a thing is a resolved feature the resolver lifted off its floor to set it on something (not a piece of a stall or
  // an assembly, which stand on their own floor, nor an arrangement's piece, composed with its instance, nor one
  // fastened to a wall, hung from a ceiling or strung on a line)
  // (what a line strung over the level carries hangs from it: compile/verify/lines.ts)
  const lines = new Set((lv.L.lines ?? []).map((ln) => ln.id));
  const looseFeature = (p: Placement): ResolvedFeature | undefined => {
    const f = features.get(p.source.elementId ?? "");
    return f !== undefined &&
      !lines.has(f.id.split("#")[0] ?? "") &&
      f.wall === undefined &&
      featureInfo(f.type).ceilingMounted !== true &&
      f.baseHeight - lv.topOf(lv.V.cell(f.at[0], f.at[1])) >= LIFTED
      ? f
      : undefined;
  };
  // what each thing was set on, found before anything moves
  const on = new Map<Placement, Item>();
  for (const it of items) {
    const f = looseFeature(it.p);
    if (!f) continue;
    const base = it.p.y;
    const pieces = isBandRock(f.type)
      ? // a rock of a cliff band or a crest is piled by its recipe (gen/cliffband.ts, gen/water.ts) at the rest height
        // of the rock under it, wherever their cells lie: that height is the relation
        [...raised.entries()]
          .filter(([id]) => id !== f.id)
          .flatMap(([, l]) => l)
          .filter((q) => Math.abs(base - restTop(q.p.asset, q.info.geom, q.info.box, measured)) <= PILED_ON)
      : // the raised pieces of the other features whose footprint holds the thing's cell, of those whose height the
        // thing was set within (above the piece's bottom, no higher than its box top and the variants' spread: a jar on
        // a shelf plank over a table stands on the plank, a candle on a crate stacked on a crate on the upper crate)
        (byCell.get(`${String(f.at[0])},${String(f.at[1])}`) ?? [])
          .filter((g) => g.id !== f.id)
          .flatMap((g) => raised.get(g.id) ?? [])
          .filter(
            (q) => base >= q.info.box.min.y + RAISED - 0.01 && base <= q.info.box.max.y + VARIANT_SPREAD,
          );
    const best = pieceUnder(it.info.box, pieces, (q) =>
      Math.abs(base - restTop(q.p.asset, q.info.geom, q.info.box, measured)),
    );
    if (best) on.set(it.p, best);
  }
  // lowest first: a support has settled before what stands on it; each thing's move, for what stands on it
  const moves = new Map<Placement, { dx: number; dy: number; dz: number }>();
  const things = items.filter((it) => on.has(it.p)).sort((a, b) => a.p.y - b.p.y);
  for (const it of things) {
    const q = on.get(it.p);
    if (!q) continue;
    const b = it.info.box;
    const qb = q.info.box;
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    const spot = restSpotAt({ asset: q.p.asset, geom: q.info.geom, box: qb, cw: q.cw }, cx, cz);
    let move: { dx: number; dy: number; dz: number };
    if (spot) {
      // the move never carries the thing further past the support's box than it already reached (a long thing on a
      // small top would otherwise be pushed into the wall the support stands against); a thing held back short of the
      // part rests at the height of the part nearest where it ends (lying across it when its outline reaches it), the
      // part verify reads there (compile/restOn.ts surfaceTopAt)
      const dx = clampMove(spot.x - cx, b.min.x, b.max.x, qb.min.x, qb.max.x);
      const dz = clampMove(spot.z - cz, b.min.z, b.max.z, qb.min.z, qb.max.z);
      const there = restSpotAt({ asset: q.p.asset, geom: q.info.geom, box: qb, cw: q.cw }, cx + dx, cz + dz);
      move = { dx, dy: (there ?? spot).y - it.p.y, dz };
    } else {
      // a support with no grid: carried by its move, set on its final top (its box is already where it moved to)
      const carried = moves.get(q.p) ?? { dx: 0, dy: 0, dz: 0 };
      const onTop = restTop(q.p.asset, q.info.geom, qb, measured) - it.p.y;
      // (how far its final top is from where the support's move alone would carry the thing: its variant's difference)
      const dy = Math.abs(onTop - carried.dy) <= VARIANT_SPREAD ? onTop : carried.dy;
      move = { dx: carried.dx, dy, dz: carried.dz };
    }
    const { dx, dy, dz } = move;
    if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6 && Math.abs(dy) < 1e-6) continue;
    moves.set(it.p, move);
    it.p.x = round4(it.p.x + dx);
    it.p.y = round4(it.p.y + dy);
    it.p.z = round4(it.p.z + dz);
    rebox(it.p, {
      min: { x: b.min.x + dx, y: b.min.y + dy, z: b.min.z + dz },
      max: { x: b.max.x + dx, y: b.max.y + dy, z: b.max.z + dz },
    });
  }
}

/**
 * Of the candidate pieces, the one whose top is nearest where the thing was set (`off`), and of those the one under the
 * most of the thing's outline `b`, else the nearest beside it within REACH (a thing set at a top's edge may hang half
 * off it, or wholly beside it); undefined when none is that near.
 */
function pieceUnder<
  T extends { info: { box: { min: { x: number; z: number }; max: { x: number; z: number } } } },
>(
  b: { min: { x: number; z: number }; max: { x: number; z: number } },
  pieces: readonly T[],
  off: (q: T) => number,
): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  let bestOff = Infinity;
  for (const q of pieces) {
    const qb = q.info.box;
    const ox = Math.min(b.max.x, qb.max.x) - Math.max(b.min.x, qb.min.x);
    const oz = Math.min(b.max.z, qb.max.z) - Math.max(b.min.z, qb.min.z);
    // overlap area when they overlap, else minus the gap between them
    const score =
      ox > 0 && oz > 0
        ? (ox * oz) / Math.max(1e-6, (b.max.x - b.min.x) * (b.max.z - b.min.z))
        : -Math.hypot(Math.max(0, -ox), Math.max(0, -oz));
    if (score < -REACH) continue;
    const o = off(q);
    if (o < bestOff - 0.01 || (Math.abs(o - bestOff) <= 0.01 && score > bestScore)) {
      best = q;
      bestScore = score;
      bestOff = Math.min(o, bestOff);
    }
  }
  return best;
}

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/**
 * A move `d` of a thing spanning [lo, hi] along one axis, held so the thing ends no further out than the larger of its
 * own span and its support's [slo, shi].
 */
function clampMove(d: number, lo: number, hi: number, slo: number, shi: number): number {
  const min = Math.min(lo, slo) - lo;
  const max = Math.max(hi, shi) - hi;
  return Math.min(max, Math.max(min, d));
}
