/**
 * Condition: a weathered or ruined building loses roof pieces, its chimney, doors and lights; breaches open in a ruined
 * ground storey; rubble and growth gather at its foot (the compiler also breaks the upper wall courses).
 *
 * Generator 3 (switch `legibleCondition`) makes the signs read from the game camera: a ragged roof hole and a second
 * one, boarded windows, bitten parapets, a lost detail, rubble on the cut wall tops, heaps where walls fell, growth at
 * the foot and climbing the walls. Every generator 3 sign draws from a stream of its own, so generator 2 draws (the
 * "condition" stream, `prng4`) are untouched.
 *
 * Reads and writes: the volumes' roofs (broken, fallen layers), the faces (windows dropped, doorways opened, breaches
 * added), `work.designs` (a lost hung detail). Returns what the building records of its decay.
 */
import type { PlaceCondition, Side } from "../../contracts/plan";
import { SIDE_STEP as STEP, SIDES } from "../../gen/gridGeometry";
import { isPassage, isWindow, openingTests } from "../../gen/openingKinds";
import { isPlankWallStyle } from "../../gen/wallStyles";
import { subSeed } from "../../util/hash";
import { createPrng, type Prng } from "../../util/prng";
import { climbingGrowth } from "../growth";
import { firstHungDetail } from "../designDetails";
import { isFlatRoof, isPitchedRoof, roofEnds } from "../roofTypes";
import { type RuinProfile, ruinProfile, scatterTopRubble } from "../ruin";
import { FOOT_DEBRIS, ROOF_BROKEN, RUINED, WEATHERED } from "./conditionRates";
import type { BuildingCtx } from "./context";
import { type BuildingFaces, GROUND_FACES, party } from "./faces";
import { alongFace, cellOf, faceKey, faceRuns, key, ringOf } from "./footprint";
import type { BuildingPlan, Chimney, GroundOpening, Porch, VolumePlan } from "./types";
import { buildingSubject, type Subject } from "../recipes/treatments";
import { ruinBays } from "./ruinBays";
import { characterAt, structureCondition } from "../character";
import { builtCondition } from "../../gen/buildingCondition";

/** A building as the treatments see it (generator 5): its condition state and role from its plan words. */
export function buildingSubjectOf(
  b: BuildingCtx,
  fp: { readonly cells: ReadonlyArray<[number, number]> },
  vplans: readonly VolumePlan[],
  condition: PlaceCondition,
): Subject {
  const { st } = b;
  return buildingSubject(
    st.id,
    fp.cells,
    st.theme ?? b.levelTheme,
    Math.max(1, maxOf(vplans.map((v) => v.storeys.length))),
    { condition, name: st.name, tags: st.tags, notes: st.notes, use: st.use },
    characterAt(b.work, st.id),
  );
}

type GrowthLevel = NonNullable<BuildingPlan["growthLevel"]>;

/** (ramshackleSigns) Share of the windows boarded, by condition state (generator 3 boards a third of any weathered). */
const BOARDED = { worn: 0.2, ramshackle: 0.6 } as const;
import type { GroundFootprint } from "./volumes";
import { maxOf, pushAll } from "../../util/lists";

export interface Decay {
  readonly condition: BuildingPlan["condition"];
  /** Generator 3, weathered or ruined: how overgrown the building is (null otherwise). */
  readonly growthLevel: GrowthLevel | null;
  readonly ruin: RuinProfile | null;
  readonly debris: BuildingPlan["debris"];
  readonly growth: BuildingPlan["growth"];
}

/** What every condition step of one building reads, and the lists they fill. */
interface DecayWork {
  readonly b: BuildingCtx;
  readonly fp: GroundFootprint;
  readonly vplans: readonly VolumePlan[];
  readonly main: VolumePlan;
  readonly faces: BuildingFaces;
  readonly ruin: RuinProfile;
  readonly ruined: boolean;
  readonly legible: boolean;
  readonly heavyGrowth: boolean;
  /** The "condition" stream (generator 2 draws). */
  readonly prng4: Prng;
  readonly debris: BuildingPlan["debris"];
}

