/**
 * Objects placed as sites (generator 5; no plan word yet, the owner's call): an internal object spec (kind, position,
 * heading, size, condition, options) turned into what the level stages already understand, so a vessel is a place:
 *   (a) its pieces, built whole by the object recipe (objects/), as arrangement instances on the level its hull stands
 *       on;
 *   (b) an area for every deck at its height on the level whose floor is there (the main deck on the object's own
 *       level, raised decks one storey up), and rooms for the spaces inside: the deck below split by the vessel's
 *       programme (objects/vesselProgramme.ts) with the ground-storey splitter (resolve/building/rooms.ts), a cabin
 *       under each raised deck; with doorways between rooms, doors from the main deck into the cabins, ladders
 *       through hatches between decks, and a gangway from the main deck across the bulwark to the quay beside it.
 * Rooms are ordinary plan areas (kind room, a purpose), so the room furnisher, lighting, review and verify treat them
 * like any room; decks are open courtyards with no walls of their own (the hull is their wall). Every cell comes from
 * the hull's outline at that height (objects/place.ts `wholeCellsInside`), and a room stands half a cell in from the
 * hull's inside so its walls stay within the planking.
 *
 * Steps (`resolveWithObjects`): `expandObjectSites` adds the areas, openings, links and any missing level to a copy of
 * the plan and drops the plan's own features from the footprint; `resolvePlan` resolves it; `placeObjectSites` adds
 * the instances, drops generated features that landed in a footprint, and re-hashes. A future plan field (the proposed
 * word: `Level.objects: [{ id, kind: "vessel", at, heading, size, condition, options }]`) only has to produce the same
 * `ObjectSpec`s. Deterministic: everything follows from the plan, the specs and the palettes.
 */
import type {
  Area,
  AreaId,
  Level,
  LevelId,
  LevelLink,
  MapPlan,
  Opening,
  RoomPurpose,
  Side,
  Vec2,
} from "../contracts/plan";
import { ROOM_PURPOSES } from "../contracts/plan";
import {
  CELL,
  CELL_FLAG,
  type ResolvedArrangement,
  type ResolvedLevel,
  type ResolvedPlan,
} from "../contracts/resolved";
import { planPointOf, type Placed } from "../arrange";
import { SIDE_STEP, SIDES } from "../gen/gridGeometry";
import { forEachMaskCell } from "../gen/mask";
import { rasterizeShape } from "../gen/shapes";
import type { RoomKind } from "../gen/roomPurpose";
import {
  buildObject,
  createKit,
  objectTurn,
  placeObject,
  VESSEL_CABINS,
  VESSEL_HOLDS,
  vessel,
  vesselDesign,
  wholeCellsInside,
  type BuiltObject,
  type Condition,
  type PlacedObject,
  type VesselParams,
} from "../objects";
import { createPlanRoles } from "../palette/planRoles";
import type { ResolvePalettes } from "../palette/resolve";
import { cloneJson } from "../util/canonical";
import { h32Utf16 } from "../util/hash";
import { maxOf, minOf, pushAll } from "../util/lists";
import { rotateXZ } from "../util/turn";
import { splitGroundStorey, type GroundStorey } from "./building/rooms";
import { isWater } from "./materials";
import { resolvePlan, resolvedHash, type ResolveOptions } from "./resolvePlan";

/** What a vessel spec may set beyond its size (the recipe's parameters), and the side it is moored by. */
export type VesselOptions = Partial<Omit<VesselParams, "size" | "seed" | "condition" | "interior">> & {
  /** The side its gangway crosses to (default port). */
  readonly moored?: "port" | "starboard";
};

/** An object placed as a site. */
export interface ObjectSpec {
  readonly id: string;
  readonly kind: "vessel";
  /** The level whose floor the object's main deck stands at (the quay's level for a moored vessel). */
  readonly level: LevelId;
  /** The plan point (whole cells) the object's centre stands on. */
  readonly at: readonly [number, number];
  /** Degrees clockwise from north that the object's front (a vessel's bow) faces; snapped to its turn step. */
  readonly heading: number;
  /** The object's main size: a vessel's length. */
  readonly size: number;
  readonly condition?: Condition;
  readonly seed?: string | number;
  readonly options?: VesselOptions;
}

