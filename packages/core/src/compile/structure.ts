/**
 * Builds buildings and enclosures (ResolvedLevel.structures) — called once per level by realize. Everything comes
 * from palette roles with fallback chains, so a cottage, a keep and a ruin differ only by style profile and roles:
 *
 *   walls      facade.<style> → wall.<style> → wall.wall           (length-2 pieces along straight runs)
 *   footing    footing.<style> → facade.<style> → wall.<style>     (ground storey lower course)
 *   posts      facade_post.<style> → wall_post.<style> → wall_post.wall
 *   doors      opening.<kind>.<style> → opening.<kind>;  over the leaf over_door.<style> → footing.<footing style> → facade
 *   windows    window.<style> → opening.window.<style> → opening.window
 *   floors     floor.<material> (upper storeys);  attic deck roof.<kit>.deck → roof.default.deck → floor.<material>
 *   roof       roof.<kit>.slope / slope2 / slope2x2 / cap / flat  (facing.front = the eave side at rot 0)
 *   gable fill gable.<style> → facade.<style> → wall.<style>
 *   chimney    chimney.<style> → chimney.default;  chimney_top.<style> → chimney_top.default
 *   porch      porch_post.<style> → porch_post.default → feature.pillar;  roof roof.<kit>.flat → floor.<porch floor>
 *   door light wall_light.<style> → wall_light.default → feature.torch_wall
 *   gates      gate.<fence style> → opening.door.<fence style>
 *
 * Geometry (verified in game, forest shack test 2026-11-20): walls in the outer half of the ring cells; storey =
 * footing course + wall course; attic deck on the wall top, the 45° roof on the deck; courses one cell in and one tile
 * up; gable ends filled up to the underside of each course; chimney breast in the wall line rising past the ridge.
 *
 * Placements carry a paste layer: "storey:<n>" for storey n, "roof" for the deck, roof, gable fill and attachment
 * roofs (absent = site).
 */
import type { PaletteFacing, Placement, PlacementRole } from "../contracts/compiler";
import type { OpeningKind, Side, WallStyle } from "../contracts/plan";
import type { ResolvedLevel, ResolvedStructure, ResolvedVolume } from "../contracts/resolved";
import type { ResolvedVariant, RoleResolution, VariantFilter } from "../palette/resolve";
import type { GeneratorProfile } from "../plan/generator";
import {
  gableRoof,
  hipRoof,
  mergeRoofs,
  type Rect,
  ringLayer,
  roofOwners,
  type RoofPiece,
  shedRoof,
  spireShell,
} from "../resolve/roof";
import { isPitchedRoof } from "../resolve/roofTypes";
import { structureStyle } from "../resolve/structureStyles";
import { OPPOSITE as OPP, SIDE_STEP as STEP, SIDES } from "../gen/gridGeometry";
import { hasLeaf, isWindow, openingTests } from "../gen/openingKinds";
import { isPlankWallStyle, THEME_WALL_STYLE } from "../gen/wallStyles";
import { THEME_WALL_ROLE, wallRole } from "../palette/roles";
import { sideEdgeIndex, sideOrient } from "../resolve/levelGrid";
import type { WorldFrame } from "./geometry";
import { rotateXZ } from "./geometry";
import { h32Utf16, hashUnitUtf16 } from "../util/hash";

export interface StructureRealizeCtx {
  L: ResolvedLevel;
  /** What the plan's generator does (plan/generator.ts); a version-dependent rule here reads a switch of it. */
  profile: GeneratorProfile;
  frame: WorldFrame;
  seed: number;
  /** Role lookup for this level (quiet: no role_missing warning). */
  lookup: (theme: string, roles: string[], filter?: VariantFilter, quiet?: boolean) => RoleResolution | null;
  pick: (vs: ResolvedVariant[], key: string) => ResolvedVariant | undefined;
  facingOf: (v: ResolvedVariant, rolePrefix: string, role: string) => PaletteFacing;
  emit: (
    v: ResolvedVariant,
    role: PlacementRole,
    x: number,
    y: number,
    z: number,
    rotDeg: number,
    source: Placement["source"],
    layer?: string,
  ) => void;
  /** Absolute floor top of a plan cell (elevation + 0.5 + height); the level floor top outside the level. */
  groundTop: (x: number, y: number) => number;
  info: (code: string, message: string, role?: string) => void;
}

const EPS = 1e-6;
const key = (x: number, y: number): string => `${x},${y}`;

const lengthOf = (v: ResolvedVariant): number =>
  v.geom.lengthAxis === "square" || v.geom.lengthAxis === undefined
    ? Math.max(1, Math.round(Math.max(v.geom.size.x, v.geom.size.z)))
    : Math.max(1, Math.round(v.geom.lengthAxis === "x" ? v.geom.size.x : v.geom.size.z));
const lenFilter = (n: number): VariantFilter => ({ key: `len${n}`, test: (v) => lengthOf(v) === n });
const notBroken: VariantFilter = { key: "intact", test: (v) => v.variant !== "broken" };
const brokenOnly: VariantFilter = { key: "broken", test: (v) => v.variant === "broken" };
const both = (a: VariantFilter, b: VariantFilter): VariantFilter => ({
  key: `${a.key}+${b.key}`,
  test: (v) => a.test(v) && b.test(v),
});

/**
 * A weathered or ruined building whose condition the generator makes legible (generator 3, `legibleCondition`): its
 * porch roofs fall, its debris is of its own material and lies at its own angles, and the rubble on its broken walls
 * lies along them. (The resolver gives exactly these buildings a growth level.)
 */
const legiblyWorn = (ctx: StructureRealizeCtx, st: ResolvedStructure): boolean =>
  ctx.profile.legibleCondition && (st.condition ?? "intact") !== "intact";

/** Footprint at rot 0 in plan cells [w, h]; tiles round up, props to nearest. */
const footOf = (v: ResolvedVariant): readonly [number, number] => v.footprint;

export function realizeStructures(ctx: StructureRealizeCtx): void {
  for (const st of ctx.L.structures ?? []) {
    if (st.kind === "enclosure") buildEnclosure(ctx, st);
    else buildBuilding(styleWatch(ctx, st), st);
  }
}

/** The role families a style's look depends on (walls, windows, doors, parapets, roof kit). */
const STYLE_ROLE =
  /^(facade|window|opening\.(door|double_door))\.[a-z_]+$|^roof\.[a-z_]+\.(slope|slope2x2|flat)$/;

/**
 * A lookup that notes, once per building and role, when a style's own piece is missing in the theme and the chain
 * falls back to another role (a modern block drawn with a town door): info `structure_style_fallback`.
 */
function styleWatch(ctx: StructureRealizeCtx, st: ResolvedStructure): StructureRealizeCtx {
  const seen = new Set<string>();
  // era: a style that declares which palette rows it accepts (its own role families, or rows owned by its
  // themes) never borrows a piece from another era's kit — a missing piece is left out and named instead
  const era = structureStyle(st.style)?.era;
  const eraRoles = era?.roles.map((p) => new RegExp(p));
  const accepts = (r: RoleResolution): boolean =>
    !era || era.themes.includes(r.paletteId) || (eraRoles ?? []).some((re) => re.test(r.role));
  const eraLookup = (theme: string, roles: string[], filter?: VariantFilter): RoleResolution | null => {
    for (const role of roles) {
      const r = ctx.lookup(theme, [role], filter, true);
      if (!r) continue;
      if (accepts(r)) return r;
      if (!seen.has(`era:${r.role}`)) {
        seen.add(`era:${r.role}`);
        ctx.info(
          "structure_style_fallback",
          `${st.id} (style ${st.style}): "${r.role}" in theme "${theme}" is not a piece of this style's era; left out`,
          r.role,
        );
      }
    }
    return null;
  };
  return {
    ...ctx,
    lookup: (theme, roles, filter, quiet) => {
      const r = era ? eraLookup(theme, roles, filter) : ctx.lookup(theme, roles, filter, quiet);
      const want = roles[0];
      const suffix = want?.split(".").pop() ?? "";
      // another role of the same style (facade.stone → wall.stone) is the same look: not a fallback
      const same = r !== null && r.role.endsWith(`.${suffix}`);
      if (want && roles.length > 1 && STYLE_ROLE.test(want) && r?.role !== want && !same && !seen.has(want)) {
        seen.add(want);
        // only when the preferred role has no piece at all in the theme (not just none of this length)
        if (ctx.lookup(theme, [want], undefined, true) === null)
          ctx.info(
            "structure_style_fallback",
            `${st.id} (style ${st.style}): theme "${theme}" has no "${want}" piece; built with ${r ? `"${r.role}"` : "nothing"} instead`,
            want,
          );
      }
      return r;
    },
  };
}

// ───────────────────────────── edge pieces ─────────────────────────────

/**
 * A half-cell edge piece on the outside of footprint cell (x, y) face `face`, running `len` cells along the face
 * (east for N/S faces, south for E/W faces), hosted in the outside cell — the placement rule of realize's walls.
 */
function edgePiece(
  ctx: StructureRealizeCtx,
  v: ResolvedVariant,
  role: PlacementRole,
  x: number,
  y: number,
  face: Side,
  len: number,
  yBase: number,
  sourceId: string,
  layer: string | undefined,
  handleFacing?: PaletteFacing,
): void {
  const [dx, dy] = STEP[face];
  const hx = x + dx;
  const hy0 = y + dy;
  const planSide = OPP[face]; // side of the host cell the edge lies on
  const vertical = face === "E" || face === "W";
  const hy = vertical && ctx.frame.o.flipZ ? hy0 + len - 1 : hy0;
  const ws = ctx.frame.worldSide(planSide);
  const ep = ctx.frame.o.edgePlacement[ws];
  const m = ctx.frame.rectMin(hx, hy, 1, 1);
  const axisFix = v.geom.lengthAxis === "z" ? 6 : 0;
  let steps = (ep.rotSteps[0] + axisFix) % 24;
  if (handleFacing?.handleEnd) {
    const pref = ctx.frame.o.doorHandlePreference;
    const want: Side = ws === "N" || ws === "S" ? (pref?.eastWestEdge ?? "W") : (pref?.northSouthEdge ?? "N");
    const cand = ep.rotSteps.map((r) => (r + axisFix) % 24);
    steps = cand.find((r) => ctx.frame.dirAfter(handleFacing.handleEnd ?? "W", r) === want) ?? steps;
  }
  ctx.emit(
    v,
    role,
    m.x + ep.offset.x,
    yBase,
    m.z + ep.offset.z,
    steps * 15 + v.rot,
    { cell: [Math.floor(hx), Math.floor(hy0)], elementId: sourceId },
    layer,
  );
}

/**
 * Covers [lo, hi] on one edge with a role's 1-long pieces: tall pieces from the bottom while they fit, then short
 * pieces (shortRoles, when shorter), and a last piece aligned to hi for the remainder. With allowBelow the last
 * piece may reach below lo (into the ground or the course below, same plane); without it a remainder that does not
 * fit is left open (never cover a window or door below).
 */
function stackEdge(
  ctx: StructureRealizeCtx,
  theme: string,
  roles: string[],
  role: PlacementRole,
  x: number,
  y: number,
  face: Side,
  lo: number,
  hi: number,
  sourceId: string,
  layer: string | undefined,
  opts: { shortRoles?: string[]; allowBelow?: boolean } = {},
): boolean {
  if (hi - lo < 0.05) return true;
  const pickV = (rs: string[] | undefined): ResolvedVariant | undefined => {
    if (!rs || rs.length === 0) return undefined;
    const r = ctx.lookup(theme, rs, lenFilter(1), true);
    return r
      ? ctx.pick(r.variants, `${ctx.L.id}:${sourceId}:${x},${y}${face}:${lo}:${rs[0] ?? ""}`)
      : undefined;
  };
  const tall = pickV(roles);
  const shortV = pickV(opts.shortRoles);
  const short = shortV && (!tall || shortV.unitHeight < tall.unitHeight - EPS) ? shortV : undefined;
  if (!tall && !short) return false;
  let yy = lo;
  if (tall)
    while (hi - yy >= tall.unitHeight - EPS) {
      edgePiece(ctx, tall, role, x, y, face, 1, yy, sourceId, layer);
      yy += tall.unitHeight;
    }
  if (short)
    while (hi - yy >= short.unitHeight - EPS) {
      edgePiece(ctx, short, role, x, y, face, 1, yy, sourceId, layer);
      yy += short.unitHeight;
    }
  if (hi - yy > 0.2) {
    const fin = short ?? tall;
    if (fin && (hi - fin.unitHeight >= lo - EPS || opts.allowBelow))
      edgePiece(ctx, fin, role, x, y, face, 1, hi - fin.unitHeight, sourceId, layer);
  }
  return true;
}

// ───────────────────────────── buildings ─────────────────────────────

interface FaceCell {
  x: number;
  y: number;
  face: Side;
}

function faceCells(cells: ReadonlySet<string>): FaceCell[] {
  const out: FaceCell[] = [];
  for (const k of [...cells].sort()) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    for (const face of SIDES) {
      const [dx, dy] = STEP[face];
      if (!cells.has(key(x + dx, y + dy))) out.push({ x, y, face });
    }
  }
  return out;
}

/** Runs of consecutive face cells on one line (for length-2 wall pieces). */
function faceRunsOf(list: readonly FaceCell[]): FaceCell[][] {
  const byLine = new Map<string, FaceCell[]>();
  for (const f of list) {
    const line = f.face === "N" || f.face === "S" ? `${f.face}|${f.y}` : `${f.face}|${f.x}`;
    const arr = byLine.get(line) ?? [];
    arr.push(f);
    byLine.set(line, arr);
  }
  const runs: FaceCell[][] = [];
  for (const arr of [...byLine.values()]) {
    const along = (f: FaceCell): number => (f.face === "N" || f.face === "S" ? f.x : f.y);
    arr.sort((a, b) => along(a) - along(b));
    let cur: FaceCell[] = [];
    for (const f of arr) {
      const last = cur[cur.length - 1];
      if (last && along(f) !== along(last) + 1) {
        runs.push(cur);
        cur = [];
      }
      cur.push(f);
    }
    if (cur.length) runs.push(cur);
  }
  return runs;
}

type Op = { id: string; kind: OpeningKind; width: number; first: FaceCell; index: number };
type VStoreyR = ResolvedVolume["storeys"][number];
type LitWindow = { x: number; y: number; face: Side; floorTop: number; layer: string; walls: WallStyle };

/** A phase-1 record has no volumes: one volume over its footprint and wings, storeys and roof. */
function volumesOf(st: ResolvedStructure): ResolvedVolume[] {
  if (st.volumes && st.volumes.length > 0) return st.volumes;
  return [
    {
      id: "main",
      on: null,
      corners: "square",
      rects: st.wings,
      storeys: st.storeys.map((s) => ({
        floorTop: s.floorTop,
        wallTop: s.floorTop + s.wallHeight,
        cells: st.cells,
        rect: boundsOfCells(st.cells),
        footing: s.footing,
        walls: s.walls,
        floor: s.floor,
        seam: null,
      })),
      roof: {
        layers: [
          {
            type: st.roof.type,
            requested: st.roof.requested,
            style: st.roof.style,
            courses: 1,
            low: "S",
            parapet: st.roof.parapet,
            ridge: st.wings[0]?.ridge ?? "ew",
          },
        ],
        deck: st.roof.deck,
        broken: st.roof.broken,
      },
    },
  ];
}

function boundsOfCells(cells: ReadonlyArray<readonly [number, number]>): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of cells) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { x: 0, y: 0, w: 0, h: 0 };
}

const setOf = (cells: ReadonlyArray<readonly [number, number]>): Set<string> =>
  new Set(cells.map(([x, y]) => key(x, y)));

