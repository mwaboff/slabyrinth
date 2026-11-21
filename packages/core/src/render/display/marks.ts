/** Symbols on the map: openings, steps between heights, links between levels (with their level badge), features. */
import type { Side } from "../../contracts/plan";
import type { DisplayItem } from "../../contracts/resolved";
import { EDGE } from "../../contracts/resolved";
import { featureInfo } from "../../gen/catalog";
import { SIDE_ROT } from "../../gen/gridGeometry";
import { isSecret } from "../../gen/openingKinds";
import { hEdgeIndex, vEdgeIndex } from "../../resolve/levelGrid";
import type { DisplayCtx } from "./context";

/** Symbol rotation of a link or a flight of steps climbing toward a side (0 = climbing north, the screen's up). */
const DIR_ROT: Record<Side, number> = { N: 0, E: 90, S: 180, W: 270 };

/** Depth of a door symbol across its wall, in cells: the half-cell wall strip it sits in. */
const DOOR_DEPTH = 0.5;

/** Door symbols, on the host side of their wall; gaps ("open") draw nothing, GM-only ones only on the GM layer. */
export function openingItems(c: DisplayCtx): DisplayItem[] {
  const { bx, by, level, opts } = c;
  const items: DisplayItem[] = [];
  for (const o of level.openings) {
    if (o.kind === "open") continue;
    if (!opts.gmLayer && (o.gmOnly === true || isSecret(o.kind))) continue;
    const g = o.orientation === "h" ? level.hEdges : level.vEdges;
    const lx = o.start[0] - bx;
    const ly = o.start[1] - by;
    const e = o.orientation === "h" ? hEdgeIndex(level.bounds, lx, ly) : vEdgeIndex(level.bounds, lx, ly);
    const host = g.host[e] === 1;
    const id = `door-${o.kind}`;
    const sym: NonNullable<DisplayItem["symbol"]> =
      o.orientation === "h"
        ? {
            id,
            x: o.start[0],
            y: host ? o.start[1] : o.start[1] - DOOR_DEPTH,
            w: o.width,
            h: DOOR_DEPTH,
            rot: host ? 0 : 180,
          }
        : {
            id,
            x: host ? o.start[0] : o.start[0] - DOOR_DEPTH,
            y: o.start[1],
            w: DOOR_DEPTH,
            h: o.width,
            rot: host ? 90 : 270,
          };
    items.push({
      layer: "opening",
      style: isSecret(o.kind) ? "secret" : "door",
      symbol: sym,
      ref: o.id,
    });
  }
  return items;
}

/** Steps (EDGE.STAIR): a stair symbol in the lower cell, climbing toward the higher one. */
export function stepItems(c: DisplayCtx): DisplayItem[] {
  const { bx, by, w, h, level } = c;
  const items: DisplayItem[] = [];
  const stepSym = (orient: "h" | "v", e: number, lx: number, ly: number): void => {
    const g = orient === "h" ? level.hEdges : level.vEdges;
    if (g.kind[e] !== EDGE.STAIR) return;
    const a = orient === "h" ? c.cellAt(lx, ly - 1) : c.cellAt(lx - 1, ly);
    const b = c.cellAt(lx, ly);
    if (a < 0 || b < 0) return;
    const lowerIsA = (level.cells.height[a] as number) < (level.cells.height[b] as number);
    const lo = lowerIsA ? a : b;
    const dir: Side = orient === "h" ? (lowerIsA ? "S" : "N") : lowerIsA ? "E" : "W";
    const x = bx + (lo % w);
    const y = by + Math.floor(lo / w);
    items.push({
      layer: "link",
      style: "steps",
      symbol: { id: "link-stairs", x, y, w: 1, h: 1, rot: DIR_ROT[dir] },
    });
  };
  for (let ly = 0; ly <= h; ly++)
    for (let lx = 0; lx < w; lx++) stepSym("h", hEdgeIndex(level.bounds, lx, ly), lx, ly);
  for (let ly = 0; ly < h; ly++)
    for (let lx = 0; lx <= w; lx++) stepSym("v", vEdgeIndex(level.bounds, lx, ly), lx, ly);
  return items;
}

/** Links touching the level: the link symbol over its cells, and a badge naming the level it leads to. */
export function linkItems(c: DisplayCtx): DisplayItem[] {
  const { level } = c;
  const labels = c.plan.levelLabels ?? {};
  const items: DisplayItem[] = [];
  for (const link of c.plan.links ?? []) {
    const lower = link.fromLevel === level.id;
    const upper = link.toLevel === level.id;
    if (!lower && !upper) continue;
    const cells = lower ? link.lowerCells : link.upperCells;
    if (cells.length === 0) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [cx, cy] of cells) {
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx + 1);
      y1 = Math.max(y1, cy + 1);
    }
    const rot = DIR_ROT[link.dir];
    items.push({
      layer: "link",
      style: lower ? "link-up" : "link-down",
      symbol: { id: `link-${link.kind}`, x: x0, y: y0, w: x1 - x0, h: y1 - y0, rot },
      ref: link.id,
    });
    const other = lower ? link.toLevel : link.fromLevel;
    // lower level: tag at the top of the run (where it goes up); upper level: at the bottom of the hole
    const at = lower
      ? (link.lowerCells[link.lowerCells.length - 1] ?? [x0, y0])
      : (link.upperCells[0] ?? [x0, y0]);
    items.push({
      layer: "label",
      style: lower ? "link-badge-up" : "link-badge-down",
      text: { value: labels[other] ?? other, x: at[0] + 0.5, y: at[1] + 0.5, size: "s", anchor: "middle" },
      ref: link.id,
    });
  }
  return items;
}

/** Features shown in this view (GM-only on the GM layer, furniture when asked), non-blocking first so rugs lie under tables. */
export function featureItems(c: DisplayCtx): DisplayItem[] {
  const { opts } = c;
  const feats = c.level.features.filter((f) => {
    if (!opts.gmLayer && f.gmOnly) return false;
    if (!opts.furniture && featureInfo(f.type).category === "furniture") return false;
    return true;
  });
  const ordered = [...feats.filter((f) => !f.blocking), ...feats.filter((f) => f.blocking)];
  return ordered.map((f): DisplayItem => {
    const info = featureInfo(f.type);
    const rot = info.wallMounted && f.wall ? SIDE_ROT[f.wall] : f.rotFine;
    // generator 4: a covered stall is drawn as its canopy, turned so the front eave is on the side the customer stands
    // (the symbol is drawn front-up; only covered stalls carry `stall`)
    const symbol = f.stall
      ? { id: "feat-stall_cover", rot: SIDE_ROT[f.stall.front] }
      : { id: `feat-${f.type}`, rot };
    return {
      layer: "feature",
      style: f.gmOnly ? "feat-gm" : "feat",
      symbol: { id: symbol.id, x: f.at[0], y: f.at[1], w: f.size[0], h: f.size[1], rot: symbol.rot },
      ref: f.id,
    };
  });
}
