/**
 * Shots by name (design §2.5, §5.1): what the model's 3D pictures and the app's 3D view ask for — "overview",
 * "level:<id>", "front:<id>", "interior:<id>", "flagged" (where the design review pointed) and "changed" (what the
 * last version changed) — framed by general rules over the scene, never per kind of thing:
 *
 * - **flagged**: each review note with a cell or elements: the pieces of those elements (or their owner) and the
 *   pieces within a few tiles of its cell, on its level; framed at least 8 × 8 tiles, everything above the level and
 *   every roof hidden, seen from the side most of them show from (the occlusion probe).
 * - **changed**: the pieces of every element the last version added or changed, framed together, roofs hidden, from
 *   the side most of them show from.
 * - Without names, the shots are ranked flagged > changed > overview > interiors > fronts > levels, a shot whose
 *   frame overlaps a kept one by more than 70 % (of their union) is dropped, and the best `max` are kept; the rest are
 *   offered as suggestions.
 */
import { objectOf } from "@slabyrinth/core/objects";
import { frameBox } from "../raster/camera";
import type { Box3, Cutaway, PlanRect, Scene, SceneInstance, ShotSpec } from "../types/index";
import {
  SIDES,
  INTERIOR_ELEVATION,
  PROBE,
  boxOf,
  frontOf,
  frontShot,
  grown,
  interiorShots,
  padded,
  thingsOf,
  visibleShare,
  type Thing,
} from "./planner";
import { levelShots, overviewShot, type ShotSize } from "./presets";

/** A shot's name as the model and the 3D view ask for it. */
export type ShotName =
  "overview" | "flagged" | "changed" | `level:${string}` | `front:${string}` | `interior:${string}`;

/** A place the design review pointed at (core DesignNote, as plain data). */
export interface FocusNote {
  levelId: string;
  /** Plan cell (x, y). */
  cell?: readonly [number, number];
  elementIds?: readonly string[];
  /** Short words for the caption (the note's code or message). */
  label: string;
  /** Rank (higher first). */
  score?: number;
}

/** What the request rules read besides the scene. */
export interface ShotContext {
  /** The design review's notes on this version (for "flagged"). */
  notes?: readonly FocusNote[];
  /** Element ids the last version added or changed, and how many it removed (for "changed"). */
  changed?: { ids: readonly string[]; removed: number };
  /**
   * The plan cells each element covers, by id (an area's cells: its floors and walls are placed as merged runs whose
   * pieces name the run, not the area, so a piece is the area's when it stands on one of them).
   */
  footprints?: ReadonlyMap<string, ReadonlyArray<readonly [levelId: string, x: number, y: number]>>;
}

/** A chosen shot and the name that chose it. */
export interface NamedShot {
  name: ShotName;
  spec: ShotSpec;
}

/** Notes looked at for "flagged", best first. */
export const MAX_FLAGGED = 4;
/** A note's pieces: those of its elements, and those within this many tiles of its cell. */
const NOTE_RADIUS = 4;
/** A flagged frame is at least this many tiles across. */
const MIN_FRAME = 8;
const FLAGGED_ELEVATION = 50;
const CHANGED_ELEVATION = 45;
/** Two frames overlapping more than this share of their union show the same place. */
const SAME_PLACE = 0.7;
/** Without names, fronts and interiors are planned for at most this many things (changed ones first, then largest). */
const THINGS_CONSIDERED = 3;

/** Does a piece belong to one of `ids`: named by it (or by a part it owns), or standing on one of its cells? */
function belongsTo(scene: Scene, ids: readonly string[], ctx: ShotContext): (inst: SceneInstance) => boolean {
  const set = new Set(ids);
  const cells = new Set<string>();
  const levelIndex = new Map(scene.levels.map((l) => [l.id, l.index]));
  for (const id of ids)
    for (const [levelId, x, y] of ctx.footprints?.get(id) ?? [])
      cells.add(`${String(levelIndex.get(levelId) ?? -1)}:${String(x)},${String(y)}`);
  return (inst) =>
    (inst.elementId !== null && (set.has(inst.elementId) || set.has(objectOf(inst.elementId) ?? ""))) ||
    (inst.cell !== null &&
      cells.has(`${String(inst.levelIndex)}:${String(inst.cell[0])},${String(inst.cell[1])}`));
}