export function applyCondition(
  b: BuildingCtx,
  fp: GroundFootprint,
  vplans: readonly VolumePlan[],
  main: VolumePlan,
  faces: BuildingFaces,
  chimneys: readonly Chimney[],
  porches: readonly Porch[] = [],
): Decay {
  const { st, profile, seed } = b;
  // generator 5 (characterCascade): the condition its character resolved (stated, worded or drawn from its district)
  const ch = characterAt(b.work, st.id);
  const condition =
    ch !== null ? structureCondition(ch) : builtCondition(st.condition ?? profile.condition ?? "intact");
  const legible = b.gen.legibleCondition;
  const prng4 = createPrng(subSeed(seed, "condition"));
  const debris: BuildingPlan["debris"] = [];
  const growth: BuildingPlan["growth"] = [];
  // generator 3: how overgrown the building is (the plan's word, else light for weathered, medium for ruined)
  const growthLevel: GrowthLevel | null =
    legible && condition !== "intact" ? (st.growth ?? (condition === "ruined" ? "medium" : "light")) : null;
  if (condition === "intact") return { condition, growthLevel, ruin: null, debris, growth };
  const ruined = condition === "ruined";
  // generator 5: a ruin is a sound building that lost whole bays (resolve/building/ruinBays.ts)
  if (ruined && b.gen.ruinBays) {
    const s = buildingSubjectOf(b, fp, vplans, condition);
    const ruin = ruinBays(b, fp, vplans, main, faces, porches, s);
    const d: DecayWork = {
      b,
      fp,
      vplans,
      main,
      faces,
      ruin,
      ruined,
      legible,
      heavyGrowth: growthLevel === "heavy",
      prng4,
      debris,
    };
    dropWindowsAboveWallTops(d);
    for (const v of vplans) {
      if (s.severity === 3) {
        v.roof.layers = [];
        v.roof.deck = false;
      } else v.roof.broken = Math.max(v.roof.broken, ROOF_BROKEN.keptAnchor);
    }
    main.roof.summary.broken = Math.max(main.roof.summary.broken, ROOF_BROKEN.keptAnchor);
    for (const g of faces.ground) if (isPassage(g.kind)) g.kind = "open";
    const blocked = doorPaths(faces.ground, openingTests(b.gen).doorway);
    if (legible) {
      const openKeys = new Set<string>();
      for (const g of faces.ground)
        for (let k = 0; k < g.width; k++) openKeys.add(faceKey(...alongFace(g.at, g.side, k), g.side));
      scatterTopRubble(ruin, openKeys, subSeed(seed, "ruin"));
      pushAll(growth, climbing(d, blocked, growthLevel));
    }
    return { condition, growthLevel, ruin, debris, growth };
  }
  const ruin = ruinOf(b, vplans, main, faces, condition, ruined, legible);
  const d: DecayWork = {
    b,
    fp,
    vplans,
    main,
    faces,
    ruin,
    ruined,
    legible,
    heavyGrowth: growthLevel === "heavy",
    prng4,
    debris,
  };
  if (ruined) dropWindowsAboveWallTops(d);
  else weather(d, chimneys.length > 0);
  breakRoofs(d);
  if (ruined) {
    // the chimney fell with the roof (planBuilding keeps none); doorways stand empty
    for (const g of faces.ground) if (isPassage(g.kind)) g.kind = "open";
    breachGroundStorey(d);
  }
  // generator 3: broken blocks and rubble on the cut wall tops (never over a doorway, breach or window)
  if (ruined && legible) {
    const openKeys = new Set<string>();
    for (const g of faces.ground)
      for (let k = 0; k < g.width; k++) openKeys.add(faceKey(...alongFace(g.at, g.side, k), g.side));
    scatterTopRubble(ruin, openKeys, subSeed(seed, "ruin"));
  }
  const blocked = doorPaths(faces.ground, openingTests(b.gen).doorway);
  // generator 5: a weathered building's foot is dressed by its treatment (the `wallFootGrowth` recipe: off its doors'
  // faces, by distance from use), not by heaps in the ring round it
  const footByRecipe = b.gen.wallFootGrowth && !ruined;
  if (!footByRecipe) scatterFootDebris(d, blocked);
  if (legible && !ruined && !footByRecipe) footGrowth(d, blocked);
  if (ruined) insideRubble(d, blocked);
  if (ruined && legible) fallenHeaps(d, blocked);
  if (legible) pushAll(growth, climbing(d, blocked, growthLevel));
  return { condition, growthLevel, ruin, debris, growth };
}

