/**
 * What no recipe's piece may take, enforced once by the engine for every recipe (never by a recipe itself):
 *
 *   ways      the walking space (floor top to head height) of every cell beside a passage opening, of stairs, links and
 *             ramps: no piece at all.
 *   lanes     the walking space of a room's clear lanes and door aprons (anchors/zones.ts LANE, DOOR), and of the cells
 *             the room furnisher kept clear (ResolvedLevel.keptClear): a piece may only hug a wall there (lie within
 *             HUG of a walled side of the cell).
 *   open      the free centre of every open floor cell (resolve/levelGrid.ts `freeCentre`, where the 2D map's open
 *             floor is judged): no piece over it at walking height.
 *   features  the footprint and height of every feature already on the level (furniture, wall torches, shelves): no
 *             piece in it.
 *   fixtures  what a building's record says it hangs on its walls and before its doors (door lights, entrance strips,
 *             porches, a canopy or awning, balconies, a fire escape, service pipes, a shop sign): no piece in it.
 *
 * Underfoot pieces (a recipe's flat or low ground cover, walked over) skip `open` and may lie over open floor, but take
 * no lane or apron cell at all, not even against a wall.
 *
 * A box here is plan x/y (cells) and absolute height. Heights the resolved level does not hold (a feature's piece, a
 * door light) are the palette's (`heightOf`) or a generous default.
 */
import type { Side } from "../../contracts/plan";
import type { ResolvedFeature, ResolvedLevel, ResolvedStructure } from "../../contracts/resolved";
import { CELL_FLAG, EDGE } from "../../contracts/resolved";
import { OPPOSITE, SIDE_STEP, SIDES } from "../../gen/gridGeometry";
import { isPassage, isWindow } from "../../gen/openingKinds";
import type { LevelGrid } from "../levelGrid";
import { openingFace, volumesOf } from "../structureFaces";
import { ZONE, type ZoneAnchor } from "../anchors";
import { maxOf } from "../../util/lists";

/** Head room over a walkable cell (tiles). */
export const HEAD = 2;
/** A piece within this of a walled side of a lane cell hugs the wall and leaves the lane walkable. */
export const HUG = 0.35;
/** Overlaps thinner than this are touching, not taking. */
const TOUCH = 0.02;
/** Height of a feature whose piece the palette was not asked for. */
const FEATURE_HEIGHT = 2;

/** A box in plan x/y and absolute height. */
export interface PlanBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z0: number;
  readonly z1: number;
}

/** Why a box was refused (for tests and the proof). */
export type ClearReason = "way" | "lane" | "open" | "feature" | "fixture";

const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.min(a1, b1) - Math.max(a0, b0);

export class KeepClear {
  private readonly hard = new Set<number>();
  private readonly soft = new Set<number>();
  private readonly boxes: Array<{ box: PlanBox; why: ClearReason }> = [];

  constructor(
    private readonly L: ResolvedLevel,
    private readonly g: LevelGrid,
    zones: readonly ZoneAnchor[],
    heightOf: (f: ResolvedFeature) => number | null,
  ) {
    const n = g.w * g.h;
    for (let i = 0; i < n; i++)
      if (((L.cells.flags[i] ?? 0) & (CELL_FLAG.STEPS | CELL_FLAG.LINK)) !== 0) this.hard.add(i);
    for (const r of L.ramps ?? []) for (const [x, y] of r.cells) this.addHard(x, y);
    for (const op of L.openings) {
      if (!isPassage(op.kind)) continue;
      for (let k = 0; k < op.width; k++) {
        const [ex, ey] =
          op.orientation === "h" ? [op.start[0] + k, op.start[1]] : [op.start[0], op.start[1] + k];
        this.addHard(ex, ey);
        if (op.orientation === "h") this.addHard(ex, ey - 1);
        else this.addHard(ex - 1, ey);
      }
    }
    for (const z of zones)
      for (const [x, y] of z.cells)
        if ((z.classAt(x, y) & (ZONE.LANE | ZONE.DOOR)) !== 0) this.soft.add(g.index(x, y));
    // what a room's furnisher kept clear (standing room before a group, the way to it, door landings) is a lane too
    for (const i of L.keptClear ?? []) this.soft.add(i);
    for (const f of L.features) {
      const ox = f.offset?.[0] ?? 0;
      const oy = f.offset?.[1] ?? 0;
      // (baseHeight is absolute: it holds the level's elevation already)
      const base = f.baseHeight;
      this.boxes.push({
        box: {
          x0: f.at[0] + ox,
          y0: f.at[1] + oy,
          x1: f.at[0] + f.size[0] + ox,
          y1: f.at[1] + f.size[1] + oy,
          z0: base,
          z1: base + (heightOf(f) ?? FEATURE_HEIGHT),
        },
        why: "feature",
      });
    }
    for (const st of L.structures ?? [])
      for (const box of structureFixtures(L, st)) this.boxes.push({ box, why: "fixture" });
  }