/** A site as expanded: the built object, where it stands, and the plan elements it added. */
export interface ObjectSite {
  readonly spec: ObjectSpec;
  readonly built: BuiltObject;
  readonly placed: PlacedObject;
  /** Where its frame stands: plan point, absolute height of its datum (a vessel's waterline), turn. */
  readonly anchor: { readonly at: readonly [number, number]; readonly base: number; readonly turn: number };
  /** The elevation of the level its main deck is on. */
  readonly deckElevation: number;
  /** The level its hull stands on. */
  readonly hullLevel: LevelId;
  /** Every level the object has areas on, with the ids of those areas. */
  readonly areas: ReadonlyMap<LevelId, ReadonlySet<AreaId>>;
  /** The rooms aboard: area id, level, name, the room-kind it is furnished as, and where it is (deck name). */
  readonly rooms: ReadonlyArray<{
    readonly id: AreaId;
    readonly level: LevelId;
    readonly name: string;
    readonly kind: RoomKind;
    readonly cells: readonly Vec2[];
  }>;
  /** The decks: area id, level, name, cells. */
  readonly decks: ReadonlyArray<{
    readonly id: AreaId;
    readonly level: LevelId;
    readonly name: string;
    readonly cells: readonly Vec2[];
  }>;
  /** The main deck's area id (the place every room is reached from), when it has one. */
  readonly mainDeck: AreaId | null;
  /** The gangway's cells (deck edge outward, the landing last), empty when none. */
  readonly gangway: readonly Vec2[];
  /** Plan cells the object stands in on every level of it (its footprint and keep-clear ring). */
  readonly blocked: readonly Vec2[];
}

const key = (c: readonly [number, number]): string => `${c[0]},${c[1]}`;

/** A cell list as a plan shape (an explicit mask). */
function maskOf(cells: readonly Vec2[]): Area["shape"] {
  const xs = cells.map((c) => c[0]);
  const ys = cells.map((c) => c[1]);
  const x0 = minOf(xs);
  const y0 = minOf(ys);
  const set = new Set(cells.map(key));
  const rows: string[] = [];
  for (let y = y0; y <= maxOf(ys); y++) {
    let r = "";
    for (let x = x0; x <= maxOf(xs); x++) r += set.has(key([x, y])) ? "#" : ".";
    rows.push(r);
  }
  return { type: "cells", x: x0, y: y0, rows };
}

/** The level at `elevation`: the plan's own, else a new empty one (void base, the deck level's bounds and theme). */
function levelAt(plan: MapPlan, deck: Level, elevation: number, tag: string): Level {
  const found = plan.levels.find((l) => l.elevation === elevation);
  if (found) return found;
  const made: Level = {
    id: `${deck.id}~${tag}`,
    name: `${deck.name} (${tag})`,
    elevation,
    bounds: { ...deck.bounds },
    base: { type: "void" },
    ...(deck.theme !== undefined ? { theme: deck.theme } : {}),
    areas: [],
    openings: [],
    walls: [],
    features: [],
    terrain: [],
    labels: [],
  };
  plan.levels.push(made);
  plan.levels.sort((a, b) => a.elevation - b.elevation);
  return made;
}

/** The purpose a room kind is planned with (its own word when it is one, else none: the name says it). */
const purposeOf = (kind: RoomKind): RoomPurpose | undefined =>
  (ROOM_PURPOSES as readonly string[]).includes(kind) ? (kind as RoomPurpose) : undefined;

/** Where a plan cell's centre lies in the vessel's own frame: station along the length (bow +), side (port +). */
interface Station {
  readonly x: number;
  readonly z: number;
}

/** The ladders, doors and gangway lanes of one vessel, chosen over its cells. */
class VesselLayout {
  constructor(
    readonly at: readonly [number, number],
    readonly turn: number,
  ) {}

  /** A cell's centre in the recipe's frame (bow +x, port +z): the object frame (bow +z) turned back by 90°. */
  station(c: readonly [number, number]): Station {
    const r = rotateXZ(c[0] + 0.5 - this.at[0], -(c[1] + 0.5 - this.at[1]), -this.turn);
    return { x: r.z, z: -r.x };
  }
}

/** Boundary edges from cells of `a` to cells of `b`: the cell in `a` and the side toward `b`, in grid order. */
function sharedEdges(a: readonly Vec2[], b: ReadonlySet<string>): Array<{ at: Vec2; side: Side }> {
  const out: Array<{ at: Vec2; side: Side }> = [];
  for (const c of a)
    for (const s of SIDES) {
      const [dx, dy] = SIDE_STEP[s];
      if (b.has(key([c[0] + dx, c[1] + dy]))) out.push({ at: c, side: s });
    }
  return out;
}

/**
 * The deck below split into the vessel's rooms: the largest rectangle of its cells (the parallel midship body) goes
 * to the splitter, entered on the face toward the stern (the hold, the public room, takes the after part; the rooms
 * behind it lie forward); the cells of the tapering ends join the room they touch.
 */
