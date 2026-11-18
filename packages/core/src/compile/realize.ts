/**
 * Realize: ResolvedPlan + palettes + orientation → PlacementSet (architecture §4.3). World space: x east, y up,
 * z north, tiles. Never throws for bad content; problems become aggregated diagnostics.
 */
import type {
  Box3,
  CompileDiagnostic,
  OrientationCalibration,
  PaletteCatalog,
  PaletteFacing,
  Placement,
  PlacementRole,
  PlacementSet,
  RoleName,
} from "../contracts/compiler";
import type { LevelId, Side, ThemeId } from "../contracts/plan";
import {
  CELL,
  CELL_FLAG,
  EDGE,
  type ResolvedFeature,
  type ResolvedLevel,
  type ResolvedPlan,
} from "../contracts/resolved";
import { loadOrientation } from "../palette/load";
import { own } from "../palette/own";
import {
  createRoleResolver,
  footprintFromGeom,
  type ResolvedVariant,
  type ResolveOutcome,
  type VariantFilter,
} from "../palette/resolve";
import { WorldFrame, emptyBox, finiteBox, growBox, h32, placementBox, rotateDir, rotateXZ } from "./geometry";

export const ROLE_ORDER: readonly PlacementRole[] = [
  "floor",
  "fill",
  "wall",
  "wall_post",
  "opening",
  "link",
  "feature",
  "ledge",
  "marker",
];

/** World AABB of every placement made by realize (keyed by object; used by chunking for exact bounds). */
export const placementBoxes = new WeakMap<Placement, Box3>();

/** Asset name and geometry of every placement made by realize (used by the verify stage). */
export const placementMeta = new WeakMap<Placement, { name: string; geom: ResolvedVariant["geom"] }>();

export interface RealizeOptions {
  levels?: LevelId[];
  seed?: number;
  orientation?: OrientationCalibration;
}

export interface BundleSubstitution {
  role: RoleName;
  wanted: { uuid: string; name?: string };
  used: { uuid: string; name?: string } | null;
  count: number;
}

/** PlacementSet plus what the chunk/bundle stage needs (structurally a PlacementSet). */
export interface RealizedSet extends PlacementSet {
  substitutions: BundleSubstitution[];
  assetSource: "install" | "builtin";
  /** Alignment marker asset (marker.alignment), null when the palettes have none. */
  marker: { uuid: string; geom: ResolvedVariant["geom"] } | null;
  levelInfo: Array<{
    levelId: LevelId;
    elevation: number;
    bounds: Box3;
    cellBounds: { x: number; y: number; w: number; h: number };
  }>;
  resolvedHash: string;
}

const NONE = 0xffff;
/** Opening roles whose asset is a full-height wall piece (no lintel above them). */
const NO_LINTEL = new Set(["opening.archway", "opening.window", "opening.arrow_slit"]);
const opposite = (s: Side): Side => (s === "N" ? "S" : s === "S" ? "N" : s === "E" ? "W" : "E");
const EPS = 1e-6;

interface CellInfo {
  open: boolean;
  floor: boolean;
  /** Relative floor height in tiles. */
  height: number;
  material: string | null;
  theme: ThemeId;
  area: number;
  flags: number;
}

class LevelView {
  readonly w: number;
  readonly h: number;
  constructor(
    readonly L: ResolvedLevel,
    readonly defaultTheme: ThemeId,
  ) {
    this.w = L.bounds.w;
    this.h = L.bounds.h;
  }
  inBounds(x: number, y: number): boolean {
    const lx = x - this.L.bounds.x;
    const ly = y - this.L.bounds.y;
    return lx >= 0 && ly >= 0 && lx < this.w && ly < this.h;
  }
  cell(x: number, y: number): CellInfo {
    if (!this.inBounds(x, y))
      return {
        open: false,
        floor: false,
        height: 0,
        material: null,
        theme: this.defaultTheme,
        area: 0,
        flags: 0,
      };
    const i = (y - this.L.bounds.y) * this.w + (x - this.L.bounds.x);
    const c = this.L.cells;
    const state = c.state[i] ?? CELL.VOID;
    const flags = c.flags[i] ?? 0;
    const mat = c.material[i] ?? 0;
    const open = state === CELL.OPEN;
    return {
      open,
      floor: open && (flags & CELL_FLAG.NO_FLOOR) === 0 && mat > 0,
      height: (c.height[i] ?? 0) / 4,
      material: mat > 0 ? (this.L.materials[mat - 1] ?? null) : null,
      theme: this.L.themes[c.theme[i] ?? 0] ?? this.defaultTheme,
      area: c.area[i] ?? 0,
      flags,
    };
  }
  /** Horizontal edge = NORTH edge of cell (x, y); y may equal bounds.y + h (south border). */
  hEdge(x: number, y: number): number {
    const lx = x - this.L.bounds.x;
    const ly = y - this.L.bounds.y;
    if (lx < 0 || lx >= this.w || ly < 0 || ly > this.h) return -1;
    return ly * this.w + lx;
  }
  /** Vertical edge = WEST edge of cell (x, y); x may equal bounds.x + w (east border). */
  vEdge(x: number, y: number): number {
    const lx = x - this.L.bounds.x;
    const ly = y - this.L.bounds.y;
    if (lx < 0 || lx > this.w || ly < 0 || ly >= this.h) return -1;
    return ly * (this.w + 1) + lx;
  }
}

/** One edge strip (a wall or door piece occupying the half-cell next to an edge), for corner posts. */
interface Strip {
  orient: "h" | "v";
  /** Plan side of the edge line the strip lies on: h → "N"|"S", v → "W"|"E". */
  side: Side;
  style: string;
  theme: ThemeId;
  base: number;
  top: number;
}