function rectCellsOf(r: Rect): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push([x, y]);
  return out;
}

/** Deterministic 0..1 from a key (build-time choices: lit windows, clutter). */
const unit01 = (ctx: StructureRealizeCtx, k: string): number => hashUnitUtf16(ctx.seed, k);

/**
 * A building: volume by volume, storey by storey (walls, openings, posts, upper floors, the seam a set-in storey
 * leaves on the one below), then each volume's stacked roof layers, chimneys, porches, lights and roof furniture.
 * Ground-floor openings belong to the synthetic area's footprint and are built by the volume whose face they are on;
 * a face another volume covers over most of the storey's height gets no wall (no wall between joined volumes).
 */
function buildBuilding(ctx: StructureRealizeCtx, st: ResolvedStructure): void {
  const groundCells = setOf(st.cells);
  const theme = st.theme;
  const vols = volumesOf(st);
  const openingsById = new Map(ctx.L.openings.map((o) => [o.id, o]));
  const chimneyWall = new Set<string>();
  for (const c of st.chimneys) {
    const [dx, dy] = STEP[c.side];
    chimneyWall.add(`${c.at[0] - dx},${c.at[1] - dy},${c.side}`);
  }
  const mainId = vols.find((v) => v.on === null)?.id ?? "main";
  const tagOf = (vid: string): string => (vid === mainId ? st.id : `${st.id}~${vid}`);
  const GROUND = "@ground:0";

  // per "volume:storey": which face cells are taken by which opening (all ground storeys share "@ground:0")
  const opsBy = new Map<string, Map<string, Op>>();
  const markOpening = (
    k: string,
    id: string,
    kind: OpeningKind,
    x: number,
    y: number,
    face: Side,
    width: number,
  ): void => {
    const m = opsBy.get(k) ?? new Map<string, Op>();
    for (let i = 0; i < width; i++) {
      const cx = face === "N" || face === "S" ? x + i : x;
      const cy = face === "N" || face === "S" ? y : y + i;
      m.set(`${cx},${cy},${face}`, { id, kind, width, first: { x, y, face }, index: i });
    }
    opsBy.set(k, m);
  };
  for (const id of st.openingIds) {
    const o = openingsById.get(id);
    if (!o) continue;
    // the resolver records an opening by the edge's start vertex; find its footprint cell and face
    const cellA: [number, number] =
      o.orientation === "h" ? [o.start[0], o.start[1] - 1] : [o.start[0] - 1, o.start[1]];
    const cellB: [number, number] = [o.start[0], o.start[1]];
    const inA = groundCells.has(key(cellA[0], cellA[1]));
    const face: Side = o.orientation === "h" ? (inA ? "S" : "N") : inA ? "E" : "W";
    const c = inA ? cellA : cellB;
    markOpening(GROUND, id, o.kind, c[0], c[1], face, o.width);
  }
  st.upperOpenings.forEach((u, i) => {
    const vid = u.volume ?? mainId;
    const ground = u.storey === 0 && vols.find((v) => v.id === vid)?.on === null;
    markOpening(
      ground ? GROUND : `${vid}:${u.storey}`,
      `${tagOf(vid)}~u${u.storey}${u.kind}${i}`,
      u.kind,
      u.at[0],
      u.at[1],
      u.side,
      u.width,
    );
  });

  // party walls: a building earlier in the list that stands against this one builds the shared wall
  const all = ctx.L.structures ?? [];
  const earlier = all
    .slice(0, Math.max(0, all.indexOf(st)))
    .filter((o) => o.kind === "building")
    .flatMap((o) => volumesOf(o));
  /** Another volume's storey (this building's, or an earlier neighbour's) fills the cell over most of this storey's
   * height: no wall faces it. */
  const covered = (v: ResolvedVolume, sp: VStoreyR, x: number, y: number): boolean =>
    vols.some(
      (o) =>
        o !== v &&
        o.storeys.some(
          (os) =>
            os.cells.some((c) => c[0] === x && c[1] === y) &&
            Math.min(os.wallTop, sp.wallTop) - Math.max(os.floorTop, sp.floorTop) > 0.5,
        ),
    ) || party(sp, x, y);
  /** A neighbour's wall courses on this cell span this storey's whole height (its ground walls reach the ground). */
  const party = (sp: VStoreyR, x: number, y: number): boolean =>
    earlier.some((o) => {
      let lo = Infinity;
      let hi = -Infinity;
      o.storeys.forEach((os, i) => {
        if (!os.cells.some((c) => c[0] === x && c[1] === y)) return;
        lo = Math.min(lo, i === 0 && o.on === null ? -Infinity : os.floorTop - 0.5);
        hi = Math.max(hi, os.wallTop);
      });
      return lo <= sp.floorTop - 0.5 + 1e-6 && hi >= sp.wallTop - 1e-6;
    });

  // a weathered or ruined building: every wall column stops at its surviving top; fallen floor cells stay open
  const caps = st.ruin
    ? new Map(st.ruin.columns.map((c) => [`${c.at[0]},${c.at[1]},${c.side}`, c.top]))
    : undefined;
  const holesOf = new Map((st.ruin?.holes ?? []).map((h) => [`${h.volume}:${h.storey}`, setOf(h.cells)]));
  const ruined = st.condition === "ruined";
  const windows: LitWindow[] = [];
  for (const v of vols) {
    const tag = tagOf(v.id);
    v.storeys.forEach((sp, s) => {
      const ground = s === 0 && v.on === null;
      const own = setOf(sp.cells);
      const ops = opsBy.get(ground ? GROUND : `${v.id}:${s}`) ?? new Map<string, Op>();
      const layer = `storey:${s}`;
      // upper floors (the ground floor is the area's own floor)
      const fallen = holesOf.get(`${v.id}:${s}`);
      if (!ground)
        placeFloor(
          ctx,
          theme,
          [`floor.${sp.floor}`],
          fallen ? new Set([...own].filter((k) => !fallen.has(k))) : own,
          sp.floorTop - 0.5,
          `${tag}~floor${s}`,
          layer,
          "floor",
        );
      const prev = v.storeys[s - 1];
      if (prev && sp.seam && !ruined) buildSeam(ctx, st, theme, prev, sp, `${tag}~seam${s}`);
      if (sp.walls === null) return;
      const keptWhole = ruined && st.ruin?.keep === v.id;
      const faces = faceCells(own).filter((f) => {
        const [dx, dy] = STEP[f.face];
        // the kept, roofed volume of a ruin keeps its wall where a wing stood against it: the wing's own walls fell, so
        // the cell beside it is no longer a room, and the eave must not hang over a gap (generator 3)
        if (keptWhole && !party(sp, f.x + dx, f.y + dy)) return true;
        return !covered(v, sp, f.x + dx, f.y + dy);
      });
      buildCourses(ctx, theme, {
        s,
        faces,
        own,
        ops,
        floorTop: sp.floorTop,
        top: sp.wallTop,
        footing: ground ? sp.footing : null,
        walls: sp.walls,
        ground,
        layer,
        chimneyWall,
        tag,
        windows,
        openTop: ruined,
        ...(caps ? { caps } : {}),
        ...(st.ruin?.arches
          ? { arches: new Set(st.ruin.arches.map((q) => `${q.at[0]},${q.at[1]},${q.side}`)) }
          : {}),
        ...(st.design
          ? { doorUse: USE_DOOR[st.design.use] ?? (structureStyle(st.style)?.era ? "home" : "") }
          : {}),
      });
    });
  }

  if (!ruined) buildLips(ctx, st, theme, vols);

  // ── roofs, volume by volume ──
  let mainRoofTop = vols[0]?.storeys[vols[0].storeys.length - 1]?.wallTop ?? 0;
  const flatTops: FlatTop[] = [];
  // cells of every other building: a parapet never stands against a neighbour
  const foreign = new Set<string>();
  for (const o of all)
    if (o !== st && o.kind === "building") for (const [x, y] of o.cells) foreign.add(key(x, y));
  // generator 3: roofs that meet are merged into valleys (the higher surface owns each cell)
  const merge = st.valleys ? roofValleys(st, vols) : undefined;
  for (const v of vols) {
    const top = v.storeys[v.storeys.length - 1];
    if (!top) continue;
    const res = buildRoof(ctx, st, theme, v, top, chimneyWall, tagOf(v.id), foreign, merge);
    if (v.id === mainId) mainRoofTop = res.top;
    if (res.flat) flatTops.push(res.flat);
  }

  if (!ruined) buildChimneys(ctx, st, theme, mainRoofTop);
  buildPorches(ctx, st, theme);
  buildDoorLights(ctx, st, theme);
  buildWindowLights(ctx, st, theme, windows);
  buildEntranceStrips(ctx, st, theme);
  buildShopfront(ctx, st, theme);
  buildDebris(ctx, st, theme);
  buildDetails(ctx, st, theme, vols, foreign);
  if (caps) buildRuinFragments(ctx, st, theme);
  buildWallTopRubble(ctx, st, theme);
  buildGrowth(ctx, st, theme);
  // a volume standing on a flat top (a tower on its podium) takes its cells and wall ring off that roof
  for (const t of flatTops)
    for (const v of vols)
      for (const sp of v.storeys)
        if (sp.floorTop > t.y - 0.6 && sp.floorTop < t.y + 0.6) {
          const own = setOf(sp.cells);
          for (const k of [...own, ...ringOf8(own)]) t.cells.delete(k);
        }
  buildRoofFurniture(ctx, st, theme, flatTops);
}

interface CourseArgs {
  s: number;
  /** Weathered or ruined: the surviving top of each wall column ("x,y,face"), absolute; the walls stop there. */
  caps?: ReadonlyMap<string, number>;
  /** A ruin: open doorways and breaches get no filler above them. */
  openTop?: boolean;
  /** Ruins (generator 3): openings whose frame and arch stand on ("x,y,face" of the first cell). */
  arches?: ReadonlySet<string>;
  faces: FaceCell[];
  own: ReadonlySet<string>;
  ops: ReadonlyMap<string, Op>;
  floorTop: number;
  top: number;
  footing: { style: WallStyle; height: number } | null;
  walls: WallStyle;
  ground: boolean;
  layer: string;
  chimneyWall: ReadonlySet<string>;
  tag: string;
  windows: LitWindow[];
  /** Door family for the building's use (shop, home, office, works), tried before the wall style's doors. */
  doorUse?: string;
}

/** Door family per building use (palette roles opening.door.<family>, opening.double_door.<family>). */
const USE_DOOR: Readonly<Record<string, string>> = {
  shop: "shop",
  diner: "shop",
  office: "office",
  civic: "office",
  apartments: "home",
  townhouse: "home",
  warehouse: "works",
  garage: "works",
  workshop: "works",
};

