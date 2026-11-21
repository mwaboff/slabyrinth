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
import { stallPieceOf } from "../gen/market";
import { featureRoles } from "../gen/surfaces";
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
import { areaReferenceHeights, wallSpan } from "../resolve/wallspan";
import { realizeStructures, structureClaims } from "./structure";
import { realizeStall } from "./stalls";
import { SHELL, planShell } from "./shell";
import { ValueNoise } from "../gen/noise";
import { cliffRockKinds, edgeHidden, type RockShape } from "../gen/cover";
import { planCaveWall, type WallFace, type WallShape } from "../gen/cavewall";
import { axisPosition } from "../resolve/road";
import { roughCells } from "../resolve/wallTops";
import { createFamilyPicker, familiesOfVariants, type FloorFamily } from "../resolve/floorFamilies";
import { OBSERVED_TONES } from "../review/tones";
import { generatorProfile } from "../plan/generator";

/** Rock band (generator 2, themes with cliff.formation_face): rise that gets a band, and how far it reaches. */
const BAND = { minRiseQ: 8, out: 2, back: 2 } as const;

/** Road markings (generator 2 roads): sparse drains along the kerb, data rather than code. */
const ROAD_MARKINGS = {
  drain: {
    /** Cells from the start of a kerb line to the first drain (seeded within this range). */
    first: [5, 14],
    /** Cells between drains (seeded within this range per gap). */
    every: [20, 30],
    /** Kerb lines shorter than this get none; shorter than every[0], one with this chance. */
    minLine: 8,
    shortChance: 0.4,
  },
} as const;

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
  /**
   * Paste layers to leave out (Placement.layer): "roof" drops roofs, attic decks, gable fill and attachment roofs
   * (a see-inside build); "storey:2" drops one storey. Absent = everything.
   */
  omitLayers?: string[];
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
    /** Intended water surface (absolute tiles), when the level has water (ResolvedLevel.waterLevel). */
    waterLevel?: number;
    /** Range the surface may be set in: a quarter above the highest bed to a quarter below the lowest bank (absolute tiles). */
    waterRange?: [number, number];
  }>;
  resolvedHash: string;
}

const NONE = 0xffff;
/** Opening roles whose asset is a full-height wall piece (no lintel above them). */
const NO_LINTEL = new Set(["opening.archway", "opening.window", "opening.arrow_slit"]);
const opposite = (s: Side): Side => (s === "N" ? "S" : s === "S" ? "N" : s === "E" ? "W" : "E");
const EPS = 1e-6;
/** Natural ground whose drops of a tile or more are built as rock cliffs when the palette has no cliff.<material> role. */
/** Water surface range of a level: a quarter tile above its highest water bed to a quarter below its lowest dry bank. */
function waterRangeOf(L: ResolvedLevel): [number, number] {
  const { w, h } = L.bounds;
  const top = (i: number): number => L.elevation + (L.cells.height[i] ?? 0) / 4 + 0.5;
  const floor = (i: number): boolean =>
    L.cells.state[i] === CELL.OPEN && ((L.cells.flags[i] ?? 0) & CELL_FLAG.NO_FLOOR) === 0;
  const wet = (i: number): boolean => ((L.cells.flags[i] ?? 0) & CELL_FLAG.WATER) !== 0;
  let bed = -Infinity;
  let bank = Infinity;
  for (let i = 0; i < w * h; i++) {
    if (!floor(i) || !wet(i)) continue;
    bed = Math.max(bed, top(i));
    const x = i % w;
    for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1])
      if (j >= 0 && j < w * h && floor(j) && !wet(j)) bank = Math.min(bank, top(j));
  }
  const lo = bed + 0.25;
  return [lo, Number.isFinite(bank) ? Math.max(lo, bank - 0.25) : lo];
}

/** Upright feature types whose assets are mixed along a run (see runPicks). */
const RUN_MIX = new Set([
  "cluster_tall",
  "formation",
  "boulder",
  "tree",
  "pine_tree",
  "dead_tree",
  "stalagmite",
  "edge_dressing",
  "undergrowth",
  "standing_stone",
  "monolith",
  "vehicle",
]);

/**
 * Floor families that only grow where something causes them (owner's v6 and watchtower runs, 2026-11-20: reddish
 * leaf-litter squares scattered over open grass): under trees, along paths, at the foot of a rise, round a camp.
 */
const CAUSED_FAMILIES = new Set(["lush"]);
/** Natural standing pieces that must never be built from wall blocks (generator 3). */
/** Loose rock that follows the tone of a cliff beside it (generator 3). */
const CLIFF_DRESSING = new Set(["formation", "rock_formation", "boulder", "rock"]);
const NATURAL_STANDING =new Set(["cluster_tall", "formation", "landmark", "rock_formation", "tall_marker"]);

/** Features that cause litter and worn ground round them. */
const CAUSE_FEATURES = new Set([
  "cluster_tall",
  "tree",
  "pine_tree",
  "dead_tree",
  "tree_large",
  "campfire",
  "fire_pit",
  "tent",
]);

