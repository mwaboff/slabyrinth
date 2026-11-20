/**
 * Automatic design review: measured observations about a resolved plan, each with a suggested action, ranked and
 * capped (REVIEW.maxNotes). Advice for the model, never an error: it never blocks a build and changes nothing.
 * Deterministic and cheap (one pass per measure over the cells); thresholds are data (review/thresholds.ts).
 * The principles it measures are the product text in agent/designPrinciples.ts.
 */
import type { DesignBrief, MapPlan, Vec2 } from "../contracts/plan";
import {
  CELL,
  CELL_FLAG,
  type ResolvedLevel,
  type ResolvedPlan,
  type ResolvedStructure,
} from "../contracts/resolved";
import type { CompileDiagnostic, PaletteCatalog } from "../contracts/compiler";
import { loadPalettes } from "../palette/load";
import { createRoleResolver } from "../palette/resolve";
import { structureSignature, structureSilhouette, structureTone } from "../resolve/structureVariety";
import { structureRuinMeasures } from "../resolve/ruin";
import { components, longestInnerStraight, outline, squareCorners } from "./metrics";
import { forEachMaskCell } from "../gen/mask";
import { rasterizeShape } from "../gen/shapes";
import { OBSERVED_TONES } from "./tones";
import { briefNotes } from "./brief";
import {
  FORMAL_THEMES,
  REPEAT_WATCH,
  BAND_ROCK,
  COVER_FEATURES,
  SMALL_FEATURES,
  GROWTH_FEATURES,
  ROAD_FEATURES,
  FOCAL_FEATURES,
  NATURAL_FEATURES,
  NATURAL_MATERIALS,
  PRIMARY_FEATURES,
  REVIEW,
  SUBSTITUTION_CODES,
} from "./thresholds";

export type DesignNoteCode =
  | "flat_map"
  | "straight_natural"
  | "water_on_edge"
  | "rows_or_even_scatter"
  | "dead_space"
  | "lookalike_neighbours"
  | "path_to_nowhere"
  | "floor_patchwork"
  | "tone_cluster"
  | "roofs_alike"
  | "blank_lot"
  | "no_focal_point"
  | "competing_focals"
  | "landmark_against_wall"
  | "single_route"
  | "pieces_substituted"
  | "repeated_prop"
  | "symmetry"
  | "no_relief"
  | "street_without_sidewalk"
  | "misplaced_props"
  | "brief_not_met"
  | "bare_ground"
  | "square_terraces"
  | "patch_without_cause"
  | "focus_unreached"
  | "cliff_unclad"
  | "cliff_unclad_low"
  | "cliff_sheer"
  | "cliff_band_thin"
  | "cliff_no_crest"
  | "cliff_straight"
  | "cliff_repetition"
  | "cliff_hanging"
  | "rise_timid"
  | "board_rectangular"
  | "ruin_flat_top"
  | "ruin_uniform";

export interface ReviewOptions {
  /** Palettes for tone tags (default: the bundled palettes). */
  palettes?: PaletteCatalog;
  /** Build diagnostics, when a build ran: substituted and unresolved pieces become one note. */
  diagnostics?: readonly CompileDiagnostic[];
  /** The design brief (update_brief): words that map to a measure (review/brief.ts) are checked. */
  brief?: DesignBrief;
  /** Notes kept (default REVIEW.maxNotes; tests and the CLI may ask for all). */
  limit?: number;
}

export interface DesignNote {
  code: DesignNoteCode;
  levelId: string;
  /** Rank: the note's weight times how far past its threshold the measure is. */
  score: number;
  /** What was measured. */
  message: string;
  /** What to do about it. */
  action: string;
  cell?: Vec2;
  elementIds?: string[];
}

interface Ctx {
  plan: MapPlan;
  /** Tones of a floor role's variants in a theme (tagged variants only). */
  floorTones: (theme: string, material: string) => Set<string>;
  /** Tile families of a floor role and the largest one's share. */
  floorFamilies: (theme: string, material: string) => { families: number; dominant: number; toned: boolean };
  /** Distinct assets the theme has for a feature type (feature.<type>). */
  pieceKinds: (theme: string, type: string) => number;
  L: ResolvedLevel;
  W: number;
  H: number;
  walkable: Uint8Array;
  walkCount: number;
}

const over = (value: number, threshold: number): number => Math.min(3, value / Math.max(1e-9, threshold));

/** Review every level of a resolved plan. Notes are ranked across levels and capped. */
let bundled: PaletteCatalog | null = null;

export function reviewDesign(plan: MapPlan, resolved: ResolvedPlan, opts: ReviewOptions = {}): DesignNote[] {
  const notes: DesignNote[] = [];
  const role = createRoleResolver(opts.palettes ?? (bundled ??= loadPalettes()));
  const toneMemo = new Map<string, Set<string>>();
  const floorTones = (theme: string, material: string): Set<string> => {
    const k = `${theme}|${material}`;
    let t = toneMemo.get(k);
    if (!t) {
      t = new Set<string>();
      for (const v of role(theme, `floor.${material}`).resolution?.variants ?? [])
        if (v.weight > 0) {
          const tone = v.tone ?? OBSERVED_TONES[v.uuid]?.tone;
          if (tone !== undefined) t.add(tone);
        }
      toneMemo.set(k, t);
    }
    return t;
  };
  // tile families a floor role lays in one field, and the largest family's share of the pick weight
  const famMemo = new Map<string, { families: number; dominant: number; toned: boolean }>();
  const floorFamilies = (
    theme: string,
    material: string,
  ): { families: number; dominant: number; toned: boolean } => {
    const k = `${theme}|${material}`;
    let f = famMemo.get(k);
    if (!f) {
      const w = new Map<string, number>();
      for (const v of role(theme, `floor.${material}`).resolution?.variants ?? [])
        if (v.weight > 0) w.set(v.variant ?? "", (w.get(v.variant ?? "") ?? 0) + v.weight);
      const total = [...w.values()].reduce((a, b) => a + b, 0);
      f = {
        families: w.size,
        dominant: total > 0 ? Math.max(...w.values()) / total : 1,
        // a family of known contrasting tone (a tagged or observed dark or light piece) among them
        toned: [...floorTones(theme, material)].some((t) => t === "dark" || t === "light"),
      };
      famMemo.set(k, f);
    }
    return f;
  };
  const kindMemo = new Map<string, number>();
  const pieceKinds = (theme: string, type: string): number => {
    const k = `${theme}|${type}`;
    let n = kindMemo.get(k);
    if (n === undefined) {
      n = new Set(
        (role(theme, `feature.${type}`).resolution?.variants ?? [])
          .filter((v) => v.weight > 0)
          .map((v) => v.uuid),
      ).size;
      kindMemo.set(k, n);
    }
    return n;
  };
  for (const L of resolved.levels) {
    const W = L.bounds.w;
    const H = L.bounds.h;
    const walkable = new Uint8Array(W * H);
    let walkCount = 0;
    for (let i = 0; i < W * H; i++) {
      const f = L.cells.flags[i] as number;
      if (L.cells.state[i] === CELL.OPEN && (f & (CELL_FLAG.NO_FLOOR | CELL_FLAG.WATER)) === 0) {
        walkable[i] = 1;
        walkCount++;
      }
    }
    if (walkCount < REVIEW.minCells) continue;
    const ctx: Ctx = { plan, floorTones, floorFamilies, pieceKinds, L, W, H, walkable, walkCount };
    for (const fn of [
      flat,
      straight,
      scatter,
      deadSpace,
      blankLot,
      lookalikes,
      buildingTones,
      roofsAlike,
      floors,
      focus,
      routes,
      pathEnds,
      identicalProps,
      symmetry,
      relief,
      streets,
      bareGround,
      terraces,
      patches,
      reachFocus,
      cliffChecks,
      ruins,
    ])
      notes.push(...fn(ctx));
  }
  notes.push(...substitutionNotes(opts.diagnostics ?? [], resolved.levels[0]?.id ?? ""));
  notes.push(...briefNotes(opts.brief, plan, resolved, REVIEW.brief.weight));
  return notes
    .sort((a, b) => b.score - a.score || a.levelId.localeCompare(b.levelId) || a.code.localeCompare(b.code))
    .slice(0, opts.limit ?? REVIEW.maxNotes);
}

/** The review as text for a tool result (empty string when there is nothing to say). */
export function designReviewText(notes: readonly DesignNote[], briefLine = ""): string {
  if (notes.length === 0 && !briefLine) return "";
  const lines = notes.map((n) => {
    const where = n.cell ? ` @${Math.round(n.cell[0])},${Math.round(n.cell[1])}` : "";
    return `- [${n.code}] level ${n.levelId}${where}: ${n.message} → ${n.action}`;
  });
  if (briefLine) lines.push(briefLine);
  return `DESIGN REVIEW (advice, not errors; revise once for what matters):\n${lines.join("\n")}`;
}

// ───────────────────────── measures ─────────────────────────