  private addHard(x: number, y: number): void {
    const i = this.g.index(x, y);
    if (i >= 0) this.hard.add(i);
  }

  /**
   * Why a piece's box may not stand, or null when it may. An `underfoot` piece (flat or low, walked over) may cover open
   * floor, but never a lane or an apron, not even against a wall.
   */
  refuse(b: PlanBox, underfoot = false): ClearReason | null {
    const g = this.g;
    for (let y = Math.floor(b.y0 + TOUCH); y < b.y1 - TOUCH; y++)
      for (let x = Math.floor(b.x0 + TOUCH); x < b.x1 - TOUCH; x++) {
        const i = g.index(x, y);
        if (i < 0 || !g.cell(x, y).floor) continue;
        const top = g.top(x, y);
        if (overlap(b.z0, b.z1, top, top + HEAD) <= TOUCH) continue;
        if (this.hard.has(i)) return "way";
        if (this.soft.has(i) && (underfoot || !this.hugs(b, x, y))) return "lane";
        if (underfoot) continue;
        // the point the 2D map's open floor is judged at stays free
        const c = g.freeCentre(x, y);
        if (c && c[0] > b.x0 + TOUCH && c[0] < b.x1 - TOUCH && c[1] > b.y0 + TOUCH && c[1] < b.y1 - TOUCH)
          return "open";
      }
    for (const { box, why } of this.boxes)
      if (
        overlap(b.x0, b.x1, box.x0, box.x1) > TOUCH &&
        overlap(b.y0, b.y1, box.y0, box.y1) > TOUCH &&
        overlap(b.z0, b.z1, box.z0, box.z1) > TOUCH
      )
        return why;
    return null;
  }

  /**
   * Whether the part of `b` over cell (x, y) lies within HUG of a wall surface of the cell (the edge, or half a cell
   * in when the wall's strip stands in this cell).
   */
  private hugs(b: PlanBox, x: number, y: number): boolean {
    const ox0 = Math.max(b.x0, x);
    const ox1 = Math.min(b.x1, x + 1);
    const oy0 = Math.max(b.y0, y);
    const oy1 = Math.min(b.y1, y + 1);
    return SIDES.some((s) => {
      const k = this.g.edgeKind(x, y, s);
      if (k !== EDGE.WALL && k !== EDGE.OPENING) return false;
      const reach = HUG + (this.g.hostedOn(x, y, s) ? 0.5 : 0);
      switch (s) {
        case "N":
          return oy1 <= y + reach;
        case "S":
          return oy0 >= y + 1 - reach;
        case "W":
          return ox1 <= x + reach;
        case "E":
          return ox0 >= x + 1 - reach;
      }
    });
  }
}

/** A box on the outside of footprint cell (x, y)'s face `side`: `along` and `out` (from the edge) ranges, heights. */
function faceBox(
  x: number,
  y: number,
  side: Side,
  along: readonly [number, number],
  out: readonly [number, number],
  z: readonly [number, number],
): PlanBox {
  const [dx, dy] = SIDE_STEP[side];
  // the edge line and the direction along the face (east for N/S, south for E/W, as structureFaces.alongFace)
  const ex = side === "E" ? x + 1 : x;
  const ey = side === "S" ? y + 1 : y;
  if (dx === 0) {
    const ya = ey + dy * out[0];
    const yb = ey + dy * out[1];
    return {
      x0: x + along[0],
      x1: x + along[1],
      y0: Math.min(ya, yb),
      y1: Math.max(ya, yb),
      z0: z[0],
      z1: z[1],
    };
  }
  const xa = ex + dx * out[0];
  const xb = ex + dx * out[1];
  return {
    x0: Math.min(xa, xb),
    x1: Math.max(xa, xb),
    y0: y + along[0],
    y1: y + along[1],
    z0: z[0],
    z1: z[1],
  };
}

