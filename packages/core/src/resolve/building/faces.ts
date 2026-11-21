/**
 * What stands in a building's faces: the written openings (and a default door), chimneys, and the automatic windows.
 *
 * `BuildingFaces` is the record of the face cells taken per volume and storey and of the openings placed; it lives
 * across steps: openings, chimneys and windows take cells and add openings, the condition step drops windows and adds
 * breaches (condition.ts), and door lights read which face cells are free (fittings.ts).
 */
import type { Building, Side, Vec2 } from "../../contracts/plan";
import { BUILD_CONSTANTS } from "../../contracts/plan";
import { SIDE_STEP as STEP, SIDES } from "../../gen/gridGeometry";
import { WINDOW_SPACING } from "../structureStyles";
import type { BuildingCtx } from "./context";
import { along, DOOR_KINDS, type FaceRun, faceKey, faceRuns, key, pickRange } from "./footprint";
import type { Chimney, GroundOpening, UpperOpening, VolumePlan, VStorey } from "./types";
import type { GroundFootprint } from "./volumes";

/** Ground storey faces belong to every ground volume (one area): their faces are taken under this key. */
export const GROUND_FACES = "@ground";

/** A written opening of the building (Building.openings), or the default door. */
type WrittenOpening = NonNullable<Building["openings"]>[number];

export class BuildingFaces {
  /** "volume:storey" → face cells taken ("x,y,side"). */
  private readonly used = new Map<string, Set<string>>();
  private readonly counter: Record<string, number> = {};
  readonly ground: GroundOpening[] = [];
  readonly upper: UpperOpening[] = [];

  constructor(private readonly id: string) {}

  /** The key a storey's faces are taken under: the ground storey of a ground volume shares the ground's. */
  keyOf(v: VolumePlan, s: number): [string, number] {
    return s === 0 && v.on === null ? [GROUND_FACES, 0] : [v.id, s];
  }

  take(v: string, s: number, k: string): void {
    const set = this.used.get(`${v}:${s}`) ?? new Set<string>();
    set.add(k);
    this.used.set(`${v}:${s}`, set);
  }

  isTaken(v: string, s: number, k: string): boolean {
    return this.used.get(`${v}:${s}`)?.has(k) ?? false;
  }

  /** The next synthetic id of a ground opening of this kind ("<building>~<kind><n>"). */
  nextId(kind: string): string {
    const n = this.counter[kind] ?? 0;
    this.counter[kind] = n + 1;
    return `${this.id}~${kind}${n}`;
  }
}

/** A neighbouring building stands on this cell (a party wall: no windows, no default door). */
export function party(b: BuildingCtx, x: number, y: number): boolean {
  const o = b.work.neighbours.get(key(x, y));
  return o !== undefined && o !== b.st.id;
}

/**
 * The written openings, after a default door when the ground storey has none (on a face with room in front, not a
 * party wall): ground openings on the whole footprint's faces, upper ones on the main volume. Returns the openings as
 * placed in order (with the default door first), which the chimney step reads for the door faces.
 */
