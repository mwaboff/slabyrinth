/**
 * The viewer's camera: an orbit about a target (compass bearing and elevation, as scene3d's shots), with limits that
 * keep the user from getting lost at any map size (never under the ground, never so far the map is a dot, the
 * target never wanders off the map), zoom toward the cursor, pan in the ground plane, fly, framing a box the way the
 * software shots frame it, and interruptible animated moves.
 */
import type { Box3, Vec3 } from "@slabyrinth/scene3d";

/** Degrees of vertical field of view (scene3d's perspective default). */
export const FOV_DEG = 45;
/** Elevation limits: the camera is always above its target and never exactly overhead (the basis stays defined). */
export const MIN_PITCH = 4;
export const MAX_PITCH = 89.5;
/** Closest the camera comes to its target (tiles). */
export const MIN_DISTANCE = 1.5;
/** The eye stays this far above the ground (tiles). */
export const EYE_CLEARANCE = 0.25;

/** Where the camera is: the point it orbits, how far, from which compass bearing (0 north, 90 east) and how high. */
export interface CameraView {
  target: Vec3;
  distance: number;
  /** Compass bearing from the target to the camera, degrees. */
  bearing: number;
  /** Elevation of the camera above the target's horizon, degrees. */
  elevation: number;
}

export interface CameraLimits {
  /** World y of the ground (the scene's lowest point). */
  ground: number;
  /** The box the target is kept in (the scene grown by a margin). */
  box: Box3;
  minDistance: number;
  /** Beyond this the map would be a dot. */
  maxDistance: number;
}

