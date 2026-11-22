/** The level's surfaces: ground (rock, void, the ghost of another level), floors by material, water, height shading. */
import type { DisplayItem } from "../../contracts/resolved";
import { CELL, CELL_FLAG } from "../../contracts/resolved";
import type { Material } from "../../contracts/plan";
import { isWater } from "../../resolve/materials";
import { traceRings } from "../../resolve/trace";
import type { DisplayCtx } from "./context";
import { flat, groupRings } from "./rings";

/** Height shading steps are capped at this many quarter tiles (the theme has a token per step). */
const HEIGHT_SHADE_STEPS = 16;

/** Rock and void, then the ghost of the level shown under this one (when asked for). */
export function groundItems(c: DisplayCtx): DisplayItem[] {
  const items: DisplayItem[] = [];
  const st = c.level.cells.state;
  for (const [k, rings] of groupRings(c.level, (i) =>
    st[i] === CELL.SOLID ? "rock" : st[i] === CELL.VOID ? "void" : null,
  ))
    if (rings.length > 0) items.push({ layer: "ground", style: k, geom: { rings, closed: true } });
  const g = c.opts.ghostLevel;
  if (g) {
    const gw = g.bounds.w;
    const rings = traceRings(
      gw,
      g.bounds.h,
      (ux, uy) => g.cells.state[uy * gw + ux] === CELL.OPEN,
      g.bounds.x,
      g.bounds.y,
    ).map(flat);
    if (rings.length > 0) items.push({ layer: "ground", style: "ghost", geom: { rings, closed: true } });
  }
  return items;
}

/** The floor material of a cell, null when it has none. */
function cellMaterial(c: DisplayCtx, i: number): Material | null {
  const m = c.level.cells.material[i] as number;
  return m > 0 ? (c.level.materials[m - 1] as Material) : null;
}

/** Floors by material, chasms and stairwells (water is its own layer). */
export function floorItems(c: DisplayCtx): DisplayItem[] {
  const st = c.level.cells.state;
  const floorKey = (i: number): string | null => {
    if (st[i] !== CELL.OPEN) return null;
    const f = c.level.cells.flags[i] as number;
    if (f & CELL_FLAG.STAIRWELL) return "stairwell";
    const ub = c.underBroken.get(i);
    if (ub) return ub.material === null ? "chasm" : `mat-${ub.material}`;
    if (f & CELL_FLAG.NO_FLOOR) return "chasm";
    const m = cellMaterial(c, i);
    if (m === null) return "floor";
    return isWater(m) ? null : `mat-${m}`;
  };
  return groupRings(c.level, floorKey).map(([k, rings]) => ({
    layer: "floor",
    style: k,
    geom: { rings, closed: true },
  }));
}

/** Water floors, by depth ("water-shallow", "water-deep"). */
export function waterItems(c: DisplayCtx): DisplayItem[] {
  const waterKey = (i: number): string | null => {
    if (!c.isFloor(i)) return null;
    const m = cellMaterial(c, i);
    // the theme's water tokens are the material names in token spelling: water_deep -> "water-deep"
    return m !== null && isWater(m) ? m.replace(/_/g, "-") : null;
  };
  return groupRings(c.level, waterKey).map(([k, rings]) => ({
    layer: "water",
    style: k,
    geom: { rings, closed: true },
  }));
}

/** Raised and sunken floors (the ground below a broken bridge cell when it has one), by height step. */
export function heightItems(c: DisplayCtx): DisplayItem[] {
  const heightKey = (i: number): string | null => {
    const ub = c.underBroken.get(i);
    if (!c.isFloor(i) && !(ub && ub.material !== null)) return null;
    const q = c.groundHeight(i);
    if (q === 0) return null;
    return q > 0
      ? `height-up-${Math.min(HEIGHT_SHADE_STEPS, q)}`
      : `height-down-${Math.min(HEIGHT_SHADE_STEPS, -q)}`;
  };
  return groupRings(c.level, heightKey).map(([k, rings]) => ({
    layer: "height_shade",
    style: k,
    geom: { rings, closed: true },
  }));
}
