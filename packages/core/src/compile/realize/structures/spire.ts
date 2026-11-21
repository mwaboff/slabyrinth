/**
 * Realize, a spire: a steep pointed roof over the top storey.
 *   shell kit   roof.<kit>.shell courses stepping in, flared bands of the kit's slopes, a lid (roof.<kit>.flat → cap),
 *               the finial (magic_beacon.default for a beacon, roof.<kit>.finial → finial.default)
 *   otherwise   a hip roof's rings laid twice (two tiles per cell inward), the tip (roof.<kit>.tip → roof.default.tip),
 *               else the finial
 * A ceiling (roof.<kit>.deck → roof.default.deck → a stone floor) closes the storey below.
 * Reads: the layer's rect, base and band count. Writes: roof placements (layer "roof"). Returns the spire's top.
 */
import type { RoleName } from "../../../contracts/compiler";
import type { Side } from "../../../contracts/plan";
import { lenFilter } from "../../../palette/filters";
import { DEFAULT_PART, defaultPartRole, floorRole, roofRole } from "../../../palette/roles";
import { PART_FALLBACK_FLOORS } from "../../../resolve/building/parts";
import { hipRoof, ringLayer, spireShell, type Rect } from "../../../resolve/roof";
import { EPS } from "../level";
import type { StructureCtx } from "./context";
import { edgePiece, layTiles, placeProp, rectCellsOf, setOf } from "./pieces";
import { layRoofPiece } from "./roofPiece";

/**
 * The spire. The rings of a hip roof (eaves over the wall ring, the last ring capped) are each laid twice, one tile
 * above the other, so every ring rises two tiles per cell inward (a pitch about twice the 45° of a plain hip): a pyramid
 * about as tall as the crown is wide, then a tip piece (roof.<kit>.tip, a slim pointed cap) and the finial or beacon on
 * top. (Owner, 2026-11-20: the earlier stack of shrinking wall boxes read as a pagoda, not a spire.) A kit with
 * tile-faced thin walls (roof.<kit>.shell) builds it as a hollow shell instead (`layShellSpire`).
 */
export function laySpire(
  b: StructureCtx,
  kit: string,
  rect: Rect,
  base: number,
  bands: number,
  tag: string,
): number {
  const { st } = b;
  const { L, emit } = b.lv;
  const { frame, pick } = b.lv.ctx;
  layTiles(
    b,
    [roofRole(kit, "deck"), roofRole(DEFAULT_PART, "deck"), floorRole(PART_FALLBACK_FLOORS.stone)],
    setOf(rectCellsOf(rect)),
    base - 0.5,
    "floor",
    { id: `${tag}~ceiling`, layer: "roof" },
  );
  if (b.lookup([roofRole(kit, "shell")], undefined, true))
    return layShellSpire(b, kit, rect, base, bands, tag);
  const g = hipRoof(rect);
  // slopes doubled: ring k fills base+2k .. base+2k+2; the ridge caps sit on the last ring's top (no gap under them)
  const slopeTop = Math.max(0, ...g.pieces.filter((p) => p.kind !== "cap").map((p) => 2 * p.course + 2));
  for (const p of g.pieces) {
    if (p.kind === "cap") {
      layRoofPiece(b, kit, p, base + slopeTop - p.course, tag);
      continue;
    }
    layRoofPiece(b, kit, p, base + p.course, tag);
    layRoofPiece(b, kit, p, base + p.course + 1, tag);
  }
  // (the ridge caps, a tile tall, finish the point above the last ring)
  let top = base + slopeTop + (g.pieces.some((p) => p.kind === "cap") ? 1 : 0);
  // the tip: a slim pointed piece on the middle cell(s)
  const cx = rect.x + Math.floor((rect.w - 1) / 2);
  const cy = rect.y + Math.floor((rect.h - 1) / 2);
  const tr = b.lookup([roofRole(kit, "tip"), roofRole(DEFAULT_PART, "tip")], undefined, true);
  const tv = tr ? pick(tr.variants, `${L.id}:${tag}:tip`) : undefined;
  if (tv) {
    const m = frame.rectMin(cx, cy, 1, 1);
    emit(tv, "wall", m.x, top - 1, m.z, tv.rot, { cell: [cx, cy], elementId: `${tag}~tip` }, "roof");
    top = top - 1 + tv.geom.size.y;
  }
  // a pointed tip is the spire's own finial: nothing balances on its point
  if (!tv && st.furniture?.finial !== false) {
    const r = b.lookup(finialRoles(b, kit), undefined, true);
    const v = r ? pick(r.variants, `${L.id}:${tag}:finial`) : undefined;
    if (v) placeProp(b, v, cx + 0.5, cy + 0.5, top, 0, { id: `${tag}~finial`, layer: "roof" });
  }
  return top;
}

