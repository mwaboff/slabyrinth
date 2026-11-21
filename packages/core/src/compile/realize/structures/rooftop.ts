/**
 * Realize, what stands on a building's flat roofs: a roof access hut, a mast on the highest flat top, and either a
 * designed building's rooftop sets (a plant yard, a terrace, storage) or a clutter field.
 *   hut        opening.door.works → opening.door.<style> → opening.door;  walls facade.<style> → wall.<style> →
 *              wall.wall;  roof.<kit>.flat → a tile floor
 *   mast       mast.default
 *   sets       roof_terrace.default → the terrace kit's flat roof;  feature.seating → feature.bench;
 *              light.window.<style> → light.window;  roof_clutter.<family>
 *   clutter    roof_clutter.<equipment|storage> → roof_clutter.default
 * Reads: the building's flat tops (roofs.ts). Writes: wall, opening, floor and feature placements (layer "roof").
 */
import type { Side, WallStyle } from "../../../contracts/plan";
import type { VariantFilter } from "../../../palette/resolve";
import type { RoleName } from "../../../contracts/compiler";
import { footprintAtMost, lenFilter } from "../../../palette/filters";
import {
  THEME_WALL_ROLE,
  defaultPartRole,
  featureRole,
  floorRole,
  lightRole,
  openingRole,
  partRole,
  roofRole,
  styledOpeningRole,
  wallRole,
} from "../../../palette/roles";
import {
  PART_FALLBACK_FLOORS,
  PART_FALLBACK_KITS,
  WORKS_DOOR_FAMILY,
  partWalls,
} from "../../../resolve/building/parts";
import type { ResolvedVariant } from "../../../palette/resolve";
import { h32Utf16 } from "../../../util/hash";
import { unit01, type StructureCtx } from "./context";
import {
  cellOfKey,
  edgePiece,
  faceCells,
  key,
  layTiles,
  placeProp,
  ringOf8,
  setOf,
  stackEdge,
} from "./pieces";
import type { FlatTop } from "./roofs";

/** Flat roofs: a hut, a mast on the highest flat top, then the rooftop sets (designed) or a clutter field. */
export function layRoofFurniture(b: StructureCtx, tops: readonly FlatTop[]): void {
  const { st, lv } = b;
  const { L } = lv;
  const { pick } = lv.ctx;
  const F = st.furniture;
  if (!F || tops.length === 0) return;
  const high = [...tops].sort((p, q) => q.y - p.y)[0];
  const hutRing = new Set<string>();
  if (F.hut && high && high.walls && high.rect.w >= 5 && high.rect.h >= 5)
    layRoofHut(b, high, high.walls, hutRing);
  let mastCell: string | null = null;
  if (F.mast && high) {
    const r = b.lookup([defaultPartRole("mast")], undefined, true);
    const v = r ? pick(r.variants, `${L.id}:${st.id}:mast`) : undefined;
    if (v) {
      let mx = high.rect.x + Math.floor(high.rect.w / 2);
      let my = high.rect.y + Math.floor(high.rect.h / 2);
      if (hutRing.has(key(mx, my))) {
        // the hut is in one corner: the mast goes toward the opposite one
        const hx =
          hutRing.has(key(high.rect.x + 1, high.rect.y + 1)) ||
          hutRing.has(key(high.rect.x + 1, high.rect.y + high.rect.h - 2));
        mx = hx ? high.rect.x + high.rect.w - 2 : high.rect.x + 1;
        my = high.rect.y + high.rect.h - 2;
        if (hutRing.has(key(mx, my))) my = high.rect.y + 1;
      }
      mastCell = key(mx, my);
      placeProp(b, v, mx + 0.5, my + 0.5, high.y, 0, { id: `${st.id}~mast`, layer: "roof" });
    }
  }
  if (st.design) {
    layRooftopSets(
      b,
      tops,
      new Set<string>([
        ...hutRing,
        ...(mastCell ? ringOf8(new Set([mastCell])) : []),
        ...(mastCell ? [mastCell] : []),
      ]),
    );
    return;
  }
  if (F.clutter > 0) layClutter(b, tops, new Set<string>([...hutRing, ...(mastCell ? [mastCell] : [])]));
}

/**
 * A clutter field on an undesigned building's flat tops: equipment on the rows beside the parapet, storage between, a
 * cell apart, never on the edge row or the hut and mast.
 */
