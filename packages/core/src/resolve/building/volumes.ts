/**
 * A building's masses: the volumes as written (a phase-1 building is one volume "main" over its wings or footprint),
 * their storeys with relative heights (the ground floor top is 0) and roofs, and the ground footprint they stand on.
 */
import type { Roof, RoofLayer } from "../../contracts/plan";
import { BUILD_CONSTANTS } from "../../contracts/plan";
import type { BuiltRoofType, ResolvedVolume } from "../../contracts/resolved";
import type { rasterizeShape } from "../../gen/shapes";
import type { Prng } from "../../util/prng";
import { defaultRidge, type RoofWing } from "../roof";
import { roofInfo } from "../roofTypes";
import type { WindowDensity } from "../structureStyles";
import type { BuildingCtx } from "./context";
import { boundsOf, cellOf, chamfer, key, rectCells, rectText, ringOf } from "./footprint";
import type { VolumePlan, VolumeSpec, VStorey } from "./types";

const ridgeFrom = (r: Roof | "none" | undefined): "ew" | "ns" | undefined =>
  r === undefined || r === "none" ? undefined : r.ridge;

/** The volumes as written, checked (unique ids, each "on" an earlier one, one on the ground); null after an error. */
export function volumeSpecs(
  b: BuildingCtx,
  cellsOfShape: (s: Parameters<typeof rasterizeShape>[0]) => Array<[number, number]>,
): VolumeSpec[] | null {
  const { st, profile } = b;
  const ridgeOverride = st.roof !== undefined && st.roof !== "none" ? st.roof.ridge : undefined;
  const specs: VolumeSpec[] = [];
  if (st.volumes && st.volumes.length > 0) {
    const ids = new Set<string>();
    for (const v of st.volumes) {
      if (ids.has(v.id)) {
        b.issue(
          "error",
          `building "${st.id}": two volumes are called "${v.id}"`,
          "give every volume its own id",
        );
        return null;
      }
      if (v.on !== undefined && !ids.has(v.on)) {
        b.issue(
          "error",
          `building "${st.id}": volume "${v.id}" stands on "${v.on}", which is not an earlier volume`,
          `list the volume it stands on first; volumes so far: ${[...ids].join(", ") || "(none)"}`,
        );
        return null;
      }
      ids.add(v.id);
      const rect = { x: v.x, y: v.y, w: v.w, h: v.h };
      specs.push({
        id: v.id,
        on: v.on ?? null,
        cells: rectCells(rect),
        rect,
        rects: [{ ...rect, ridge: v.ridge ?? ridgeFrom(v.roof) ?? defaultRidge(v.w, v.h) }],
        storeys: v.storeys ?? (ids.size === 1 && v.on === undefined ? st.storeys : undefined),
        storeyHeight: v.storeyHeight ?? st.storeyHeight,
        corners: v.corners ?? st.corners ?? profile.corners ?? "square",
        roof: v.roof ?? (ids.size === 1 ? st.roof : undefined),
      });
    }
  } else {
    let cells: Array<[number, number]>;
    const rects: RoofWing[] = [];
    if (st.wings && st.wings.length > 0) {
      const set = new Map<string, [number, number]>();
      for (const w of st.wings) {
        for (const [x, y] of rectCells(w)) if (b.inBounds(x, y)) set.set(key(x, y), [x, y]);
        rects.push({
          x: w.x,
          y: w.y,
          w: w.w,
          h: w.h,
          ridge: w.ridge ?? ridgeOverride ?? defaultRidge(w.w, w.h),
        });
      }
      cells = [...set.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    } else if (st.footprint) {
      cells = cellsOfShape(st.footprint);
      if (st.footprint.type === "rect") {
        const f = st.footprint;
        rects.push({ x: f.x, y: f.y, w: f.w, h: f.h, ridge: ridgeOverride ?? defaultRidge(f.w, f.h) });
      }
    } else return null; // validation reports it
    const rect = boundsOf(cells);
    specs.push({
      id: "main",
      on: null,
      cells,
      rect: rects.length === 1 && cells.length === rect.w * rect.h ? rect : null,
      rects,
      storeys: st.storeys,
      storeyHeight: st.storeyHeight,
      corners: st.corners ?? profile.corners ?? "square",
      roof: st.roof,
    });
  }
  if (!specs.some((v) => v.on === null)) {
    b.issue(
      "error",
      `building "${st.id}" has no volume on the ground`,
      "give at least one volume without on",
    );
    return null;
  }
  return specs;
}

/** Every volume's storeys (set-ins, wall styles, footing, heights, seams) and roof, in spec order. */
export function planVolumes(b: BuildingCtx, specs: readonly VolumeSpec[]): VolumePlan[] {
  const { st, profile, prng } = b;
  const vplans: VolumePlan[] = [];
  const density0: WindowDensity =
    st.windows ??
    (profile.variety.windowDensities[prng.int(profile.variety.windowDensities.length)] as WindowDensity);
  for (const spec of specs) {
    const target = spec.on !== null ? vplans.find((v) => v.id === spec.on) : undefined;
    const storeys = planStoreys(b, spec, target, density0);
    if (
      storeys.some((sp, i) => sp.walls === null && i < storeys.length - 1 && storeys[i + 1]?.walls !== null)
    )
      b.issue(
        "warning",
        `building "${st.id}": a storey without walls carries a walled storey above it`,
        "give the lower storey walls, or make it the top storey",
      );
    if (target) checkStandsOn(b, spec, target, storeys);
    const roof = resolveRoof(b, spec, b.prng2);
    const topRel = storeys[storeys.length - 1]?.relTop ?? 0;
    vplans.push({
      id: spec.id,
      on: spec.on,
      corners: spec.corners,
      rects: spec.rects,
      storeys,
      roof,
      relRoofTop: topRel + BUILD_CONSTANTS.floorThickness,
    });
  }
  return vplans;
}

/** The storeys of one volume, from its floor (the ground, or the deck of the volume it stands on) up. */
function planStoreys(
  b: BuildingCtx,
  spec: VolumeSpec,
  target: VolumePlan | undefined,
  density0: WindowDensity,
): VStorey[] {
  const { st, profile, prng2, prng3 } = b;
  const storeyCountDraw = (): number => {
    const r = profile.storeyCount;
    return r ? r[0] + prng3.int(r[1] - r[0] + 1) : 1;
  };
  const drawUpper = (): number => {
    const u = profile.upperWallHeight;
    if (u === undefined) return profile.wallHeight;
    if (typeof u === "number") return u;
    return Math.round((u[0] + (u[1] - u[0]) * prng2.next()) * 2) / 2;
  };
  const pickSeam = (): "skirt" | "plain" | "crenellated" => {
    const w = profile.seams ?? { plain: 1 };
    const entries = (["skirt", "plain", "crenellated"] as const).filter((k) => (w[k] ?? 0) > 0);
    const total = entries.reduce((sum, k) => sum + (w[k] ?? 0), 0);
    let r = prng2.next() * total;
    for (const k of entries) {
      r -= w[k] ?? 0;
      if (r < 0) return k;
    }
    return entries[entries.length - 1] ?? "plain";
  };
  const count = typeof spec.storeys === "number" ? spec.storeys : (spec.storeys?.length ?? storeyCountDraw());
  const given = Array.isArray(spec.storeys) ? spec.storeys : [];
  let relFloor = target ? target.relRoofTop : 0;
  let rect = spec.rect;
  const storeys: VStorey[] = [];
  for (let s = 0; s < count; s++) {
    const g = given[s] ?? {};
    const ground = s === 0 && spec.on === null;
    // set-ins: given, or drawn from the style for storeys above the ground of a rectangular volume
    let inset = g.inset ?? 0;
    if (g.inset === undefined && s > 0 && rect && profile.setIn && prng2.chance(profile.setIn.chance))
      inset = rect.w - 2 >= profile.setIn.minWidth && rect.h - 2 >= profile.setIn.minWidth ? 1 : 0;
    if (inset > 0 && !rect) {
      b.issue(
        "warning",
        `building "${st.id}": storey ${s} of volume "${spec.id}" cannot step in: only rectangular volumes can`,
        "describe it as volumes [{id, x, y, w, h}]",
      );
      inset = 0;
    }
    if (inset > 0 && rect && (rect.w - 2 * inset < 2 || rect.h - 2 * inset < 2)) {
      b.issue(
        "warning",
        `building "${st.id}": storey ${s} of volume "${spec.id}" would be narrower than 2 cells after stepping in ${inset}; it keeps the width`,
        "step in less, or widen the volume",
      );
      inset = 0;
    }
    if (inset > 0 && rect)
      rect = { x: rect.x + inset, y: rect.y + inset, w: rect.w - 2 * inset, h: rect.h - 2 * inset };
    const cells0 = rect ? rectCells(rect) : spec.cells;
    const cells = spec.corners === "chamfer" && rect ? chamfer(cells0, rect) : cells0;
    const isTop = s === count - 1;
    const wallsRaw =
      g.walls ??
      (ground
        ? profile.walls
        : isTop && count > 1 && profile.crownWalls
          ? profile.crownWalls
          : profile.upperWalls);
    const footRaw = ground ? (g.footing ?? profile.footing ?? "none") : "none";
    if (!ground && g.footing !== undefined && g.footing !== "none")
      b.issue(
        "warning",
        `building "${st.id}": only the ground storey has a footing course`,
        "remove footing from upper storeys",
      );
    const footing = footRaw === "none" ? null : { style: footRaw, height: profile.footingHeight };
    const wallHeight = g.height ?? spec.storeyHeight ?? (s === 0 ? profile.wallHeight : drawUpper());
    const relTop = relFloor + (footing?.height ?? 0) + wallHeight;
    storeys.push({
      walls: wallsRaw === "none" ? null : wallsRaw,
      footing,
      wallHeight,
      floor: g.floor ?? profile.floor,
      density: g.windows ?? density0,
      cells,
      cellSet: new Set(cells.map(([x, y]) => key(x, y))),
      rect: rect ?? boundsOf(cells),
      seam: inset > 0 ? (g.seam ?? pickSeam()) : null,
      relFloor,
      relTop,
    });
    relFloor = relTop + BUILD_CONSTANTS.floorThickness;
  }
  return storeys;
}

/** A volume "on" another stands inside its top storey, on a roof it can stand on (warnings only). */
function checkStandsOn(
  b: BuildingCtx,
  spec: VolumeSpec,
  target: VolumePlan,
  storeys: readonly VStorey[],
): void {
  const { st, designed } = b;
  const top = target.storeys[target.storeys.length - 1];
  const off = storeys[0]?.cells.filter(([x, y]) => !top?.cellSet.has(key(x, y))) ?? [];
  // a drawn design (twisted storeys, bartizans) and a building with character overhang on purpose
  if (off.length > 0 && !designed && (st.character ?? []).length === 0)
    b.issue(
      "warning",
      `building "${st.id}": volume "${spec.id}" overhangs the top of "${target.id}" at ${off.length} cell(s)`,
      `keep it inside ${target.id}'s top storey (${rectText(top?.rect)})`,
    );
  if (roofInfo(target.roof.layers[target.roof.layers.length - 1]?.type ?? "flat")?.deck !== true)
    b.issue(
      "warning",
      `building "${st.id}": volume "${spec.id}" stands on "${target.id}", whose roof is not flat; it stands on its deck`,
      `give "${target.id}" a flat roof`,
    );
}

/** The volume's roof as stacked layers: the plan's roof (or the style's), its further layers, normalised and checked. */
function resolveRoof(b: BuildingCtx, spec: VolumeSpec, prng2: Prng): VolumePlan["roof"] {
  const { st, profile } = b;
  const given = spec.roof;
  const first: Roof = given === "none" ? { type: "none" } : (given ?? { type: profile.roof.type });
  const extra: RoofLayer[] =
    given === undefined || given === "none"
      ? given === "none"
        ? []
        : (profile.roofLayers ?? []).map((l) => ({
            type: l.type,
            ...(l.courses ? { courses: l.courses } : {}),
            ...(l.kit ? { style: l.kit } : {}),
          }))
      : (first.layers ?? []);
  const raw: RoofLayer[] = [
    {
      type: first.type,
      ...(first.style ? { style: first.style } : {}),
      ...(first.ridge ? { ridge: first.ridge } : {}),
      ...(first.courses ? { courses: first.courses } : {}),
      ...(first.low ? { low: first.low } : {}),
      ...(first.parapet ? { parapet: first.parapet } : {}),
    },
    ...extra,
  ];
  const kit = first.style ?? profile.roof.kit;
  const layers: ResolvedVolume["roof"]["layers"] = [];
  const rect = spec.rects[0];
  for (const l of raw) {
    let type: string = roofInfo(l.type)?.as ?? l.type;
    const requested = l.type;
    if (layers.length > 0 && roofInfo(layers[layers.length - 1]?.type ?? "")?.closing === true) {
      b.issue(
        "warning",
        `building "${st.id}": roof layer "${requested}" of volume "${spec.id}" stands on a roof that is already closed; it is left out`,
        "put skirt or stepped layers below gable, hip, shed, spire or flat",
      );
      continue;
    }
    if (roofInfo(type)?.built !== true) {
      b.issue(
        "warning",
        `building "${st.id}": "${requested}" roofs are not built yet; it gets a flat roof`,
        "use gable, hip, shed, skirt, stepped, spire, flat or none",
      );
      type = "flat";
    }
    if (roofInfo(type)?.rect === true && !rect) {
      b.issue(
        "warning",
        `building "${st.id}": a ${type} roof needs a rectangular volume or wings; this footprint gets a flat roof`,
        "describe the building as wings or volumes of rectangles",
      );
      type = "flat";
    }
    if (roofInfo(type)?.ends === "gable" && spec.rects.length > 1 && layers.length === 0)
      b.issue(
        "info",
        `building "${st.id}": roofs of several wings meet with approximate valleys`,
        "a single wing gives the cleanest roof",
      );
    const parapet = l.parapet === "none" ? null : (l.parapet ?? profile.roof.parapet);
    const courses =
      l.courses ??
      (roofInfo(type)?.tapers === true && profile.spire
        ? profile.spire.bands[0] + prng2.int(profile.spire.bands[1] - profile.spire.bands[0] + 1)
        : 1);
    layers.push({
      type: type as BuiltRoofType,
      requested,
      style: l.style ?? kit,
      courses,
      low: l.low ?? "S",
      parapet,
      ridge: l.ridge ?? rect?.ridge ?? "ew",
    });
  }
  const deck = (given !== undefined && given !== "none" ? given.deck : undefined) ?? profile.roof.deck;
  const broken = (given !== undefined && given !== "none" ? given.broken : undefined) ?? profile.roof.broken;
  const l0 = layers[0];
  return {
    layers,
    deck,
    broken,
    summary: {
      type: l0?.type ?? "none",
      requested: l0?.requested ?? "none",
      style: l0?.style ?? kit,
      deck,
      broken,
      parapet: l0?.parapet ?? null,
    },
  };
}

/** The ground storeys of the ground volumes, inside the level. */
export interface GroundFootprint {
  /** In row order. */
  readonly cells: Array<[number, number]>;
  readonly cellSet: Set<string>;
  /** Footprint cells of the buildings planned before this one ("x,y" → building id). */
  readonly occupied: ReadonlyMap<string, string>;
}

/**
 * The footprint the ground volumes cover in the level: an error (null) when it covers no cell, overlaps a building
 * planned before it or is less than 2x2; a warning when it touches the level edge.
 */
export function groundFootprint(b: BuildingCtx, vplans: readonly VolumePlan[]): GroundFootprint | null {
  const { st } = b;
  const groundSet = new Map<string, [number, number]>();
  for (const v of vplans)
    if (v.on === null)
      for (const c of v.storeys[0]?.cells ?? [])
        if (b.inBounds(c[0], c[1])) groundSet.set(key(c[0], c[1]), c);
  const cells = [...groundSet.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  if (cells.length === 0) {
    b.issue("error", `building "${st.id}" covers no cell of the level`, "move it inside the level bounds");
    return null;
  }
  const cellSet = new Set(cells.map(([x, y]) => key(x, y)));
  const taken = b.work.occupied();
  const clash = cells.find(([x, y]) => taken.has(key(x, y)));
  if (clash) {
    b.issue(
      "error",
      `building "${st.id}" overlaps building "${taken.get(key(clash[0], clash[1])) ?? "?"}" at ${clash[0]},${clash[1]}`,
      "buildings may not share cells; move one, or make them volumes of one building",
      [clash[0], clash[1]],
    );
    return null;
  }
  const bb = boundsOf(cells);
  if (bb.w < 2 || bb.h < 2) {
    b.issue(
      "error",
      `building "${st.id}" is ${bb.w}x${bb.h}; a building needs at least 2x2 cells`,
      "make it at least 2 cells wide and deep",
    );
    return null;
  }
  if (ringOf(cellSet).some((k) => !b.inBounds(...cellOf(k))))
    b.issue(
      "warning",
      `building "${st.id}" touches the level edge; its walls stand in the ring of cells around it`,
      "leave one free cell between the building and the level bounds",
    );
  return { cells, cellSet, occupied: taken };
}
