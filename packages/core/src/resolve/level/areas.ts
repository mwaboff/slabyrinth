/**
 * The level's areas: the area table the grid is built with, then steps 1 and 3 of a level, the base and the areas.
 * Reads: the level's base and areas (with the theme defaults and the palette's interior character), the routes'
 * endpoints. Writes: the area table (`areaTable`: one AreaInfo per plan area, wall mode and style, floor, room class,
 * rough finish; built once, never changed), the base fill of the cell arrays and each area's cells (state, owner,
 * floor, theme, floorHeight). Returns the routes (`RouteRecord`, the corridors drawn between two areas) to the
 * caller, which hands them to the openings. Also the check, after the openings, that warns about area fields that do
 * nothing for the area's kind.
 */
import type { AreaKind, Level, OpeningKind, ThemeId, Vec2, WallMode } from "../../contracts/plan";
import { CELL } from "../../contracts/resolved";
import { classifyRoom, type RoomKind } from "../../gen/roomPurpose";
import { bandOffsets, routeCenterline } from "../../gen/shapes";
import { NATURAL_WALL_STYLE, THEME_WALL_STYLE, isNaturalWallStyle } from "../../gen/wallStyles";
import type { GeneratorProfile } from "../../plan/generator";
import { materialOrdinal } from "../materials";
import { isRoughDressed } from "../themes";
import type { AreaInfo, LevelContext, ResolveGrid } from "./grid";

const DEFAULT_MODE: Record<AreaKind, WallMode> = {
  room: "auto",
  corridor: "auto",
  cave: "auto",
  building: "auto",
  courtyard: "perimeter",
  zone: "none",
  bridge: "none",
};

/** What a level's grid is built with: one AreaInfo per plan area, each area's index by id, and the theme table. */
export interface AreaTable {
  readonly areas: readonly AreaInfo[];
  /** First area of each id (a plan with a duplicate id is reported by validation; the first one wins here). */
  readonly byId: ReadonlyMap<string, number>;
  /** The level's themes; cells and areas refer to them by index, the level theme is index 0. */
  readonly themes: readonly ThemeId[];
}

/**
 * Describes the level's areas once, before any cell is claimed (ResolveGrid's constructor): wall mode and style, floor,
 * theme, room class and finish. Pure; nothing changes an AreaInfo afterwards.
 */
export function areaTable(
  level: Level,
  ctx: LevelContext,
  profile: GeneratorProfile,
  levelTheme: ThemeId,
  defaultWallHeight: number,
  /** Generator 5 (`buildingRooms`): the synthetic ground-storey rooms and the building each partitions. */
  roomBuilding?: ReadonlyMap<string, string>,
  /** Generator 5 (`sleepingCorners`): the zones a synthetic room holds besides its own kind. */
  roomZones?: ReadonlyMap<string, readonly RoomKind[]>,
): AreaTable {
  const themes: ThemeId[] = [levelTheme];
  const themeIndex = (t: ThemeId): number => {
    const k = themes.indexOf(t);
    return k >= 0 ? k : themes.push(t) - 1;
  };
  const areas: AreaInfo[] = [];
  const byId = new Map<string, number>();
  level.areas.forEach((area, index) => {
    const theme = area.theme ?? levelTheme;
    const td = ctx.themeDefaults(theme);
    const defFloor =
      area.kind === "cave" ? td.caveFloor : area.kind === "courtyard" ? td.courtyardFloor : td.floor;
    const floor = area.floor ?? defFloor;
    // generator 4 reads these (rooms dressed, floored, finished by purpose); they are cheap and pure, so every
    // generator computes them, and only generator 4 writes them on the resolved area; generator 5 also reads the
    // finer kind a room is furnished as (switch roomKinds)
    const room = classifyRoom(area, { kinds: profile.roomKinds });
    const interior = td.interior;
    const building = roomBuilding?.get(area.id);
    const zones = roomZones?.get(area.id);
    areas.push({
      ...(building !== undefined ? { building } : {}),
      ...(zones !== undefined ? { zones } : {}),
      area,
      index,
      kind: area.kind,
      mode: area.walls ?? DEFAULT_MODE[area.kind],
      // generator 2: in a theme whose walls are natural rock (cave), every area defaults to rock walls, so a tunnel
      // into a cave is rock, not a brick box
      wallStyle:
        area.wallStyle ??
        (area.kind === "cave" || (profile.naturalThemeWalls && isNaturalWallStyle(td.wallStyle))
          ? NATURAL_WALL_STYLE
          : THEME_WALL_STYLE),
      wallHeight: area.wallHeight ?? defaultWallHeight,
      themeIdx: themeIndex(theme),
      theme,
      floorMat: floor === "none" ? 0 : materialOrdinal(floor),
      floorNone: floor === "none",
      isZone: area.kind === "zone",
      isRoute: area.shape.type === "route",
      isBridge: area.kind === "bridge",
      room,
      interior,
      rough: isRoughDressed(interior.finish, room.abandoned),
    });
    if (!byId.has(area.id)) byId.set(area.id, index);
  });
  return { areas, byId, themes };
}