/** One storey's walls: footing course, main course (length-2 pieces along runs), openings with fillers, corner posts. */
function buildCourses(ctx: StructureRealizeCtx, theme: string, a: CourseArgs): void {
  const { s, faces, ops, floorTop, top, footing, layer, chimneyWall, tag } = a;
  const style = a.walls;
  const mainBase = floorTop + (footing?.height ?? 0);
  const mainRoles = [`facade.${style}`, wallRole(style), THEME_WALL_ROLE];
  const capAt = (x: number, y: number, face: Side): number => a.caps?.get(`${x},${y},${face}`) ?? Infinity;
  const along = (f: FaceCell, k: number): [number, number, Side] =>
    f.face === "N" || f.face === "S" ? [f.x + k, f.y, f.face] : [f.x, f.y + k, f.face];
  // a window whose column has broken off below the storey's top is gone: its cells are built as broken wall
  const brokenOps = new Set<string>();
  if (a.caps)
    for (const [k, op] of ops)
      if (isWindow(op.kind) && (a.caps.get(k) ?? Infinity) < top - EPS) brokenOps.add(op.id);
  // ruins break cell by cell: one-cell pieces where the style has them
  const single =
    a.openTop === true && a.caps !== undefined && ctx.lookup(theme, mainRoles, lenFilter(1), true) !== null;
  // ground storey walls reach down to the ground outside when the pad is higher than its surroundings
  const lowAt = (f: FaceCell): number => {
    if (!a.ground) return floorTop;
    const [dx, dy] = STEP[f.face];
    return Math.min(floorTop, ctx.groundTop(f.x + dx, f.y + dy));
  };
  // footing course (ground storey)
  if (footing) {
    const fs = footing.style;
    for (const f of faces) {
      const op = ops.get(`${f.x},${f.y},${f.face}`);
      if (chimneyWall.has(`${f.x},${f.y},${f.face}`)) continue;
      if (op && !isWindow(op.kind)) continue;
      stackEdge(
        ctx,
        theme,
        [`footing.${fs}`, `facade.${fs}`, `wall.${fs}`],
        "wall",
        f.x,
        f.y,
        f.face,
        lowAt(f),
        mainBase,
        `${tag}~footing`,
        layer,
        { allowBelow: true },
      );
    }
  }
  // main course: plain wall runs (length-2 pieces where they fit)
  const plain = faces.filter((f) => {
    const op = ops.get(`${f.x},${f.y},${f.face}`);
    return (!op || brokenOps.has(op.id)) && !chimneyWall.has(`${f.x},${f.y},${f.face}`);
  });
  for (const run of faceRunsOf(plain)) {
    let i = 0;
    while (i < run.length) {
      const f = run[i] as FaceCell;
      const lo = a.ground && !footing ? lowAt(f) : mainBase;
      const flatBase = a.ground && !footing ? Math.abs(lo - mainBase) < EPS : true;
      let placed = 0;
      for (const n of [2, 1]) {
        if (n > run.length - i) continue;
        if (n === 2 && single) continue;
        if (n === 2) {
          const g = run[i + 1] as FaceCell;
          const lo2 = a.ground && !footing ? lowAt(g) : mainBase;
          if (!flatBase || Math.abs(lo2 - lo) > EPS) continue;
        }
        const r = ctx.lookup(theme, mainRoles, lenFilter(n), n !== 1);
        const v = r ? ctx.pick(r.variants, `${ctx.L.id}:${tag}:w${s}:${f.x},${f.y}${f.face}`) : undefined;
        if (!v) continue;
        if (a.ground) {
          // from the top down: the lowest piece may reach into the ground outside
          // a broken column stops at its surviving top (the pieces reach down into the ground below the floor)
          const tg = Math.min(top, capAt(f.x, f.y, f.face), n === 2 ? capAt(...along(f, 1)) : Infinity);
          const count = Math.max(1, Math.ceil((tg - lo) / v.unitHeight - EPS));
          for (let k = 0; k < count; k++)
            edgePiece(
              ctx,
              v,
              "wall",
              f.x,
              f.y,
              f.face,
              n,
              tg - (count - k) * v.unitHeight,
              `${tag}~wall`,
              layer,
            );
        } else {
          const t2 = Math.min(top, capAt(f.x, f.y, f.face), n === 2 ? capAt(...along(f, 1)) : Infinity);
          if (t2 > floorTop + 0.2)
            upperCourse(ctx, theme, v, f, n, floorTop - 0.5, t2, style, `${tag}~wall`, layer);
        }
        placed = n;
        break;
      }
      i += Math.max(1, placed);
    }
  }
  // openings (only those on this storey's faces)
  const faceKeys = new Set(faces.map((f) => `${f.x},${f.y},${f.face}`));
  const done = new Set<string>();
  for (const op of ops.values()) {
    if (done.has(op.id) || brokenOps.has(op.id)) continue;
    done.add(op.id);
    const f = op.first;
    if (!faceKeys.has(`${f.x},${f.y},${f.face}`)) continue;
    const windowed = isWindow(op.kind);
    // upper-storey windows sit on the wall top below (the floor band is wall), ground ones on the footing
    const base = windowed ? (a.ground ? mainBase : floorTop - 0.5) : floorTop;
    const roles = windowed
      ? [`window.${style}`, `opening.${op.kind}.${style}`, `opening.${op.kind}`]
      : [
          ...(a.ground && a.doorUse ? [`opening.${op.kind}.${a.doorUse}`] : []),
          `opening.${op.kind}.${style}`,
          `opening.${op.kind}`,
        ];
    let i = 0;
    let leafTop = base;
    while (i < op.width) {
      const cx = f.face === "N" || f.face === "S" ? f.x + i : f.x;
      const cy = f.face === "N" || f.face === "S" ? f.y : f.y + i;
      let n = 0;
      if (op.kind !== "open")
        // the style's own role first in every length, before a broader role (no 2-wide window of another kit
        // where the style has 1-wide ones)
        for (const [role, len] of roles.flatMap((ro) =>
          [op.width - i, 2, 1]
            .filter((l, j, arr) => l >= 1 && l <= op.width - i && arr.indexOf(l) === j)
            .map((l) => [ro, l] as const),
        )) {
          const r = ctx.lookup(theme, [role], lenFilter(len), true);
          const v = r ? ctx.pick(r.variants, `${ctx.L.id}:${op.id}:${i}`) : undefined;
          if (!v || !r) continue;
          const facing = hasLeaf(op.kind) ? ctx.facingOf(v, "opening", r.role) : undefined;
          edgePiece(ctx, v, "opening", cx, cy, f.face, len, base, op.id, layer, facing);
          leafTop = base + v.unitHeight;
          n = len;
          break;
        }
      if (n === 0) {
        if (op.kind !== "open" && op.kind !== "archway")
          ctx.info(
            "role_missing",
            `No "${roles[roles.length - 1] ?? ""}" piece for ${op.id}; left open`,
            roles[0],
          );
        n = 1;
        leafTop = base + 2;
      }
      // filler above a door shorter than the wall (lintel), down to nothing when the door fills the course
      for (let k = 0; k < n; k++) {
        const ex = f.face === "N" || f.face === "S" ? cx + k : cx;
        const ey = f.face === "N" || f.face === "S" ? cy : cy + k;
        if (windowed) a.windows.push({ x: ex, y: ey, face: f.face, floorTop, layer, walls: style });
        // (a ruin's empty doorways and breaches stay open to the top: broken wall stubs either side)
        const tc = Math.min(top, capAt(ex, ey, f.face));
        const standing = a.arches?.has(`${f.x},${f.y},${f.face}`) === true;
        if (tc - leafTop > 0.2 && !(a.openTop && op.kind === "open" && !standing)) {
          const lintel = [`over_door.${style}`];
          if (footing) lintel.push(`footing.${footing.style}`);
          lintel.push(...mainRoles);
          // (over an empty doorway the grid has no opening edge, so the lintel is a wall piece, not a door piece)
          stackEdge(
            ctx,
            theme,
            lintel,
            op.kind === "open" ? "wall" : "opening",
            ex,
            ey,
            f.face,
            leafTop,
            tc,
            op.id,
            layer,
            {
              shortRoles: [`over_door.${style}`],
            },
          );
        }
      }
      i += n;
    }
  }
  // outer corner posts (footing course and wall course)
  for (const k of a.own) {
    const [cx, cy] = k.split(",").map(Number) as [number, number];
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      if (a.own.has(key(cx + dx, cy)) || a.own.has(key(cx, cy + dy)) || a.own.has(key(cx + dx, cy + dy)))
        continue;
      const px = dx < 0 ? cx - 0.5 : cx + 1;
      const py = dy < 0 ? cy - 0.5 : cy + 1;
      const lo = a.ground ? Math.min(floorTop, ctx.groundTop(cx + dx, cy + dy)) : floorTop - 0.5; // upper courses close the floor band
      // a broken corner stands no higher than the lower of its two walls
      const ptop = Math.min(top, capAt(cx, cy, dx < 0 ? "W" : "E"), capAt(cx, cy, dy < 0 ? "N" : "S"));
      const courses: Array<[string[], number, number]> = [];
      if (footing) {
        const fs = footing.style;
        courses.push([
          [`facade_post.${fs}`, `wall_post.${fs}`, "wall_post.wall"],
          lo,
          Math.min(mainBase, ptop),
        ]);
        courses.push([[`facade_post.${style}`, `wall_post.${style}`, "wall_post.wall"], mainBase, ptop]);
      } else courses.push([[`facade_post.${style}`, `wall_post.${style}`, "wall_post.wall"], lo, ptop]);
      for (const [roles, ya, yb] of courses) {
        const r = ctx.lookup(theme, roles, undefined, true);
        const v = r ? ctx.pick(r.variants, `${ctx.L.id}:${tag}:post:${px},${py}`) : undefined;
        // a post taller than its course would poke into the ground or past the wall: leave the corner open
        // (a ruin's ground corner stub is built top-down like its walls, reaching below the floor)
        if (!v || yb - ya < 0.05 || (v.unitHeight > yb - ya + 0.3 && !(a.caps && a.ground))) continue;
        const m = ctx.frame.rectMin(px, py, 0.5, 0.5);
        const n = Math.max(1, Math.ceil((yb - ya) / v.unitHeight - EPS));
        for (let j = 0; j < n; j++)
          ctx.emit(
            v,
            "wall_post",
            m.x,
            // ground: from the top down (into the ground); upper storeys: from the floor up, the last one top-aligned
            a.ground ? yb - (n - j) * v.unitHeight : Math.min(ya + j * v.unitHeight, yb - v.unitHeight),
            m.z,
            v.rot,
            { cell: [Math.floor(px), Math.floor(py)], elementId: `${tag}~post` },
            layer,
          );
      }
    }
  }
}

/**
 * An upper storey's wall course on one run of n face cells: full pieces from the floor up, then short pieces
 * (wall_short / over_door / footing of the style) for a remainder, else one more full piece aligned to the top
 * (overlapping its own course, never the storey below).
 */
function upperCourse(
  ctx: StructureRealizeCtx,
  theme: string,
  v: ResolvedVariant,
  f: FaceCell,
  n: number,
  lo: number,
  top: number,
  style: WallStyle,
  sourceId: string,
  layer: string,
): void {
  const u = v.unitHeight;
  const full = Math.max(0, Math.floor((top - lo) / u + EPS));
  for (let k = 0; k < full; k++) edgePiece(ctx, v, "wall", f.x, f.y, f.face, n, lo + k * u, sourceId, layer);
  let y = lo + full * u;
  if (top - y <= 0.2) return;
  const shortRoles = [`wall_short.${style}`, `over_door.${style}`, `footing.${style}`];
  for (const len of n === 2 ? [2, 1] : [1]) {
    const r = ctx.lookup(theme, shortRoles, lenFilter(len), true);
    const sv = r ? ctx.pick(r.variants, `${ctx.L.id}:${sourceId}:short:${f.x},${f.y}${f.face}`) : undefined;
    if (!sv || sv.unitHeight > top - y + EPS || sv.unitHeight >= u - EPS) continue;
    while (top - y >= sv.unitHeight - EPS) {
      for (let c = 0; c < n; c += len) {
        const cx = f.face === "N" || f.face === "S" ? f.x + c : f.x;
        const cy = f.face === "N" || f.face === "S" ? f.y : f.y + c;
        edgePiece(ctx, sv, "wall", cx, cy, f.face, len, y, sourceId, layer);
      }
      y += sv.unitHeight;
    }
    break;
  }
  if (top - y > 0.2) edgePiece(ctx, v, "wall", f.x, f.y, f.face, n, Math.max(lo, top - u), sourceId, layer);
}

/** The ring a set-in storey leaves on the storey below: a skirt of roof slope, a plain ledge, or a crenellated one. */
function buildSeam(
  ctx: StructureRealizeCtx,
  st: ResolvedStructure,
  theme: string,
  prev: VStoreyR,
  sp: VStoreyR,
  tag: string,
): void {
  const inner = setOf(sp.cells);
  const ring = setOf(prev.cells.filter(([x, y]) => !inner.has(key(x, y))));
  if (ring.size === 0) return;
  const y = prev.wallTop;
  const kit = st.roof.style || "slate";
  if (sp.seam === "skirt") {
    // slopes falling outward over the ledge, from the upper wall line down to the lower storey's eave
    const courses = Math.max(1, sp.rect.x - prev.rect.x, sp.rect.y - prev.rect.y);
    const g = ringLayer(prev.rect, courses, "slope", false);
    for (const p of g.pieces) if (ring.has(key(p.x, p.y))) placeRoofPiece(ctx, st, theme, kit, p, y, tag);
    return;
  }
  const ps = prev.walls ?? "stone";
  placeFloor(
    ctx,
    theme,
    [`seam_ledge.${ps}`, `floor.${prev.floor}`],
    ring,
    y,
    `${tag}~ledge`,
    "roof",
    "floor",
  );
  // battlements on the ledge's outer edge: one course of crenellation pieces, else a parapet course
  if (sp.seam === "crenellated")
    for (const f of faceCells(setOf(prev.cells))) {
      const r = ctx.lookup(theme, [`crenel.${ps}`, "crenel.default"], lenFilter(1), true);
      const v = r ? ctx.pick(r.variants, `${ctx.L.id}:${tag}:crenel`) : undefined;
      if (v) edgePiece(ctx, v, "wall", f.x, f.y, f.face, 1, y + 0.5, `${tag}~crenel`, "roof");
      else
        stackEdge(
          ctx,
          theme,
          ["wall.parapet", "wall.low_wall"],
          "wall",
          f.x,
          f.y,
          f.face,
          y + 0.5,
          y + 1.5,
          `${tag}~crenel`,
          "roof",
        );
    }
}

/**
 * The pitched roofs of a building (first layer of every volume: gable wings, hips, sheds) merged where they meet
 * (resolve/roof.ts mergeRoofs); keyed "<volume>#<wing>". Heights match buildRoof: the wall top, plus the attic deck.
 */
function roofValleys(st: ResolvedStructure, vols: ResolvedVolume[]): Map<string, RoofPiece[]> {
  return mergeRoofs(
    roofOwners(vols, new Set(st.chimneys.map((c) => key(c.at[0], c.at[1]))), st.roofFill === true),
  );
}

interface FlatTop {
  cells: Set<string>;
  y: number;
  rect: Rect;
  /** Wall style of the storey under it and the roof kit (a roof hut is built of them). */
  walls: WallStyle | null;
  kit: string;
}

/** The stacked roof layers of one volume; returns the top height and the flat top (for clutter and masts) if any. */
function buildRoof(
  ctx: StructureRealizeCtx,
  st: ResolvedStructure,
  theme: string,
  v: ResolvedVolume,
  top: VStoreyR,
  chimneyWall: ReadonlySet<string>,
  tag: string,
  foreign: ReadonlySet<string> = new Set(),
  merge?: ReadonlyMap<string, RoofPiece[]>,
): { top: number; flat: FlatTop | null } {
  const cells = setOf(top.cells);
  const wallTop = top.wallTop;
  const topStyle = top.walls;
  let base = wallTop;
  let rect: Rect = { ...top.rect };
  let roofTop = wallTop;
  let flat: FlatTop | null = null;
  const holes = new Set(st.chimneys.map((c) => key(c.at[0], c.at[1])));
  const gableFill = (fx: number, fy: number, face: Side, t: number): void => {
    const [dx, dy] = STEP[face];
    if (!cells.has(key(fx, fy)) || cells.has(key(fx + dx, fy + dy))) return;
    if (chimneyWall.has(`${fx},${fy},${face}`) || topStyle === null) return;
    stackEdge(
      ctx,
      theme,
      [`gable.${topStyle}`, `facade.${topStyle}`, `wall.${topStyle}`],
      "wall",
      fx,
      fy,
      face,
      wallTop,
      t,
      `${tag}~gable`,
      "roof",
      { shortRoles: [`over_door.${topStyle}`, `gable_short.${topStyle}`] },
    );
  };
  const n = v.roof.layers.length;
  v.roof.layers.forEach((layer, li) => {
    const kit = layer.style;
    const first = li === 0;
    const last = li === n - 1;
    const pitched = isPitchedRoof(layer.type);
    if (first && v.roof.deck && pitched) {
      placeFloor(
        ctx,
        theme,
        [`roof.${kit}.deck`, "roof.default.deck", `floor.${top.floor}`],
        cells,
        wallTop,
        `${tag}~deck`,
        "roof",
        "floor",
      );
      base = wallTop + 0.5;
    }
    const closeFlat = (r: Rect | null, at: number): void => {
      if (!r) return;
      const topCells = setOf(rectCellsOf(r));
      placeFloor(
        ctx,
        theme,
        [`roof.${kit}.flat`, `floor.${top.floor}`],
        topCells,
        at - 0.5,
        `${tag}~roof${li}`,
        "roof",
        "floor",
      );
      flat = { cells: topCells, y: at, rect: r, walls: topStyle, kit };
    };
    switch (layer.type) {
      case "gable": {
        const wings = first ? v.rects : [{ ...rect, ridge: layer.ridge }];
        const roofs = wings.map((w) => ({ w, g: gableRoof(w, holes) }));
        // a ruin keeps the gable wall at its standing end: the slopes have fallen in
        const only = v.roof.gableOnly;
        // where wings overlap, the higher roof surface wins the cell (approximate valleys)
        const surface = (wi: number, x: number, y: number): number => {
          const r = roofs[wi];
          if (!r) return -1;
          const o = r.g.outline;
          if (x < o.x || y < o.y || x >= o.x + o.w || y >= o.y + o.h) return -1;
          const a = r.w.ridge === "ew" ? y - o.y : x - o.x;
          return r.g.rowCourse[a] ?? -1;
        };
        roofs.forEach((r, wi) => {
          let dormerNext = 1;
          // generator 3 (first layer): the pieces left after the valleys; otherwise every piece, the old rule hiding some
          const mine = first && merge ? merge.get(`${v.id}#${wi}`) : undefined;
          for (const p of mine ?? r.g.pieces) {
            let hidden = false;
            for (let y = p.y; y < p.y + p.h && !hidden && !mine; y++)
              for (let x = p.x; x < p.x + p.w && !hidden; x++)
                for (let wj = 0; wj < roofs.length; wj++) {
                  if (wj === wi) continue;
                  const mine = surface(wi, x, y);
                  const other = surface(wj, x, y);
                  if (other > mine || (other === mine && other >= 0 && wj < wi)) hidden = true;
                }
            if (hidden || only) continue;
            // dormers at a seeded rhythm on the lowest course (kits with a dormer piece only)
            if (st.furniture?.dormers && p.kind === "slope2x2" && p.course === 0) {
              const along = r.w.ridge === "ew" ? p.x - r.g.outline.x : p.y - r.g.outline.y;
              if (along >= dormerNext && placeDormer(ctx, theme, kit, p, base, tag)) {
                dormerNext = along + 3 + (h32Utf16(`${ctx.seed}:${tag}:dormer:${along}`) % 3);
                continue;
              }
            }
            placeRoofPiece(ctx, st, theme, kit, p, base, tag);
          }
          roofTop = Math.max(roofTop, base + r.g.ridgeTop);
          // gable fill under each free gable end (first layer: on the walls)
          if (!first) return;
          const w = r.w;
          const span = w.ridge === "ew" ? w.h + 2 : w.w + 2;
          const ends: Array<[Side, number]> =
            w.ridge === "ew"
              ? [
                  ["W", w.x],
                  ["E", w.x + w.w - 1],
                ]
              : [
                  ["N", w.y],
                  ["S", w.y + w.h - 1],
                ];
          for (const [face, line] of ends)
            for (let a = 1; a <= span - 2 && (!only || face === only); a++) {
              const fx = w.ridge === "ew" ? line : w.x + a - 1;
              const fy = w.ridge === "ew" ? w.y + a - 1 : line;
              gableFill(fx, fy, face, base + (r.g.rowCourse[a] ?? 0));
            }
        });
        base = roofTop;
        return;
      }
      case "hip":
      case "shed": {
        const g =
          layer.type === "hip"
            ? hipRoof(rect, holes)
            : shedRoof(rect, layer.low, holes, st.roofFill === true);
        for (const p of (first && merge ? merge.get(`${v.id}#0`) : undefined) ?? g.pieces)
          placeRoofPiece(ctx, st, theme, kit, p, base, tag);
        if (first)
          for (const f of faceCells(cells)) {
            const [dx, dy] = STEP[f.face];
            const s = g.surface(f.x + dx, f.y + dy);
            if (s > 0) gableFill(f.x, f.y, f.face, base + s);
          }
        roofTop = Math.max(roofTop, base + g.top);
        base = roofTop;
        return;
      }
      case "skirt":
      case "stepped": {
        const g = ringLayer(rect, layer.courses, layer.type === "stepped" ? "step" : "slope", first, holes);
        for (const p of g.pieces) placeRoofPiece(ctx, st, theme, kit, p, base, tag);
        base += layer.courses;
        roofTop = Math.max(roofTop, base);
        if (g.inner) rect = g.inner;
        // a flat top closes the layer unless another layer stands on it
        if (last) closeFlat(g.inner, base);
        return;
      }
      case "spire": {
        const t = buildSpire(ctx, st, theme, kit, topStyle ?? "stone", rect, base, layer.courses, tag);
        roofTop = Math.max(roofTop, t);
        base = roofTop;
        return;
      }
      case "flat": {
        const topCells = first ? cells : setOf(rectCellsOf(rect));
        // a weathered flat roof has fallen in over a patch inside its edge (the edge and parapet stand)
        const fallen = new Set(
          (st.condition === "weathered" ? (st.ruin?.roofHoles ?? []) : [])
            .map(([x, y]) => key(x, y))
            .filter((k) => {
              const [x, y] = k.split(",").map(Number) as [number, number];
              return SIDES.every((sd) => topCells.has(key(x + STEP[sd][0], y + STEP[sd][1])));
            }),
        );
        placeFloor(
          ctx,
          theme,
          [`roof.${kit}.flat`, `floor.${top.floor}`],
          fallen.size ? new Set([...topCells].filter((k) => !fallen.has(k))) : topCells,
          base,
          `${tag}~roof`,
          "roof",
          "floor",
        );
        base += 0.5;
        roofTop = Math.max(roofTop, base);
        flat = {
          cells: new Set([...topCells].filter((k) => !fallen.has(k))),
          y: base,
          rect,
          walls: topStyle,
          kit,
        };
        if (layer.parapet) {
          // one course of the parapet style along each run of the roof edge (length-2 pieces where they fit)
          const roles = [`parapet.${layer.parapet}`, `wall.${layer.parapet}`];
          const bitten = new Set(st.ruin?.weather?.parapetBites ?? []);
          const edge = faceCells(topCells).filter((f) => {
            const [dx, dy] = STEP[f.face];
            return !foreign.has(key(f.x + dx, f.y + dy)) && !bitten.has(`${f.x},${f.y},${f.face}`);
          });
          for (const run of faceRunsOf(edge)) {
            let i = 0;
            while (i < run.length) {
              const f = run[i] as FaceCell;
              let placed = 1;
              for (const [role, len] of roles.flatMap((ro) => [2, 1].map((l) => [ro, l] as const))) {
                if (len > run.length - i) continue;
                const r = ctx.lookup(theme, [role], lenFilter(len), true);
                const pv = r
                  ? ctx.pick(r.variants, `${ctx.L.id}:${tag}:parapet:${f.x},${f.y}${f.face}`)
                  : undefined;
                if (!pv) continue;
                edgePiece(ctx, pv, "wall", f.x, f.y, f.face, len, base, `${tag}~parapet`, "roof");
                placed = len;
                break;
              }
              i += placed;
            }
          }
        }
        return;
      }
      case "none":
        return;
    }
  });
  return { top: roofTop, flat };
}