function flat(c: Ctx): DesignNote[] {
  const T = REVIEW.flat;
  // built places get their height from the buildings (storeys, roofs): a street of several buildings may lie flat
  if ((c.L.structures ?? []).filter((s) => s.kind === "building").length >= T.buildingsGiveDepth) return [];
  const bands = new Map<number, number>();
  for (let i = 0; i < c.W * c.H; i++) {
    if (!c.walkable[i]) continue;
    const b = Math.floor((c.L.cells.height[i] as number) / 2);
    bands.set(b, (bands.get(b) ?? 0) + 1);
  }
  const top = Math.max(...bands.values());
  const share = top / c.walkCount;
  const levels = [...bands.values()].filter((n) => n / c.walkCount >= T.bandShare).length;
  if (share < T.maxShare && levels >= T.minBands) return [];
  const flatOut = levels < T.minBands;
  return [
    {
      code: "flat_map",
      levelId: c.L.id,
      score: T.weight * (flatOut ? Math.max(1.2, over(share, T.maxShare)) : 0.8 * over(share, T.maxShare)),
      message: flatOut
        ? `the map is flat: ${Math.round(share * 100)}% of the walkable floor is at one height`
        : `little height variation: ${Math.round(share * 100)}% of the walkable floor is at one height, the raised or sunken parts are small`,
      action: flatOut
        ? "add one or two bold level changes (a platform op with tiers, an area floorHeight, a sunken pit or a chasm op) and put the focal feature on the high ground"
        : "one bold level change would help: make a raised part larger or higher (platform op rise or tiers, an area floorHeight), or cut a pit or chasm",
    },
  ];
}

function straight(c: Ctx): DesignNote[] {
  const T = REVIEW.straight;
  const { L, W, H } = c;
  const out: DesignNote[] = [];
  const mat = (i: number): string => L.materials[(L.cells.material[i] ?? 1) - 1] ?? "";
  const trail: Array<[number, number]> = [];
  const water: Array<[number, number]> = [];
  let onEdge = 0;
  for (let i = 0; i < W * H; i++) {
    if (L.cells.state[i] !== CELL.OPEN) continue;
    const f = L.cells.flags[i] as number;
    const x = L.bounds.x + (i % W);
    const y = L.bounds.y + Math.floor(i / W);
    if ((f & CELL_FLAG.PATH) !== 0 && NATURAL_MATERIALS.has(mat(i))) trail.push([x, y]);
    if ((f & CELL_FLAG.WATER) !== 0) {
      water.push([x, y]);
      const lx = i % W;
      const ly = Math.floor(i / W);
      if (lx <= 1 || ly <= 1 || lx >= W - 2 || ly >= H - 2) onEdge++;
    }
  }
  const worst = (cells: Array<[number, number]>): { length: number; at: [number, number] } => {
    let best = { length: 0, at: [0, 0] as [number, number] };
    for (const comp of components(cells)) {
      const s = longestInnerStraight(comp, L.bounds);
      if (s.length > best.length) best = s;
    }
    return best;
  };
  const t = worst(trail);
  if (t.length > T.trail)
    out.push({
      code: "straight_natural",
      levelId: L.id,
      score: T.weight * over(t.length, T.trail),
      cell: t.at,
      message: `a natural trail edge runs straight for ${t.length} cells`,
      action:
        'let it wind: style "natural" with a few connect points off the straight line, not a route of right angles',
    });
  const w = worst(water);
  if (w.length > T.water)
    out.push({
      code: "straight_natural",
      levelId: L.id,
      score: T.weight * over(w.length, T.water),
      cell: w.at,
      message: `a water edge runs straight for ${w.length} cells`,
      action:
        "make the channel meander (a chasm op with a water floor, or points that bend) and vary its width",
    });
  if (water.length >= 12 && onEdge / water.length > T.waterOnEdge)
    out.push({
      code: "water_on_edge",
      levelId: L.id,
      score: T.weight * 0.8 * over(onEdge / water.length, T.waterOnEdge),
      message: `${Math.round((onEdge / water.length) * 100)}% of the water hugs the board edge`,
      action:
        "run the water across the map from one edge to another, through the play space, instead of along the border",
    });
  else if (water.length >= 12) {
    // a course that keeps to a strip along one edge, parallel to it, the whole way across
    const bandX = Math.max(3, Math.round(W * T.edgeBand));
    const bandY = Math.max(3, Math.round(H * T.edgeBand));
    const sides: Array<[string, (x: number, y: number) => boolean]> = [
      ["north", (_x, y) => y - L.bounds.y < bandY],
      ["south", (_x, y) => L.bounds.y + H - 1 - y < bandY],
      ["west", (x) => x - L.bounds.x < bandX],
      ["east", (x) => L.bounds.x + W - 1 - x < bandX],
    ];
    for (const [name, inBand] of sides) {
      const share = water.filter(([x, y]) => inBand(x, y)).length / water.length;
      if (share < T.edgeBandShare) continue;
      out.push({
        code: "water_on_edge",
        levelId: L.id,
        score: T.weight * 0.8 * over(share, T.edgeBandShare),
        message: `the water keeps to a strip along the ${name} edge (${Math.round(share * 100)}% of it), parallel to the border`,
        action:
          "bring it through the play space: bend its points toward the middle of the map, entering on one edge and leaving on another",
      });
      break;
    }
  }
  // natural risers: longest straight run of one step direction along a row or column
  const ok = (a: number, b: number): number => {
    if (L.cells.state[a] !== CELL.OPEN || L.cells.state[b] !== CELL.OPEN) return 0;
    // water banks are judged as water; bridges and stairs are built
    const fl = (L.cells.flags[a] as number) | (L.cells.flags[b] as number);
    if ((fl & (CELL_FLAG.BRIDGE | CELL_FLAG.STEPS | CELL_FLAG.WATER | CELL_FLAG.NO_FLOOR)) !== 0) return 0;
    if (!NATURAL_MATERIALS.has(mat(a)) && !NATURAL_MATERIALS.has(mat(b))) return 0;
    const d = (L.cells.height[a] as number) - (L.cells.height[b] as number);
    return Math.abs(d) >= T.riserMinQuarters ? Math.sign(d) : 0;
  };
  let best = 0;
  let bestAt: [number, number] = [0, 0];
  for (const horiz of [true, false]) {
    const A = horiz ? H : W;
    const B = horiz ? W : H;
    for (let u = 1; u < A; u++) {
      let run = 0;
      let dir = 0;
      for (let v = 0; v < B; v++) {
        const a = horiz ? (u - 1) * W + v : v * W + u - 1;
        const b = horiz ? u * W + v : v * W + u;
        const d = ok(a, b);
        run = d !== 0 && d === dir ? run + 1 : d !== 0 ? 1 : 0;
        dir = d;
        if (run > best) {
          best = run;
          bestAt = horiz ? [L.bounds.x + v, L.bounds.y + u] : [L.bounds.x + u, L.bounds.y + v];
        }
      }
    }
  }
  if (best > T.riser)
    out.push({
      code: "straight_natural",
      levelId: L.id,
      score: T.weight * over(best, T.riser),
      cell: bestAt,
      message: `a natural rise runs ruler-straight for ${best} cells`,
      action:
        'use edge "ragged" (one platform with several tiers rather than stacked ops over one shape), or clad the edge with rock and growth',
    });
  return out;
}

function scatter(c: Ctx): DesignNote[] {
  const T = REVIEW.scatter;
  const groups = new Map<string, Array<{ x: number; y: number; id: string }>>();
  for (const f of c.L.features) {
    if (!NATURAL_FEATURES.has(f.type)) continue;
    const g = groups.get(f.type) ?? [];
    g.push({ x: f.at[0] + f.size[0] / 2, y: f.at[1] + f.size[1] / 2, id: f.id });
    groups.set(f.type, g);
  }
  const out: DesignNote[] = [];
  for (const [type, pts] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // rows: a chain of evenly spaced pieces along one step vector
    let row = 0;
    let rowAt: [number, number] = [0, 0];
    const near = (x: number, y: number): boolean =>
      pts.some((p) => Math.abs(p.x - x) <= T.rowTolerance && Math.abs(p.y - y) <= T.rowTolerance);
    for (let a = 0; a < pts.length; a++)
      for (let b = 0; b < pts.length; b++) {
        if (a === b) continue;
        const pa = pts[a] as { x: number; y: number };
        const pb = pts[b] as { x: number; y: number };
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const step = Math.hypot(dx, dy);
        if (step < T.rowMinStep || step > T.rowMaxStep) continue;
        // only count from the start of a chain
        if (near(pa.x - dx, pa.y - dy)) continue;
        let n = 2;
        while (near(pa.x + dx * n, pa.y + dy * n)) n++;
        if (n > row) {
          row = n;
          rowAt = [pa.x, pa.y];
        }
      }
    // small ground pieces sit on a dense lattice and line up by chance more easily
    if (row >= (SMALL_FEATURES.has(type) ? T.rowSmall : T.row))
      out.push({
        code: "rows_or_even_scatter",
        levelId: c.L.id,
        score: T.weight * over(row, T.row),
        cell: rowAt,
        message: `${row} pieces of ${type} stand evenly spaced in a row`,
        action: "break the row: cluster them in uneven groups with gaps, as growth or rockfall would",
      });
    // even spread: Clark–Evans ratio over the group's bounding box
    if (pts.length >= T.evenMinCount) {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const area = (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1);
      let sum = 0;
      for (const p of pts) {
        let d = Infinity;
        for (const q of pts) if (q !== p) d = Math.min(d, Math.hypot(q.x - p.x, q.y - p.y));
        sum += d;
      }
      const ratio = sum / pts.length / (0.5 / Math.sqrt(pts.length / area));
      if (ratio > T.evenRatio)
        out.push({
          code: "rows_or_even_scatter",
          levelId: c.L.id,
          score: T.weight * 0.9 * over(ratio, T.evenRatio),
          message: `${pts.length} pieces of ${type} are spread evenly (spacing ratio ${ratio.toFixed(2)}; clustered growth is below 1)`,
          action:
            "gather them into a few dense clumps with open ground between, denser at edges and around a cause (water, a wall, a fallen tree)",
        });
    }
  }
  return out;
}

