/**
 * Realize, fill passes: what stands under a raised floor (fill courses, cliff blocks, outcrop columns) and the piers
 * under bridge decks. `stackFill` is also used by the link pass (fill under stair flights).
 * Reads: the level's cells and bridges; the ground under decks (floors.ts), the rock band's back and bare cells
 * (cliffBand.ts), `outcropCells`, `outsideGround`. Writes: fill and ledge placements.
 */
import type { PlacementRole } from "../../contracts/compiler";
import type { Material, ThemeId } from "../../contracts/plan";
import { CELL_FLAG } from "../../contracts/resolved";
import type { VariantFilter } from "../../palette/resolve";
import { isWater } from "../../resolve/materials";
import { BAND, type RockBand } from "./cliffBand";
import type { GroundUnderDecks } from "./floors";
import { EPS, isCliffGround, type RealizeLevel } from "./level";

// fill under raised cells; drops of a tile or more get a cliff face (ledge role / natural rock) instead
export function layRaisedFill(lv: RealizeLevel, band: RockBand, groundUnder: GroundUnderDecks): void {
  const { L, V, elev, outcropCells, outsideGround } = lv;
  const { profile } = lv.ctx;
  /** Theme and material pairs already noted as having no cliff piece (one diagnostic each). */
  const noted = new Set<string>();
  /** Height of the ground a neighbour presents to a raised cell (open cells, floorless ones included, and the ground under decks). */
  const groundOf = (x: number, y: number): number => {
    const g = groundUnder.get(`${x},${y}`);
    if (g !== undefined) return g;
    if (!V.inBounds(x, y)) return outsideGround;
    const n = V.cell(x, y);
    return n.open ? n.height : 0;
  };
  for (let ly = 0; ly < V.h; ly++) {
    for (let lx = 0; lx < V.w; lx++) {
      const x = L.bounds.x + lx;
      const y = L.bounds.y + ly;
      const c = V.cell(x, y);
      if (!c.floor || (c.flags & CELL_FLAG.BRIDGE) !== 0) continue; // decks have open air beneath
      const minN = Math.min(groundOf(x, y - 1), groundOf(x + 1, y), groundOf(x, y + 1), groundOf(x - 1, y));
      if (outcropCells.has(`${x},${y}`)) {
        // a rock column from the ground around it up to its top (no floor tile): reads as rock, not a tiled box
        const from = elev + Math.min(minN, 0);
        if (!cliffFace(lv, noted, c.theme, c.material, x, y, from, elev + c.height + 0.5, true))
          stackFill(lv, c.theme, c.material, x, y, from, elev + c.height + 0.5);
        continue;
      }
      if (c.height <= minN + EPS) continue;
      // generator 4: a floor raised no more than its own slab (half a tile) over every neighbour abuts the neighbour's
      // slab, so nothing shows under it and no fill course is needed (a room raised a quarter tile over its corridor
      // costs no extra pieces); the board edge and open air beside it keep their fill
      if (
        profile.flushRaisedFloors &&
        c.height - minN <= 0.5 + EPS &&
        c.material !== null &&
        !isCliffGround(c.material) &&
        !isWater(c.material)
      )
        continue;
      // behind a rock band: no face blocks and no hidden fill (the band covers the drop); the board's own edge keeps
      // its solid side
      if (band.bare.has(`${x},${y}`)) {
        // one rock family for every such patch (the band's backing), never the mixed per-cell picks
        const bandKey = `${L.id}:ledge:band`;
        if (cliffFace(lv, noted, c.theme, c.material, x, y, elev + minN, elev + c.height, false, bandKey))
          continue;
      } else if (
        band.back.has(`${x},${y}`) &&
        c.height - minN >= BAND.minRiseQ / 4 - EPS &&
        lx > 0 &&
        ly > 0 &&
        lx < V.w - 1 &&
        ly < V.h - 1
      ) {
        continue;
      }
      if (
        c.height - minN >= 1 - EPS &&
        cliffFace(lv, noted, c.theme, c.material, x, y, elev + minN, elev + c.height)
      )
        continue;
      stackFill(lv, c.theme, c.material, x, y, elev + minN, elev + c.height);
    }
  }
}

/**
 * Stacks cliff blocks (cliff.<material>, cliff.default, or natural rock for natural ground) under a raised cell.
 * False when the palette has none (then `noted` remembers the theme and material, so the note is given once).
 */