/**
 * Spire: a steep pointed roof over the top storey. The rings of a hip roof (eaves over the wall ring, the last ring
 * capped) are each laid twice, one tile above the other, so every ring rises two tiles per cell inward (a pitch
 * about twice the 45° of a plain hip): a pyramid about as tall as the crown is wide, then a tip piece
 * (roof.<kit>.tip, a slim pointed cap) and the finial or beacon on top. A ceiling closes the storey below.
 * (Owner, 2026-11-20: the earlier stack of shrinking wall boxes read as a pagoda, not a spire.) Returns the top.
 */
function buildSpire(
  ctx: StructureRealizeCtx,
  st: ResolvedStructure,
  theme: string,
  kit: string,
  _wallStyle: WallStyle,
  rect: Rect,
  base: number,
  _bands: number,
  tag: string,
): number {
  placeFloor(
    ctx,
    theme,
    [`roof.${kit}.deck`, "roof.default.deck", "floor.flagstone"],
    setOf(rectCellsOf(rect)),
    base - 0.5,
    `${tag}~ceiling`,
    "roof",
    "floor",
  );
  // a kit with tile-faced thin walls (roof.<kit>.shell) builds the spire as a steep hollow shell: courses two tiles
  // tall stepping in half a cell on every side (about 76°), a flared band of the kit's slopes round some courses, a
  // lid and the finial (the technique of the best community towers). The shell never falls back to wall pieces:
  // walls stacked into a spire read as a pagoda of boxes.
  const shellRole = ctx.lookup(theme, [`roof.${kit}.shell`], undefined, true);
  if (shellRole) {
    const shell = spireShell(
      // the first course stands half a cell inside the walls, its eave band over the wall line
      { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      { bands: Math.max(1, _bands) },
    );
    const strip = (x: number, y: number, face: Side, len: number, yb: number, yt: number): void => {
      let done = 0;
      while (done < len) {
        let placed = 0;
        for (const n of [2, 1]) {
          if (n > len - done) continue;
          const r = ctx.lookup(theme, [`roof.${kit}.shell`], lenFilter(n), true);
          const v = r
            ? ctx.pick(r.variants, `${ctx.L.id}:${tag}:spire:${x},${y},${face},${done}`)
            : undefined;
          if (!v) continue;
          const px = face === "N" || face === "S" ? x + done : x;
          const py = face === "N" || face === "S" ? y : y + done;
          const cnt = Math.max(1, Math.ceil((yt - yb) / v.unitHeight - EPS));
          for (let k = 0; k < cnt; k++)
            edgePiece(ctx, v, "wall", px, py, face, n, yb + k * v.unitHeight, `${tag}~spire`, "roof");
          placed = n;
          break;
        }
        if (placed === 0) return;
        done += placed;
      }
    };
    for (const c of shell.courses) {
      const yb = base + c.y;
      const w = c.x1 - c.x0;
      const h = c.y1 - c.y0;
      strip(c.x0, c.y0 + 0.5, "N", w, yb, yb + 2);
      strip(c.x0, c.y1 - 1.5, "S", w, yb, yb + 2);
      strip(c.x0 + 0.5, c.y0 + 0.5, "W", h - 1, yb, yb + 2);
      strip(c.x1 - 1.5, c.y0 + 0.5, "E", h - 1, yb, yb + 2);
      if (c.band || c.y === 0) {
        // a flared band of the kit's slopes just outside the course, at its foot (always at the eave)
        const x0 = Math.ceil(c.x0) - 1;
        const y0 = Math.ceil(c.y0) - 1;
        const ring = ringLayer(
          { x: x0, y: y0, w: Math.floor(c.x1) + 1 - x0, h: Math.floor(c.y1) + 1 - y0 },
          1,
          "slope",
          false,
        );
        for (const p of ring.pieces) placeRoofPiece(ctx, st, theme, kit, p, yb, tag);
      }
    }
    const tip = base + shell.top;
    const last = shell.courses[shell.courses.length - 1];
    if (last) {
      const lid: Rect = {
        x: Math.ceil(last.x0),
        y: Math.ceil(last.y0),
        w: Math.max(1, Math.floor(last.x1) - Math.ceil(last.x0)),
        h: Math.max(1, Math.floor(last.y1) - Math.ceil(last.y0)),
      };
      placeFloor(
        ctx,
        theme,
        [`roof.${kit}.flat`, `roof.${kit}.cap`, "floor.flagstone"],
        setOf(rectCellsOf(lid)),
        tip - 0.5,
        `${tag}~lid`,
        "roof",
        "floor",
      );
    }
    // a bartizan's little spire ends at its lid: a finial there would lean into the shaft beside it
    if (st.furniture?.finial !== false && !tag.includes("bartizan")) {
      const r = ctx.lookup(
        theme,
        [
          ...(st.design?.details.includes("beacon") ? ["magic_beacon.default"] : []),
          `roof.${kit}.finial`,
          "finial.default",
        ],
        undefined,
        true,
      );
      const v = r ? ctx.pick(r.variants, `${ctx.L.id}:${tag}:finial`) : undefined;
      if (v) placeProp(ctx, v, shell.finial.x, shell.finial.y, tip, 0, `${tag}~finial`, "roof");
    }
    return tip;
  }
  const g = hipRoof(rect);
  // slopes doubled: ring k fills base+2k .. base+2k+2; the ridge caps sit on the last ring's top (no gap under them)
  const slopeTop = Math.max(0, ...g.pieces.filter((p) => p.kind !== "cap").map((p) => 2 * p.course + 2));
  for (const p of g.pieces) {
    if (p.kind === "cap") {
      placeRoofPiece(ctx, st, theme, kit, p, base + slopeTop - p.course, tag);
      continue;
    }
    placeRoofPiece(ctx, st, theme, kit, p, base + p.course, tag);
    placeRoofPiece(ctx, st, theme, kit, p, base + p.course + 1, tag);
  }
  // (the ridge caps, a tile tall, finish the point above the last ring)
  let top = base + slopeTop + (g.pieces.some((p) => p.kind === "cap") ? 1 : 0);
  // the tip: a slim pointed piece on the middle cell(s)
  const cx = rect.x + Math.floor((rect.w - 1) / 2);
  const cy = rect.y + Math.floor((rect.h - 1) / 2);
  const tr = ctx.lookup(theme, [`roof.${kit}.tip`, "roof.default.tip"], undefined, true);
  const tv = tr ? ctx.pick(tr.variants, `${ctx.L.id}:${tag}:tip`) : undefined;
  if (tv) {
    const m = ctx.frame.rectMin(cx, cy, 1, 1);
    ctx.emit(tv, "wall", m.x, top - 1, m.z, tv.rot, { cell: [cx, cy], elementId: `${tag}~tip` }, "roof");
    top = top - 1 + tv.geom.size.y;
  }
  // a pointed tip is the spire's own finial: nothing balances on its point
  if (!tv && st.furniture?.finial !== false) {
    const r = ctx.lookup(
      theme,
      [
        ...(st.design?.details.includes("beacon") ? ["magic_beacon.default"] : []),
        `roof.${kit}.finial`,
        "finial.default",
      ],
      undefined,
      true,
    );
    const v = r ? ctx.pick(r.variants, `${ctx.L.id}:${tag}:finial`) : undefined;
    if (v) placeProp(ctx, v, cx + 0.5, cy + 0.5, top, 0, `${tag}~finial`, "roof");
  }
  return top;
}

/** A prop centred on a plan point at height y, with its palette assembly pieces (same anchor, rotated offsets). */
function placeProp(
  ctx: StructureRealizeCtx,
  v: ResolvedVariant,
  px: number,
  py: number,
  y: number,
  deg: number,
  sourceId: string,
  layer: string | undefined,
  role: PlacementRole = "feature",
): void {
  const c = ctx.frame.point(px, py);
  const src: Placement["source"] = { cell: [Math.floor(px), Math.floor(py)], elementId: sourceId };
  const one = (
    vv: ResolvedVariant,
    geom: ResolvedVariant["geom"],
    ox: number,
    oy: number,
    oz: number,
  ): void => {
    const o = rotateXZ(ox, oz, deg * ctx.frame.o.rotSense);
    if (geom.originAt === "minCorner") {
      const swap = Math.round(deg / 90) % 2 === 1;
      const hx = (swap ? geom.size.z : geom.size.x) / 2;
      const hz = (swap ? geom.size.x : geom.size.z) / 2;
      ctx.emit(vv, role, c.x + o.x - hx, y + oy, c.z + o.z - hz, deg + vv.rot, src, layer);
    } else {
      const off = rotateXZ(geom.boundsCenter.x, geom.boundsCenter.z, deg * ctx.frame.o.rotSense);
      ctx.emit(vv, role, c.x + o.x - off.x, y + oy, c.z + o.z - off.z, deg + vv.rot, src, layer);
    }
  };
  one(v, v.geom, 0, 0, 0);
  for (const part of v.parts ?? []) {
    const pv: ResolvedVariant = {
      ...v,
      uuid: part.asset,
      wanted: part.asset,
      geom: part.geom,
      name: part.name ?? v.name,
      offset: { x: 0, y: 0, z: 0 },
    };
    delete pv.parts;
    one(pv, part.geom, part.offset?.x ?? 0, v.offset.y + (part.offset?.y ?? 0), part.offset?.z ?? 0);
  }
}

/** A dormer piece in place of a 2×2 slope (only kits that have one: roof.<kit>.dormer). */
function placeDormer(
  ctx: StructureRealizeCtx,
  theme: string,
  kit: string,
  p: RoofPiece,
  base: number,
  tag: string,
): boolean {
  const r = ctx.lookup(
    theme,
    [`roof.${kit}.dormer`],
    { key: "2x2", test: (v) => v.footprint[0] === 2 && v.footprint[1] === 2 },
    true,
  );
  const v = r ? ctx.pick(r.variants, `${ctx.L.id}:${tag}:dormer:${p.x},${p.y}`) : undefined;
  if (!v || !r) return false;
  const front = ctx.facingOf(v, "roof", r.role).front ?? "N";
  const steps = ctx.frame.stepsToFace(front, ctx.frame.worldSide(p.eave));
  const m = ctx.frame.rectMin(p.x, p.y, 2, 2);
  ctx.emit(
    v,
    "wall",
    m.x,
    base + p.course,
    m.z,
    steps * 15 + v.rot,
    { cell: [p.x, p.y], elementId: `${tag}~dormer` },
    "roof",
  );
  return true;
}

/** Chimneys: a breast of blocks in the wall line, from the ground past the main roof, a pot on top. */
function buildChimneys(
  ctx: StructureRealizeCtx,
  st: ResolvedStructure,
  theme: string,
  roofTop: number,
): void {
  for (const c of st.chimneys) {
    const fs = st.storeys[0]?.footing?.style ?? st.storeys[0]?.walls ?? "stone";
    const r = ctx.lookup(
      theme,
      [`chimney.${fs}`, "chimney.default"],
      { key: "1x1", test: (v) => v.footprint[0] === 1 && v.footprint[1] === 1 },
      false,
    );
    const v = r ? ctx.pick(r.variants, `${ctx.L.id}:${st.id}:chimney`) : undefined;
    if (!v) continue;
    const m = ctx.frame.rectMin(c.at[0], c.at[1], 1, 1);
    const lo = Math.min(st.storeys[0]?.floorTop ?? 0, ctx.groundTop(c.at[0], c.at[1]));
    // generator 3: the stack tops out about a tile and a half above the ridge, pot included (it was two and a half), and
    // the foot is three wide for its first two courses (a breast, not a pole)
    // (the profile's `roofValleys` switch, carried on the building as ResolvedStructure.valleys)
    const chimneyBreast = st.valleys === true;
    const hi = roofTop + (chimneyBreast ? 0.5 : 1.5);
    const n = Math.max(1, Math.ceil((hi - lo) / v.unitHeight - EPS));
    if (chimneyBreast) {
      const [dx, dy] = STEP[c.side];
      const lat: Array<[number, number]> = [
        [c.at[0] + Math.abs(dy), c.at[1] + Math.abs(dx)],
        [c.at[0] - Math.abs(dy), c.at[1] - Math.abs(dx)],
      ];
      for (const [lx, ly] of lat) {
        if (st.cells.some(([x, y]) => x === lx && y === ly)) continue;
        const ml = ctx.frame.rectMin(lx, ly, 1, 1);
        const lowL = Math.min(st.storeys[0]?.floorTop ?? 0, ctx.groundTop(lx, ly));
        for (let k = 0; k < Math.min(2, n); k++)
          ctx.emit(
            v,
            "wall",
            ml.x,
            lowL + k * v.unitHeight,
            ml.z,
            v.rot,
            { cell: [lx, ly], elementId: `${st.id}~chimney` },
            "storey:0",
          );
      }
    }
    for (let k = 0; k < n; k++)
      ctx.emit(
        v,
        "wall",
        m.x,
        lo + k * v.unitHeight,
        m.z,
        v.rot,
        { cell: [c.at[0], c.at[1]], elementId: `${st.id}~chimney` },
        "storey:0",
      );
    const pr = ctx.lookup(theme, [`chimney_top.${fs}`, "chimney_top.default"], undefined, true);
    const pv = pr ? ctx.pick(pr.variants, `${ctx.L.id}:${st.id}:pot`) : undefined;
    if (pv)
      ctx.emit(
        pv,
        "wall",
        m.x,
        lo + n * v.unitHeight,
        m.z,
        pv.rot,
        { cell: [c.at[0], c.at[1]], elementId: `${st.id}~chimney` },
        "storey:0",
      );
  }
}

/** Porches: posts at the outer corners, a flat roof below the eave. */
function buildPorches(ctx: StructureRealizeCtx, st: ResolvedStructure, theme: string): void {
  const s0 = st.storeys[0];
  if (!s0) return;
  const kit = st.roof.style;
  const groundWallTop = s0.floorTop + s0.wallHeight;
  for (const [pi, p] of st.porches.entries()) {
    if (!p.roof) continue;
    const xs = p.cells.map((c) => c[0]);
    const ys = p.cells.map((c) => c[1]);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs) + 1;
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys) + 1;
    const roofY = Math.max(s0.floorTop + 2, groundWallTop - 1);
    // generator 3: an attached porch takes the building's condition: a ruin's hood has fallen (one post stands), a
    // weathered one has lost a third of its roof cells
    const worn = legiblyWorn(ctx, st);
    const gone = worn && st.condition === "ruined";
    const roofCells = gone
      ? []
      : worn
        ? p.cells.filter((_, i) => p.cells.length < 2 || h32Utf16(`${st.id}:porch${pi}:${i}`) % 3 !== 0)
        : p.cells;
    if (roofCells.length > 0)
      placeFloor(
        ctx,
        theme,
        [`roof.${kit}.flat`, `floor.${p.floor}`],
        setOf(roofCells),
        roofY,
        `${st.id}~porchroof${pi}`,
        "roof",
        "wall",
      );
    const style = s0.walls ?? "wood";
    const pr = ctx.lookup(
      theme,
      [`porch_post.${style}`, "porch_post.default", "feature.pillar"],
      undefined,
      false,
    );
    const pv = pr ? ctx.pick(pr.variants, `${ctx.L.id}:${st.id}:porchpost`) : undefined;
    if (!pv) continue;
    const outer: Array<[number, number]> =
      p.side === "S"
        ? [
            [x0 + 0.15, y1 - 0.15],
            [x1 - 0.15, y1 - 0.15],
          ]
        : p.side === "N"
          ? [
              [x0 + 0.15, y0 + 0.15],
              [x1 - 0.15, y0 + 0.15],
            ]
          : p.side === "E"
            ? [
                [x1 - 0.15, y0 + 0.15],
                [x1 - 0.15, y1 - 0.15],
              ]
            : [
                [x0 + 0.15, y0 + 0.15],
                [x0 + 0.15, y1 - 0.15],
              ];
    for (const [px, py] of gone ? outer.slice(0, 1) : outer) {
      const c = ctx.frame.point(px, py);
      const off =
        pv.geom.originAt === "minCorner"
          ? { x: pv.geom.size.x / 2, z: pv.geom.size.z / 2 }
          : rotateXZ(pv.geom.boundsCenter.x, pv.geom.boundsCenter.z, 0);
      const n = Math.max(1, Math.round((roofY - s0.floorTop) / Math.max(0.25, pv.unitHeight)));
      for (let k = 0; k < n; k++)
        ctx.emit(
          pv,
          "wall_post",
          c.x - off.x,
          s0.floorTop + k * pv.unitHeight,
          c.z - off.z,
          pv.rot,
          { cell: [Math.floor(px), Math.floor(py)], elementId: `${st.id}~porch${pi}` },
          "storey:0",
        );
    }
  }
}

