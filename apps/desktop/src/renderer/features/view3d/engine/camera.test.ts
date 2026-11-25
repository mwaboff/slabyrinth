import { describe, expect, it } from "vitest";
import { frameBox, viewBasis, type Box3 } from "@slabyrinth/scene3d";
import {
  EYE_CLEARANCE,
  MAX_PITCH,
  MIN_PITCH,
  clampView,
  clipPlanes,
  eyeOf,
  frameView,
  limitsFor,
  newView,
  panView,
  tweenAt,
  zoomViewAbout,
} from "./camera";
import { basisInto, boxInFrustum, frustumInto, rayBox, viewProjInto } from "./math";

const MAP: Box3 = { min: { x: 0, y: 0, z: 0 }, max: { x: 1024, y: 24, z: 1024 } };

function project(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  const cx = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
  const cy = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
  const cz = (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0);
  const cw = (m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[11] ?? 0) * z + (m[15] ?? 0);
  return [cx / cw, cy / cw, cz / cw];
}

describe("camera maths", () => {
  it("uses scene3d's view basis (same up rule, also straight down)", () => {
    for (const [eye, target] of [
      [
        { x: 10, y: 8, z: -4 },
        { x: 0, y: 0, z: 0 },
      ],
      [
        { x: 5, y: 50, z: 5 },
        { x: 5, y: 0, z: 5 },
      ],
    ] as const) {
      const ref = viewBasis({ projection: "persp", eye, target, fovDeg: 45, halfHeight: 1 });
      const b = new Float64Array(9);
      basisInto(b, eye.x, eye.y, eye.z, target.x, target.y, target.z);
      expect([...b].map((v) => +v.toFixed(9) + 0)).toEqual(
        [ref.right, ref.up, ref.fwd].flatMap((v) => [v.x, v.y, v.z]).map((v) => +v.toFixed(9) + 0),
      );
    }
  });

  it("frames the map like scene3d's perspective frameBox", () => {
    const v = frameView(MAP, 225, 35, 16 / 9, newView());
    const ref = frameBox(MAP, {
      bearingDeg: 225,
      elevationDeg: 35,
      projection: "persp",
      width: 1600,
      height: 900,
    });
    const eye = eyeOf(v, { x: 0, y: 0, z: 0 });
    expect(eye.x).toBeCloseTo(ref.eye.x, 6);
    expect(eye.y).toBeCloseTo(ref.eye.y, 6);
    expect(eye.z).toBeCloseTo(ref.eye.z, 6);
  });

  it("projects the target to the picture centre, east to the right looking north", () => {
    const v = { target: { x: 10, y: 0, z: 10 }, distance: 20, bearing: 180, elevation: 30 };
    const eye = eyeOf(v, { x: 0, y: 0, z: 0 });
    const b = new Float64Array(9);
    basisInto(b, eye.x, eye.y, eye.z, 10, 0, 10);
    const m = new Float32Array(16);
    viewProjInto(m, b, eye.x, eye.y, eye.z, 45, 1.5, 0.1, 500);
    const c = project(m, 10, 0, 10);
    expect(c[0]).toBeCloseTo(0, 5);
    expect(c[1]).toBeCloseTo(0, 5);
    expect(project(m, 12, 0, 10)[0]).toBeGreaterThan(0);
    const planes = new Float64Array(24);
    frustumInto(planes, m);
    expect(boxInFrustum(planes, new Float32Array([9, 0, 9, 11, 1, 11]), 0)).toBe(true);
    // behind the camera (south of the eye)
    expect(boxInFrustum(planes, new Float32Array([9, 0, -100, 11, 1, -90]), 0)).toBe(false);
    // far beyond the far plane
    expect(boxInFrustum(planes, new Float32Array([9, 0, 900, 11, 1, 910]), 0)).toBe(false);
  });

  it("keeps the user from getting lost", () => {
    const lim = limitsFor(MAP);
    const v = { target: { x: -5000, y: -40, z: 99999 }, distance: 1e9, bearing: -30, elevation: -20 };
    clampView(v, lim);
    expect(v.elevation).toBe(MIN_PITCH);
    expect(v.distance).toBe(lim.maxDistance);
    expect(v.target.x).toBeGreaterThanOrEqual(lim.box.min.x);
    expect(v.target.z).toBeLessThanOrEqual(lim.box.max.z);
    expect(v.bearing).toBe(330);
    const eye = eyeOf(v, { x: 0, y: 0, z: 0 });
    expect(eye.y).toBeGreaterThanOrEqual(lim.ground + EYE_CLEARANCE);
    // the farthest view still shows the map at a readable size: the map's sphere fills ≥ 1/4 of the height
    const radius = Math.hypot(1024, 24, 1024) / 2;
    const fraction = Math.atan(radius / lim.maxDistance) / ((45 * Math.PI) / 360);
    expect(fraction).toBeGreaterThan(0.25);
    clampView(Object.assign(v, { elevation: 120, distance: 0 }), lim);
    expect(v.elevation).toBe(MAX_PITCH);
    expect(v.distance).toBe(lim.minDistance);
  });

  it("zooms about the point under the cursor (the point stays on the same line of sight)", () => {
    const lim = limitsFor(MAP);
    const v = { target: { x: 500, y: 0, z: 500 }, distance: 200, bearing: 225, elevation: 40 };
    const p = { x: 540, y: 0, z: 470 };
    const e0 = eyeOf(v, { x: 0, y: 0, z: 0 });
    const dir0 = [p.x - e0.x, p.y - e0.y, p.z - e0.z].map((c, _, a) => c / Math.hypot(...a));
    zoomViewAbout(v, p, 0.5, lim);
    const e1 = eyeOf(v, { x: 0, y: 0, z: 0 });
    const dir1 = [p.x - e1.x, p.y - e1.y, p.z - e1.z].map((c, _, a) => c / Math.hypot(...a));
    expect(v.distance).toBe(100);
    dir0.forEach((c, i) => {
      expect(dir1[i]).toBeCloseTo(c, 9);
    });
    // a clamped zoom does not slide the target
    const t = { ...v.target };
    zoomViewAbout(v, p, 1e-9, lim);
    expect(v.distance).toBe(lim.minDistance);
    expect(v.target.x).not.toBe(t.x);
    const before = { ...v.target };
    zoomViewAbout(v, p, 0.5, lim);
    expect(v.target).toEqual(before);
  });

  it("pans in the ground plane, the ground following the pointer", () => {
    const v = { target: { x: 0, y: 0, z: 0 }, distance: 10, bearing: 180, elevation: 90 };
    // looking north from the south: dragging right moves the target west
    panView(v, 100, 0, 1000);
    expect(v.target.x).toBeLessThan(0);
    expect(v.target.z).toBeCloseTo(0, 9);
    const w = { target: { x: 0, y: 0, z: 0 }, distance: 10, bearing: 180, elevation: 90 };
    panView(w, 0, 100, 1000);
    expect(w.target.z).toBeGreaterThan(0);
  });

  it("animates the shortest way round and ends exactly at the destination", () => {
    const from = { target: { x: 0, y: 0, z: 0 }, distance: 10, bearing: 350, elevation: 30 };
    const to = { target: { x: 10, y: 0, z: 0 }, distance: 1000, bearing: 10, elevation: 60 };
    const out = newView();
    expect(tweenAt({ from, to, startMs: 0, durationMs: 100 }, 50, out)).toBe(false);
    expect(out.bearing > 350 || out.bearing < 10).toBe(true);
    expect(out.distance).toBeLessThan(1000);
    expect(tweenAt({ from, to, startMs: 0, durationMs: 100 }, 100, out)).toBe(true);
    expect(out).toEqual(to);
  });

  it("chooses tight clip planes at map scale", () => {
    const near = clipPlanes(0, 1500, 5);
    expect(near.near).toBeLessThanOrEqual(0.1);
    expect(near.far).toBeGreaterThan(1500);
    const far = clipPlanes(2000, 3500, 3000);
    // depth precision: the ratio stays modest even from far away
    expect(far.far / far.near).toBeLessThan(100);
  });

  it("meets boxes with a ray (slab test)", () => {
    const box = new Float32Array([0, 0, 0, 1, 1, 1]);
    expect(rayBox(-1, 0.5, 0.5, 1, Infinity, Infinity, box, 0)).toBeCloseTo(1, 9);
    expect(rayBox(-1, 2, 0.5, 1, Infinity, Infinity, box, 0)).toBe(-1);
    expect(rayBox(0.5, 0.5, 0.5, 1, Infinity, Infinity, box, 0)).toBe(0);
  });
});
