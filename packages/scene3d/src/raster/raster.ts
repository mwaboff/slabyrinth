/**
 * The software rasteriser: one thread, a z-buffer and an id buffer, flat two-sided Lambert shading with one fixed
 * light, one colour per piece, and a dark outline wherever the piece under a pixel changes (so piece boundaries and
 * gaps show). Orthographic or perspective. Deterministic: the same scene and shot give the same bytes (no time, no
 * randomness, a fixed order of work).
 *
 * Cheap level of detail: a piece whose box covers fewer than LOD_BOX_PX pixels on screen is drawn as its box (12
 * triangles), and a piece wholly outside the picture is skipped.
 */
import type {
  Box3,
  Camera,
  Cutaway,
  MeshData,
  RenderedImage,
  Rgb,
  Scene,
  SceneInstance,
  ShotSpec,
  Vec3,
} from "../types/index";
import { turnBasis } from "@slabyrinth/core";
import { emptyBox, growBox, storeyOf } from "../geom/box";
import { cuboid, meshBox } from "../geom/mesh";
import { viewBasis } from "./camera";

/** A piece smaller than this on screen (pixels, longer side of its projected box) is drawn as its box. */
export const LOD_BOX_PX = 3;
/** Perspective near plane (tiles): a triangle with a corner nearer than this is cut at it (clipNear). */
export const NEAR_PLANE = 0.05;
const NEAR = NEAR_PLANE;
const LIGHT = (() => {
  const l = { x: -0.45, y: 0.8, z: -0.35 };
  const n = Math.hypot(l.x, l.y, l.z);
  return { x: l.x / n, y: l.y / n, z: l.z / n };
})();
export const BACKGROUND: Rgb = [30, 32, 38];
/** How much an outline pixel keeps of its colour. */
const OUTLINE = 0.62;

/** Is the instance shown under the cutaway? */
export function shown(inst: SceneInstance, cut: Cutaway): boolean {
  if (cut.maxLevelIndex !== undefined && inst.levelIndex > cut.maxLevelIndex) return false;
  if (cut.hideLayers?.includes(inst.layer)) return false;
  if (cut.maxStorey !== undefined) {
    const n = storeyOf(inst.layer);
    if (n !== null && n > cut.maxStorey) return false;
  }
  const w = cut.within;
  if (
    w &&
    (inst.aabb.max.x < w.minX ||
      inst.aabb.min.x > w.maxX ||
      inst.aabb.max.z < w.minZ ||
      inst.aabb.min.z > w.maxZ)
  )
    return false;
  return true;
}

/** The world box of the instances the cutaway shows (empty when none). */
export function shownBounds(scene: Scene, cut: Cutaway, keep?: (i: SceneInstance) => boolean): Box3 {
  const b: Box3 = emptyBox();
  for (const i of scene.instances) if (shown(i, cut) && (!keep || keep(i))) growBox(b, i.aabb);
  return b;
}

interface Projector {
  /** Writes screen x, y and the depth key (larger = nearer; NaN behind the near plane) of a world point. */
  project(x: number, y: number, z: number, out: Float64Array, at: number): void;
}

function projector(cam: Camera, width: number, height: number): Projector {
  const v = viewBasis(cam);
  const { eye, right: r, up: u, fwd: f } = v;
  const cx = width / 2;
  const cy = height / 2;
  if (cam.projection === "ortho") {
    const s = cy / cam.halfHeight;
    return {
      project(x, y, z, out, at) {
        const dx = x - eye.x;
        const dy = y - eye.y;
        const dz = z - eye.z;
        out[at] = cx + (dx * r.x + dy * r.y + dz * r.z) * s;
        out[at + 1] = cy - (dx * u.x + dy * u.y + dz * u.z) * s;
        out[at + 2] = -(dx * f.x + dy * f.y + dz * f.z);
      },
    };
  }
  const focal = cy / Math.tan((cam.fovDeg * Math.PI) / 360);
  return {
    project(x, y, z, out, at) {
      const dx = x - eye.x;
      const dy = y - eye.y;
      const dz = z - eye.z;
      const depth = dx * f.x + dy * f.y + dz * f.z;
      if (depth < NEAR) {
        out[at] = NaN;
        out[at + 1] = NaN;
        out[at + 2] = NaN;
        return;
      }
      const k = focal / depth;
      out[at] = cx + (dx * r.x + dy * r.y + dz * r.z) * k;
      out[at + 1] = cy - (dx * u.x + dy * u.y + dz * u.z) * k;
      out[at + 2] = 1 / depth;
    },
  };
}