function deadSpace(c: Ctx): DesignNote[] {
  const T = REVIEW.deadSpace;
  const { L, W, H } = c;
  // distance (Chebyshev) to anything with a purpose: features, structures, paths, water, walls of the level
  const busy = new Uint8Array(W * H);
  const mark = (x: number, y: number): void => {
    const lx = x - L.bounds.x;
    const ly = y - L.bounds.y;
    if (lx >= 0 && ly >= 0 && lx < W && ly < H) busy[ly * W + lx] = 1;
  };
  for (const f of L.features)
    for (let dy = 0; dy < f.size[1]; dy++)
      for (let dx = 0; dx < f.size[0]; dx++) mark(f.at[0] + dx, f.at[1] + dy);
  for (const st of L.structures ?? []) for (const [x, y] of st.cells) mark(x, y);
  for (let i = 0; i < W * H; i++) {
    const f = L.cells.flags[i] as number;
    if (L.cells.state[i] !== CELL.OPEN || (f & (CELL_FLAG.PATH | CELL_FLAG.WATER | CELL_FLAG.LINK)) !== 0)
      busy[i] = 1;
    const a = L.areas[(L.cells.area[i] ?? 0) - 1];
    if (a?.kind === "building") busy[i] = 1;
  }
  const near = new Uint8Array(W * H);
  const r = T.clearance;
  for (let i = 0; i < W * H; i++) {
    if (!busy[i]) continue;
    const x = i % W;
    const y = Math.floor(i / W);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H) near[ny * W + nx] = 1;
      }
  }
  const empty: Array<[number, number]> = [];
  for (let i = 0; i < W * H; i++)
    if (c.walkable[i] && !near[i]) empty.push([L.bounds.x + (i % W), L.bounds.y + Math.floor(i / W)]);
  let big: Array<[number, number]> = [];
  for (const comp of components(empty)) if (comp.length > big.length) big = comp;
  const share = big.length / c.walkCount;
  if (big.length < T.minCells || share < T.minShare) return [];
  const cx = big.reduce((s, p) => s + p[0], 0) / big.length;
  const cy = big.reduce((s, p) => s + p[1], 0) / big.length;
  return [
    {
      code: "dead_space",
      levelId: L.id,
      score: T.weight * over(share, T.minShare),
      cell: [cx, cy],
      message: `an empty region of ${big.length} cells (${Math.round(share * 100)}% of the floor) has nothing in it and no purpose`,
      action:
        "give it a purpose (a yard, a garden, a camp, a ruin, a pond), shape it with terrain, or bound it so the open ground is deliberate and sized for play",
    },
  ];
}

function lookalikes(c: Ctx): DesignNote[] {
  const T = REVIEW.lookalike;
  const bs = (c.L.structures ?? []).filter((s) => s.kind === "building");
  const box = (s: ResolvedStructure): { x0: number; y0: number; x1: number; y1: number } => {
    const xs = s.cells.map((p) => p[0]);
    const ys = s.cells.map((p) => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };
  const axes = (s: ResolvedStructure): string[] => {
    const b = box(s);
    const area = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
    const height = s.storeys.reduce((t, q) => t + q.wallHeight, 0);
    return [
      `storeys:${s.design?.storeys ?? s.storeys.length}`,
      `walls:${s.design?.material ?? s.storeys[0]?.walls ?? "none"}`,
      `roof:${s.roof.type}/${s.design?.roof ?? s.roof.style}`,
      `size:${area < 30 ? "s" : area < 60 ? "m" : area < 100 ? "l" : "xl"}`,
      `height:${Math.round(height)}`,
      `tone:${structureTone(s) ?? "?"}`,
      // massing from any side and from above (the building engineer's measure, positions dropped)
      `silhouette:${structureSilhouette(s)
        .split(";")
        .map((p) => p.replace(/^-?\d+,-?\d+,/, ""))
        .join(";")}`,
    ];
  };
  const pairs: string[] = [];
  let at: Vec2 | undefined;
  for (let i = 0; i < bs.length; i++)
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i] as ResolvedStructure;
      const b = bs[j] as ResolvedStructure;
      const ba = box(a);
      const bb = box(b);
      const gx = Math.max(0, Math.max(ba.x0, bb.x0) - Math.min(ba.x1, bb.x1) - 1);
      const gy = Math.max(0, Math.max(ba.y0, bb.y0) - Math.min(ba.y1, bb.y1) - 1);
      if (Math.max(gx, gy) > T.gap) continue;
      const xa = axes(a);
      const xb = axes(b);
      const differ = xa.filter((v, k) => v !== xb[k]).length;
      // the same drawn design (every variety axis) is a lookalike whatever the size
      const sa = structureSignature(a);
      const same = sa !== null && sa === structureSignature(b);
      if (differ >= T.minAxes && !same) continue;
      pairs.push(`${a.id}/${b.id}`);
      at ??= [(ba.x0 + bb.x1) / 2, (ba.y0 + bb.y1) / 2];
    }
  if (pairs.length === 0) return [];
  return [
    {
      code: "lookalike_neighbours",
      levelId: c.L.id,
      score: T.weight * Math.min(3, 0.8 + pairs.length * 0.4),
      ...(at ? { cell: at } : {}),
      elementIds: pairs.flatMap((p) => p.split("/")).filter((v, k, s) => s.indexOf(v) === k),
      message: `neighbouring buildings differ on fewer than ${T.minAxes} of storeys, walls, roof, size, height and tone: ${pairs.slice(0, 4).join(", ")}`,
      action:
        "give each its own role and silhouette: change storeys, wall material, roof form or footprint so neighbours differ on two or more",
    },
  ];
}

function pathEnds(c: Ctx): DesignNote[] {
  const T = REVIEW.pathEnd;
  const { L, W, H } = c;
  const lv = c.plan.levels.find((l) => l.id === L.id);
  if (!lv) return [];
  const goal = new Uint8Array(W * H);
  const mark = (x: number, y: number): void => {
    const lx = x - L.bounds.x;
    const ly = y - L.bounds.y;
    if (lx >= 0 && ly >= 0 && lx < W && ly < H) goal[ly * W + lx] = 1;
  };
  for (const f of L.features)
    for (let dy = 0; dy < f.size[1]; dy++)
      for (let dx = 0; dx < f.size[0]; dx++) mark(f.at[0] + dx, f.at[1] + dy);
  for (const st of L.structures ?? []) for (const [x, y] of st.cells) mark(x, y);
  for (const o of L.openings) {
    // both cells beside the opening
    mark(o.start[0], o.start[1]);
    if (o.orientation === "h") mark(o.start[0], o.start[1] - 1);
    else mark(o.start[0] - 1, o.start[1]);
  }
  for (let i = 0; i < W * H; i++) {
    const f = L.cells.flags[i] as number;
    if ((f & (CELL_FLAG.WATER | CELL_FLAG.LINK | CELL_FLAG.BRIDGE)) !== 0) goal[i] = 1;
    const a = L.areas[(L.cells.area[i] ?? 0) - 1];
    if (a !== undefined && a.kind !== "zone" && a.kind !== "courtyard") goal[i] = 1;
  }
  // cells of each path op, to tell its own cells from another path's
  const ends: Array<{ id: string; p: Vec2 }> = [];
  const pathCells = new Map<string, Set<string>>();
  for (const op of lv.terrain) {
    if (op.op !== "path" || !op.points || op.points.length < 2) continue;
    // water courses are judged as water (they run to the board edge by default)
    if (op.material === "water_shallow" || op.material === "water_deep") continue;
    const pts = op.points;
    ends.push({ id: op.id, p: pts[0] as Vec2 }, { id: op.id, p: pts[pts.length - 1] as Vec2 });
    const own = new Set<string>();
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k] as Vec2;
      const b = pts[k + 1] as Vec2;
      const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
      for (let s = 0; s <= n; s++)
        own.add(
          `${Math.round(a[0] + ((b[0] - a[0]) * s) / n)},${Math.round(a[1] + ((b[1] - a[1]) * s) / n)}`,
        );
    }
    pathCells.set(op.id, own);
  }
  const lost: Array<{ id: string; p: Vec2 }> = [];
  for (const e of ends) {
    const [x, y] = e.p;
    const lx = x - L.bounds.x;
    const ly = y - L.bounds.y;
    if (lx <= T.reach || ly <= T.reach || lx >= W - 1 - T.reach || ly >= H - 1 - T.reach) continue;
    let found = false;
    for (let dy = -T.reach; dy <= T.reach && !found; dy++)
      for (let dx = -T.reach; dx <= T.reach && !found; dx++) {
        const nx = lx + dx;
        const ny = ly + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (goal[ny * W + nx]) found = true;
        else
          for (const [id, cells] of pathCells)
            if (id !== e.id && cells.has(`${x + dx},${y + dy}`)) found = true;
      }
    if (!found) lost.push(e);
  }
  if (lost.length === 0) return [];
  return [
    {
      code: "path_to_nowhere",
      levelId: L.id,
      score: T.weight * Math.min(3, 0.8 + lost.length * 0.3),
      cell: (lost[0] as { p: Vec2 }).p,
      elementIds: lost.map((l) => l.id).filter((v, k, s) => s.indexOf(v) === k),
      message: `${lost.length} path end${lost.length === 1 ? "" : "s"} stop in open ground with nothing there`,
      action:
        "end each path at something: an entrance, the focal feature, water, another path or the map edge (or use connect)",
    },
  ];
}

