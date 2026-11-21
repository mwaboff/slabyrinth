/**
 * Realize, link passes: step and stair pieces on stair edges within a level (EDGE.STAIR), and the links between
 * levels (stair flights and ramps, vertical ladders and spiral stairs, trapdoor hatches).
 * Reads: the level's edges and cells, the plan's links, the view of the level above. Writes: link placements (and
 * fill under flights and landings, through stackFill); a diagnostic for a vertical link built from a stand-in piece.
 */
import type { Placement } from "../../contracts/compiler";
import type { Side, ThemeId } from "../../contracts/plan";
import { EDGE, type ResolvedPlan } from "../../contracts/resolved";
import type { ResolvedVariant } from "../../palette/resolve";
import { SIDES } from "../../gen/gridGeometry";
import type { EdgeOrient } from "../../resolve/levelGrid";
import { rotateXZ } from "../geometry";
import { stackFill } from "./fill";
import { isCliffGround } from "../../resolve/materials";
import { EPS, type RealizeLevel } from "./level";

// stairs (EDGE.STAIR): a stair piece in the lower cell climbing toward the higher one
export function layStairEdges(lv: RealizeLevel): void {
  const { L, V, topOf, emit } = lv;
  const { frame, lookup, pick, facingOf } = lv.ctx;
  // edge (x, y) = the north (h) or west (v) edge of cell (x, y)
  const stairAt = (orient: EdgeOrient, x: number, y: number): void => {
    if (V.edgeKind(x, y, orient === "h" ? "N" : "W") !== EDGE.STAIR) return;
    const a = orient === "h" ? { x, y: y - 1 } : { x: x - 1, y };
    const b = { x, y };
    const ca = V.cell(a.x, a.y);
    const cb = V.cell(b.x, b.y);
    if (!ca.floor || !cb.floor) return;
    const lowerIsA = ca.height < cb.height;
    const lo = lowerIsA ? a : b;
    const cl = lowerIsA ? ca : cb;
    const rise = Math.abs(ca.height - cb.height);
    const dir: Side = orient === "h" ? (lowerIsA ? "S" : "N") : lowerIsA ? "E" : "W";
    const roles =
      rise >= 0.75 - EPS && rise <= 1.25 + EPS
        ? // natural ground may have its own stair piece (earth or rock steps) before the built one
          cl.material && isCliffGround(cl.material)
          ? [`link.stairs.${cl.material}`, "link.stairs.natural", "link.stairs"]
          : ["link.stairs"]
        : cl.material
          ? isCliffGround(cl.material)
            ? [`step.${cl.material}`]
            : [`step.${cl.material}`, "step.default"]
          : ["step.default"];
    const res = lookup(L.id, cl.theme, roles, undefined, true);
    const v = res ? pick(res.variants, `${L.id}:step:${lo.x}:${lo.y}`) : undefined;
    if (!v || !res) return;
    // a step piece must fit under the step it climbs: one taller than the rise would stand as a block on the lower
    // floor (the riser is built anyway, from the cell's own floor or fill)
    if (!res.role.startsWith("link.stairs") && v.geom.size.y > rise + 0.05) return;
    const f = facingOf(v, "link", res.role);
    const steps = f.ascendsToward ? frame.stepsToFace(f.ascendsToward, frame.worldSide(dir)) : 0;
    const deg = steps * 15 + v.rot;
    const src: Placement["source"] = { cell: [lo.x, lo.y], elementId: "steps" };
    if (v.geom.originAt === "minCorner") {
      const m = frame.rectMin(lo.x, lo.y, 1, 1);
      emit(v, "link", m.x, topOf(cl), m.z, deg, src);
    } else {
      const ctr = frame.point(lo.x + 0.5, lo.y + 0.5);
      const off = rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * frame.o.rotSense);
      emit(v, "link", ctr.x - off.x, topOf(cl), ctr.z - off.z, deg, src);
    }
  };
  for (let ly = 0; ly <= V.h; ly++) for (let lx = 0; lx < V.w; lx++) stairAt("h", V.x0 + lx, V.y0 + ly);
  for (let ly = 0; ly < V.h; ly++) for (let lx = 0; lx <= V.w; lx++) stairAt("v", V.x0 + lx, V.y0 + ly);
}

// ── links (placed on the lower level) ──
export function layLinks(lv: RealizeLevel): void {
  const { L, V } = lv;
  const { resolved, frame, lookup, pick, facingOf } = lv.ctx;
  for (const lk of resolved.links) {
    if (lk.kind === "trapdoor") {
      // the hatch lies on the UPPER level's floor (the resolver keeps that floor for trapdoors)
      if (lk.toLevel === L.id) placeHatch(lv, lk);
      continue;
    }
    if (lk.fromLevel !== L.id) continue;
    if (lk.kind === "pit_drop") continue;
    const roleName = `link.${lk.kind}`;
    const firstCell = lk.lowerCells[0];
    if (!firstCell) continue;
    const theme = lk.theme || V.cell(firstCell[0], firstCell[1]).theme;
    const res = lookup(L.id, theme, [roleName]);
    if (!res) continue;
    const pool = res.variants.filter((v) => v.weight > 0);
    const v = pick(pool.length ? pool : res.variants, `${L.id}:link:${lk.id}`);
    if (!v) continue;
    const f = facingOf(v, "link", res.role);
    const wdir = frame.worldSide(lk.dir);
    const deg = (f.ascendsToward ? frame.stepsToFace(f.ascendsToward, wdir) : 0) * 15 + v.rot;
    if (lk.kind === "stairs" || lk.kind === "ramp") layFlight(lv, lk, v, theme, deg);
    else layVerticalLink(lv, lk, v, res.role, deg);
  }
}