function layClutter(b: StructureCtx, tops: readonly FlatTop[], taken: Set<string>): void {
  const { st, lv } = b;
  const { L } = lv;
  const { pick } = lv.ctx;
  const clutter = st.furniture?.clutter ?? 0;
  for (const t of tops) {
    for (const k of [...t.cells].sort()) {
      if (taken.has(k)) continue;
      if (unit01(lv, `${st.id}:clutter:${k}`) >= clutter) continue;
      const [x, y] = cellOfKey(k);
      const edge =
        !t.cells.has(key(x - 1, y)) ||
        !t.cells.has(key(x + 1, y)) ||
        !t.cells.has(key(x, y - 1)) ||
        !t.cells.has(key(x, y + 1));
      // the edge row stays clear: props there poke through the parapet and the wall below
      if (edge) continue;
      const family = x === t.rect.x + 1 || x === t.rect.x + t.rect.w - 2 ? "equipment" : "storage";
      const r = b.lookup(
        [partRole("roof_clutter", family), defaultPartRole("roof_clutter")],
        undefined,
        true,
      );
      const v = r ? pick(r.variants, `${L.id}:${st.id}:clutter:${k}`) : undefined;
      if (!v) continue;
      // a prop wider than a cell needs a full cell of roof on every side (never over the parapet or the wall line)
      const reach = Math.max(v.footprint[0], v.footprint[1]) > 1 ? 2 : 1;
      let room = true;
      for (let dy = -reach; dy <= reach && room; dy++)
        for (let dx = -reach; dx <= reach && room; dx++) if (!t.cells.has(key(x + dx, y + dy))) room = false;
      if (!room) continue;
      // keep pieces a cell apart (overlapping props read as a heap)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) taken.add(key(x + dx, y + dy));
      // square to the building
      const deg = (h32Utf16(`${st.id}:${k}:r`) % 4) * 90;
      placeProp(b, v, x + 0.5, y + 0.5, t.y, deg, { id: `${st.id}~clutter`, layer: "roof" });
    }
  }
}

/**
 * A roof access hut on a flat top: a 2×2 (or 2×1 on a narrow roof) box of the storey's walls in a corner the seed
 * picks, a door facing into the roof, a flat roof of the kit. Its cells and their ring are added to `ring` so the
 * mast and the clutter keep off it.
 */
function layRoofHut(b: StructureCtx, t: FlatTop, walls: WallStyle, ring: Set<string>): void {
  const { st, lv } = b;
  const { L } = lv;
  const { seed, pick } = lv.ctx;
  const r = t.rect;
  const w = r.w >= 8 ? 3 : 2; // a bigger stair hut on a big roof
  const h = r.h >= 6 ? 2 : 1;
  const corner = h32Utf16(`${seed}:${st.id}:hut`) % 4;
  const x0 = corner % 2 === 0 ? r.x + 1 : r.x + r.w - 1 - w;
  const y0 = corner < 2 ? r.y + 1 : r.y + r.h - 1 - h;
  const cells = new Set<string>();
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) cells.add(key(x, y));
  if ([...cells].some((k) => !t.cells.has(k))) return;
  for (const k of cells) ring.add(k);
  for (const k of ringOf8(cells)) ring.add(k);
  const tag = `${st.id}~hut`;
  const part = { id: tag, layer: "roof" };
  // the door faces the middle of the roof
  const doorFace: Side = corner < 2 ? "S" : "N";
  const doorCell = key(corner % 2 === 0 ? x0 + w - 1 : x0, doorFace === "S" ? y0 + h - 1 : y0);
  const wallTop = t.y + 2;
  for (const f of faceCells(cells)) {
    if (key(f.x, f.y) === doorCell && f.face === doorFace) {
      const dr = b.lookup(
        [styledOpeningRole("door", WORKS_DOOR_FAMILY), styledOpeningRole("door", walls), openingRole("door")],
        lenFilter(1),
        true,
      );
      const dv = dr ? pick(dr.variants, `${L.id}:${tag}:door`) : undefined;
      if (dv && dr) {
        edgePiece(b, dv, "opening", f, 1, t.y, part, dr.role);
        continue;
      }
    }
    stackEdge(
      b,
      [partRole("facade", walls), wallRole(walls), THEME_WALL_ROLE],
      "wall",
      f,
      t.y,
      wallTop,
      part,
    );
  }
  layTiles(b, [roofRole(t.kit, "flat"), floorRole(PART_FALLBACK_FLOORS.tile)], cells, wallTop, "floor", {
    id: `${tag}~roof`,
    layer: "roof",
  });
}

