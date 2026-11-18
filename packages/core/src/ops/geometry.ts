/**
 * Small geometric helpers for edit ops: translating elements and an approximate "cell is inside this area's
 * shape" test (used to decide which features/labels/openings travel with an area on move/duplicate).
 *
 * Membership follows the §2.4 rasterization rule (cell centre inside) for rect, polygon, circle, ellipse, cells
 * and path. blob uses its base circle and cave its rect (their exact cells need the generators); route areas carry
 * no contents. Painter-order overrides by later areas are ignored.
 */
import type { Shape, TerrainOp, Vec2 } from "../contracts/plan";

export const tr = (v: Vec2, dx: number, dy: number): Vec2 => [v[0] + dx, v[1] + dy];

export function translateShape(shape: Shape, dx: number, dy: number): Shape {
  switch (shape.type) {
    case "rect":
    case "cave":
    case "cells":
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
    case "polygon":
    case "path":
      return { ...shape, points: shape.points.map((p) => tr(p, dx, dy)) };
    case "circle":
    case "ellipse":
    case "blob":
      return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy };
    case "route":
      return {
        ...shape,
        from: typeof shape.from === "string" ? shape.from : tr(shape.from, dx, dy),
        to: typeof shape.to === "string" ? shape.to : tr(shape.to, dx, dy),
      };
  }
}

export function translateTerrain(op: TerrainOp, dx: number, dy: number): TerrainOp {
  switch (op.op) {
    case "paint":
    case "height":
    case "noise":
      return { ...op, shape: translateShape(op.shape, dx, dy) };
    case "path":
      return { ...op, points: op.points.map((p) => tr(p, dx, dy)) };
    case "scatter": {
      const out = { ...op };
      if (op.shape !== undefined) out.shape = translateShape(op.shape, dx, dy);
      if (op.exclude !== undefined) out.exclude = op.exclude.map((s) => translateShape(s, dx, dy));
      return out;
    }
    case "dress":
      return { ...op };
  }
}

function pointInPolygon(px: number, py: number, pts: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i] as Vec2;
    const b = pts[j] as Vec2;
    if (a[1] > py !== b[1] > py && px < ((b[0] - a[0]) * (py - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}

/** Approximate membership of cell (x, y) in a shape (see module doc). */
export function shapeHasCell(shape: Shape, x: number, y: number): boolean {
  const cx = x + 0.5;
  const cy = y + 0.5;
  switch (shape.type) {
    case "rect":
    case "cave":
      return x >= shape.x && x < shape.x + shape.w && y >= shape.y && y < shape.y + shape.h;
    case "polygon":
      return pointInPolygon(cx, cy, shape.points);
    case "circle":
    case "blob": {
      const dx = cx - shape.cx;
      const dy = cy - shape.cy;
      return dx * dx + dy * dy <= shape.r * shape.r;
    }
    case "ellipse": {
      const dx = (cx - shape.cx) / shape.rx;
      const dy = (cy - shape.cy) / shape.ry;
      return dx * dx + dy * dy <= 1;
    }
    case "cells":
      return shape.rows[y - shape.y]?.[x - shape.x] === "#";
    case "path": {
      const w = shape.width ?? 1;
      const lo = Math.floor((w - 1) / 2);
      const hi = w - 1 - lo;
      const pts = shape.points;
      if (pts.length === 1) {
        const p = pts[0] as Vec2;
        return x >= p[0] - lo && x <= p[0] + hi && y >= p[1] - lo && y <= p[1] + hi;
      }
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1] as Vec2;
        const b = pts[i] as Vec2;
        const x0 = Math.min(a[0], b[0]) - lo;
        const x1 = Math.max(a[0], b[0]) + hi;
        const y0 = Math.min(a[1], b[1]) - lo;
        const y1 = Math.max(a[1], b[1]) + hi;
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
      }
      return false;
    }
    case "route":
      return false;
  }
}

/** Neighbour cell across `side`. */
export function across(x: number, y: number, side: "N" | "E" | "S" | "W"): Vec2 {
  switch (side) {
    case "N":
      return [x, y - 1];
    case "S":
      return [x, y + 1];
    case "E":
      return [x + 1, y];
    case "W":
      return [x - 1, y];
  }
}