function indexesOf(scene: Scene, keep: (inst: SceneInstance) => boolean): number[] {
  const idx: number[] = [];
  scene.instances.forEach((inst, i) => {
    if (keep(inst)) idx.push(i);
  });
  return idx;
}

/** The thing of an element id: its pieces (its own, those it owns, those on its cells), whatever their number. */
export function thingById(scene: Scene, id: string, ctx: ShotContext = {}): Thing | null {
  const own = thingsOf(scene).find((t) => t.id === id);
  if (own) return own;
  const idx = indexesOf(scene, belongsTo(scene, [id], ctx));
  return idx.length === 0 ? null : { id, instances: idx, box: boxOf(scene, idx) };
}

/** A box at least `min` tiles across in plan, about the same centre. */
function atLeast(b: Box3, min: number): Box3 {
  const cx = (b.min.x + b.max.x) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const hx = Math.max((b.max.x - b.min.x) / 2, min / 2);
  const hz = Math.max((b.max.z - b.min.z) / 2, min / 2);
  return { min: { x: cx - hx, y: b.min.y, z: cz - hz }, max: { x: cx + hx, y: b.max.y, z: cz + hz } };
}

/** The bearing (of the four sides) from which most of `idx` shows with this cutaway. */
function bestSide(
  scene: Scene,
  idx: readonly number[],
  frame: Box3,
  cutaway: Cutaway,
  elevationDeg: number,
): number {
  let best: number = SIDES[2].bearing;
  let share = -1;
  for (const s of SIDES) {
    const camera = frameBox(frame, {
      bearingDeg: s.bearing,
      elevationDeg,
      projection: "ortho",
      ...PROBE,
    });
    const v = visibleShare(scene, { camera, cutaway }, idx);
    if (v > share) {
      share = v;
      best = s.bearing;
    }
  }
  return best;
}

/** A shot of some pieces: framed on them (at least `minFrame` tiles), cut away above `maxLevel`, roofs hidden. */
function focusShot(
  scene: Scene,
  idx: readonly number[],
  o: { id: string; rule: string; caption: string; targets: string[]; elevation: number; minFrame: number },
  size: ShotSize,
): ShotSpec {
  const maxLevelIndex = idx.reduce((m, i) => Math.max(m, scene.instances[i]?.levelIndex ?? 0), 0);
  return boxShot(scene, boxOf(scene, idx), idx, { ...o, maxLevelIndex, hideLayers: ["roof"] }, size);
}

/**
 * A shot of a place (a world box, e.g. a scene check's finding): framed on it (at least `minFrame` tiles across), cut
 * away above `maxLevelIndex` and hiding `hideLayers`, with only its surroundings drawn, seen from the side most of
 * `idx` (the pieces it is about) shows from.
 */
export function boxShot(
  scene: Scene,
  place: Box3,
  idx: readonly number[],
  o: {
    id: string;
    rule: string;
    caption: string;
    targets: string[];
    elevation: number;
    minFrame: number;
    maxLevelIndex: number;
    hideLayers: string[];
  },
  size: ShotSize,
): ShotSpec {
  const box = atLeast(place, o.minFrame);
  const cutaway: Cutaway = {
    maxLevelIndex: o.maxLevelIndex,
    hideLayers: o.hideLayers,
    within: grown(box, 3),
  };
  const frame = padded(box, 1);
  const bearingDeg = bestSide(scene, idx, frame, cutaway, o.elevation);
  return {
    id: o.id,
    rule: o.rule,
    caption: o.caption,
    camera: frameBox(frame, {
      bearingDeg,
      elevationDeg: o.elevation,
      projection: size.projection ?? "ortho",
      width: size.width,
      height: size.height,
    }),
    cutaway,
    width: size.width,
    height: size.height,
    targets: o.targets,
  };
}