function holdRooms(
  cells: readonly Vec2[],
  layout: VesselLayout,
  kind: "ship" | "barge",
  seed: number,
): {
  rooms: Array<{ name: string; kind: RoomKind; cells: Vec2[] }>;
  doorways: Array<{ kind: "door" | "open"; at: Vec2; side: Side; width: number }>;
} {
  if (cells.length === 0) return { rooms: [], doorways: [] };
  const set = new Set(cells.map(key));
  // the midship rectangle: the widest rows across the beam, in one run along the length
  const along = cells.map((c) => layout.station(c));
  const byStation = new Map<number, Vec2[]>();
  cells.forEach((c, i) => {
    const s = Math.round((along[i] as Station).x * 2) / 2;
    const l = byStation.get(s);
    if (l) l.push(c);
    else byStation.set(s, [c]);
  });
  const widest = maxOf([...byStation.values()].map((l) => l.length));
  const stations = [...byStation.keys()].sort((p, q) => p - q);
  let best: number[] = [];
  let cur: number[] = [];
  for (const s of stations) {
    if ((byStation.get(s)?.length ?? 0) === widest) cur.push(s);
    else cur = [];
    if (cur.length > best.length) best = [...cur];
  }
  const rect = best.flatMap((s) => byStation.get(s) ?? []);
  const rectSet = new Set(rect.map(key));
  // the virtual street door: the middle cell of the rectangle's face toward the stern
  const sternmost = minOf(rect.map((c) => layout.station(c).x));
  const face = rect.filter((c) => Math.abs(layout.station(c).x - sternmost) < 0.25);
  face.sort((p, q) => layout.station(p).z - layout.station(q).z);
  const door = face[Math.floor(face.length / 2)] as Vec2;
  const out = SIDES.find((s) => {
    const [dx, dy] = SIDE_STEP[s];
    const n: Vec2 = [door[0] + dx, door[1] + dy];
    return !rectSet.has(key(n)) && layout.station(n).x < sternmost;
  }) as Side;
  const g: GroundStorey = {
    id: "hold",
    cells: rect,
    openings: [{ kind: "door", at: door, side: out, width: 1 }],
    hearths: [],
    kind: "barn",
    seed,
  };
  const split = splitGroundStorey(g, VESSEL_HOLDS[kind]);
  const rooms = (
    split?.rooms ?? [
      { name: VESSEL_HOLDS[kind].single.name, kind: VESSEL_HOLDS[kind].single.kind, cells: rect },
    ]
  ).map((r) => ({
    name: r.name,
    kind: r.kind,
    cells: [...r.cells],
  }));
  // the ends: each cell joins the room of the nearest rectangle cell it reaches through the hold's cells (breadth first)
  const owner = new Map<string, number>();
  rooms.forEach((r, i) => {
    for (const c of r.cells) owner.set(key(c), i);
  });
  let frontier = rect.filter((c) => owner.has(key(c)));
  while (frontier.length > 0) {
    const next: Vec2[] = [];
    for (const c of frontier)
      for (const s of SIDES) {
        const [dx, dy] = SIDE_STEP[s];
        const n: Vec2 = [c[0] + dx, c[1] + dy];
        if (!set.has(key(n)) || owner.has(key(n))) continue;
        const i = owner.get(key(c)) as number;
        owner.set(key(n), i);
        rooms[i]?.cells.push(n);
        next.push(n);
      }
    frontier = next.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  }
  for (const r of rooms) r.cells.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  return { rooms, doorways: (split?.doorways ?? []).map((d) => ({ ...d, at: [d.at[0], d.at[1]] as Vec2 })) };
}

/** A seed number from a spec's seed (or the plan's and the spec's id). */
const seedOf = (plan: MapPlan, spec: ObjectSpec): number =>
  h32Utf16(String(spec.seed ?? `${String(plan.seed)}:${spec.id}`));

/** How far (cells) a vessel is moved off the quay at most, before it is left where it was asked. */
const BERTH_SHIFT = 8;

/**
 * Where a moored vessel lies: at its asked point, or moved away from its moored side, a cell at a time, until its hull
 * stands clear of the quay (the landing's cells): a hull never eats the wharf it is moored to. Unmoved when no shift
 * within BERTH_SHIFT clears it.
 */