/** Limits for a scene's bounds (an empty scene: a 16-tile area at the origin). */
export function limitsFor(bounds: Box3): CameraLimits {
  const ok = Number.isFinite(bounds.min.x) && bounds.max.x >= bounds.min.x;
  const b = ok ? bounds : { min: { x: 0, y: 0, z: 0 }, max: { x: 16, y: 1, z: 16 } };
  const sx = b.max.x - b.min.x;
  const sy = b.max.y - b.min.y;
  const sz = b.max.z - b.min.z;
  const radius = Math.max(4, Math.hypot(sx, sy, sz) / 2);
  const pad = Math.max(8, radius * 0.15);
  return {
    ground: b.min.y,
    box: {
      min: { x: b.min.x - pad, y: b.min.y, z: b.min.z - pad },
      max: { x: b.max.x + pad, y: b.max.y + pad, z: b.max.z + pad },
    },
    minDistance: MIN_DISTANCE,
    // the whole map's bounding sphere fills about a third of the picture height at the farthest
    maxDistance: (radius / Math.sin((FOV_DEG * Math.PI) / 360)) * 3,
  };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Wraps a bearing into 0..360. */
export function wrapBearing(b: number): number {
  const r = b % 360;
  return r < 0 ? r + 360 : r;
}

/** Puts a view inside the limits, in place; returns it. */
export function clampView(v: CameraView, lim: CameraLimits): CameraView {
  v.bearing = wrapBearing(v.bearing);
  v.elevation = clamp(v.elevation, MIN_PITCH, MAX_PITCH);
  v.distance = clamp(v.distance, lim.minDistance, lim.maxDistance);
  v.target.x = clamp(v.target.x, lim.box.min.x, lim.box.max.x);
  v.target.y = clamp(v.target.y, lim.ground, lim.box.max.y);
  v.target.z = clamp(v.target.z, lim.box.min.z, lim.box.max.z);
  // the target is on or above the ground and the elevation positive, so the eye is too; keep a clearance
  const eyeY = v.target.y + v.distance * Math.sin((v.elevation * Math.PI) / 180);
  if (eyeY < lim.ground + EYE_CLEARANCE) v.target.y = lim.ground + EYE_CLEARANCE;
  return v;
}

/** The eye position of a view (scene3d `directionFrom`: x = cos e sin b, y = sin e, z = cos e cos b). */
export function eyeOf(v: CameraView, out: Vec3): Vec3 {
  const b = (v.bearing * Math.PI) / 180;
  const e = (v.elevation * Math.PI) / 180;
  out.x = v.target.x + Math.cos(e) * Math.sin(b) * v.distance;
  out.y = v.target.y + Math.sin(e) * v.distance;
  out.z = v.target.z + Math.cos(e) * Math.cos(b) * v.distance;
  return out;
}

export function copyView(from: CameraView, to: CameraView): CameraView {
  to.target.x = from.target.x;
  to.target.y = from.target.y;
  to.target.z = from.target.z;
  to.distance = from.distance;
  to.bearing = from.bearing;
  to.elevation = from.elevation;
  return to;
}

export const newView = (): CameraView => ({
  target: { x: 0, y: 0, z: 0 },
  distance: 10,
  bearing: 225,
  elevation: 35,
});

/**
 * The view that frames `box` from a bearing and elevation, as scene3d's `frameBox` does in perspective (the box's
 * bounding sphere fills the narrower field of view, with a 4% margin): the viewer's "frame all" and the software
 * overview agree on what is in the picture.
 */
export function frameView(
  box: Box3,
  bearing: number,
  elevation: number,
  aspect: number,
  out: CameraView,
  margin = 0.04,
): CameraView {
  const ok = Number.isFinite(box.min.x) && box.max.x >= box.min.x;
  const b = ok ? box : { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  const radius = Math.max(0.5, Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) / 2);
  const vFov = (FOV_DEG * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  out.target.x = (b.min.x + b.max.x) / 2;
  out.target.y = (b.min.y + b.max.y) / 2;
  out.target.z = (b.min.z + b.max.z) / 2;
  out.distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * (1 + margin);
  out.bearing = bearing;
  out.elevation = elevation;
  return out;
}

/** Turns the camera about its target. */
export function orbitView(v: CameraView, dBearing: number, dElevation: number): void {
  v.bearing += dBearing;
  v.elevation += dElevation;
}

/** World units one screen pixel covers at the target's distance. */
export function unitsPerPixel(v: CameraView, viewportHeight: number): number {
  return (2 * v.distance * Math.tan((FOV_DEG * Math.PI) / 360)) / Math.max(1, viewportHeight);
}

/**
 * Moves the target in the ground plane so the ground follows the pointer: `dx` right and `dy` down in pixels. A
 * low camera moves the target further per pixel of vertical drag (the ground is foreshortened).
 */
export function panView(v: CameraView, dx: number, dy: number, viewportHeight: number): void {
  const s = unitsPerPixel(v, viewportHeight);
  const b = (v.bearing * Math.PI) / 180;
  // camera right (horizontal) and forward (horizontal, away from the camera)
  const rx = -Math.cos(b);
  const rz = Math.sin(b);
  const fx = -Math.sin(b);
  const fz = -Math.cos(b);
  const fore = 1 / Math.max(0.35, Math.sin((v.elevation * Math.PI) / 180));
  v.target.x += -rx * dx * s + fx * dy * s * fore;
  v.target.z += -rz * dx * s + fz * dy * s * fore;
}

/** Moves the target along the camera's horizontal forward and right and world up (world units). */
export function flyView(v: CameraView, forward: number, right: number, up: number): void {
  const b = (v.bearing * Math.PI) / 180;
  v.target.x += -Math.sin(b) * forward - Math.cos(b) * right;
  v.target.z += -Math.cos(b) * forward + Math.sin(b) * right;
  v.target.y += up;
}

/**
 * Zooms by `factor` (< 1 nearer) about the world point `p`: the point stays under the cursor, as the eye and target
 * both scale toward it. Distance limits apply to the factor first, so a clamped zoom does not slide the target.
 */
export function zoomViewAbout(v: CameraView, p: Vec3 | null, factor: number, lim: CameraLimits): void {
  const d = clamp(v.distance * factor, lim.minDistance, lim.maxDistance);
  const k = d / v.distance;
  if (p) {
    v.target.x = p.x + (v.target.x - p.x) * k;
    v.target.y = p.y + (v.target.y - p.y) * k;
    v.target.z = p.z + (v.target.z - p.z) * k;
  }
  v.distance = d;
}

/** Keyboard fly speed in tiles per second: proportional to the distance so it feels the same at any zoom. */
export function flySpeed(v: CameraView, fast: boolean): number {
  return Math.max(4, v.distance * 0.9) * (fast ? 4 : 1);
}

/** Near and far planes for the scene box seen from `eye`: tight, so depth stays precise at map scale. */
export function clipPlanes(
  eyeDistToBounds: number,
  farthestToBounds: number,
  distance: number,
): { near: number; far: number } {
  const far = Math.max(farthestToBounds, distance) * 1.02 + 1;
  // as near as the closest thing may be, but never so near that the depth range wastes its precision
  const near = clamp(Math.max(eyeDistToBounds * 0.8, distance * 0.02), 0.03, far / 4);
  return { near, far };
}

/** An animated move from one view to another (eased, shortest way round, distance in log space). */
export interface Tween {
  from: CameraView;
  to: CameraView;
  startMs: number;
  durationMs: number;
}

export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/** The view of a tween at `nowMs`, into `out`; returns true when the tween has ended. */
export function tweenAt(t: Tween, nowMs: number, out: CameraView): boolean {
  const raw = t.durationMs <= 0 ? 1 : (nowMs - t.startMs) / t.durationMs;
  if (raw >= 1) {
    copyView(t.to, out);
    return true;
  }
  const u = easeOutCubic(clamp(raw, 0, 1));
  const lerp = (a: number, b: number): number => a + (b - a) * u;
  out.target.x = lerp(t.from.target.x, t.to.target.x);
  out.target.y = lerp(t.from.target.y, t.to.target.y);
  out.target.z = lerp(t.from.target.z, t.to.target.z);
  out.distance = Math.exp(lerp(Math.log(t.from.distance), Math.log(t.to.distance)));
  let db = wrapBearing(t.to.bearing) - wrapBearing(t.from.bearing);
  if (db > 180) db -= 360;
  if (db < -180) db += 360;
  out.bearing = wrapBearing(t.from.bearing + db * u);
  out.elevation = lerp(t.from.elevation, t.to.elevation);
  return raw >= 1;
}