function cliffFace(
  lv: RealizeLevel,
  noted: Set<string>,
  theme: ThemeId,
  material: Material | null,
  x: number,
  y: number,
  from: number,
  to: number,
  force = false,
  pickKey?: string,
): boolean {
  const { L, blockTurn, emit } = lv;
  const { profile, frame, lookup, pick, addDiag } = lv.ctx;
  // whole-cell blocks only: 1×1 footprint and about a tile wide both ways
  const one: VariantFilter = {
    key: "block1x1",
    test: (v) =>
      v.footprint[0] === 1 &&
      v.footprint[1] === 1 &&
      v.geom.size.x > 0.8 &&
      v.geom.size.z > 0.8 &&
      v.geom.originAt === "minCorner",
  };
  // generator 3: natural ground shows rock where its face is bare, never earth-coloured fill (cliff.rock_block)
  const rockFirst = profile.rockGroundFaces && material !== null && isCliffGround(material);
  let res = lookup(
    L.id,
    theme,
    material
      ? [...(rockFirst ? ["cliff.rock_block"] : []), `cliff.${material}`, "cliff.default"]
      : ["cliff.default"],
    one,
    true,
  );
  if (!res && material !== null && (force || isCliffGround(material)))
    res = lookup(L.id, theme, ["cliff.natural"], one, true);
  if (!res) {
    if (material !== null && isCliffGround(material) && !noted.has(`${theme}|${material}`)) {
      noted.add(`${theme}|${material}`);
      addDiag({
        severity: "info",
        code: "asset_substituted",
        message: `No cliff piece for ${material} in theme "${theme}" (cliff.${material}, cliff.default, cliff.natural); its drops are built with fill courses`,
        levelId: L.id,
        role: `cliff.${material}`,
      });
    }
    return false;
  }
  const v = pick(res.variants, pickKey ?? `${L.id}:ledge:${x}:${y}`);
  if (!v) return false;
  const u = v.unitHeight;
  // outcrops (force) are rock all the way: a part block sinks into the ground rather than becoming fill
  const n = force ? Math.max(1, Math.ceil((to - from) / u - EPS)) : Math.floor((to - from) / u + EPS);
  const m = frame.rectMin(x, y, 1, 1);
  for (let k = 0; k < n; k++)
    emit(v, "ledge", m.x, to - (k + 1) * u, m.z, v.rot + blockTurn(v, `${x}:${y}:${k}`), {
      cell: [x, y],
      elementId: "ledge",
    });
  // the rest (less than one block) in fill courses, so nothing reaches below the lower floor
  const rest = to - n * u - from;
  if (rest > EPS) stackFill(lv, theme, material, x, y, from, from + rest);
  return true;
}

// stone piers under bridge decks: courses of the deck's fill from the ground beneath up to the deck
export function layPiers(lv: RealizeLevel): void {
  const { L, V, elev, emit } = lv;
  const { frame, lookup, pick } = lv.ctx;
  for (const b of L.bridges ?? []) {
    for (const [px, py] of b.piers ?? []) {
      const j = b.cells.findIndex((c) => c[0] === px && c[1] === py);
      if (j < 0) continue;
      const c = V.cell(px, py);
      const ground = (b.under[j] ?? b.deck) / 4;
      if (c.height - ground < 0.5 - EPS) continue;
      // pier.<material> / pier.default when the palette has a column piece, else courses of the deck's fill
      const one: VariantFilter = { key: "1x1", test: (q) => q.footprint[0] === 1 && q.footprint[1] === 1 };
      const roles = c.material ? [`pier.${c.material}`, "pier.default"] : ["pier.default"];
      const pr = lookup(L.id, c.theme, roles, one, true);
      const pv = pr ? pick(pr.variants, `${L.id}:pier:${px}:${py}`) : undefined;
      if (pv) {
        const m = frame.rectMin(px, py, 1, 1);
        // whole pieces from the deck down, the remainder in fill: nothing reaches below the ground beneath
        const n = Math.floor((c.height - ground) / pv.unitHeight + EPS);
        for (let s = 0; s < n; s++)
          emit(pv, "fill", m.x, elev + c.height - (s + 1) * pv.unitHeight, m.z, pv.rot, {
            cell: [px, py],
            elementId: "pier",
          });
        const rest = c.height - ground - n * pv.unitHeight;
        if (rest > EPS)
          stackFill(lv, c.theme, c.material, px, py, elev + ground, elev + ground + rest, "fill", "pier");
      } else stackFill(lv, c.theme, c.material, px, py, elev + ground, elev + c.height, "fill", "pier");
    }
  }
}

/** Stacks fill courses (the cell's own fill or floor tile, else fill.default) from `from` up to `to`. */
export function stackFill(
  lv: RealizeLevel,
  theme: ThemeId,
  material: Material | null,
  x: number,
  y: number,
  from: number,
  to: number,
  role: PlacementRole = "fill",
  elementId = "fill",
): void {
  const { L, emit } = lv;
  const { profile, frame, lookup, pick } = lv.ctx;
  const levelId = L.id;
  // water cells sit on their bed; other cells fill with their own floor tile before the generic fill
  const roles = !material
    ? ["fill.default"]
    : isWater(material)
      ? [`bed.${material}`, "bed.default", "fill.default"]
      : [
          ...(profile.rockGroundFaces && isCliffGround(material) ? ["fill.rock"] : []),
          `fill.${material}`,
          `floor.${material}`,
          "fill.default",
        ];
  // stacked courses use the default family (untagged 1×1 variants), not a patch family's tile
  const res = lookup(levelId, theme, roles, {
    key: "1x1plain",
    test: (v) => v.footprint[0] === 1 && v.footprint[1] === 1 && (v.variant ?? "") === "",
  });
  if (!res) return;
  const v = pick(res.variants, `${levelId}:fill:${x}:${y}`);
  if (!v) return;
  const u = v.unitHeight;
  const n = Math.ceil((to - from) / u - EPS);
  const m = frame.rectMin(x, y, 1, 1);
  for (let k = 0; k < n; k++) emit(v, role, m.x, to - (k + 1) * u, m.z, v.rot, { cell: [x, y], elementId });
}