function offTheQuay(
  built: BuiltObject,
  asked: readonly [number, number],
  turn: number,
  landing: ReadonlySet<string>,
  side: 1 | -1,
): readonly [number, number] {
  const hits = (p: readonly [number, number]): boolean =>
    placeObject(built, { id: "berth", anchor: { at: p, base: 0, turn } }).footprint.some((c) =>
      landing.has(key(c)),
    );
  if (!hits(asked)) return asked;
  // the whole-cell step toward the moored side (the largest port-ward station), taken the other way
  const layout = new VesselLayout(asked, turn);
  const toward = [...SIDES]
    .map((s) => SIDE_STEP[s])
    .sort(
      (p, q) =>
        side *
        (layout.station([asked[0] + q[0], asked[1] + q[1]]).z -
          layout.station([asked[0] + p[0], asked[1] + p[1]]).z),
    )[0];
  if (!toward) return asked;
  for (let k = 1; k <= BERTH_SHIFT; k++) {
    const p: readonly [number, number] = [asked[0] - k * toward[0], asked[1] - k * toward[1]];
    if (!hits(p)) return p;
  }
  return asked;
}

/** How many cells a gangway may cross between the hull and the quay; further, the vessel has none. */
export const GANGWAY_REACH = 3;

/**
 * The cells a gangway may land on, per level: the plan's own dry ground (every area with a floor that is not water),
 * before any object adds its decks.
 */
function landingsOf(plan: MapPlan): Map<LevelId, Set<string>> {
  const out = new Map<LevelId, Set<string>>();
  for (const lv of plan.levels) {
    const s = new Set<string>();
    const clip = {
      x0: lv.bounds.x,
      y0: lv.bounds.y,
      x1: lv.bounds.x + lv.bounds.w - 1,
      y1: lv.bounds.y + lv.bounds.h - 1,
    };
    for (const a of lv.areas) {
      if (a.floor === "none" || (a.floor !== undefined && isWater(a.floor))) continue;
      forEachMaskCell(rasterizeShape(a.shape, { planSeed: plan.seed, clip }), (x, y) => s.add(key([x, y])));
    }
    out.set(lv.id, s);
  }
  return out;
}

