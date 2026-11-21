/**
 * Realize, fill passes: what stands under a raised floor (fill courses, cliff blocks, outcrop columns) and the piers
 * under bridge decks. `stackFill` and `cliffFace` are also used by the link pass (fill under stair flights).
 * Reads: the level's cells and bridges; `groundUnder` (floors.ts), `bandBack` and `bandBare` (cliffBand.ts),
 * `outcropCells`. Writes: fill and ledge placements; `outsideGround` (read by the rock wall pass); `cliffNoted`.
 */
import type { PlacementRole } from "../../contracts/compiler";
import type { LevelId, ThemeId } from "../../contracts/plan";
import { CELL, CELL_FLAG } from "../../contracts/resolved";
import type { VariantFilter } from "../../palette/resolve";
import { BAND } from "./cliffBand";
import { EPS, NATURAL_GROUND, WATER, type LevelWork } from "./work";

// fill under raised cells; drops of a tile or more get a cliff face (ledge role / natural rock) instead
export function layRaisedFill(w: LevelWork): void {
  const { L, V, elev, groundUnder, outcropCells, bandBack, bandBare } = w;
  const { gen } = w.ctx;
  // Generator 2: the level stands on a solid foundation down to its lowest floor, so outside the level bounds the
  // ground is that low and cells on the border get solid sides (raised land has thickness seen from the side).
  let levelLowest = 0;
  for (let i = 0; i < V.w * V.h; i++)
    if (L.cells.state[i] === CELL.OPEN) levelLowest = Math.min(levelLowest, (L.cells.height[i] ?? 0) / 4);
  for (const b of L.bridges ?? []) for (const q of b.under) levelLowest = Math.min(levelLowest, q / 4);
  const outsideGround = gen.foundation ? Math.min(levelLowest, -(L.foundation ?? 0)) : 0;
  w.outsideGround = outsideGround;
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
        if (!cliffFace(w, c.theme, c.material, x, y, elev + Math.min(minN, 0), elev + c.height + 0.5, true))
          stackFill(w, L.id, c.theme, c.material, x, y, elev + Math.min(minN, 0), elev + c.height + 0.5);
        continue;
      }
      if (c.height <= minN + EPS) continue;
      // generator 4: a floor raised no more than its own slab (half a tile) over every neighbour abuts the neighbour's
      // slab, so nothing shows under it and no fill course is needed (a room raised a quarter tile over its corridor
      // costs no extra pieces); the board edge and open air beside it keep their fill
      if (
        gen.flushRaisedFloors &&
        c.height - minN <= 0.5 + EPS &&
        c.material !== null &&
        !NATURAL_GROUND.has(c.material) &&
        !WATER.has(c.material)
      )
        continue;
      // behind a rock band: no face blocks and no hidden fill (the band covers the drop); the board's own edge keeps
      // its solid side
      if (bandBare.has(`${x},${y}`)) {
        // one rock family for every such patch (the band's backing), never the mixed per-cell picks
        if (cliffFace(w, c.theme, c.material, x, y, elev + minN, elev + c.height, false, `${L.id}:ledge:band`))
          continue;
      } else if (
        bandBack.has(`${x},${y}`) &&
        c.height - minN >= BAND.minRiseQ / 4 - EPS &&
        lx > 0 &&
        ly > 0 &&
        lx < V.w - 1 &&
        ly < V.h - 1
      ) {
        continue;
      }
      if (c.height - minN >= 1 - EPS && cliffFace(w, c.theme, c.material, x, y, elev + minN, elev + c.height))
        continue;
      stackFill(w, L.id, c.theme, c.material, x, y, elev + minN, elev + c.height);
    }
  }
}

/** Stacks cliff blocks (cliff.<material>, cliff.default, or natural rock for natural ground) under a raised cell. */
export function cliffFace(
  w: LevelWork,
  theme: ThemeId,
  material: string | null,
  x: number,
  y: number,
  from: number,
  to: number,
  force = false,
  pickKey?: string,
): boolean {
  const { L, cliffNoted, blockTurn, emit } = w;
  const { gen, frame, lookup, pick, addDiag } = w.ctx;
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
  const rockFirst = gen.rockGroundFaces && material !== null && NATURAL_GROUND.has(material);
  let res = lookup(
    L.id,
    theme,
    material
      ? [...(rockFirst ? ["cliff.rock_block"] : []), `cliff.${material}`, "cliff.default"]
      : ["cliff.default"],
    one,
    true,
  );
  if (!res && material !== null && (force || NATURAL_GROUND.has(material)))
    res = lookup(L.id, theme, ["cliff.natural"], one, true);
  if (!res) {
    if (material !== null && NATURAL_GROUND.has(material) && !cliffNoted.has(`${theme}|${material}`)) {
      cliffNoted.add(`${theme}|${material}`);
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
  if (rest > EPS) stackFill(w, L.id, theme, material, x, y, from, from + rest);
  return true;
}

// stone piers under bridge decks: courses of the deck's fill from the ground beneath up to the deck
export function layPiers(w: LevelWork): void {
  const { L, V, elev, emit } = w;
  const { frame, lookup, pick } = w.ctx;
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
          stackFill(w, L.id, c.theme, c.material, px, py, elev + ground, elev + ground + rest, "fill", "pier");
      } else stackFill(w, L.id, c.theme, c.material, px, py, elev + ground, elev + c.height, "fill", "pier");
    }
  }
}

/** Stacks fill courses (the cell's own fill or floor tile, else fill.default) from `from` up to `to`. */
export function stackFill(
  w: LevelWork,
  levelId: LevelId,
  theme: ThemeId,
  material: string | null,
  x: number,
  y: number,
  from: number,
  to: number,
  role: PlacementRole = "fill",
  elementId = "fill",
): void {
  const { emit } = w;
  const { gen, frame, lookup, pick } = w.ctx;
  // water cells sit on their bed; other cells fill with their own floor tile before the generic fill
  const roles = !material
    ? ["fill.default"]
    : WATER.has(material)
      ? [`bed.${material}`, "bed.default", "fill.default"]
      : [
          ...(gen.rockGroundFaces && NATURAL_GROUND.has(material) ? ["fill.rock"] : []),
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
  for (let k = 0; k < n; k++)
    emit(v, role, m.x, to - (k + 1) * u, m.z, v.rot, { cell: [x, y], elementId });
}