// ───────────────────────── buildings: tone and roofs ─────────────────────────

const boxOf = (s: ResolvedStructure): { x0: number; y0: number; x1: number; y1: number } => {
  const xs = s.cells.map((p) => p[0]);
  const ys = s.cells.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};
const gapBetween = (a: ResolvedStructure, b: ResolvedStructure): number => {
  const ba = boxOf(a);
  const bb = boxOf(b);
  const gx = Math.max(0, Math.max(ba.x0, bb.x0) - Math.min(ba.x1, bb.x1) - 1);
  const gy = Math.max(0, Math.max(ba.y0, bb.y0) - Math.min(ba.y1, bb.y1) - 1);
  return Math.max(gx, gy);
};
const buildingsOf = (c: Ctx): ResolvedStructure[] =>
  (c.L.structures ?? []).filter((s) => s.kind === "building");
/** Groups of neighbouring buildings (footprints within `gap` cells) that share a key. */
function neighbourGroups(
  bs: readonly ResolvedStructure[],
  gap: number,
  key: (s: ResolvedStructure) => string | undefined,
): ResolvedStructure[][] {
  const seen = new Set<string>();
  const out: ResolvedStructure[][] = [];
  for (const b of bs) {
    const k = key(b);
    if (k === undefined || seen.has(b.id)) continue;
    const group = [b];
    seen.add(b.id);
    for (let i = 0; i < group.length; i++)
      for (const o of bs)
        if (!seen.has(o.id) && key(o) === k && gapBetween(group[i] as ResolvedStructure, o) <= gap) {
          seen.add(o.id);
          group.push(o);
        }
    if (group.length > 1) out.push(group);
  }
  return out;
}
const centreOf = (g: readonly ResolvedStructure[]): Vec2 => {
  const cs = g.flatMap((s) => s.cells);
  return [cs.reduce((t, p) => t + p[0], 0) / cs.length, cs.reduce((t, p) => t + p[1], 0) / cs.length];
};

function buildingTones(c: Ctx): DesignNote[] {
  const T = REVIEW.tone;
  const groups = neighbourGroups(buildingsOf(c), T.gap, (s) =>
    structureTone(s) === "dark" ? "dark" : undefined,
  ).filter((g) => g.length >= T.darkCluster);
  if (groups.length === 0) return [];
  const g = groups.sort((a, b) => b.length - a.length)[0] as ResolvedStructure[];
  return [
    {
      code: "tone_cluster",
      levelId: c.L.id,
      score: T.weight * over(g.length, T.darkCluster),
      cell: centreOf(g),
      elementIds: g.map((s) => s.id),
      message: `${g.length} dark-walled buildings stand together (${g.map((s) => s.id).join(", ")}): dark on dark disappears`,
      action:
        "give all but one of them a lighter wall material (a storey's walls, or another use or seed), or put a light building between them",
    },
  ];
}

function roofsAlike(c: Ctx): DesignNote[] {
  const T = REVIEW.roofs;
  const surface = (s: ResolvedStructure): string => `${s.roof.type}/${s.design?.roofSurface ?? s.roof.style}`;
  const groups = neighbourGroups(buildingsOf(c), T.gap, surface).filter((g) => g.length >= T.alike);
  if (groups.length === 0) return [];
  const g = groups.sort((a, b) => b.length - a.length)[0] as ResolvedStructure[];
  return [
    {
      code: "roofs_alike",
      levelId: c.L.id,
      score: T.weight * over(g.length, T.alike),
      cell: centreOf(g),
      elementIds: g.map((s) => s.id),
      message: `${g.length} neighbouring roofs look the same from above (${surface(g[0] as ResolvedStructure)}: ${g.map((s) => s.id).join(", ")})`,
      action:
        "vary roof form or surface between neighbours (roof type, roof style kit, a rooftop volume or furniture) so each reads from above",
    },
  ];
}

// ───────────────────────── ground ─────────────────────────

function floors(c: Ctx): DesignNote[] {
  const T = REVIEW.floors;
  const { L, W, H } = c;
  // open ground outside buildings, paths and bridges: the "field"
  const count = new Map<string, { n: number; theme: string }>();
  let field = 0;
  for (let i = 0; i < W * H; i++) {
    if (!c.walkable[i]) continue;
    if (((L.cells.flags[i] as number) & (CELL_FLAG.PATH | CELL_FLAG.BRIDGE)) !== 0) continue;
    if (L.areas[(L.cells.area[i] ?? 0) - 1]?.kind === "building") continue;
    const m = L.materials[(L.cells.material[i] ?? 1) - 1] ?? "";
    const theme = L.themes[L.cells.theme[i] ?? 0] ?? "generic";
    const e = count.get(m) ?? { n: 0, theme };
    e.n++;
    count.set(m, e);
    field++;
  }
  if (field < REVIEW.minCells) return [];
  const big = [...count.entries()]
    .filter(([, e]) => e.n / field >= T.minShare)
    .sort((a, b) => b[1].n - a[1].n);
  const out: DesignNote[] = [];
  // tile families of one material that mix dark and light (tone tags), or materials of clashing tone
  const tones = new Map<string, string[]>();
  for (const [m, e] of big)
    for (const t of c.floorTones(e.theme, m)) tones.set(t, [...(tones.get(t) ?? []), m]);
  if (tones.has("dark") && tones.has("light")) {
    const mats = [...new Set([...(tones.get("dark") ?? []), ...(tones.get("light") ?? [])])];
    out.push({
      code: "floor_patchwork",
      levelId: L.id,
      score: T.weight * 1.2,
      message: `the ground mixes dark and light tiles in one field (${mats.map((m) => `floor ${m}`).join(", ")}): it reads as a patchwork`,
      action:
        "keep one dominant floor in a single tone across the field; use the contrasting one only for a few deliberate patches (a paint or noise op with low coverage)",
    });
  }
  // one material laid as several tile families with none dominant
  const top = big[0];
  if (top && top[1].n / field >= T.familyFieldShare) {
    const fam = c.floorFamilies(top[1].theme, top[0]);
    if (fam.toned && fam.families >= T.families && fam.dominant < T.dominant)
      out.push({
        code: "floor_patchwork",
        levelId: L.id,
        score: T.weight * over(T.dominant, fam.dominant),
        message: `the ${top[0]} floor (${Math.round((top[1].n / field) * 100)}% of the ground) is laid as ${fam.families} tile families with none dominant (largest ${Math.round(fam.dominant * 100)}%): it reads as a patchwork`,
        action: `let one floor dominate: paint most of the field with a single material and keep ${top[0]} for patches and edges (paint or noise ops)`,
      });
  }
  const dominant = (big[0]?.[1].n ?? 0) / field;
  if (big.length >= T.materials && dominant < T.dominant)
    out.push({
      code: "floor_patchwork",
      levelId: L.id,
      score: T.weight * over(T.dominant, dominant),
      message: `${big.length} floor materials share the open ground with none dominant (${big
        .map(([m, e]) => `${m} ${Math.round((e.n / field) * 100)}%`)
        .join(", ")})`,
      action:
        "pick one dominant floor (about two thirds of the ground) and keep the others as accents along edges, paths and under features",
    });
  return out;
}

function blankLot(c: Ctx): DesignNote[] {
  const T = REVIEW.blankLot;
  const { L, W, H } = c;
  const busy = new Uint8Array(W * H);
  const mark = (x: number, y: number): void => {
    const lx = x - L.bounds.x;
    const ly = y - L.bounds.y;
    if (lx >= 0 && ly >= 0 && lx < W && ly < H) busy[ly * W + lx] = 1;
  };
  for (const f of L.features)
    for (let dy = 0; dy < f.size[1]; dy++)
      for (let dx = 0; dx < f.size[0]; dx++) mark(f.at[0] + dx, f.at[1] + dy);
  for (const st of L.structures ?? []) for (const [x, y] of st.cells) mark(x, y);
  for (const rd of L.roads ?? []) {
    for (const [x, y] of rd.carriageway) mark(x, y);
    for (const [x, y] of rd.pavement) mark(x, y);
  }
  for (const i of L.reserved ?? []) busy[i] = 1;
  for (let i = 0; i < W * H; i++) {
    const f = L.cells.flags[i] as number;
    if (L.cells.state[i] !== CELL.OPEN || (f & (CELL_FLAG.PATH | CELL_FLAG.WATER | CELL_FLAG.LINK)) !== 0)
      busy[i] = 1;
    if (L.areas[(L.cells.area[i] ?? 0) - 1]?.kind === "building") busy[i] = 1;
  }
  // paved (built) ground at least `clearance` from anything with a purpose
  const r = T.clearance;
  const empty: Array<[number, number]> = [];
  for (let i = 0; i < W * H; i++) {
    if (!c.walkable[i] || busy[i]) continue;
    const m = L.materials[(L.cells.material[i] ?? 1) - 1] ?? "";
    if (NATURAL_MATERIALS.has(m)) continue;
    const x = i % W;
    const y = Math.floor(i / W);
    let near = false;
    for (let dy = -r; dy <= r && !near; dy++)
      for (let dx = -r; dx <= r && !near; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && busy[ny * W + nx]) near = true;
      }
    if (!near) empty.push([L.bounds.x + x, L.bounds.y + y]);
  }
  // a lot, not a strip: its core (cells with the whole 5×5 around them empty) must be large too
  const emptySet = new Set(empty.map(([x, y]) => `${x},${y}`));
  const coreOf = (comp: ReadonlyArray<[number, number]>): number =>
    comp.filter(([x, y]) => {
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) if (!emptySet.has(`${x + dx},${y + dy}`)) return false;
      return true;
    }).length;
  let big: Array<[number, number]> = [];
  let bigCore = 0;
  for (const comp of components(empty)) {
    if (comp.length < T.minCells) continue;
    const core = coreOf(comp);
    if (core > bigCore) {
      big = comp;
      bigCore = core;
    }
  }
  if (big.length < T.minCells || bigCore < T.minCore) return [];
  return [
    {
      code: "blank_lot",
      levelId: L.id,
      score: T.weight * over(big.length, T.minCells),
      cell: [big.reduce((t, p) => t + p[0], 0) / big.length, big.reduce((t, p) => t + p[1], 0) / big.length],
      message: `a blank paved lot of about ${big.length} cells has no use`,
      action:
        "give it one: a car park or yard (an enclosure with vehicles or crates), a market, a garden, or a building",
    },
  ];
}

