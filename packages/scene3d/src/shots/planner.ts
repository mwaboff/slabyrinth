/**
 * Shot rules (design §2.5): cameras chosen from the map itself by general rules over parts and data, never per kind
 * of thing, so they work for a thing nobody has built before.
 *
 * - A **thing** is every piece one plan element owns (core objectOf: `<owner>~<part>`, `<owner>#<n>`, `<owner>@<level>`),
 *   when it is more than a few pieces, has a built piece (wall, opening, roof or stairs: not ground, not loose
 *   dressing) and does not cover most of the map.
 * - Its **front** is the side most of its ground-level doors and windows face (the "opening" colour class: plan roles or
 *   catalog facts); a thing without any is looked at from the side where most of it is visible (the occlusion probe).
 * - Its **interior** is each storey (paste layer `storey:<n>`) or level it spans, with roofs and everything above hidden.
 * - The **overview** looks from the bearing that shows most of the map (south-west unless another is clearly better).
 * - **Levels** are the presets: each level cut away.
 * Ranked overview > interiors > fronts > levels, cut to a budget.
 */
import { objectOf } from "@slabyrinth/core/objects";
import { PlanHash } from "../geom/planHash";
import { frameBox } from "../raster/camera";
import { renderScene, shownBounds } from "../raster/raster";
import type { Box3, Cutaway, PlanRect, Scene, SceneInstance, ShotSpec } from "../types/index";
import {
  LEVEL_ELEVATION,
  OVERVIEW_BEARING,
  OVERVIEW_ELEVATION,
  levelShots,
  slug,
  type ShotSize,
} from "./presets";

export const SHOT_RULES = ["overview", "interiors", "fronts", "levels"] as const;
export type ShotRule = (typeof SHOT_RULES)[number];

/** A thing smaller than this many pieces gets no shots of its own. */
export const MIN_THING_PIECES = 6;
/** Built pieces: a thing has at least one (props alone are dressing). */
const BODY: ReadonlySet<string> = new Set(["wall", "opening", "roof", "stairs"]);
/** A storey's shell: what an interior shot is framed on. */
const SHELL: ReadonlySet<string> = new Set(["wall", "opening", "floor", "stairs"]);
const FRONT_ELEVATION = 20;
const INTERIOR_ELEVATION = 65;
/** The probe's picture: small, every piece drawn (most as boxes). */
const PROBE = { width: 128, height: 96 };
/** Another overview bearing must show this much more of the map than the south-west one to be chosen. */
const OVERVIEW_GAIN = 0.02;

export const SIDES = [
  { side: "north", bearing: 0 },
  { side: "east", bearing: 90 },
  { side: "south", bearing: 180 },
  { side: "west", bearing: 270 },
] as const;
type SideName = (typeof SIDES)[number]["side"];

export interface Thing {
  id: string;
  /** Indexes into Scene.instances. */
  instances: number[];
  box: Box3;
}

const storeyOf = (layer: string): number | null =>
  layer.startsWith("storey:") ? Number(layer.slice("storey:".length)) : null;

/** The world box of some of a scene's instances (by index). */
export function boxOf(scene: Scene, idx: readonly number[]): Box3 {
  const b: Box3 = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
  for (const i of idx) {
    const a = scene.instances[i]?.aabb;
    if (!a) continue;
    b.min.x = Math.min(b.min.x, a.min.x);
    b.min.y = Math.min(b.min.y, a.min.y);
    b.min.z = Math.min(b.min.z, a.min.z);
    b.max.x = Math.max(b.max.x, a.max.x);
    b.max.y = Math.max(b.max.y, a.max.y);
    b.max.z = Math.max(b.max.z, a.max.z);
  }
  return b;
}

/** The plan rectangle of a box grown by `d` tiles each side. */
export const grown = (b: Box3, d: number): PlanRect => ({
  minX: b.min.x - d,
  maxX: b.max.x + d,
  minZ: b.min.z - d,
  maxZ: b.max.z + d,
});
/** A box grown by `d` tiles in plan (x and z). */
export const padded = (b: Box3, d: number): Box3 => ({
  min: { x: b.min.x - d, y: b.min.y, z: b.min.z - d },
  max: { x: b.max.x + d, y: b.max.y, z: b.max.z + d },
});