/**
 * A designed building's rooftop sets, grouped and scaled to the roof (a GM mostly sees roofs from above): a plant
 * yard (a block of units filling every cell), a terrace (a deck of lighter tiles with seating and a lamp), storage
 * (a few pieces in a corner). Each set takes a block in a different corner of the largest flat top, a cell in from
 * the parapet, never on the hut or the mast.
 */
function layRooftopSets(b: StructureCtx, tops: readonly FlatTop[], taken: Set<string>): void {
  const { st, lv } = b;
  const { L } = lv;
  const { seed, pick } = lv.ctx;
  const sets = (st.design?.rooftop ?? []).filter((s) => s === "plant" || s === "terrace" || s === "storage");
  if (sets.length === 0) return;
  const t = [...tops].sort((p, q) => q.cells.size - p.cells.size)[0];
  if (!t) return;
  const area = t.cells.size;
  const inner = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (!t.cells.has(key(x + dx, y + dy))) return false;
    return true;
  };
  /** The first free block of w×h inner cells, scanning from a corner. */
  const block = (w: number, h: number, corner: number): Array<[number, number]> | null => {
    const r = t.rect;
    const xs = Array.from({ length: r.w }, (_, i) => r.x + i);
    const ys = Array.from({ length: r.h }, (_, i) => r.y + i);
    if (corner & 1) xs.reverse();
    if (corner & 2) ys.reverse();
    for (const y0 of ys)
      for (const x0 of xs) {
        const cells: Array<[number, number]> = [];
        let ok = true;
        for (let dy = 0; dy < h && ok; dy++)
          for (let dx = 0; dx < w && ok; dx++) {
            const x = corner & 1 ? x0 - dx : x0 + dx;
            const y = corner & 2 ? y0 - dy : y0 + dy;
            if (!inner(x, y) || taken.has(key(x, y))) ok = false;
            else cells.push([x, y]);
          }
        if (ok) return cells;
      }
    return null;
  };
  const one = (
    roles: RoleName[],
    filter: VariantFilter | undefined,
    k: string,
  ): ResolvedVariant | undefined => {
    const r = b.lookup(roles, filter, true);
    return r ? pick(r.variants, `${L.id}:${st.id}:${k}`) : undefined;
  };
  // (keyed apart from ONE_CELL: the two once shared the memo key "1x1" with different tests)
  const small = footprintAtMost(1, 1);
  // the size of a set follows the roof: a quarter of a big roof, a few cells of a small one
  const side = Math.max(2, Math.min(5, Math.round(Math.sqrt(area) / 2)));
  sets.forEach((set, si) => {
    const corner = (h32Utf16(`${seed}:${st.id}:set${si}`) + si * 3) % 4;
    const cells = block(set === "storage" ? 2 : side, set === "storage" ? 1 : Math.max(2, side - 1), corner);
    if (!cells) return;
    for (const [x, y] of cells)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) taken.add(key(x + dx, y + dy));
    const part = { id: `${st.id}~${set}`, layer: "roof" };
    if (set === "terrace") {
      layTiles(
        b,
        [defaultPartRole("roof_terrace"), roofRole(PART_FALLBACK_KITS.terrace, "flat")],
        setOf(cells),
        t.y,
        "floor",
        part,
      );
      const seats = [cells[0], cells[cells.length - 1]];
      for (const [i, c] of seats.entries()) {
        const v = c ? one([featureRole("seating"), featureRole("bench")], undefined, `seat${i}`) : undefined;
        if (v && c)
          placeProp(b, v, c[0] + 0.5, c[1] + 0.5, t.y + 0.5, (h32Utf16(`${st.id}:seat${i}`) % 4) * 90, part);
      }
      const mid = cells[Math.floor(cells.length / 2)];
      const lamp = mid
        ? one(
            [lightRole("window", partWalls(t.walls, "terraceLamp")), lightRole("window")],
            undefined,
            "terrace-lamp",
          )
        : undefined;
      if (lamp && mid) placeProp(b, lamp, mid[0] + 0.5, mid[1] + 0.5, t.y + 0.5, 0, part);
      return;
    }
    const family = set === "plant" ? "equipment" : "storage";
    for (const [x, y] of cells) {
      const v = one([partRole("roof_clutter", family)], small, `${set}:${x},${y}`);
      if (v) placeProp(b, v, x + 0.5, y + 0.5, t.y, (h32Utf16(`${st.id}:${x},${y}`) % 2) * 90, part);
    }
  });
}
