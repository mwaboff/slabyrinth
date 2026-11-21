/**
 * Built interiors (generator 4): room floors and steps before the edges (step 4), and, with the features (step 9),
 * the default dressing of rooms by purpose and the rubble at the foot of rough walls.
 * Reads: the areas' room class (purpose, abandoned), interior character and rough finish, the theme's floors and the
 * palette's floor tile sizes and room pieces, which areas a corridor opens on, link cells, the walls and openings.
 * Writes: room floor materials and the quarter-tile step of a room entered from a corridor (cell heights), the
 * rooms' furniture, things on it and lights (via gen/rooms4.ts), and the wall-foot rubble features.
 */
import type { AreaKind, FeatureType, Material, Side, Vec2 } from "../../contracts/plan";
import { MATERIALS, PLAN_LIMITS } from "../../contracts/plan";
import type { ResolvedFeature } from "../../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../../contracts/resolved";
import { featureInfo, rotatedSize } from "../../gen/catalog";
import type { GeneratedPlacement, PlacementGrid } from "../../gen/place";
import { furnishedPurpose } from "../../gen/roomPurpose";
import { dressRoom, lightArea } from "../../gen/rooms4";
import { isUnevenWallStyle } from "../../gen/wallStyles";
import { linkCellsOnLevel } from "../../plan/links";
import { elementSeed, h32, subSeed } from "../../util/hash";
import { BUILT_FLOORS, FAMILY_ROTATION, purposeFloor } from "../interiorFloors";
import { materialOrdinal } from "../materials";
import { commitGenerated, placementGrid } from "./features";
import type { AreaInfo, ResolveGrid } from "./grid";

/**
 * Generator 4, built interiors (level base solid): rooms are told apart by floor and sit a step above the corridor
 * (resolve/interiorFloors.ts).
 *  (a) a room whose floor is the theme default (the model writes `flagstone` on every room, which says nothing) takes
 *      the floor its purpose asks for in the theme's floor family (gen/roomPurpose.ts, from the purpose the room was
 *      classified with once), else the first built floor that none of the rooms or corridors beside it mostly uses;
 *      corridor-like rooms (a landing, a passage), abandoned rooms and floors the plan chose on purpose are left alone;
 *  (b) a room a corridor opens on (a door or an unwalled boundary, not a wall it merely touches: see
 *      roomsOpeningOnCorridors), with no floorHeight and no height of its own (no dais, hole, steps or link)
 *      is raised a quarter tile; the lip at its door is the step. A miniature climbs half a tile, so a quarter is
 *      always walkable, and walls take their height from the lower floor (resolve/wallspan.ts), so tops stay put.
 * Rooms that hold a link end (stairs, ladder) keep their floor height: the climb lands on the level's own floor top.
 */