// ───────────────────────── focus and routes ─────────────────────────

function focus(c: Ctx): DesignNote[] {
  const T = REVIEW.focus;
  const { L } = c;
  const out: DesignNote[] = [];
  // a focal point: a focal feature, or in a built place a square, park or yard (an enclosure or courtyard)
  const focal =
    L.features.some((f) => FOCAL_FEATURES.has(f.type)) ||
    (L.structures ?? []).some((s) => s.kind === "enclosure") ||
    L.areas.some((a) => a.kind === "courtyard");
  if (c.walkCount >= T.minCellsForFocal && !focal)
    out.push({
      code: "no_focal_point",
      levelId: L.id,
      score: T.weight,
      message: "nothing stands out as the focal point",
      action:
        "add one primary feature (a landmark, statue, altar, great tree, fountain; in a town a square or park) on high or central ground and let paths lead to it",
    });
  // primary pieces grouped within `groupRadius`: more than `maxPrimaries` groups compete
  const prim = L.features.filter((f) => PRIMARY_FEATURES.has(f.type));
  const groups: Array<typeof prim> = [];
  for (const f of prim) {
    const g = groups.find((q) =>
      q.some((o) => Math.max(Math.abs(o.at[0] - f.at[0]), Math.abs(o.at[1] - f.at[1])) <= T.groupRadius),
    );
    if (g) g.push(f);
    else groups.push([f]);
  }
  if (groups.length > T.maxPrimaries)
    out.push({
      code: "competing_focals",
      levelId: L.id,
      score: T.weight * over(groups.length, T.maxPrimaries),
      elementIds: groups.map((g) => g[0]?.id ?? ""),
      message: `${groups.length} big landmark pieces in different places compete for attention`,
      action: "keep one primary landmark; make the others smaller (secondary) or group them with it",
    });
  // a big piece jammed against a wall or rock
  for (const f of prim) {
    let touches = false;
    for (let dy = -1; dy <= f.size[1] && !touches; dy++)
      for (let dx = -1; dx <= f.size[0] && !touches; dx++) {
        const lx = f.at[0] + dx - L.bounds.x;
        const ly = f.at[1] + dy - L.bounds.y;
        if (lx < 0 || ly < 0 || lx >= c.W || ly >= c.H) continue;
        if (L.cells.state[ly * c.W + lx] !== CELL.OPEN) touches = true;
      }
    if (!touches) continue;
    out.push({
      code: "landmark_against_wall",
      levelId: L.id,
      score: T.weight * 0.7,
      cell: f.at,
      elementIds: [f.id],
      message: `the landmark ${f.id} (${f.type}) stands against a wall or rock face`,
      action: "move it into open ground with space around it, where it can be seen from the approach",
    });
    break;
  }
  return out;
}

function routes(c: Ctx): DesignNote[] {
  const T = REVIEW.routes;
  const { L } = c;
  const rooms = new Set(L.areas.filter((a) => a.kind !== "zone" && a.kind !== "building").map((a) => a.id));
  if (rooms.size < T.minRooms) return [];
  const edges = new Set<string>();
  const nodes = new Set<string>();
  for (const o of L.openings) {
    const [a, b] = o.sides;
    if (a === null || b === null || a === b || !rooms.has(a) || !rooms.has(b)) continue;
    edges.add(a < b ? `${a}|${b}` : `${b}|${a}`);
    nodes.add(a);
    nodes.add(b);
  }
  // connected rooms with no loop: edges = nodes − 1
  if (nodes.size < T.minRooms || edges.size >= nodes.size) return [];
  return [
    {
      code: "single_route",
      levelId: L.id,
      score: T.weight,
      message: `the ${nodes.size} rooms connect in a single branching route with no loop`,
      action:
        "add a second way through: an opening or passage that joins two rooms on different branches into a loop",
    },
  ];
}

/** Substituted and unresolved pieces of a build as one note (empty when none). */
export function substitutionNotes(diags: readonly CompileDiagnostic[], levelId = ""): DesignNote[] {
  const T = REVIEW.substitutions;
  const hit = diags.filter((d) => SUBSTITUTION_CODES.has(d.code));
  if (hit.length === 0) return [];
  const n = hit.reduce((t, d) => t + (d.count ?? 1), 0);
  const ids = [
    ...new Set(
      hit.flatMap(
        (d) => d.elementIds ?? (d.elementId !== undefined ? [d.elementId] : d.role ? [d.role] : []),
      ),
    ),
  ];
  return [
    {
      code: "pieces_substituted",
      levelId: hit[0]?.levelId ?? levelId,
      score: T.weight * Math.min(3, 0.8 + n * 0.1),
      ...(ids.length > 0 ? { elementIds: ids.slice(0, 8) } : {}),
      message: `${n} piece${n === 1 ? " was" : "s were"} unresolved or substituted (${[...new Set(hit.map((d) => d.code))].join(", ")}${ids.length ? `: ${ids.slice(0, 6).join(", ")}` : ""})`,
      action:
        "a wrong object is worse than none: change those hints or styles to pieces the theme has, or remove them",
    },
  ];
}

// ───────────────────────── repetition and symmetry ─────────────────────────

function identicalProps(c: Ctx): DesignNote[] {
  const T = REVIEW.identical;
  const groups = new Map<string, { n: number; ids: string[]; theme: string; type: string }>();
  for (const f of c.L.features) {
    if (!REPEAT_WATCH.has(f.type)) continue;
    const k = `${f.type}|${f.variant ?? ""}|${f.hint ?? ""}`;
    const g = groups.get(k) ?? { n: 0, ids: [], theme: f.theme, type: f.type };
    g.n++;
    g.ids.push(f.id);
    groups.set(k, g);
  }
  const out: DesignNote[] = [];
  for (const g of [...groups.values()].sort((a, b) => b.n - a.n)) {
    // the theme's piece choice: a role with few variants repeats the same asset
    const kinds = c.pieceKinds(g.theme, g.type);
    if (g.n < T.count || kinds > T.maxKinds) continue;
    out.push({
      code: "repeated_prop",
      levelId: c.L.id,
      score: T.weight * over(g.n, T.count),
      elementIds: g.ids.slice(0, 6),
      message: `${g.n} ${g.type} pieces look identical (the theme has ${kinds} kind${kinds === 1 ? "" : "s"} of ${g.type})`,
      action: `use fewer, or mix them with other pieces of the same purpose (variants, a custom hint, other features); never more than ${T.count - 1} of one look in view`,
    });
    break;
  }
  return out;
}

function symmetry(c: Ctx): DesignNote[] {
  const T = REVIEW.symmetry;
  const { L } = c;
  if (FORMAL_THEMES.has(L.themes[0] ?? "")) return [];
  // occupied cells: building footprints and blocking features
  const occ = new Set<string>();
  for (const st of L.structures ?? [])
    if (st.kind === "building") for (const [x, y] of st.cells) occ.add(`${x},${y}`);
  for (const f of L.features)
    if (!NATURAL_FEATURES.has(f.type))
      for (let dy = 0; dy < f.size[1]; dy++)
        for (let dx = 0; dx < f.size[0]; dx++) occ.add(`${f.at[0] + dx},${f.at[1] + dy}`);
  if (occ.size < T.minCells) return [];
  const cells = [...occ].map((k) => k.split(",").map(Number) as [number, number]);
  // mirror lines: the level's centre lines and every straight road axis
  const lines: Array<{ v: boolean; at: number }> = [
    { v: true, at: L.bounds.x + L.bounds.w / 2 - 0.5 },
    { v: false, at: L.bounds.y + L.bounds.h / 2 - 0.5 },
  ];
  for (const rd of L.roads ?? []) {
    const a = rd.axis[0];
    const b = rd.axis[rd.axis.length - 1];
    if (!a || !b) continue;
    if (a[1] === b[1]) lines.push({ v: false, at: a[1] });
    else if (a[0] === b[0]) lines.push({ v: true, at: a[0] });
  }
  let best = 0;
  let bestLine: { v: boolean; at: number } | null = null;
  for (const ln of lines) {
    let hit = 0;
    for (const [x, y] of cells) {
      const mx = ln.v ? Math.round(2 * ln.at - x) : x;
      const my = ln.v ? y : Math.round(2 * ln.at - y);
      if (occ.has(`${mx},${my}`)) hit++;
    }
    const share = hit / cells.length;
    if (share > best) {
      best = share;
      bestLine = ln;
    }
  }
  if (best < T.share || !bestLine) return [];
  return [
    {
      code: "symmetry",
      levelId: L.id,
      score: T.weight * over(best, T.share),
      message: `the layout is mirrored: ${Math.round(best * 100)}% of the buildings and props have a twin across the ${
        bestLine.v ? `line x=${bestLine.at}` : `line y=${bestLine.at}`
      }`,
      action:
        "break the mirror for an everyday place: vary building widths, setbacks and heights on each side, and put the focal feature off-centre",
    },
  ];
}