/** What crowns a spire: a beacon on a building with that detail, else the kit's finial or the default one. */
const finialRoles = (b: StructureCtx, kit: string): RoleName[] => [
  ...(b.st.design?.details.includes("beacon") ? [defaultPartRole("magic_beacon")] : []),
  roofRole(kit, "finial"),
  defaultPartRole("finial"),
];

/**
 * A kit with tile-faced thin walls (roof.<kit>.shell) builds the spire as a steep hollow shell: courses two tiles tall
 * stepping in half a cell on every side (about 76°), a flared band of the kit's slopes round some courses, a lid and the
 * finial (the technique of the best community towers). The shell never falls back to wall pieces: walls stacked into a
 * spire read as a pagoda of boxes.
 */
function layShellSpire(
  b: StructureCtx,
  kit: string,
  rect: Rect,
  base: number,
  bands: number,
  tag: string,
): number {
  const { st } = b;
  const { L } = b.lv;
  const { pick } = b.lv.ctx;
  const shell = spireShell(
    // the first course stands half a cell inside the walls, its eave band over the wall line
    { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    { bands: Math.max(1, bands) },
  );
  const strip = (x: number, y: number, face: Side, len: number, yb: number, yt: number): void => {
    let done = 0;
    while (done < len) {
      let placed = 0;
      for (const n of [2, 1]) {
        if (n > len - done) continue;
        const r = b.lookup([roofRole(kit, "shell")], lenFilter(n), true);
        const v = r ? pick(r.variants, `${L.id}:${tag}:spire:${x},${y},${face},${done}`) : undefined;
        if (!v) continue;
        const px = face === "N" || face === "S" ? x + done : x;
        const py = face === "N" || face === "S" ? y : y + done;
        const cnt = Math.max(1, Math.ceil((yt - yb) / v.unitHeight - EPS));
        for (let k = 0; k < cnt; k++)
          edgePiece(b, v, "wall", { x: px, y: py, face }, n, yb + k * v.unitHeight, {
            id: `${tag}~spire`,
            layer: "roof",
          });
        placed = n;
        break;
      }
      if (placed === 0) return;
      done += placed;
    }
  };
  for (const c of shell.courses) {
    const yb = base + c.y;
    const w = c.x1 - c.x0;
    const h = c.y1 - c.y0;
    strip(c.x0, c.y0 + 0.5, "N", w, yb, yb + 2);
    strip(c.x0, c.y1 - 1.5, "S", w, yb, yb + 2);
    strip(c.x0 + 0.5, c.y0 + 0.5, "W", h - 1, yb, yb + 2);
    strip(c.x1 - 1.5, c.y0 + 0.5, "E", h - 1, yb, yb + 2);
    if (c.band || c.y === 0) {
      // a flared band of the kit's slopes just outside the course, at its foot (always at the eave)
      const x0 = Math.ceil(c.x0) - 1;
      const y0 = Math.ceil(c.y0) - 1;
      const ring = ringLayer(
        { x: x0, y: y0, w: Math.floor(c.x1) + 1 - x0, h: Math.floor(c.y1) + 1 - y0 },
        1,
        "slope",
        false,
      );
      for (const p of ring.pieces) layRoofPiece(b, kit, p, yb, tag);
    }
  }
  const tip = base + shell.top;
  const last = shell.courses[shell.courses.length - 1];
  if (last) {
    const lid: Rect = {
      x: Math.ceil(last.x0),
      y: Math.ceil(last.y0),
      w: Math.max(1, Math.floor(last.x1) - Math.ceil(last.x0)),
      h: Math.max(1, Math.floor(last.y1) - Math.ceil(last.y0)),
    };
    layTiles(
      b,
      [roofRole(kit, "flat"), roofRole(kit, "cap"), floorRole(PART_FALLBACK_FLOORS.stone)],
      setOf(rectCellsOf(lid)),
      tip - 0.5,
      "floor",
      { id: `${tag}~lid`, layer: "roof" },
    );
  }
  // a bartizan's little spire ends at its lid: a finial there would lean into the shaft beside it
  if (st.furniture?.finial !== false && !tag.includes("bartizan")) {
    const r = b.lookup(finialRoles(b, kit), undefined, true);
    const v = r ? pick(r.variants, `${L.id}:${tag}:finial`) : undefined;
    if (v) placeProp(b, v, shell.finial.x, shell.finial.y, tip, 0, { id: `${tag}~finial`, layer: "roof" });
  }
  return tip;
}
