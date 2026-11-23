/**
 * Interior notes (generator 4 work, any generator's plan). The owner admired a community interior and called our dungeon
 * "a plain hall and identical cells". Measured like for like: 1.3 props per 10 floor tiles against 21, 40% of the
 * furniture within a tile of a wall against 92%, six of thirteen rooms with no light, four identical cells. Rooms are
 * judged one by one (areas of kind room with 8 or more floor tiles); abandoned places (a crypt, cells, a ruin) are meant
 * to be sparse and dark and are not judged bare or unlit; passages (a landing, an antechamber) are not judged bare.
 *
 *   room_bare         rooms with under 3 props per 10 floor tiles in a map where another room is dressed
 *   rooms_alike       3 or more rooms of one size class with the same floor and the same furniture
 *   room_unlit        rooms with no light inside or on their walls
 *   furniture_adrift  rooms with under 60% of their furniture within a tile of a wall
 *   anchor_missing    (generator 5) rooms of a furnished kind with none of the pieces their kind is known by
 *
 * Generator 5 (switch `reviewByKind`) judges a room by its kind's row of the room-kind table (gen/roomTraits.ts
 * roomTargets): bare below half its kind's props per 10 tiles (never stricter than 3), adrift below its kind's near-wall
 * share (never stricter than 60%; kinds that lay out floor groups or station rows are not judged), and a hall carried by
 * columns, three floor heights or water is not called bare.
 *
 * What a room is for and whether it is abandoned is the resolver's one classification (ResolvedArea.purpose /
 * .abandoned, generator 4). A plan of an older generator has none on its resolved areas, so its rooms are classified
 * here from the plan's own area with the same classifier (gen/roomPurpose.ts), never by other words.
 *
 * The notes run for every generator (plan/generator.ts, review policy), but only generator 4 dresses and lights a room
 * from its name, so the action of room_bare and room_unlit says that only to a generator-4 plan.
 */
import type { Area, MapPlan } from "../contracts/plan";
import type { ResolvedArea, ResolvedFeature, ResolvedLevel, ResolvedPlan } from "../contracts/resolved";
import { CELL, CELL_FLAG } from "../contracts/resolved";
import { LIGHT_FEATURES, featureInfo } from "../gen/catalog";
import { SIDES, SIDE_STEP } from "../gen/gridGeometry";
import { LevelGrid } from "../resolve/levelGrid";
import { type RoomClass, type RoomKind, classifyRoom, furnishedPurpose } from "../gen/roomPurpose";
import { roomTargets } from "../gen/roomTraits";
import { generatorProfile } from "../plan/generator";
import { roomMeantDim } from "./lights";
import type { DesignNote } from "./review";
import { REVIEW, capped } from "./thresholds";

export interface RoomStat {
  levelId: string;
  id: string;
  name: string;
  floor: number;
  props: number;
  lights: number;
  blockers: number;
  nearWall: number;
  abandoned: boolean;
  /** A long thin room (4 or fewer wide, 2.5 times as long): circulation, judged neither bare nor unlit alone. */
  passage: boolean;
  /** Size class: index into REVIEW.interiors.sizeClasses (the last is open). */
  sizeClass: number;
  /** Floor material and the multiset of feature types, as one string: rooms with the same one are copies. */
  signature: string;
  cell: [number, number];
  /** Generator 5: what the room is furnished as (its row of the room-kind table); absent when it names none. */
  kind?: RoomKind;
  /** Carried by structure: as many floor heights as REVIEW.interiors.byKind.carriedHeights, a column, or water. */
  carried: boolean;
  /** Share of the floor not under a blocking piece. */
  clear: number;
  /** One of its kind's anchors stands in it (true when it has no kind). */
  anchor: boolean;
  /** Generator 5: its lights were drawn dim or dark (ResolvedArea.lightLevel): few or no lights are meant. */
  dim: boolean;
}

/** What a room is furnished as: the kind its words name, else its purpose when that is furnished. */
export const kindOf = (c: RoomClass): RoomKind | undefined =>
  c.kind ?? (furnishedPurpose(c.purpose) ? c.purpose : undefined);

/** A resolved area's classification as the resolver wrote it (generator 4). */
export const resolvedRoomClass = (a: ResolvedArea): RoomClass =>
  a.purpose === undefined
    ? { abandoned: a.abandoned === true }
    : { purpose: a.purpose, abandoned: a.abandoned === true };

