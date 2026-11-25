/**
 * Cameras: the view basis of an eye and a target, and framing a world box from a compass bearing and an elevation
 * (orthographic: the box fills the picture; perspective: its bounding sphere does).
 */
import type { Box3, Camera, Vec3 } from "../types/index";

export interface ViewBasis {
  eye: Vec3;
  /** Unit vectors: screen right, screen up, and forward (into the picture). */
  right: Vec3;
  up: Vec3;
  fwd: Vec3;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
function unit(v: Vec3): Vec3 {
  const n = Math.hypot(v.x, v.y, v.z);
  return n === 0 ? { x: 0, y: 0, z: 1 } : { x: v.x / n, y: v.y / n, z: v.z / n };
}

/** The basis of a camera: up is world up, or north when looking straight down or up (north at the top). */
export function viewBasis(cam: Camera): ViewBasis {
  const fwd = unit(sub(cam.target, cam.eye));
  const hint = Math.abs(fwd.y) > 0.999 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const right = unit(cross(hint, fwd));
  const up = cross(fwd, right);
  return { eye: cam.eye, right, up, fwd };
}

/** Unit vector from a target toward a camera at compass `bearingDeg` (0 north, 90 east) and `elevationDeg` up. */
export function directionFrom(bearingDeg: number, elevationDeg: number): Vec3 {
  const b = (bearingDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  return { x: Math.cos(e) * Math.sin(b), y: Math.sin(e), z: Math.cos(e) * Math.cos(b) };
}

export interface FrameOptions {
  bearingDeg: number;
  elevationDeg: number;
  projection: Camera["projection"];
  width: number;
  height: number;
  /** Vertical field of view for perspective (default 45). */
  fovDeg?: number;
  /** Extra room round the box, as a fraction (default 0.04). */
  margin?: number;
}

const corners = (b: Box3): Vec3[] => {
  const out: Vec3[] = [];
  for (const x of [b.min.x, b.max.x])
    for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) out.push({ x, y, z });
  return out;
};

/** A box that is never empty or infinite (an empty scene frames a tile at the origin). */
export function finiteBox(b: Box3): Box3 {
  return Number.isFinite(b.min.x) && b.max.x >= b.min.x
    ? b
    : { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
}

/** A camera that frames `box` seen from the bearing and elevation given. */
export function frameBox(box: Box3, o: FrameOptions): Camera {
  const b = finiteBox(box);
  const fovDeg = o.fovDeg ?? 45;
  const margin = o.margin ?? 0.04;
  const c = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
  const radius = Math.max(0.5, Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) / 2);
  const dir = directionFrom(o.bearingDeg, o.elevationDeg);
  if (o.projection === "persp") {
    const vFov = (fovDeg * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (o.width / o.height));
    const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * (1 + margin);
    const eye = { x: c.x + dir.x * dist, y: c.y + dir.y * dist, z: c.z + dir.z * dist };
    return { projection: "persp", eye, target: c, fovDeg, halfHeight: radius };
  }
  const far = radius * 2 + 10;
  const eye0 = { x: c.x + dir.x * far, y: c.y + dir.y * far, z: c.z + dir.z * far };
  const basis = viewBasis({ projection: "ortho", eye: eye0, target: c, fovDeg, halfHeight: 1 });
  let r0 = Infinity;
  let r1 = -Infinity;
  let u0 = Infinity;
  let u1 = -Infinity;
  for (const p of corners(b)) {
    const d = sub(p, c);
    const r = dot(d, basis.right);
    const u = dot(d, basis.up);
    r0 = Math.min(r0, r);
    r1 = Math.max(r1, r);
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
  }
  const rm = (r0 + r1) / 2;
  const um = (u0 + u1) / 2;
  const shift = {
    x: basis.right.x * rm + basis.up.x * um,
    y: basis.right.y * rm + basis.up.y * um,
    z: basis.right.z * rm + basis.up.z * um,
  };
  const halfHeight = Math.max((u1 - u0) / 2, ((r1 - r0) / 2) * (o.height / o.width), 0.5) * (1 + margin);
  return {
    projection: "ortho",
    eye: { x: eye0.x + shift.x, y: eye0.y + shift.y, z: eye0.z + shift.z },
    target: { x: c.x + shift.x, y: c.y + shift.y, z: c.z + shift.z },
    fovDeg,
    halfHeight,
  };
}
