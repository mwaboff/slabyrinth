/**
 * 3D pictures of a scene (design §5.1, §5.2): the shots a request names (or the ranked rules' choice), rendered by the
 * software renderer into one numbered sheet of 1024 × 768 (four views of 512 × 384 by default), with one plain caption
 * per view and the views worth a look next. For the model, the text also lists the scene checks' findings on the
 * pieces each view draws (its id buffer), so the model gets measured facts with places, not only pixels.
 * Pure and deterministic: main's scene worker serves the model's pictures
 * and the 3D view's still pictures with it; the fake bridge too.
 */
import {
  boxesNear,
  chooseShots,
  encodePng,
  numberedSheet,
  renderScene,
  sheetGrid,
  shown,
  shotsByName,
  type Finding,
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

/** Measured findings listed under one sheet at most (the rest are counted). */
export const MAX_FINDING_LINES = 10;

/**
 * Whether a finding is in a view: one of its pieces is drawn there, or, for a fault with no piece of its own (a hole,
 * an open roof), a drawn piece touches its box.
 */
function inView(scene: Scene, f: Finding, drawn: ReadonlySet<number>): boolean {
  if (f.pieces.length > 0) return f.pieces.some((p) => drawn.has(p.index));
  for (const i of drawn) {
    const inst = scene.instances[i];
    if (inst && boxesNear(inst.aabb, f.where.box, 0.25)) return true;
  }
  return false;
}

/** "level Cellar (l1), hall, square 12,4 (+3 more)": where a finding is, in the plan's own words. */
function whereOf(scene: Scene, f: Finding): string {
  const level = scene.levels.find((l) => l.id === f.where.levelId);
  const parts = [
    level && level.name !== level.id ? `level ${level.name} (${level.id})` : `level ${f.where.levelId}`,
  ];
  const element = f.where.elementId ?? f.pieces.find((p) => p.elementId !== null)?.elementId ?? null;
  if (element !== null) parts.push(element);
  const [first, ...rest] = f.where.cells;
  if (first)
    parts.push(
      `square ${String(first[0])},${String(first[1])}${rest.length > 0 ? ` (+${String(rest.length)} more)` : ""}`,
    );
  return parts.join(", ");
}

/**
 * The measured findings for the parts in view, in plain words with the place the model can act on, faults first;
 * then how many were measured elsewhere on the map. `findings` null: the checks could not run (nothing is said).
 */
export function findingsText(
  scene: Scene,
  findings: readonly Finding[] | null,
  drawnPerView: ReadonlyArray<ReadonlySet<number>>,
): string {
  if (findings === null) return "";
  const lines: string[] = [];
  let elsewhere = 0;
  const ordered = [...findings].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "fault" ? -1 : 1,
  );
  for (const f of ordered) {
    const views = drawnPerView.flatMap((d, i) => (inView(scene, f, d) ? [i + 1] : []));
    if (views.length === 0) {
      elsewhere++;
      continue;
    }
    const worth = f.severity === "warn" ? " (worth a look; often fine)" : "";
    lines.push(`- view ${views.join(", ")}, ${whereOf(scene, f)}: ${f.message}${worth}`);
  }
  const out: string[] = [];
  if (lines.length === 0)
    out.push(
      "Measured on the pieces in view: no gaps, holes, floating, sunk or clashing pieces, wrong facing or blocked ways.",
    );
  else {
    out.push("Measured on the pieces in view (faults first):", ...lines.slice(0, MAX_FINDING_LINES));
    if (lines.length > MAX_FINDING_LINES)
      out.push(`- and ${String(lines.length - MAX_FINDING_LINES)} more in view`);
  }
  if (elsewhere > 0)
    out.push(
      `${String(elsewhere)} more measured elsewhere on the map (ask for "flagged" or a view of that place).`,
    );
  return out.join("\n");
}

/** The sheet for a request: views by name (in order) or by the ranked rules, at most `max` (1..4). */
export function scenePictures(
  scene: Scene,
  req: { shots?: readonly ShotName[]; max?: number },
  ctx: ShotContext = {},
  /** The scene checks' findings (null: they could not run; absent: none were asked for). */
  findings?: readonly Finding[] | null,
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
  const drawn: Array<Set<number>> = [];
  chosen.shots.forEach((s, i) => {
    const img = renderScene(scene, s.spec);
    pictures.push({ width: img.width, height: img.height, rgba: img.rgba });
    captions.push(`${String(i + 1)}. ${captionOf(scene, s.spec)}`);
    if (findings !== undefined) {
      const seen = new Set<number>();
      for (const id of img.idAt) if (id >= 0) seen.add(id);
      drawn.push(seen);
    }
  });
  const empty = chosen.empty.length > 0 ? ` Nothing to show for: ${chosen.empty.join(", ")}.` : "";
  const next =
    chosen.suggestions.length > 0
      ? `Other views: ${chosen.suggestions.slice(0, 8).join(", ")}.${empty}`
      : `No other views suggested.${empty}`;
  const measured = findings !== undefined ? findingsText(scene, findings, drawn) : "";
  return {
    png: encodePng(numberedSheet(pictures, SHEET_SIZE.width, SHEET_SIZE.height)),
    captions,
    suggestions: measured !== "" ? `${measured}\n${next}` : next,
    views: pictures.length,
  };
}