/** One vessel expanded into the plan (see the file header). */
function expandVessel(
  plan: MapPlan,
  spec: ObjectSpec,
  palettes: ResolvePalettes,
  landing: ReadonlySet<string>,
): ObjectSite {
  const deckLevel = plan.levels.find((l) => l.id === spec.level);
  if (!deckLevel) throw new Error(`object ${spec.id}: no level ${spec.level}`);
  const theme = deckLevel.theme ?? plan.theme;
  const kit = createKit(createPlanRoles(palettes, plan.generator), theme);
  const { moored = "port", ...options } = spec.options ?? {};
  const params: VesselParams = {
    ...options,
    size: spec.size,
    seed: spec.seed ?? `${String(plan.seed)}:${spec.id}`,
    ...(spec.condition !== undefined ? { condition: spec.condition } : {}),
    interior: true,
  };
  const design = vesselDesign(params);
  if (design.kind === "boat")
    return plainVessel(plan, spec, deckLevel, buildObject(vessel, params, kit), design);
  const kind = design.kind;
  const first = buildObject(vessel, params, kit);
  const turn = objectTurn(first, spec.heading);
  const at = offTheQuay(first, spec.at, turn, landing, moored === "port" ? 1 : -1);
  const layout = new VesselLayout(at, turn);
  const E = deckLevel.elevation;
  // a frame height (relative to the main deck) → the level whose floor is there
  const levelFor = (dy: number): Level =>
    dy === 0 ? deckLevel : levelAt(plan, deckLevel, E + dy, dy < 0 ? "below" : "above");
  const cellsOf = (poly: BuiltObject["surfaces"][number]["polygon"]): Vec2[] =>
    wholeCellsInside(poly, at, turn);
  const areaIds = new Map<LevelId, Set<AreaId>>();
  const addArea = (lv: Level, a: Area): void => {
    lv.areas.push(a);
    const s = areaIds.get(lv.id) ?? new Set<AreaId>();
    s.add(a.id);
    areaIds.set(lv.id, s);
  };
  const rooms: Array<{ id: AreaId; level: LevelId; name: string; kind: RoomKind; cells: Vec2[] }> = [];
  const decks: Array<{ id: AreaId; level: LevelId; name: string; cells: Vec2[] }> = [];
  const room = (lv: Level, id: AreaId, name: string, k: RoomKind, cells: Vec2[]): void => {
    if (cells.length === 0) return;
    const purpose = purposeOf(k);
    addArea(lv, {
      id,
      kind: "room",
      name,
      shape: maskOf(cells),
      floor: "wood_plank",
      walls: "auto",
      wallStyle: "wood",
      ...(purpose !== undefined ? { purpose } : {}),
      tags: ["aboard"],
    });
    rooms.push({ id, level: lv.id, name, kind: k, cells });
  };
  const deckArea = (lv: Level, id: AreaId, name: string, cells: Vec2[]): void => {
    if (cells.length === 0) return;
    addArea(lv, { id, kind: "courtyard", name, shape: maskOf(cells), floor: "wood_plank", walls: "none" });
    decks.push({ id, level: lv.id, name, cells });
  };

  // ── the decks ──
  const surf = new Map(first.surfaces.map((s) => [s.id, s]));
  const space = new Map(first.spaces.map((s) => [s.id, s]));
  const mainName = design.openHold ? "Foredeck" : "Main deck";
  const main = surf.get("deck");
  const mainCells = main ? cellsOf(main.polygon) : [];
  deckArea(deckLevel, `${spec.id}~deck`, mainName, mainCells);
  const raised: Array<{ end: "aft" | "fore"; surface: string; space: string; name: string }> = [
    {
      end: "aft",
      surface: "quarterdeck",
      space: "stern cabin",
      name: kind === "barge" ? "Cabin roof" : "Quarterdeck",
    },
    { end: "fore", surface: "forecastle", space: "forecastle cabin", name: "Forecastle deck" },
  ];
  const cabins: Array<{
    end: "aft" | "fore";
    id: AreaId;
    cells: Vec2[];
    upper: Level;
    deckCells: Set<string>;
  }> = [];
  for (const r of raised) {
    const s = surf.get(r.surface);
    const c = space.get(r.space);
    if (!s || !c) continue;
    const upper = levelFor(s.y - design.deck);
    const deckCells = cellsOf(s.polygon);
    deckArea(upper, `${spec.id}~${r.surface}`, r.name, deckCells);
    const cabin = VESSEL_CABINS[kind][r.end];
    const id = `${spec.id}~cabin-${r.end}`;
    // a cabin is covered by its raised deck: only the cells under it
    const under = new Set(deckCells.map(key));
    const cells = cellsOf(c.polygon).filter((q) => under.has(key(q)));
    room(levelFor(c.floorY - design.deck), id, cabin.name, cabin.kind, cells);
    if (cells.length > 0) cabins.push({ end: r.end, id, cells, upper, deckCells: under });
  }

  // ── the deck below: the vessel's programme ──
  const holdSpace = space.get("hold");
  const holdLevel = holdSpace ? levelFor(holdSpace.floorY - design.deck) : deckLevel;
  const holdCells = holdSpace ? cellsOf(holdSpace.polygon) : [];
  const split = holdRooms(holdCells, layout, kind, seedOf(plan, spec));
  const holdIds: AreaId[] = [];
  split.rooms.forEach((r, i) => {
    const id = `${spec.id}~hold-${i + 1}`;
    room(holdLevel, id, r.name, r.kind, r.cells);
    holdIds.push(id);
  });
  split.doorways.forEach((dw, i) =>
    holdLevel.openings.push({
      id: `${spec.id}~holddoor-${i + 1}`,
      kind: dw.kind,
      at: { x: dw.at[0], y: dw.at[1], side: dw.side },
      width: Math.min(3, Math.max(1, dw.width)) as 1 | 2 | 3,
    }),
  );

  // ── doors from the main deck into the cabins, ladders between decks ──
  const mainSet = new Set(mainCells.map(key));
  const links: LevelLink[] = [];
  const clear: number[] = [];
  const mastNear = (c: Vec2): boolean => design.masts.some((m) => Math.abs(m.x - layout.station(c).x) < 1.6);
  const doorCells = new Set<string>();
  const joined = new Set<AreaId>();
  for (const cab of cabins) {
    const edges = sharedEdges(cab.cells, mainSet);
    if (edges.length === 0) continue;
    edges.sort((p, q) => layout.station(p.at).z - layout.station(q.at).z);
    const mid = edges[Math.floor(edges.length / 2)] as { at: Vec2; side: Side };
    const op: Opening = {
      id: `${cab.id}~door`,
      kind: "door",
      at: { x: mid.at[0], y: mid.at[1], side: mid.side },
    };
    deckLevel.openings.push(op);
    doorCells.add(key(mid.at));
    const [dx, dy] = SIDE_STEP[mid.side];
    doorCells.add(key([mid.at[0] + dx, mid.at[1] + dy]));
    joined.add(cab.id);
  }
  // a ladder from a cell of `from` (best first) up to `to` (cells above, on the next level up)
  const ladder = (
    id: string,
    lower: Level,
    from: readonly Vec2[],
    upper: Level,
    above: ReadonlySet<string>,
    avoid: (c: Vec2) => boolean,
  ): Vec2 | null => {
    const c = from.find((q) => above.has(key(q)) && !avoid(q)) ?? from.find((q) => above.has(key(q)));
    if (!c) return null;
    links.push({ id, kind: "ladder", from: { level: lower.id, at: [c[0], c[1]] }, to: { level: upper.id } });
    return c;
  };
  // the main hatch: from the hold (its public room first, nearest its middle, clear of the masts and the doorways)
  const doorwayCells = new Set(
    split.doorways.flatMap((dw) => {
      const [dx, dy] = SIDE_STEP[dw.side];
      return [key(dw.at), key([dw.at[0] + dx, dw.at[1] + dy])];
    }),
  );
  const byMiddle = (cells: readonly Vec2[]): Vec2[] => {
    const mx = cells.reduce((s, c) => s + c[0], 0) / Math.max(1, cells.length);
    const my = cells.reduce((s, c) => s + c[1], 0) / Math.max(1, cells.length);
    return [...cells].sort(
      (p, q) =>
        Math.hypot(p[0] - mx, p[1] - my) - Math.hypot(q[0] - mx, q[1] - my) || p[1] - q[1] || p[0] - q[0],
    );
  };
  const pub = split.rooms[0];
  const holdAll = split.rooms.flatMap((r) => r.cells);
  if (holdSpace && pub && mainCells.length > 0) {
    const order = [...byMiddle(pub.cells), ...byMiddle(holdAll)];
    const c = ladder(
      `${spec.id}~hatch`,
      holdLevel,
      order,
      deckLevel,
      mainSet,
      (q) => mastNear(q) || doorwayCells.has(key(q)),
    );
    if (c) clear.push(layout.station(c).x);
  }
  // a cabin no door joins to the main deck is reached from the hold below it
  for (const cab of cabins) {
    if (joined.has(cab.id) || !holdSpace) continue;
    const under = new Set(cab.cells.map(key));
    ladder(`${cab.id}~hatch`, holdLevel, byMiddle(holdAll), deckLevel, under, (q) =>
      doorwayCells.has(key(q)),
    );
  }
  // each cabin: a ladder up through its raised deck, beside its after or forward wall, off the door's line
  for (const cab of cabins) {
    const far = cab.end === "aft" ? (c: Vec2) => layout.station(c).x : (c: Vec2) => -layout.station(c).x;
    const order = [...cab.cells].sort(
      (p, q) =>
        Math.abs(layout.station(q).z) - Math.abs(layout.station(p).z) ||
        far(q) - far(p) ||
        p[1] - q[1] ||
        p[0] - q[0],
    );
    const usedBelow = new Set(links.filter((l) => l.to.level === deckLevel.id).map((l) => key(l.from.at)));
    ladder(
      `${cab.id}~ladder`,
      deckLevel,
      order,
      cab.upper,
      cab.deckCells,
      (q) => doorCells.has(key(q)) || usedBelow.has(key(q)),
    );
  }

  // ── the gangway: from the main deck's edge on the moored side, square across, to the quay it is moored to ──
  const side = moored === "port" ? 1 : -1;
  const gangway: Vec2[] = [];
  let gangwayAt: number | null = null;
  if (mainCells.length > 0) {
    const used = new Set(links.map((l) => key(l.from.at)));
    const candidates = byMiddle(mainCells).filter(
      (c) => !mastNear(c) && !clear.some((x) => Math.abs(x - layout.station(c).x) < 1.2),
    );
    // the row across the deck at a candidate's station, its outermost cell on the moored side
    const outermost = (c: Vec2): Vec2 | null => {
      const sx = layout.station(c).x;
      const row = mainCells.filter((q) => Math.abs(layout.station(q).x - sx) < 0.25);
      const best = row.sort((p, q) => side * (layout.station(q).z - layout.station(p).z))[0];
      return best ?? null;
    };
    // the shortest crossing to the landing (the level's own dry ground at deck height), nearest midships first; the
    // landing's cell stays the quay's (the gangway is only the cells between)
    let best: { cells: Vec2[]; at: number } | null = null;
    for (const c of candidates) {
      const edge = outermost(c);
      if (!edge || used.has(key(edge))) continue;
      const step = SIDES.map((s) => SIDE_STEP[s]).find(([dx, dy]) => {
        const n: Vec2 = [edge[0] + dx, edge[1] + dy];
        return side * (layout.station(n).z - layout.station(edge).z) > 0.5;
      });
      if (!step) continue;
      const cells: Vec2[] = [];
      let cur: Vec2 = [edge[0] + step[0], edge[1] + step[1]];
      while (!landing.has(key(cur)) && cells.length < GANGWAY_REACH) {
        cells.push(cur);
        cur = [cur[0] + step[0], cur[1] + step[1]];
      }
      if (!landing.has(key(cur))) continue;
      if (!best || cells.length < best.cells.length) best = { cells, at: layout.station(edge).x };
      if (best.cells.length <= 1) break;
    }
    if (best) {
      pushAll(gangway, best.cells);
      gangwayAt = best.at;
    }
    if (gangway.length > 0)
      addArea(deckLevel, {
        id: `${spec.id}~gangway`,
        kind: "courtyard",
        name: "Gangway",
        shape: maskOf(gangway),
        floor: "wood_plank",
        walls: "none",
      });
    if (gangwayAt !== null) clear.push(gangwayAt);
  }
  pushAll(plan.links, links);

  // ── the object, built again with its lanes and its gangway port ──
  const built = buildObject(
    vessel,
    { ...params, clear, ...(gangwayAt !== null ? { gangway: { x: gangwayAt, side } } : {}) },
    kit,
  );
  const base = E + 0.5 - design.deck;
  const placed = placeObject(built, { id: spec.id, anchor: { at, base, turn } });
  const gangSet = new Set(gangway.map(key));
  const blocked = [...placed.footprint, ...placed.keepClear].filter((c) => !gangSet.has(key(c)));
  // the plan's own features never stand in the object (on any of its levels)
  const blockSet = new Set(blocked.map(key));
  const hullLevel = holdLevel;
  for (const lv of plan.levels)
    if (areaIds.has(lv.id) || lv.id === holdLevel.id)
      lv.features = lv.features.filter((f) => !blockSet.has(key([Math.floor(f.at[0]), Math.floor(f.at[1])])));
  return {
    spec,
    built,
    placed,
    anchor: { at, base, turn },
    deckElevation: E,
    hullLevel: hullLevel.id,
    areas: areaIds,
    rooms,
    decks,
    mainDeck: mainCells.length > 0 ? `${spec.id}~deck` : null,
    gangway,
    blocked,
  };
}