/** A wall-mounted prop on the outside of face cell (x, y): `out` cells from the cell centre, `along` the face. */
function wallProp(
  ctx: StructureRealizeCtx,
  v: ResolvedVariant,
  role: string,
  x: number,
  y: number,
  side: Side,
  out: number,
  h: number,
  sourceId: string,
  layer: string,
  along = 0,
): void {
  const [dx, dy] = STEP[side];
  const along2 = side === "N" || side === "S" ? [along, 0] : [0, along];
  const px = x + 0.5 + dx * out + (along2[0] ?? 0);
  const py = y + 0.5 + dy * out + (along2[1] ?? 0);
  const c = ctx.frame.point(px, py);
  const f = ctx.facingOf(v, "feature", role);
  const wallDir = ctx.frame.worldSide(OPP[side]);
  const steps = ctx.frame.stepsToFace(f.mountsOn ?? "S", wallDir);
  const deg = steps * 15 + v.rot;
  const off =
    v.geom.originAt === "minCorner"
      ? { x: 0, z: 0 }
      : rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * ctx.frame.o.rotSense);
  ctx.emit(
    v,
    "wall_post",
    c.x - off.x,
    h,
    c.z - off.z,
    deg,
    { cell: [x + dx, y + dy], elementId: sourceId },
    layer,
  );
}

/** A light on the wall beside each door. */
function buildDoorLights(ctx: StructureRealizeCtx, st: ResolvedStructure, theme: string): void {
  const s0 = st.storeys[0];
  if (!s0) return;
  for (const lt of st.lights) {
    const style = s0.walls ?? "wood";
    const r = ctx.lookup(
      theme,
      [`wall_light.${style}`, "wall_light.default", "feature.torch_wall"],
      undefined,
      true,
    );
    const v = r ? ctx.pick(r.variants, `${ctx.L.id}:${st.id}:light:${lt.at[0]},${lt.at[1]}`) : undefined;
    if (!v || !r) continue;
    // centre 0.65 cells out from the edge line (0.15 outside the wall's outer face), 1.6 tiles up
    wallProp(
      ctx,
      v,
      r.role,
      lt.at[0],
      lt.at[1],
      lt.side,
      1.15,
      s0.floorTop + 1.6,
      `${st.id}~light`,
      "storey:0",
    );
  }
}

/** Lit windows: a warm room light or a coloured glow on the floor just inside a seeded share of the windows. */
function buildWindowLights(
  ctx: StructureRealizeCtx,
  st: ResolvedStructure,
  theme: string,
  windows: LitWindow[],
): void {
  const L = st.lighting;
  if (!L || L.windows === "none" || L.lit <= 0) return;
  for (const w of windows) {
    const roles =
      L.windows === "glow"
        ? [`light.glow.${L.colour}`, "light.glow", "feature.crystal"]
        : [`light.window.${w.walls}`, "light.window", "feature.candles"];
    const r = ctx.lookup(theme, roles, undefined, true);
    if (!r) continue;
    const k = `${st.id}:lit:${w.x},${w.y},${w.face},${w.floorTop}`;
    if (unit01(ctx, k) >= L.lit) continue;
    const v = ctx.pick(r.variants, `${ctx.L.id}:${k}`);
    if (!v) continue;
    // in the middle of the cell behind the window (clear of the wall, seen through the glass)
    placeProp(ctx, v, w.x + 0.5, w.y + 0.5, w.floorTop, (h32Utf16(k) % 4) * 90, `${st.id}~lit`, w.layer);
  }
}

/** Entrance strips: a pair of light strips flanking the main door. */
/** Footprint cell and face of one of the building's ground openings. */
function openingFace(
  st: ResolvedStructure,
  op: ResolvedLevel["openings"][number],
): { c: [number, number]; face: Side } {
  const cells = setOf(st.cells);
  const cellA: [number, number] =
    op.orientation === "h" ? [op.start[0], op.start[1] - 1] : [op.start[0] - 1, op.start[1]];
  const inA = cells.has(key(cellA[0], cellA[1]));
  return {
    c: inA ? cellA : [op.start[0], op.start[1]],
    face: op.orientation === "h" ? (inA ? "S" : "N") : inA ? "E" : "W",
  };
}

/** Shopfront: a sign band over each wide window of the ground storey's street face. */
function buildShopfront(ctx: StructureRealizeCtx, st: ResolvedStructure, theme: string): void {
  const s0 = st.storeys[0];
  const fr = st.frontage;
  if (!fr?.shopfront || !s0) return;
  const r = ctx.lookup(
    theme,
    [`sign_band.${s0.walls ?? THEME_WALL_STYLE}`, "feature.signage", "sign_band.default"],
    undefined,
    true,
  );
  if (!r) return;
  const top = s0.floorTop + (s0.footing?.height ?? 0) + 2;
  const windowed = openingTests(ctx.profile).window;
  for (const op of ctx.L.openings) {
    if (!st.openingIds.includes(op.id) || !windowed(op.kind)) continue;
    const { c, face } = openingFace(st, op);
    if (face !== fr.side) continue;
    const v = ctx.pick(r.variants, `${ctx.L.id}:${op.id}:sign`);
    if (v)
      wallProp(
        ctx,
        v,
        r.role,
        c[0],
        c[1],
        face,
        1.05,
        top + (st.design?.details.includes("canopy") ? 0.8 : 0.15), // above a canopy
        `${st.id}~sign`,
        "storey:0",
        (op.width - 1) / 2,
      );
  }
}

function buildEntranceStrips(ctx: StructureRealizeCtx, st: ResolvedStructure, theme: string): void {
  const s0 = st.storeys[0];
  if (!st.lighting?.strips || !s0) return;
  const doors = ctx.L.openings.filter((o) => st.openingIds.includes(o.id) && !isWindow(o.kind));
  // the entrance on the street face first
  const op = doors.find((o) => openingFace(st, o).face === st.frontage?.side) ?? doors[0];
  if (!op) return;
  const r = ctx.lookup(theme, ["light.strip"], undefined, true);
  if (!r) return;
  const { c, face } = openingFace(st, op);
  for (const along of [-0.55, op.width - 0.45]) {
    const v = ctx.pick(r.variants, `${ctx.L.id}:${st.id}:strip:${along}`);
    if (v)
      wallProp(
        ctx,
        v,
        r.role,
        c[0],
        c[1],
        face,
        1.05,
        s0.floorTop + 0.25,
        `${st.id}~strip`,
        "storey:0",
        along,
      );
  }
}

/** Flat roofs: a clutter field (edge band, equipment rows, storage) and a mast on the highest flat top. */
function buildRoofFurniture(
  ctx: StructureRealizeCtx,
  st: ResolvedStructure,
  theme: string,
  tops: FlatTop[],
): void {
  const F = st.furniture;
  if (!F || tops.length === 0) return;
  const high = [...tops].sort((a, b) => b.y - a.y)[0];
  const hutRing = new Set<string>();
  if (F.hut && high && high.walls && high.rect.w >= 5 && high.rect.h >= 5)
    buildRoofHut(ctx, st, theme, high, hutRing);
  let mastCell: string | null = null;
  if (F.mast && high) {
    const r = ctx.lookup(theme, ["mast.default"], undefined, true);
    const v = r ? ctx.pick(r.variants, `${ctx.L.id}:${st.id}:mast`) : undefined;
    if (v) {
      let mx = high.rect.x + Math.floor(high.rect.w / 2);
      let my = high.rect.y + Math.floor(high.rect.h / 2);
      if (hutRing.has(key(mx, my))) {
        // the hut is in one corner: the mast goes toward the opposite one
        const hx =
          hutRing.has(key(high.rect.x + 1, high.rect.y + 1)) ||
          hutRing.has(key(high.rect.x + 1, high.rect.y + high.rect.h - 2));
        mx = hx ? high.rect.x + high.rect.w - 2 : high.rect.x + 1;
        my = high.rect.y + high.rect.h - 2;
        if (hutRing.has(key(mx, my))) my = high.rect.y + 1;
      }
      mastCell = key(mx, my);
      placeProp(ctx, v, mx + 0.5, my + 0.5, high.y, 0, `${st.id}~mast`, "roof");
    }
  }
  if (st.design) {
    buildRooftopSets(
      ctx,
      st,
      theme,
      tops,
      new Set<string>([
        ...hutRing,
        ...(mastCell ? ringOf8(new Set([mastCell])) : []),
        ...(mastCell ? [mastCell] : []),
      ]),
    );
    return;
  }
  if (F.clutter <= 0) return;
  const taken = new Set<string>([...hutRing, ...(mastCell ? [mastCell] : [])]);
  for (const t of tops) {
    for (const k of [...t.cells].sort()) {
      if (taken.has(k)) continue;
      if (unit01(ctx, `${st.id}:clutter:${k}`) >= F.clutter) continue;
      const [x, y] = k.split(",").map(Number) as [number, number];
      const edge =
        !t.cells.has(key(x - 1, y)) ||
        !t.cells.has(key(x + 1, y)) ||
        !t.cells.has(key(x, y - 1)) ||
        !t.cells.has(key(x, y + 1));
      // the edge row stays clear: props there poke through the parapet and the wall below
      if (edge) continue;
      const natural = x === t.rect.x + 1 || x === t.rect.x + t.rect.w - 2 ? "equipment" : "storage";
      // a designed building keeps to its rooftop sets: a plant yard (vents and units), storage, or a terrace
      const allowed = rooftopFamilies(undefined);
      const family =
        !allowed || allowed.length === 0 || allowed.includes(natural) ? natural : (allowed[0] as string);
      const r = ctx.lookup(
        theme,
        family === "terrace"
          ? ["roof_clutter.terrace", "feature.flowers", "feature.bench"]
          : [`roof_clutter.${family}`, "roof_clutter.default"],
        undefined,
        true,
      );
      const v = r ? ctx.pick(r.variants, `${ctx.L.id}:${st.id}:clutter:${k}`) : undefined;
      if (!v) continue;
      // a prop wider than a cell needs a full cell of roof on every side (never over the parapet or the wall line)
      const reach = Math.max(v.footprint[0], v.footprint[1]) > 1 ? 2 : 1;
      let room = true;
      for (let dy = -reach; dy <= reach && room; dy++)
        for (let dx = -reach; dx <= reach && room; dx++) if (!t.cells.has(key(x + dx, y + dy))) room = false;
      if (!room) continue;
      // keep pieces a cell apart (overlapping props read as a heap)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) taken.add(key(x + dx, y + dy));
      // square to the building
      const deg = (h32Utf16(`${st.id}:${k}:r`) % 4) * 90;
      placeProp(ctx, v, x + 0.5, y + 0.5, t.y, deg, `${st.id}~clutter`, "roof");
    }
  }
}