export function stepRoomFloors(work: ResolveGrid): void {
  if (work.level.base.type !== "solid") return;
  const rooms = work.areas.filter(
    (a) =>
      a.kind === "room" &&
      !a.isZone &&
      !a.isRoute &&
      !a.isBridge &&
      !a.floorNone &&
      a.area.shape.type !== "route",
  );
  if (rooms.length === 0) return;
  // cells that hold a link end on this level (lower run, the well above it, the landing)
  const linkCells = new Set<number>();
  for (const c of linkCellsOnLevel(work.plan, work.level.id)) {
    const i = work.idx(c[0], c[1]);
    if (i >= 0) linkCells.add(i);
  }
  const cellsOf = new Map<number, number[]>();
  const nbrs = new Map<number, Set<number>>();
  for (const a of work.areas) {
    if (a.isZone) continue;
    cellsOf.set(a.index, work.areaCells(a.index));
  }
  for (const [ai, cells] of cellsOf) {
    const set = new Set<number>();
    for (const i of cells) {
      const [x, y] = work.cellXY(i);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const j = work.idx(x + dx, y + dy);
        if (j < 0 || work.state[j] !== CELL.OPEN) continue;
        const o = (work.struct[j] as number) - 1;
        if (o >= 0 && o !== ai) set.add(o);
      }
    }
    nbrs.set(ai, set);
  }
  // the floor an area mostly has (a dais or a painted patch does not count)
  const famOf = (ai: number): Material | undefined => {
    const count = new Map<number, number>();
    for (const i of cellsOf.get(ai) ?? []) {
      const m = work.mat[i] as number;
      if (m > 0) count.set(m, (count.get(m) ?? 0) + 1);
    }
    const top = [...count].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0];
    return top === undefined ? undefined : MATERIALS[top[0] - 1];
  };
  // (a) floors
  for (const info of rooms) {
    const td = work.ctx.themeDefaults(info.theme);
    if (!BUILT_FLOORS.has(td.floor)) continue;
    if (info.area.floor !== undefined && info.area.floor !== td.floor) continue;
    // the floor stays inside the theme's floor family: stone and earth below ground, wood and a few domestic tiles in
    // an inhabited timber building (the theme's interior character, resolve/themes.ts)
    const family = info.interior.floorFamily;
    const purpose = purposeFloor(info.room.purpose, family);
    // a corridor in all but name keeps the corridor's floor; an abandoned room keeps the level's default floor
    if (purpose === "keep" || info.room.abandoned) continue;
    const ns = [...(nbrs.get(info.index) ?? [])];
    const used = new Set<Material>(ns.map(famOf).filter((m): m is Material => m !== undefined));
    const rotation = FAMILY_ROTATION[family];
    const start =
      elementSeed(work.plan.seed, `${work.level.id}~${info.area.id}~floorfam`, undefined) % rotation.length;
    // a timber building keeps a room's purpose floor even when its neighbours share it (wood beside wood is one building);
    // the difference rule only picks among the rest
    const cand: Material[] = [
      ...(purpose !== null ? [purpose] : []),
      ...rotation.map((_, k) => rotation[(start + k) % rotation.length] as Material),
    ];
    const nCells = (cellsOf.get(info.index) ?? []).length;
    // a big room keeps to floors that come in big tiles (a 1x1-only tile would take four times the pieces)
    const pick = cand.find(
      (m) =>
        (!used.has(m) || (family === "timber" && m === purpose)) &&
        BUILT_FLOORS.has(m) &&
        (nCells <= 36 || (work.ctx.palette.floorTileArea(info.theme, m) ?? 4) >= 4),
    );
    if (pick === undefined || pick === td.floor) continue;
    const ord = materialOrdinal(pick);
    const cells = cellsOf.get(info.index) ?? [];
    for (const i of cells) if (work.mat[i] === info.floorMat) work.setMaterial(i, pick);
    info.floorMat = ord;
  }
  // (b) a step above the corridor, for a room you enter from one
  const joined = roomsOpeningOnCorridors(work, nbrs);
  for (const info of rooms) {
    if (info.area.floorHeight !== undefined) continue;
    const cells = cellsOf.get(info.index) ?? [];
    if (cells.length < 4) continue;
    if (!joined.has(info.index)) continue;
    const clean = cells.every(
      (i) =>
        work.height[i] === 0 &&
        !linkCells.has(i) &&
        ((work.flags[i] as number) &
          (CELL_FLAG.NO_FLOOR |
            CELL_FLAG.LINK |
            CELL_FLAG.STEPS |
            CELL_FLAG.BRIDGE |
            CELL_FLAG.WATER |
            CELL_FLAG.STAIRWELL)) ===
          0,
    );
    if (!clean) continue;
    for (const i of cells) work.height[i] = 1;
  }
}

/**
 * Rooms (area indexes) a corridor opens on: a plan opening between the two (by `between` or by an `at` edge with a
 * cell of each on its sides), a route corridor that ends on the room, or a shared boundary where no wall stands
 * (neither area builds walls, as in stepEdges). A room that only touches a corridor across a solid wall is not one.
 * Runs before the openings are placed, so it reads the plan's openings, not the edges.
 */
