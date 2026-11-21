/**
 * Realize, where one storey or volume meets another: the seam a set-in storey leaves on the storey below (a skirt of
 * roof slope, a plain ledge, or a crenellated one), and the lip of a volume standing on another (a corbel course under
 * an overhang, a skirt of slope on the host's exposed roof cells).
 *   ledge      seam_ledge.<style> → floor.<material>
 *   battlement crenel.<style> → crenel.default, else a parapet course (wall.parapet → wall.low_wall)
 *   corbel     corbel.<style> → facade.<style> → wall.<style>
 * Reads: the storeys and volumes. Writes: wall, floor and roof placements.
 */
import type { ResolvedVolume } from "../../../contracts/resolved";
import { SIDE_STEP, SIDES } from "../../../gen/gridGeometry";
import { lenFilter } from "../../../palette/filters";
import {
  CRENEL_FALLBACK_ROLES,
  defaultPartRole,
  floorRole,
  partRole,
  wallRole,
} from "../../../palette/roles";
import { PART_FALLBACK_KITS, partWalls } from "../../../resolve/building/parts";
import { ringLayer } from "../../../resolve/roof";
import { usesRoofKit } from "../../../resolve/roofTypes";
import type { StructureCtx } from "./context";
import { cellOfKey, edgePiece, faceCells, key, layTiles, setOf, stackEdge } from "./pieces";
import { layRoofPiece } from "./roofPiece";

type VolumeStorey = ResolvedVolume["storeys"][number];

/** The ring a set-in storey leaves on the storey below: a skirt of roof slope, a plain ledge, or a crenellated one. */
export function laySeam(b: StructureCtx, prev: VolumeStorey, sp: VolumeStorey, tag: string): void {
  const { st } = b;
  const { L } = b.lv;
  const { pick } = b.lv.ctx;
  const inner = setOf(sp.cells);
  const ring = setOf(prev.cells.filter(([x, y]) => !inner.has(key(x, y))));
  if (ring.size === 0) return;
  const y = prev.wallTop;
  const kit = st.roof.style || PART_FALLBACK_KITS.pitched;
  if (sp.seam === "skirt") {
    // slopes falling outward over the ledge, from the upper wall line down to the lower storey's eave
    const courses = Math.max(1, sp.rect.x - prev.rect.x, sp.rect.y - prev.rect.y);
    const g = ringLayer(prev.rect, courses, "slope", false);
    for (const p of g.pieces) if (ring.has(key(p.x, p.y))) layRoofPiece(b, kit, p, y, tag);
    return;
  }
  const ps = partWalls(prev.walls, "seam");
  layTiles(b, [partRole("seam_ledge", ps), floorRole(prev.floor)], ring, y, "floor", {
    id: `${tag}~ledge`,
    layer: "roof",
  });
  // battlements on the ledge's outer edge: one course of crenellation pieces, else a parapet course
  if (sp.seam === "crenellated") {
    const part = { id: `${tag}~crenel`, layer: "roof" };
    for (const f of faceCells(setOf(prev.cells))) {
      const r = b.lookup([partRole("crenel", ps), defaultPartRole("crenel")], lenFilter(1), true);
      const v = r ? pick(r.variants, `${L.id}:${tag}:crenel`) : undefined;
      if (v) edgePiece(b, v, "wall", f, 1, y + 0.5, part);
      else stackEdge(b, CRENEL_FALLBACK_ROLES, "wall", f, y + 0.5, y + 1.5, part);
    }
  }
}

/**
 * No bare floor edge on the outside (owner, 2026-11-20: offset storeys showed slab edges): where a volume standing
 * on another overhangs it, a corbel course of its own wall material hangs a tile below its floor on the overhanging
 * faces; where it sets back from a host with no roof of its own, the exposed host cells get a skirt of roof slope
 * falling outward, laid on the host's wall top.
 */
export function layLips(b: StructureCtx, vols: readonly ResolvedVolume[]): void {
  const { st } = b;
  // the skirts take the building's pitched roof kit (one roof material throughout)
  const kit =
    vols.flatMap((v) => v.roof.layers).find((l) => usesRoofKit(l.type))?.style ||
    st.roof.style ||
    PART_FALLBACK_KITS.pitched;
  for (const v of vols) {
    if (v.on === null) continue;
    const host = vols.find((o) => o.id === v.on);
    const hostTop = host?.storeys[host.storeys.length - 1];
    const sp = v.storeys[0];
    if (!host || !hostTop || !sp) continue;
    const hostCells = setOf(hostTop.cells);
    const own = setOf(sp.cells);
    // the corbel course is trim: the design's base (trim) material when it has one (stone under a brick shaft)
    const walls = st.design?.treatment ? st.design.baseMaterial : partWalls(sp.walls, "lip");
    const tag = `${st.id}~${v.id}~lip`;
    for (const f of faceCells(own)) {
      if (hostCells.has(key(f.x, f.y))) continue;
      stackEdge(
        b,
        [partRole("corbel", walls), partRole("facade", walls), wallRole(walls)],
        "wall",
        f,
        sp.floorTop - 1.5,
        sp.floorTop - 0.5,
        { id: tag, layer: "storey:0" },
        { allowBelow: true },
      );
    }
    if (host.roof.layers.length > 0) continue; // a roofed host (a podium, a terrace) shows its own roof
    for (const k of hostCells) {
      if (own.has(k)) continue;
      const [x, y] = cellOfKey(k);
      const eave =
        SIDES.find((s) => !hostCells.has(key(x + SIDE_STEP[s][0], y + SIDE_STEP[s][1]))) ??
        SIDES.find((s) => !own.has(key(x - SIDE_STEP[s][0], y - SIDE_STEP[s][1]))) ??
        "S";
      layRoofPiece(b, kit, { kind: "slope", x, y, w: 1, h: 1, eave, course: 0 }, hostTop.wallTop, tag);
    }
  }
}