export function stepBase(work: ResolveGrid): void {
  const base = work.level.base;
  if (base.type === "solid") work.state.fill(CELL.SOLID);
  else if (base.type === "void") work.state.fill(CELL.VOID);
  else {
    work.state.fill(CELL.OPEN);
    for (let i = 0; i < work.n; i++) work.setMaterial(i, base.material);
  }
  work.theme.fill(0);
}

/** A corridor drawn between two areas (an area of shape "route"): where its openings go (resolve/level/openings.ts). */
export interface RouteRecord {
  ai: number;
  from: number; // area index or -1
  to: number;
  width: number;
  kind: OpeningKind;
  /** The plan named the kind (shape.openings); else `kind` is the default gap and generator 5 may choose (doorsByRole). */
  stated: boolean;
  startSquare: Array<[number, number]>;
  endSquare: Array<[number, number]>;
  /** Edge orientation crossed by the route where it leaves `from` / enters `to` (null = unknown). */
  orientA: "h" | "v" | null;
  orientB: "h" | "v" | null;
}

/** Claims each area's cells (shapes in plan order, then the routes between them); returns the routes drawn. */
export function stepAreas(work: ResolveGrid): RouteRecord[] {
  for (const info of work.areas) {
    if (info.isRoute) continue;
    const cells = work.shapeCells(
      info.area.shape,
      "area",
      `/levels/${work.li}/areas/${info.index}/shape`,
      info.area.id,
    );
    for (const i of cells) work.claim(i, info);
  }
  const routes: RouteRecord[] = [];
  for (const info of work.areas) {
    const r = info.isRoute ? routeArea(work, info) : null;
    if (r) routes.push(r);
  }
  work.recountStruct();
  return routes;
}