function roomsOpeningOnCorridors(
  work: ResolveGrid,
  nbrs: ReadonlyMap<number, ReadonlySet<number>>,
): Set<number> {
  const out = new Set<number>();
  const kindOf = (ai: number | undefined): AreaKind | undefined =>
    ai === undefined || ai < 0 ? undefined : work.areas[ai]?.kind;
  const pair = (a: number | undefined, b: number | undefined): void => {
    if (a === undefined || b === undefined) return;
    if (kindOf(a) === "room" && kindOf(b) === "corridor") out.add(a);
    if (kindOf(b) === "room" && kindOf(a) === "corridor") out.add(b);
  };
  const step: Record<Side, readonly [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
  for (const o of work.level.openings) {
    if (o.between) pair(work.areaIndexById.get(o.between[0]), work.areaIndexById.get(o.between[1]));
    else if (o.at) {
      const [dx, dy] = step[o.at.side];
      const width = o.width ?? (o.kind === "double_door" ? 2 : 1);
      // the run extends east along a horizontal edge (N/S side), south along a vertical one
      for (let k = 0; k < width; k++) {
        const x = o.at.x + (o.at.side === "N" || o.at.side === "S" ? k : 0);
        const y = o.at.y + (o.at.side === "E" || o.at.side === "W" ? k : 0);
        pair(work.owner(work.idx(x, y)) - 1, work.owner(work.idx(x + dx, y + dy)) - 1);
      }
    }
  }
  for (const info of work.areas) {
    const s = info.area.shape;
    if (info.kind !== "corridor" || s.type !== "route") continue;
    for (const end of [s.from, s.to])
      if (typeof end === "string") {
        const ai = work.areaIndexById.get(end);
        if (ai !== undefined && kindOf(ai) === "room") out.add(ai);
      }
  }
  for (const [ai, set] of nbrs) {
    if (kindOf(ai) !== "room") continue;
    for (const o of set)
      if (kindOf(o) === "corridor" && work.modeOf(ai + 1) !== "auto" && work.modeOf(o + 1) !== "auto")
        out.add(ai);
  }
  return out;
}

/**
 * Generator 4, rough interiors (level base solid, dungeon wall styles): rubble at the foot of the walls and either
 * side of about half the doorways, so the join of wall and floor is soft (about 1 pile per 10 floor tiles of a room,
 * the reference interior has 1.1). Low debris mostly; blocking rubble only in a corner or at a jamb of a room, never
 * in a corridor. Never on a link, steps, a doorway cell, a cell that holds a feature, or a collapse rim.
 */
export function stepWallFootRubble(work: ResolveGrid): void {
  if (!work.profile.wallFootRubble || work.level.base.type !== "solid" || work.structs) return;
  const seed = elementSeed(work.plan.seed, `${work.level.id}~footrubble`, undefined);
  const u = (k: string, i: number): number => h32(`${seed}:${k}:${i}`) / 4294967296;
  const roughSide = (x: number, y: number, s: Side): boolean => {
    const se = work.sideEdge(x, y, s);
    return se !== null && se.e.kind[se.i] === EDGE.WALL && isUnevenWallStyle(se.e.style[se.i]);
  };
  const sides: Side[] = ["N", "E", "S", "W"];
  const plain = (i: number): boolean => {
    if (i < 0 || work.state[i] !== CELL.OPEN || (work.occ[i] as number) > 0) return false;
    const f = work.flags[i] as number;
    if (
      f &
      (CELL_FLAG.NO_FLOOR |
        CELL_FLAG.LINK |
        CELL_FLAG.STEPS |
        CELL_FLAG.FEATURE |
        CELL_FLAG.STAIRWELL |
        CELL_FLAG.BRIDGE |
        CELL_FLAG.WATER)
    )
      return false;
    // only a rough interior has rubble at the wall foot: not a kept-up timber or plaster room (unless abandoned), and
    // not a cell outside every room (the same rule the compiler reads back, resolve/wallTops.ts roughCells)
    const ar = work.disp[i] as number;
    if (ar <= 0 || !(work.areas[ar - 1] as AreaInfo).rough) return false;
    const [x, y] = work.cellXY(i);
    for (const s of sides) {
      const k = work.edgeKindAt(x, y, s);
      if (k === EDGE.OPENING || k === EDGE.STAIR) return false;
    }
    return true;
  };
  const rims = new Set<number>();
  for (const fo of work.floorOpenings) for (const c of fo.rimCells) rims.add(c);
  const info = { debris: featureInfo("debris"), rubble: featureInfo("rubble") };
  const placed = new Set<number>();
  let n = 0;
  const put = (i: number, type: "debris" | "rubble"): boolean => {
    if (placed.has(i) || rims.has(i) || !plain(i)) return false;
    const [x, y] = work.cellXY(i);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (placed.has(work.idx(x + dx, y + dy))) return false;
    const size = rotatedSize(info[type].size, 0);
    const c: Vec2 = [x, y];
    if (work.featureProblem(type, c, size, undefined) !== null) return false;
    const rf: ResolvedFeature = {
      id: `walls#foot${n++}`,
      type,
      generatedBy: "walls",
      at: c,
      size,
      rot: 0,
      rotFine: (h32(`${seed}:rot:${i}`) % 24) * 15,
      baseHeight: work.featureBase(i, 0),
      theme: work.themes[work.theme[i] as number] ?? work.levelTheme,
      blocking: info[type].blocking,
    };
    const ar = work.disp[i] as number;
    if (ar > 0) rf.area = (work.areas[ar - 1] as AreaInfo).area.id;
    work.addFeatureCells(rf);
    placed.add(i);
    return true;
  };
  const inCorridor = (i: number): boolean => {
    const s = work.struct[i] as number;
    return s > 0 && (work.areas[s - 1] as AreaInfo).kind === "corridor";
  };
  // the foot of the walls
  for (let i = 0; i < work.n; i++) {
    if (!plain(i)) continue;
    const [x, y] = work.cellXY(i);
    const walls = sides.filter((s) => roughSide(x, y, s)).length;
    if (walls === 0) continue;
    const p = walls >= 2 ? 0.5 : 0.28;
    if (u("foot", i) >= p) continue;
    const block = walls >= 2 && !inCorridor(i) && u("blk", i) < 0.35;
    put(i, block ? "rubble" : "debris");
  }
  // either side of about half the doorways: the cells flanking the opening along its wall
  work.openings.forEach((op, k) => {
    if (op.kind === "open" || u("jamb", k + 7919) >= 0.5) return;
    const [sx, sy] = op.start;
    const flank: Vec2[] =
      op.orientation === "h"
        ? [
            [sx - 1, sy - 1],
            [sx - 1, sy],
            [sx + op.width, sy - 1],
            [sx + op.width, sy],
          ]
        : [
            [sx - 1, sy - 1],
            [sx, sy - 1],
            [sx - 1, sy + op.width],
            [sx, sy + op.width],
          ];
    const picks = flank
      .map((c, j) => ({ c, j, r: u("jc", k * 4 + j) }))
      .filter(({ c, j }) => {
        // the cell must stand against the wall the opening is in: even flanks lie north (west) of the line, so the wall is on their S (E) side
        const side: Side = op.orientation === "h" ? (j % 2 === 0 ? "S" : "N") : j % 2 === 0 ? "E" : "W";
        return roughSide(c[0], c[1], side);
      })
      .sort((a, b) => a.r - b.r)
      .slice(0, 2);
    for (const { c, j } of picks) {
      const i = work.idx(c[0], c[1]);
      if (i < 0) continue;
      put(i, !inCorridor(i) && j % 2 === 0 ? "rubble" : "debris");
    }
  });
}

/**
 * Generator 4: the default dressing of rooms (gen/rooms4.ts). An area of kind room whose name, tags or notes name a
 * purpose, that no dress op covers and that the plan furnished lightly (under 2 features per 10 floor tiles), gets
 * that purpose's furniture, things on it and lights. A room with no purpose, or one the plan furnished itself, still
 * gets its torches; a passage a few. Abandoned places (a crypt, cells, a ruin) stay sparse and keep one light at most.
 * `roomDress: false` on the level turns it off.
 */
export function stepRoomRecipes(work: ResolveGrid): void {
  const cap = PLAN_LIMITS.generatedFeaturesPerLevel;
  const dressed = new Set<string>();
  for (const op of work.level.terrain) if (op.op === "dress" && op.area !== undefined) dressed.add(op.area);
  const baseGrid = placementGrid(work);
  if (baseGrid.piece4 === undefined) return;
  for (const info of work.areas) {
    if (info.kind !== "room" && info.kind !== "corridor") continue;
    const area = info.area;
    const cells: Array<[number, number]> = [];
    for (let i = 0; i < work.n; i++)
      if (work.disp[i] === info.index + 1 && work.isFloor(i)) cells.push(work.cellXY(i));
    if (cells.length < 6) continue;
    const theme = info.theme;
    const grid: PlacementGrid = {
      ...baseGrid,
      piece4: (t: FeatureType, v?: string) => work.ctx.palette.roomPiece(theme, t, v),
    };
    const seed = subSeed(elementSeed(work.plan.seed, `${work.level.id}~${area.id}~room`, undefined), "room");
    const own = work.features.filter(
      (f) => f.area === area.id && f.generatedBy === undefined && f.type !== "torch_wall",
    ).length;
    const lightly = own * 10 < 2 * cells.length;
    // a corridor is never furnished, but its name still says whether it is kept up ("Crypt passage" stays dark)
    const { purpose, abandoned } = info.room;
    const ruin = purpose === "ruin";
    let res: { placements: GeneratedPlacement[]; capped: boolean } | null = null;
    if (info.kind === "room" && furnishedPurpose(purpose) && lightly && !dressed.has(area.id)) {
      res = dressRoom(grid, {
        purpose,
        abandoned,
        areaIndex: info.index + 1,
        areaCells: cells,
        density: 1,
        seed,
        remaining: cap - work.generated,
        have: work.features
          .filter((f) => f.area === area.id && f.generatedBy === undefined)
          .map((f) => f.type),
      });
    }
    // no recipe (no purpose, the plan's own furnishing, or no pieces to dress with): torches only, never in a ruin or
    // a room a dress op already composed
    if (res === null && !ruin && !dressed.has(area.id)) {
      res = lightArea(grid, {
        areaIndex: info.index + 1,
        areaCells: cells,
        seed,
        remaining: cap - work.generated,
        every: info.kind === "corridor" ? 18 : 12,
        abandoned,
      });
    }
    if (res === null) continue;
    commitGenerated(work, `${area.id}~room`, res.placements);
    if (res.capped) break;
  }
}