// ───────────────────────── relief and streets ─────────────────────────

function relief(c: Ctx): DesignNote[] {
  const T = REVIEW.relief;
  const { L, W, H } = c;
  const built = buildingsOf(c).length + (L.roads?.length ?? 0);
  let naturalCells = 0;
  let pavedCells = 0;
  for (let i = 0; i < W * H; i++) {
    if (!c.walkable[i]) continue;
    const m = L.materials[(L.cells.material[i] ?? 1) - 1] ?? "";
    if (NATURAL_MATERIALS.has(m)) naturalCells++;
    else pavedCells++;
  }
  // growth only (theme slots such as ground cover may be litter in a town)
  const naturalProps = L.features.filter((f) => GROWTH_FEATURES.has(f.type)).length;
  const builtProps = L.features.filter((f) => !NATURAL_FEATURES.has(f.type)).length;
  if (built >= T.builtMin && naturalCells / c.walkCount < T.minShare && naturalProps < T.minGrowth)
    return [
      {
        code: "no_relief",
        levelId: L.id,
        score: T.weight,
        message: "a built-up place with no natural element at all: nothing to relieve the stone and paving",
        action:
          "give it a pocket of contrast: a strip of grass or a few trees by a wall, a planted square or yard (a paint op of grass, tree or undergrowth features)",
      },
    ];
  if (
    built === 0 &&
    (L.structures ?? []).length === 0 &&
    pavedCells / c.walkCount < T.minShare &&
    builtProps === 0
  )
    return [
      {
        code: "no_relief",
        levelId: L.id,
        score: T.weight * 0.8,
        message: "a wild place with no trace of people: nothing tells a story",
        action:
          "add one trace of use: a campfire, a cairn or signpost, a ruin, a trail, a fallen cart (a feature or a path op)",
      },
    ];
  return [];
}

function streets(c: Ctx): DesignNote[] {
  const { L } = c;
  const roads = L.roads ?? [];
  if (roads.length === 0) return [];
  const out: DesignNote[] = [];
  const carriage = new Set(roads.flatMap((r) => r.carriageway.map(([x, y]) => `${x},${y}`)));
  const pavement = new Set(roads.flatMap((r) => r.pavement.map(([x, y]) => `${x},${y}`)));
  const crossing = new Set(
    roads.flatMap((r) => r.crossings.flatMap((q) => q.cells.map(([x, y]) => `${x},${y}`))),
  );
  // a straight paved path that runs into a road without being one: no junction, no kerb or pavement
  const lv = c.plan.levels.find((l) => l.id === L.id);
  const joins: string[] = [];
  for (const op of lv?.terrain ?? []) {
    if (op.op !== "path" || op.sidewalk !== undefined || op.crossings !== undefined) continue;
    if (NATURAL_MATERIALS.has(op.material) || !op.points || op.points.length < 2) continue;
    const ends = [op.points[0] as Vec2, op.points[op.points.length - 1] as Vec2];
    if (ends.some(([x, y]) => carriage.has(`${x},${y}`))) joins.push(op.id);
  }
  if (joins.length > 0)
    out.push({
      code: "street_without_sidewalk",
      levelId: L.id,
      score: REVIEW.streets.weight,
      elementIds: joins,
      message: `${joins.join(", ")} meets a road as a plain path: no junction, kerb or pavement forms`,
      action:
        "give it `sidewalk` (and crossings if people cross it) so it becomes a side street with a proper junction",
    });
  // props standing where they do not belong: anything but vehicles in the carriageway or on a crossing, vehicles on
  // the pavement
  const wrong: string[] = [];
  let at: Vec2 | undefined;
  for (const f of L.features) {
    const cells: string[] = [];
    for (let dy = 0; dy < f.size[1]; dy++)
      for (let dx = 0; dx < f.size[0]; dx++) cells.push(`${f.at[0] + dx},${f.at[1] + dy}`);
    const vehicle = ROAD_FEATURES.has(f.type);
    const bad = vehicle
      ? cells.some((k) => pavement.has(k) || crossing.has(k))
      : cells.some((k) => carriage.has(k));
    if (bad) {
      wrong.push(f.id);
      at ??= f.at;
    }
  }
  if (wrong.length > 0)
    out.push({
      code: "misplaced_props",
      levelId: L.id,
      score: REVIEW.streets.weight * Math.min(2, 0.8 + wrong.length * 0.2),
      ...(at ? { cell: at } : {}),
      elementIds: wrong.slice(0, 8),
      message: `${wrong.length} prop${wrong.length === 1 ? " stands" : "s stand"} where it does not belong (vehicles on the pavement or a crossing, other props in the carriageway): ${wrong.slice(0, 5).join(", ")}`,
      action:
        "move vehicles to the carriageway edge or a car park, and other props onto the pavement's outer edge or into yards",
    });
  return out;
}

// ───────────────────────── natural cover ─────────────────────────

function bareGround(c: Ctx): DesignNote[] {
  const T = REVIEW.bare;
  const { L, W, H } = c;
  if (buildingsOf(c).length >= REVIEW.relief.builtMin) return [];
  // tall growth or rock within `reach` cells covers the ground (undergrowth and ground cover alone leave it bare)
  const cover = new Uint8Array(W * H);
  for (const f of L.features) {
    if (!COVER_FEATURES.has(f.type)) continue;
    for (let dy = -T.reach; dy < f.size[1] + T.reach; dy++)
      for (let dx = -T.reach; dx < f.size[0] + T.reach; dx++) {
        const lx = f.at[0] + dx - L.bounds.x;
        const ly = f.at[1] + dy - L.bounds.y;
        if (lx >= 0 && ly >= 0 && lx < W && ly < H) cover[ly * W + lx] = 1;
      }
  }
  let natural = 0;
  let covered = 0;
  for (let i = 0; i < W * H; i++) {
    if (!c.walkable[i] || ((L.cells.flags[i] as number) & CELL_FLAG.PATH) !== 0) continue;
    const m = L.materials[(L.cells.material[i] ?? 1) - 1] ?? "";
    if (!NATURAL_MATERIALS.has(m)) continue;
    natural++;
    if (cover[i]) covered++;
  }
  if (natural < T.minCells) return [];
  const share = covered / natural;
  if (share >= T.minCover) return [];
  return [
    {
      code: "bare_ground",
      levelId: L.id,
      score: T.weight * over(T.minCover, Math.max(0.05, share)),
      message: `the natural ground is bare: only ${Math.round(share * 100)}% of it has growth or rock nearby`,
      action:
        "dress it densely (a dress op such as woodland or natural_clusters over the level, or scatter at density 0.3+) and keep open ground only as chosen clearings",
    },
  ];
}

/** Identity of a note across results: its code, level and elements (or its rough place). */
export function noteKey(n: DesignNote): string {
  const where = n.elementIds?.length
    ? n.elementIds.slice().sort().join(",")
    : n.cell
      ? `${Math.round(n.cell[0] / 4)},${Math.round(n.cell[1] / 4)}`
      : "";
  return `${n.code}|${n.levelId}|${where}`;
}

/**
 * The review against the one shown last time for the same plan: new notes in full, notes still open as one short
 * line each, cleared notes by code. Without a previous review it is the full text.
 */
export function designReviewDelta(
  notes: readonly DesignNote[],
  previous: readonly DesignNote[] | undefined,
  briefLine = "",
): string {
  if (previous === undefined) return designReviewText(notes, briefLine);
  const before = new Set(previous.map(noteKey));
  const now = new Set(notes.map(noteKey));
  const fresh = notes.filter((n) => !before.has(noteKey(n)));
  const open = notes.filter((n) => before.has(noteKey(n)));
  const cleared = previous.filter((n) => !now.has(noteKey(n)));
  if (fresh.length === 0 && open.length === 0 && cleared.length === 0 && !briefLine) return "";
  const lines = designReviewText(fresh).split("\n").slice(1);
  if (open.length > 0) lines.push(`- still open: ${open.map((n) => `[${n.code}] ${n.message}`).join("; ")}`);
  if (cleared.length > 0) lines.push(`- cleared: ${[...new Set(cleared.map((n) => n.code))].join(", ")}`);
  if (briefLine) lines.push(briefLine);
  return `DESIGN REVIEW (advice, not errors; revise once for what matters):\n${lines.join("\n")}`;
}

// ───────────────────────── terraces, patches, reaching the focus ─────────────────────────

/** Cells of a plan shape on this level (rects and polygons by their raster). */
function opCells(c: Ctx, shape: { type: string } | undefined): Array<[number, number]> {
  if (!shape) return [];
  const mask = rasterizeShape(shape as Parameters<typeof rasterizeShape>[0], { planSeed: c.plan.seed });
  const out: Array<[number, number]> = [];
  forEachMaskCell(mask, (x, y) => {
    const lx = x - c.L.bounds.x;
    const ly = y - c.L.bounds.y;
    if (lx >= 0 && ly >= 0 && lx < c.W && ly < c.H) out.push([x, y]);
  });
  return out;
}