/** One shot per review note that points at pieces of the scene (best notes first, at most MAX_FLAGGED). */
export function flaggedShots(scene: Scene, size: ShotSize, ctx: ShotContext = {}): ShotSpec[] {
  const out: ShotSpec[] = [];
  const ranked = (ctx.notes ?? [])
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (b.n.score ?? 0) - (a.n.score ?? 0) || a.i - b.i);
  for (const { n } of ranked) {
    if (out.length >= MAX_FLAGGED) break;
    const level = scene.levels.find((l) => l.id === n.levelId);
    const owned = belongsTo(scene, n.elementIds ?? [], ctx);
    const idx = indexesOf(scene, (inst) => {
      if (level && inst.levelIndex !== level.index) return false;
      const near =
        n.cell !== undefined &&
        inst.cell !== null &&
        Math.abs(inst.cell[0] - n.cell[0]) <= NOTE_RADIUS &&
        Math.abs(inst.cell[1] - n.cell[1]) <= NOTE_RADIUS;
      return near || owned(inst);
    });
    if (idx.length === 0) continue;
    const where = n.elementIds && n.elementIds.length > 0 ? ` at ${n.elementIds.slice(0, 2).join(", ")}` : "";
    out.push(
      focusShot(
        scene,
        idx,
        {
          id: `flagged-${String(out.length + 1)}`,
          rule: "flagged",
          caption: `Flagged by the review: ${n.label}${where} (${level?.name ?? n.levelId}; above and roofs hidden)`,
          targets: [...(n.elementIds ?? [])],
          elevation: FLAGGED_ELEVATION,
          minFrame: MIN_FRAME,
        },
        size,
      ),
    );
  }
  return out;
}

/** The pieces the last version added or changed, in one shot (null when none of them has a piece). */
export function changedShot(scene: Scene, size: ShotSize, ctx: ShotContext = {}): ShotSpec | null {
  const changed = ctx.changed;
  if (!changed || changed.ids.length === 0) return null;
  const idx = indexesOf(scene, belongsTo(scene, changed.ids, ctx));
  if (idx.length === 0) return null;
  const shown = changed.ids.filter((id) => {
    const own = belongsTo(scene, [id], ctx);
    return idx.some((i) => own(scene.instances[i] as SceneInstance));
  });
  const named =
    shown.slice(0, 4).join(", ") + (shown.length > 4 ? ` and ${String(shown.length - 4)} more` : "");
  const removed = changed.removed > 0 ? `; ${String(changed.removed)} removed` : "";
  return focusShot(
    scene,
    idx,
    {
      id: "changed",
      rule: "changed",
      caption: `What the last change touched: ${named}${removed} (roofs hidden)`,
      targets: shown,
      elevation: CHANGED_ELEVATION,
      minFrame: MIN_FRAME,
    },
    size,
  );
}

/** Every shot one name asks for (a building's interior may be several storeys); [] when it names nothing here. */
export function shotsByName(scene: Scene, name: ShotName, size: ShotSize, ctx: ShotContext = {}): ShotSpec[] {
  if (name === "overview") return [{ ...overviewShot(scene, size) }];
  if (name === "flagged") return flaggedShots(scene, size, ctx);
  if (name === "changed") {
    const c = changedShot(scene, size, ctx);
    return c ? [c] : [];
  }
  const colon = name.indexOf(":");
  const kind = name.slice(0, colon);
  const id = name.slice(colon + 1);
  if (kind === "level") return levelShots(scene, size).filter((s) => s.targets[0] === id);
  const thing = thingById(scene, id, ctx);
  if (!thing) return [];
  const front = frontOf(scene, thing);
  if (kind === "front") return [frontShot(thing, front, size)];
  if (kind !== "interior") return [];
  const slices = interiorShots(scene, thing, front, size);
  if (slices.length > 0) return slices;
  // one storey on one level (a room, a hall): from above at a steep angle, roofs and the levels above hidden
  return [
    focusShot(
      scene,
      thing.instances,
      {
        id: `interior-${id}`,
        rule: "interior",
        caption: `Inside ${id}: roofs and everything above hidden`,
        targets: [id],
        elevation: INTERIOR_ELEVATION,
        minFrame: 0,
      },
      size,
    ),
  ];
}

/** The plan rectangle a shot looks at (its `within`, else the box of what it shows). */
function frameOf(scene: Scene, s: ShotSpec): PlanRect {
  if (s.cutaway.within) return s.cutaway.within;
  const b = scene.bounds;
  return { minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z };
}