/**
 * A vessel with no rooms (a rowing boat: no deck to walk, no hold): placed as a plain object, its deck height at the
 * level's floor like a decked vessel's, the level's own features cleared from its footprint; no areas, rooms or decks.
 */
function plainVessel(
  plan: MapPlan,
  spec: ObjectSpec,
  level: Level,
  built: BuiltObject,
  design: { readonly deck: number },
): ObjectSite {
  const turn = objectTurn(built, spec.heading);
  const at = spec.at;
  const base = level.elevation + 0.5 - design.deck;
  const placed = placeObject(built, { id: spec.id, anchor: { at, base, turn } });
  const blocked = [...placed.footprint, ...placed.keepClear];
  const blockSet = new Set(blocked.map(key));
  level.features = level.features.filter(
    (f) => !blockSet.has(key([Math.floor(f.at[0]), Math.floor(f.at[1])])),
  );
  return {
    spec,
    built,
    placed,
    anchor: { at, base, turn },
    deckElevation: level.elevation,
    hullLevel: level.id,
    areas: new Map(),
    rooms: [],
    decks: [],
    mainDeck: null,
    gangway: [],
    blocked,
  };
}

/**
 * The plan with every object's areas, openings, links and levels added, and its own features cleared from the
 * objects' footprints (a copy; the plan passed in is not changed).
 */