function terraces(c: Ctx): DesignNote[] {
  const T = REVIEW.terraces;
  const lv = c.plan.levels.find((l) => l.id === c.L.id);
  const out: DesignNote[] = [];
  for (const op of lv?.terrain ?? []) {
    if (op.op !== "uneven") continue;
    const cells = op.shape
      ? opCells(c, op.shape)
      : Array.from(
          { length: c.W * c.H },
          (_, i) => [c.L.bounds.x + (i % c.W), c.L.bounds.y + Math.floor(i / c.W)] as [number, number],
        );
    // the steps inside the op: each height band's outline, counted for square corners
    const bands = new Map<number, Array<[number, number]>>();
    for (const [x, y] of cells) {
      const i = (y - c.L.bounds.y) * c.W + (x - c.L.bounds.x);
      if (!c.walkable[i]) continue;
      // half-tile bands: quarter-tile ripples are gentle ground, not terraces
      const h = Math.floor((c.L.cells.height[i] as number) / 2);
      bands.set(h, [...(bands.get(h) ?? []), [x, y]]);
    }
    if (bands.size < 2) continue;
    let corners = 0;
    // only lumps the op itself made: bands that touch the edge of its shape belong to the ground it was laid on
    const inside = new Set(cells.map(([x, y]) => `${x},${y}`));
    const touchesEdge = (comp: ReadonlyArray<[number, number]>): boolean =>
      comp.some(([x, y]) =>
        [
          [x + 1, y],
          [x - 1, y],
          [x, y + 1],
          [x, y - 1],
        ].some(([nx, ny]) => !inside.has(`${nx},${ny}`)),
      );
    // a band edged by a step larger than the op makes is someone else's rise (a platform, a chasm), not a lump
    const amountQ = Math.round((op.amount ?? 0.5) * 4);
    const hAt = (x: number, y: number): number | undefined => {
      const lx = x - c.L.bounds.x;
      const ly = y - c.L.bounds.y;
      if (lx < 0 || ly < 0 || lx >= c.W || ly >= c.H || !c.walkable[ly * c.W + lx]) return undefined;
      return c.L.cells.height[ly * c.W + lx];
    };
    const boundedByRise = (comp: ReadonlyArray<[number, number]>): boolean =>
      comp.some(([x, y]) => {
        const h = hAt(x, y) ?? 0;
        return [
          [x + 1, y],
          [x - 1, y],
          [x, y + 1],
          [x, y - 1],
        ].some(([nx, ny]) => {
          const hn = hAt(nx as number, ny as number);
          return hn !== undefined && Math.abs(hn - h) > amountQ;
        });
      });
    for (const cellsOf of bands.values())
      for (const comp of components(cellsOf))
        if (comp.length >= T.minBand && !touchesEdge(comp) && !boundedByRise(comp))
          corners += squareCorners(comp, T.arm);
    if (corners < T.squareCorners) continue;
    out.push({
      code: "square_terraces",
      levelId: c.L.id,
      score: T.weight * over(corners, T.squareCorners),
      elementIds: [op.id],
      message: `the uneven ground of ${op.id} steps in square terraces (${corners} square corners)`,
      action:
        "soften it: a larger scale and smaller amount on the uneven op, or shape the rise with a ragged platform instead",
    });
  }
  return out;
}

function patches(c: Ctx): DesignNote[] {
  const T = REVIEW.patches;
  const { L, W, H } = c;
  const lv = c.plan.levels.find((l) => l.id === L.id);
  const base = lv?.base.type === "ground" ? lv.base.material : undefined;
  // causes: paths, water, buildings and features, and steps in the ground
  const cause = new Uint8Array(W * H);
  const mark = (x: number, y: number): void => {
    const lx = x - L.bounds.x;
    const ly = y - L.bounds.y;
    if (lx >= 0 && ly >= 0 && lx < W && ly < H) cause[ly * W + lx] = 1;
  };
  for (const f of L.features)
    for (let dy = 0; dy < f.size[1]; dy++)
      for (let dx = 0; dx < f.size[0]; dx++) mark(f.at[0] + dx, f.at[1] + dy);
  for (const st of L.structures ?? []) for (const [x, y] of st.cells) mark(x, y);
  for (let i = 0; i < W * H; i++) {
    const f = L.cells.flags[i] as number;
    if ((f & (CELL_FLAG.PATH | CELL_FLAG.WATER | CELL_FLAG.BRIDGE | CELL_FLAG.LINK)) !== 0) cause[i] = 1;
    if (L.cells.state[i] !== CELL.OPEN) cause[i] = 1;
    const x = i % W;
    if (x + 1 < W && Math.abs((L.cells.height[i] as number) - (L.cells.height[i + 1] as number)) >= 2) {
      cause[i] = 1;
      cause[i + 1] = 1;
    }
    if (i + W < W * H && Math.abs((L.cells.height[i] as number) - (L.cells.height[i + W] as number)) >= 2) {
      cause[i] = 1;
      cause[i + W] = 1;
    }
  }
  const lost: string[] = [];
  for (const op of lv?.terrain ?? []) {
    if (
      (op.op !== "paint" && op.op !== "noise") ||
      op.material === base ||
      !NATURAL_MATERIALS.has(op.material)
    )
      continue;
    const cells = opCells(c, op.shape);
    if (cells.length < T.minCells) continue;
    let near = false;
    for (const [x, y] of cells) {
      for (let dy = -T.reach; dy <= T.reach && !near; dy++)
        for (let dx = -T.reach; dx <= T.reach && !near; dx++) {
          const lx = x + dx - L.bounds.x;
          const ly = y + dy - L.bounds.y;
          if (lx >= 0 && ly >= 0 && lx < W && ly < H && cause[ly * W + lx]) near = true;
        }
      if (near) break;
    }
    if (!near) lost.push(op.id);
  }
  if (lost.length === 0) return [];
  return [
    {
      code: "patch_without_cause",
      levelId: L.id,
      score: T.weight,
      elementIds: lost,
      message: `${lost.join(", ")}: a patch of ground with nothing that explains it (no path, water, building, feature or rise nearby)`,
      action:
        "tie it to a cause: under a grove or a camp, along a path or bank, at the foot of a rise, or remove it",
    },
  ];
}

function reachFocus(c: Ctx): DesignNote[] {
  const T = REVIEW.reach;
  const { L, W, H } = c;
  const pathCells: Array<[number, number]> = [];
  for (let i = 0; i < W * H; i++)
    if (((L.cells.flags[i] as number) & CELL_FLAG.PATH) !== 0)
      pathCells.push([L.bounds.x + (i % W), L.bounds.y + Math.floor(i / W)]);
  // built-up places are reached by their streets; judged where few buildings stand
  if (pathCells.length === 0 || buildingsOf(c).length >= REVIEW.relief.builtMin) return [];
  const focal =
    // the plan's own focal piece (generated landmarks are placed after the paths), else the first building
    L.features.find((f) => f.generatedBy === undefined && PRIMARY_FEATURES.has(f.type)) ??
    L.features.find((f) => f.generatedBy === undefined && FOCAL_FEATURES.has(f.type)) ??
    buildingsOf(c)[0];
  if (!focal) return [];
  const cells: Array<readonly [number, number]> =
    "cells" in focal
      ? focal.cells
      : Array.from({ length: focal.size[0] * focal.size[1] }, (_, k) => [
          focal.at[0] + (k % focal.size[0]),
          focal.at[1] + Math.floor(k / focal.size[0]),
        ]);
  const reached = pathCells.some(([px, py]) =>
    cells.some(([x, y]) => Math.max(Math.abs(px - x), Math.abs(py - y)) <= T.reach),
  );
  if (reached) return [];
  return [
    {
      code: "focus_unreached",
      levelId: L.id,
      score: T.weight,
      elementIds: [focal.id],
      message: `no path leads to the focal point ${focal.id}`,
      action: "lead a path from the entrance or map edge to it (a path op whose points or connect end at it)",
    },
  ];
}

// ───────────────────────── cliffs (docs/internal/cliffs-lessons-reference.md §4) ─────────────────────────