export function placeOpenings(
  b: BuildingCtx,
  fp: GroundFootprint,
  main: VolumePlan,
  faces: BuildingFaces,
): WrittenOpening[] {
  const { st, profile, prng } = b;
  const count = main.storeys.length;
  const opens: WrittenOpening[] = [...(st.openings ?? [])];
  if (!opens.some((o) => (o.storey ?? 0) === 0 && DOOR_KINDS.has(o.kind))) {
    const sides = SIDES.filter((s) => {
      const r = faceRuns(fp.cellSet, s)[0];
      if (!r) return false;
      const [dx, dy] = STEP[s];
      return r.cells.every(([x, y]) => b.inBounds(x + dx * 2, y + dy * 2) && !party(b, x + dx, y + dy));
    });
    const side = st.front ?? (sides.length > 0 ? (sides[prng.int(sides.length)] ?? "S") : "S");
    opens.unshift({ kind: "door", side, position: pickRange(prng, profile.variety.doorPosition) });
  }
  for (const o of opens) {
    const s = o.storey ?? 0;
    if (s >= count) {
      b.issue(
        "error",
        `building "${st.id}": opening on storey ${s}, but it has ${count} storey(s)`,
        `storeys are 0..${count - 1}`,
      );
      continue;
    }
    const faceSet = s === 0 ? fp.cellSet : (main.storeys[s]?.cellSet ?? fp.cellSet);
    const run = faceRuns(faceSet, o.side)[0];
    if (!run) {
      b.issue("error", `building "${st.id}" has no ${o.side} face`, "use N, E, S or W");
      continue;
    }
    const width = Math.min(o.width ?? (o.kind === "double_door" ? 2 : 1), run.cells.length);
    const pos = o.position ?? (DOOR_KINDS.has(o.kind) ? pickRange(prng, profile.variety.doorPosition) : 0.5);
    const a = along(run, pos, width);
    const c = run.cells[a] as [number, number];
    const [vk, vs] = faces.keyOf(main, s);
    for (let k = 0; k < width; k++) {
      const cc = run.cells[a + k] as [number, number];
      faces.take(vk, vs, faceKey(cc[0], cc[1], o.side));
    }
    if (s === 0)
      faces.ground.push({ id: faces.nextId(o.kind), kind: o.kind, at: [c[0], c[1]], side: o.side, width });
    else
      faces.upper.push({ storey: s, kind: o.kind, at: [c[0], c[1]], side: o.side, width, volume: main.id });
  }
  return opens;
}

/**
 * Chimneys: written, or drawn on a gable end of the main roof away from the doors; each stands outside the wall line
 * of the ground footprint at a face cell no opening took (the nearest free one), and takes that face on every storey.
 */
export function placeChimneys(
  b: BuildingCtx,
  fp: GroundFootprint,
  vplans: readonly VolumePlan[],
  main: VolumePlan,
  faces: BuildingFaces,
  opens: readonly WrittenOpening[],
): Chimney[] {
  const { st, profile, prng } = b;
  const chimneys: Chimney[] = [];
  const doorFaces = new Set(
    opens.filter((o) => (o.storey ?? 0) === 0 && DOOR_KINDS.has(o.kind)).map((o) => o.side),
  );
  const chimneyFaces = ((): Side[] => {
    // generator 3: a hip roof has no gable wall to carry a stack, so a drawn chimney would stand apart from wall and roof
    if (b.gen.wholeFacades && main.roof.layers[0]?.type === "hip") return [];
    const w0 = main.rects[0];
    const gables: Side[] = !w0 ? SIDES.slice() : w0.ridge === "ew" ? ["W", "E"] : ["N", "S"];
    const g = gables.filter((f) => !doorFaces.has(f));
    return g.length > 0 ? g : SIDES.filter((f) => !doorFaces.has(f));
  })();
  const chimneyIn =
    st.chimneys ??
    (chimneyFaces.length > 0 && prng.chance(profile.variety.chimneyChance)
      ? [
          {
            side: chimneyFaces[prng.int(chimneyFaces.length)] as Side,
            position: pickRange(prng, [0.35, 0.65]),
          },
        ]
      : []);
  for (const ch of chimneyIn) {
    const run = faceRuns(fp.cellSet, ch.side)[0];
    if (!run) {
      b.issue(
        "error",
        `building "${st.id}" has no ${ch.side} face for a chimney`,
        "use a side the building has",
      );
      continue;
    }
    let a = along(run, ch.position ?? 0.5, 1);
    const free = (i: number): boolean => {
      const c = run.cells[i] as [number, number];
      return !faces.isTaken(GROUND_FACES, 0, faceKey(c[0], c[1], ch.side));
    };
    if (!free(a)) {
      const alt = run.cells
        .map((_, i) => i)
        .filter(free)
        .sort((p, q) => Math.abs(p - a) - Math.abs(q - a))[0];
      if (alt === undefined) continue;
      a = alt;
    }
    const c = run.cells[a] as [number, number];
    const [dx, dy] = STEP[ch.side];
    const at: Vec2 = [c[0] + dx, c[1] + dy];
    if (!b.inBounds(at[0], at[1])) {
      b.issue(
        "error",
        `building "${st.id}": its ${ch.side} chimney would stand outside the level`,
        "use another side or move the building in",
      );
      continue;
    }
    for (const v of vplans)
      for (let s = 0; s < v.storeys.length; s++)
        faces.take(...faces.keyOf(v, s), faceKey(c[0], c[1], ch.side));
    chimneys.push({ at, side: ch.side, wall: [c[0], c[1]] });
  }
  return chimneys;
}