/**
 * The keep-out boxes of what a building's record hangs on its walls (compile/realize/structures attachments and
 * details lay them; their sizes here are generous bounds, not the pieces).
 */
export function structureFixtures(L: ResolvedLevel, st: ResolvedStructure): PlanBox[] {
  const out: PlanBox[] = [];
  const s0 = st.storeys[0];
  if (st.kind !== "building" || !s0) return out;
  const floor = s0.floorTop;
  const vols = volumesOf(st);
  const top = maxOf([floor + s0.wallHeight, ...vols.flatMap((v) => v.storeys.map((s) => s.wallTop))]);
  const front: Side = st.frontage?.side ?? "S";
  const facesOn = (side: Side): Array<[number, number]> => {
    const cells = new Set(st.cells.map(([x, y]) => `${x},${y}`));
    const [dx, dy] = SIDE_STEP[side];
    return st.cells.filter(([x, y]) => !cells.has(`${x + dx},${y + dy}`)).map(([x, y]) => [x, y]);
  };
  // door lights: 0.15 outside the wall, 1.6 up (compile/realize/structures/attachments.ts layDoorLights)
  for (const lt of st.lights)
    out.push(faceBox(lt.at[0], lt.at[1], lt.side, [0.1, 0.9], [0, 1.1], [floor + 1.2, floor + 2.6]));
  // entrance strips at the main door's jambs
  if (st.lighting?.strips) {
    const doors = L.openings.filter((o) => st.openingIds.includes(o.id) && !isWindow(o.kind));
    const op = doors.find((o) => openingFace(st, o).face === st.frontage?.side) ?? doors[0];
    if (op) {
      const { c, face } = openingFace(st, op);
      for (const a of [-0.55, op.width - 0.45])
        out.push(faceBox(c[0], c[1], face, [a + 0.2, a + 0.8], [0, 1], [floor, floor + 3]));
    }
  }
  // porches: their cells, floor to roof
  for (const p of st.porches)
    for (const [x, y] of p.cells)
      out.push({ x0: x, y0: y, x1: x + 1, y1: y + 1, z0: floor - 0.5, z1: floor + 3.5 });
  const details = st.condition === "ruined" ? [] : (st.design?.details ?? []);
  const wholeSide = (side: Side, z0: number, z1: number, reach: number): void => {
    for (const [x, y] of facesOn(side)) out.push(faceBox(x, y, side, [-0.5, 1.5], [0, reach], [z0, z1]));
  };
  if (details.includes("canopy") || details.includes("awning"))
    wholeSide(front, floor + (s0.footing?.height ?? 0) + 1.8, floor + (s0.footing?.height ?? 0) + 2.9, 3);
  if (st.frontage?.shopfront) wholeSide(front, floor + (s0.footing?.height ?? 0) + 1.8, floor + 4, 1.5);
  if (details.includes("fire_escape"))
    for (const side of front === "N" || front === "S" ? (["E", "W"] as const) : (["N", "S"] as const))
      wholeSide(side, floor, top + 1, 3);
  if (details.includes("services")) wholeSide(OPPOSITE[front], floor, top + 1, 1.5);
  if (details.includes("banners") || details.includes("balcony")) wholeSide(front, floor, top + 1, 2);
  if (details.includes("balconies"))
    for (const u of st.upperOpenings) {
      if (u.side !== front || !isWindow(u.kind)) continue;
      const sp = vols.find((v) => v.id === (u.volume ?? vols[0]?.id))?.storeys[u.storey];
      const f = sp?.floorTop ?? floor;
      out.push(faceBox(u.at[0], u.at[1], u.side, [-1, u.width + 1], [0, 2], [f - 0.7, f + 1.4]));
    }
  return out;
}