/** The things of a scene that get shots of their own, by id. */
export function thingsOf(scene: Scene): Thing[] {
  const groups = new Map<string, number[]>();
  scene.instances.forEach((inst, i) => {
    const owner = objectOf(inst.elementId ?? undefined);
    if (owner === null) return;
    let g = groups.get(owner);
    if (!g) groups.set(owner, (g = []));
    g.push(i);
  });
  const out: Thing[] = [];
  for (const [id, idx] of groups) {
    if (idx.length < MIN_THING_PIECES) continue;
    // ground (floor pieces only) is not a thing, nor is loose dressing (props only): a thing has a built piece
    if (!idx.some((i) => BODY.has(scene.instances[i]?.colourClass ?? "unknown"))) continue;
    out.push({ id, instances: idx, box: boxOf(scene, idx) });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The share of `of` the camera sees (distinct instances on the probe's id buffer). */
const HASHES = new WeakMap<Scene, PlanHash>();
/** The scene's plan hash, built once per scene. */
function planHashOf(scene: Scene): PlanHash {
  let h = HASHES.get(scene);
  if (!h) HASHES.set(scene, (h = new PlanHash(scene.instances.map((i) => i.aabb))));
  return h;
}

export function visibleShare(
  scene: Scene,
  spec: Pick<ShotSpec, "camera" | "cutaway">,
  of: readonly number[],
): number {
  // a probe cut to a plan rectangle draws only the pieces near it (a plan hash), not every piece of the map
  const w = spec.cutaway.within;
  const only = w ? planHashOf(scene).near(w.minX, w.maxX, w.minZ, w.maxZ) : undefined;
  const img = renderScene(scene, { ...spec, ...PROBE }, only ? { only } : {});
  const want = new Set(of);
  const seen = new Set<number>();
  for (const id of img.idAt) if (want.has(id)) seen.add(id);
  return of.length === 0 ? 0 : seen.size / of.length;
}

export interface Front {
  side: SideName;
  bearing: number;
  /** "openings": the side its doors and windows face; "probe": the side it is most visible from. */
  by: "openings" | "probe";
}

/** The side a thing faces (see the header). */
export function frontOf(scene: Scene, thing: Thing): Front {
  const counts = new Map<SideName, number>();
  const b = thing.box;
  for (const i of thing.instances) {
    const inst = scene.instances[i];
    if (inst?.colourClass !== "opening" || inst.aabb.min.y > b.min.y + 1.5) continue;
    const cx = (inst.aabb.min.x + inst.aabb.max.x) / 2;
    const cz = (inst.aabb.min.z + inst.aabb.max.z) / 2;
    const d: Array<[SideName, number]> = [
      ["north", b.max.z - cz],
      ["east", b.max.x - cx],
      ["south", cz - b.min.z],
      ["west", cx - b.min.x],
    ];
    const near = d.reduce((m, x) => (x[1] < m[1] ? x : m));
    counts.set(near[0], (counts.get(near[0]) ?? 0) + 1);
  }
  let best: (typeof SIDES)[number] | null = null;
  for (const s of SIDES) if ((counts.get(s.side) ?? 0) > (best ? (counts.get(best.side) ?? 0) : 0)) best = s;
  if (best) return { side: best.side, bearing: best.bearing, by: "openings" };
  let probeBest: (typeof SIDES)[number] = SIDES[2];
  let share = -1;
  const cutaway: Cutaway = { within: grown(b, 3) };
  for (const s of SIDES) {
    const camera = frameBox(padded(b, 1), {
      bearingDeg: s.bearing,
      elevationDeg: FRONT_ELEVATION,
      projection: "ortho",
      ...PROBE,
    });
    const v = visibleShare(scene, { camera, cutaway }, thing.instances);
    if (v > share) {
      share = v;
      probeBest = s;
    }
  }
  return { side: probeBest.side, bearing: probeBest.bearing, by: "probe" };
}

/** The overview's bearing: south-west, unless another of the eight shows clearly more of the map. */
export function overviewBearing(scene: Scene): number {
  const all = scene.instances.map((_, i) => i);
  const share = (bearingDeg: number): number =>
    visibleShare(
      scene,
      {
        camera: frameBox(scene.bounds, {
          bearingDeg,
          elevationDeg: OVERVIEW_ELEVATION,
          projection: "ortho",
          ...PROBE,
        }),
        cutaway: {},
      },
      all,
    );
  let best = OVERVIEW_BEARING;
  let bestShare = share(best);
  for (let k = 1; k < 8; k++) {
    const b = (OVERVIEW_BEARING + 45 * k) % 360;
    const v = share(b);
    if (v > bestShare + OVERVIEW_GAIN) {
      best = b;
      bestShare = v;
    }
  }
  return best;
}

/** A thing seen from its front, with its surroundings (3 tiles). */
export function frontShot(t: Thing, front: Front, size: ShotSize): ShotSpec {
  return {
    id: `front-${slug(t.id)}`,
    rule: "front",
    caption: `${t.id} from the ${front.side} (${front.by === "openings" ? "the side its doors and windows face" : "the side most of it shows from"})`,
    camera: frameBox(padded(t.box, 1), {
      bearingDeg: front.bearing,
      elevationDeg: FRONT_ELEVATION,
      projection: size.projection ?? "ortho",
      ...size,
    }),
    cutaway: { within: grown(t.box, 3) },
    width: size.width,
    height: size.height,
    targets: [t.id],
  };
}

/** Inside a thing: each storey it has, else each level it spans (when more than one), roofs and above hidden. */
export function interiorShots(scene: Scene, t: Thing, front: Front | null, size: ShotSize): ShotSpec[] {
  const storeys = [
    ...new Set(t.instances.map((i) => storeyOf(scene.instances[i]?.layer ?? "")).filter((s) => s !== null)),
  ].sort((a, b) => a - b);
  const levels = [...new Set(t.instances.map((i) => scene.instances[i]?.levelIndex ?? 0))].sort(
    (a, b) => a - b,
  );
  const slices: Array<{
    suffix: string;
    words: string;
    cutaway: Cutaway;
    keep: (i: SceneInstance) => boolean;
  }> =
    storeys.length > 0
      ? storeys.map((s) => ({
          suffix: `s${s}`,
          words: s === 0 ? "ground storey" : `storey ${s}`,
          cutaway: { hideLayers: ["roof"], maxStorey: s, within: grown(t.box, 1) },
          keep: (i) => objectOf(i.elementId ?? undefined) === t.id && storeyOf(i.layer) === s,
        }))
      : levels.length > 1
        ? levels.map((l) => ({
            suffix: `l${l}`,
            words: `on ${scene.levels[l]?.name ?? `level ${l}`}`,
            cutaway: { hideLayers: ["roof"], maxLevelIndex: l, within: grown(t.box, 1) },
            keep: (i) => objectOf(i.elementId ?? undefined) === t.id && i.levelIndex === l,
          }))
        : [];
  const out: ShotSpec[] = [];
  for (const sl of slices) {
    // framed on the storey's shell (walls, doors, floors), not on what it dresses outside (a porch post, a lamp, a
    // line to a neighbour), so the room sits in the middle of the picture; all of it when it has no shell
    const shell = shownBounds(
      scene,
      sl.cutaway,
      (i) => sl.keep(i) && SHELL.has(i.colourClass) && i.role !== "wall_post",
    );
    const box = Number.isFinite(shell.min.x) ? shell : shownBounds(scene, sl.cutaway, sl.keep);
    if (!Number.isFinite(box.min.x)) continue;
    out.push({
      id: `interior-${slug(t.id)}-${sl.suffix}`,
      rule: "interior",
      caption: `Inside ${t.id}, ${sl.words}: roofs and everything above hidden`,
      camera: frameBox(padded(box, 1), {
        bearingDeg: front?.bearing ?? OVERVIEW_BEARING,
        elevationDeg: INTERIOR_ELEVATION,
        projection: size.projection ?? "ortho",
        ...size,
      }),
      cutaway: sl.cutaway,
      width: size.width,
      height: size.height,
      targets: [t.id],
    });
  }
  return out;
}

export interface PlanOptions {
  size: ShotSize;
  /** The rules to apply (default all). */
  rules?: readonly ShotRule[];
  /** At most this many shots, the best ranked first (default no limit). */
  max?: number;
}

/** The shots of a scene by the rules, ranked. */
export function planShots(scene: Scene, o: PlanOptions): ShotSpec[] {
  const rules = new Set(o.rules ?? SHOT_RULES);
  const size = o.size;
  const projection = size.projection ?? "ortho";
  const out: ShotSpec[] = [];
  if (rules.has("overview")) {
    const bearingDeg = overviewBearing(scene);
    out.push({
      id: "overview",
      rule: "overview",
      caption: `The whole map from bearing ${bearingDeg}°`,
      camera: frameBox(scene.bounds, { bearingDeg, elevationDeg: OVERVIEW_ELEVATION, projection, ...size }),
      cutaway: {},
      width: size.width,
      height: size.height,
      targets: [],
    });
  }
  const things = rules.has("interiors") || rules.has("fronts") ? thingsOf(scene) : [];
  const fronts = new Map(things.map((t) => [t.id, frontOf(scene, t)]));
  if (rules.has("interiors"))
    for (const t of things)
      for (const s of interiorShots(scene, t, fronts.get(t.id) ?? null, size)) out.push(s);
  if (rules.has("fronts"))
    for (const t of things) {
      const front = fronts.get(t.id);
      if (front) out.push(frontShot(t, front, size));
    }
  if (rules.has("levels") && scene.levels.length > 1)
    for (const s of levelShots(scene, size))
      out.push({ ...s, caption: `${s.caption} (${LEVEL_ELEVATION}° up)` });
  return o.max === undefined ? out : out.slice(0, Math.max(0, o.max));
}