/** The street face (given, else the first door's face) and whether it is a shopfront (written, or drawn: prng3). */
export function drawFrontage(b: BuildingCtx, faces: BuildingFaces): { side: Side; shopfront: boolean } {
  const { st, profile, prng3 } = b;
  const side: Side = st.front ?? faces.ground.find((g) => DOOR_KINDS.has(g.kind))?.side ?? "S";
  const shopfront = st.shopfront ?? (profile.shopfront ? prng3.chance(profile.shopfront) : false);
  return { side, shopfront };
}

/**
 * Automatic windows (rhythm from the density, offset from the seed), per volume and storey: the ground storey first
 * (one face set for every ground volume), then the rest volume by volume. A face is split where another volume or a
 * neighbour covers it; a shopfront glazes the street face of the ground storey wall to wall.
 */
export function placeWindows(
  b: BuildingCtx,
  fp: GroundFootprint,
  vplans: readonly VolumePlan[],
  main: VolumePlan,
  faces: BuildingFaces,
  frontage: { side: Side; shopfront: boolean },
): void {
  const offset = b.prng.int(3);
  const rows = { b, fp, vplans, faces, frontage, offset };
  windowsFor(rows, main, 0, fp.cellSet, main.storeys[0] as VStorey);
  for (const v of vplans)
    v.storeys.forEach((sp, s) => {
      if (s === 0 && v.on === null) return;
      windowsFor(rows, v, s, sp.cellSet, sp);
    });
}

interface WindowRows {
  readonly b: BuildingCtx;
  readonly fp: GroundFootprint;
  readonly vplans: readonly VolumePlan[];
  readonly faces: BuildingFaces;
  readonly frontage: { side: Side; shopfront: boolean };
  /** Where the rhythm starts along each face (drawn once per building). */
  readonly offset: number;
}

/** The windows of one storey of one volume. */
function windowsFor(
  r: WindowRows,
  v: VolumePlan,
  s: number,
  faceSet: ReadonlySet<string>,
  sp: VStorey,
): void {
  if (sp.walls === null || sp.density === "none") return;
  const [vk] = r.faces.keyOf(v, s);
  for (const side of SIDES)
    for (const run0 of faceRuns(faceSet, side)) {
      // a shopfront: wide glazing close together on the ground storey's street face
      const shop = r.frontage.shopfront && vk === GROUND_FACES && side === r.frontage.side;
      for (const cellsRun of uncoveredStretches(r, v, sp, run0)) {
        if (shop) glazeShopfront(r, cellsRun, side);
        else windowRhythm(r, v, s, WINDOW_SPACING[sp.density], cellsRun, side);
      }
    }
}

/** The face run split where another volume's storey covers it at the same height, or a neighbour stands. */
function uncoveredStretches(
  r: WindowRows,
  v: VolumePlan,
  sp: VStorey,
  run: FaceRun,
): Array<Array<[number, number]>> {
  const [dx, dy] = STEP[run.side];
  /** Faces of a storey's cells that another volume's storey covers at the same height have no wall. */
  const covered = (x: number, y: number): boolean =>
    r.vplans.some(
      (o) =>
        o !== v &&
        o.storeys.some(
          (os) =>
            os.cellSet.has(key(x, y)) &&
            Math.min(os.relTop, sp.relTop) - Math.max(os.relFloor, sp.relFloor) >
              BUILD_CONSTANTS.floorThickness,
        ),
    );
  const parts: Array<Array<[number, number]>> = [[]];
  for (const c of run.cells) {
    if (covered(c[0] + dx, c[1] + dy) || party(r.b, c[0] + dx, c[1] + dy)) parts.push([]);
    else parts[parts.length - 1]?.push(c);
  }
  return parts;
}