/**
 * The wall tops and fallen floors (resolve/ruin.ts); a gable-roofed main mass keeps the gable wall nearest its standing
 * corner, its slopes fallen in (generator 3: not on timber walls: a lone stepped gable of planks is masonry logic).
 */
function ruinOf(
  b: BuildingCtx,
  vplans: readonly VolumePlan[],
  main: VolumePlan,
  faces: BuildingFaces,
  condition: "weathered" | "ruined",
  ruined: boolean,
  legible: boolean,
): RuinProfile {
  const { seed } = b;
  const timberWalls = legible && vplans.some((v) => v.on === null && isPlankWallStyle(v.storeys[0]?.walls));
  const gableWing =
    ruined && !timberWalls && roofEnds(main.roof.layers[0]?.type) === "gable" ? main.rects[0] : undefined;
  return ruinProfile(
    vplans,
    condition,
    subSeed(seed, "ruin"),
    gableWing,
    new Set(vplans.filter((v) => v.roof.layers.length > 0).map((v) => v.id)),
    {
      legibleCondition: legible,
      pitched: new Set(vplans.filter((v) => isPitchedRoof(v.roof.layers[0]?.type)).map((v) => v.id)),
      // generator 3: a ruin of several volumes keeps one whole under its roof more often than not
      keepRoofed:
        legible && ruined && vplans.filter((v) => v.on === null).length > 1
          ? createPrng(subSeed(seed, "anchor3")).chance(RUINED.keepRoofed)
          : false,
      openings: faces.ground.map((g) => ({ at: g.at, side: g.side, width: g.width })),
    },
  );
}

/** A ruin: a window in a stretch of wall that fell below the ground storey's top goes with the wall. */
function dropWindowsAboveWallTops({ ruin, vplans, faces }: DecayWork): void {
  const tops = new Map(ruin.columns.map((c) => [faceKey(c.at[0], c.at[1], c.side), c.top]));
  const groundTop = vplans[0]?.storeys[0]?.relTop ?? 0;
  const ground = faces.ground;
  for (let i = ground.length - 1; i >= 0; i--) {
    const g = ground[i];
    if (!g || !isWindow(g.kind)) continue;
    for (let k = 0; k < g.width; k++) {
      const [gx, gy] = alongFace(g.at, g.side, k);
      if ((tops.get(faceKey(gx, gy, g.side)) ?? Infinity) < groundTop - 1e-6) {
        ground.splice(i, 1);
        break;
      }
    }
  }
}

/**
 * Weathered: a patch of the main roof is gone (the eave pieces round it stay); its chimney has fallen. Generator 3 adds
 * the signs that read from the game camera (`ruin.weather`).
 */
function weather(d: DecayWork, hadChimney: boolean): void {
  const { b, vplans, ruin, prng4 } = d;
  const topMass = vplans.filter((v) => !vplans.some((o) => o.on === v.id) && v.roof.layers.length > 0);
  const host = topMass[prng4.int(Math.max(1, topMass.length))];
  const ts = host?.storeys[host.storeys.length - 1];
  if (ts && ts.rect.w >= 3 && ts.rect.h >= 3) {
    const cx = ts.rect.x + 1 + prng4.int(ts.rect.w - 2);
    const cy = ts.rect.y + 1 + prng4.int(ts.rect.h - 2);
    ruin.roofHoles = ts.cells.filter(([x, y]) => Math.abs(x - cx) <= 1 && Math.abs(y - cy) <= 1);
  }
  if (!d.legible) return;
  const lost: string[] = hadChimney ? ["chimney"] : [];
  // generator 3: the signs must read from the game camera (own stream; generator 2 draws are untouched)
  const wp = createPrng(subSeed(b.seed, "weather3"));
  if (ts) {
    raggedRoofHole(b, ruin, ts);
    secondRoofHole(ruin, ts, wp);
  }
  const wins = [
    ...d.faces.ground.filter((g) => isWindow(g.kind)),
    ...d.faces.upper.filter((g) => isWindow(g.kind)),
  ];
  // generator 5 (`ramshackleSigns`): a ramshackle building boards up most of its windows, a worn one few
  const state = d.b.gen.ramshackleSigns ? buildingSubjectOf(d.b, d.fp, d.vplans, "weathered").state : null;
  const share =
    state === "ramshackle" ? BOARDED.ramshackle : state === "worn" ? BOARDED.worn : WEATHERED.boardedShare;
  const boarded = boardWindows(d.faces, wins, wp, share);
  const bites = biteParapets(vplans, wp);
  const hung = loseHungDetail(b);
  if (hung) lost.push(hung);
  ruin.weather = { boarded, parapetBites: bites.sort(), lost, windows: wins.length };
}