/** Per-room measures of one level (areas of kind room with floor). */
export function roomStats(
  L: ResolvedLevel,
  classOf: (a: ResolvedArea) => RoomClass = resolvedRoomClass,
  /** Does a feature give light (review/lights.ts lightGiver)? Default: every light feature. */
  gives: (f: ResolvedFeature) => boolean = (f) => LIGHT_FEATURES.has(f.type),
): RoomStat[] {
  const T = REVIEW.interiors;
  const W = L.bounds.w;
  const grid = new LevelGrid(L);
  const out: RoomStat[] = [];
  L.areas.forEach((a, ai) => {
    if (a.kind !== "room") return;
    const cells: Array<[number, number]> = [];
    const heights = new Set<number>();
    let water = false;
    for (let i = 0; i < L.cells.area.length; i++) {
      if (L.cells.area[i] !== ai + 1 || L.cells.state[i] !== CELL.OPEN) continue;
      if (((L.cells.flags[i] as number) & CELL_FLAG.WATER) !== 0) water = true;
      if (((L.cells.flags[i] as number) & (CELL_FLAG.NO_FLOOR | CELL_FLAG.WATER)) !== 0) continue;
      heights.add(L.cells.height[i] as number);
      cells.push([L.bounds.x + (i % W), L.bounds.y + Math.floor(i / W)]);
    }
    if (cells.length < T.minFloor) return;
    // loose litter (wall-foot rubble, bones, webs: `strewn`) is neither furniture nor a thing on it, so it does not make
    // a room dressed, and two rooms differing only in their litter are still copies
    const mine = L.features.filter(
      (f) => f.area === a.id && f.gmOnly !== true && featureInfo(f.type).strewn !== true,
    );
    const own = new Set(cells.map(([x, y]) => `${x},${y}`));
    // furniture: blocking pieces that are not mounted on a wall; "near a wall" = a wall within one cell of any of its cells
    const near = (x: number, y: number): boolean => {
      for (const s of SIDES) {
        const [dx, dy] = SIDE_STEP[s];
        for (let k = 0; k < 2; k++) {
          const cx = x + dx * k;
          const cy = y + dy * k;
          if (!own.has(`${cx},${cy}`)) break;
          if (grid.wallOn(cx, cy, s)) return true;
        }
      }
      return false;
    };
    const blockers = mine.filter((f) => f.blocking && !featureInfo(f.type).wallMounted);
    let nearWall = 0;
    for (const f of blockers) {
      let hit = false;
      for (let y = f.at[1]; y < f.at[1] + f.size[1] && !hit; y++)
        for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++)
          if (near(x, y)) {
            hit = true;
            break;
          }
      if (hit) nearWall++;
    }
    const counts = new Map<string, number>();
    for (const f of mine) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
    const first = cells[0] as [number, number];
    const mat = L.materials[(L.cells.material[grid.index(first[0], first[1])] as number) - 1] ?? "";
    const sizeClass = T.sizeClasses.findIndex((m) => cells.length <= m);
    const cls = classOf(a);
    const kind = kindOf(cls);
    const under = new Set<string>();
    for (const f of blockers)
      for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
        for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) if (own.has(`${x},${y}`)) under.add(`${x},${y}`);
    const anchors = kind !== undefined ? roomTargets(kind).anchors : [];
    out.push({
      ...(kind !== undefined ? { kind } : {}),
      carried:
        heights.size >= T.byKind.carriedHeights ||
        water ||
        mine.some((f) => featureInfo(f.type).carriesHall === true),
      clear: 1 - under.size / cells.length,
      anchor: anchors.length === 0 || mine.some((f) => anchors.includes(f.type)),
      levelId: L.id,
      id: a.id,
      name: a.name ?? a.id,
      floor: cells.length,
      props: mine.length,
      lights: mine.filter(gives).length,
      dim: roomMeantDim(a),
      blockers: blockers.length,
      nearWall,
      abandoned: cls.abandoned,
      // named as a passage, or long and thin (a landing, a gallery): circulation, not a room to furnish
      passage:
        cls.purpose === "passage" ||
        (Math.min(a.bbox.w, a.bbox.h) <= 4 &&
          Math.max(a.bbox.w, a.bbox.h) >= 2.5 * Math.min(a.bbox.w, a.bbox.h)),
      sizeClass: sizeClass < 0 ? T.sizeClasses.length : sizeClass,
      signature: `${mat}|${[...counts.entries()]
        .sort((p, q) => (p[0] < q[0] ? -1 : 1))
        .map(([k, v]) => `${k}${v}`)
        .join(",")}`,
      cell: first,
    });
  });
  return out;
}

