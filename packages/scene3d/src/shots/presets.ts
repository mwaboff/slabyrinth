/**
 * The preset shots every scene has: an overview at an angle, straight down, and each level cut away (the levels above
 * and every roof hidden). Each is framed on what it shows.
 */
import { frameBox } from "../raster/camera";
import { shownBounds } from "../raster/raster";
import type { Camera, Cutaway, Scene, SceneInstance, ShotSpec } from "../types/index";

export interface ShotSize {
  width: number;
  height: number;
  projection?: Camera["projection"];
}

/** Bearing of the overview camera: from the south-west, so north is up and to the right. */
export const OVERVIEW_BEARING = 225;
export const OVERVIEW_ELEVATION = 35;
export const LEVEL_ELEVATION = 55;

/** A file-safe id from a level id or element id. */
export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "x"
  );
}

function framed(
  scene: Scene,
  base: Omit<ShotSpec, "camera" | "width" | "height">,
  size: ShotSize,
  bearingDeg: number,
  elevationDeg: number,
  /** Frame on these of the shown instances only (default: all shown). */
  keep?: (i: SceneInstance) => boolean,
): ShotSpec {
  const camera = frameBox(shownBounds(scene, base.cutaway, keep), {
    bearingDeg,
    elevationDeg,
    projection: size.projection ?? "ortho",
    width: size.width,
    height: size.height,
  });
  return { ...base, camera, width: size.width, height: size.height };
}

export function overviewShot(scene: Scene, size: ShotSize, cutaway: Cutaway = {}): ShotSpec {
  return framed(
    scene,
    { id: "overview", rule: "overview", caption: "The whole map from the south-west", cutaway, targets: [] },
    size,
    OVERVIEW_BEARING,
    OVERVIEW_ELEVATION,
  );
}

export function topShot(scene: Scene, size: ShotSize, cutaway: Cutaway = {}): ShotSpec {
  return framed(
    scene,
    { id: "top", rule: "top", caption: "Straight down, north up", cutaway, targets: [] },
    { ...size, projection: "ortho" },
    0,
    90,
  );
}

/** Each level from above at an angle, with the levels above it and every roof hidden (only when there are levels). */
export function levelShots(scene: Scene, size: ShotSize): ShotSpec[] {
  return scene.levels
    .filter((l) => Number.isFinite(l.bounds.min.x))
    .map((l) =>
      framed(
        scene,
        {
          id: `level-${slug(l.id)}`,
          rule: "level",
          caption: `${l.name}: levels above and roofs hidden`,
          cutaway: { maxLevelIndex: l.index, hideLayers: ["roof"] },
          targets: [l.id],
        },
        size,
        OVERVIEW_BEARING,
        LEVEL_ELEVATION,
        (i) => i.levelIndex === l.index,
      ),
    );
}