export function expandObjectSites(
  plan: MapPlan,
  specs: readonly ObjectSpec[],
  palettes: ResolvePalettes,
): { plan: MapPlan; sites: ObjectSite[] } {
  const out = cloneJson(plan);
  const landings = landingsOf(plan);
  const sites = specs.map((s) => expandVessel(out, s, palettes, landings.get(s.level) ?? new Set()));
  return { plan: out, sites };
}

/** Whether a resolved level has a floor at plan cell `c` (open, not cut by a link or a hole). */
function floorAt(lv: ResolvedLevel, c: readonly [number, number]): boolean {
  const lx = c[0] - lv.bounds.x;
  const ly = c[1] - lv.bounds.y;
  if (lx < 0 || ly < 0 || lx >= lv.bounds.w || ly >= lv.bounds.h) return false;
  const i = ly * lv.bounds.w + lx;
  return lv.cells.state[i] === CELL.OPEN && ((lv.cells.flags[i] as number) & CELL_FLAG.NO_FLOOR) === 0;
}

/**
 * A site's instances by level: a piece standing over a floor of a level above the hull's, at or above that level,
 * belongs to it (its floor carries it, and a level's pieces never rise through the floor of the level above); a piece
 * under such a floor that would rise through it (a deck margin tile centred over another floor's cell) is left out,
 * the floor covers it; every other piece stands with the hull.
 */