/** Tiles over a cell set at y (bottom), greedy 2×2 then 1×1, from a role chain. */
function placeFloor(
  ctx: StructureRealizeCtx,
  theme: string,
  roles: string[],
  cells: ReadonlySet<string>,
  y: number,
  sourceId: string,
  layer: string,
  role: PlacementRole,
): void {
  const used = new Set<string>();
  const list = [...cells]
    .map((k) => k.split(",").map(Number) as [number, number])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  // the first role of the chain that has any piece supplies both sizes (a kit's own 1×1 beats another role's 2×2)
  const own = roles.find((r) => ctx.lookup(theme, [r], undefined, true) !== null);
  const chain = own ? [own] : roles;
  const big = ctx.lookup(
    theme,
    chain,
    { key: "2x2", test: (v) => v.footprint[0] === 2 && v.footprint[1] === 2 },
    true,
  );
  const small = ctx.lookup(
    theme,
    chain,
    { key: "1x1", test: (v) => v.footprint[0] === 1 && v.footprint[1] === 1 },
    true,
  );
  for (const [x, y0] of list) {
    if (used.has(key(x, y0))) continue;
    const quad = [key(x, y0), key(x + 1, y0), key(x, y0 + 1), key(x + 1, y0 + 1)];
    const bv = big ? ctx.pick(big.variants, `${ctx.L.id}:${sourceId}:${x},${y0}`) : undefined;
    if (bv && quad.every((k) => cells.has(k) && !used.has(k))) {
      quad.forEach((k) => used.add(k));
      const m = ctx.frame.rectMin(x, y0, 2, 2);
      ctx.emit(
        bv,
        role,
        m.x,
        y,
        m.z,
        bv.rot + (h32Utf16(`${ctx.seed}:${sourceId}:${x},${y0}`) % 4) * 90,
        { cell: [x, y0], elementId: sourceId },
        layer,
      );
      continue;
    }
    used.add(key(x, y0));
    const sv = small ? ctx.pick(small.variants, `${ctx.L.id}:${sourceId}:${x},${y0}`) : undefined;
    if (!sv) continue;
    const m = ctx.frame.rectMin(x, y0, 1, 1);
    ctx.emit(sv, role, m.x, y, m.z, sv.rot, { cell: [x, y0], elementId: sourceId }, layer);
  }
}

/** One roof piece: rotation from the kit's eave facing, position = min corner of the covered cells. */
function placeRoofPiece(
  ctx: StructureRealizeCtx,
  st: ResolvedStructure,
  theme: string,
  kit: string,
  p: RoofPiece,
  base: number,
  tag: string = st.id,
): void {
  const ring = p.kind !== "slope2" && p.kind !== "slope2x2"; // eaves rows and ridge stay intact
  const pkey = `${ctx.seed}:${st.id}:${p.x},${p.y}:${p.kind}`;
  // a weathered roof's fallen patch: the slope pieces above the eave course are gone, the deck or room shows
  if (st.condition === "weathered" && p.course > 0 && p.kind !== "cap" && st.ruin?.roofHoles) {
    const holes = st.ruin.roofHoles;
    if (holes.some(([x, y]) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h)) return;
  }
  const wantBroken = !ring && st.roof.broken > 0 && hashUnitUtf16(pkey, "broken") < st.roof.broken;
  const tryPlace = (
    kind: RoofPiece["kind"],
    x: number,
    y: number,
    w: number,
    h: number,
    course: number,
  ): boolean => {
    const role =
      kind === "cap"
        ? // a kit with no cap or flat piece (village) falls to the palette's default cap (an alias of the slate cap, generator
          // 4 only: the role is hidden from earlier generators), so the ridge row is never bare
          [`roof.${kit}.cap`, `roof.${kit}.flat`, "roof.default.cap"]
        : kind === "corner"
          ? [`roof.${kit}.corner`, `roof.${kit}.slope`]
          : kind === "step"
            ? [`roof.${kit}.step`, "roof.default.step", `roof.${kit}.slope`]
            : [`roof.${kit}.${kind}`];
    const fit: VariantFilter = {
      key: `${kind}${w}x${h}`,
      test: () => true,
    };
    let r = wantBroken ? ctx.lookup(theme, role, both(fit, brokenOnly), true) : null;
    if (!r || r.variants.length === 0) r = ctx.lookup(theme, role, both(fit, notBroken), true);
    if (!r) return false;
    const v = ctx.pick(r.variants, `${pkey}:${x},${y}`);
    if (!v) return false;
    if (kind === "cap") {
      const m = ctx.frame.rectMin(x, y, 1, 1);
      ctx.emit(
        v,
        "wall",
        m.x,
        base + course - v.geom.size.y,
        m.z,
        v.rot,
        { cell: [x, y], elementId: `${tag}~roof` },
        "roof",
      );
      return true;
    }
    const front = ctx.facingOf(v, "roof", r.role).front ?? "N";
    // a corner piece at rot 0 has its low sides N and W (front N): turn it clockwise onto its corner (UNVERIFIED)
    const toward: Side =
      r.role.endsWith(".corner") && p.corner
        ? ({ NW: "N", NE: "E", SE: "S", SW: "W" } as const)[p.corner]
        : p.eave;
    const steps = ctx.frame.stepsToFace(front, ctx.frame.worldSide(toward));
    const quarter = Math.round(steps / 6) % 2 === 1;
    const [fw, fh] = footOf(v);
    const rw = quarter ? fh : fw;
    const rh = quarter ? fw : fh;
    if (rw !== w || rh !== h) return false;
    const m = ctx.frame.rectMin(x, y, w, h);
    ctx.emit(
      v,
      "wall",
      m.x,
      base + course,
      m.z,
      steps * 15 + v.rot,
      { cell: [x, y], elementId: `${tag}~roof` },
      "roof",
    );
    return true;
  };
  if (tryPlace(p.kind, p.x, p.y, p.w, p.h, p.course)) return;
  // fallbacks: a 2×2 as two 1-wide run-2 pieces; a run-2 piece as two one-cell slopes
  const runAlongY = p.eave === "N" || p.eave === "S";
  if (p.kind === "slope2x2") {
    const halves: Array<[number, number, number, number]> = runAlongY
      ? [
          [p.x, p.y, 1, 2],
          [p.x + 1, p.y, 1, 2],
        ]
      : [
          [p.x, p.y, 2, 1],
          [p.x, p.y + 1, 2, 1],
        ];
    for (const [x, y, w, h] of halves) if (!tryPlace("slope2", x, y, w, h, p.course)) singles(x, y, w, h);
    return;
  }
  if (p.kind === "slope2") singles(p.x, p.y, p.w, p.h);
  else ctx.info("role_missing", `No roof.${kit}.${p.kind} piece for ${st.id}`, `roof.${kit}.${p.kind}`);

  function singles(x: number, y: number, w: number, h: number): void {
    // the cell nearer the eave sits at the piece's course, the other one course higher
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        const nearEave =
          p.eave === "N"
            ? yy === y
            : p.eave === "S"
              ? yy === y + h - 1
              : p.eave === "W"
                ? xx === x
                : xx === x + w - 1;
        if (!tryPlace("slope", xx, yy, 1, 1, p.course + (nearEave ? 0 : 1)))
          ctx.info("role_missing", `No roof.${kit}.slope piece for ${st.id}`, `roof.${kit}.slope`);
      }
  }
}

// ───────────────────────────── enclosures ─────────────────────────────

function buildEnclosure(ctx: StructureRealizeCtx, st: ResolvedStructure): void {
  const fence = st.fence?.style ?? null;
  if (!fence) return;
  const cells = new Set(st.cells.map(([x, y]) => key(x, y)));
  for (const g of st.fence?.gates ?? []) {
    const o = ctx.L.openings.find((op) => op.id.startsWith(`${st.id}~gate`) && sameEdge(op, g.at, g.side));
    const width = o?.width ?? 1;
    const r =
      ctx.lookup(st.theme, [`gate.${fence}`, `opening.door.${fence}`], lenFilter(width), true) ??
      ctx.lookup(st.theme, [`gate.${fence}`, `opening.door.${fence}`], lenFilter(1), true);
    const v = r ? ctx.pick(r.variants, `${ctx.L.id}:${st.id}:gate:${g.at[0]},${g.at[1]}`) : undefined;
    if (!v || !r) {
      ctx.info(
        "role_missing",
        `No gate piece for a ${fence} fence; ${st.id} has an open gateway`,
        `gate.${fence}`,
      );
      continue;
    }
    const len = lengthOf(v);
    const n = Math.max(1, Math.floor(width / len));
    for (let k = 0; k < n; k++) {
      const x = g.side === "N" || g.side === "S" ? g.at[0] + k * len : g.at[0];
      const y = g.side === "N" || g.side === "S" ? g.at[1] : g.at[1] + k * len;
      if (!cells.has(key(x, y))) continue;
      if ((r.def.mount ?? "half-cell") === "edge-center") {
        const along =
          g.side === "N" || g.side === "S"
            ? { x: x + len / 2, y: g.side === "N" ? y : y + 1 }
            : { x: g.side === "W" ? x : x + 1, y: y + len / 2 };
        const c = ctx.frame.point(along.x, along.y);
        const runsEW = g.side === "N" || g.side === "S";
        const axisFix = v.geom.lengthAxis === "z" ? 6 : 0;
        const steps = ((runsEW ? 0 : ctx.frame.stepsForQuarters(1)) + axisFix) % 24;
        const deg = steps * 15 + v.rot;
        const off =
          v.geom.originAt === "minCorner"
            ? { x: 0, z: 0 }
            : rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * ctx.frame.o.rotSense);
        ctx.emit(v, "opening", c.x - off.x, ctx.groundTop(x, y), c.z - off.z, deg, {
          cell: [x, y],
          elementId: o?.id ?? st.id,
        });
      } else
        edgePiece(
          ctx,
          v,
          "opening",
          x,
          y,
          g.side,
          len,
          ctx.groundTop(x, y),
          o?.id ?? st.id,
          undefined,
          ctx.facingOf(v, "opening", r.role),
        );
    }
  }
}

function sameEdge(o: ResolvedLevel["openings"][number], at: readonly [number, number], side: Side): boolean {
  if (side === "N") return o.orientation === "h" && o.start[0] === at[0] && o.start[1] === at[1];
  if (side === "S") return o.orientation === "h" && o.start[0] === at[0] && o.start[1] === at[1] + 1;
  if (side === "W") return o.orientation === "v" && o.start[0] === at[0] && o.start[1] === at[1];
  return o.orientation === "v" && o.start[0] === at[0] + 1 && o.start[1] === at[1];
}

/** Shell edges and structure openings realize must leave to this module. */
export function structureClaims(L: ResolvedLevel): {
  edges: Set<string>;
  openings: Set<string>;
  /** Shell edges of ruined buildings: their walls may break off a tile above the floor. */
  ruined: Set<string>;
} {
  const edges = new Set<string>();
  const ruined = new Set<string>();
  const openings = new Set<string>();
  for (const st of L.structures ?? []) {
    for (const id of st.openingIds) openings.add(id);
    if (st.kind !== "building") continue;
    const cells = new Set(st.cells.map(([x, y]) => key(x, y)));
    const out = st.condition === "ruined" ? ruined : null;
    for (const [x, y] of st.cells) {
      const lx = x - L.bounds.x;
      const ly = y - L.bounds.y;
      for (const face of SIDES) {
        const [dx, dy] = STEP[face];
        if (cells.has(key(x + dx, y + dy))) continue;
        const e = `${sideOrient(face)}${sideEdgeIndex(L.bounds, lx, ly, face)}`;
        edges.add(e);
        out?.add(e);
      }
    }
  }
  return { edges, openings, ruined };
}

export type { WallStyle };

/**
 * A roof access hut on a flat top: a 2×2 (or 2×1 on a narrow roof) box of the storey's walls in a corner the seed
 * picks, a door facing into the roof, a flat roof of the kit. Its cells and their ring are added to `ring` so the
 * mast and the clutter keep off it.
 */
function buildRoofHut(
  ctx: StructureRealizeCtx,
  st: ResolvedStructure,
  theme: string,
  t: FlatTop,
  ring: Set<string>,
): void {
  const walls = t.walls ?? THEME_WALL_STYLE;
  const r = t.rect;
  const w = r.w >= 8 ? 3 : 2; // a bigger stair hut on a big roof
  const h = r.h >= 6 ? 2 : 1;
  const corner = h32Utf16(`${ctx.seed}:${st.id}:hut`) % 4;
  const x0 = corner % 2 === 0 ? r.x + 1 : r.x + r.w - 1 - w;
  const y0 = corner < 2 ? r.y + 1 : r.y + r.h - 1 - h;
  const cells = new Set<string>();
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) cells.add(key(x, y));
  if ([...cells].some((k) => !t.cells.has(k))) return;
  for (const k of cells) ring.add(k);
  for (const k of ringOf8(cells)) ring.add(k);
  const tag = `${st.id}~hut`;
  // the door faces the middle of the roof
  const doorFace: Side = corner < 2 ? "S" : "N";
  const doorCell = key(corner % 2 === 0 ? x0 + w - 1 : x0, doorFace === "S" ? y0 + h - 1 : y0);
  const wallTop = t.y + 2;
  for (const f of faceCells(cells)) {
    if (key(f.x, f.y) === doorCell && f.face === doorFace) {
      const dr = ctx.lookup(
        theme,
        ["opening.door.works", `opening.door.${walls}`, "opening.door"],
        lenFilter(1),
        true,
      );
      const dv = dr ? ctx.pick(dr.variants, `${ctx.L.id}:${tag}:door`) : undefined;
      if (dv && dr) {
        edgePiece(
          ctx,
          dv,
          "opening",
          f.x,
          f.y,
          f.face,
          1,
          t.y,
          tag,
          "roof",
          ctx.facingOf(dv, "opening", dr.role),
        );
        continue;
      }
    }
    stackEdge(
      ctx,
      theme,
      [`facade.${walls}`, wallRole(walls), THEME_WALL_ROLE],
      "wall",
      f.x,
      f.y,
      f.face,
      t.y,
      wallTop,
      tag,
      "roof",
    );
  }
  placeFloor(
    ctx,
    theme,
    [`roof.${t.kit}.flat`, "floor.stone_tile"],
    cells,
    wallTop,
    `${tag}~roof`,
    "roof",
    "floor",
  );
}

/** The cells round a set, diagonals included. */
function ringOf8(cells: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (!cells.has(key(x + dx, y + dy))) out.add(key(x + dx, y + dy));
  }
  return out;
}

/** Clutter families of a design's rooftop sets (undefined = no design: every family). */
function rooftopFamilies(sets: readonly string[] | undefined): string[] | undefined {
  if (!sets) return undefined;
  const out: string[] = [];
  if (sets.includes("plant")) out.push("equipment", "edge");
  if (sets.includes("storage")) out.push("storage");
  if (sets.includes("terrace")) out.push("terrace");
  return out;
}

/**
 * Facade details of a designed building (its design's `details`): corner piers, a canopy over the street front,
 * balconies at the front windows above the ground, a fire escape on a side face, and service pipes and units on the
 * back (so backs are not blank). Faces against another building get none.
 */