/** Grows a scratch buffer to hold `n` values. */
function room(buf: Float64Array<ArrayBuffer>, n: number): Float64Array<ArrayBuffer> {
  return buf.length >= n ? buf : new Float64Array(Math.max(n, buf.length * 2));
}

/** Renders the scene for a shot (its camera, cutaway and size). */
export function renderScene(
  scene: Scene,
  shot: Pick<ShotSpec, "camera" | "cutaway" | "width" | "height">,
  opts: {
    background?: Rgb;
    /**
     * Draw only these instances (indexes; the others are not even looked at): a caller that knows which pieces can
     * show (those near a thing, from a plan hash) spares a walk over every piece of a huge map. The picture is the one
     * of all the pieces whenever the others would not have shown.
     */
    only?: readonly number[];
  } = {},
): RenderedImage {
  const W = Math.max(1, Math.round(shot.width));
  const H = Math.max(1, Math.round(shot.height));
  const bg = opts.background ?? BACKGROUND;
  const rgba = new Uint8Array(W * H * 4);
  for (let k = 0; k < W * H; k++) {
    rgba[k * 4] = bg[0];
    rgba[k * 4 + 1] = bg[1];
    rgba[k * 4 + 2] = bg[2];
    rgba[k * 4 + 3] = 255;
  }
  const depth = new Float32Array(W * H).fill(-Infinity);
  const idAt = new Int32Array(W * H).fill(-1);
  const proj = projector(shot.camera, W, H);
  const boxOf = new Map<string, MeshData>();
  const corner = new Float64Array(24);
  let screen = new Float64Array(3 * 1024);
  let world = new Float64Array(3 * 1024);
  let instancesDrawn = 0;
  let boxesDrawn = 0;
  let trianglesDrawn = 0;
  const vb = viewBasis(shot.camera);
  /** A triangle cut at the near plane: at most 4 corners, world (clip) and screen (cut). */
  const clip = new Float64Array(12);
  const cut = new Float64Array(12);

  /** Draws one screen triangle (x, y, depth key per corner) of piece `ii` in one colour, through the z-buffer. */
  const fill = (
    x0: number,
    y0: number,
    k0: number,
    x1: number,
    y1: number,
    k1: number,
    x2: number,
    y2: number,
    k2: number,
    ii: number,
    r: number,
    g: number,
    bl: number,
  ): void => {
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area === 0 || !Number.isFinite(area)) return;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minX > maxX || minY > maxY) return;
    // edge functions e0 (v1,v2), e1 (v2,v0): linear in the pixel centre; weights e/area, the third is 1 - w0 - w1
    const ia2 = 1 / area;
    const A0 = (y1 - y2) * ia2;
    const B0 = (x2 - x1) * ia2;
    const C0 = (x1 * y2 - x2 * y1) * ia2;
    const A1 = (y2 - y0) * ia2;
    const B1 = (x0 - x2) * ia2;
    const C1 = (x2 * y0 - x0 * y2) * ia2;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      let w0 = A0 * (minX + 0.5) + B0 * py + C0;
      let w1 = A1 * (minX + 0.5) + B1 * py + C1;
      let k = y * W + minX;
      for (let x = minX; x <= maxX; x++, k++, w0 += A0, w1 += A1) {
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * k0 + w1 * k1 + w2 * k2;
        if (d <= (depth[k] ?? Infinity)) continue;
        depth[k] = d;
        idAt[k] = ii;
        rgba[k * 4] = r;
        rgba[k * 4 + 1] = g;
        rgba[k * 4 + 2] = bl;
      }
    }
  };

  const order = opts.only ? [...opts.only].sort((p, q) => p - q) : null;
  const count = order ? order.length : scene.instances.length;
  for (let n = 0; n < count; n++) {
    const ii = order ? (order[n] ?? -1) : n;
    const inst = scene.instances[ii];
    if (!inst || !shown(inst, shot.cutaway)) continue;
    // cull and measure by the projected box
    const a = inst.aabb;
    let sx0 = Infinity;
    let sx1 = -Infinity;
    let sy0 = Infinity;
    let sy1 = -Infinity;
    let behind = 0;
    for (let c = 0; c < 8; c++) {
      proj.project(
        c & 1 ? a.max.x : a.min.x,
        c & 2 ? a.max.y : a.min.y,
        c & 4 ? a.max.z : a.min.z,
        corner,
        c * 3,
      );
      const x = corner[c * 3] ?? NaN;
      const y = corner[c * 3 + 1] ?? NaN;
      if (Number.isNaN(x)) {
        behind++;
        continue;
      }
      sx0 = Math.min(sx0, x);
      sx1 = Math.max(sx1, x);
      sy0 = Math.min(sy0, y);
      sy1 = Math.max(sy1, y);
    }
    if (behind === 8) continue;
    if (behind === 0 && (sx1 < 0 || sy1 < 0 || sx0 > W || sy0 > H)) continue;
    let mesh = scene.meshes.get(inst.meshKey);
    if (!mesh) continue;
    let asBox = inst.stand === "box";
    if (!asBox && behind === 0 && Math.max(sx1 - sx0, sy1 - sy0) < LOD_BOX_PX && mesh.indices.length > 36) {
      let b = boxOf.get(inst.meshKey);
      if (!b) boxOf.set(inst.meshKey, (b = localBoxMesh(mesh)));
      mesh = b;
      asBox = true;
    }
    instancesDrawn++;
    if (asBox) boxesDrawn++;
    // turn and move the vertices (core turnBasis: the one rounding, quarter turns exact), then project
    const { c: cs, s: sn } = turnBasis(inst.rotDeg);
    const P = mesh.positions;
    const nv = Math.floor(P.length / 3);
    screen = room(screen, nv * 3);
    world = room(world, nv * 3);
    for (let i = 0; i < nv; i++) {
      const lx = P[i * 3] ?? 0;
      const ly = P[i * 3 + 1] ?? 0;
      const lz = P[i * 3 + 2] ?? 0;
      const wx = lx * cs + lz * sn + inst.at.x;
      const wy = ly + inst.at.y;
      const wz = -lx * sn + lz * cs + inst.at.z;
      world[i * 3] = wx;
      world[i * 3 + 1] = wy;
      world[i * 3 + 2] = wz;
      proj.project(wx, wy, wz, screen, i * 3);
    }
    const [cr, cg, cb] = inst.colour;
    const I = mesh.indices;
    for (let ti = 0; ti + 2 < I.length; ti += 3) {
      const ia = (I[ti] ?? 0) * 3;
      const ib = (I[ti + 1] ?? 0) * 3;
      const ic = (I[ti + 2] ?? 0) * 3;
      const x0 = screen[ia] ?? NaN;
      const y0 = screen[ia + 1] ?? NaN;
      const k0 = screen[ia + 2] ?? NaN;
      const x1 = screen[ib] ?? NaN;
      const y1 = screen[ib + 1] ?? NaN;
      const k1 = screen[ib + 2] ?? NaN;
      const x2 = screen[ic] ?? NaN;
      const y2 = screen[ic + 1] ?? NaN;
      const k2 = screen[ic + 2] ?? NaN;
      const clipped = Number.isNaN(x0) || Number.isNaN(x1) || Number.isNaN(x2);
      if (!clipped) {
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (area === 0 || !Number.isFinite(area)) continue;
      }
      // world normal, for shading
      const ax = world[ia] ?? 0;
      const ay = world[ia + 1] ?? 0;
      const az = world[ia + 2] ?? 0;
      const e1x = (world[ib] ?? 0) - ax;
      const e1y = (world[ib + 1] ?? 0) - ay;
      const e1z = (world[ib + 2] ?? 0) - az;
      const e2x = (world[ic] ?? 0) - ax;
      const e2y = (world[ic + 1] ?? 0) - ay;
      const e2z = (world[ic + 2] ?? 0) - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const nl = Math.hypot(nx, ny, nz);
      if (nl === 0) continue;
      trianglesDrawn++;
      const lit = 0.34 + 0.66 * Math.abs((nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z) / nl);
      const r = Math.min(255, Math.round(cr * lit));
      const g = Math.min(255, Math.round(cg * lit));
      const bl = Math.min(255, Math.round(cb * lit));
      if (!clipped) {
        fill(x0, y0, k0, x1, y1, k1, x2, y2, k2, ii, r, g, bl);
        continue;
      }
      // a corner nearer than the near plane (a perspective shot inside a room): cut the triangle at the plane and
      // draw what is in front of it (one or two triangles), never drop it whole
      const n = clipNear(world, ia, ib, ic, vb, clip);
      for (let v = 0; v < n; v++)
        proj.project(clip[v * 3] ?? 0, clip[v * 3 + 1] ?? 0, clip[v * 3 + 2] ?? 0, cut, v * 3);
      for (let v = 1; v + 1 < n; v++)
        fill(
          cut[0] ?? NaN,
          cut[1] ?? NaN,
          cut[2] ?? NaN,
          cut[v * 3] ?? NaN,
          cut[v * 3 + 1] ?? NaN,
          cut[v * 3 + 2] ?? NaN,
          cut[v * 3 + 3] ?? NaN,
          cut[v * 3 + 4] ?? NaN,
          cut[v * 3 + 5] ?? NaN,
          ii,
          r,
          g,
          bl,
        );
    }
  }
  outline(rgba, idAt, W, H);
  return { width: W, height: H, rgba, idAt, stats: { instancesDrawn, boxesDrawn, trianglesDrawn } };
}

