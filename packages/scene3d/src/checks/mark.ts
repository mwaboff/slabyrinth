/**
 * Marked pictures of findings: findings close together are one cluster; each cluster gets one shot framed by the shot
 * rules (`boxShot`: at least 6 tiles, the levels above and the roofs hidden, from the side its pieces show best), its
 * pieces tinted a loud magenta and its box outlined in yellow, so a person or a model confirms it at a glance.
 */
import { minOf } from "@slabyrinth/core";
import { viewBasis } from "../raster/camera";
import { renderScene } from "../raster/raster";
import { drawText } from "../raster/sheet";
import { boxShot } from "../shots/request";
import type { ShotSize } from "../shots/presets";
import type { Box3, Camera, RenderedImage, Scene, ShotSpec, Vec3 } from "../types/index";
import type { Finding } from "./types";
import { copyBox, grow, groups, near } from "./util";

/** Findings whose boxes come within this many tiles of each other (same level) share a picture. */
const CLUSTER_REACH = 2;
/** A marked picture frames at least this many tiles. */
const MIN_FRAME = 6;
const TINT: readonly [number, number, number] = [255, 0, 200];
const LINE: readonly [number, number, number] = [255, 230, 0];

export interface FindingCluster {
  /** Indexes into the findings list. */
  findings: number[];
  levelIndex: number;
  box: Box3;
}

const RANK = { fault: 0, warn: 1 } as const;

/** Findings grouped by place (same level, boxes within CLUSTER_REACH), worst first, at most `max`. */
export function clusterFindings(findings: readonly Finding[], max = Infinity): FindingCluster[] {
  const gs = groups(findings, (k) => {
    const a = findings[k];
    if (!a) return [];
    const out: number[] = [];
    // findings of one render are few hundred at most: grouping is by their own boxes
    findings.forEach((b, m) => {
      if (m > k && b.where.levelIndex === a.where.levelIndex && near(a.where.box, b.where.box, CLUSTER_REACH))
        out.push(m);
    });
    return out;
  });
  const index = new Map(findings.map((f, i) => [f, i]));
  const clusters = gs.map((g) => {
    const box = copyBox(g[0]?.where.box ?? { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } });
    for (const f of g) grow(box, f.where.box);
    return { findings: g.map((f) => index.get(f) ?? 0), levelIndex: g[0]?.where.levelIndex ?? 0, box };
  });
  const worst = (c: FindingCluster): number =>
    minOf(c.findings.map((i) => RANK[findings[i]?.severity ?? "warn"]));
  return clusters
    .map((c, i) => ({ c, i }))
    .sort((p, q) => worst(p.c) - worst(q.c) || q.c.findings.length - p.c.findings.length || p.i - q.i)
    .slice(0, max)
    .map((x) => x.c);
}

/** The shot of a cluster (the shot rules' framing of its box), as `finding-<n>`. */
export function clusterShot(
  scene: Scene,
  findings: readonly Finding[],
  c: FindingCluster,
  n: number,
  size: ShotSize,
): ShotSpec {
  const fs = c.findings.map((i) => findings[i]).filter((f): f is Finding => f !== undefined);
  const idx = [...new Set(fs.flatMap((f) => f.pieces.map((p) => p.index)))];
  const codes = [...new Set(fs.map((f) => f.code))];
  const roofLook = codes.every((k) => k === "roof_open");
  return boxShot(
    scene,
    c.box,
    idx,
    {
      id: `finding-${String(n)}`,
      rule: "finding",
      caption: `${codes.join(", ")}: ${fs[0]?.message ?? ""}${fs.length > 1 ? ` (+${String(fs.length - 1)} more here)` : ""}`,
      targets: [...new Set(fs.map((f) => f.where.elementId).filter((e): e is string => e !== null))],
      elevation: roofLook ? 60 : 45,
      minFrame: MIN_FRAME,
      maxLevelIndex: c.levelIndex,
      hideLayers: roofLook ? [] : ["roof"],
    },
    size,
  );
}

/** Projects world points for a camera at a picture size (the rasteriser's own projection). */
function projector(cam: Camera, W: number, H: number): (p: Vec3) => [number, number] | null {
  const v = viewBasis(cam);
  const cx = W / 2;
  const cy = H / 2;
  if (cam.projection === "ortho") {
    const s = cy / cam.halfHeight;
    return (p) => {
      const d = { x: p.x - v.eye.x, y: p.y - v.eye.y, z: p.z - v.eye.z };
      return [
        cx + (d.x * v.right.x + d.y * v.right.y + d.z * v.right.z) * s,
        cy - (d.x * v.up.x + d.y * v.up.y + d.z * v.up.z) * s,
      ];
    };
  }
  const focal = cy / Math.tan((cam.fovDeg * Math.PI) / 360);
  return (p) => {
    const d = { x: p.x - v.eye.x, y: p.y - v.eye.y, z: p.z - v.eye.z };
    const depth = d.x * v.fwd.x + d.y * v.fwd.y + d.z * v.fwd.z;
    if (depth < 0.05) return null;
    const k = focal / depth;
    return [
      cx + (d.x * v.right.x + d.y * v.right.y + d.z * v.right.z) * k,
      cy - (d.x * v.up.x + d.y * v.up.y + d.z * v.up.z) * k,
    ];
  };
}

function line(img: RenderedImage, a: [number, number], b: [number, number]): void {
  const n = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) + 1;
  for (let k = 0; k <= n; k++) {
    const x = Math.round(a[0] + ((b[0] - a[0]) * k) / n);
    const y = Math.round(a[1] + ((b[1] - a[1]) * k) / n);
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        const px = x + ox;
        const py = y + oy;
        if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
        const i = (py * img.width + px) * 4;
        img.rgba[i] = LINE[0];
        img.rgba[i + 1] = LINE[1];
        img.rgba[i + 2] = LINE[2];
      }
  }
}

/** The marked picture of a cluster: its pieces tinted, each finding's box outlined, its codes written in the corner. */
export function markedPicture(
  scene: Scene,
  findings: readonly Finding[],
  c: FindingCluster,
  spec: ShotSpec,
): RenderedImage {
  const img = renderScene(scene, spec);
  const fs = c.findings.map((i) => findings[i]).filter((f): f is Finding => f !== undefined);
  const marked = new Set(fs.flatMap((f) => f.pieces.map((p) => p.index)));
  for (let k = 0; k < img.idAt.length; k++) {
    if (!marked.has(img.idAt[k] ?? -1)) continue;
    for (let ch = 0; ch < 3; ch++)
      img.rgba[k * 4 + ch] = Math.round(((img.rgba[k * 4 + ch] ?? 0) + (TINT[ch] ?? 0) * 2) / 3);
  }
  const project = projector(spec.camera, img.width, img.height);
  for (const f of fs) {
    const b = f.where.box;
    const corner = (i: number): Vec3 => ({
      x: i & 1 ? b.max.x : b.min.x,
      y: i & 2 ? b.max.y : b.min.y,
      z: i & 4 ? b.max.z : b.min.z,
    });
    for (const [p, q] of [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
      [0, 2],
      [1, 3],
      [4, 6],
      [5, 7],
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
    ] as const) {
      const a = project(corner(p));
      const e = project(corner(q));
      if (a && e) line(img, a, e);
    }
  }
  const codes = [...new Set(fs.map((f) => f.code))].join(", ");
  drawText(img, `${spec.id}: ${codes}`, 8, 8, 2, LINE);
  return img;
}