function buildDetails(
  ctx: StructureRealizeCtx,
  st: ResolvedStructure,
  theme: string,
  vols: ResolvedVolume[],
  foreign: ReadonlySet<string>,
): void {
  const d = st.design;
  const s0 = st.storeys[0];
  if (!d || d.details.length === 0 || !s0) return;
  const front = st.frontage?.side ?? "S";
  const cells = setOf(st.cells);
  const walls = s0.walls ?? THEME_WALL_STYLE;
  const free = (f: FaceCell): boolean => {
    const [dx, dy] = STEP[f.face];
    return !foreign.has(key(f.x + dx, f.y + dy));
  };
  const faces = faceCells(cells).filter(free);
  /** Highest wall top over a ground cell (its volume's tallest storey that still covers it). */
  const topAt = (x: number, y: number): number => {
    let t = s0.floorTop + s0.wallHeight;
    for (const v of vols)
      for (const sp of v.storeys)
        if (sp.cells.some((c) => c[0] === x && c[1] === y)) t = Math.max(t, sp.wallTop);
    return t;
  };
  const tag = (k: string): string => `${st.id}~${k}`;
  // a ruin keeps only what grows on it: balconies, banners, turrets and services fell with the rest
  for (const detail of st.condition === "ruined" ? d.details.filter((x) => x === "vines") : d.details) {
    if (detail === "piers") {
      const r = ctx.lookup(theme, [`corner_pier.${walls}`, "corner_pier.default"], undefined, true);
      const v = r ? ctx.pick(r.variants, `${ctx.L.id}:${st.id}:pier`) : undefined;
      if (!v) continue;
      for (const k of cells) {
        const [cx, cy] = k.split(",").map(Number) as [number, number];
        for (const [dx, dy] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ] as const) {
          if (cells.has(key(cx + dx, cy)) || cells.has(key(cx, cy + dy)) || cells.has(key(cx + dx, cy + dy)))
            continue;
          if (foreign.has(key(cx + dx, cy)) || foreign.has(key(cx, cy + dy))) continue;
          // centred on the corner of the two wall lines, standing proud of both faces
          const px = (dx < 0 ? cx - 0.25 : cx + 1.25) - 0.5;
          const py = (dy < 0 ? cy - 0.25 : cy + 1.25) - 0.5;
          const m = ctx.frame.rectMin(px, py, 1, 1);
          const lo = Math.min(s0.floorTop, ctx.groundTop(cx + dx, cy + dy));
          const hi = topAt(cx, cy);
          const n = Math.max(1, Math.ceil((hi - lo) / v.unitHeight - EPS));
          for (let j = 0; j < n; j++)
            ctx.emit(
              v,
              "wall_post",
              m.x,
              hi - (n - j) * v.unitHeight,
              m.z,
              v.rot,
              { cell: [cx + dx, cy + dy], elementId: tag("pier") },
              "storey:0",
            );
        }
      }
    } else if (detail === "canopy" || detail === "awning") {
      // a slab two cells deep over the street front, above the doors and shop windows (generator 3 cottages: an
      // awning of tent-cloth roof pieces, one cell deep, over the whole front)
      const awning = detail === "awning";
      const run = faces.filter((f) => f.face === front);
      const [dx, dy] = STEP[front];
      const along = (f: FaceCell): number => (front === "N" || front === "S" ? f.x : f.y);
      const lo = Math.min(...run.map(along));
      const hi = Math.max(...run.map(along));
      const slab = new Set<string>();
      for (const f of run) {
        if (!awning && (along(f) === lo || along(f) === hi)) continue;
        for (const k of awning ? [1] : [1, 2]) {
          const c = key(f.x + dx * k, f.y + dy * k);
          if (!cells.has(c) && !foreign.has(c)) slab.add(c);
        }
      }
      const y = s0.floorTop + (awning ? 2 : (s0.footing?.height ?? 0) + 2.25);
      placeFloor(
        ctx,
        theme,
        awning
          ? ["canopy.awning"]
          : [`canopy.${walls}`, "canopy.default", "roof.city.flat", "floor.stone_tile"],
        slab,
        y,
        tag("canopy"),
        "storey:0",
        "floor",
      );
    } else if (detail === "balconies") {
      const [dx, dy] = STEP[front];
      const windowed = openingTests(ctx.profile).window;
      for (const u of st.upperOpenings) {
        if (u.side !== front || !windowed(u.kind)) continue;
        const v = vols.find((vv) => vv.id === u.volume) ?? vols[0];
        const sp = v?.storeys[u.storey];
        if (!sp) continue;
        for (let k = 0; k < u.width; k++) {
          const fx = front === "N" || front === "S" ? u.at[0] + k : u.at[0];
          const fy = front === "N" || front === "S" ? u.at[1] : u.at[1] + k;
          const c = key(fx + dx, fy + dy);
          if (foreign.has(c)) continue;
          placeFloor(
            ctx,
            theme,
            ["balcony.default", "roof.city.flat", "floor.stone_tile"],
            new Set([c]),
            sp.floorTop - 0.5,
            tag("balcony"),
            `storey:${u.storey}`,
            "floor",
          );
          stackEdge(
            ctx,
            theme,
            ["balcony_rail.default"],
            "wall",
            fx + dx,
            fy + dy,
            front,
            sp.floorTop,
            sp.floorTop + 1,
            tag("balcony"),
            `storey:${u.storey}`,
          );
        }
      }
    } else if (detail === "fire_escape") {
      const r = ctx.lookup(theme, ["fire_escape.default"], undefined, true);
      const v = r ? ctx.pick(r.variants, `${ctx.L.id}:${st.id}:fire`) : undefined;
      if (!v || !r) continue;
      const sides: Side[] = front === "N" || front === "S" ? ["E", "W"] : ["N", "S"];
      let best: FaceCell[] = [];
      for (const side of sides)
        for (const run of faceRunsOf(faces.filter((f) => f.face === side)))
          if (run.length > best.length) best = run;
      if (best.length < 3) continue;
      const m = best[Math.floor(best.length / 2)] as FaceCell;
      const [dx, dy] = STEP[m.face];
      // three cells along, three out (the unit and a cell of air): clear of every other building and its wall ring
      let clear = true;
      for (let a = -1; a <= 1 && clear; a++)
        for (let o = 1; o <= 3 && clear; o++) {
          const x = m.x + dx * o + (dx === 0 ? a : 0);
          const y = m.y + dy * o + (dy === 0 ? a : 0);
          for (let ey = -1; ey <= 1 && clear; ey++)
            for (let ex = -1; ex <= 1 && clear; ex++) if (foreign.has(key(x + ex, y + ey))) clear = false;
          if (cells.has(key(x, y))) clear = false;
        }
      if (!clear) continue;
      // the unit's long axis (x, three cells) runs along the face, its two cells of depth out from the wall
      // (which of the two long sides faces the wall is UNVERIFIED in game)
      const deg = m.face === "N" ? 0 : m.face === "S" ? 180 : m.face === "E" ? 90 : 270;
      const main =
        vols.find((vv) => vv.storeys[0]?.cells.some((c) => c[0] === m.x && c[1] === m.y)) ?? vols[0];
      for (const [s, sp] of (main?.storeys ?? []).entries()) {
        if (s === 0 || !sp.cells.some((c) => c[0] === m.x && c[1] === m.y)) continue;
        placeProp(
          ctx,
          v,
          m.x + 0.5 + dx * 2.1,
          m.y + 0.5 + dy * 2.1,
          sp.floorTop - 0.5,
          deg,
          tag("fire_escape"),
          `storey:${s}`,
          "wall",
        );
      }
    } else if (detail === "banners" || detail === "balcony") {
      // on the main shaft: banners on the front face two thirds up; a balcony ring round a storey there
      const stack = vols.filter((v) => v.id !== "turret" && v.id !== "crown");
      const pick = stack[Math.max(1, Math.round(stack.length * 0.6))] ?? stack[stack.length - 1];
      const sp = pick?.storeys[0];
      if (!pick || !sp) continue;
      const own = setOf(sp.cells);
      if (detail === "banners") {
        const r = ctx.lookup(theme, ["feature.banner_wall"], undefined, true);
        const run = faceRunsOf(faceCells(own).filter((ff) => ff.face === front))[0];
        if (!r || !run || run.length < 3) continue;
        for (const ff of [run[0], run[run.length - 1]] as FaceCell[]) {
          const v = ctx.pick(r.variants, `${ctx.L.id}:${st.id}:banner:${ff.x},${ff.y}`);
          if (v)
            wallProp(ctx, v, r.role, ff.x, ff.y, front, 1.05, sp.floorTop + 0.5, tag("banner"), "storey:0");
        }
      } else {
        // a ring of floor a cell wide outside the walls, a railing on its outer edge
        const ring = new Set<string>();
        for (const k of own) {
          const [x, y] = k.split(",").map(Number) as [number, number];
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1],
          ] as const)
            if (!own.has(key(x + dx, y + dy)) && !foreign.has(key(x + dx, y + dy)))
              ring.add(key(x + dx, y + dy));
        }
        placeFloor(
          ctx,
          theme,
          [`floor.${sp.floor}`, "floor.flagstone"],
          ring,
          sp.floorTop - 0.5,
          tag("balcony"),
          "storey:0",
          "floor",
        );
        for (const ff of faceCells(new Set([...own, ...ring])))
          if (ring.has(key(ff.x, ff.y)))
            stackEdge(
              ctx,
              theme,
              ["wall.railing_stone", "wall.railing"],
              "wall",
              ff.x,
              ff.y,
              ff.face,
              sp.floorTop,
              sp.floorTop + 1,
              tag("balcony"),
              "storey:0",
            );
      }
    } else if (detail === "vines") {
      // growth climbing the base on two faces
      const r = ctx.lookup(theme, ["ruin_growth.default"], undefined, true);
      if (!r) continue;
      // never in front of a doorway: its cell and the cells beside it stay clear
      const doorCells = new Set<string>();
      const doorway = openingTests(ctx.profile).doorway;
      for (const op of ctx.L.openings) {
        if (!st.openingIds.includes(op.id) || !doorway(op.kind)) continue;
        const { c, face } = openingFace(st, op);
        const along = face === "N" || face === "S" ? [1, 0] : [0, 1];
        for (let k = -1; k <= op.width; k++)
          doorCells.add(`${c[0] + (along[0] ?? 0) * k},${c[1] + (along[1] ?? 0) * k},${face}`);
      }
      for (const ff of faces) {
        if (doorCells.has(`${ff.x},${ff.y},${ff.face}`)) continue;
        if (h32Utf16(`${st.id}:vine:${ff.x},${ff.y}${ff.face}`) % 4 !== 0) continue;
        const v = ctx.pick(r.variants, `${ctx.L.id}:${st.id}:vine:${ff.x},${ff.y}`);
        const [dx, dy] = STEP[ff.face];
        if (v)
          placeProp(
            ctx,
            v,
            ff.x + 0.5 + dx * 2,
            ff.y + 0.5 + dy * 2,
            ctx.groundTop(ff.x + dx * 2, ff.y + dy * 2),
            0,
            tag("vines"),
            undefined,
          );
      }
    } else if (detail === "services") {
      const back = OPP[front];
      const run = faceRunsOf(faces.filter((f) => f.face === back)).sort((a, b) => b.length - a.length)[0];
      if (!run || run.length < 2) continue;
      const pr = ctx.lookup(theme, ["wall_pipe.default"], undefined, true);
      const pv = pr ? ctx.pick(pr.variants, `${ctx.L.id}:${st.id}:pipe`) : undefined;
      if (pv && pr)
        for (const f of [run[0], run[run.length - 1]] as FaceCell[]) {
          const hi = topAt(f.x, f.y);
          for (let yy = s0.floorTop; yy + pv.geom.size.y <= hi + 0.3; yy += pv.geom.size.y)
            wallProp(ctx, pv, pr.role, f.x, f.y, back, 1.15, yy, tag("pipe"), "storey:0", 0);
        }
      const ur = ctx.lookup(theme, ["wall_unit.default"], undefined, true);
      const uv = ur ? ctx.pick(ur.variants, `${ctx.L.id}:${st.id}:unit`) : undefined;
      const mid = run[Math.floor(run.length / 2)];
      if (uv && ur && mid)
        wallProp(
          ctx,
          uv,
          ur.role,
          mid.x,
          mid.y,
          back,
          1.0 + uv.geom.size.z / 2,
          s0.floorTop + 0.1,
          tag("unit"),
          "storey:0",
        );
    }
  }
}

/**
 * A designed building's rooftop sets, grouped and scaled to the roof (a GM mostly sees roofs from above): a plant
 * yard (a block of units filling every cell), a terrace (a deck of lighter tiles with seating and a lamp), storage
 * (a few pieces in a corner). Each set takes a block in a different corner of the largest flat top, a cell in from
 * the parapet, never on the hut or the mast.
 */
function buildRooftopSets(
  ctx: StructureRealizeCtx,
  st: ResolvedStructure,
  theme: string,
  tops: FlatTop[],
  taken: Set<string>,
): void {
  const sets = (st.design?.rooftop ?? []).filter((s) => s === "plant" || s === "terrace" || s === "storage");
  if (sets.length === 0) return;
  const t = [...tops].sort((a, b) => b.cells.size - a.cells.size)[0];
  if (!t) return;
  const area = t.cells.size;
  const inner = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (!t.cells.has(key(x + dx, y + dy))) return false;
    return true;
  };
  /** The first free block of w×h inner cells, scanning from a corner. */
  const block = (w: number, h: number, corner: number): Array<[number, number]> | null => {
    const r = t.rect;
    const xs = Array.from({ length: r.w }, (_, i) => r.x + i);
    const ys = Array.from({ length: r.h }, (_, i) => r.y + i);
    if (corner & 1) xs.reverse();
    if (corner & 2) ys.reverse();
    for (const y0 of ys)
      for (const x0 of xs) {
        const cells: Array<[number, number]> = [];
        let ok = true;
        for (let dy = 0; dy < h && ok; dy++)
          for (let dx = 0; dx < w && ok; dx++) {
            const x = corner & 1 ? x0 - dx : x0 + dx;
            const y = corner & 2 ? y0 - dy : y0 + dy;
            if (!inner(x, y) || taken.has(key(x, y))) ok = false;
            else cells.push([x, y]);
          }
        if (ok) return cells;
      }
    return null;
  };
  const one = (
    roles: string[],
    filter: VariantFilter | undefined,
    k: string,
  ): ResolvedVariant | undefined => {
    const r = ctx.lookup(theme, roles, filter, true);
    return r ? ctx.pick(r.variants, `${ctx.L.id}:${st.id}:${k}`) : undefined;
  };
  const small: VariantFilter = { key: "1x1", test: (v) => v.footprint[0] <= 1 && v.footprint[1] <= 1 };
  // the size of a set follows the roof: a quarter of a big roof, a few cells of a small one
  const side = Math.max(2, Math.min(5, Math.round(Math.sqrt(area) / 2)));
  sets.forEach((set, si) => {
    const corner = (h32Utf16(`${ctx.seed}:${st.id}:set${si}`) + si * 3) % 4;
    const cells = block(set === "storage" ? 2 : side, set === "storage" ? 1 : Math.max(2, side - 1), corner);
    if (!cells) return;
    for (const [x, y] of cells)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) taken.add(key(x + dx, y + dy));
    const tag = `${st.id}~${set}`;
    if (set === "terrace") {
      placeFloor(
        ctx,
        theme,
        ["roof_terrace.default", "roof.durable.flat"],
        setOf(cells),
        t.y,
        tag,
        "roof",
        "floor",
      );
      const seats = [cells[0], cells[cells.length - 1]];
      for (const [i, c] of seats.entries()) {
        const v = c ? one(["feature.seating", "feature.bench"], undefined, `seat${i}`) : undefined;
        if (v && c)
          placeProp(
            ctx,
            v,
            c[0] + 0.5,
            c[1] + 0.5,
            t.y + 0.5,
            (h32Utf16(`${st.id}:seat${i}`) % 4) * 90,
            tag,
            "roof",
          );
      }
      const mid = cells[Math.floor(cells.length / 2)];
      const lamp = mid
        ? one([`light.window.${t.walls ?? "brick"}`, "light.window"], undefined, "terrace-lamp")
        : undefined;
      if (lamp && mid) placeProp(ctx, lamp, mid[0] + 0.5, mid[1] + 0.5, t.y + 0.5, 0, tag, "roof");
      return;
    }
    const family = set === "plant" ? "equipment" : "storage";
    for (const [x, y] of cells) {
      const v = one([`roof_clutter.${family}`], small, `${set}:${x},${y}`);
      if (v) placeProp(ctx, v, x + 0.5, y + 0.5, t.y, (h32Utf16(`${st.id}:${x},${y}`) % 2) * 90, tag, "roof");
    }
  });
}