export function realize(
  resolved: ResolvedPlan,
  palettes: PaletteCatalog,
  opts: RealizeOptions = {},
): RealizedSet {
  const orientation = opts.orientation ?? loadOrientation().orientation;
  const seed = opts.seed ?? h32(resolved.planId);
  const hg = resolved.levels.reduce((m, l) => Math.max(m, l.bounds.y + l.bounds.h), 0);
  const frame = new WorldFrame(orientation, hg);
  const resolveRole = createRoleResolver(palettes);
  const defaultTheme = Object.keys(palettes.palettes).includes("generic")
    ? "generic"
    : (Object.keys(palettes.palettes)[0] ?? "generic");

  const diag = new Map<string, CompileDiagnostic>();
  const addDiag = (
    d: Omit<CompileDiagnostic, "count" | "stage"> & { stage?: CompileDiagnostic["stage"] },
    n = 1,
  ): void => {
    const key = [d.severity, d.code, d.levelId ?? "", d.role ?? "", d.elementId ?? ""].join("|");
    const prev = diag.get(key);
    if (prev) prev.count = (prev.count ?? 1) + n;
    else diag.set(key, { ...d, stage: d.stage ?? "realize", count: n });
  };
  const subs = new Map<string, BundleSubstitution>();
  const themeWarned = new Set<string>();

  const levelsWanted = opts.levels ? new Set(opts.levels) : null;
  const outLevels: PlacementSet["levels"] = [];
  const levelInfo: RealizedSet["levelInfo"] = [];
  const allBox = emptyBox();
  const views = new Map<LevelId, LevelView>();
  for (const L of resolved.levels) views.set(L.id, new LevelView(L, defaultTheme));

  // ── role lookup with diagnostics ──
  const lookup = (
    levelId: LevelId,
    theme: ThemeId,
    roles: RoleName[],
    filter?: VariantFilter,
    quiet = false,
  ): ResolveOutcome["resolution"] => {
    let t = theme;
    if (!own(palettes.palettes, t)) {
      if (!themeWarned.has(t)) {
        themeWarned.add(t);
        addDiag({
          severity: "warning",
          code: "theme_fallback",
          message: `Theme "${t}" has no palette; using "${defaultTheme}"`,
          levelId,
        });
      }
      t = defaultTheme;
    }
    for (const role of roles) {
      const out = resolveRole(t, role, filter);
      if (out.resolution) {
        for (const s of out.substitutions) {
          const k = `${s.role}|${s.wanted.uuid}|${s.used?.uuid ?? ""}`;
          const e = subs.get(k);
          if (e) e.count++;
          else subs.set(k, { ...s, count: 1 });
        }
        return out.resolution;
      }
    }
    if (!quiet) {
      const role = roles[0] ?? "?";
      addDiag({
        severity: "warning",
        code: "role_missing",
        message: `No usable palette asset for role "${role}"${filter ? ` (${filter.key})` : ""} in theme "${t}"; placements dropped`,
        levelId,
        role,
      });
    }
    return null;
  };

  const pick = (vs: ResolvedVariant[], key: string): ResolvedVariant | undefined => {
    const weighted = vs.filter((v) => v.weight > 0);
    const pool = weighted.length ? weighted : vs.slice(0, 1);
    const total = pool.reduce((s, v) => s + v.weight, 0);
    if (pool.length <= 1 || total <= 0) return pool[0];
    let r = (h32(`${seed}:${key}`) / 0x100000000) * total;
    for (const v of pool) {
      r -= v.weight;
      if (r < 0) return v;
    }
    return pool[pool.length - 1];
  };

  const facingOf = (v: ResolvedVariant, rolePrefix: string, role: RoleName): PaletteFacing => {
    const d = orientation.defaultFacing;
    return {
      ...(own(d, "*") ?? {}),
      ...(own(d, rolePrefix) ?? {}),
      ...(own(d, role) ?? {}),
      ...(v.facing ?? {}),
    };
  };

  for (const L of resolved.levels) {
    if (levelsWanted && !levelsWanted.has(L.id)) continue;
    const V = views.get(L.id) ?? new LevelView(L, defaultTheme);
    const placements: Placement[] = [];
    const levelBox = emptyBox();
    const elev = L.elevation;
    const topOf = (c: CellInfo): number => elev + c.height + 0.5;

    const emit = (
      v: ResolvedVariant,
      role: PlacementRole,
      x: number,
      y: number,
      z: number,
      rotDeg: number,
      source: Placement["source"],
    ): void => {
      const rot = (((Math.round(rotDeg / 15) * 15) % 360) + 360) % 360;
      const p: Placement = {
        asset: v.uuid,
        x: x + v.offset.x,
        y: y + v.offset.y,
        z: z + v.offset.z,
        rot,
        role,
        levelId: L.id,
        source,
      };
      const box = placementBox(v.geom, p.x, p.y, p.z, rot * orientation.rotSense);
      placementBoxes.set(p, box);
      placementMeta.set(p, { name: v.name ?? palettes.availability.name(v.uuid) ?? v.uuid, geom: v.geom });
      growBox(levelBox, box);
      placements.push(p);
    };

    // ── 1. floors (greedy tiling) and 2. fill ──
    const used = new Set<number>();
    const keyOf = (c: CellInfo): string => `${c.theme}|${c.material ?? ""}|${c.height}`;
    for (let ly = 0; ly < V.h; ly++) {
      for (let lx = 0; lx < V.w; lx++) {
        const x = L.bounds.x + lx;
        const y = L.bounds.y + ly;
        const c = V.cell(x, y);
        if (!c.floor || used.has(ly * V.w + lx)) continue;
        const role = `floor.${c.material ?? ""}`;
        const res = lookup(L.id, c.theme, [role]);
        if (!res) {
          used.add(ly * V.w + lx);
          continue;
        }
        const greedy = res.def.greedyTiling !== false;
        const fps = [
          ...new Set(
            res.variants
              .filter((v) => v.weight > 0 || res.variants.every((u) => u.weight <= 0))
              .map((v) => `${v.footprint[0]}x${v.footprint[1]}`),
          ),
        ]
          .map((s) => s.split("x").map(Number) as [number, number])
          .filter(([w, h]) => greedy || (w === 1 && h === 1))
          .sort((a, b) => b[0] * b[1] - a[0] * a[1] || b[0] - a[0]);
        const k0 = keyOf(c);
        let placed = false;
        for (const [fw, fh] of fps.length ? fps : [[1, 1] as [number, number]]) {
          let fits = lx + fw <= V.w && ly + fh <= V.h;
          for (let dy = 0; fits && dy < fh; dy++) {
            for (let dx = 0; fits && dx < fw; dx++) {
              const cc = V.cell(x + dx, y + dy);
              if (!cc.floor || used.has((ly + dy) * V.w + lx + dx) || keyOf(cc) !== k0) fits = false;
            }
          }
          if (!fits) continue;
          const v = pick(
            res.variants.filter((u) => u.footprint[0] === fw && u.footprint[1] === fh),
            `${L.id}:floor:${x}:${y}`,
          );
          if (!v) continue;
          for (let dy = 0; dy < fh; dy++) for (let dx = 0; dx < fw; dx++) used.add((ly + dy) * V.w + lx + dx);
          const m = frame.rectMin(x, y, fw, fh);
          const rule = res.def.rotation ?? "random90";
          const r = h32(`${seed}:${L.id}:floorrot:${x}:${y}`);
          const steps =
            rule === "fixed"
              ? 0
              : fw === fh
                ? rule === "random90" || rule === "random15"
                  ? (r % 4) * 6
                  : 0
                : (r % 2) * 12;
          emit(v, "floor", m.x, topOf(c) - v.geom.size.y, m.z, steps * 15 + v.rot, {
            cell: [x, y],
            elementId: `floor:${role}`,
          });
          placed = true;
          break;
        }
        if (!placed) used.add(ly * V.w + lx);
      }
    }
    // fill under raised cells
    for (let ly = 0; ly < V.h; ly++) {
      for (let lx = 0; lx < V.w; lx++) {
        const x = L.bounds.x + lx;
        const y = L.bounds.y + ly;
        const c = V.cell(x, y);
        if (!c.floor) continue;
        const nh = [V.cell(x, y - 1), V.cell(x + 1, y), V.cell(x, y + 1), V.cell(x - 1, y)].map((n) =>
          n.floor ? n.height : 0,
        );
        const minN = Math.min(...nh);
        if (c.height <= minN + EPS) continue;
        stackFill(L.id, c.theme, c.material, x, y, elev + minN, elev + c.height);
      }
    }

    function stackFill(
      levelId: LevelId,
      theme: ThemeId,
      material: string | null,
      x: number,
      y: number,
      from: number,
      to: number,
      role: PlacementRole = "fill",
      elementId = "fill",
    ): void {
      const roles = material ? [`fill.${material}`, "fill.default"] : ["fill.default"];
      const res = lookup(levelId, theme, roles, {
        key: "1x1",
        test: (v) => v.footprint[0] === 1 && v.footprint[1] === 1,
      });
      if (!res) return;
      const v = pick(res.variants, `${levelId}:fill:${x}:${y}`);
      if (!v) return;
      const u = v.unitHeight;
      const n = Math.ceil((to - from) / u - EPS);
      const m = frame.rectMin(x, y, 1, 1);
      for (let k = 0; k < n; k++)
        emit(v, role, m.x, to - (k + 1) * u, m.z, v.rot, { cell: [x, y], elementId });
    }

    // ── 3. walls, openings, posts ──
    const strips = new Map<string, Array<Strip & { dir: Side }>>(); // vertex key → strips ending there
    const addStrip = (vx: number, vy: number, s: Strip, dir: Side): void => {
      const k = `${vx},${vy}`;
      const arr = strips.get(k) ?? [];
      arr.push({ ...s, dir });
      strips.set(k, arr);
    };
    /** Registers a 1-long strip on the edge starting at vertex (vx,vy) running +x (h) or +y (v). */
    const registerEdgeStrip = (orient: "h" | "v", vx: number, vy: number, s: Strip): void => {
      if (orient === "h") {
        addStrip(vx, vy, s, "E");
        addStrip(vx + 1, vy, s, "W");
      } else {
        addStrip(vx, vy, s, "S");
        addStrip(vx, vy + 1, s, "N");
      }
    };

    interface EdgeCtx {
      orient: "h" | "v";
      x: number;
      y: number;
      hostFirst: boolean;
      hostX: number;
      hostY: number;
      planSide: Side;
      base: number;
      top: number;
      theme: ThemeId;
      hostOpen: boolean;
    }
    /** Edge (x,y) = north edge of cell (x,y) for h, west edge for v. */
    const edgeCtx = (
      orient: "h" | "v",
      x: number,
      y: number,
      grid: ResolvedLevel["hEdges"],
      e: number,
      wallHeight: number,
    ): EdgeCtx => {
      const a = orient === "h" ? V.cell(x, y - 1) : V.cell(x - 1, y);
      const b = V.cell(x, y);
      const hostFirst = (grid.host[e] ?? 1) === 0;
      const host = hostFirst ? a : b;
      const other = hostFirst ? b : a;
      const tops = [a, b].filter((c) => c.floor).map(topOf);
      const base = tops.length ? Math.min(...tops) : elev + 0.5;
      const top = (tops.length ? Math.max(...tops) : base) + wallHeight;
      const theme = (other.open ? other.theme : host.open ? host.theme : other.theme) || defaultTheme;
      const hostX = orient === "h" ? x : hostFirst ? x - 1 : x;
      const hostY = orient === "h" ? (hostFirst ? y - 1 : y) : y;
      const planSide: Side = orient === "h" ? (hostFirst ? "S" : "N") : hostFirst ? "E" : "W";
      return { orient, x, y, hostFirst, hostX, hostY, planSide, base, top, theme, hostOpen: host.open };
    };

    const lengthOf = (v: ResolvedVariant): number =>
      v.geom.lengthAxis === "square" || v.geom.lengthAxis === undefined
        ? Math.max(1, Math.round(Math.max(v.geom.size.x, v.geom.size.z)))
        : Math.max(1, Math.round(v.geom.lengthAxis === "x" ? v.geom.size.x : v.geom.size.z));
    const lenFilter = (n: number): VariantFilter => ({ key: `len${n}`, test: (v) => lengthOf(v) === n });

    /** Places one half-cell edge piece covering `len` edges starting at the run's first edge ctx. */
    const placeEdgePiece = (
      v: ResolvedVariant,
      role: PlacementRole,
      roleName: RoleName,
      first: EdgeCtx,
      len: number,
      yBase: number,
      count: number,
      source: Placement["source"],
      isDoor: boolean,
    ): void => {
      // host cell whose world min corner anchors the piece: west-most (h run) or south-most in world (v run)
      const hx = first.hostX;
      const hy = first.orient === "v" && frame.o.flipZ ? first.hostY + len - 1 : first.hostY;
      const ws = frame.worldSide(first.planSide);
      const ep = frame.o.edgePlacement[ws];
      const m = frame.rectMin(hx, hy, 1, 1);
      const axisFix = v.geom.lengthAxis === "z" ? 6 : 0;
      let steps = (ep.rotSteps[0] + axisFix) % 24;
      if (isDoor) {
        const f = facingOf(v, "opening", roleName);
        if (f.handleEnd) {
          const pref = frame.o.doorHandlePreference;
          const want: Side =
            ws === "N" || ws === "S" ? (pref?.eastWestEdge ?? "W") : (pref?.northSouthEdge ?? "N");
          const cand = ep.rotSteps.map((r) => (r + axisFix) % 24);
          steps = cand.find((r) => frame.dirAfter(f.handleEnd ?? "W", r) === want) ?? cand[0] ?? steps;
        }
      }
      const unit = v.unitHeight;
      for (let k = 0; k < count; k++) {
        emit(v, role, m.x + ep.offset.x, yBase + k * unit, m.z + ep.offset.z, steps * 15 + v.rot, source);
      }
    };

    const placeEdgeCenterPiece = (
      v: ResolvedVariant,
      role: PlacementRole,
      first: EdgeCtx,
      len: number,
      source: Placement["source"],
    ): void => {
      const along =
        first.orient === "h" ? { x: first.x + len / 2, y: first.y } : { x: first.x, y: first.y + len / 2 };
      const c = frame.point(along.x, along.y);
      const runsEW = first.orient === "h";
      const axisFix = v.geom.lengthAxis === "z" ? 6 : 0;
      const steps = ((runsEW ? 0 : frame.stepsForQuarters(1)) + axisFix) % 24;
      const deg = steps * 15 + v.rot;
      const off =
        v.geom.originAt === "minCorner"
          ? { x: 0, z: 0 }
          : rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * frame.o.rotSense);
      emit(v, role, c.x - off.x, first.base, c.z - off.z, deg, source);
    };

    const fullCellDone = new Set<string>();
    const wallStyleOf = (ref: number): string => (ref === NONE ? "wall" : (L.wallStyles[ref] ?? "wall"));

    const doRuns = (orient: "h" | "v"): void => {
      const grid = orient === "h" ? L.hEdges : L.vEdges;
      const outer = orient === "h" ? V.h + 1 : V.w + 1;
      const inner = orient === "h" ? V.w : V.h;
      for (let o = 0; o < outer; o++) {
        let run: EdgeCtx[] = [];
        let runKey = "";
        let runStyle = "wall";
        const flush = (): void => {
          if (run.length) placeWallRun(run, runStyle);
          run = [];
          runKey = "";
        };
        for (let i = 0; i < inner; i++) {
          const x = orient === "h" ? L.bounds.x + i : L.bounds.x + o;
          const y = orient === "h" ? L.bounds.y + o : L.bounds.y + i;
          const e = orient === "h" ? V.hEdge(x, y) : V.vEdge(x, y);
          if (e < 0 || grid.kind[e] !== EDGE.WALL) {
            flush();
            continue;
          }
          const style = wallStyleOf(grid.ref[e] ?? NONE);
          const height = (grid.height[e] ?? 0) > 0 ? (grid.height[e] ?? 2) : 2;
          const ctx = edgeCtx(orient, x, y, grid, e, height);
          const key = [ctx.hostFirst, style, ctx.theme, ctx.base, ctx.top].join("|");
          if (key !== runKey) flush();
          runKey = key;
          runStyle = style;
          run.push(ctx);
        }
        flush();
      }

      function placeWallRun(run: EdgeCtx[], style: string): void {
        const first = run[0];
        if (!first) return;
        const roleName = `wall.${style}`;
        const res = lookup(L.id, first.theme, [roleName]);
        if (!res) return;
        const mount = res.def.mount ?? "half-cell";
        if (mount === "full-cell") {
          for (const c of run) {
            const k = `${c.hostX},${c.hostY}`;
            if (fullCellDone.has(k)) continue;
            fullCellDone.add(k);
            if (c.hostOpen) {
              addDiag({
                severity: "warning",
                code: "thick_wall_conflict",
                message: `Full-cell wall "${roleName}" would fill an open cell; skipped`,
                levelId: L.id,
                role: roleName,
                cell: [c.hostX, c.hostY],
              });
              continue;
            }
            const r1 = lookup(L.id, c.theme, [roleName], {
              key: "1x1",
              test: (v) => v.footprint[0] === 1 && v.footprint[1] === 1,
            });
            const v = r1 ? pick(r1.variants, `${L.id}:wallblock:${k}`) : undefined;
            if (!v) continue;
            const m = frame.rectMin(c.hostX, c.hostY, 1, 1);
            const n = Math.max(1, Math.ceil((c.top - c.base) / v.unitHeight - EPS));
            for (let s = 0; s < n; s++)
              emit(v, "wall", m.x, c.base + s * v.unitHeight, m.z, v.rot, {
                cell: [c.hostX, c.hostY],
                elementId: roleName,
              });
          }
          return;
        }
        const lengths = [...new Set(res.variants.filter((v) => v.weight > 0).map(lengthOf))].sort(
          (a, b) => b - a,
        );
        const greedy = res.def.greedyTiling !== false;
        let i = 0;
        while (i < run.length) {
          const remaining = run.length - i;
          const cands = (greedy ? lengths : [1]).filter((n) => n <= remaining);
          let done = false;
          for (const n of [...cands, 1]) {
            const r = lookup(L.id, first.theme, [roleName], lenFilter(n), n !== 1);
            const v = r
              ? pick(r.variants, `${L.id}:${orient}wall:${run[i]?.x ?? 0}:${run[i]?.y ?? 0}`)
              : undefined;
            const c = run[i];
            if (!v || !c) continue;
            if (mount === "edge-center")
              placeEdgeCenterPiece(v, "wall", c, n, { cell: [c.hostX, c.hostY], elementId: roleName });
            else {
              const count = Math.max(1, Math.ceil((c.top - c.base) / v.unitHeight - EPS));
              placeEdgePiece(
                v,
                "wall",
                r?.role ?? roleName,
                c,
                n,
                c.base,
                count,
                { cell: [c.hostX, c.hostY], elementId: roleName },
                false,
              );
              for (let k = 0; k < n; k++) {
                const ck = run[i + k];
                if (ck)
                  registerEdgeStrip(orient, ck.x, ck.y, {
                    orient,
                    side: opposite(ck.planSide),
                    style,
                    theme: ck.theme,
                    base: ck.base,
                    top: ck.top,
                  });
              }
            }
            i += n;
            done = true;
            break;
          }
          if (!done) i++;
        }
      }
    };
    doRuns("h");
    doRuns("v");

    // openings
    for (const op of L.openings) {
      if (op.kind === "open") continue;
      const orient = op.orientation;
      const grid = orient === "h" ? L.hEdges : L.vEdges;
      const ctxs: EdgeCtx[] = [];
      for (let k = 0; k < op.width; k++) {
        const x = orient === "h" ? op.start[0] + k : op.start[0];
        const y = orient === "h" ? op.start[1] : op.start[1] + k;
        const e = orient === "h" ? V.hEdge(x, y) : V.vEdge(x, y);
        if (e < 0) continue;
        ctxs.push(edgeCtx(orient, x, y, grid, e, (grid.height[e] ?? 0) > 0 ? (grid.height[e] ?? 2) : 2));
      }
      const first = ctxs[0];
      if (!first) continue;
      // all edges of one opening use the first edge's host side
      for (const c of ctxs) {
        if (c.hostFirst !== first.hostFirst) {
          const e = orient === "h" ? V.hEdge(c.x, c.y) : V.vEdge(c.x, c.y);
          // keep the edge's real wall height (was hard-coded to 2, leaving a gap above doors in taller walls)
          const h = (grid.height[e] ?? 0) > 0 ? (grid.height[e] ?? 2) : 2;
          Object.assign(
            c,
            edgeCtx(
              orient,
              c.x,
              c.y,
              { ...grid, host: grid.host.map(() => (first.hostFirst ? 0 : 1)) },
              e,
              h,
            ),
          );
        }
      }
      const roleName = `opening.${op.kind}`;
      const res = lookup(L.id, op.theme || first.theme, [roleName]);
      if (!res) continue;
      const lengths = [
        ...new Set(res.variants.filter((v) => v.weight > 0 || res.variants.length === 1).map(lengthOf)),
      ].sort((a, b) => b - a);
      let i = 0;
      while (i < ctxs.length) {
        const remaining = ctxs.length - i;
        const c = ctxs[i];
        if (!c) break;
        let placed = 0;
        for (const n of lengths.filter((l) => l <= remaining)) {
          const r = lookup(L.id, op.theme || first.theme, [roleName], lenFilter(n), true);
          const pool = r ? r.variants.filter((v) => v.weight > 0) : [];
          const v = r
            ? pool.length
              ? pick(pool, `${L.id}:opening:${op.id}:${i}`)
              : r.variants[0]
            : undefined;
          if (!v || !r) continue;
          const isDoor = r.role.startsWith("opening.");
          placeEdgePiece(
            v,
            r.role.startsWith("wall.") ? "wall" : "opening",
            r.role,
            c,
            n,
            c.base,
            1,
            { cell: [c.hostX, c.hostY], elementId: op.id },
            isDoor,
          );
          // wall pieces above a door shorter than the wall
          const leafTop = c.base + v.unitHeight;
          const wallTop = Math.max(...ctxs.slice(i, i + n).map((q) => q.top));
          for (let k = 0; k < n; k++) {
            const ck = ctxs[i + k];
            if (!ck) continue;
            registerEdgeStrip(orient, ck.x, ck.y, {
              orient,
              side: opposite(ck.planSide),
              style: op.wallStyle,
              theme: ck.theme,
              base: ck.base,
              top: wallTop,
            });
            if (wallTop > leafTop + 0.25 - EPS) {
              const wr = lookup(L.id, ck.theme, [`wall.${op.wallStyle}`], lenFilter(1), true);
              const wv = wr ? pick(wr.variants, `${L.id}:lintel:${ck.x}:${ck.y}`) : undefined;
              if (wv && (wr?.def.mount ?? "half-cell") === "half-cell") {
                const cnt = Math.ceil((wallTop - leafTop) / wv.unitHeight - EPS);
                placeEdgePiece(
                  wv,
                  "wall",
                  `wall.${op.wallStyle}`,
                  ck,
                  1,
                  leafTop,
                  cnt,
                  { cell: [ck.hostX, ck.hostY], elementId: op.id },
                  false,
                );
              }
            } else if (isDoor && !NO_LINTEL.has(r.role)) {
              // Kit walls are visually taller than their doors (in-game 2026-11-18): close the notch with the
              // kit's lintel piece when the palette has one (data-driven; absent role = no lintel, no warning).
              const lr = lookup(
                L.id,
                op.theme || ck.theme,
                [`lintel.${op.wallStyle}`, "lintel.wall"],
                lenFilter(1),
                true,
              );
              const lv = lr ? pick(lr.variants, `${L.id}:lintel:${ck.x}:${ck.y}`) : undefined;
              if (lv) {
                placeEdgePiece(
                  lv,
                  "opening",
                  lr?.role ?? "lintel.wall",
                  ck,
                  1,
                  leafTop,
                  1,
                  { cell: [ck.hostX, ck.hostY], elementId: op.id },
                  false,
                );
              }
            }
          }
          placed = n;
          break;
        }
        if (!placed) {
          // An archway left as a plain gap is still a correct, passable opening: info, not a warning.
          const isArch = op.kind === "archway";
          addDiag({
            severity: isArch ? "info" : "warning",
            code: "role_missing",
            message: isArch
              ? `No ${remaining}-wide arch piece in the palette for archway ${op.id}; it is built as a plain opening`
              : `No "${roleName}" piece fits the remaining ${remaining}-edge span; left open`,
            levelId: L.id,
            role: roleName,
            elementId: op.id,
          });
          break;
        }
        i += placed;
      }
    }

    // corner posts: quadrants around a vertex left uncovered where an h strip and a v strip meet
    for (const [k, list] of strips) {
      const [vx, vy] = k.split(",").map(Number) as [number, number];
      const covered = new Set(
        list.map((s) => (s.orient === "h" ? `${s.side}${s.dir}` : `${s.dir}${s.side}`)),
      );
      const gaps = new Map<string, { a: Strip; b: Strip }>();
      for (const a of list.filter((s) => s.orient === "h")) {
        for (const b of list.filter((s) => s.orient === "v")) {
          if (a.dir === b.side || b.dir === a.side) continue;
          const q = `${a.side}${b.side}`;
          if (covered.has(q) || gaps.has(q)) continue;
          gaps.set(q, { a, b });
        }
      }
      for (const [q, { a, b }] of gaps) {
        const qy = q[0] as "N" | "S";
        const qx = q[1] as "W" | "E";
        const style = a.style;
        const res = lookup(L.id, a.theme, [`wall_post.${style}`, "wall_post.wall"]);
        const v = res ? pick(res.variants, `${L.id}:post:${k}:${q}`) : undefined;
        if (!v) continue;
        const px = qx === "W" ? vx - 0.5 : vx;
        const py0 = qy === "N" ? vy - 0.5 : vy;
        const m = frame.rectMin(px, py0, 0.5, 0.5);
        const base = Math.min(a.base, b.base);
        const top = Math.max(a.top, b.top);
        const n = Math.max(1, Math.ceil((top - base) / v.unitHeight - EPS));
        const cellX = Math.floor(px);
        const cellY = Math.floor(py0);
        for (let s = 0; s < n; s++)
          emit(v, "wall_post", m.x, base + s * v.unitHeight, m.z, v.rot, {
            cell: [cellX, cellY],
            elementId: `post:${k}`,
          });
      }
    }

    // ── 4. links (placed on the lower level) ──
    for (const lk of resolved.links) {
      if (lk.kind === "trapdoor") {
        // the hatch lies on the UPPER level's floor (the resolver keeps that floor for trapdoors)
        if (lk.toLevel === L.id) placeHatch(lk);
        continue;
      }
      if (lk.fromLevel !== L.id) continue;
      if (lk.kind === "pit_drop") continue;
      const roleName = `link.${lk.kind}`;
      const firstCell = lk.lowerCells[0];
      if (!firstCell) continue;
      const theme = lk.theme || V.cell(firstCell[0], firstCell[1]).theme;
      const res = lookup(L.id, theme, [roleName]);
      if (!res) continue;
      const pool = res.variants.filter((v) => v.weight > 0);
      const v = pick(pool.length ? pool : res.variants, `${L.id}:link:${lk.id}`);
      if (!v) continue;
      const f = facingOf(v, "link", res.role);
      const wdir = frame.worldSide(lk.dir);
      const steps = f.ascendsToward ? frame.stepsToFace(f.ascendsToward, wdir) : 0;
      if (lk.kind === "stairs" || lk.kind === "ramp") {
        const xs = lk.lowerCells.map((c) => c[0]);
        const ys = lk.lowerCells.map((c) => c[1]);
        const minX = Math.min(...xs),
          maxX = Math.max(...xs),
          minY = Math.min(...ys),
          maxY = Math.max(...ys);
        for (const [cx, cy] of lk.lowerCells) {
          const kIdx =
            lk.dir === "N" ? maxY - cy : lk.dir === "S" ? cy - minY : lk.dir === "E" ? cx - minX : maxX - cx;
          const c = V.cell(cx, cy);
          const lowerTop = c.floor ? topOf(c) : elev + 0.5;
          const rise = v.unitHeight;
          const m = frame.rectMin(cx, cy, 1, 1);
          if ((kIdx + 1) * rise <= lk.rise + EPS) {
            const base = lowerTop + kIdx * rise;
            if (base > lowerTop + EPS)
              stackFill(L.id, theme, c.material, cx, cy, lowerTop, base, "link", lk.id);
            emit(v, "link", m.x, base, m.z, steps * 15 + v.rot, { cell: [cx, cy], elementId: lk.id });
          } else {
            // landing: the rest of a non-integer rise as fill courses up to the upper floor top
            stackFill(L.id, theme, c.material, cx, cy, lowerTop, lowerTop + lk.rise, "link", lk.id);
          }
        }
      } else {
        // Vertical links (ladder, spiral stairs): ONE stack of the resolved asset, from the lower floor top until it
        // reaches the upper floor top. The count comes from the asset's height versus the real span (rise 2.5, 5.0,
        // …), never from the link kind. An asset smaller than the link's footprint (a ladder standing in for spiral
        // stairs) goes once, into a cell of the footprint against a wall when there is one.
        const xs = lk.lowerCells.map((c) => c[0]);
        const ys = lk.lowerCells.map((c) => c[1]);
        const rx = Math.min(...xs);
        const ry = Math.min(...ys);
        const rw = Math.max(...xs) - rx + 1;
        const rh = Math.max(...ys) - ry + 1;
        const coversLink = v.footprint[0] * v.footprint[1] >= lk.lowerCells.length;
        const walledSide = (x: number, y: number): boolean =>
          (["N", "E", "S", "W"] as const).some((s) => {
            const e =
              s === "N"
                ? V.hEdge(x, y)
                : s === "S"
                  ? V.hEdge(x, y + 1)
                  : s === "W"
                    ? V.vEdge(x, y)
                    : V.vEdge(x + 1, y);
            const g = s === "N" || s === "S" ? L.hEdges : L.vEdges;
            return e >= 0 && g.kind[e] === EDGE.WALL;
          });
        const sorted = [...lk.lowerCells].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
        const cell: readonly [number, number] = coversLink
          ? [rx, ry]
          : (sorted.find(([x, y]) => walledSide(x, y)) ?? sorted[0] ?? [rx, ry]);
        const [cx, cy] = cell;
        const w = coversLink ? rw : 1;
        const h = coversLink ? rh : 1;
        const c = V.cell(cx, cy);
        const base = c.floor ? topOf(c) : elev + 0.5;
        const upView = views.get(lk.toLevel);
        const upperTop = upView
          ? upView.L.elevation + upView.cell(cx, cy).height + 0.5
          : elev + c.height + 0.5 + lk.rise;
        const count = Math.max(1, Math.ceil((upperTop - base) / v.unitHeight - EPS));
        const deg = steps * 15 + v.rot;
        const src: Placement["source"] = { cell: [cx, cy], elementId: lk.id };
        if (res.role !== roleName && !coversLink) {
          addDiag({
            severity: "info",
            code: "asset_substituted",
            message: `${lk.kind === "spiral_stairs" ? "Spiral stairs" : `Link (${lk.kind})`} ${lk.id} built as ${v.name ?? res.role} in one cell: no ${roleName} asset in this palette`,
            levelId: L.id,
            elementId: lk.id,
            role: roleName,
          });
        }
        if (v.geom.originAt === "minCorner") {
          const m = frame.rectMin(cx, cy, w, h);
          for (let s = 0; s < count; s++) emit(v, "link", m.x, base + s * v.unitHeight, m.z, deg, src);
        } else {
          const centre = frame.point(cx + w / 2, cy + h / 2);
          const off = rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * frame.o.rotSense);
          for (let s = 0; s < count; s++)
            emit(v, "link", centre.x - off.x, base + s * v.unitHeight, centre.z - off.z, deg, src);
        }
      }
    }

    function placeHatch(lk: ResolvedPlan["links"][number]): void {
      const cell = lk.upperCells[0] ?? lk.arrival;
      const c = V.cell(cell[0], cell[1]);
      const res = lookup(L.id, lk.theme || c.theme, ["link.trapdoor"]);
      const pool = res ? res.variants.filter((u) => u.weight > 0) : [];
      const v = res ? pick(pool.length ? pool : res.variants, `${L.id}:hatch:${lk.id}`) : undefined;
      if (!v) return;
      const m = frame.rectMin(cell[0], cell[1], 1, 1);
      emit(v, "link", m.x, c.floor ? topOf(c) : elev + 0.5, m.z, v.rot, {
        cell: [cell[0], cell[1]],
        elementId: lk.id,
      });
    }

    /** True when any edge along `side` of the plan rect is a wall (or a door) edge. */
    const rectSideWalled = (x: number, y: number, w: number, h: number, side: Side): boolean => {
      const n = side === "N" || side === "S" ? w : h;
      for (let k = 0; k < n; k++) {
        const e =
          side === "N"
            ? V.hEdge(x + k, y)
            : side === "S"
              ? V.hEdge(x + k, y + h)
              : side === "W"
                ? V.vEdge(x, y + k)
                : V.vEdge(x + w, y + k);
        const g = side === "N" || side === "S" ? L.hEdges : L.vEdges;
        if (e >= 0 && (g.kind[e] === EDGE.WALL || g.kind[e] === EDGE.OPENING)) return true;
      }
      return false;
    };
    const wallFacing = new Set(orientation.wallFacingFeatures ?? []);

    // ── 5. features ──
    for (const f of L.features) placeFeature(f);

    function placeFeature(f: ResolvedFeature): void {
      const anchor = V.cell(f.at[0], f.at[1]);
      const theme = f.theme || anchor.theme;
      const roleName = `feature.${f.type}`;
      let v: ResolvedVariant | undefined;
      let rule = "facing";
      let resolvedRole: RoleName = roleName;
      if (f.type === "custom") {
        const hit = palettes.availability.search(f.hint ?? "", undefined)[0];
        if (!hit) {
          addDiag({
            severity: "warning",
            code: "custom_unresolved",
            message: `Custom feature "${f.hint ?? ""}" matched no asset${palettes.availability.search("chest").length === 0 ? " (no TaleSpire catalog loaded)" : ""}`,
            levelId: L.id,
            elementId: f.id,
          });
          return;
        }
        const g = hit.geom;
        v = {
          uuid: hit.uuid,
          wanted: hit.uuid,
          substituted: false,
          geom: g,
          name: hit.name,
          weight: 1,
          variant: undefined,
          footprint: footprintFromGeom(g),
          rot: 0,
          offset: { x: 0, y: 0, z: 0 },
          unitHeight: g.size.y,
          facing: undefined,
        };
      } else {
        const res = lookup(L.id, theme, [roleName]);
        if (!res) return;
        resolvedRole = res.role;
        rule = res.def.rotation ?? "facing";
        let pool = res.variants;
        if (f.variant !== undefined) {
          const m = res.variants.filter((u) => u.variant === f.variant);
          if (m.length) pool = m;
          else
            addDiag({
              severity: "info",
              code: "variant_unknown",
              message: `Variant "${f.variant}" not in "${res.role}"; default used`,
              levelId: L.id,
              role: roleName,
              elementId: f.id,
            });
        }
        v = pick(pool, `${L.id}:feature:${f.id}`);
      }
      if (!v) return;
      const fp = f.size;
      const facing = facingOf(v, "feature", resolvedRole);
      let deg: number;
      if (rule === "inherit" || rule === "random15") {
        const fine = rule === "inherit" ? f.rotFine : (h32(`${seed}:${f.id}:r15`) % 24) * 15;
        deg = frame.planDegreesToWorld(fine) + v.rot;
      } else if (rule === "random90") {
        deg = frame.stepsForQuarters(h32(`${seed}:${f.id}:r90`) % 4) * 15 + v.rot;
      } else if (rule === "fixed") {
        deg = v.rot;
      } else if (f.wall) {
        deg = frame.stepsToFace(facing.mountsOn ?? "S", frame.worldSide(f.wall)) * 15 + v.rot;
      } else {
        let wantPlan = rotateDir("S", Math.round(f.rot / 90));
        // "Against the wall" furniture never faces into a wall: turn it to face into the room.
        if (wallFacing.has(f.type) && rectSideWalled(f.at[0], f.at[1], f.size[0], f.size[1], wantPlan)) {
          const square = f.size[0] === f.size[1];
          const alt = [
            opposite(wantPlan),
            ...(square ? [rotateDir(wantPlan, 1), rotateDir(wantPlan, 3)] : []),
          ].find((s) => !rectSideWalled(f.at[0], f.at[1], f.size[0], f.size[1], s));
          if (alt) wantPlan = alt;
        }
        // asset front at rot 0 defaults to N (+z), verified on three assets (orientation.json defaultFacing.feature)
        deg = frame.stepsToFace(facing.front ?? "N", frame.worldSide(wantPlan)) * 15 + v.rot;
      }
      deg = ((deg % 360) + 360) % 360;
      // ResolvedFeature.baseHeight is ABSOLUTE: elevation + floor thickness + cell height + lift (resolver featureBase).
      const y = f.baseHeight;
      const src: Placement["source"] = { cell: [f.at[0], f.at[1]], elementId: f.id };
      // footprint check (quarter turns swap the asset's footprint)
      const quarter = Math.round(deg / 90) % 2 === 1;
      const afp = quarter ? [v.footprint[1], v.footprint[0]] : [v.footprint[0], v.footprint[1]];
      if (afp[0] !== fp[0] || afp[1] !== fp[1]) {
        addDiag({
          severity: "info",
          code: "footprint_mismatch",
          message: `"${v.name ?? v.uuid}" covers ${afp[0]}×${afp[1]} cells, feature is ${fp[0]}×${fp[1]}; centred on the feature`,
          levelId: L.id,
          role: roleName,
        });
      }
      if (f.wall) {
        // back of the asset on the mounting plane: the edge line, or the face of a strip hosted in this cell
        const s = f.wall;
        const px = s === "W" ? f.at[0] : s === "E" ? f.at[0] + 1 : f.at[0] + 0.5;
        const py = s === "N" ? f.at[1] : s === "S" ? f.at[1] + 1 : f.at[1] + 0.5;
        const grid = s === "N" || s === "S" ? L.hEdges : L.vEdges;
        const e =
          s === "N"
            ? V.hEdge(f.at[0], f.at[1])
            : s === "S"
              ? V.hEdge(f.at[0], f.at[1] + 1)
              : s === "W"
                ? V.vEdge(f.at[0], f.at[1])
                : V.vEdge(f.at[0] + 1, f.at[1]);
        const hostedHere =
          e >= 0 &&
          (grid.host[e] ?? 1) === (s === "N" || s === "W" ? 1 : 0) &&
          (grid.kind[e] === EDGE.WALL || grid.kind[e] === EDGE.OPENING);
        // centred props (banners, paintings) are pushed off the wall by half their depth so the back touches it;
        // "other"-origin props (wall torch, wall lever) are authored with the origin on their back face.
        const mountAxisDepth =
          facing.mountsOn === "E" || facing.mountsOn === "W" ? v.geom.size.x : v.geom.size.z;
        const inward = (hostedHere ? 0.5 : 0) + (v.geom.originAt === "center" ? mountAxisDepth / 2 : 0);
        const ix = s === "W" ? inward : s === "E" ? -inward : 0;
        const iy = s === "N" ? inward : s === "S" ? -inward : 0;
        const p = frame.point(px + ix, py + iy);
        emit(v, "feature", p.x, y, p.z, deg, src);
        return;
      }
      if (v.geom.originAt === "minCorner") {
        const m = frame.rectMin(f.at[0], f.at[1], fp[0], fp[1]);
        emit(v, "feature", m.x, y, m.z, deg, src);
        return;
      }
      const c = frame.point(f.at[0] + fp[0] / 2, f.at[1] + fp[1] / 2);
      const off = rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * frame.o.rotSense);
      emit(v, "feature", c.x - off.x, y, c.z - off.z, deg, src);
    }

    // deterministic order: role, then source cell (y, x), then emission order
    const order = new Map(ROLE_ORDER.map((r, i) => [r, i]));
    const indexed = placements.map((p, i) => ({ p, i }));
    indexed.sort(
      (a, b) =>
        (order.get(a.p.role) ?? 99) - (order.get(b.p.role) ?? 99) ||
        (a.p.source.cell?.[1] ?? 0) - (b.p.source.cell?.[1] ?? 0) ||
        (a.p.source.cell?.[0] ?? 0) - (b.p.source.cell?.[0] ?? 0) ||
        a.i - b.i,
    );
    outLevels.push({ levelId: L.id, placements: indexed.map((x) => x.p) });
    growBox(allBox, levelBox);
    levelInfo.push({
      levelId: L.id,
      elevation: elev,
      bounds: finiteBox(levelBox),
      cellBounds: { ...L.bounds },
    });
  }

  // alignment marker asset
  const mres = lookup(resolved.levels[0]?.id ?? "", defaultTheme, ["marker.alignment"], undefined, true);
  const mv = mres?.variants[0];

  const byRole = Object.fromEntries(ROLE_ORDER.map((r) => [r, 0])) as Record<PlacementRole, number>;
  const assets = new Set<string>();
  let total = 0;
  for (const l of outLevels) {
    for (const p of l.placements) {
      byRole[p.role]++;
      assets.add(p.asset);
      total++;
    }
  }
  for (const s of subs.values()) {
    addDiag(
      {
        severity: s.used ? "info" : "warning",
        code: s.used ? "asset_substituted" : "asset_unknown",
        message: s.used
          ? `"${s.wanted.name ?? s.wanted.uuid}" is not available in your TaleSpire; "${s.used.name ?? s.used.uuid}" used instead`
          : `"${s.wanted.name ?? s.wanted.uuid}" is not available in your TaleSpire and has no substitute`,
        role: s.role,
      },
      s.count,
    );
  }
  const diagnostics = [...diag.values()];
  return {
    planId: resolved.planId,
    planVersion: resolved.planVersion,
    levels: outLevels,
    bounds: finiteBox(allBox),
    diagnostics,
    stats: { byRole, total, distinctAssets: assets.size },
    substitutions: [...subs.values()],
    assetSource:
      palettes.availability.status("00000000-0000-0000-0000-000000000000") === null ? "builtin" : "install",
    marker: mv ? { uuid: mv.uuid, geom: mv.geom } : null,
    levelInfo,
    resolvedHash: resolved.hash,
  };
}