type TopStorey = VolumePlan["storeys"][number];

/**
 * The fallen patch is ragged and sits at an eave or a corner, not in the middle (a clean square hole reads as a
 * skylight): a blob grown cell by cell from a corner of the top storey, preferring cells on its edge (own stream).
 */
function raggedRoofHole(b: BuildingCtx, ruin: RuinProfile, ts: TopStorey): void {
  if (!ruin.roofHoles || ts.cells.length < 9) return;
  const rp = createPrng(subSeed(b.seed, "roofhole3"));
  const own = new Set(ts.cells.map(([x, y]) => key(x, y)));
  const onEdge = (x: number, y: number): boolean =>
    SIDES.some((sd) => !own.has(key(x + STEP[sd][0], y + STEP[sd][1])));
  const corners: Array<[number, number]> = [
    [ts.rect.x, ts.rect.y],
    [ts.rect.x + ts.rect.w - 1, ts.rect.y],
    [ts.rect.x, ts.rect.y + ts.rect.h - 1],
    [ts.rect.x + ts.rect.w - 1, ts.rect.y + ts.rect.h - 1],
  ];
  const start = corners[rp.int(4)] as [number, number];
  const want = Math.max(
    WEATHERED.roofHoleMin,
    Math.round(ts.cells.length * (WEATHERED.roofHoleShare + WEATHERED.roofHoleExtra * rp.next())),
  );
  const blob = new Set<string>();
  if (own.has(key(start[0], start[1]))) blob.add(key(start[0], start[1]));
  while (blob.size < want && blob.size > 0) {
    const front: Array<[number, number, number]> = [];
    for (const k of blob) {
      const [x, y] = cellOf(k);
      for (const sd of SIDES) {
        const nx = x + STEP[sd][0];
        const ny = y + STEP[sd][1];
        if (own.has(key(nx, ny)) && !blob.has(key(nx, ny)))
          front.push([nx, ny, (onEdge(nx, ny) ? 3 : 1) * (0.4 + rp.next())]);
      }
    }
    if (front.length === 0) break;
    front.sort((a, b) => b[2] - a[2]);
    const pick = front[0] as [number, number, number];
    blob.add(key(pick[0], pick[1]));
  }
  if (blob.size >= 3) ruin.roofHoles = [...blob].map(cellOf);
}

/** A second fallen patch elsewhere on the same roof, with a clear cell between the two (weather stream). */
function secondRoofHole(ruin: RuinProfile, ts: TopStorey, wp: Prng): void {
  if (!ruin.roofHoles || ts.rect.w < 5 || ts.rect.h < 3) return;
  const taken = new Set(ruin.roofHoles.map(([x, y]) => key(x, y)));
  for (let t = 0; t < 8; t++) {
    const cx = ts.rect.x + 1 + wp.int(ts.rect.w - 2);
    const cy = ts.rect.y + 1 + wp.int(ts.rect.h - 2);
    const patch = ts.cells.filter(([x, y]) => Math.abs(x - cx) <= 1 && Math.abs(y - cy) <= 1);
    if (patch.length < 4 || patch.some(([x, y]) => taken.has(key(x, y)))) continue;
    // a clear cell between the patches keeps them two holes, not one
    if (patch.some(([x, y]) => SIDES.some((sd) => taken.has(key(x + STEP[sd][0], y + STEP[sd][1])))))
      continue;
    ruin.roofHoles = [...ruin.roofHoles, ...patch];
    break;
  }
}

/** A third of the windows are boarded (the opening is left out: that wall is built plain), at least one. */
function boardWindows(
  faces: BuildingFaces,
  wins: ReadonlyArray<{ at: readonly [number, number]; side: Side }>,
  wp: Prng,
  share: number = WEATHERED.boardedShare,
): string[] {
  const boardN = wins.length === 0 ? 0 : Math.max(1, Math.round(wins.length * share));
  const boarded = wp
    .shuffle(wins.map((w) => faceKey(w.at[0], w.at[1], w.side)))
    .slice(0, boardN)
    .sort();
  const board = new Set(boarded);
  for (const list of [faces.ground, faces.upper])
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i];
      if (g && isWindow(g.kind) && board.has(faceKey(g.at[0], g.at[1], g.side))) list.splice(i, 1);
    }
  return boarded;
}