/** Rubble and growth at the foot of a weathered or ruined building (roles the dressing engineer can fill). */
function buildDebris(ctx: StructureRealizeCtx, st: ResolvedStructure, theme: string): void {
  for (const d of st.debris ?? []) {
    // a theme without the role gets nothing: never a wrong object
    const walls = st.design?.material ?? st.storeys[0]?.walls;
    const timber = legiblyWorn(ctx, st) && isPlankWallStyle(walls);
    // (generator 3: fallen stone does not lie beside a timber building; its own material or nothing)
    const roles = [
      d.kind === "rubble"
        ? timber
          ? `ruin_rubble.${walls}`
          : "ruin_rubble.default"
        : d.kind === "prop"
          ? "ruin_prop.default"
          : "ruin_growth.default",
    ];
    const r = ctx.lookup(theme, roles, undefined, true);
    const k = `${st.id}:debris:${d.at[0]},${d.at[1]}`;
    // a heap wider than a cell and a half would lean into the walls beside it: smaller pieces when the role has them
    const small = r ? r.variants.filter((x) => Math.max(x.geom.size.x, x.geom.size.z) <= 1.6) : [];
    const v = r ? ctx.pick(small.length ? small : r.variants, `${ctx.L.id}:${k}`) : undefined;
    if (v)
      placeProp(
        ctx,
        v,
        d.at[0] + 0.5,
        d.at[1] + 0.5,
        ctx.groundTop(d.at[0], d.at[1]),
        // generator 3: heaps lie at their own angles, not square to the grid
        legiblyWorn(ctx, st) ? (h32Utf16(k) % 24) * 15 : (h32Utf16(k) % 4) * 90,
        `${st.id}~${d.kind}`,
        undefined,
      );
  }
}

/**
 * Broken blocks and small rubble lying on the cut tops of a ruin's walls (generator 3; the resolver chose the
 * columns). A block takes the wall style's own `ruin_block.<style>`, then `ruin_block.default`, a heap
 * `ruin_rubble.default`; a theme without the role gets nothing. Pieces no wider than a wall are preferred, set on the
 * wall's strip at the cut height.
 */
function buildWallTopRubble(ctx: StructureRealizeCtx, st: ResolvedStructure, theme: string): void {
  const list = st.ruin?.topRubble;
  if (!list || list.length === 0) return;
  const style = st.design?.material ?? st.storeys[0]?.walls ?? "stone";
  // never a neat whole block seated square on a step (the pale 1x1 stair block read as coping stones in game): wall-top
  // material is broken stuff, rubble heaps of mixed sizes (a long pile now and then) and block pieces only when the
  // role has small broken ones (a brick pile), each turned at its own angle along the wall
  // timber walls (generator 3): what lies on a timber wall is timber (fallen beams, planks): the wall material's own
  // role, and nothing when the palette has none, never grey stone blocks on brown planks
  const timber = legiblyWorn(ctx, st) && isPlankWallStyle(style);
  const blockRole = ctx.lookup(
    theme,
    timber ? [`ruin_block.${style}`] : [`ruin_block.${style}`, "ruin_block.default"],
    undefined,
    true,
  );
  const heapRole = ctx.lookup(
    theme,
    timber ? [`ruin_rubble.${style}`] : ["ruin_rubble.default"],
    undefined,
    true,
  );
  const longest = (x: ResolvedVariant): number => Math.max(x.geom.size.x, x.geom.size.z);
  const smallBroken = [
    ...(heapRole?.variants.filter((x) => longest(x) <= 1.1) ?? []),
    ...(blockRole?.variants.filter((x) => longest(x) <= 0.8) ?? []),
  ];
  // a long pile only across three neighbouring rubble columns of one wall (it never reaches over an opening)
  const longPile = heapRole?.variants.filter((x) => longest(x) > 1.1 && longest(x) <= 1.7) ?? [];
  const listed = new Set(list.map((t) => `${t.at[0]},${t.at[1]},${t.side}`));
  if (smallBroken.length === 0) return;
  const legibleCondition = legiblyWorn(ctx, st);
  for (const t of list) {
    const k = `${st.id}:walltop:${t.at[0]},${t.at[1]}${t.side}`;
    const [ax, ay] = t.side === "N" || t.side === "S" ? [1, 0] : [0, 1];
    const spans =
      legibleCondition &&
      longPile.length > 0 &&
      listed.has(`${t.at[0] - ax},${t.at[1] - ay},${t.side}`) &&
      listed.has(`${t.at[0] + ax},${t.at[1] + ay},${t.side}`) &&
      h32Utf16(`${k}:long`) % 2 === 0;
    const v = ctx.pick(spans ? longPile : smallBroken, `${ctx.L.id}:${k}`);
    if (!v) continue;
    const [dx, dy] = STEP[t.side];
    const jit = (s: string): number => hashUnitUtf16(ctx.seed, k, s) - 0.5;
    // along the wall (a long pile lies lengthwise), 15 degree steps of yaw either side, never square to the step
    const base = (t.side === "N" || t.side === "S" ? 0 : 90) + (h32Utf16(`${k}:flip`) % 2) * 180;
    const yaw = legibleCondition ? base + Math.round(jit("yaw") * 6) * 15 : (h32Utf16(k) % 4) * 90;
    const [ux, uy] = t.side === "N" || t.side === "S" ? [1, 0] : [0, 1];
    placeProp(
      ctx,
      v,
      t.at[0] +
        0.5 +
        dx * (0.75 + (legibleCondition ? jit("out") * 0.2 : 0)) +
        (legibleCondition ? ux * jit("al") * 0.3 : 0), // the wall strip lies in the ring cell outside the face (edge pieces are hosted there)
      t.at[1] +
        0.5 +
        dy * (0.75 + (legibleCondition ? jit("out") * 0.2 : 0)) +
        (legibleCondition ? uy * jit("al") * 0.3 : 0),
      t.top,
      ((yaw % 360) + 360) % 360,
      `${st.id}~walltop`,
      "roof",
      "wall", // a piece of the broken wall itself: the prop checks (floating over floor) do not apply to masonry
    );
  }
}

/**
 * Growth that climbs the structure (generator 3; the resolver chose where, `ResolvedStructure.growth`): vine strands
 * stacked up a wall face, roots at its base, small growth on a cut wall top, a tree in a roofless middle. Palette
 * roles ruin_climber.default / ruin_root.default / ruin_cap.default / ruin_tree.default, each falling back to the
 * theme's feature role (feature.vines, feature.roots_wall, ruin_growth.default, feature.tree); a theme with neither
 * gets nothing, never a wrong object. Pieces no wider than a cell and a half sit on the wall face.
 */
function buildGrowth(ctx: StructureRealizeCtx, st: ResolvedStructure, theme: string): void {
  const list = st.growth;
  if (!list || list.length === 0) return;
  const slim = (v: ResolvedVariant): boolean => Math.max(v.geom.size.x, v.geom.size.z) <= 1.1;
  const climber = ctx.lookup(
    theme,
    ["ruin_climber.default", "feature.vines"],
    { key: "strand", test: (v) => slim(v) && v.geom.size.y <= 2.4 },
    true,
  );
  // the largest climbing piece the palette has: a broad batch (a face and a half wide) for the foot of a heavy mass
  const batcher = ctx.lookup(
    theme,
    ["ruin_climber.default", "feature.vines"],
    { key: "vinebatch", test: (v) => v.geom.size.x >= 1.5 && v.geom.size.x <= 2.1 && v.geom.size.y <= 2.4 },
    true,
  );
  const rooter = ctx.lookup(
    theme,
    ["ruin_root.default", "feature.roots_wall"],
    { key: "wallroot", test: slim },
    true,
  );
  const capper = ctx.lookup(
    theme,
    ["ruin_cap.default", "ruin_growth.default"],
    { key: "smallplant", test: (v) => Math.max(v.geom.size.x, v.geom.size.z) <= 1.8 && v.geom.size.y <= 1.3 },
    true,
  );
  const treer = ctx.lookup(
    theme,
    ["ruin_tree.default", "feature.tree"],
    { key: "smalltree", test: (v) => Math.max(v.geom.size.x, v.geom.size.z) <= 3.2 && v.geom.size.y <= 4.2 },
    true,
  );
  for (const g of list) {
    const k = `${st.id}:grow:${g.kind}:${g.at[0]},${g.at[1]}${g.side ?? ""}`;
    const rnd = (s: string): number => hashUnitUtf16(ctx.seed, k, s);
    if ((g.kind === "vine" || g.kind === "root") && g.side) {
      const r = g.kind === "vine" ? climber : rooter;
      if (!r) continue;
      let y = g.from;
      const thick = g.thick ?? 1;
      for (let i = 0; i < 8 && y < g.to - 0.3; i++) {
        // a broad batch over the lowest course of a wide mass (it spans this face and its neighbours)
        const wideV =
          g.wide && i === 0 && g.kind === "vine" && batcher
            ? ctx.pick(batcher.variants, `${ctx.L.id}:${k}:wide`)
            : undefined;
        // strands side by side, one fewer at each course up (masses thin upward)
        const n = wideV ? 1 : Math.max(1, thick - i);
        let adv = 0;
        for (let j = 0; j < n; j++) {
          // a strand that fits the span (a little over at most)
          const fit = r.variants.filter((v) => v.geom.size.y <= g.to - y + 0.4);
          const v = wideV ?? ctx.pick(fit.length ? fit : r.variants, `${ctx.L.id}:${k}:${i}:${j}`);
          if (!v) break;
          const h = v.geom.size.y;
          if (h > g.to - y + 0.5) break;
          const base = Math.max(g.from, Math.min(y, g.to - h));
          const along =
            n === 1 ? (rnd(`a${i}`) - 0.5) * 0.5 : (j - (n - 1) / 2) * 0.34 + (rnd(`a${i}:${j}`) - 0.5) * 0.1;
          wallProp(
            ctx,
            v,
            r.role,
            g.at[0],
            g.at[1],
            g.side,
            1.15,
            base,
            `${st.id}~${g.kind === "vine" ? "vine" : "wallroot"}`,
            "storey:0",
            along,
          );
          adv = Math.max(adv, base + h * 0.9);
        }
        if (adv === 0) break;
        y = adv;
      }
    } else if (g.kind === "cap" && g.side && capper) {
      const v = ctx.pick(capper.variants, `${ctx.L.id}:${k}`);
      if (!v) continue;
      const [dx, dy] = STEP[g.side];
      placeProp(
        ctx,
        v,
        g.at[0] + 0.5 + dx * 0.75,
        g.at[1] + 0.5 + dy * 0.75,
        g.from,
        (h32Utf16(k) % 4) * 90,
        `${st.id}~topgrowth`,
        "roof",
        "wall",
      );
    } else if (g.kind === "tree" && treer) {
      const v = ctx.pick(treer.variants, `${ctx.L.id}:${k}`);
      if (!v) continue;
      placeProp(
        ctx,
        v,
        g.at[0] + 0.5,
        g.at[1] + 0.5,
        ctx.groundTop(g.at[0], g.at[1]),
        (h32Utf16(k) % 4) * 90,
        `${st.id}~tree`,
        undefined,
      );
    }
  }
}

/**
 * What a ruin keeps of its battlements (the reference keep: crenellation pieces at whatever height the wall now
 * ends, not one parapet line): a crenel piece on some columns that stand above both neighbours. Only where the
 * wall style has crenels (role crenel.<style>, crenel.default); otherwise nothing.
 */
function buildRuinFragments(ctx: StructureRealizeCtx, st: ResolvedStructure, theme: string): void {
  if (st.condition !== "ruined" || !st.ruin) return;
  const at = new Map(st.ruin.columns.map((c) => [`${c.at[0]},${c.at[1]},${c.side}`, c]));
  const style = st.design?.material ?? st.storeys[0]?.walls ?? "stone";
  const r = ctx.lookup(theme, [`crenel.${style}`, "crenel.default"], lenFilter(1), true);
  if (!r) return;
  for (const c of st.ruin.columns) {
    if (c.top >= c.full - 1e-6) continue; // an intact top carries its roof or parapet as built
    const [ax, ay] = c.side === "N" || c.side === "S" ? [1, 0] : [0, 1];
    const p = at.get(`${c.at[0] - ax},${c.at[1] - ay},${c.side}`);
    const q = at.get(`${c.at[0] + ax},${c.at[1] + ay},${c.side}`);
    if (!p || !q || p.top >= c.top || q.top >= c.top) continue;
    const k = `${st.id}:remnant:${c.at[0]},${c.at[1]}${c.side}`;
    if (h32Utf16(`${ctx.seed}:${k}`) % 3 !== 0) continue;
    const v = ctx.pick(r.variants, `${ctx.L.id}:${k}`);
    if (v) edgePiece(ctx, v, "wall", c.at[0], c.at[1], c.side, 1, c.top, `${st.id}~remnant`, "roof");
  }
}

/**
 * No bare floor edge on the outside (owner, 2026-11-20: offset storeys showed slab edges): where a volume standing
 * on another overhangs it, a corbel course of its own wall material hangs a tile below its floor on the overhanging
 * faces; where it sets back from a host with no roof of its own, the exposed host cells get a skirt of roof slope
 * falling outward, laid on the host's wall top.
 */
function buildLips(
  ctx: StructureRealizeCtx,
  st: ResolvedStructure,
  theme: string,
  vols: ResolvedVolume[],
): void {
  // the skirts take the building's pitched roof kit (one roof material throughout)
  const kit =
    vols.flatMap((v) => v.roof.layers).find((l) => l.type !== "flat" && l.type !== "none")?.style ||
    st.roof.style ||
    "slate";
  for (const v of vols) {
    if (v.on === null) continue;
    const host = vols.find((o) => o.id === v.on);
    const hostTop = host?.storeys[host.storeys.length - 1];
    const sp = v.storeys[0];
    if (!host || !hostTop || !sp) continue;
    const hostCells = setOf(hostTop.cells);
    const own = setOf(sp.cells);
    // the corbel course is trim: the design's base (trim) material when it has one (stone under a brick shaft)
    const walls = st.design?.treatment ? st.design.baseMaterial : (sp.walls ?? "stone");
    const tag = `${st.id}~${v.id}~lip`;
    for (const f of faceCells(own)) {
      if (hostCells.has(key(f.x, f.y))) continue;
      stackEdge(
        ctx,
        theme,
        [`corbel.${walls}`, `facade.${walls}`, `wall.${walls}`],
        "wall",
        f.x,
        f.y,
        f.face,
        sp.floorTop - 1.5,
        sp.floorTop - 0.5,
        tag,
        "storey:0",
        { allowBelow: true },
      );
    }
    if (host.roof.layers.length > 0) continue; // a roofed host (a podium, a terrace) shows its own roof
    for (const k of hostCells) {
      if (own.has(k)) continue;
      const [x, y] = k.split(",").map(Number) as [number, number];
      const eave =
        SIDES.find((s) => !hostCells.has(key(x + STEP[s][0], y + STEP[s][1]))) ??
        SIDES.find((s) => !own.has(key(x - STEP[s][0], y - STEP[s][1]))) ??
        "S";
      placeRoofPiece(
        ctx,
        st,
        theme,
        kit,
        { kind: "slope", x, y, w: 1, h: 1, eave, course: 0 },
        hostTop.wallTop,
        tag,
      );
    }
  }
}
