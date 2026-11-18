/**
 * Pure hit-testing and selection (architecture §5.4): no DOM. Points and rects are in global cell units.
 * Priority: feature > opening (within 0.2 cell of its edge) > link > area > cell.
 */
import type { AreaId, LevelId } from "../contracts/plan";
import type {
  DisplayContext,
  DisplayItem,
  HitTarget,
  MapSelection,
  ResolvedLevel,
  ResolvedLink,
  ResolvedOpening,
} from "../contracts/resolved";

/** Contract DisplayContext (links are needed to report link hits) plus the opening tolerance. */
export interface HitContext extends DisplayContext {
  /** Opening hit tolerance in cells (default 0.2). */
  openingTolerance?: number;
}

function linkCells(link: ResolvedLink, levelId: LevelId): ReadonlyArray<readonly [number, number]> {
  if (link.fromLevel === levelId) return link.lowerCells;
  if (link.toLevel === levelId) return link.upperCells;
  return [];
}

function openingSegment(o: ResolvedOpening): [number, number, number, number] {
  const [x, y] = o.start;
  return o.orientation === "h" ? [x, y, x + o.width, y] : [x, y, x, y + o.width];
}

function distToSegment(px: number, py: number, s: [number, number, number, number]): number {
  const [x0, y0, x1, y1] = s;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  const qx = x0 + t * dx - px;
  const qy = y0 + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

export function hitTest(
  level: ResolvedLevel,
  point: readonly [number, number],
  ctx: HitContext = {},
): HitTarget | null {
  const [px, py] = point;
  const B = level.bounds;
  if (px < B.x || py < B.y || px >= B.x + B.w || py >= B.y + B.h) return null;
  for (let k = level.features.length - 1; k >= 0; k--) {
    const f = level.features[k];
    if (!f) continue;
    if (px >= f.at[0] && px < f.at[0] + f.size[0] && py >= f.at[1] && py < f.at[1] + f.size[1]) {
      return f.area !== undefined
        ? { kind: "feature", id: f.id, area: f.area }
        : { kind: "feature", id: f.id };
    }
  }
  const tol = ctx.openingTolerance ?? 0.2;
  for (const o of level.openings)
    if (distToSegment(px, py, openingSegment(o)) <= tol) return { kind: "opening", id: o.id };
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  for (const link of ctx.links ?? []) {
    if (linkCells(link, level.id).some((c) => c[0] === cx && c[1] === cy))
      return { kind: "link", id: link.id };
  }
  const i = (cy - B.y) * B.w + (cx - B.x);
  const a = level.cells.area[i] ?? 0;
  if (a > 0) return { kind: "area", id: level.areaIds[a - 1] as AreaId };
  return { kind: "cell", cell: [cx, cy] };
}

/** Everything touching a cell rect (rubber band / region chip). */
export function selectRect(
  level: ResolvedLevel,
  rect: { x: number; y: number; w: number; h: number },
  ctx: HitContext = {},
): MapSelection {
  const B = level.bounds;
  const x0 = Math.max(B.x, Math.floor(rect.x));
  const y0 = Math.max(B.y, Math.floor(rect.y));
  const x1 = Math.min(B.x + B.w, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(B.y + B.h, Math.ceil(rect.y + rect.h));
  const areas = new Set<number>();
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const a = level.cells.area[(y - B.y) * B.w + (x - B.x)] ?? 0;
      if (a > 0) areas.add(a - 1);
    }
  const overlaps = (ax: number, ay: number, aw: number, ah: number): boolean =>
    ax < x1 && ax + aw > x0 && ay < y1 && ay + ah > y0;
  return {
    levelId: level.id,
    areaIds: [...areas].sort((p, q) => p - q).map((k) => level.areaIds[k] as AreaId),
    featureIds: level.features
      .filter((f) => overlaps(f.at[0], f.at[1], f.size[0], f.size[1]))
      .map((f) => f.id),
    openingIds: level.openings
      .filter((o) => {
        const [sx, sy, ex, ey] = openingSegment(o);
        return sx <= x1 && ex >= x0 && sy <= y1 && ey >= y0;
      })
      .map((o) => o.id),
    linkIds: (ctx.links ?? [])
      .filter((l) => linkCells(l, level.id).some((c) => overlaps(c[0], c[1], 1, 1)))
      .map((l) => l.id),
    rect: { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) },
  };
}

/**
 * Selection / hover overlay items (layer "selection") for the given ids. The view appends them to the level's
 * display list (or draws them as a second list) so selection changes never rebuild the base list.
 * Styles: "<mode>-area" (tint + outline), "<mode>-feature" (outline), "select-rect".
 */
export function selectionItems(
  level: ResolvedLevel,
  sel: Partial<Pick<MapSelection, "areaIds" | "featureIds" | "openingIds" | "linkIds" | "rect">>,
  mode: "select" | "hover" = "select",
  ctx: HitContext = {},
): DisplayItem[] {
  const out: DisplayItem[] = [];
  const rectRing = (x: number, y: number, w: number, h: number): number[] => [
    x,
    y,
    x + w,
    y,
    x + w,
    y + h,
    x,
    y + h,
  ];
  for (const id of sel.areaIds ?? []) {
    const a = level.areas.find((r) => r.id === id);
    if (!a || a.outline.length === 0) continue;
    out.push({
      layer: "selection",
      style: `${mode}-area`,
      geom: { rings: a.outline.map((r) => r.flatMap((p) => [p[0], p[1]])), closed: true },
      ref: id,
    });
  }
  for (const id of sel.featureIds ?? []) {
    const f = level.features.find((r) => r.id === id);
    if (f)
      out.push({
        layer: "selection",
        style: `${mode}-feature`,
        geom: { rings: [rectRing(f.at[0], f.at[1], f.size[0], f.size[1])], closed: true },
        ref: id,
      });
  }
  for (const id of sel.openingIds ?? []) {
    const o = level.openings.find((r) => r.id === id);
    if (!o) continue;
    const [sx, sy, ex, ey] = openingSegment(o);
    const r = o.orientation === "h" ? rectRing(sx, sy - 0.5, ex - sx, 1) : rectRing(sx - 0.5, sy, 1, ey - sy);
    out.push({ layer: "selection", style: `${mode}-feature`, geom: { rings: [r], closed: true }, ref: id });
  }
  for (const id of sel.linkIds ?? []) {
    const l = (ctx.links ?? []).find((r) => r.id === id);
    if (!l) continue;
    const rings = linkCells(l, level.id).map((c) => rectRing(c[0], c[1], 1, 1));
    if (rings.length > 0)
      out.push({ layer: "selection", style: `${mode}-feature`, geom: { rings, closed: true }, ref: id });
  }
  if (sel.rect)
    out.push({
      layer: "selection",
      style: "select-rect",
      geom: { rings: [rectRing(sel.rect.x, sel.rect.y, sel.rect.w, sel.rect.h)], closed: true },
    });
  return out;
}