/** A flat roof's parapet is bitten in places (a pitched roof hides its wall tops), as "x,y,side" in draw order. */
function biteParapets(vplans: readonly VolumePlan[], wp: Prng): string[] {
  const bites: string[] = [];
  for (const v of vplans) {
    const top = v.storeys[v.storeys.length - 1];
    if (!top || !v.roof.layers.some((l) => isFlatRoof(l.type) && l.parapet)) continue;
    const own = new Set(top.cells.map(([x, y]) => key(x, y)));
    for (const [x, y] of top.cells)
      for (const sd of SIDES)
        if (!own.has(key(x + STEP[sd][0], y + STEP[sd][1])) && wp.chance(WEATHERED.parapetBite))
          bites.push(faceKey(x, y, sd));
  }
  return bites;
}

/** A detail has fallen or been taken away: one hung detail (canopy, balcony, fire escape) of a drawn design. */
function loseHungDetail(b: BuildingCtx): string | undefined {
  const dz = b.work.designs.get(b.st.id);
  if (!dz) return undefined;
  const hung = firstHungDetail(dz.design.details);
  if (hung)
    b.work.designs.set(b.st.id, {
      ...dz,
      design: { ...dz.design, details: dz.design.details.filter((d) => d !== hung) },
    });
  return hung;
}

/**
 * Roofs break: the anchor of a generator 3 ruin keeps its roof, a little broken at the edges; a ruin's other roofs
 * have fallen in (the gable wall of a pitched one may stand).
 */
function breakRoofs({ vplans, main, ruin, ruined, legible }: DecayWork): void {
  for (const v of vplans) {
    if (ruined && ruin.keep === v.id) {
      v.roof.broken = Math.max(v.roof.broken, ROOF_BROKEN.keptAnchor);
      continue;
    }
    v.roof.broken = Math.max(
      v.roof.broken,
      ruined ? ROOF_BROKEN.ruined : legible ? ROOF_BROKEN.weatheredLegible : ROOF_BROKEN.weathered,
    );
    if (ruined) {
      if (v === main && ruin.gable) v.roof.gableOnly = ruin.gable;
      else v.roof.layers = [];
      v.roof.deck = false;
    }
  }
  main.roof.summary.broken = Math.max(
    main.roof.summary.broken,
    ruined ? ROOF_BROKEN.ruined : ROOF_BROKEN.weathered,
  );
}

/** Does opening g span cell c of the face on `side`? */
function onFace(
  g: { at: readonly [number, number]; side: Side; width: number },
  c: readonly [number, number],
  side: Side,
): boolean {
  if (g.side !== side) return false;
  for (let k = 0; k < g.width; k++) {
    const [gx, gy] = alongFace(g.at, side, k);
    if (gx === c[0] && gy === c[1]) return true;
  }
  return false;
}

/**
 * One or two breaches in a ruin's ground storey, away from the doorways: a breach may tear out a window, never a
 * doorway, a standing arch or a wall of the kept, roofed volume; tried on several faces until enough are open.
 */