/**
 * The part of world triangle (a, b, c) (offsets into `world`) in front of the near plane, as a polygon of 0, 3 or 4
 * corners written to `out` (x, y, z each); returns the corner count. The plane sits a hair in front of NEAR, so every
 * corner it makes projects.
 */
function clipNear(
  world: Float64Array,
  a: number,
  b: number,
  c: number,
  v: { eye: Vec3; fwd: Vec3 },
  out: Float64Array,
): number {
  const plane = NEAR * (1 + 1e-6);
  const corners = [a, b, c];
  const depthOf = (o: number): number =>
    ((world[o] ?? 0) - v.eye.x) * v.fwd.x +
    ((world[o + 1] ?? 0) - v.eye.y) * v.fwd.y +
    ((world[o + 2] ?? 0) - v.eye.z) * v.fwd.z;
  let n = 0;
  const put = (x: number, y: number, z: number): void => {
    out[n * 3] = x;
    out[n * 3 + 1] = y;
    out[n * 3 + 2] = z;
    n++;
  };
  for (let i = 0; i < 3; i++) {
    const p = corners[i] ?? 0;
    const q = corners[(i + 1) % 3] ?? 0;
    const dp = depthOf(p) - plane;
    const dq = depthOf(q) - plane;
    if (dp >= 0) put(world[p] ?? 0, world[p + 1] ?? 0, world[p + 2] ?? 0);
    if (dp >= 0 !== dq >= 0) {
      const t = dp / (dp - dq);
      put(
        (world[p] ?? 0) + ((world[q] ?? 0) - (world[p] ?? 0)) * t,
        (world[p + 1] ?? 0) + ((world[q + 1] ?? 0) - (world[p + 1] ?? 0)) * t,
        (world[p + 2] ?? 0) + ((world[q + 2] ?? 0) - (world[p + 2] ?? 0)) * t,
      );
    }
  }
  return n;
}

/** Darkens every drawn pixel whose right or lower neighbour shows another piece (or nothing). */
function outline(rgba: Uint8Array, idAt: Int32Array, W: number, H: number): void {
  const edge = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      const id = idAt[k] ?? -1;
      const right = x + 1 < W ? (idAt[k + 1] ?? -1) : id;
      const down = y + 1 < H ? (idAt[k + W] ?? -1) : id;
      if (right !== id || down !== id) {
        // the outline goes on the drawn side of the boundary
        if (id >= 0) edge[k] = 1;
        else if (right >= 0) edge[k + 1] = 1;
        else if (down >= 0) edge[k + W] = 1;
      }
    }
  for (let k = 0; k < W * H; k++)
    if (edge[k] === 1)
      for (let c = 0; c < 3; c++) rgba[k * 4 + c] = Math.round((rgba[k * 4 + c] ?? 0) * OUTLINE);
}

/** The box (12 triangles) round a mesh's vertices, in its own frame. */
function localBoxMesh(m: MeshData): MeshData {
  const b = meshBox(m);
  return cuboid(b.min, b.max);
}