const names = (rooms: readonly RoomStat[]): string =>
  rooms
    .slice(0, 6)
    .map((r) => `${r.name} (${r.id})`)
    .join(", ") + (rooms.length > 6 ? ` and ${rooms.length - 6} more` : "");

const rank = (weight: number, n: number): number => weight * capped(0.8 + n / 3);

/** The interior notes of a map: bare, alike, unlit and adrift rooms. */
export function interiorNotes(
  plan: MapPlan,
  resolved: ResolvedPlan,
  gives?: (f: ResolvedFeature) => boolean,
): DesignNote[] {
  const T = REVIEW.interiors;
  const gen = generatorProfile(plan);
  // a generator that resolves no classification: read the plan's area with the same classifier the resolver uses
  const planClass = (levelId: string) => {
    const byId = new Map<string, Area>(
      (plan.levels.find((l) => l.id === levelId)?.areas ?? []).map((a) => [a.id, a]),
    );
    return (a: ResolvedArea): RoomClass => classifyRoom(byId.get(a.id) ?? a);
  };
  // generator 5 (`reviewByKind`): the kind its words name, read with the classifier the resolver used
  const kindClass = (levelId: string) => {
    const byId = new Map<string, Area>(
      (plan.levels.find((l) => l.id === levelId)?.areas ?? []).map((a) => [a.id, a]),
    );
    return (a: ResolvedArea): RoomClass => {
      const kind = classifyRoom(byId.get(a.id) ?? a, { kinds: gen.roomKinds }).kind;
      return { ...resolvedRoomClass(a), ...(kind !== undefined ? { kind } : {}) };
    };
  };
  const rooms = resolved.levels.flatMap((L) =>
    roomStats(
      L,
      gen.reviewByKind ? kindClass(L.id) : gen.roomClassification ? resolvedRoomClass : planClass(L.id),
      gives,
    ),
  );
  if (rooms.length === 0) return [];
  const out: DesignNote[] = [];
  const density = (r: RoomStat): number => (r.props * 10) / r.floor;
  const byKind = (r: RoomStat): RoomKind | undefined => (gen.reviewByKind ? r.kind : undefined);
  const K = T.byKind;
  /** Props per 10 tiles under which a room reads bare: half its kind's least, within [bareFloor, bareDensity]. */
  const bareBelow = (r: RoomStat): number => {
    const k = byKind(r);
    if (k === undefined) return T.bareDensity;
    return Math.min(T.bareDensity, Math.max(K.bareFloor, K.bareShare * roomTargets(k).props10[0]));
  };

  // bare: only judged where the map shows the author can dress a room; abandoned rooms are sparse on purpose, and (by
  // kind) a hall carried by columns, level changes or water reads full with few props
  const dressed = rooms.some((r) => density(r) >= T.dressedDensity);
  const bare = rooms.filter(
    (r) => !r.abandoned && !r.passage && !(gen.reviewByKind && r.carried) && density(r) < bareBelow(r),
  );
  if (dressed && bare.length > 0)
    out.push({
      code: "room_bare",
      levelId: (bare[0] as RoomStat).levelId,
      score: rank(T.weights.bare, bare.length),
      cell: (bare[0] as RoomStat).cell,
      elementIds: bare.slice(0, 6).map((r) => r.id),
      message: `${bare.length} of ${rooms.length} rooms read bare (${gen.reviewByKind ? `under half the props per 10 floor tiles their kind holds, at most ${T.bareDensity}` : `under ${T.bareDensity} props per 10 floor tiles`}) while other rooms are dressed: ${names(bare)}`,
      action: gen.roomRecipes
        ? "name each room for what it is (Kitchen, Guard room, Library, Store room, Bedroom, Armoury, Shrine, Washroom) so the generator dresses it, or give it a dress op with the matching preset; keep a crypt or cells sparse on purpose"
        : "give each bare room a dress op with the preset of its purpose, or furnish it with features along its walls; keep a crypt or cells sparse on purpose",
    });

  // alike: copies of one room (same size class, floor and furniture)
  const groups = new Map<string, RoomStat[]>();
  for (const r of rooms)
    groups.set(`${r.sizeClass}|${r.signature}`, [...(groups.get(`${r.sizeClass}|${r.signature}`) ?? []), r]);
  const alike = [...groups.values()]
    .filter((g) => g.length >= T.alike)
    .sort((p, q) => q.length - p.length)[0];
  if (alike)
    out.push({
      code: "rooms_alike",
      levelId: (alike[0] as RoomStat).levelId,
      score: rank(T.weights.alike, alike.length),
      cell: (alike[0] as RoomStat).cell,
      elementIds: alike.slice(0, 6).map((r) => r.id),
      message: `${alike.length} rooms of one size have the same floor and the same furniture: ${names(alike)}`,
      action:
        "give them different purposes (a cell, a store, a bedroom), different floors, or their own dress ops; rooms of one purpose still differ in their layout and what stands on the furniture",
    });

  // unlit: every room people use has a light; only abandoned places keep dark rooms
  // (the kinds whose lights per 10 tiles start at 0, cells and crypts, are read abandoned already)
  // (generator 5: a room drawn dim or dark is meant to be)
  const unlit = rooms.filter((r) => !r.abandoned && r.lights === 0 && !r.dim);
  if (unlit.length > 0)
    out.push({
      code: "room_unlit",
      levelId: (unlit[0] as RoomStat).levelId,
      score: rank(T.weights.unlit, unlit.length),
      cell: (unlit[0] as RoomStat).cell,
      elementIds: unlit.slice(0, 6).map((r) => r.id),
      message: `${unlit.length} of ${rooms.length} rooms have no light inside or on their walls: ${names(unlit)}`,
      action: gen.roomRecipes
        ? "light every room that is lived in: candles on its table, a lantern on a chest, wall torches, a brazier in a big room (naming a room for its purpose lights it by itself); leave only crypts, cells and ruins dark"
        : "light every room that is lived in: candles on its table, a lantern on a chest, wall torches, a brazier in a big room; leave only crypts, cells and ruins dark",
    });

  // adrift: furniture belongs along the walls, with the middle clear
  // (by kind: the kind's least near-wall share, never stricter than adriftShare; a kind that lays out floor groups or
  // station rows stands its furniture free on purpose)
  const adriftBelow = (r: RoomStat): number | null => {
    const k = byKind(r);
    if (k === undefined) return T.adriftShare;
    const t = roomTargets(k);
    return t.floorGroups || t.stationRows ? null : Math.min(T.adriftShare, t.nearWall[0]);
  };
  const adrift = rooms.filter((r) => {
    const below = adriftBelow(r);
    return below !== null && r.blockers >= T.adriftMin && r.nearWall < below * r.blockers;
  });
  if (adrift.length > 0)
    out.push({
      code: "furniture_adrift",
      levelId: (adrift[0] as RoomStat).levelId,
      score: rank(T.weights.adrift, adrift.length),
      cell: (adrift[0] as RoomStat).cell,
      elementIds: adrift.slice(0, 6).map((r) => r.id),
      message: `the furniture of ${adrift.length} rooms stands in the middle (under ${Math.round(T.adriftShare * 100)}% within a tile of a wall): ${names(adrift)}`,
      action:
        "put the furniture against the walls (a bed in a corner, shelves and chests along a wall, a table with its chairs against one) and keep the middle and the way between doors free",
    });

  // anchor missing (by kind): a furnished room of a kind with none of the pieces that make it read as that kind
  const unanchored = gen.reviewByKind
    ? rooms.filter((r) => r.kind !== undefined && !r.abandoned && !r.passage && !r.anchor && r.props > 0)
    : [];
  const ua = unanchored[0];
  if (ua)
    out.push({
      code: "anchor_missing",
      levelId: ua.levelId,
      score: rank(T.anchorWeight, unanchored.length),
      cell: ua.cell,
      elementIds: unanchored.slice(0, 6).map((r) => r.id),
      message: `${unanchored.length} rooms hold none of the pieces their kind is known by: ${unanchored
        .slice(0, 6)
        .map(
          (r) =>
            `${r.name} (${r.id}: a ${String(r.kind)} wants ${roomTargets(r.kind as RoomKind)
              .anchors.map((t) => featureInfo(t).label.toLowerCase())
              .join(" or ")})`,
        )
        .join(", ")}`,
      action: "add the anchor piece (the bed, the counter, the desk), or rename the room for what it holds",
    });
  return out;
}