type Link = ResolvedPlan["links"][number];

/**
 * A stair flight or ramp: one piece per lower cell, stepped up by its index along the climb, with fill under it; the
 * cells past the rise are a landing of fill courses up to the upper floor top.
 */
function layFlight(lv: RealizeLevel, lk: Link, v: ResolvedVariant, theme: ThemeId, deg: number): void {
  const { V, elev, topOf, emit } = lv;
  const { frame } = lv.ctx;
  const xs = lk.lowerCells.map((c) => c[0]);
  const ys = lk.lowerCells.map((c) => c[1]);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  for (const [cx, cy] of lk.lowerCells) {
    const kIdx =
      lk.dir === "N" ? maxY - cy : lk.dir === "S" ? cy - minY : lk.dir === "E" ? cx - minX : maxX - cx;
    const c = V.cell(cx, cy);
    const lowerTop = c.floor ? topOf(c) : elev + 0.5;
    const rise = v.unitHeight;
    const m = frame.rectMin(cx, cy, 1, 1);
    if ((kIdx + 1) * rise <= lk.rise + EPS) {
      const base = lowerTop + kIdx * rise;
      if (base > lowerTop + EPS) stackFill(lv, theme, c.material, cx, cy, lowerTop, base, "link", lk.id);
      emit(v, "link", m.x, base, m.z, deg, { cell: [cx, cy], elementId: lk.id });
    } else {
      // landing: the rest of a non-integer rise as fill courses up to the upper floor top
      stackFill(lv, theme, c.material, cx, cy, lowerTop, lowerTop + lk.rise, "link", lk.id);
    }
  }
}

/**
 * Vertical links (ladder, spiral stairs): ONE stack of the resolved asset, from the lower floor top until it reaches
 * the upper floor top. The count comes from the asset's height versus the real span (rise 2.5, 5.0, …), never from the
 * link kind. An asset smaller than the link's footprint (a ladder standing in for spiral stairs) goes once, into a
 * cell of the footprint against a wall when there is one.
 */
function layVerticalLink(lv: RealizeLevel, lk: Link, v: ResolvedVariant, role: string, deg: number): void {
  const { L, V, elev, topOf, emit } = lv;
  const { frame, facts, addDiag } = lv.ctx;
  const roleName = `link.${lk.kind}`;
  const xs = lk.lowerCells.map((c) => c[0]);
  const ys = lk.lowerCells.map((c) => c[1]);
  const rx = Math.min(...xs);
  const ry = Math.min(...ys);
  const rw = Math.max(...xs) - rx + 1;
  const rh = Math.max(...ys) - ry + 1;
  const coversLink = v.footprint[0] * v.footprint[1] >= lk.lowerCells.length;
  const walledSide = (x: number, y: number): boolean => SIDES.some((s) => V.wallOn(x, y, s));
  const sorted = [...lk.lowerCells].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const cell: readonly [number, number] = coversLink
    ? [rx, ry]
    : (sorted.find(([x, y]) => walledSide(x, y)) ?? sorted[0] ?? [rx, ry]);
  const [cx, cy] = cell;
  const cols = coversLink ? rw : 1;
  const rows = coversLink ? rh : 1;
  const c = V.cell(cx, cy);
  const base = c.floor ? topOf(c) : elev + 0.5;
  const upView = facts.grid(lk.toLevel);
  const upperTop = upView ? upView.top(cx, cy) : elev + c.height + 0.5 + lk.rise;
  const count = Math.max(1, Math.ceil((upperTop - base) / v.unitHeight - EPS));
  const src: Placement["source"] = { cell: [cx, cy], elementId: lk.id };
  if (role !== roleName && !coversLink) {
    addDiag({
      severity: "info",
      code: "asset_substituted",
      message: `${lk.kind === "spiral_stairs" ? "Spiral stairs" : `Link (${lk.kind})`} ${lk.id} built as ${v.name ?? role} in one cell: no ${roleName} asset in this palette`,
      levelId: L.id,
      elementId: lk.id,
      role: roleName,
    });
  }
  if (v.geom.originAt === "minCorner") {
    const m = frame.rectMin(cx, cy, cols, rows);
    for (let s = 0; s < count; s++) emit(v, "link", m.x, base + s * v.unitHeight, m.z, deg, src);
  } else {
    const centre = frame.point(cx + cols / 2, cy + rows / 2);
    const off = rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * frame.o.rotSense);
    for (let s = 0; s < count; s++)
      emit(v, "link", centre.x - off.x, base + s * v.unitHeight, centre.z - off.z, deg, src);
  }
}

function placeHatch(lv: RealizeLevel, lk: ResolvedPlan["links"][number]): void {
  const { L, V, elev, topOf, emit } = lv;
  const { frame, lookup, pick } = lv.ctx;
  const cell = lk.upperCells[0] ?? lk.arrival;
  const c = V.cell(cell[0], cell[1]);
  const res = lookup(L.id, lk.theme || c.theme, ["link.trapdoor"]);
  const pool = res ? res.variants.filter((u) => u.weight > 0) : [];
  const v = res ? pick(pool.length ? pool : res.variants, `${L.id}:hatch:${lk.id}`) : undefined;
  if (!v) return;
  const m = frame.rectMin(cell[0], cell[1], 1, 1);
  emit(v, "link", m.x, c.floor ? topOf(c) : elev + 0.5, m.z, v.rot, {
    cell: [cell[0], cell[1]],
    elementId: lk.id,
  });
}