function routeArea(work: ResolveGrid, info: AreaInfo): RouteRecord | null {
  const shape = info.area.shape;
  if (shape.type !== "route") return null;
  const path = `/levels/${work.li}/areas/${info.index}/shape`;
  const endpoint = (
    ref: string | Vec2,
    which: "from" | "to",
  ): { cell: [number, number]; ai: number } | null => {
    if (typeof ref !== "string") return { cell: [ref[0], ref[1]], ai: -1 };
    const ai = work.areaIndexById.get(ref);
    if (ai === undefined) {
      work.issue("error", "ref_unknown", `route "${info.area.id}" ${which} unknown area "${ref}"`, {
        path: `${path}/${which}`,
        elementId: info.area.id,
        hint: `areas on ${work.level.id}: ${work.level.areas.map((a) => a.id).join(", ")}`,
      });
      return null;
    }
    const cell = work.anchorOf(work.areaCells(ai));
    if (!cell) return null;
    return { cell, ai };
  };
  const a = endpoint(shape.from, "from");
  const b = endpoint(shape.to, "to");
  if (!a || !b) return null;
  const width = shape.width ?? 1;
  const line = routeCenterline(a.cell, b.cell, shape.bend ?? "hv");
  const inA = (c: readonly [number, number]): boolean => a.ai >= 0 && ownerIs(work, c, a.ai);
  const inB = (c: readonly [number, number]): boolean => b.ai >= 0 && ownerIs(work, c, b.ai);
  let i0 = 0;
  while (i0 < line.length && inA(line[i0] as [number, number])) i0++;
  let j0 = i0;
  while (j0 < line.length && !inB(line[j0] as [number, number])) j0++;
  const [lo, hi] = bandOffsets(width);
  const square = (c: readonly [number, number]): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let y = c[1] + lo; y <= c[1] + hi; y++)
      for (let x = c[0] + lo; x <= c[0] + hi; x++) out.push([x, y]);
    return out;
  };
  for (let k = i0; k < j0; k++) {
    for (const [x, y] of square(line[k] as [number, number])) {
      const i = work.idx(x, y);
      if (i >= 0 && work.struct[i] === 0) work.claim(i, info);
    }
  }
  return {
    ai: info.index,
    from: a.ai,
    to: b.ai,
    width,
    kind: shape.openings ?? "open",
    stated: shape.openings !== undefined,
    startSquare: i0 < j0 ? square(line[i0] as [number, number]) : [],
    endSquare: i0 < j0 ? square(line[j0 - 1] as [number, number]) : [],
    orientA: i0 > 0 && i0 < line.length ? crossOrient(line[i0 - 1] as Vec2, line[i0] as Vec2) : null,
    orientB: j0 > 0 && j0 < line.length ? crossOrient(line[j0 - 1] as Vec2, line[j0] as Vec2) : null,
  };
}

function ownerIs(work: ResolveGrid, c: readonly [number, number], ai: number): boolean {
  const i = work.idx(c[0], c[1]);
  if (i < 0) return false;
  const info = work.areas[ai] as AreaInfo;
  return (info.isZone ? work.disp[i] : work.struct[i]) === ai + 1;
}

/** Fields that do nothing for an area of this kind (zone floor/height/walls, bridge-only fields elsewhere). */
export function checkAreaFields(work: ResolveGrid): void {
  for (const info of work.areas) {
    const a = info.area;
    const path = `/levels/${work.li}/areas/${info.index}`;
    const unused: string[] = [];
    if (info.isZone) {
      for (const f of ["floor", "floorHeight", "walls", "wallStyle", "wallHeight"] as const)
        if (a[f] !== undefined) unused.push(f);
    } else if (info.mode === "none" && !info.isBridge) {
      for (const f of ["wallStyle", "wallHeight"] as const) if (a[f] !== undefined) unused.push(f);
    }
    if (!info.isBridge)
      for (const f of ["railing", "broken", "crumble"] as const) if (a[f] !== undefined) unused.push(f);
    if (unused.length === 0) continue;
    const hint = info.isZone
      ? 'a zone only names cells; for a raised dais or sunken pit use kind "room"/"cave" with floorHeight (later in the list than the area it sits in), or a height terrain op with layer "over"; for a floor use a paint op'
      : info.mode === "none" && !info.isBridge && (a.wallStyle !== undefined || a.wallHeight !== undefined)
        ? 'walls "none" never builds walls: use walls "auto" or "perimeter" to get them'
        : 'railing, broken and crumble only apply to kind "bridge"';
    work.issue(
      "warning",
      "no_effect",
      `area "${a.id}" (${a.kind}) sets ${unused.join(", ")}, which ${unused.length > 1 ? "do" : "does"} nothing for it`,
      { path, elementId: a.id, hint },
    );
  }
}

/** Orientation of the edge crossed when stepping from cell a to the 4-adjacent cell b. */
function crossOrient(a: Vec2, b: Vec2): "h" | "v" {
  return a[1] !== b[1] ? "h" : "v";
}
