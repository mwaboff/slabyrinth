/** Zone outlines and text: room numbers and names (kept off furniture, links and plan labels), the water note, plan labels. */
import type { DisplayItem, ResolvedArea } from "../../contracts/resolved";
import { CELL, CELL_FLAG } from "../../contracts/resolved";
import type { DisplayCtx } from "./context";
import { flat } from "./rings";

/** How far (in rings of cells) a room's badge looks for a spot clear of its name strip, and for any free cell. */
const NAMED_BADGE_REACH = 4;
const BADGE_REACH = 3;
/** Height is stored in quarter tiles. */
const QUARTERS_PER_TILE = 4;

/** Text strip of `len` characters centred on cell column x (generous: the font has a pixel minimum). */
const stripHalf = (len: number): number => len * 0.13 + 0.2;

/** Outline of each zone that has cells. */
export function zoneItems(c: DisplayCtx): DisplayItem[] {
  return c.level.areas
    .filter((a) => a.kind === "zone" && a.cellCount > 0)
    .map((a) => ({
      layer: "area_outline",
      style: "zone-outline",
      geom: { rings: a.outline.map((r) => flat(r)), closed: true },
      ref: a.id,
    }));
}

/** Cells under a feature, and cells a plan label's text strip crosses (local indices). */
function takenCells(c: DisplayCtx): { covered: Set<number>; texted: Set<number> } {
  const { bx, by, w, h, level } = c;
  const covered = new Set<number>();
  for (const f of level.features)
    for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
      for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) covered.add((y - by) * w + (x - bx));
  // plan labels ("Up to the abbey") occupy their row too: room badges and names keep off them
  const texted = new Set<number>();
  for (const l of level.labels) {
    const cx = l.at[0] + 0.5;
    const half = stripHalf(l.text.length);
    for (let x = Math.floor(cx - half); x <= Math.floor(cx + half - 1e-9); x++)
      if (x >= bx && x < bx + w && l.at[1] >= by && l.at[1] < by + h)
        texted.add((l.at[1] - by) * w + (x - bx));
  }
  return { covered, texted };
}

/**
 * Badge cell of a room: labelAt, else the nearest cell of the area (anchor first, then rings out to 4) whose badge
 * cell is free floor of the area AND whose name strip (when a name is drawn) is clear of features and links — so the
 * name is never overprinted by furniture or by a plan-check marker (markers sit on the feature's cell). Falls back to
 * the nearest free badge cell, then the anchor.
 */
function badgeFinder(
  c: DisplayCtx,
): (a: ResolvedArea, ai: number, name: { row: 0 | 1; half: number } | null) => readonly [number, number] {
  const { bx, by, w, h, level } = c;
  const { covered, texted } = takenCells(c);
  const inside = (x: number, y: number): boolean => x >= bx && y >= by && x < bx + w && y < by + h;
  /** Cell is clear of features, link runs and plan labels (inside the level). */
  const clear = (x: number, y: number): boolean => {
    if (!inside(x, y)) return false;
    const i = (y - by) * w + (x - bx);
    return !covered.has(i) && !texted.has(i) && ((level.cells.flags[i] as number) & CELL_FLAG.LINK) === 0;
  };
  return (a, ai, name) => {
    if (a.labelAt) return a.labelAt;
    const free = (x: number, y: number): boolean => {
      if (!inside(x, y)) return false;
      const i = (y - by) * w + (x - bx);
      return level.cells.area[i] === ai + 1 && c.isFloor(i) && clear(x, y);
    };
    const nameClear = (x: number, y: number): boolean => {
      if (!name) return true;
      const cx = x + 0.5;
      for (let k = Math.floor(cx - name.half); k <= Math.floor(cx + name.half - 1e-9); k++)
        if (!clear(k, y + name.row)) return false;
      return true;
    };
    const [ax, ay] = a.anchor;
    const search = (ok: (x: number, y: number) => boolean, max: number): readonly [number, number] | null => {
      if (ok(ax, ay)) return a.anchor;
      for (let r = 1; r <= max; r++)
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++)
            if (Math.max(Math.abs(dx), Math.abs(dy)) === r && ok(ax + dx, ay + dy)) return [ax + dx, ay + dy];
      return null;
    };
    return (
      (name ? search((x, y) => free(x, y) && nameClear(x, y), NAMED_BADGE_REACH) : null) ??
      search(free, BADGE_REACH) ??
      a.anchor
    );
  };
}

/** Room numbers (keyed rooms) and names (when asked for), at each room's badge cell. */
export function roomLabelItems(c: DisplayCtx): DisplayItem[] {
  const { opts } = c;
  const badgeCell = badgeFinder(c);
  const items: DisplayItem[] = [];
  for (const [ai, a] of c.level.areas.entries()) {
    if (a.cellCount === 0) continue;
    const drawName = opts.roomNames && a.name !== undefined && (a.key !== undefined || a.kind !== "corridor");
    const numbered = opts.roomNumbers && a.key !== undefined;
    // name plate half-width in cells (generous: the font has a pixel minimum when zoomed out)
    const at = badgeCell(
      a,
      ai,
      drawName && a.name !== undefined ? { row: numbered ? 1 : 0, half: stripHalf(a.name.length) } : null,
    );
    if (opts.roomNumbers && a.key !== undefined) {
      items.push({
        layer: "label",
        style: "room-number",
        text: { value: a.key, x: at[0] + 0.5, y: at[1] + 0.5, size: "m", anchor: "middle" },
        ref: a.id,
      });
    }
    if (drawName && a.name !== undefined) {
      const dy = numbered ? 1.15 : 0.5;
      items.push({
        layer: "label",
        style: "room-name",
        text: { value: a.name, x: at[0] + 0.5, y: at[1] + dy, size: "s", anchor: "middle" },
        ref: a.id,
      });
    }
  }
  return items;
}

/**
 * TaleSpire water is a board-wide plane the slab cannot carry: same wording as the paste note (above the bottom of the
 * slab, which is the level's foundation or its lowest floor, whichever is lower).
 */
export function waterLevelItems(c: DisplayCtx): DisplayItem[] {
  const { bx, by, w, h, level } = c;
  if (level.waterLevel === undefined) return [];
  let lowest = 0;
  for (let i = 0; i < w * h; i++)
    if (level.cells.state[i] === CELL.OPEN)
      lowest = Math.min(lowest, (level.cells.height[i] as number) / QUARTERS_PER_TILE);
  for (const b of level.bridges ?? [])
    for (const q of b.under) lowest = Math.min(lowest, q / QUARTERS_PER_TILE);
  const bottom = level.elevation + Math.min(lowest, -(level.foundation ?? 0));
  const rel = level.waterLevel - bottom;
  return [
    {
      layer: "label",
      style: "label",
      text: {
        value: `Water: set to about ${rel} tiles above the slab bottom`,
        x: bx + 0.5,
        y: by + 0.5,
        size: "s",
        anchor: "start",
      },
      ref: "water-level",
    },
  ];
}

/** The plan's own labels. */
export function planLabelItems(c: DisplayCtx): DisplayItem[] {
  return c.level.labels.map((l) => ({
    layer: "label",
    style: "label",
    text: { value: l.text, x: l.at[0] + 0.5, y: l.at[1] + 0.5, size: l.size, anchor: "middle" },
    ref: l.id,
  }));
}