function breachGroundStorey(d: DecayWork): void {
  const { b, fp, vplans, faces, ruin, legible, prng4 } = d;
  const ground = faces.ground;
  const doorway = openingTests(b.gen).doorway;
  const breaches = RUINED.breachesMin + prng4.int(RUINED.breachesExtra);
  // the walls of the kept, roofed volume are not breached
  const whole = new Set<string>();
  if (ruin.keep !== undefined)
    for (const c of ruin.columns) if (c.top >= c.full - 1e-6) whole.add(faceKey(c.at[0], c.at[1], c.side));
  let made = 0;
  for (let attempt = 0; attempt < RUINED.breachTries && made < breaches; attempt++) {
    const side = SIDES[prng4.int(4)] as Side;
    const run = faceRuns(fp.cellSet, side).sort((p, q) => q.cells.length - p.cells.length)[0];
    if (!run || run.cells.length < RUINED.breachMinRun) continue;
    const width = RUINED.breachWidthMin + prng4.int(RUINED.breachWidthExtra);
    const a0 = 1 + prng4.int(Math.max(1, run.cells.length - width - 1));
    const [dx, dy] = STEP[side];
    let free = true;
    for (let k = -1; k <= width && free; k++) {
      const c = run.cells[a0 + k];
      if (!c) continue;
      // doorways and their neighbours stay; windows (and slits and bars) inside the breach go
      if (ground.some((g) => doorway(g.kind) && onFace(g, c, side))) free = false;
      if (whole.has(faceKey(c[0], c[1], side))) free = false;
      // nor a standing arch (generator 3) and its jambs
      if (ruin.arches?.some((q) => onFace(q, c, side))) free = false;
      if (
        k >= 0 &&
        k < width &&
        (!b.inBounds(c[0] + dx * 2, c[1] + dy * 2) || party(b, c[0] + dx, c[1] + dy))
      )
        free = false;
    }
    if (!free) continue;
    const cells = run.cells.slice(a0, a0 + width);
    for (let i = ground.length - 1; i >= 0; i--) {
      const g = ground[i];
      if (g && !doorway(g.kind) && cells.some((c) => onFace(g, c, side))) ground.splice(i, 1);
    }
    for (const cc of cells) faces.take(GROUND_FACES, 0, faceKey(cc[0], cc[1], side));
    // generator 3: collapse goes top-down, so no upper wall hangs over a breach (the column ends at the storey's top)
    if (legible)
      for (const cc of cells) {
        const col = ruin.columns.find((q) => q.at[0] === cc[0] && q.at[1] === cc[1] && q.side === side);
        const gt = vplans[0]?.storeys[0]?.relTop;
        if (col && gt !== undefined && col.top > gt) col.top = gt;
      }
    const c = cells[0] as [number, number];
    ground.push({ id: faces.nextId("breach"), kind: "open", at: [c[0], c[1]], side, width });
    made++;
  }
}

/** Cells in a doorway's or breach's path (three cells out, one in, a cell either side): no heap lies there. */
function doorPaths(
  ground: readonly GroundOpening[],
  doorway: (kind: GroundOpening["kind"]) => boolean,
): Set<string> {
  const blocked = new Set<string>();
  for (const g of ground) {
    if (!doorway(g.kind)) continue;
    const [dx, dy] = STEP[g.side];
    for (let k = -1; k <= g.width; k++)
      for (let dd = -1; dd <= 3; dd++) {
        const [ax, ay] = alongFace(g.at, g.side, k);
        blocked.add(key(ax + dx * dd, ay + dy * dd));
      }
  }
  return blocked;
}

/** Free cells (in the level, no door path, no neighbour's footprint) of a ring of keys, sorted. */
function freeRingCells({ b }: DecayWork, ring: Iterable<string>, blocked: ReadonlySet<string>): string[] {
  return [...ring]
    .sort()
    .filter((k) => !blocked.has(k) && b.inBounds(...cellOf(k)) && !b.work.neighbours.has(k));
}

/** A heap within one cell of (x, y) already. */
function nearHeap({ debris }: DecayWork, x: number, y: number): boolean {
  return debris.some((d) => Math.abs(d.at[0] - x) <= 1 && Math.abs(d.at[1] - y) <= 1);
}

/**
 * Rubble and growth in the two rings around the walls, never in a door's path: a ruin's in proportion to how much fell
 * (its rubble mostly lies inside, `insideRubble`), a weathered building's a little at its foot.
 */
function scatterFootDebris(d: DecayWork, blocked: ReadonlySet<string>): void {
  const { fp, ruin, ruined, heavyGrowth, prng4 } = d;
  const ring2 = ringOf(new Set([...fp.cellSet, ...ringOf(fp.cellSet)]));
  const loss = ruin.loss;
  const r = heavyGrowth ? FOOT_DEBRIS.ruinedHeavy : FOOT_DEBRIS.ruined;
  const w = heavyGrowth ? FOOT_DEBRIS.weatheredHeavy : FOOT_DEBRIS.weathered;
  for (const k of freeRingCells(d, ring2, blocked)) {
    if (!prng4.chance(ruined ? r.base + r.perLoss * loss : w.chance)) continue;
    const [x, y] = cellOf(k);
    if (nearHeap(d, x, y)) continue;
    d.debris.push({ at: [x, y], kind: prng4.chance(ruined ? r.rubble : w.rubble) ? "rubble" : "growth" });
  }
}

