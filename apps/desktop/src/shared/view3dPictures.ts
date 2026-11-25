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
  type CheckCode,
  type Finding,
  type Picture,
  type Scene,
  type ShotContext,
  type ShotName,
  type ShotSpec,
} from "@slabyrinth/scene3d";
import type { ElementKind } from "@slabyrinth/core/plan";

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

/** Side of a square of the drawn-piece index, in tiles. */
const BUCKET = 4;
/** A drawn piece "touches" a pieceless fault within this many tiles. */
const TOUCH = 0.25;
const bucketKey = (bx: number, bz: number): number => (bx + 32768) * 65536 + (bz + 32768);

/** One view's drawn pieces, and (built when first needed) those pieces by square of the plan. */
class DrawnView {
  private index: Map<number, number[]> | null = null;
  constructor(
    private readonly scene: Scene,
    readonly ids: ReadonlySet<number>,
    private readonly stats?: { boxTests: number },
  ) {}

  private buckets(): Map<number, number[]> {
    if (this.index) return this.index;
    const index = new Map<number, number[]>();
    for (const i of this.ids) {
      const b = this.scene.instances[i]?.aabb;
      if (!b) continue;
      for (let bx = Math.floor(b.min.x / BUCKET); bx <= Math.floor(b.max.x / BUCKET); bx++)
        for (let bz = Math.floor(b.min.z / BUCKET); bz <= Math.floor(b.max.z / BUCKET); bz++) {
          const k = bucketKey(bx, bz);
          const list = index.get(k);
          if (list) list.push(i);
          else index.set(k, [i]);
        }
    }
    this.index = index;
    return index;
  }

  /** A drawn piece within TOUCH of `box`: only the pieces in the squares around it are tested. */
  touches(box: Finding["where"]["box"]): boolean {
    const index = this.buckets();
    for (
      let bx = Math.floor((box.min.x - TOUCH) / BUCKET);
      bx <= Math.floor((box.max.x + TOUCH) / BUCKET);
      bx++
    )
      for (
        let bz = Math.floor((box.min.z - TOUCH) / BUCKET);
        bz <= Math.floor((box.max.z + TOUCH) / BUCKET);
        bz++
      )
        for (const i of index.get(bucketKey(bx, bz)) ?? []) {
          const inst = this.scene.instances[i];
          if (this.stats) this.stats.boxTests++;
          if (inst && boxesNear(inst.aabb, box, TOUCH)) return true;
        }
    return false;
  }
}

/**
 * Whether a finding is in a view: one of its pieces is drawn there, or, for a fault with no piece of its own (a hole,
 * an open roof), a drawn piece touches its box.
 */
function inView(f: Finding, view: DrawnView): boolean {
  if (f.pieces.length > 0) return f.pieces.some((p) => view.ids.has(p.index));
  return view.touches(f.where.box);
}

/** What kind of plan element an id is; null when the plan has no such element (a piece the generator made). */
export type PlannedKind = (id: string) => ElementKind | null;

/**
 * The plan elements the plan itself positions, best first, and the change that moves them: a fault on one of their
 * pieces is something an edit_plan can fix. Everything else in a build (an area's floors and walls, a structure's
 * shell, what dress, scatter and room dressing place) is laid by the generator, so an edit does not move the piece.
 */
const PLAN_PLACED: ReadonlyArray<readonly [ElementKind, string]> = [
  ["opening", "change the opening (move it along the wall, or another width or kind)"],
  ["link", "move the stairs or ladder, or give them a clear way on and off"],
  ["feature", "move it or give it room"],
  ["wall_run", "move or shorten the wall run"],
];
/** Findings about what a piece stands on: a feature's fix is to stand it elsewhere. */
const SUPPORT_CODES: ReadonlySet<CheckCode> = new Set<CheckCode>(["floating", "sunk"]);

export const APP_PLACED_WORDS =
  "The app placed this: a plan change will not fix it; tell the GM only if it matters.";

/** The change that fixes a finding through the plan, or null when only the app's own placement is involved. */
export function planFix(f: Finding, kindOf: PlannedKind): string | null {
  const ids = new Set<string>();
  if (f.where.elementId !== null) ids.add(f.where.elementId);
  for (const p of f.pieces) if (p.elementId !== null) ids.add(p.elementId);
  const kinds = new Set([...ids].map(kindOf));
  for (const [kind, words] of PLAN_PLACED)
    if (kinds.has(kind))
      return kind === "feature" && SUPPORT_CODES.has(f.code)
        ? "move it or pick another support for it"
        : words;
  return null;
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
 * The measured findings for the parts in view, in plain words with the place the model can act on, faults first,
 * each marked with the plan change that fixes it or as the app's own placement (`kindOf`: the plan's elements; absent,
 * no mark); then how many were measured elsewhere on the map. `findings` null: the checks could not run (nothing is
 * said). `stats` counts the box tests (the large-scene test holds the index to it).
 */
export function findingsText(
  scene: Scene,
  findings: readonly Finding[] | null,
  drawnPerView: ReadonlyArray<ReadonlySet<number>>,
  kindOf?: PlannedKind,
  stats?: { boxTests: number },
): string {
  if (findings === null) return "";
  const views = drawnPerView.map((ids) => new DrawnView(scene, ids, stats));
  const lines: string[] = [];
  let elsewhere = 0;
  const ordered = [...findings].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "fault" ? -1 : 1,
  );
  for (const f of ordered) {
    const shown = views.flatMap((v, i) => (inView(f, v) ? [i + 1] : []));
    if (shown.length === 0) {
      elsewhere++;
      continue;
    }
    const worth = f.severity === "warn" ? " (worth a look; often fine)" : "";
    const fix = kindOf ? planFix(f, kindOf) : undefined;
    const mark = fix === undefined ? "" : fix === null ? ` ${APP_PLACED_WORDS}` : ` Plan fix: ${fix}.`;
    lines.push(`- view ${shown.join(", ")}, ${whereOf(scene, f)}: ${f.message}${worth}.${mark}`);
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
  /** The plan's elements, to mark each finding as plan-fixable or the app's own. */
  kindOf?: PlannedKind,
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
  const measured = findings !== undefined ? findingsText(scene, findings, drawn, kindOf) : "";
  return {
    png: encodePng(numberedSheet(pictures, SHEET_SIZE.width, SHEET_SIZE.height)),
    captions,
    suggestions: measured !== "" ? `${measured}\n${next}` : next,
    views: pictures.length,
  };
}
