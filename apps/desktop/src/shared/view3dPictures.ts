/**
 * 3D pictures of a scene (design §5.1, §5.2): the shots a request names (or the ranked rules' choice), rendered by the
 * software renderer into one numbered sheet of 1024 × 768 (four views of 512 × 384 by default), with one plain caption
 * per view and the views worth a look next. Pure and deterministic: main's scene worker serves the model's pictures
 * and the 3D view's still pictures with it; the fake bridge too.
 */
import {
  chooseShots,
  encodePng,
  numberedSheet,
  renderScene,
  sheetGrid,
  shown,
  shotsByName,
  type Picture,
  type Scene,
  type ShotContext,
  type ShotName,
  type ShotSpec,
} from "@slabyrinth/scene3d";

/** The sheet the model gets (design §5.2: about 1,050 input tokens). */
export const SHEET_SIZE = { width: 1024, height: 768 } as const;
/** Views on one sheet at most. */
export const MAX_VIEWS = 4;

export interface ScenePictures {
  png: Uint8Array;
  /** "1. …" per view, in the sheet's order. */
  captions: string[];
  suggestions: string;
  views: number;
}

/** Pieces drawn as boxes of their real size (no game shape) among those the shot shows. */
function boxesShown(scene: Scene, spec: ShotSpec): number {
  let n = 0;
  for (const i of scene.instances) if (i.stand === "box" && shown(i, spec.cutaway)) n++;
  return n;
}

const captionOf = (scene: Scene, spec: ShotSpec): string => {
  const boxes = boxesShown(scene, spec);
  return boxes > 0 ? `${spec.caption} (boxes: ${String(boxes)})` : spec.caption;
};

/** The picture of one view by name, at the size asked (null when the name shows nothing in this scene). */
export function onePicture(
  scene: Scene,
  name: ShotName,
  width: number,
  height: number,
  ctx: ShotContext = {},
): { png: Uint8Array; caption: string } | null {
  const spec = shotsByName(scene, name, { width, height }, ctx)[0];
  if (!spec) return null;
  return { png: encodePng(renderScene(scene, spec)), caption: captionOf(scene, spec) };
}

/** The sheet for a request: views by name (in order) or by the ranked rules, at most `max` (1..4). */
export function scenePictures(
  scene: Scene,
  req: { shots?: readonly ShotName[]; max?: number },
  ctx: ShotContext = {},
): ScenePictures {
  const max = Math.min(MAX_VIEWS, Math.max(1, Math.floor(req.max ?? MAX_VIEWS)));
  const cell = (n: number): { width: number; height: number } => {
    const g = sheetGrid(n);
    return {
      width: Math.floor(SHEET_SIZE.width / g.columns),
      height: Math.floor(SHEET_SIZE.height / g.rows),
    };
  };
  const ask = { ...(req.shots ? { shots: req.shots } : {}), max };
  let chosen = chooseShots(scene, ask, cell(max), ctx);
  const n = chosen.shots.length;
  // fewer views than the budget: frame them again for their own cells (the grid differs)
  if (n > 0 && n < max) {
    const a = sheetGrid(n);
    const b = sheetGrid(max);
    if (a.columns !== b.columns || a.rows !== b.rows)
      chosen = chooseShots(scene, { ...ask, max: n }, cell(n), ctx);
  }
  const pictures: Picture[] = [];
  const captions: string[] = [];
  chosen.shots.forEach((s, i) => {
    const img = renderScene(scene, s.spec);
    pictures.push({ width: img.width, height: img.height, rgba: img.rgba });
    captions.push(`${String(i + 1)}. ${captionOf(scene, s.spec)}`);
  });
  const empty = chosen.empty.length > 0 ? ` Nothing to show for: ${chosen.empty.join(", ")}.` : "";
  const suggestions =
    chosen.suggestions.length > 0
      ? `Other views: ${chosen.suggestions.slice(0, 8).join(", ")}.${empty}`
      : `No other views suggested.${empty}`;
  return {
    png: encodePng(numberedSheet(pictures, SHEET_SIZE.width, SHEET_SIZE.height)),
    captions,
    suggestions,
    views: pictures.length,
  };
}
