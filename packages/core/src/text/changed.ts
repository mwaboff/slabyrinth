/**
 * "Changed region" ASCII views for tool results (architecture §3.3 item 1): the ASCII view of each dirty level,
 * cropped to the changed bounding box ±3 cells, within a character budget (default 4,000 per result). When the
 * views do not fit, `fits` is false and the caller degrades to outline lines of the changed elements.
 */
import type { LevelId } from "../contracts/plan";
import type { ResolvedLevel, ResolvedPlan } from "../contracts/resolved";
import { edgeCol, edgeRow } from "../resolve/levelGrid";
import { asciiLevel } from "./ascii";

export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bounding box (global cells) of everything that differs between two versions of a level; null if identical. */
export function changedBBox(before: ResolvedLevel | undefined, after: ResolvedLevel): CellRect | null {
  const B = after.bounds;
  if (
    !before ||
    before.bounds.x !== B.x ||
    before.bounds.y !== B.y ||
    before.bounds.w !== B.w ||
    before.bounds.h !== B.h
  )
    return { ...B };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const hit = (gx: number, gy: number, gx2 = gx, gy2 = gy): void => {
    x0 = Math.min(x0, gx);
    y0 = Math.min(y0, gy);
    x1 = Math.max(x1, gx2);
    y1 = Math.max(y1, gy2);
  };
  const w = B.w;
  const matName = (l: ResolvedLevel, i: number): string => {
    const m = l.cells.material[i] as number;
    return m > 0 ? (l.materials[m - 1] as string) : "";
  };
  const areaName = (l: ResolvedLevel, i: number): string => {
    const a = l.cells.area[i] as number;
    return a > 0 ? (l.areaIds[a - 1] as string) : "";
  };
  for (let i = 0; i < w * B.h; i++) {
    if (
      before.cells.state[i] !== after.cells.state[i] ||
      before.cells.flags[i] !== after.cells.flags[i] ||
      before.cells.height[i] !== after.cells.height[i] ||
      matName(before, i) !== matName(after, i) ||
      areaName(before, i) !== areaName(after, i)
    )
      hit(B.x + (i % w), B.y + Math.floor(i / w));
  }
  for (let i = 0; i < after.hEdges.kind.length; i++) {
    if (before.hEdges.kind[i] !== after.hEdges.kind[i] || before.hEdges.host[i] !== after.hEdges.host[i]) {
      const gx = B.x + edgeCol(B, "h", i);
      const gy = B.y + edgeRow(B, "h", i);
      hit(gx, gy - 1, gx, gy);
    }
  }
  for (let i = 0; i < after.vEdges.kind.length; i++) {
    if (before.vEdges.kind[i] !== after.vEdges.kind[i] || before.vEdges.host[i] !== after.vEdges.host[i]) {
      const gx = B.x + edgeCol(B, "v", i);
      const gy = B.y + edgeRow(B, "v", i);
      hit(gx - 1, gy, gx, gy);
    }
  }
  const key = (f: ResolvedLevel["features"][number]): string =>
    `${f.id}|${f.type}|${f.at[0]},${f.at[1]}|${f.size[0]}x${f.size[1]}|${f.rotFine}`;
  const fb = new Map(before.features.map((f) => [f.id, key(f)]));
  const fa = new Map(after.features.map((f) => [f.id, key(f)]));
  for (const f of after.features)
    if (fb.get(f.id) !== key(f)) hit(f.at[0], f.at[1], f.at[0] + f.size[0] - 1, f.at[1] + f.size[1] - 1);
  for (const f of before.features)
    if (fa.get(f.id) !== key(f)) hit(f.at[0], f.at[1], f.at[0] + f.size[0] - 1, f.at[1] + f.size[1] - 1);
  const ob = new Map(before.openings.map((o) => [o.id, JSON.stringify(o)]));
  for (const o of after.openings) {
    if (ob.get(o.id) !== JSON.stringify(o))
      hit(o.start[0] - 1, o.start[1] - 1, o.start[0] + o.width, o.start[1] + o.width);
  }
  const ab = new Map(before.areas.map((a) => [a.id, `${a.key ?? ""}|${a.name ?? ""}|${a.anchor.join(",")}`]));
  for (const a of after.areas)
    if (ab.get(a.id) !== `${a.key ?? ""}|${a.name ?? ""}|${a.anchor.join(",")}`)
      hit(a.anchor[0], a.anchor[1]);
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export interface ChangedViewOptions {
  margin?: number;
  maxChars?: number;
  levelLabels?: Record<string, string>;
}

export interface ChangedView {
  levelId: LevelId;
  region: CellRect;
  text: string;
}

/**
 * ASCII views of every level that changed between `before` (null = new plan) and `after`.
 * `fits` is false when the total exceeds `maxChars`; `views` then holds what fitted, in level order.
 */
export function changedRegionViews(
  before: ResolvedPlan | null,
  after: ResolvedPlan,
  opts: ChangedViewOptions = {},
): { views: ChangedView[]; fits: boolean } {
  const margin = opts.margin ?? 3;
  const max = opts.maxChars ?? 4000;
  const views: ChangedView[] = [];
  let total = 0;
  let fits = true;
  for (const lvl of after.levels) {
    const prev = before?.levels.find((l) => l.id === lvl.id);
    const bb = changedBBox(prev, lvl);
    if (!bb) continue;
    const B = lvl.bounds;
    const x0 = Math.max(B.x, bb.x - margin);
    const y0 = Math.max(B.y, bb.y - margin);
    const x1 = Math.min(B.x + B.w, bb.x + bb.w + margin);
    const y1 = Math.min(B.y + B.h, bb.y + bb.h + margin);
    const region = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const text = `LEVEL ${lvl.id} region ${region.x},${region.y} ${region.w}x${region.h}\n${asciiLevel(lvl, after, { region, ...(opts.levelLabels ? { levelLabels: opts.levelLabels } : {}) })}`;
    if (total + text.length > max) {
      fits = false;
      continue;
    }
    total += text.length;
    views.push({ levelId: lvl.id, region, text });
  }
  return { views, fits };
}