/** Water materials: TaleSpire's water is a board-wide plane, so the slab carries the channel's bed. */
const WATER = new Set(["water_shallow", "water_deep"]);
const NATURAL_GROUND = new Set([
  "rock",
  "dirt",
  "gravel",
  "mud",
  "sand",
  "grass",
  "snow",
  "ice",
  "swamp",
  "lava",
]);

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
  // what the plan's generator does (plan/generator.ts); palette roles carry their own first generator (minGenerator)
  const gen = generatorProfile(resolved);
  const resolveRole = createRoleResolver(palettes, resolved.generator);
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

  /**
   * Floor variants in organic patches (2026-11-19): a value-noise field (about 5 cells across) picks the variant by
   * its weight band, with a little per-tile jitter, so variants form patches instead of a salt-and-pepper grid.
   */
  const patchNoise = new ValueNoise(h32(`${seed}:floorpatches`));
  const pickPatch = (
    vs: ResolvedVariant[],
    x: number,
    y: number,
    key: string,
  ): ResolvedVariant | undefined => {
    const weighted = vs.filter((v) => v.weight > 0);
    if (weighted.length <= 1) return pick(vs, key);
    const total = weighted.reduce((sum, v) => sum + v.weight, 0);
    const jitter = (h32(`${seed}:${key}:j`) / 0x100000000 - 0.5) * 0.15;
    let r = Math.min(0.9999, Math.max(0, patchNoise.sample(x / 5, y / 5) + jitter)) * total;
    for (const v of weighted) {
      r -= v.weight;
      if (r < 0) return v;
    }
    return weighted[weighted.length - 1];
  };

  /**
   * Floor families (round 5, 2026-11-20): a floor role's weighted variants that carry a `variant` name form a family
   * each (untagged variants are the default family) — rock slab, dark rock, packed earth, gravel; short and lush
   * grass. A coarse value-noise field (about 7 cells across, stretched so every family shows) gives each cell one
   * family, so the floor reads as large irregular patches of different ground instead of one tile on a grid. Each
   * family's share is its heaviest variant's weight. Roles without tagged variants behave as before.
   */
  const familyNoise = new ValueNoise(h32(`${seed}:floorfamilies`));
  const familyWarp = new ValueNoise(h32(`${seed}:floorfamilies:warp`));
  const familiesOf = (vs: ResolvedVariant[]): FloorFamily[] =>
    familiesOfVariants(vs, (uuid) => OBSERVED_TONES[uuid]?.tone);
  const familyAt = (fams: Array<{ name: string; share: number }>, x: number, y: number): string => {
    if (fams.length <= 1) return fams[0]?.name ?? "";
    const total = fams.reduce((t, q) => t + q.share, 0);
    const wx = (familyWarp.sample(x / 4, y / 4) - 0.5) * 3;
    const raw = familyNoise.sample((x + wx) / 7, (y - wx) / 7);
    let r = Math.min(0.9999, Math.max(0, (raw - 0.5) * 1.9 + 0.5)) * total;
    for (const q of fams) {
      r -= q.share;
      if (r < 0) return q.name;
    }
    return fams[fams.length - 1]?.name ?? "";
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
    /**
     * Upright pieces already realized per role, for the run mix (round 5): along a row or column, a piece does not
     * take an asset a neighbour within three cells already shows (a row of identical cypresses read
     * as a planted hedge), when its role has another weighted asset.
     */
    const runPicks = new Map<string, Array<{ x: number; y: number; uuid: string }>>();
    const levelBox = emptyBox();
    const outcropCells = new Set((L.outcrops ?? []).flatMap((o) => o.cells.map(([x, y]) => `${x},${y}`)));
    const waterCells: Array<[number, number]> = [];
    const bedNoted = new Set<string>();
    let kerbNoted = false;
    /** Seeded quarter turn for square whole-cell blocks (mixes up repeated rock faces). */
    const blockTurn = (v: ResolvedVariant, key: string): number =>
      Math.abs(v.geom.size.x - v.geom.size.z) < 0.05 ? (h32(`${seed}:${L.id}:turn:${key}`) % 4) * 90 : 0;
    const elev = L.elevation;
    const topOf = (c: CellInfo): number => elev + c.height + 0.5;
    const roadAxisAt = new Map<string, "h" | "v">();
    for (const rd of L.roads ?? [])
      for (const [x, y] of rd.carriageway) roadAxisAt.set(`${x},${y}`, axisPosition(rd.axis, x, y).dir);

    const emit = (
      v: ResolvedVariant,
      role: PlacementRole,
      x: number,
      y: number,
      z: number,
      rotDeg: number,
      source: Placement["source"],
      layer?: string,
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
      if (layer !== undefined) p.layer = layer;
      const box = placementBox(v.geom, p.x, p.y, p.z, rot * orientation.rotSense);
      placementBoxes.set(p, box);
      placementMeta.set(p, { name: v.name ?? palettes.availability.name(v.uuid) ?? v.uuid, geom: v.geom });
      growBox(levelBox, box);
      placements.push(p);
    };

    // ── 1. floors (greedy tiling) and 2. fill ──
    // crossing cells take the theme's crossing tile (marking.crossing) AS their floor tile, turned by the road
    // axis: a thick striped tile laid on top of the road would stand as a step
    // where caused floor families may grow: within two cells of a tree, a camp, a path or the foot of a rise
    const causeDist = new Map<string, number>();
    {
      const src: Array<[number, number]> = [];
      for (const f of L.features)
        if (CAUSE_FEATURES.has(f.type))
          for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
            for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) src.push([x, y]);
      for (let ly = 0; ly < V.h; ly++)
        for (let lx = 0; lx < V.w; lx++) {
          const x = L.bounds.x + lx;
          const y = L.bounds.y + ly;
          const c = V.cell(x, y);
          if (!c.floor) continue;
          const i = ly * V.w + lx;
          if (((L.cells.flags[i] ?? 0) & CELL_FLAG.PATH) !== 0) src.push([x, y]);
          else if (
            [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ].some(([dx, dy]) => {
              const n = V.cell(x + (dx as number), y + (dy as number));
              return n.floor && n.height - c.height >= 0.5;
            })
          )
            src.push([x, y]);
        }
      for (const [sx, sy] of src)
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const k = `${sx + dx},${sy + dy}`;
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            if ((causeDist.get(k) ?? 9) > d) causeDist.set(k, d);
          }
    }
    /** The cell's floor family: caused families only near their cause, with a feathered, noisy edge. */
    // generator 3: one dominant family, a tonally close second only in feathered patches with a cause
    const pickFamily = gen.floorFamilies ? createFamilyPicker(L, seed) : null;
    const famAt = (fams: FloorFamily[], x: number, y: number): string => {
      if (pickFamily) return pickFamily(fams, x, y);
      const caused = fams.filter((q) => CAUSED_FAMILIES.has(q.name));
      if (caused.length === 0) return familyAt(fams, x, y);
      const d = causeDist.get(`${x},${y}`) ?? 9;
      const j = familyWarp.sample(x / 2.5 + 11, y / 2.5 + 3);
      if ((d === 0 && j > 0.45) || (d === 1 && j > 0.62) || (d === 2 && j > 0.8))
        return (caused[0] as { name: string }).name;
      return familyAt(
        fams.filter((q) => !CAUSED_FAMILIES.has(q.name)),
        x,
        y,
      );
    };
    const crossingAxis = new Map<string, "h" | "v">();
    for (const rd of L.roads ?? [])
      for (const cr of rd.crossings) for (const [x, y] of cr.cells) crossingAxis.set(`${x},${y}`, cr.axis);
    const used = new Set<number>();
    // rock band (generator 2): where the theme has the formation roles, natural cliff runs of 2 tiles or more are
    // faced by the dressing's rock band. Under the band the low ground is rock floor (about 2 cells out), the face has
    // no 1×1 blocks and the cells behind the edge (about 2 back) no hidden fill.
    const bandThemes = new Map<string, boolean>();
    const hasBand = (theme: ThemeId): boolean => {
      let b = bandThemes.get(theme);
      if (b === undefined) {
        b = Boolean(lookup(L.id, theme, ["cliff.formation_face"], undefined, true));
        bandThemes.set(theme, b);
      }
      return b;
    };
    // generator 3: one rock tone per cliff (gen/cover.ts cliffRockKinds): a kind of rock with no piece in the cliff's
    // tone is not built (its drops get the plain block face), and the dressing rock near a cliff follows the tone
    const kindMemo = new Map<ThemeId, ReturnType<typeof cliffRockKinds>>();
    const cliffKinds = (theme: ThemeId): ReturnType<typeof cliffRockKinds> => {
      if (!gen.cliffToneRule) return { face: true, crest: true };
      let k = kindMemo.get(theme);
      if (k === undefined) {
        const vs = (role: string): readonly ResolvedVariant[] =>
          lookup(L.id, theme, [role], undefined, true)?.variants ?? [];
        k = cliffRockKinds(vs("cliff.formation_face"), vs("cliff.formation_crest"));
        kindMemo.set(theme, k);
      }
      return k;
    };
    /** Boulders of a tone the theme's boulder role lacks (role cliff.formation_crest_<tone>), for cliffs and rock beside them. */
    const toneBoulders = (theme: ThemeId, tone: string): readonly ResolvedVariant[] =>
      (lookup(L.id, theme, [`cliff.formation_crest_${tone}`], undefined, true)?.variants ?? []).filter(
        (u) => u.weight > 0,
      );
    let cliffCells: Set<string> | undefined;
    /** Is the cell within 3 cells of a band rock (generator 3)? */
    const nearCliff = (x: number, y: number): boolean => {
      if (cliffCells === undefined) {
        cliffCells = new Set();
        for (const q of L.features) {
          if (q.type !== "cliff_face" && q.type !== "cliff_crest") continue;
          for (let dy = -3; dy < q.size[1] + 3; dy++)
            for (let dx = -3; dx < q.size[0] + 3; dx++) cliffCells.add(`${q.at[0] + dx},${q.at[1] + dy}`);
        }
      }
      return cliffCells.has(`${x},${y}`);
    };
    const bandLow = new Set<string>();
    const bandBack = new Set<string>();
    /** Upper cells of a band edge the band left bare: they get a face block of one family. */
    const bandBare = new Set<string>();
    // generator 3: the rocks as they stand (real outline, turn, slide, vertical span), to test what hides a face
    const restingBand = gen.restingCliffBand;
    const rockShapes: RockShape[] = [];
    if (restingBand) {
      const extent = (
        theme: ThemeId,
        role: string,
        tall: boolean,
      ): { w: number; d: number; h: number } | undefined => {
        const r = lookup(L.id, theme, [role], undefined, true);
        const vs = (r?.variants ?? []).filter((q) => q.weight > 0 && (!tall || q.geom.size.y >= 1.2));
        const v = [...vs].sort((a, b) => b.weight - a.weight)[0];
        return v ? { w: v.geom.size.x, d: v.geom.size.z, h: v.geom.size.y } : undefined;
      };
      for (const f of L.features) {
        if (f.type !== "cliff_face" && f.type !== "cliff_crest") continue;
        if (!cliffKinds(f.theme)[f.type === "cliff_face" ? "face" : "crest"]) continue;
        const ext =
          f.type === "cliff_face"
            ? extent(f.theme, "cliff.formation_face", false)
            : extent(f.theme, "cliff.formation_crest", true);
        if (!ext) continue;
        rockShapes.push({
          cx: f.at[0] + f.size[0] / 2 + (f.offset?.[0] ?? 0),
          cy: f.at[1] + f.size[1] / 2 + (f.offset?.[1] ?? 0),
          rot: f.rotFine,
          w: ext.w,
          d: ext.d,
          base: f.baseHeight,
          top: f.baseHeight + ext.h,
        });
      }
    }
    if (gen.cliffRockBand)
      for (const run of L.cliffs ?? [])
        for (const e of run.edges) {
          if (e.high - e.low < (restingBand ? 4 : BAND.minRiseQ)) continue;
          const c0 = V.cell(e.at[0], e.at[1]);
          if (!hasBand(c0.theme)) continue;
          const [dx, dy] =
            e.side === "N" ? [0, -1] : e.side === "S" ? [0, 1] : e.side === "E" ? [1, 0] : [-1, 0];
          const tallEdge = e.high - e.low >= BAND.minRiseQ;
          if (tallEdge) {
            for (let k = 1; k <= BAND.out; k++) bandLow.add(`${e.at[0] + dx * k},${e.at[1] + dy * k}`);
            for (let k = 0; k < BAND.back; k++) bandBack.add(`${e.at[0] - dx * k},${e.at[1] - dy * k}`);
          }
          // what the band actually placed: an edge with no rock over its midpoint keeps a face behind it (no hole)
          const mx = e.at[0] + 0.5 + dx * 0.5;
          const my = e.at[1] + 0.5 + dy * 0.5;
          const base = L.elevation + 0.5;
          const covered = restingBand
            ? edgeHidden(
                rockShapes,
                mx,
                my,
                dy !== 0 ? 1 : 0,
                dx !== 0 ? 1 : 0,
                base + e.low / 4,
                base + e.high / 4,
              )
            : L.features.some(
                (f) =>
                  (f.type === "cliff_face" || f.type === "cliff_crest") &&
                  cliffKinds(f.theme)[f.type === "cliff_face" ? "face" : "crest"] &&
                  mx >= f.at[0] - 0.3 &&
                  mx <= f.at[0] + f.size[0] + 0.3 &&
                  my >= f.at[1] - 0.3 &&
                  my <= f.at[1] + f.size[1] + 0.3,
              );
          if (!covered) bandBare.add(`${e.at[0]},${e.at[1]}`);
        }
    /** Floor material as laid: natural low ground under a rock band is rock. */
    const laidMaterial = (c: CellInfo, x: number, y: number): string | null =>
      c.material !== null && NATURAL_GROUND.has(c.material) && bandLow.has(`${x},${y}`) ? "rock" : c.material;
    const keyOf = (c: CellInfo, x: number, y: number): string =>
      `${c.theme}|${laidMaterial(c, x, y) ?? ""}|${c.height}`;
    for (let ly = 0; ly < V.h; ly++) {
      for (let lx = 0; lx < V.w; lx++) {
        const x = L.bounds.x + lx;
        const y = L.bounds.y + ly;
        const c = V.cell(x, y);
        if (!c.floor || used.has(ly * V.w + lx)) continue;
        // outcrops are solid rock columns (built in the cliff pass), not floor tiles
        if (outcropCells.has(`${x},${y}`)) {
          used.add(ly * V.w + lx);
          continue;
        }
        // water: TaleSpire's water is the board's water plane; the slab carries the channel's bed (+ optional surface)
        if (c.material !== null && WATER.has(c.material)) {
          used.add(ly * V.w + lx);
          waterCells.push([x, y]);
          continue;
        }
        const crossAxis = crossingAxis.get(`${x},${y}`);
        if (crossAxis !== undefined) {
          const cr = lookup(
            L.id,
            c.theme,
            ["marking.crossing"],
            { key: "1x1", test: (q) => q.footprint[0] === 1 && q.footprint[1] === 1 },
            true,
          );
          const cv = cr ? pick(cr.variants, `${L.id}:crossing:${x}:${y}`) : undefined;
          if (cv) {
            used.add(ly * V.w + lx);
            const m = frame.rectMin(x, y, 1, 1);
            emit(cv, "floor", m.x, topOf(c) - cv.geom.size.y, m.z, (crossAxis === "h" ? 0 : 90) + cv.rot, {
              cell: [x, y],
              elementId: "crossing",
            });
            continue;
          }
        }
        const role = `floor.${laidMaterial(c, x, y) ?? ""}`;
        const res = lookup(L.id, c.theme, [role]);
        if (!res) {
          used.add(ly * V.w + lx);
          continue;
        }
        const greedy = res.def.greedyTiling !== false;
        // families on natural ground only: built floors (flagstone, planks) keep their regular laying
        const fams = c.material !== null && NATURAL_GROUND.has(c.material) ? familiesOf(res.variants) : [];
        const fam = famAt(fams, x, y);
        const inFam = (v: ResolvedVariant): boolean => fams.length <= 1 || (v.variant ?? "") === fam;
        const fps = [
          ...new Set(
            res.variants
              .filter((v) => v.weight > 0 || res.variants.every((u) => u.weight <= 0))
              .filter((v) => inFam(v) || (v.variant ?? "") === "")
              .map((v) => `${v.footprint[0]}x${v.footprint[1]}`),
          ),
        ]
          .map((s) => s.split("x").map(Number) as [number, number])
          .filter(([w, h]) => greedy || (w === 1 && h === 1))
          .sort((a, b) => b[0] * b[1] - a[0] * a[1] || b[0] - a[0]);
        // generator 3: a 1x2 piece may lie either way (turned a quarter), the way round chosen per cell from the seed, so
        // a field of them is not all one orientation
        if (gen.turnedFloorTiles && greedy)
          for (const [fw0, fh0] of [...fps])
            if (fw0 !== fh0 && !fps.some(([a, b]) => a === fh0 && b === fw0)) fps.push([fh0, fw0]);
        if (gen.turnedFloorTiles && greedy) {
          const flip = h32(`${seed}:${L.id}:floororient:${x}:${y}`) % 2 === 1;
          fps.sort((a, b) => b[0] * b[1] - a[0] * a[1] || (flip ? a[0] - b[0] : b[0] - a[0]));
        }
        const k0 = keyOf(c, x, y);
        // road carriageway tiles keep one orientation along the road's axis (markings on the tiles line up)
        const roadDir = roadAxisAt.get(`${x},${y}`);
        let placed = false;
        for (const [fw, fh] of fps.length ? fps : [[1, 1] as [number, number]]) {
          let fits = lx + fw <= V.w && ly + fh <= V.h;
          for (let dy = 0; fits && dy < fh; dy++) {
            for (let dx = 0; fits && dx < fw; dx++) {
              const cc = V.cell(x + dx, y + dy);
              if (!cc.floor || used.has((ly + dy) * V.w + lx + dx) || keyOf(cc, x + dx, y + dy) !== k0)
                fits = false;
              else if (fams.length > 1 && famAt(fams, x + dx, y + dy) !== fam) fits = false;
            }
          }
          if (!fits) continue;
          // a candidate with no variant of that footprint but one of the transposed footprint lays that piece turned
          const ownOf = (a: number, b: number): ResolvedVariant[] =>
            res.variants.filter(
              (u) =>
                u.footprint[0] === a && u.footprint[1] === b && u.weight > 0 && (inFam(u) || (u.variant ?? "") === ""),
            );
          const turned = gen.turnedFloorTiles && fw !== fh && ownOf(fw, fh).length === 0 && ownOf(fh, fw).length > 0;
          const sized = res.variants.filter((u) =>
            turned ? u.footprint[0] === fh && u.footprint[1] === fw : u.footprint[0] === fw && u.footprint[1] === fh,
          );
          // the cell's family. A family without a piece of this size tries its own smaller pieces first; one with
          // nothing smaller (a meadow made only of 8×8 tiles) uses the default family's piece of this size
          const famSized = sized.filter((u) => inFam(u) && u.weight > 0);
          if (
            famSized.length === 0 &&
            fams.length > 1 &&
            res.variants.some((u) => inFam(u) && u.weight > 0 && u.footprint[0] * u.footprint[1] < fw * fh)
          )
            continue;
          const v = pickPatch(
            famSized.length ? famSized : sized.filter((u) => (u.variant ?? "") === ""),
            x,
            y,
            `${L.id}:floor:${x}:${y}`,
          );
          if (!v) continue;
          for (let dy = 0; dy < fh; dy++) for (let dx = 0; dx < fw; dx++) used.add((ly + dy) * V.w + lx + dx);
          const m = frame.rectMin(x, y, fw, fh);
          const rule = res.def.rotation ?? "random90";
          const r = h32(`${seed}:${L.id}:floorrot:${x}:${y}`);
          const steps =
            roadDir !== undefined
              ? roadDir === "h"
                ? 0
                : 6
              : rule === "fixed"
                ? 0
                : fw === fh
                  ? rule === "random90" || rule === "random15"
                    ? (r % 4) * 6
                    : 0
                  : (r % 2) * 12 + (turned ? 6 : 0);
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
    // road markings (generator 2 roads): marking.crossing on crossing cells, an occasional marking.drain on the
    // carriageway beside the kerb; optional roles, the road is complete without them
    for (const rd of L.roads ?? []) {
      const one: VariantFilter = { key: "1x1", test: (q) => q.footprint[0] === 1 && q.footprint[1] === 1 };
      const mark = (role: string, x: number, y: number, dir: "h" | "v", tag: string): boolean => {
        const c = V.cell(x, y);
        const res = lookup(L.id, c.theme, [role], one, true);
        const v = res ? pick(res.variants, `${L.id}:${tag}:${x}:${y}`) : undefined;
        if (!v) return false;
        const m = frame.rectMin(x, y, 1, 1);
        emit(v, "floor", m.x, topOf(c), m.z, (dir === "h" ? 0 : 90) + v.rot, {
          cell: [x, y],
          elementId: tag,
        });
        return true;
      };
      // crossings are laid as floor tiles in the floor pass
      for (const kl of rd.kerbLines) {
        const [dx, dy] =
          kl.side === "N" ? [0, -1] : kl.side === "S" ? [0, 1] : kl.side === "E" ? [1, 0] : [-1, 0];
        const n = Math.max(Math.abs(kl.to[0] - kl.from[0]), Math.abs(kl.to[1] - kl.from[1])) + 1;
        const sx = Math.sign(kl.to[0] - kl.from[0]);
        const sy = Math.sign(kl.to[1] - kl.from[1]);
        // sparse, irregular drains (ROAD_MARKINGS): a seeded gap from the start of the kerb line, then a jittered
        // spacing; a line shorter than the minimum spacing gets one at most, and only sometimes
        const D = ROAD_MARKINGS.drain;
        let h = h32(`${seed}:${L.id}:drain:${kl.from[0]},${kl.from[1]}:${kl.side}`);
        if (n < D.minLine || (n < D.every[0] && h % 100 >= D.shortChance * 100)) continue;
        for (let t = D.first[0] + (h % (D.first[1] - D.first[0] + 1)); t < n - 1;) {
          const x = kl.from[0] + sx * t + dx;
          const y = kl.from[1] + sy * t + dy;
          if (!mark("marking.drain", x, y, kl.side === "N" || kl.side === "S" ? "h" : "v", "drain")) break;
          h = h32(`${h}`);
          t += D.every[0] + (h % (D.every[1] - D.every[0] + 1));
        }
      }
    }
    // water beds: bed.<water material> → bed.default → the floor of the bank beside it (never an open void)
    for (const [x, y] of waterCells) {
      const c = V.cell(x, y);
      const one: VariantFilter = { key: "1x1", test: (q) => q.footprint[0] === 1 && q.footprint[1] === 1 };
      let res = lookup(L.id, c.theme, [`bed.${c.material ?? ""}`, "bed.default"], one, true);
      if (!res) {
        let bank: string | null = null;
        for (const [nx, ny] of [
          [x, y - 1],
          [x + 1, y],
          [x, y + 1],
          [x - 1, y],
        ] as const) {
          const n = V.cell(nx, ny);
          if (n.floor && n.material !== null && !WATER.has(n.material)) bank = bank ?? n.material;
        }
        res = lookup(L.id, c.theme, ["floor.gravel", `floor.${bank ?? "rock"}`, "fill.default"], one, true);
        if (!bedNoted.has(`${c.theme}|${c.material}`)) {
          bedNoted.add(`${c.theme}|${c.material}`);
          addDiag({
            severity: "warning",
            code: "asset_substituted",
            message: `No bed piece for ${c.material} in theme "${c.theme}" (bed.${c.material}, bed.default): the channel is floored with ${res?.role ?? "nothing"}`,
            levelId: L.id,
            role: `bed.${c.material}`,
          });
        }
      }
      const v = res ? pick(res.variants, `${L.id}:bed:${x}:${y}`) : undefined;
      if (v) {
        const m = frame.rectMin(x, y, 1, 1);
        const steps = (h32(`${seed}:${L.id}:floorrot:${x}:${y}`) % 4) * 6;
        emit(v, "floor", m.x, topOf(c) - v.geom.size.y, m.z, steps * 15 + v.rot, {
          cell: [x, y],
          elementId: "bed",
        });
      }
      // optional surface piece, only where the palette has one (water.<material>)
      const wr = lookup(L.id, c.theme, [`water.${c.material ?? ""}`], one, true);
      const wv = wr ? pick(wr.variants, `${L.id}:water:${x}:${y}`) : undefined;
      if (wv) {
        const m = frame.rectMin(x, y, 1, 1);
        emit(wv, "floor", m.x, topOf(c), m.z, wv.rot, { cell: [x, y], elementId: "water" });
      }
    }
    // the ground under bridge decks: its floor tile, and its height for the cliff faces around it
    const groundUnder = new Map<string, number>();
    const cliffNoted = new Set<string>();
    for (const b of L.bridges ?? []) {
      b.cells.forEach(([bx, by], j) => {
        const uq = b.under[j] ?? b.deck;
        groundUnder.set(`${bx},${by}`, uq / 4);
        const mat = b.underMaterial[j] ?? null;
        if (mat === null || uq >= b.deck) return;
        const c = V.cell(bx, by);
        const role = `floor.${mat}`;
        // the default family (untagged variants): patch families are for open floors
        const res = lookup(L.id, c.theme, [role], {
          key: "1x1plain",
          test: (v) => v.footprint[0] === 1 && v.footprint[1] === 1 && (v.variant ?? "") === "",
        });
        const v = res ? pick(res.variants, `${L.id}:under:${bx}:${by}`) : undefined;
        if (!v) return;
        const m = frame.rectMin(bx, by, 1, 1);
        const steps = (h32(`${seed}:${L.id}:floorrot:${bx}:${by}`) % 4) * 6;
        emit(v, "floor", m.x, elev + uq / 4 + 0.5 - v.geom.size.y, m.z, steps * 15 + v.rot, {
          cell: [bx, by],
          elementId: `floor:${role}`,
        });
      });
    }
    /** Height of the ground a neighbour presents to a raised cell (open cells, floorless ones included, and the ground under decks). */
    // Generator 2: the level stands on a solid foundation down to its lowest floor, so outside the level bounds the
    // ground is that low and cells on the border get solid sides (raised land has thickness seen from the side).
    let levelLowest = 0;
    for (let i = 0; i < V.w * V.h; i++)
      if (L.cells.state[i] === CELL.OPEN) levelLowest = Math.min(levelLowest, (L.cells.height[i] ?? 0) / 4);
    for (const b of L.bridges ?? []) for (const q of b.under) levelLowest = Math.min(levelLowest, q / 4);
    const outsideGround = gen.foundation ? Math.min(levelLowest, -(L.foundation ?? 0)) : 0;
    const groundOf = (x: number, y: number): number => {
      const g = groundUnder.get(`${x},${y}`);
      if (g !== undefined) return g;
      if (!V.inBounds(x, y)) return outsideGround;
      const n = V.cell(x, y);
      return n.open ? n.height : 0;
    };
    // fill under raised cells; drops of a tile or more get a cliff face (ledge role / natural rock) instead
    for (let ly = 0; ly < V.h; ly++) {
      for (let lx = 0; lx < V.w; lx++) {
        const x = L.bounds.x + lx;
        const y = L.bounds.y + ly;
        const c = V.cell(x, y);
        if (!c.floor || (c.flags & CELL_FLAG.BRIDGE) !== 0) continue; // decks have open air beneath
        const minN = Math.min(groundOf(x, y - 1), groundOf(x + 1, y), groundOf(x, y + 1), groundOf(x - 1, y));
        if (outcropCells.has(`${x},${y}`)) {
          // a rock column from the ground around it up to its top (no floor tile): reads as rock, not a tiled box
          if (!cliffFace(c.theme, c.material, x, y, elev + Math.min(minN, 0), elev + c.height + 0.5, true))
            stackFill(L.id, c.theme, c.material, x, y, elev + Math.min(minN, 0), elev + c.height + 0.5);
          continue;
        }
        if (c.height <= minN + EPS) continue;
        // generator 4: a floor raised no more than its own slab (half a tile) over every neighbour abuts the neighbour's
        // slab, so nothing shows under it and no fill course is needed (a room raised a quarter tile over its corridor
        // costs no extra pieces); the board edge and open air beside it keep their fill
        if (
          gen.flushRaisedFloors &&
          c.height - minN <= 0.5 + EPS &&
          c.material !== null &&
          !NATURAL_GROUND.has(c.material) &&
          !WATER.has(c.material)
        )
          continue;
        // behind a rock band: no face blocks and no hidden fill (the band covers the drop); the board's own edge keeps
        // its solid side
        if (bandBare.has(`${x},${y}`)) {
          // one rock family for every such patch (the band's backing), never the mixed per-cell picks
          if (cliffFace(c.theme, c.material, x, y, elev + minN, elev + c.height, false, `${L.id}:ledge:band`))
            continue;
        } else if (
          bandBack.has(`${x},${y}`) &&
          c.height - minN >= BAND.minRiseQ / 4 - EPS &&
          lx > 0 &&
          ly > 0 &&
          lx < V.w - 1 &&
          ly < V.h - 1
        ) {
          continue;
        }
        if (c.height - minN >= 1 - EPS && cliffFace(c.theme, c.material, x, y, elev + minN, elev + c.height))
          continue;
        stackFill(L.id, c.theme, c.material, x, y, elev + minN, elev + c.height);
      }
    }

    /** Stacks cliff blocks (cliff.<material>, cliff.default, or natural rock for natural ground) under a raised cell. */
    function cliffFace(
      theme: ThemeId,
      material: string | null,
      x: number,
      y: number,
      from: number,
      to: number,
      force = false,
      pickKey?: string,
    ): boolean {
      // whole-cell blocks only: 1×1 footprint and about a tile wide both ways
      const one: VariantFilter = {
        key: "block1x1",
        test: (v) =>
          v.footprint[0] === 1 &&
          v.footprint[1] === 1 &&
          v.geom.size.x > 0.8 &&
          v.geom.size.z > 0.8 &&
          v.geom.originAt === "minCorner",
      };
      // generator 3: natural ground shows rock where its face is bare, never earth-coloured fill (cliff.rock_block)
      const rockFirst = gen.rockGroundFaces && material !== null && NATURAL_GROUND.has(material);
      let res = lookup(
        L.id,
        theme,
        material
          ? [...(rockFirst ? ["cliff.rock_block"] : []), `cliff.${material}`, "cliff.default"]
          : ["cliff.default"],
        one,
        true,
      );
      if (!res && material !== null && (force || NATURAL_GROUND.has(material)))
        res = lookup(L.id, theme, ["cliff.natural"], one, true);
      if (!res) {
        if (material !== null && NATURAL_GROUND.has(material) && !cliffNoted.has(`${theme}|${material}`)) {
          cliffNoted.add(`${theme}|${material}`);
          addDiag({
            severity: "info",
            code: "asset_substituted",
            message: `No cliff piece for ${material} in theme "${theme}" (cliff.${material}, cliff.default, cliff.natural); its drops are built with fill courses`,
            levelId: L.id,
            role: `cliff.${material}`,
          });
        }
        return false;
      }
      const v = pick(res.variants, pickKey ?? `${L.id}:ledge:${x}:${y}`);
      if (!v) return false;
      const u = v.unitHeight;
      // outcrops (force) are rock all the way: a part block sinks into the ground rather than becoming fill
      const n = force ? Math.max(1, Math.ceil((to - from) / u - EPS)) : Math.floor((to - from) / u + EPS);
      const m = frame.rectMin(x, y, 1, 1);
      for (let k = 0; k < n; k++)
        emit(v, "ledge", m.x, to - (k + 1) * u, m.z, v.rot + blockTurn(v, `${x}:${y}:${k}`), {
          cell: [x, y],
          elementId: "ledge",
        });
      // the rest (less than one block) in fill courses, so nothing reaches below the lower floor
      const rest = to - n * u - from;
      if (rest > EPS) stackFill(L.id, theme, material, x, y, from, from + rest);
      return true;
    }

    // stone piers under bridge decks: courses of the deck's fill from the ground beneath up to the deck
    for (const b of L.bridges ?? []) {
      for (const [px, py] of b.piers ?? []) {
        const j = b.cells.findIndex((c) => c[0] === px && c[1] === py);
        if (j < 0) continue;
        const c = V.cell(px, py);
        const ground = (b.under[j] ?? b.deck) / 4;
        if (c.height - ground < 0.5 - EPS) continue;
        // pier.<material> / pier.default when the palette has a column piece, else courses of the deck's fill
        const one: VariantFilter = { key: "1x1", test: (q) => q.footprint[0] === 1 && q.footprint[1] === 1 };
        const roles = c.material ? [`pier.${c.material}`, "pier.default"] : ["pier.default"];
        const pr = lookup(L.id, c.theme, roles, one, true);
        const pv = pr ? pick(pr.variants, `${L.id}:pier:${px}:${py}`) : undefined;
        if (pv) {
          const m = frame.rectMin(px, py, 1, 1);
          // whole pieces from the deck down, the remainder in fill: nothing reaches below the ground beneath
          const n = Math.floor((c.height - ground) / pv.unitHeight + EPS);
          for (let s = 0; s < n; s++)
            emit(pv, "fill", m.x, elev + c.height - (s + 1) * pv.unitHeight, m.z, pv.rot, {
              cell: [px, py],
              elementId: "pier",
            });
          const rest = c.height - ground - n * pv.unitHeight;
          if (rest > EPS)
            stackFill(L.id, c.theme, c.material, px, py, elev + ground, elev + ground + rest, "fill", "pier");
        } else stackFill(L.id, c.theme, c.material, px, py, elev + ground, elev + c.height, "fill", "pier");
      }
    }

    // light props on liquid surfaces (lava glow): every third cell on a 3×3 lattice, when the palette has the role
    for (let ly = 0; ly < V.h; ly++) {
      for (let lx = 0; lx < V.w; lx++) {
        const x = L.bounds.x + lx;
        const y = L.bounds.y + ly;
        if (((x % 3) + 3) % 3 !== 1 || ((y % 3) + 3) % 3 !== 1) continue;
        const c = V.cell(x, y);
        if (!c.floor || c.material === null) continue;
        const res = lookup(
          L.id,
          c.theme,
          [`glow.${c.material}`, `feature.${c.material}_glow`],
          undefined,
          true,
        );
        const v = res ? pick(res.variants, `${L.id}:glow:${x}:${y}`) : undefined;
        if (!v) continue;
        const ctr = frame.point(x + 0.5, y + 0.5);
        const off =
          v.geom.originAt === "minCorner"
            ? { x: v.geom.size.x / 2, z: v.geom.size.z / 2 }
            : v.geom.boundsCenter;
        emit(v, "feature", ctr.x - off.x, topOf(c), ctr.z - off.z, v.rot, {
          cell: [x, y],
          elementId: `glow:${c.material}`,
        });
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
      // water cells sit on their bed; other cells fill with their own floor tile before the generic fill
      const roles = !material
        ? ["fill.default"]
        : WATER.has(material)
          ? [`bed.${material}`, "bed.default", "fill.default"]
          : [
              ...(gen.rockGroundFaces && NATURAL_GROUND.has(material) ? ["fill.rock"] : []),
              `fill.${material}`,
              `floor.${material}`,
              "fill.default",
            ];
      // stacked courses use the default family (untagged 1×1 variants), not a patch family's tile
      const res = lookup(levelId, theme, roles, {
        key: "1x1plain",
        test: (v) => v.footprint[0] === 1 && v.footprint[1] === 1 && (v.variant ?? "") === "",
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
      /** The cell on the other side of the edge (full-cell blocks go there when the host cell is open). */
      otherX: number;
      otherY: number;
      otherOpen: boolean;
      planSide: Side;
      base: number;
      top: number;
      theme: ThemeId;
      hostOpen: boolean;
    }
    const refHeights = areaReferenceHeights(L);
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
      const { base, top } = wallSpan(elev, a, b, hostFirst, wallHeight, refHeights);
      const theme = (other.open ? other.theme : host.open ? host.theme : other.theme) || defaultTheme;
      const hostX = orient === "h" ? x : hostFirst ? x - 1 : x;
      const hostY = orient === "h" ? (hostFirst ? y - 1 : y) : y;
      const otherX = orient === "h" ? x : hostFirst ? x : x - 1;
      const otherY = orient === "h" ? (hostFirst ? y : y - 1) : y;
      const planSide: Side = orient === "h" ? (hostFirst ? "S" : "N") : hostFirst ? "E" : "W";
      return {
        orient,
        x,
        y,
        hostFirst,
        hostX,
        hostY,
        otherX,
        otherY,
        otherOpen: other.open,
        planSide,
        base,
        top,
        theme,
        hostOpen: host.open,
      };
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
    const fullCells = new Map<
      string,
      { x: number; y: number; base: number; top: number; theme: ThemeId; roleName: string }
    >();
    const wallStyleOf = (ref: number): string => (ref === NONE ? "wall" : (L.wallStyles[ref] ?? "wall"));

    // buildings build their own shell (compile/structure.ts)
    const claimed = structureClaims(L);
    // generator 4: a built interior is carved into a solid mass: a flat cap on the solid cells round the rooms, closed
    // on its outer edge by a skirt of the level's wall style (compile/shell.ts). The cap piece comes first: with no
    // cap tile in any palette the shell is left out whole.
    const carvedLevel = !L.structures?.length && L.cells.state.some((s) => s === CELL.SOLID);
    // ... and only a rough interior gets broken wall tops (a kept-up timber inn keeps clean walls)
    const roughMap = gen.interiorWallTops && carvedLevel ? roughCells(L) : null;
    const roughCellAt = (x: number, y: number): boolean => {
      if (!roughMap || !V.inBounds(x, y)) return false;
      return roughMap[(y - L.bounds.y) * L.bounds.w + (x - L.bounds.x)] === 1;
    };
    let shell = gen.solidShell && carvedLevel
      ? planShell(resolved, L, seed, (o, e) => claimed.edges.has(`${o}${e}`), defaultTheme)
      : null;
    const capRes = shell ? lookup(L.id, shell.theme, ["cap.solid"], undefined, true) : null;
    const capVariants = (capRes?.variants ?? []).filter((v) => v.weight > 0 && v.footprint[0] === v.footprint[1]);
    if (shell && capVariants.length === 0) shell = shell.strips.length > 0 ? { ...shell, cells: new Map(), edges: [] } : null;
    const capThick = capVariants.length > 0 ? Math.min(...capVariants.map((v) => v.geom.size.y)) : 0.5;
    const shellEdges = new Map<string, EdgeCtx>();
    if (shell)
      for (const se of shell.edges) {
        const e = se.orient === "h" ? V.hEdge(se.x, se.y) : V.vEdge(se.x, se.y);
        if (e < 0) continue;
        shellEdges.set(`${se.orient}${e}`, {
          orient: se.orient,
          x: se.x,
          y: se.y,
          hostFirst: se.hostFirst,
          hostX: se.hostX,
          hostY: se.hostY,
          otherX: se.orient === "h" ? se.x : se.hostFirst ? se.x : se.x - 1,
          otherY: se.orient === "h" ? (se.hostFirst ? se.y : se.y - 1) : se.y,
          otherOpen: false,
          planSide: se.planSide,
          base: shell.base,
          // the skirt stops a hair under the cap's lift: a whole 2-tall piece from the floor's underside to the cap tile
          top: se.top - capThick - SHELL.lift,
          theme: shell.theme,
          hostOpen: false,
        });
      }
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
          const skirt = e >= 0 ? shellEdges.get(`${orient}${e}`) : undefined;
          if (skirt === undefined && (e < 0 || grid.kind[e] !== EDGE.WALL || claimed.edges.has(`${orient}${e}`))) {
            flush();
            continue;
          }
          const style = skirt && shell ? shell.style : wallStyleOf(grid.ref[e] ?? NONE);
          const height = (grid.height[e] ?? 0) > 0 ? (grid.height[e] ?? 2) : 2;
          const ctx = skirt ?? edgeCtx(orient, x, y, grid, e, height);
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
            // A rock block cannot stand in an open host cell; put it in the other cell when that one is rock, void or
            // outside the level (a cave touching the level bounds), otherwise skip it with a warning.
            const flip = c.hostOpen && !c.otherOpen;
            const bx = flip ? c.otherX : c.hostX;
            const by = flip ? c.otherY : c.hostY;
            const k = `${bx},${by}`;
            // generator 3: a passage that reaches the board edge is an exit; no rock column stands outside the bounds
            if (
              gen.boardEdgeExits &&
              (bx < L.bounds.x || bx >= L.bounds.x + L.bounds.w || by < L.bounds.y || by >= L.bounds.y + L.bounds.h)
            )
              continue;
            if (c.hostOpen && !flip) {
              if (fullCellDone.has(`x${k}`)) continue;
              fullCellDone.add(`x${k}`);
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
            // one column per rock cell, spanning every edge it closes (a cell beside a chasm and its rim gets one
            // column from the chasm floor to the rim wall top)
            const prev = fullCells.get(k);
            if (prev) {
              prev.base = Math.min(prev.base, c.base);
              prev.top = Math.max(prev.top, c.top);
            } else fullCells.set(k, { x: bx, y: by, base: c.base, top: c.top, theme: c.theme, roleName });
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
          const shortest = lengths.length > 0 ? Math.min(...lengths) : 1;
          if (mount === "edge-center" && remaining < shortest) {
            // free-standing low walls/fences/railings: a run shorter than the shortest piece gets that piece centred
            // over it (it overhangs a little), rather than a gap
            const r = lookup(L.id, first.theme, [roleName], lenFilter(shortest), true);
            const v = r
              ? pick(r.variants, `${L.id}:${orient}wall:${run[i]?.x ?? 0}:${run[i]?.y ?? 0}`)
              : undefined;
            const c = run[i];
            if (v && c) {
              placeEdgeCenterPiece(v, "wall", c, remaining, {
                cell: [c.hostX, c.hostY],
                elementId: roleName,
              });
              i += remaining;
              continue;
            }
          }
          let done = false;
          for (const n of [...cands, 1]) {
            let r = lookup(L.id, first.theme, [roleName], lenFilter(n), n !== 1);
            let v = r
              ? pick(r.variants, `${L.id}:${orient}wall:${run[i]?.x ?? 0}:${run[i]?.y ?? 0}`)
              : undefined;
            const c = run[i];
            if (!v || !c) continue;
            // generator 4, rough interiors: about one piece in five of a run is a broken-top variant (wall.ruined)
            if (
              roughMap !== null &&
              style === "wall" &&
              n >= 2 &&
              c.hostOpen &&
              roughCellAt(c.hostX, c.hostY) &&
              h32(`${seed}:${L.id}:brokentop:${orient}:${c.x}:${c.y}`) % 5 === 0
            ) {
              const rr = lookup(L.id, first.theme, ["wall.ruined"], lenFilter(n), true);
              const rv = rr ? pick(rr.variants, `${L.id}:${orient}broken:${c.x}:${c.y}`) : undefined;
              if (rr && rv && (rr.def.mount ?? "half-cell") === "half-cell") {
                r = rr;
                v = rv;
              }
            }
            if (mount === "edge-center")
              placeEdgeCenterPiece(v, "wall", c, n, { cell: [c.hostX, c.hostY], elementId: roleName });
            else {
              const count = Math.max(1, Math.ceil((c.top - c.base) / v.unitHeight - EPS));
              // generator 4: a wall a quarter or half a tile short of whole pieces sinks into the floor slab so its top
              // lands where the edge says (rough tops, resolve/wallTops.ts); the piece never lifts off the floor
              const yBase = gen.exactWallTops
                ? Math.max(c.base - 0.5, Math.min(c.base, c.top - count * v.unitHeight))
                : c.base;
              placeEdgePiece(
                v,
                "wall",
                r?.role ?? roleName,
                c,
                n,
                yBase,
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
    // generator 4: the flat cap of the solid shell, flush with the wall tops, in the palette's biggest square pieces
    if (shell && capRes) {
      const sizes = [...new Set(capVariants.map((v) => v.footprint[0]))].sort((a, b) => b - a);
      const capUsed = new Set<string>();
      const cells = [...shell.cells.values()].sort((a, b) => a.y - b.y || a.x - b.x);
      // the shell's blocks lie on the level's even lattice: big tiles go there first, then big tiles anywhere they fit
      // (the strip against a wall that is off the lattice), then singles
      const passes: Array<{ s: number; aligned: boolean }> = [
        ...sizes.filter((s) => s > 1).map((s) => ({ s, aligned: true })),
        ...sizes.filter((s) => s > 1).map((s) => ({ s, aligned: false })),
        { s: 1, aligned: false },
      ];
      for (const { s, aligned } of passes) {
        if (!sizes.includes(s)) continue;
        for (const c of cells) {
          if (capUsed.has(`${c.x},${c.y}`)) continue;
          if (aligned && ((c.x - L.bounds.x) % s !== 0 || (c.y - L.bounds.y) % s !== 0)) continue;
          let fits = true;
          for (let dy = 0; fits && dy < s; dy++)
            for (let dx = 0; fits && dx < s; dx++) {
              const cc = shell.cells.get(`${c.x + dx},${c.y + dy}`);
              if (!cc || capUsed.has(`${c.x + dx},${c.y + dy}`) || cc.theme !== c.theme || cc.top !== c.top) fits = false;
            }
          if (!fits) continue;
          const v = pick(
            capVariants.filter((q) => q.footprint[0] === s),
            `${L.id}:cap:${c.x}:${c.y}`,
          );
          if (!v) continue;
          for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) capUsed.add(`${c.x + dx},${c.y + dy}`);
          const m = frame.rectMin(c.x, c.y, s, s);
          const steps = (h32(`${seed}:${L.id}:caprot:${c.x}:${c.y}`) % 4) * 6;
          emit(v, "fill", m.x, c.top - v.geom.size.y, m.z, steps * 15 + v.rot, {
            cell: [c.x, c.y],
            elementId: "shell",
          });
        }
      }
    }
    // generator 4: in a tidy interior, a one-cell solid strip between two rooms is closed flush at wall-top height with a
    // tile of the floor of the room it joins, so two rooms read as sharing one thick wall instead of a trench
    if (shell && shell.strips.length > 0) {
      for (const s of shell.strips) {
        const sr = lookup(
          L.id,
          s.theme,
          // the floor role of the room the strip joins; the palette's own fallback chain covers a material it lacks
          s.material ? [`floor.${s.material}`] : ["cap.solid"],
          { key: "strip1x1", test: (v) => v.footprint[0] === 1 && v.footprint[1] === 1 },
          true,
        );
        const sv = sr ? pick(sr.variants.filter((v) => v.weight > 0), `${L.id}:strip:${s.x}:${s.y}`) : undefined;
        if (!sv) continue;
        const m = frame.rectMin(s.x, s.y, 1, 1);
        emit(sv, "fill", m.x, s.top - sv.geom.size.y, m.z, sv.rot, { cell: [s.x, s.y], elementId: "shell" });
      }
    }
    // Generator 2: rock walls reach down to the lowest floor of the level (nothing below the room shows from outside)
    // and vary in height like a natural cave (0, 1 or 2 extra blocks from seeded value noise).
    const rockSkirt = gen.rockWallSkirt;
    const skirt = elev + outsideGround;
    const wallNoise = new ValueNoise(h32(`${seed}:${L.id}:walltops`));
    // the extra blocks never rise through the floor of a level stacked above (verify_pokes_into_level_above)
    const ceiling = resolved.levels.reduce(
      (m, o) => (o.elevation > elev + EPS ? Math.min(m, o.elevation) : m),
      Infinity,
    );
    const massFaces: Array<WallFace & { theme: ThemeId }> = [];
    const columnLater = new Map<string, () => void>();
    for (const [k, c] of fullCells) {
      const r1 = lookup(L.id, c.theme, [c.roleName], {
        key: "1x1",
        test: (v) => v.footprint[0] === 1 && v.footprint[1] === 1,
      });
      const v = r1 ? pick(r1.variants, `${L.id}:wallblock:${k}`) : undefined;
      if (!v) continue;
      const m = frame.rectMin(c.x, c.y, 1, 1);
      let base = c.base;
      let top = c.top;
      const floorTop = c.base;
      if (rockSkirt) {
        base = Math.min(base, skirt);
        // clustered: broad noise picks masses (up to 3 blocks taller) and a few lower stretches (1 block down, never
        // below a tile above the floor), a per-cell hash breaks up runs of equal columns
        const nz =
          wallNoise.sample(c.x / 4, c.y / 4) * 0.8 + (h32(`${seed}:${c.x}:${c.y}:wt`) / 4294967296) * 0.2;
        let extra = nz < 0.22 ? -1 : nz < 0.45 ? 0 : nz < 0.62 ? 1 : nz < 0.8 ? 2 : 3;
        // generator 3: the column is the closing skin of a wall of rock mass (gen/cavewall.ts): lower, in uneven runs
        if (gen.caveRockMass && c.roleName === "wall.cave_rock") extra =nz < 0.3 ? -1 : nz < 0.72 ? 0 : 1;
        if (extra < 0 && top - v.unitHeight < floorTop + 1.5) extra = 0;
        // a column that closes the mouth of a chasm or pit (its wall reaches below the floor) is never one of the
        // low stretches, and stands at least a block taller, so nothing glows over it from inside
        if (c.base < elev + 0.5 - 0.75) extra = Math.max(extra, 1);
        while (extra > 0 && top + extra * v.unitHeight > ceiling + EPS) extra--;
        top += extra * v.unitHeight;
      }
      const n = Math.max(1, Math.ceil((top - base) / v.unitHeight - EPS));
      // generator 2: a block that would rise through the floor above is dropped to sit just under it (overlapping
      // the block below), so a stacked cave keeps its wall closed without poking into the level above
      const yAt = (s: number): number => {
        const y = base + s * v.unitHeight;
        return rockSkirt && y + v.unitHeight > ceiling + EPS && ceiling - v.unitHeight >= base - EPS
          ? ceiling - v.unitHeight
          : y;
      };
      const buildColumn = (): void => {
        for (let s = 0; s < n; s++)
          emit(v, "wall", m.x, yAt(s), m.z, v.rot + (rockSkirt ? blockTurn(v, `${k}:${s}`) : 0), {
            cell: [c.x, c.y],
            elementId: c.roleName,
          });
      };
      // generator 3: the column is only the fill of a wall of rock mass (gen/cavewall.ts); it is built below, where
      // no mass piece closes the face cell
      if (gen.caveRockMass && c.roleName === "wall.cave_rock") {
        massFaces.push({ x: c.x, y: c.y, base, top: base + n * v.unitHeight, edgeBase: floorTop, theme: c.theme });
        columnLater.set(`${c.x},${c.y}`, buildColumn);
      } else buildColumn();
    }

    // generator 3: the rock mass behind and over the wall columns (gen/cavewall.ts)
    if (massFaces.length > 0) {
      const edgeBlocked = new Set<string>();
      for (const orient of ["h", "v"] as const) {
        const g = orient === "h" ? L.hEdges : L.vEdges;
        for (let y = L.bounds.y; y <= L.bounds.y + V.h; y++)
          for (let x = L.bounds.x; x <= L.bounds.x + V.w; x++) {
            const e = orient === "h" ? V.hEdge(x, y) : V.vEdge(x, y);
            if (e < 0 || (g.kind[e] !== EDGE.OPENING && g.kind[e] !== EDGE.STAIR)) continue;
            for (let dy = -2; dy <= 2; dy++)
              for (let dx = -2; dx <= 2; dx++) edgeBlocked.add(`${x + dx},${y + dy}`);
          }
      }
      const taken = new Set<string>();
      for (const f of L.features)
        for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
          for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++)
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) taken.add(`${x + dx},${y + dy}`);
      for (const theme of new Set(massFaces.map((f) => f.theme))) {
        const vars: Array<{ v: ResolvedVariant; role: string }> = [];
        const shapes: WallShape[] = [];
        const add = (
          roleName: string,
          family: WallShape["family"],
          ok: (q: ResolvedVariant) => boolean,
          lift?: (q: ResolvedVariant) => number,
        ) => {
          const r = lookup(L.id, theme, [roleName], undefined, true);
          for (const q of r?.variants ?? []) {
            if (q.weight <= 0 || !ok(q)) continue;
            shapes.push({
              id: vars.length,
              family,
              w: q.geom.size.x,
              d: q.geom.size.z,
              h: q.geom.size.y,
              weight: q.weight,
              ...(lift === undefined ? {} : { lift: lift(q) }),
            });
            vars.push({ v: q, role: r?.role ?? roleName });
          }
        };
        // one rock family per cave: the Cavern kit (cliff.cave_mass), the tone of the wall columns; themes without it
        // build the mass from their own cliff band rock (crest boulders and faces)
        add("cliff.cave_mass", "A", () => true);
        const kit = shapes.length > 0;
        if (!kit) {
          add("cliff.formation_crest", "A", (q) => q.geom.size.y >= 1.2);
          add("cliff.formation_face", "A", () => true);
        }
        // flat sheets close the far part of a deep band
        if (kit) add("cliff.cave_cap", "cap", () => true);
        // foot stones: the kit's low stone, else small rocks and rubble
        if (kit) add("cliff.cave_mass", "toe", (q) => q.geom.size.y <= 1.05, () => 0);
        else {
          add("feature.rock", "toe", (q) => q.geom.size.y <= 0.8 && q.geom.size.x >= 0.9, () => 0);
          add("feature.rubble", "toe", (q) => q.geom.size.y <= 0.8 && q.geom.size.x >= 0.8, () => 0);
        }
        if (!shapes.some((s) => s.family !== "toe")) continue;
        const faces = massFaces.filter((f) => f.theme === theme);
        const inLevelState = (x: number, y: number): number =>
          V.inBounds(x, y) ? (L.cells.state[(y - L.bounds.y) * V.w + (x - L.bounds.x)] ?? CELL.VOID) : -1;
        const plan = planCaveWall({
          seed: h32(`${seed}:${L.id}:cavemass`),
          faces,
          bounds: { x: L.bounds.x, y: L.bounds.y, w: V.w, h: V.h },
          // (a level of rooms and caves: the cells the shell owns are not the rock's, gen/solidMass.ts)
          rock: (x, y) => inLevelState(x, y) === CELL.SOLID && (shell?.rockMayTake(x, y) ?? true),
          open: (x, y) => V.cell(x, y).open,
          floorTop: (x, y) => topOf(V.cell(x, y)),
          toeOk: (x, y) => {
            const c = V.cell(x, y);
            return (
              c.floor &&
              (c.flags & (CELL_FLAG.PATH | CELL_FLAG.LINK | CELL_FLAG.WATER | CELL_FLAG.NO_FLOOR)) === 0 &&
              !taken.has(`${x},${y}`) &&
              !edgeBlocked.has(`${x},${y}`)
            );
          },
          shapes,
          ceiling,
          // generator 4: solid rock, filled from the foot with no see-through gap
          ...(gen.solidCaveRock ? { solid: true } : {}),
        });
        for (const f of faces) if (!plan.columns.has(`${f.x},${f.y}`)) columnLater.delete(`${f.x},${f.y}`);
        for (const pc of plan.pieces) {
          const q = vars[pc.shape];
          if (!q) continue;
          const deg = (((frame.planDegreesToWorld(pc.rot) + q.v.rot) % 360) + 360) % 360;
          const c = frame.point(pc.cx, pc.cy);
          const off = rotateXZ(q.v.geom.boundsCenter.x, q.v.geom.boundsCenter.z, deg * frame.o.rotSense);
          emit(q.v, pc.family === "toe" ? "feature" : "wall", c.x - off.x, pc.base, c.z - off.z, deg, {
            cell: [Math.floor(pc.cx), Math.floor(pc.cy)],
            elementId: pc.family === "toe" ? "cave_foot" : pc.family === "cap" ? "cave_cap" : "cave_mass",
          });
          // a tile (corner-origin) piece turned off the quarter turns: its box is the turned outline's (the box of a
          // corner-origin piece is only right for quarter turns)
          const last = placements[placements.length - 1];
          if (last && q.v.geom.originAt === "minCorner") {
            const box = placementBox(
              { ...q.v.geom, originAt: "other" },
              last.x,
              last.y,
              last.z,
              last.rot * orientation.rotSense,
            );
            placementBoxes.set(last, box);
            growBox(levelBox, box);
          }
        }
      }
    }
    // the wall columns left as fill (all of them where no mass was planned)
    for (const build of columnLater.values()) build();

    // kerbs along kerbed paths: kerb.<material> / kerb.default, a half-cell piece on the path side of the edge
    for (const kb of L.kerbs ?? []) {
      const c = V.cell(kb.at[0], kb.at[1]);
      const res = lookup(L.id, c.theme, [`kerb.${kb.material}`, "kerb.default"], lenFilter(1), true);
      const v = res ? pick(res.variants, `${L.id}:kerb:${kb.at[0]}:${kb.at[1]}:${kb.side}`) : undefined;
      if (!v || !res) {
        if (!kerbNoted) {
          kerbNoted = true;
          addDiag({
            severity: "info",
            code: "role_missing",
            message: `No kerb piece (kerb.${kb.material}, kerb.default) in theme "${c.theme}"; paths are built without kerbs`,
            levelId: L.id,
            role: `kerb.${kb.material}`,
          });
        }
        continue;
      }
      const s = kb.side;
      const ex = s === "E" ? kb.at[0] + 1 : kb.at[0];
      const ey = s === "S" ? kb.at[1] + 1 : kb.at[1];
      const orient: "h" | "v" = s === "N" || s === "S" ? "h" : "v";
      const ctx: EdgeCtx = {
        orient,
        x: ex,
        y: ey,
        // the kerb stands on the verge, beside the path, never on the path cell itself
        hostFirst: s === "N" || s === "W",
        hostX: s === "E" ? kb.at[0] + 1 : s === "W" ? kb.at[0] - 1 : kb.at[0],
        hostY: s === "S" ? kb.at[1] + 1 : s === "N" ? kb.at[1] - 1 : kb.at[1],
        otherX: kb.at[0],
        otherY: kb.at[1],
        otherOpen: true,
        planSide: opposite(s),
        base: topOf(c),
        top: topOf(c) + v.unitHeight,
        theme: c.theme,
        hostOpen: true,
      };
      placeEdgePiece(
        v,
        "ledge",
        res.role,
        ctx,
        1,
        topOf(c),
        1,
        { cell: [kb.at[0], kb.at[1]], elementId: "kerb" },
        false,
      );
    }

    // stairs (EDGE.STAIR): a stair piece in the lower cell climbing toward the higher one
    const stairAt = (orient: "h" | "v", e: number, x: number, y: number): void => {
      const g = orient === "h" ? L.hEdges : L.vEdges;
      if (g.kind[e] !== EDGE.STAIR) return;
      const a = orient === "h" ? { x, y: y - 1 } : { x: x - 1, y };
      const b = { x, y };
      const ca = V.cell(a.x, a.y);
      const cb = V.cell(b.x, b.y);
      if (!ca.floor || !cb.floor) return;
      const lowerIsA = ca.height < cb.height;
      const lo = lowerIsA ? a : b;
      const cl = lowerIsA ? ca : cb;
      const rise = Math.abs(ca.height - cb.height);
      const dir: Side = orient === "h" ? (lowerIsA ? "S" : "N") : lowerIsA ? "E" : "W";
      const roles =
        rise >= 0.75 - EPS && rise <= 1.25 + EPS
          ? // natural ground may have its own stair piece (earth or rock steps) before the built one
            cl.material && NATURAL_GROUND.has(cl.material)
            ? [`link.stairs.${cl.material}`, "link.stairs.natural", "link.stairs"]
            : ["link.stairs"]
          : cl.material
            ? NATURAL_GROUND.has(cl.material)
              ? [`step.${cl.material}`]
              : [`step.${cl.material}`, "step.default"]
            : ["step.default"];
      const res = lookup(L.id, cl.theme, roles, undefined, true);
      const v = res ? pick(res.variants, `${L.id}:step:${lo.x}:${lo.y}`) : undefined;
      if (!v || !res) return;
      // a step piece must fit under the step it climbs: one taller than the rise would stand as a block on the lower
      // floor (the riser is built anyway, from the cell's own floor or fill)
      if (!res.role.startsWith("link.stairs") && v.geom.size.y > rise + 0.05) return;
      const f = facingOf(v, "link", res.role);
      const steps = f.ascendsToward ? frame.stepsToFace(f.ascendsToward, frame.worldSide(dir)) : 0;
      const deg = steps * 15 + v.rot;
      const src: Placement["source"] = { cell: [lo.x, lo.y], elementId: "steps" };
      if (v.geom.originAt === "minCorner") {
        const m = frame.rectMin(lo.x, lo.y, 1, 1);
        emit(v, "link", m.x, topOf(cl), m.z, deg, src);
      } else {
        const ctr = frame.point(lo.x + 0.5, lo.y + 0.5);
        const off = rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * frame.o.rotSense);
        emit(v, "link", ctr.x - off.x, topOf(cl), ctr.z - off.z, deg, src);
      }
    };
    for (let ly = 0; ly <= V.h; ly++)
      for (let lx = 0; lx < V.w; lx++) stairAt("h", ly * V.w + lx, L.bounds.x + lx, L.bounds.y + ly);
    for (let ly = 0; ly < V.h; ly++)
      for (let lx = 0; lx <= V.w; lx++) stairAt("v", ly * (V.w + 1) + lx, L.bounds.x + lx, L.bounds.y + ly);

    // openings
    for (const op of L.openings) {
      if (op.kind === "open" || claimed.openings.has(op.id)) continue;
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
          // generator 4: a secret door is ONE removable plug in the wall line (the palette's `opening.secret_door` piece, else
          // the wall style's own piece); the build report says where it stands so a GM can find and delete it
          if (op.kind === "secret_door" && gen.secretDoorPlug && i === 0) {
            const sideName = { N: "north", S: "south", E: "east", W: "west" }[c.planSide];
            const [a, b] = op.sides;
            addDiag({
              severity: "info",
              code: "secret_door_plug",
              message: `Secret door ${op.id} between ${a ?? "?"} and ${b ?? "?"} on level ${L.id} at cell ${c.hostX},${c.hostY} (${sideName} wall, floor level ${c.base}): delete the ${v.name} standing in that wall to open the way.`,
              levelId: L.id,
              elementId: op.id,
              role: r.role,
            });
          }
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
        // generator 4: a post up to half a tile (a quarter for a 1-tall piece) short of whole pieces stops there; walls
        // beside a room raised a quarter tile stand that much taller than the post's own course, which would otherwise
        // stack a second 2-tall piece through the floor above
        const slack = gen.exactWallTops ? Math.min(0.5, v.unitHeight / 4) : 0;
        const n = Math.max(1, Math.ceil((top - base - slack) / v.unitHeight - EPS));
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

    // outcrops are built up with the theme's rock formations: one on the crown, and formations and edge dressing
    // piled round the foot, so a crag reads as a rock mass rather than a stack of blocks
    for (const oc of L.outcrops ?? []) {
      const inOc = new Set(oc.cells.map(([x, y]) => `${x},${y}`));
      const placeDressing = (role: string, x: number, y: number, key: string): void => {
        const c = V.cell(x, y);
        const res = lookup(L.id, c.theme, [role], undefined, true);
        const v = res ? pick(res.variants, `${L.id}:outcrop:${oc.id}:${key}`) : undefined;
        if (!v) return;
        const src: Placement["source"] = { cell: [x, y], elementId: `outcrop:${oc.id}` };
        const turn = h32(`${seed}:${oc.id}:${key}:rot`);
        if (v.geom.originAt === "minCorner") {
          const m = frame.rectMin(x, y, v.footprint[0], v.footprint[1]);
          emit(v, "feature", m.x, topOf(c), m.z, (turn % 4) * 90 + v.rot, src);
          return;
        }
        const deg = (turn % 24) * 15 + v.rot;
        const ctr = frame.point(x + 0.5, y + 0.5);
        const off = rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * frame.o.rotSense);
        emit(v, "feature", ctr.x - off.x, topOf(c), ctr.z - off.z, deg, src);
      };
      const crown = [...oc.cells].sort(
        (a, b) => V.cell(b[0], b[1]).height - V.cell(a[0], a[1]).height || a[1] - b[1] || a[0] - b[0],
      )[0];
      if (crown) placeDressing("feature.formation", crown[0], crown[1], "crown");
      const foot = new Map<string, [number, number]>();
      for (const [x, y] of oc.cells)
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (!inOc.has(`${nx},${ny}`) && V.cell(nx, ny).floor) foot.set(`${nx},${ny}`, [nx, ny]);
        }
      [...foot.values()]
        .sort((a, b) => a[1] - b[1] || a[0] - b[0])
        .forEach(([x, y], i) => {
          const r = h32(`${seed}:${oc.id}:${x}:${y}:foot`) % 3;
          if (r === 0)
            placeDressing(i % 2 === 0 ? "feature.formation" : "feature.edge_dressing", x, y, `${x}:${y}`);
        });
    }

    function placeFeature(f: ResolvedFeature): void {
      const anchor = V.cell(f.at[0], f.at[1]);
      const theme = f.theme || anchor.theme;
      const roleName = `feature.${f.type}`;
      // generator 4: a covered stall is built from parts (base, counters, posts, canopy); without them the table below
      if (
        gen.coveredStalls &&
        f.type === "stall" &&
        f.stall !== undefined &&
        realizeStall(
          {
            frame,
            seed,
            lookup: (t, roles, filter, quiet) => lookup(L.id, t, roles, filter, quiet),
            pick,
            facingOf,
            emit,
            info: (code, message, role) => {
              addDiag({
                severity: "info",
                code: code as CompileDiagnostic["code"],
                message,
                levelId: L.id,
                ...(role ? { role } : {}),
              });
            },
          },
          f,
        )
      )
        return;
      let v: ResolvedVariant | undefined;
      let rule = "facing";
      let resolvedRole: RoleName = roleName;
      if (f.type === "custom") {
        // a real match only (strict name search), and a plausible size for the thing asked: a wrong object is worse
        // than none (round 5: "car" once became a cardboard carton). Footprint area within 9× either way.
        const want = Math.max(1, f.size[0] * f.size[1]);
        const hits = palettes.availability.search(f.hint ?? "", undefined);
        const hit = hits.find((h) => {
          const [fw, fh] = footprintFromGeom(h.geom);
          const area = Math.max(1, fw * fh);
          return area <= want * 9 && area * 9 >= want;
        });
        if (!hit) {
          // no catalog at all is a setup problem (warning); a catalog with no such thing is information for the
          // model, which should pick another type or hint
          const noCatalog = palettes.availability.search("chest").length === 0;
          addDiag({
            severity: noCatalog ? "warning" : "info",
            code: "custom_unresolved",
            message: `Custom feature "${f.hint ?? ""}" matched no asset${noCatalog ? " (no TaleSpire catalog loaded)" : hits.length > 0 ? ` of a plausible size (nearest name match "${hits[0]?.name ?? ""}" is the wrong size)` : " whose name is that thing"}; nothing was placed. Try another hint or a feature type.`,
            levelId: L.id,
            elementId: f.id,
          });
          return;
        }
        const g = hit.geom;
        const fpHit = footprintFromGeom(g);
        addDiag({
          severity: "info",
          code: "custom_resolved",
          message: `Custom feature "${f.hint ?? ""}" is "${hit.name}" (${Math.round(g.size.y * 10) / 10} tiles tall, ${fpHit[0]}×${fpHit[1]} cells; feature is ${f.size[0]}×${f.size[1]})`,
          levelId: L.id,
          elementId: f.id,
        });
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
        // generator 4: small things on a surface (clutter, goods) are one family table over two roles (gen/surfaces.ts):
        // the first role that has the asked family wins, else the first role there is (the variant note below applies)
        const roles = gen.sharedSmallThings ? featureRoles(f.type) : [roleName];
        const wantFamily = f.variant;
        const res =
          (roles.length > 1 && wantFamily !== undefined
            ? lookup(L.id, theme, [...roles], { key: `variant:${wantFamily}`, test: (u) => u.variant === wantFamily }, true)
            : null) ?? lookup(L.id, theme, [...roles]);
        if (!res) return;
        resolvedRole = res.role;
        rule = res.def.rotation ?? "facing";
        let pool = res.variants;
        // generator 3: the band's rocks turn as the generator set them (the palette's role says "fixed", which left every
        // rock at one turn), and a boulder is a tall one (Moss Rock 01 is knee-high and hides no face)
        if (gen.restingCliffBand && (f.type === "cliff_face" || f.type === "cliff_crest")) {
          rule = "inherit";
          if (f.type === "cliff_crest") {
            const tallOnes = pool.filter((u) => u.geom.size.y >= 1.2);
            if (tallOnes.length > 0) pool = tallOnes;
          }
          // one rock tone per cliff: the face piece decides; boulders match it (the palette's same-tone boulder role when
          // the boulder role has none), and keep their own tone only when the palette has no piece of that tone
          const tone = cliffKinds(theme).tone;
          if (tone !== undefined) {
            const same = pool.filter((u) => u.weight > 0 && u.tone === tone);
            if (same.length > 0) pool = same;
            else if (f.type === "cliff_crest") {
              const alt = toneBoulders(theme, tone);
              if (alt.length > 0) pool = [...alt];
            }
          }
        }
        // generator 3: the loose rock within 3 cells of a cliff follows the cliff's tone (untagged pieces are unknown: kept)
        if (gen.cliffToneRule && CLIFF_DRESSING.has(f.type) && nearCliff(f.at[0], f.at[1])) {
          const tone = cliffKinds(theme).tone;
          const tagged = pool.filter((u) => u.weight > 0 && u.tone !== undefined);
          if (tone !== undefined && tagged.length > 0) {
            if (tagged.some((u) => u.tone === tone)) pool = pool.filter((u) => u.tone === undefined || u.tone === tone);
            else {
              const alt = toneBoulders(theme, tone);
              if (alt.length > 0) pool = [...pool.filter((u) => u.tone === undefined), ...alt];
            }
          }
        }
        // generator 3: a wall block (a tile, minCorner) is not a natural standing piece: a cave's stone columns are
        // stalagmites, never a row of Cave Wall stubs that read as a brick maze
        if (gen.naturalStanding && NATURAL_STANDING.has(f.type)) {
          const notTiles = pool.filter((u) => u.geom.originAt !== "minCorner");
          if (notTiles.length > 0) pool = notTiles;
        }
        // generator 3: a stall's kind is the goods it sells; kinds that stand on the bare table share its variant
        const wantVariant =
          gen.stallsAndLines && f.type === "stall" && f.variant !== undefined
            ? stallPieceOf(f.variant)
            : f.variant;
        if (wantVariant !== undefined) {
          const m = res.variants.filter((u) => u.variant === wantVariant);
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
        // generator 3: a stall made of 1x1 tiles (fruit, vegetables, spices) is one tile in each of its two cells
        if (
          v &&
          gen.stallsAndLines &&
          f.type === "stall" &&
          v.footprint[0] * v.footprint[1] === 1 &&
          f.size[0] * f.size[1] === 2
        ) {
          const fct = facingOf(v, "feature", resolvedRole);
          const wantPlan = rotateDir("S", Math.round(f.rot / 90));
          const degRaw = frame.stepsToFace(fct.front ?? "N", frame.worldSide(wantPlan)) * 15 + v.rot;
          const degT = (((Math.round(degRaw / 90) % 4) + 4) % 4) * 90;
          for (let yy = f.at[1]; yy < f.at[1] + f.size[1]; yy++)
            for (let xx = f.at[0]; xx < f.at[0] + f.size[0]; xx++) {
              const vt = pick(pool, `${L.id}:feature:${f.id}:${xx}:${yy}`) ?? v;
              const m = frame.rectMin(xx, yy, 1, 1);
              emit(vt, "feature", m.x, f.baseHeight, m.z, degT, { cell: [xx, yy], elementId: f.id });
            }
          return;
        }
        if (v && RUN_MIX.has(f.type)) {
          const near = (runPicks.get(res.role) ?? []).filter(
            (q) =>
              (q.y === f.at[1] && Math.abs(q.x - f.at[0]) <= 3) ||
              (q.x === f.at[0] && Math.abs(q.y - f.at[1]) <= 3),
          );
          const same = near.filter((q) => q.uuid === v?.uuid).length;
          const others = pool.filter((u) => u.weight > 0 && u.uuid !== v?.uuid);
          if (same >= 1 && others.length > 0) v = pick(others, `${L.id}:feature:${f.id}:mix`) ?? v;
          const l = runPicks.get(res.role) ?? [];
          l.push({ x: f.at[0], y: f.at[1], uuid: v.uuid });
          runPicks.set(res.role, l);
        }
        // a vehicle is the thing asked for or nothing (owner's model test, 2026-11-20: a 4×2 "Stalled bus" became a
        // taxi). Its length must be close to the feature's long side; a label naming a kind the asset is not (a
        // van that becomes a taxi of the same size) is placed with a note.
        if (v && f.type === "vehicle") {
          const featLong = Math.max(f.size[0], f.size[1]);
          const assetLong = Math.max(v.geom.size.x, v.geom.size.z);
          const label = (f.label ?? "").toLowerCase();
          const kind =
            /\b(bus|coach|van|truck|lorry|tram|cart|wagon|carriage|car|taxi|cab|jeep|pickup)\b/.exec(
              label,
            )?.[1];
          const CARS = new Set(["car", "taxi", "cab"]);
          const nameLc = (v.name ?? "").toLowerCase();
          const sameKind =
            kind === undefined ||
            nameLc.includes(kind) ||
            (CARS.has(kind) && /\b(car|taxi|cab)/.test(nameLc));
          if (Math.abs(featLong - assetLong) > 1.2) {
            addDiag({
              severity: "info",
              code: "custom_unresolved",
              message: `Vehicle "${f.label ?? f.id}" (${f.size[0]}×${f.size[1]}): the theme's vehicles (${v.name ?? v.uuid}, ${assetLong.toFixed(1)} long) are not that size; nothing was placed`,
              levelId: L.id,
              elementId: f.id,
            });
            return;
          }
          if (!sameKind)
            addDiag({
              severity: "info",
              code: "custom_resolved",
              message: `Vehicle "${f.label ?? f.id}": the theme has no ${kind}; "${v.name ?? v.uuid}" stands in`,
              levelId: L.id,
              elementId: f.id,
            });
        }
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
      // a long asset lies along a long feature (city street, 2026-11-20: a taxi on a 3×2 "parked car" stood across
      // the road): when a quarter turn fits the asset's footprint to the feature's better, take it. Wall pieces keep
      // their mounting side.
      if (!f.wall && fp[0] !== fp[1]) {
        const q = Math.round(deg / 90) % 2 === 1;
        const [aw, ah] = q ? [v.footprint[1], v.footprint[0]] : [v.footprint[0], v.footprint[1]];
        const miss = (w: number, h: number): number => Math.abs(w - fp[0]) + Math.abs(h - fp[1]);
        if (miss(ah, aw) < miss(aw, ah)) deg = (deg + 90) % 360;
      }
      // tiles (and tile assemblies) stay on quarter turns: a 15° tile would not sit on the grid
      if (v.geom.originAt === "minCorner") deg = (Math.round(deg / 90) % 4) * 90;
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
      // landmarks must give the map a skyline
      if (f.type === "landmark" || f.type === "tree_large" || f.type === "statue_large") {
        const top = Math.max(
          v.geom.size.y,
          ...(v.parts ?? []).map((q) => (q.offset?.y ?? 0) + q.geom.size.y),
        );
        if (top < 3 - EPS)
          addDiag({
            severity: "info",
            code: "landmark_short",
            message: `"${v.name ?? v.uuid}" for ${f.type} ${f.id} is only ${Math.round(top * 10) / 10} tiles tall; a landmark should stand 3 or more (use an assembly or a taller asset)`,
            levelId: L.id,
            role: roleName,
            elementId: f.id,
          });
      }
      if (v.geom.originAt === "minCorner") {
        const m = frame.rectMin(f.at[0], f.at[1], fp[0], fp[1]);
        emit(v, "feature", m.x, y, m.z, deg, src);
      } else {
        // generator 3: a sub-cell shift (ResolvedFeature.offset; centred pieces only, tiles stay on the grid)
        const c = frame.point(
          f.at[0] + fp[0] / 2 + (f.offset?.[0] ?? 0),
          f.at[1] + fp[1] / 2 + (f.offset?.[1] ?? 0),
        );
        const off = rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * frame.o.rotSense);
        emit(v, "feature", c.x - off.x, y, c.z - off.z, deg, src);
      }
      // assembly pieces: same anchor and rotation, each moved by its own offset (palette `parts`)
      const centre = frame.point(
        f.at[0] + fp[0] / 2 + (v.geom.originAt === "minCorner" ? 0 : (f.offset?.[0] ?? 0)),
        f.at[1] + fp[1] / 2 + (v.geom.originAt === "minCorner" ? 0 : (f.offset?.[1] ?? 0)),
      );
      for (const part of v.parts ?? []) {
        const pv: ResolvedVariant = {
          ...v,
          uuid: part.asset,
          wanted: part.asset,
          geom: part.geom,
          name: part.name ?? v.name,
          offset: { x: 0, y: 0, z: 0 },
          rot: v.rot,
        };
        delete pv.parts;
        const o = rotateXZ(part.offset?.x ?? 0, part.offset?.z ?? 0, deg * frame.o.rotSense);
        const py = y + v.offset.y + (part.offset?.y ?? 0);
        if (part.geom.originAt === "minCorner") {
          const swap = Math.round(deg / 90) % 2 === 1;
          const hx = (swap ? part.geom.size.z : part.geom.size.x) / 2;
          const hz = (swap ? part.geom.size.x : part.geom.size.z) / 2;
          emit(pv, "feature", centre.x + o.x - hx, py, centre.z + o.z - hz, deg, src);
        } else {
          const off = rotateXZ(part.geom.boundsCenter.x, part.geom.boundsCenter.z, deg * frame.o.rotSense);
          emit(pv, "feature", centre.x + o.x - off.x, py, centre.z + o.z - off.z, deg, src);
        }
      }
    }

    // ── buildings and enclosures ──
    if (L.structures?.length)
      realizeStructures({
        L,
        frame,
        seed,
        lookup: (theme, roles, filter, quiet) => lookup(L.id, theme, roles, filter, quiet),
        pick,
        facingOf,
        emit,
        groundTop: (x, y) => {
          const c = V.cell(x, y);
          return c.open ? topOf(c) : elev + 0.5;
        },
        info: (code, message, role) => {
          addDiag({
            severity: "info",
            code: code as CompileDiagnostic["code"],
            message,
            levelId: L.id,
            ...(role ? { role } : {}),
          });
        },
      });
    if (opts.omitLayers?.length) {
      const drop = new Set(opts.omitLayers);
      for (let i = placements.length - 1; i >= 0; i--) {
        const ly = placements[i]?.layer;
        if (ly !== undefined && drop.has(ly)) placements.splice(i, 1);
      }
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
      ...(L.waterLevel !== undefined ? { waterLevel: L.waterLevel, waterRange: L.waterRange ?? waterRangeOf(L) } : {}),
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