function cliffChecks(c: Ctx): DesignNote[] {
  const T = REVIEW.cliffs;
  const { L } = c;
  const out: DesignNote[] = [];
  const rocks = L.features.filter((f) => BAND_ROCK.has(f.type));
  const covers = (f: (typeof rocks)[number], px: number, py: number, pad: number): boolean =>
    px >= f.at[0] - pad &&
    px <= f.at[0] + f.size[0] + pad &&
    py >= f.at[1] - pad &&
    py <= f.at[1] + f.size[1] + pad;
  const STEPV: Record<string, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
  interface Unit {
    mid: [number, number];
    low: [number, number];
    out: [number, number];
    rise: number;
  }
  const units: Unit[] = [];
  for (const run of L.cliffs ?? [])
    for (const e of run.edges) {
      const [dx, dy] = STEPV[e.side] as [number, number];
      const mid: [number, number] = [e.at[0] + 0.5 + dx * 0.5, e.at[1] + 0.5 + dy * 0.5];
      units.push({ mid, low: [e.at[0] + dx, e.at[1] + dy], out: [dx, dy], rise: (e.high - e.low) / 4 });
    }
  const high = units.filter((u) => u.rise >= 2);
  const lowR = units.filter((u) => u.rise >= 1 && u.rise < 2);
  const clad = (u: Unit): boolean => rocks.some((f) => covers(f, u.mid[0], u.mid[1], 0.3));
  const share = (list: Unit[], pred: (u: Unit) => boolean): number =>
    list.length === 0 ? 0 : list.filter(pred).length / list.length;
  if (high.length >= T.minUnits) {
    const bare = share(high, (u) => !clad(u));
    if (bare > T.unclad)
      out.push({
        code: "cliff_unclad",
        levelId: L.id,
        score: T.weight * over(bare, T.unclad),
        message: `${Math.round(bare * 100)}% of the cliff edge (rises of 2 tiles or more) shows bare ground or square blocks`,
        action:
          "face every natural rise with rock (the theme's rock band); if the theme has none, keep few, bold rises and clad the lips with boulders",
      });
    const cladUnits = high.filter(clad);
    // proud: a rock reaching at least a cell out over the low ground
    const proud = (u: Unit): boolean =>
      rocks.some((f) => covers(f, u.low[0] + 0.5 + u.out[0] * 0.5, u.low[1] + 0.5 + u.out[1] * 0.5, 0));
    const sheer = share(cladUnits, (u) => !proud(u));
    if (cladUnits.length >= T.minUnits && sheer > T.sheer)
      out.push({
        code: "cliff_sheer",
        levelId: L.id,
        score: T.weight * 0.8 * over(sheer, T.sheer),
        message: `${Math.round(sheer * 100)}% of the faced cliff stands sheer: no rock reaches out over the low ground`,
        action:
          "let the rock band lean back: courses resting on the low ground a cell or two out, stepping back as they rise",
      });
    // band width: rock cells along the outward normal through each faced unit
    const widths = cladUnits.map((u) => {
      let n = 0;
      for (let k = -3; k <= 3; k++) {
        const px = u.low[0] + 0.5 + u.out[0] * (k - 1);
        const py = u.low[1] + 0.5 + u.out[1] * (k - 1);
        if (rocks.some((f) => covers(f, px, py, 0))) n++;
      }
      return n;
    });
    const median = widths.length
      ? (widths.slice().sort((a, b) => a - b)[Math.floor(widths.length / 2)] ?? 0)
      : 0;
    if (cladUnits.length >= T.minUnits && median < T.bandWidth)
      out.push({
        code: "cliff_band_thin",
        levelId: L.id,
        score: T.weight * 0.7,
        message: `the rock band along the cliffs is thin (median ${median} cells across)`,
        action:
          "widen it: rock reaching about 2 cells out over the low ground and 2 back under the upper ground",
      });
    const crests = rocks.filter((f) => f.type === "cliff_crest");
    const noCrest = share(high, (u) => !crests.some((f) => covers(f, u.mid[0], u.mid[1], 1.5)));
    if (noCrest > T.noCrest)
      out.push({
        code: "cliff_no_crest",
        levelId: L.id,
        score: T.weight * 0.7 * over(noCrest, T.noCrest),
        message: `${Math.round(noCrest * 100)}% of the cliff lip has no crest boulder: the square edge of the upper ground shows`,
        action: "finish the band with boulders standing just above the lip, every 1.5–3 cells",
      });
  }
  if (lowR.length >= T.minUnits) {
    const bare = share(lowR, (u) => !clad(u));
    if (bare > T.uncladLow)
      out.push({
        code: "cliff_unclad_low",
        levelId: L.id,
        score: T.weight * 0.6 * over(bare, T.uncladLow),
        message: `${Math.round(bare * 100)}% of the one-tile banks are bare`,
        action:
          "set loose boulders along about half of each bank, or merge small steps into fewer, bolder rises",
      });
  }
  // the band's outer boundary should wander
  if (rocks.length >= T.minPieces) {
    const cells: Array<[number, number]> = [];
    const seen = new Set<string>();
    for (const f of rocks)
      for (let dy = 0; dy < f.size[1]; dy++)
        for (let dx = 0; dx < f.size[0]; dx++) {
          const k = `${f.at[0] + dx},${f.at[1] + dy}`;
          if (!seen.has(k)) {
            seen.add(k);
            cells.push([f.at[0] + dx, f.at[1] + dy]);
          }
        }
    const segs = outline(cells).flatMap((r) =>
      r.map((p, i) => {
        const q = r[(i + 1) % r.length] as [number, number];
        return Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);
      }),
    );
    const total = segs.reduce((a, b) => a + b, 0);
    const straightShare =
      total > 0 ? segs.filter((s) => s >= T.straightRun).reduce((a, b) => a + b, 0) / total : 0;
    if (straightShare > T.straight)
      out.push({
        code: "cliff_straight",
        levelId: L.id,
        score: T.weight * 0.7 * over(straightShare, T.straight),
        message: `${Math.round(straightShare * 100)}% of the rock band's edge runs in straight lines of ${T.straightRun} cells or more`,
        action: "let the band wander: vary how far the rock reaches out, with bays and spurs",
      });
    // the same piece in the same turn over and over
    const counts = new Map<string, number>();
    for (const f of rocks) {
      const k = `${f.type}|${f.variant ?? ""}|${f.rot}|${f.rotFine}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const top = Math.max(...counts.values()) / rocks.length;
    if (top > T.repetition)
      out.push({
        code: "cliff_repetition",
        levelId: L.id,
        score: T.weight * 0.6 * over(top, T.repetition),
        message: `${Math.round(top * 100)}% of the cliff rocks are the same piece in the same turn`,
        action: "vary the rock: two or three pieces per run, turned freely",
      });
    // pieces floating with nothing under them
    const floating = rocks.filter((f) => {
      const i = (f.at[1] - L.bounds.y) * c.W + (f.at[0] - L.bounds.x);
      const ground = L.elevation + 0.5 + (L.cells.height[i] ?? 0) / 4;
      if (f.baseHeight <= ground + 0.6) return false;
      return !rocks.some(
        (o) =>
          o !== f &&
          o.baseHeight < f.baseHeight - 0.1 &&
          o.at[0] < f.at[0] + f.size[0] &&
          f.at[0] < o.at[0] + o.size[0] &&
          o.at[1] < f.at[1] + f.size[1] &&
          f.at[1] < o.at[1] + o.size[1],
      );
    }).length;
    if (floating / rocks.length > T.hanging)
      out.push({
        code: "cliff_hanging",
        levelId: L.id,
        score: T.weight * 0.6,
        message: `${floating} rock pieces hang in the air with no rock or ground under them`,
        action:
          "rest every rock on the ground or on the rock below it (the base course sits on the low ground)",
      });
  }
  // few, bold rises: most steps a single tile is timid
  const natural = (L.cliffs ?? []).flatMap((r) => r.edges);
  const bands = new Set<number>();
  for (let i = 0; i < c.W * c.H; i++)
    if (c.walkable[i]) bands.add(Math.floor((L.cells.height[i] as number) / 4));
  if (bands.size >= 3 && natural.length >= T.minUnits) {
    const timid = natural.filter((e) => e.high - e.low === 4).length / natural.length;
    if (timid > T.timid)
      out.push({
        code: "rise_timid",
        levelId: L.id,
        score: T.weight * 0.8 * over(timid, T.timid),
        message: `${Math.round(timid * 100)}% of the rises are single-tile steps: many small steps instead of a few bold ones`,
        action:
          "shape the hill as two or three terraces 2–3 tiles apart (a ragged platform with tiers and rise 2.5)",
      });
  }
  // a natural map should not fill its rectangle
  const lv = c.plan.levels.find((l) => l.id === L.id);
  const naturalMap =
    lv?.base.type === "ground" &&
    NATURAL_MATERIALS.has(lv.base.material) &&
    lv.outline !== "rect" &&
    (L.roads ?? []).length === 0 &&
    buildingsOf(c).length < REVIEW.relief.builtMin;
  if (naturalMap) {
    let open = 0;
    for (let i = 0; i < c.W * c.H; i++) if (L.cells.state[i] === CELL.OPEN) open++;
    const fill = open / (c.W * c.H);
    if (fill > T.boardFill)
      out.push({
        code: "board_rectangular",
        levelId: L.id,
        score: T.weight * 0.6,
        message: `the natural map fills ${Math.round(fill * 100)}% of its rectangle: a square board edge`,
        action:
          'leave the level outline natural (the default; outline "rect" turns it off) and keep a strip of low ground at the edge',
      });
  }
  return out;
}

// ───────────────────────── ruins (the building engineer's measures) ─────────────────────────

function ruins(c: Ctx): DesignNote[] {
  const T = REVIEW.ruins;
  const out: DesignNote[] = [];
  for (const st of buildingsOf(c)) {
    if (st.condition !== "ruined") continue;
    const m = structureRuinMeasures(st);
    if (!m) continue;
    const flat = 1 - m.topVariety;
    if (flat > T.flatTop)
      out.push({
        code: "ruin_flat_top",
        levelId: c.L.id,
        score: T.weight * over(flat, T.flatTop),
        elementIds: [st.id],
        message: `the ruin ${st.id} has a level, even wall top (${Math.round(flat * 100)}% of neighbouring wall tops are the same height)`,
        action:
          "break it further: a taller tower mass, more loss, or another seed, so the wall tops step cell by cell",
      });
    const intact = st.storeys.reduce((t, q) => t + q.wallHeight, 0);
    if (intact >= T.minIntact && m.contrast < T.contrast)
      out.push({
        code: "ruin_uniform",
        levelId: c.L.id,
        score: T.weight * over(T.contrast, Math.max(0.1, m.contrast)),
        elementIds: [st.id],
        message: `the ruin ${st.id} has decayed evenly: its tallest parts are only ${m.contrast.toFixed(1)}× its median wall height`,
        action:
          "keep one tower or keep mass standing tall and let the rest fall to stubs (more storeys on one volume, or a second volume)",
      });
  }
  return out;
}