/** The wall outside this face cell meets another wall of the building in the same host cell (an inner corner). */
function innerCorner(cellSet: ReadonlySet<string>, c: readonly [number, number], side: Side): boolean {
  const [dx, dy] = STEP[side];
  const hx = c[0] + dx;
  const hy = c[1] + dy;
  return dx === 0
    ? cellSet.has(key(hx - 1, hy)) || cellSet.has(key(hx + 1, hy))
    : cellSet.has(key(hx, hy - 1)) || cellSet.has(key(hx, hy + 1));
}

/** A shopfront is glazed wall to wall: a window in every free cell of the street face (doors stay). */
function glazeShopfront(
  { b, fp, faces }: WindowRows,
  cellsRun: ReadonlyArray<[number, number]>,
  side: Side,
): void {
  const n = cellsRun.length;
  for (const [ci, c] of cellsRun.entries()) {
    const k = faceKey(c[0], c[1], side);
    if (faces.isTaken(GROUND_FACES, 0, k) || innerCorner(fp.cellSet, c, side)) continue;
    // generator 3 (cottage-like walls): a corner cell keeps its wall, a window there is walled over
    if (b.gen.wholeFacades && (ci === 0 || ci === n - 1) && n >= 3) continue;
    faces.take(GROUND_FACES, 0, k);
    faces.ground.push({ id: faces.nextId("window"), kind: "window", at: [c[0], c[1]], side, width: 1 });
  }
}

/** Windows along a stretch at the storey's spacing, never at its ends, an inner corner or beside a taken face cell. */
function windowRhythm(
  { b, fp, faces, offset }: WindowRows,
  v: VolumePlan,
  s: number,
  spacing: number,
  cellsRun: ReadonlyArray<[number, number]>,
  side: Side,
): void {
  const [vk, vs] = faces.keyOf(v, s);
  const n = cellsRun.length;
  const width = Math.min(b.profile.windows.width, 2);
  // generator 3: no blank wall (the baseline every condition inherits): a face of three cells or more gets a
  // window (one cell wide when two will not fit), and the gap between windows is at most three cells
  const noBlankWall = b.gen.wholeFacades;
  const wd = noBlankWall && n < width + 2 && n >= 3 ? 1 : width;
  const gap = noBlankWall ? Math.min(spacing, 3) : spacing;
  if (n < wd + 2) return;
  const keepFree = (i: number): boolean => {
    if (i < 1 || i >= n - 1) return false;
    const c = cellsRun[i] as [number, number];
    if (innerCorner(fp.cellSet, c, side)) return false;
    for (const d of [-1, 0, 1]) {
      const cc = cellsRun[i + d];
      if (cc && faces.isTaken(vk, vs, faceKey(cc[0], cc[1], side))) return false;
    }
    return !faces.isTaken(vk, vs, faceKey(c[0], c[1], side));
  };
  let p = 1 + (offset % Math.max(1, Math.min(gap, n - wd - 1)));
  while (p + wd - 1 <= n - 2) {
    let ok = true;
    for (let k = 0; k < wd; k++) if (!keepFree(p + k)) ok = false;
    if (!ok) {
      p++;
      continue;
    }
    const c = cellsRun[p] as [number, number];
    for (let k = 0; k < wd; k++) {
      const cc = cellsRun[p + k] as [number, number];
      faces.take(vk, vs, faceKey(cc[0], cc[1], side));
    }
    if (vk === GROUND_FACES)
      faces.ground.push({ id: faces.nextId("window"), kind: "window", at: [c[0], c[1]], side, width: wd });
    else faces.upper.push({ storey: s, kind: "window", at: [c[0], c[1]], side, width: wd, volume: v.id });
    p += wd + gap;
  }
}