/**
 * Generator 3, weathered: growth against the foot of the walls, a heap for about every seven wall faces (three when
 * heavily grown), never in a door's path (own stream).
 */
function footGrowth(d: DecayWork, blocked: ReadonlySet<string>): void {
  const { b, fp, heavyGrowth } = d;
  const wp2 = createPrng(subSeed(b.seed, "weather3b"));
  let faceCount = 0;
  for (const k of fp.cellSet) {
    const [x, y] = cellOf(k);
    for (const sd of SIDES) if (!fp.cellSet.has(key(x + STEP[sd][0], y + STEP[sd][1]))) faceCount++;
  }
  const foot = freeRingCells(d, ringOf(fp.cellSet), blocked);
  const want = Math.max(
    WEATHERED.footMin,
    Math.ceil(faceCount / (heavyGrowth ? WEATHERED.footFacesHeavy : WEATHERED.footFaces)),
  );
  let made = 0;
  for (const k of wp2.shuffle(foot)) {
    if (made >= want) break;
    const [x, y] = cellOf(k);
    if (nearHeap(d, x, y)) continue;
    d.debris.push({ at: [x, y], kind: "growth" });
    made++;
  }
}

/**
 * A ruin's rubble inside its walls: off the wall cells (a heap there would lean into the wall), never two side by side,
 * scaled to the rubble outside and how much fell; the first is rubble, the next two story props in a large ruin.
 */
function insideRubble(d: DecayWork, blocked: ReadonlySet<string>): void {
  const { fp, ruin, heavyGrowth, prng4, debris } = d;
  const cellSet = fp.cellSet;
  const inside = [...cellSet].sort().filter((k) => {
    const [x, y] = cellOf(k);
    return !blocked.has(k) && SIDES.every((sd) => cellSet.has(key(x + STEP[sd][0], y + STEP[sd][1])));
  });
  const want = Math.max(
    RUINED.insideMin,
    Math.round(debris.filter((q) => q.kind === "rubble").length * RUINED.insidePerOutside) +
      Math.round(inside.length * RUINED.insidePerCellLoss * ruin.loss),
  );
  const picked: string[] = [];
  for (const k of prng4.shuffle(inside)) {
    if (picked.length >= Math.min(Math.round(inside.length * RUINED.insideMaxShare), want)) break;
    const [x, y] = cellOf(k);
    if (
      picked.some((p) => {
        const [px, py] = cellOf(p);
        return Math.abs(px - x) <= 1 && Math.abs(py - y) <= 1;
      })
    )
      continue;
    picked.push(k);
  }
  picked.forEach((k, i) => {
    const [x, y] = cellOf(k);
    debris.push({
      at: [x, y],
      kind:
        i === 0
          ? "rubble"
          : i <= 2 && inside.length >= RUINED.insidePropsFrom
            ? "prop"
            : prng4.chance(heavyGrowth ? RUINED.insideRubbleHeavy : RUINED.insideRubble)
              ? "rubble"
              : "growth",
    });
  });
}

/**
 * Generator 3, ruined: what fell lies on the ground beside where it fell: clusters of heaps within two or three cells
 * of each fallen stretch of wall, inside and outside, not in the ring cell the vines use (own stream).
 */
function fallenHeaps(d: DecayWork, blocked: ReadonlySet<string>): void {
  const { b, fp, ruin, heavyGrowth, debris } = d;
  const fp3 = createPrng(subSeed(b.seed, "fallen3"));
  const have = new Set(debris.map((q) => key(q.at[0], q.at[1])));
  const fallenCols = ruin.columns.filter((c) => {
    const [dx, dy] = STEP[c.side];
    return c.full - c.top >= RUINED.fallenDrop && !fp.cellSet.has(key(c.at[0] + dx, c.at[1] + dy));
  });
  let budget = Math.max(RUINED.fallenMinBudget, Math.round(fallenCols.length * RUINED.fallenPerColumn));
  for (const c of fp3.shuffle(fallenCols)) {
    if (budget <= 0) break;
    const [dx, dy] = STEP[c.side];
    const [lx, ly] = [Math.abs(dy), Math.abs(dx)];
    const spots: Array<[number, number]> = [];
    for (const dd of [-1, 0, 2, 3])
      for (const l of [-1, 0, 1]) spots.push([c.at[0] + dx * dd + lx * l, c.at[1] + dy * dd + ly * l]);
    const n = Math.min(RUINED.fallenMaxPerColumn, 1 + Math.round((c.full - c.top) / 2) + fp3.int(2));
    let made = 0;
    for (const [x, y] of fp3.shuffle(spots)) {
      if (made >= n) break;
      const k = key(x, y);
      if (have.has(k) || !b.inBounds(x, y) || blocked.has(k) || b.work.neighbours.has(k)) continue;
      have.add(k);
      debris.push({
        at: [x, y],
        kind: fp3.chance(heavyGrowth ? RUINED.fallenRubbleHeavy : RUINED.fallenRubble) ? "rubble" : "growth",
      });
      made++;
      budget--;
    }
  }
}