function instancesByLevel(
  site: ObjectSite,
  levels: readonly ResolvedLevel[],
): Map<LevelId, ResolvedArrangement[]> {
  const { at, base, turn } = site.anchor;
  const hull = levels.find((l) => l.id === site.hullLevel);
  const above = levels
    .filter((l) => hull !== undefined && l.elevation > hull.elevation)
    .sort((a, b) => b.elevation - a.elevation);
  const levelOf = (q: Placed): LevelId | null => {
    const p = planPointOf(at, turn, q.x, q.z);
    const c: Vec2 = [Math.floor(p[0]), Math.floor(p[1])];
    const bottom = base + q.y;
    const lv = above.find((l) => bottom >= l.elevation - 0.05 && floorAt(l, c));
    if (lv) return lv.id;
    const top = bottom + q.piece.variant.geom.size.y;
    const through = above.some((l) => top > l.elevation + 0.01 && bottom < l.elevation && floorAt(l, c));
    return through ? null : site.hullLevel;
  };
  const out = new Map<LevelId, ResolvedArrangement[]>();
  for (const lv of [...(hull ? [hull] : []), ...above]) {
    const parts = site.built.parts
      .map((p) => ({ ...p, pieces: p.pieces.filter((q) => levelOf(q) === lv.id) }))
      .filter((p) => p.pieces.length > 0);
    if (parts.length === 0) continue;
    const id = lv.id === site.hullLevel ? site.spec.id : `${site.spec.id}@${lv.id}`;
    out.set(lv.id, placeObject({ ...site.built, parts }, { id, anchor: { at, base, turn } }).instances);
  }
  return out;
}

/**
 * The resolved plan with every site's instances on their levels and the generated features that landed in a site
 * (outside its own areas) removed; re-hashed.
 */
export function placeObjectSites(resolved: ResolvedPlan, sites: readonly ObjectSite[]): ResolvedPlan {
  const byLevel = sites.map((s) => instancesByLevel(s, resolved.levels));
  const levels = resolved.levels.map((lv) => {
    const instances = byLevel.flatMap((m) => m.get(lv.id) ?? []);
    const mine = sites.filter((s) => s.areas.has(lv.id) || s.hullLevel === lv.id);
    if (mine.length === 0 && instances.length === 0) return lv;
    const own = new Set(mine.flatMap((s) => [...(s.areas.get(lv.id) ?? [])]));
    const blocked = new Set(mine.flatMap((s) => s.blocked.map(key)));
    const covers = (f: (typeof lv.features)[number]): Vec2[] => {
      const out: Vec2[] = [];
      for (let y = 0; y < f.size[1]; y++)
        for (let x = 0; x < f.size[0]; x++) out.push([f.at[0] + x, f.at[1] + y]);
      return out;
    };
    const dropped = lv.features.filter(
      (f) => !(f.area !== undefined && own.has(f.area)) && covers(f).some((c) => blocked.has(key(c))),
    );
    const features = lv.features.filter((f) => !dropped.includes(f));
    const flags = [...lv.cells.flags];
    const still = new Set(features.flatMap((f) => covers(f).map(key)));
    for (const f of dropped)
      for (const c of covers(f)) {
        if (still.has(key(c))) continue;
        const lx = c[0] - lv.bounds.x;
        const ly = c[1] - lv.bounds.y;
        if (lx < 0 || ly < 0 || lx >= lv.bounds.w || ly >= lv.bounds.h) continue;
        const i = ly * lv.bounds.w + lx;
        flags[i] = (flags[i] as number) & ~CELL_FLAG.FEATURE;
      }
    return {
      ...lv,
      cells: { ...lv.cells, flags },
      features,
      ...(instances.length > 0 ? { arrangements: [...(lv.arrangements ?? []), ...instances] } : {}),
    };
  });
  const out: ResolvedPlan = { ...resolved, levels, hash: "" };
  out.hash = resolvedHash(out);
  return out;
}

/** The plan resolved with its objects placed as sites (see the file header). */
export function resolveWithObjects(
  plan: MapPlan,
  specs: readonly ObjectSpec[],
  palettes: ResolvePalettes,
  opts: ResolveOptions = {},
): { resolved: ResolvedPlan; plan: MapPlan; sites: ObjectSite[] } {
  const ex = expandObjectSites(plan, specs, palettes);
  // afloat: the board's one water plane at the lowest waterline (none sits above the water), unless the caller says
  const lines = ex.sites.map((s) => s.anchor.base);
  const plane = opts.waterPlane ?? (lines.length > 0 ? minOf(lines) : undefined);
  const resolved = placeObjectSites(
    resolvePlan(ex.plan, palettes, { ...opts, ...(plane !== undefined ? { waterPlane: plane } : {}) }),
    ex.sites,
  );
  return { resolved, plan: ex.plan, sites: ex.sites };
}

/** Exported for tests. */
export const _internal = { holdRooms, VesselLayout };
