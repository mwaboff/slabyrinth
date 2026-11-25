/**
 * Realize, settle pass (generator 6, `unevenTops`): every thing set on a piece of furniture (a candle on an altar, a
 * hammer on an anvil, papers on a chest, goods on a stall's table) stands on the part of the top under it, at that
 * part's measured height (compile/restOn.ts, palette/restGrid.ts), and a thing over a part that cannot hold it (a
 * rounded lid's side, a horn, past an edge) moves to the nearest part that can. The resolver set it at the piece's one
 * rest height, before the piece's variant and turn were known; this pass reads both from the placement.
 *
 * A thing is on a support when its base is at the support's rest height and its outline over the support's box (the
 * support under most of it, when two are). Things
 * are settled lowest first, so a thing on a thing moves with what carries it. A support never measured (no grid) leaves
 * what stands on it where it is. Reads and writes: the level's feature placements and their boxes (`rebox`).
 */
import type { Placement } from "../../contracts/compiler";
import { featureInfo } from "../../gen/catalog";
import { restGridOf } from "../../palette/restGrid";
import { restTop } from "../../palette/restSurface";
import { restSpotAt, type PlacedSupport } from "../restOn";
import type { RealizeLevel } from "./level";

/** A base this close to a support's rest height was set on it (tiles). */
const SET_ON = 0.02;
/** A support's rest surface stands at least this high over its bottom (a rug's or a floor patch's does not). */
const RAISED = 0.15;
/** A thing set on something was lifted at least this far off its floor by the resolver. */
const LIFTED = 0.1;
/** A thing lifted to a support's top this far beside it was meant for it (tiles across the floor). */
const REACH = 0.5;

export function settleOnSupports(lv: RealizeLevel): void {
  const { ctx, placements, rebox } = lv;
  if (!ctx.profile.unevenTops) return;
  const { placed, turns } = ctx;
  // each feature with its name, collider, box and the world turn it was placed with (realize/level.ts emit)
  const items = placements
    .filter((p) => p.role === "feature")
    .flatMap((p) => {
      const info = placed.get(p);
      const cw = turns.get(p);
      return info && cw !== undefined ? [{ p, info, cw }] : [];
    });
  // supports by the whole cells their boxes cover (world x, z)
  const byCell = new Map<string, typeof items>();
  for (const it of items) {
    if (!restGridOf(it.p.asset, it.info.geom)) continue;
    const b = it.info.box;
    for (let x = Math.floor(b.min.x); x <= Math.floor(b.max.x); x++)
      for (let z = Math.floor(b.min.z); z <= Math.floor(b.max.z); z++) {
        const k = `${String(x)},${String(z)}`;
        const l = byCell.get(k);
        if (l) l.push(it);
        else byCell.set(k, [it]);
      }
  }
  const measured = ctx.profile.restSurfaces;
  // a thing is a resolved feature the resolver lifted off its floor to set it on something (not a piece of a stall or
  // an assembly, which stand on their own floor, nor an arrangement's piece, composed with its instance, nor one
  // fastened to a wall, hung from a ceiling or strung on a line)
  const features = new Map(lv.L.features.map((f) => [f.id, f]));
  // (what a line strung over the level carries hangs from it: compile/verify/lines.ts)
  const lines = new Set((lv.L.lines ?? []).map((ln) => ln.id));
  const loose = (p: Placement): boolean => {
    const f = features.get(p.source.elementId ?? "");
    return (
      f !== undefined &&
      !lines.has(f.id.split("#")[0] ?? "") &&
      f.wall === undefined &&
      featureInfo(f.type).ceilingMounted !== true &&
      f.baseHeight - lv.topOf(lv.V.cell(f.at[0], f.at[1])) >= LIFTED
    );
  };
  // what each thing was set on, found before anything moves
  const on = new Map<Placement, (typeof items)[number]>();
  for (const it of items) {
    if (!loose(it.p)) continue;
    const b = it.info.box;
    // the support under the most of the thing's outline, else the nearest one beside it (a thing set at a top's edge
    // may hang half off it, or wholly beside it)
    let best: (typeof items)[number] | undefined;
    let bestScore = -Infinity;
    const seen = new Set<(typeof items)[number]>();
    for (let x = Math.floor(b.min.x - REACH); x <= Math.floor(b.max.x + REACH); x++)
      for (let z = Math.floor(b.min.z - REACH); z <= Math.floor(b.max.z + REACH); z++)
        for (const q of byCell.get(`${String(x)},${String(z)}`) ?? []) {
          if (q === it || seen.has(q)) continue;
          seen.add(q);
          // an assembly's upper piece stands on its own lower piece by design
          if (q.p.source.elementId === it.p.source.elementId) continue;
          const qb = q.info.box;
          const top = restTop(q.p.asset, q.info.geom, qb, measured);
          // a raised top (a rug or a floor patch carries what stands on the floor beside it too)
          if (top - qb.min.y < RAISED || Math.abs(it.p.y - top) > SET_ON) continue;
          const ox = Math.min(b.max.x, qb.max.x) - Math.max(b.min.x, qb.min.x);
          const oz = Math.min(b.max.z, qb.max.z) - Math.max(b.min.z, qb.min.z);
          // overlap area when they overlap, else minus the gap between them
          const score =
            ox > 0 && oz > 0
              ? (ox * oz) / Math.max(1e-6, (b.max.x - b.min.x) * (b.max.z - b.min.z))
              : -Math.hypot(Math.max(0, -ox), Math.max(0, -oz));
          if (score < -REACH) continue;
          if (score > bestScore) {
            best = q;
            bestScore = score;
          }
        }
    if (best) on.set(it.p, best);
  }
  // lowest first: a support has settled before what stands on it
  const things = items.filter((it) => on.has(it.p)).sort((a, b) => a.p.y - b.p.y);
  for (const it of things) {
    const q = on.get(it.p);
    if (!q) continue;
    const support: PlacedSupport = {
      asset: q.p.asset,
      geom: q.info.geom,
      box: q.info.box,
      cw: q.cw,
    };
    const b = it.info.box;
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    const spot = restSpotAt(support, cx, cz);
    if (!spot) continue;
    // the move never carries the thing further past the support's box than it already reached (a long thing on a small
    // top would otherwise be pushed into the wall the support stands against); a thing held back short of the part
    // rests at that part's height, lying across it
    const qb = q.info.box;
    const dx = clampMove(spot.x - cx, b.min.x, b.max.x, qb.min.x, qb.max.x);
    const dz = clampMove(spot.z - cz, b.min.z, b.max.z, qb.min.z, qb.max.z);
    const dy = spot.y - it.p.y;
    if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6 && Math.abs(dy) < 1e-6) continue;
    it.p.x = round4(it.p.x + dx);
    it.p.y = round4(it.p.y + dy);
    it.p.z = round4(it.p.z + dz);
    rebox(it.p, {
      min: { x: b.min.x + dx, y: b.min.y + dy, z: b.min.z + dz },
      max: { x: b.max.x + dx, y: b.max.y + dy, z: b.max.z + dz },
    });
  }
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
