/**
 * Resolver-independent shape facts: structural problems (degenerate polygons, diagonal path segments, ragged
 * masks…) and a conservative cell bounding box. Rasterization itself belongs to WP2's resolver.
 */
import type { Shape, Vec2 } from "../contracts/plan";
import { maxOf, minOf } from "../util/lists";

export interface CellBox {
  x0: number;
  y0: number;
  /** Exclusive. */
  x1: number;
  y1: number;
}

/** Conservative bbox of cells the shape may cover (null for routes: depends on area anchors). */
export function shapeCellBox(shape: Shape): CellBox | null {
  switch (shape.type) {
    case "rect":
    case "cave":
      return { x0: shape.x, y0: shape.y, x1: shape.x + shape.w, y1: shape.y + shape.h };
    case "polygon": {
      const xs = shape.points.map((p) => p[0]);
      const ys = shape.points.map((p) => p[1]);
      return { x0: minOf(xs), y0: minOf(ys), x1: maxOf(xs), y1: maxOf(ys) };
    }
    case "circle":
    case "blob": {
      const r = shape.type === "blob" ? shape.r * (1 + (shape.roughness ?? 0) / 2) : shape.r;
      return {
        x0: Math.floor(shape.cx - r),
        y0: Math.floor(shape.cy - r),
        x1: Math.ceil(shape.cx + r),
        y1: Math.ceil(shape.cy + r),
      };
    }
    case "ellipse":
      return {
        x0: Math.floor(shape.cx - shape.rx),
        y0: Math.floor(shape.cy - shape.ry),
        x1: Math.ceil(shape.cx + shape.rx),
        y1: Math.ceil(shape.cy + shape.ry),
      };
    case "cells": {
      const w = Math.max(0, maxOf(shape.rows.map((r) => r.length)));
      return { x0: shape.x, y0: shape.y, x1: shape.x + w, y1: shape.y + shape.rows.length };
    }
    case "path": {
      const w = shape.width ?? 1;
      const lo = Math.floor((w - 1) / 2);
      const hi = w - 1 - lo;
      const xs = shape.points.map((p) => p[0]);
      const ys = shape.points.map((p) => p[1]);
      return {
        x0: minOf(xs) - lo,
        y0: minOf(ys) - lo,
        x1: maxOf(xs) + hi + 1,
        y1: maxOf(ys) + hi + 1,
      };
    }
    case "route":
      return null;
  }
}

export function boxesIntersect(a: CellBox, b: CellBox): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Twice the signed area (shoelace). */
function area2(points: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Vec2;
    const b = points[(i + 1) % points.length] as Vec2;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

function orient(a: Vec2, b: Vec2, c: Vec2): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

export interface ShapeProblem {
  /** Relative pointer below the shape, e.g. "/points/2". */
  subPath: string;
  message: string;
  hint: string;
}

/** Index of the first consecutive pair that is not axis-aligned or repeats a point, or -1. */
function badPolylineStep(
  points: readonly Vec2[],
  requireAxis: boolean,
): { index: number; repeat: boolean } | null {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Vec2;
    const b = points[i] as Vec2;
    if (a[0] === b[0] && a[1] === b[1]) return { index: i, repeat: true };
    if (requireAxis && a[0] !== b[0] && a[1] !== b[1]) return { index: i, repeat: false };
  }
  return null;
}

/** Corner point making an L between a and b (horizontal leg first). */
function lCorner(a: Vec2, b: Vec2): Vec2 {
  return [b[0], a[1]];
}

/** Checks one polyline of points (paths, wall runs, terrain paths). */
export function polylineProblems(
  points: readonly Vec2[],
  requireAxis: boolean,
  what: string,
): ShapeProblem[] {
  const bad = badPolylineStep(points, requireAxis);
  if (bad === null) return [];
  const a = points[bad.index - 1] as Vec2;
  const b = points[bad.index] as Vec2;
  if (bad.repeat) {
    return [
      {
        subPath: `/points/${bad.index}`,
        message: `${what} repeats point [${a.join(",")}]`,
        hint: `remove points[${bad.index}]`,
      },
    ];
  }
  const c = lCorner(a, b);
  return [
    {
      subPath: `/points/${bad.index}`,
      message: `${what} segment [${a.join(",")}]→[${b.join(",")}] is diagonal; consecutive points must share x or y`,
      hint: `insert the corner [${c.join(",")}] between them`,
    },
  ];
}

/**
 * Structural problems of a shape (resolver-independent). `allowRoute` is false outside area shapes.
 */
export function shapeProblems(shape: Shape, allowRoute: boolean): ShapeProblem[] {
  switch (shape.type) {
    case "polygon": {
      const pts = shape.points;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i] as Vec2;
        const b = pts[(i + 1) % pts.length] as Vec2;
        if (a[0] === b[0] && a[1] === b[1]) {
          return [
            {
              subPath: `/points/${(i + 1) % pts.length}`,
              message: `polygon repeats vertex [${a.join(",")}]`,
              hint: "remove the repeated vertex",
            },
          ];
        }
      }
      if (area2(pts) === 0) {
        return [
          {
            subPath: "/points",
            message: "polygon has zero area (all points on one line)",
            hint: "use at least 3 points that are not collinear, e.g. a rect shape instead",
          },
        ];
      }
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          // Skip adjacent edges (they share a vertex).
          if (j === i + 1 || (i === 0 && j === n - 1)) continue;
          if (
            segmentsIntersect(
              pts[i] as Vec2,
              pts[(i + 1) % n] as Vec2,
              pts[j] as Vec2,
              pts[(j + 1) % n] as Vec2,
            )
          ) {
            return [
              {
                subPath: "/points",
                message: `polygon edges ${i}→${(i + 1) % n} and ${j}→${(j + 1) % n} cross; polygons must be simple`,
                hint: "reorder the points so the outline does not cross itself, or split it into two areas",
              },
            ];
          }
        }
      }
      return [];
    }
    case "path":
      return polylineProblems(shape.points, true, "path");
    case "cells": {
      const w = shape.rows[0]?.length ?? 0;
      const ragged = shape.rows.findIndex((r) => r.length !== w);
      if (ragged >= 0) {
        return [
          {
            subPath: `/rows/${ragged}`,
            message: `mask row ${ragged} has ${shape.rows[ragged]?.length ?? 0} chars; row 0 has ${w}`,
            hint: `pad every row to ${w} characters with '.'`,
          },
        ];
      }
      return [];
    }
    case "route": {
      if (!allowRoute) {
        return [
          {
            subPath: "/type",
            message: "route shapes are only valid as area shapes",
            hint: "use a path shape (axis-aligned points) or a terrain path op",
          },
        ];
      }
      const same =
        typeof shape.from === "string"
          ? shape.from === shape.to
          : typeof shape.to !== "string" && shape.from[0] === shape.to[0] && shape.from[1] === shape.to[1];
      if (same)
        return [
          {
            subPath: "/to",
            message: "route starts and ends at the same place",
            hint: "route between two different areas or cells",
          },
        ];
      return [];
    }
    default:
      return [];
  }
}