function overlap(a: PlanRect, b: PlanRect): number {
  const area = (r: PlanRect): number => Math.max(0, r.maxX - r.minX) * Math.max(0, r.maxZ - r.minZ);
  const i = {
    minX: Math.max(a.minX, b.minX),
    maxX: Math.min(a.maxX, b.maxX),
    minZ: Math.max(a.minZ, b.minZ),
    maxZ: Math.min(a.maxZ, b.maxZ),
  };
  const inter = i.maxX > i.minX && i.maxZ > i.minZ ? area(i) : 0;
  const union = area(a) + area(b) - inter;
  return union <= 0 ? 0 : inter / union;
}

/** The name a ranked shot is asked for by. */
function nameOf(s: ShotSpec): ShotName {
  const t = s.targets[0] ?? "";
  if (s.rule === "level") return `level:${t}`;
  if (s.rule === "front") return `front:${t}`;
  if (s.rule === "interior") return `interior:${t}`;
  if (s.rule === "flagged") return "flagged";
  if (s.rule === "changed") return "changed";
  return "overview";
}

/** The things fronts and interiors are planned for without names: changed ones first, then the largest. */
function consideredThings(scene: Scene, ctx: ShotContext): Thing[] {
  const changed = new Set(ctx.changed?.ids ?? []);
  return thingsOf(scene)
    .map((t) => ({ t, hit: changed.has(t.id) ? 1 : 0 }))
    .sort(
      (a, b) => b.hit - a.hit || b.t.instances.length - a.t.instances.length || (a.t.id < b.t.id ? -1 : 1),
    )
    .slice(0, THINGS_CONSIDERED)
    .map((x) => x.t);
}

export interface ChosenShots {
  shots: NamedShot[];
  /** Names of further views worth a look (not in `shots`), best first. */
  suggestions: ShotName[];
  /** Names asked for that show nothing here (an unknown id, no review notes, nothing changed). */
  empty: ShotName[];
}

/**
 * The shots of a request. Names given: each name's shots in the order given, cut to `max`. None: the ranked rules
 * above. Deterministic for the same scene, request and context.
 */
export function chooseShots(
  scene: Scene,
  req: { shots?: readonly ShotName[]; max: number },
  size: ShotSize,
  ctx: ShotContext = {},
): ChosenShots {
  const max = Math.max(1, Math.floor(req.max));
  const empty: ShotName[] = [];
  if (req.shots && req.shots.length > 0) {
    const all: NamedShot[] = [];
    for (const name of [...new Set(req.shots)]) {
      const specs = shotsByName(scene, name, size, ctx);
      if (specs.length === 0) empty.push(name);
      for (const spec of specs) all.push({ name, spec });
    }
    return {
      shots: all.slice(0, max),
      suggestions: [...new Set(all.slice(max).map((s) => s.name))],
      empty,
    };
  }
  const changed = changedShot(scene, size, ctx);
  const ranked: ShotSpec[] = [
    ...flaggedShots(scene, size, ctx),
    ...(changed ? [changed] : []),
    overviewShot(scene, size),
  ];
  const things = consideredThings(scene, ctx);
  const fronts = new Map(things.map((t) => [t.id, frontOf(scene, t)]));
  for (const t of things)
    for (const s of interiorShots(scene, t, fronts.get(t.id) ?? null, size)) ranked.push(s);
  for (const t of things) {
    const f = fronts.get(t.id);
    if (f) ranked.push(frontShot(t, f, size));
  }
  if (scene.levels.length > 1) for (const s of levelShots(scene, size)) ranked.push(s);
  const kept: ShotSpec[] = [];
  const rest: ShotSpec[] = [];
  for (const s of ranked) {
    const f = frameOf(scene, s);
    const same = kept.some(
      (k) => k.rule !== "overview" && s.rule !== "overview" && overlap(frameOf(scene, k), f) > SAME_PLACE,
    );
    if (kept.length < max && !same) kept.push(s);
    else rest.push(s);
  }
  const shown = new Set(kept.map(nameOf));
  return {
    shots: kept.map((spec) => ({ name: nameOf(spec), spec })),
    suggestions: [...new Set(rest.map(nameOf))].filter((n) => !shown.has(n)),
    empty,
  };
}