/**
 * Generator 3: growth that climbs the structure (vines up the faces, roots at the base, plants on cut tops, a tree in
 * a roofless middle), kept off the openings' faces; own stream (resolve/growth.ts).
 */
function climbing(
  d: DecayWork,
  blocked: ReadonlySet<string>,
  growthLevel: GrowthLevel | null,
): BuildingPlan["growth"] {
  const { b, fp, vplans, main, faces, ruin, ruined, heavyGrowth, debris } = d;
  const ground = faces.ground;
  const faceKeys = new Set<string>();
  const around = (at: readonly [number, number], side: Side, from: number, to: number): void => {
    for (let k = from; k <= to; k++) faceKeys.add(faceKey(...alongFace(at, side, k), side));
  };
  // (heavy growth frames the windows: ivy runs up to a window's edge, never across it)
  for (const g of ground)
    if (heavyGrowth && isWindow(g.kind)) around(g.at, g.side, 0, g.width - 1);
    else around(g.at, g.side, -1, g.width);
  for (const q of ruin.arches ?? []) around(q.at, q.side, -1, q.width);
  // (a weathered or ruined building has lost its chimney: none to keep clear)
  const upperFaces = new Set<string>();
  for (const g of faces.upper) around(g.at, g.side, 0, g.width - 1);
  const groundTop = main.storeys[0]?.relTop ?? 2;
  const taken2 = new Set((ruin.topRubble ?? []).map((t) => faceKey(t.at[0], t.at[1], t.side)));
  const heapCells = new Set(debris.map((q) => key(q.at[0], q.at[1])));
  const open = new Set<string>();
  // a tree stands well clear of every doorway and breach (its crown is two and a half cells wide)
  const doorZone = new Set<string>();
  for (const g of ground)
    for (let k = -3; k <= g.width + 2; k++)
      for (let dd = -4; dd <= 4; dd++) {
        const [sx, sy] = STEP[g.side];
        const [ax, ay] = alongFace(g.at, g.side, k);
        doorZone.add(key(ax + sx * dd, ay + sy * dd));
      }
  if (ruined)
    for (const v of vplans)
      if (v.on === null && v.roof.layers.length === 0)
        for (const [x, y] of v.storeys[0]?.cells ?? []) {
          let clear = !doorZone.has(key(x, y));
          // (a heavily overgrown ruin plants its trees among the bushes: only the tree's own cell is kept clear)
          for (let dy = heavyGrowth ? 0 : -1; dy <= (heavyGrowth ? 0 : 1) && clear; dy++)
            for (let dx = heavyGrowth ? 0 : -1; dx <= (heavyGrowth ? 0 : 1); dx++)
              if (heapCells.has(key(x + dx, y + dy))) clear = false;
          if (clear) open.add(key(x, y));
        }
  return climbingGrowth({
    seed: subSeed(b.seed, "growth3"),
    ruined,
    level: growthLevel ?? "light",
    columns: ruin.columns,
    anchor: ruin.anchor,
    cellSet: fp.cellSet,
    blocked: faceKeys,
    upperFaces,
    groundTop,
    // (a foot heap in or beside the ring cell, a door path or a neighbour takes the face: a heap is wider than its cell)
    ringFree: (x, y) =>
      b.inBounds(x, y) &&
      !b.work.neighbours.has(key(x, y)) &&
      !blocked.has(key(x, y)) &&
      // (vines meet the heaps at the foot: only a heap in the ring cell itself takes the face)
      !heapCells.has(key(x, y)),
    topTaken: taken2,
    open,
  });
}
