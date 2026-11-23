/**
 * Automatic design review: measured observations about a resolved plan, each with a suggested action, ranked and
 * capped (REVIEW.maxNotes). Advice for the model, never an error: it never blocks a build and changes nothing.
 * Deterministic and cheap (one pass per measure over the cells); thresholds are data (review/thresholds.ts).
 * The principles it measures are the product text in agent/designPrinciples.ts.
 */
import type { DesignBrief, FeatureType, MapPlan, Material, Vec2 } from "../contracts/plan";
import {
  CELL,
  CELL_FLAG,
  type ResolvedFeature,
  type ResolvedLevel,
  type ResolvedPlan,
  type ResolvedStructure,
} from "../contracts/resolved";
import type { CompileDiagnostic, PaletteCatalog, PlacementSet } from "../contracts/compiler";
import { generatorProfile, type GeneratorProfile } from "../plan/generator";
import type { ResolvedVariant } from "../palette/resolve";
import {
  CLIFF_CREST_ROLE,
  CLIFF_FACE_ROLE,
  RUIN_CLIMBER_ROLE,
  featureRole,
  floorRole,
} from "../palette/roles";
import { isWater, materialHas } from "../resolve/materials";
import { paletteView } from "../palette/view";
import { structureSignature, structureSilhouette, structureTone } from "../resolve/structureVariety";
import { roofUnsupportedEdges, structureRuinMeasures, weatherMeasures, weatherSigns } from "../resolve/ruin";
import { GROWTH_LEVELS, growthMeasures } from "../resolve/growth";
import { roofProportion } from "../resolve/roof";
import { cellIndex, cellTheme, elementThemeAt } from "../resolve/levelGrid";
import { components, longestInnerStraight, outline, squareCorners } from "./metrics";
import { forEachMaskCell } from "../gen/mask";
import {
  cliffRockKinds,
  edgeHidden,
  terraceRockShare,
  toneFamilies,
  type RockShape,
  type ToneVariant,
} from "../gen/cover";
import { rasterizeShape } from "../gen/shapes";
import { isToneExtreme, type Tone } from "../palette/tones";
import { FENCE, fenceShare, type FenceRule } from "./rockSpacing";
import { courseShape } from "../resolve/chasm";
import {
  createFamilyPicker,
  familiesOfVariants,
  patchStats,
  tonesClose,
  type FloorFamily,
} from "../resolve/floorFamilies";
import { h32 } from "../util/hash";
import { briefNotes } from "./brief";
import { caveNaturalChecks, caveWallChecks } from "./caveWall";
import { caveMassReviewNotes } from "./caveMass";
import { interiorNotes } from "./interiors";
import { lightGiver, roomMeantDim, sceneMeantDim } from "./lights";
import { roofGapNotes } from "./roofGaps";
import { reviewBuild } from "./reviewBuild";
import { stallNotes } from "./stalls";
import { floorAccentNotes } from "./floorTone";
import { centreOf, neighbourGroups } from "../resolve/neighbours";
import { qualityNotes } from "./qualityNotes";
import { layoutNotes } from "./layoutNotes";
import { LIGHT_FEATURES, isBandRock } from "../gen/catalog";
import {
  LIT_FOCALS,
  REPEAT_WATCH,
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
  capped,
  over,
} from "./thresholds";
import { maxOf, minOf, pushAll } from "../util/lists";

export type DesignNoteCode =
  | "opening_over_nothing"
  | "opening_hidden"
  | "levels_close"
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
  | "square_outcrop"
  | "patch_without_cause"
  | "focus_unreached"
  | "cliff_unclad"
  | "cliff_unclad_low"
  | "cliff_sheer"
  | "cliff_band_thin"
  | "cliff_no_crest"
  | "cliff_straight"
  | "cliff_repetition"
  | "cliff_even_spacing"
  | "cliff_buries_ground"
  | "cliff_hanging"
  | "cave_wall_thin"
  | "cave_rock_uncovered"
  | "cave_mass_gaps"
  | "cave_mass_hollow"
  | "cave_floor_flat"
  | "cave_outline_straight"
  | "cave_rock_tones"
  | "cave_wall_row"
  | "focal_unlit"
  | "floor_accent_tone"
  | "stalls_uncovered"
  | "stalls_grid"
  | "rock_tones_mixed"
  | "rise_timid"
  | "board_rectangular"
  | "board_edge_bare"
  | "ruin_flat_top"
  | "ruin_teeth"
  | "roof_unsupported"
  | "ruin_uniform"
  | "weathered_same_as_intact"
  | "growth_bare"
  | "roof_squat"
  | "roof_gap"
  | "room_bare"
  | "rooms_alike"
  | "room_unlit"
  | "furniture_adrift"
  | "river_trench"
  | "rift_broken"
  | "bridge_along"
  | "lane_blocked"
  | "doors_unlit"
  | "silhouette_flat"
  | "facades_alike"
  | "anchor_missing"
  | "dead_end_empty"
  | "rooms_same_size"
  | "corridor_heavy"
  | "entrances_few"
  | "drop_trap_dead";

/** Bare face by class (gen/cover.ts: what really hides the face), for the cliff checks and for proofs and tests. */
export interface CliffCoverage {
  levelId: string;
  /** Interior drops of 2 tiles or more. */
  tall: { edges: number; bare: number };
  /** Interior drops of 1 to under 2 tiles. */
  low: { edges: number; bare: number };
  /** The board's outer edge where the ground stands a tile or more above the base (generator 3 plans). */
  board: { edges: number; bare: number };
  /** Middles of the edges still showing bare face, by class. */
  bareAt: { tall: Array<[number, number]>; low: Array<[number, number]>; board: Array<[number, number]> };
}

export interface ReviewOptions {
  /** Called once per level with the bare-face figures behind the cliff notes. */
  onCoverage?: (c: CliffCoverage) => void;
  /** False judges the rock as built without the one-tone rule (generator 2's way); for tests and proofs. Default true. */
  oneToneRule?: boolean;
  /** Build diagnostics, when a build ran: substituted and unresolved pieces become one note. */
  diagnostics?: readonly CompileDiagnostic[];
  /**
   * The realized placements, when a build ran (the CLI): the notes measured on the placed pieces (cave rock mass,
   * roof gaps) use them. Without them a generator 4 review builds once itself, shared by those notes (review/reviewBuild.ts).
   */
  placements?: PlacementSet;
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
  /** Does a feature give light (review/lights.ts lightGiver)? Absent in tests that build a context by hand: every light feature. */
  givesLight?: (f: ResolvedFeature) => boolean;
  /** What the plan's generator does (plan/generator.ts): a check of newer behaviour reads its switch. */
  gen: GeneratorProfile;
  /** Ids of features the build dropped (custom_unresolved); absent in tests that build a context by hand. */
  dropped?: ReadonlySet<string>;
  /** Tones of a floor role's variants in a theme (PaletteView.floorTones: tagged or observed pieces only). */
  floorTones: (theme: string, material: Material) => ReadonlySet<Tone>;
  /** Tile families of a floor role and the largest one's share. */
  floorFamilies: (
    theme: string,
    material: Material,
  ) => { families: number; dominant: number; toned: boolean };
  /** The floor role's families with their pick weights and tones (generator 3 measures the laid floor). */
  familyList: (theme: string, material: string) => FloorFamily[];
  /** Distinct assets the theme has for a feature type (feature.<type>). */
  pieceKinds: (theme: string, type: FeatureType) => number;
  /** Does the theme have a role (with at least one variant)? Absent in tests that build a context by hand. */
  hasRole?: (theme: string, role: string) => boolean;
  /** Can the theme build a covered stall? The one capability check (palette/stallParts.ts) the resolver and compiler use. */
  canCoverStall?: (theme: string) => boolean;
  /** Real outline (tiles) of the rock band's pieces in a theme: the sturdiest variant (a boulder, not a moss rock). */
  rockExtent: (
    theme: string,
    type: "cliff_face" | "cliff_crest",
  ) => { w: number; d: number; h: number } | undefined;
  /** The rock kinds of a theme's cliffs that are built (generator 3 one-tone rule), with the cliff's tone. */
  rockKinds: (theme: string) => { tone?: string; face: boolean; crest: boolean };
  /** The tone families of a rock role's pieces (positive weights, tagged only), optionally narrowed to one tone. */
  roleTones: (theme: string, roleName: string, only?: string) => string[];
  /** The theme a cell with no theme reads as, the one the build falls back to (palette/planRoles.ts). */
  defaultTheme: string;
  /** Is a theme's place formal, so mirror symmetry is meant (PaletteView.formalLayout)? */
  formalLayout: (theme: string) => boolean;
  L: ResolvedLevel;
  /** The whole resolved plan (all levels and links); absent in tests that build a context by hand. */
  resolved?: ResolvedPlan;
  W: number;
  H: number;
  walkable: Uint8Array;
  walkCount: number;
  onCoverage?: (c: CliffCoverage) => void;
}

/** The level's material ordinals (cells.material) of hazard materials (resolve/materials.ts `hazard`: lava). */
function hazardOrdinals(L: ResolvedLevel): ReadonlySet<number> {
  const out = new Set<number>();
  L.materials.forEach((m, k) => {
    if (materialHas(m, (info) => info.hazard)) out.add(k + 1);
  });
  return out;
}

/**
 * Review every level of a resolved plan, against the palettes it is built with (tones, piece kinds and sizes, what a
 * theme can build). Notes are ranked across levels and capped.
 */
export function reviewDesign(
  plan: MapPlan,
  resolved: ResolvedPlan,
  palettes: PaletteCatalog,
  opts: ReviewOptions = {},
): DesignNote[] {
  const notes: DesignNote[] = [];
  const gen = generatorProfile(plan);
  // generator 5: only pieces that give light count as lights (a stone lantern does not)
  const gives = lightGiver(resolved, palettes);
  // the questions the resolver and the compiler ask of these palettes, with their answers (palette/view.ts), as the
  // plan's generator sees them: a role the build cannot use (minGenerator) is not advice for this plan
  const view = paletteView(palettes, plan.generator);
  /** The usable variants of a role in a theme (after the palette's fallbacks). */
  const variants = (theme: string, name: string): readonly ResolvedVariant[] =>
    view.probe(theme)([name])?.variants ?? [];
  // the tones of a floor's pieces, on the palette's one tone scale
  const floorTones = view.floorTones;
  // tile families a floor role lays in one field, and the largest family's share of the pick weight
  const famMemo = new Map<string, { families: number; dominant: number; toned: boolean }>();
  const floorFamilies = (
    theme: string,
    material: Material,
  ): { families: number; dominant: number; toned: boolean } => {
    const k = `${theme}|${material}`;
    let f = famMemo.get(k);
    if (!f) {
      const w = new Map<string, number>();
      for (const v of variants(theme, floorRole(material)))
        if (v.weight > 0) w.set(v.variant ?? "", (w.get(v.variant ?? "") ?? 0) + v.weight);
      const total = [...w.values()].reduce((a, b) => a + b, 0);
      f = {
        families: w.size,
        dominant: total > 0 ? maxOf(w.values()) / total : 1,
        // a family of known contrasting tone (a tagged or observed dark or light piece) among them
        toned: [...floorTones(theme, material)].some(isToneExtreme),
      };
      famMemo.set(k, f);
    }
    return f;
  };
  const listMemo = new Map<string, FloorFamily[]>();
  const familyList = (theme: string, material: string): FloorFamily[] => {
    const k = `${theme}|${material}`;
    let l = listMemo.get(k);
    if (!l) {
      l = familiesOfVariants(variants(theme, floorRole(material)));
      listMemo.set(k, l);
    }
    return l;
  };
  const kindMemo = new Map<string, number>();
  const pieceKinds = (theme: string, type: FeatureType): number => {
    const k = `${theme}|${type}`;
    let n = kindMemo.get(k);
    if (n === undefined) {
      n = new Set(
        variants(theme, featureRole(type))
          .filter((v) => v.weight > 0)
          .map((v) => v.uuid),
      ).size;
      kindMemo.set(k, n);
    }
    return n;
  };
  const hasRole = (theme: string, name: string): boolean => variants(theme, name).some((v) => v.weight > 0);
  const canCoverStall = (theme: string): boolean => view.stallForms(theme).length > 0;
  const extentMemo = new Map<string, { w: number; d: number; h: number } | null>();
  const rockExtent: Ctx["rockExtent"] = (theme, type) => {
    const k = `${theme}|${type}`;
    let e = extentMemo.get(k);
    if (e === undefined) {
      const vs = variants(theme, type === "cliff_face" ? CLIFF_FACE_ROLE : CLIFF_CREST_ROLE).filter(
        (v) => v.weight > 0 && (type === "cliff_face" || v.geom.size.y >= 1.2),
      );
      const v = [...vs].sort((a, b) => b.weight - a.weight)[0];
      e = v ? { w: v.geom.size.x, d: v.geom.size.z, h: v.geom.size.y } : null;
      extentMemo.set(k, e);
    }
    return e ?? undefined;
  };
  const roleTones: Ctx["roleTones"] = (theme, roleName, only) =>
    toneFamilies(variants(theme, roleName).filter((v) => only === undefined || v.tone === only));
  const rockKinds: Ctx["rockKinds"] = (theme) => {
    if (opts.oneToneRule === false || !gen.cliffToneRule) return { face: true, crest: true };
    const vs = (n: string): readonly ToneVariant[] => variants(theme, n);
    return cliffRockKinds(vs(CLIFF_FACE_ROLE), vs(CLIFF_CREST_ROLE));
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
    const ctx: Ctx = {
      plan,
      gen,
      givesLight: gives,
      // features the build dropped (unresolved or wrong size) are not on the map: repeated_prop counts what stands
      dropped: new Set(
        (opts.diagnostics ?? [])
          .filter((d) => d.code === "custom_unresolved")
          .flatMap((d) => d.elementIds ?? (d.elementId !== undefined ? [d.elementId] : [])),
      ),
      floorTones,
      floorFamilies,
      familyList,
      pieceKinds,
      hasRole,
      canCoverStall,
      rockExtent,
      rockKinds,
      roleTones,
      defaultTheme: view.defaultTheme,
      formalLayout: view.formalLayout,
      L,
      resolved,
      W,
      H,
      walkable,
      walkCount,
      ...(opts.onCoverage ? { onCoverage: opts.onCoverage } : {}),
    };
    for (const fn of [
      flat,
      floorOpeningNotes,
      stackedLevels,
      straight,
      channels,
      riftBroken,
      bridgeAlong,
      riverTrench,
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
      squareOutcrops,
      patches,
      reachFocus,
      cliffChecks,
      rockTonesMixed,
      (c: Ctx) => caveWallChecks(plan, c.L),
      (c: Ctx) => caveNaturalChecks(plan, c.L),
      (c: Ctx) => (c.gen.floorAccentReview ? floorAccentNotes(c.L.id, c.L, view) : []),
      focalLights,
      ruins,
      (c: Ctx) =>
        c.gen.coveredStalls
          ? stallNotes({
              levelId: c.L.id,
              level: c.L,
              defaultTheme: c.defaultTheme,
              ...(c.canCoverStall ? { canCoverStall: c.canCoverStall } : {}),
            })
          : [],
    ])
      pushAll(notes, fn(ctx));
  }
  // the cave rock mass as built (generator 3): measured on the realized pieces; generator 4 builds the cave itself when
  // the review was given no build (the in-app model review), so the mass checks run in every review
  // one build per review run (review/reviewBuild.ts): every note measured on the placed pieces shares it
  const build = reviewBuild(resolved, palettes, opts.placements);
  pushAll(notes, caveMassReviewNotes(plan, resolved, build, palettes));
  // generator 4: an intact roof is whole (only a chimney stack stands in it); measured on the realized roof pieces
  pushAll(notes, roofGapNotes(plan, resolved, build, palettes));
  // rooms: bare, alike, unlit, furniture adrift (judged room by room, across the whole map)
  pushAll(notes, interiorNotes(plan, resolved, gives));
  // generator 5: what the quality meter finds that plan words can change (lanes, door lights, roofline, facades)
  if (gen.qualityNotes) pushAll(notes, qualityNotes(plan, resolved, gives));
  // generator 5: how a complex of rooms is laid out (dead ends, size mix, corridors, ways in, ways back)
  pushAll(notes, layoutNotes(plan, resolved));
  pushAll(notes, substitutionNotes(opts.diagnostics ?? [], resolved.levels[0]?.id ?? ""));
  pushAll(notes, briefNotes(opts.brief, plan, resolved, REVIEW.brief.weight));
  const ranked = notes.sort(
    (a, b) => b.score - a.score || a.levelId.localeCompare(b.levelId) || a.code.localeCompare(b.code),
  );
  const limit = opts.limit ?? REVIEW.maxNotes;
  const kept = ranked.slice(0, limit);
  // the ground and the water course are what the eye meets first: a crowded review never drops their notes (the
  // owner's cave proof showed a quilt of floor families with no floor_patchwork note in the result)
  for (const n of ranked.slice(limit)) {
    if (!NEVER_CROWDED_OUT.has(n.code) || kept.some((k) => k.code === n.code && k.levelId === n.levelId))
      continue;
    let at = -1;
    for (let k = kept.length - 1; k >= 0 && at < 0; k--)
      if (!NEVER_CROWDED_OUT.has((kept[k] as DesignNote).code)) at = k;
    if (at < 0) break;
    kept[at] = n;
  }
  return kept.sort(
    (a, b) => b.score - a.score || a.levelId.localeCompare(b.levelId) || a.code.localeCompare(b.code),
  );
}

/** Notes the cap on the review never drops in favour of a lower-ranked kind. */
const NEVER_CROWDED_OUT: ReadonlySet<DesignNoteCode> = new Set([
  "floor_patchwork",
  "river_trench",
  "rift_broken",
]);

/**
 * A bridge crosses a channel by the shortest span, square to its course. A deck that runs along the channel (its long
 * side within about 35 degrees of the course there) is a ribbon laid down the crack, not a crossing.
 */
function bridgeAlong(c: Ctx): DesignNote[] {
  const T = REVIEW.channels;
  const { L } = c;
  if (!c.gen.wanderingChannels) return [];
  const out: DesignNote[] = [];
  for (const b of L.bridges ?? []) {
    if (!b.id.includes("~b") || b.cells.length < 4) continue;
    const xs = b.cells.map((p) => p[0]);
    const ys = b.cells.map((p) => p[1]);
    const dx = maxOf(xs) - minOf(xs) + 1;
    const dy = maxOf(ys) - minOf(ys) + 1;
    if (Math.max(dx, dy) < T.alongMinLength) continue;
    const mx = (maxOf(xs) + minOf(xs)) / 2 + 0.5;
    const my = (maxOf(ys) + minOf(ys)) / 2 + 0.5;
    const ch = (L.channels ?? []).find((q) => b.id.startsWith(`${q.id}~`));
    if (!ch || ch.centre.length < 3) continue;
    let k = 0;
    let best = Infinity;
    ch.centre.forEach(([px, py], j) => {
      const d = (px - mx) * (px - mx) + (py - my) * (py - my);
      if (d < best) {
        best = d;
        k = j;
      }
    });
    const a = ch.centre[Math.max(0, k - 1)] as Vec2;
    const z = ch.centre[Math.min(ch.centre.length - 1, k + 1)] as Vec2;
    const tl = Math.hypot(z[0] - a[0], z[1] - a[1]) || 1;
    const tx = (z[0] - a[0]) / tl;
    const ty = (z[1] - a[1]) / tl;
    const long: Vec2 = dx >= dy ? [1, 0] : [0, 1];
    const cos = Math.abs(tx * long[0] + ty * long[1]);
    if (cos <= T.alongCos) continue;
    out.push({
      code: "bridge_along",
      levelId: L.id,
      score: T.weight * 1.5,
      cell: [Math.round(mx), Math.round(my)],
      message: `bridge ${b.id} runs ${Math.round((Math.acos(Math.min(1, cos)) * 180) / Math.PI)} degrees off the channel's course for ${Math.max(dx, dy)} cells: it is a ribbon laid along the crack, not a crossing`,
      action:
        "cross the channel by the shortest span, square to its course: move the bridge's `at` to a straighter stretch",
    });
  }
  return out;
}

/**
 * A rift or river is one crack (generator 3 records its course): measured on the laid channel, not the plan. The cells
 * of its material (lava, water, floorless) plus the bridge decks over it must form one body; two or more large bodies
 * on one course are separate pits with ground between them (a span of floor that is not a bridge).
 */
function riftBroken(c: Ctx): DesignNote[] {
  const T = REVIEW.channels;
  const { L, W, H } = c;
  if (!c.gen.wanderingChannels || (L.channels ?? []).length === 0) return [];
  const hazard = hazardOrdinals(L);
  const cells: Array<[number, number]> = [];
  for (let i = 0; i < W * H; i++) {
    if (L.cells.state[i] !== CELL.OPEN) continue;
    const f = L.cells.flags[i] as number;
    const wet = (f & (CELL_FLAG.WATER | CELL_FLAG.NO_FLOOR | CELL_FLAG.BRIDGE)) !== 0;
    if (wet || hazard.has(L.cells.material[i] ?? 0))
      cells.push([L.bounds.x + (i % W), L.bounds.y + Math.floor(i / W)]);
  }
  const bodies = components(cells)
    .filter((b) => b.length >= T.brokenMinCells)
    .sort((a, b) => b.length - a.length);
  if (bodies.length < 2) return [];
  // only bodies lying on a recorded course count
  const onCourse = (b: Array<[number, number]>): boolean =>
    (L.channels ?? []).some((ch) =>
      ch.centre.some(([cx, cy]) =>
        b.some(([x, y]) => Math.abs(x + 0.5 - cx) <= 2.5 && Math.abs(y + 0.5 - cy) <= 2.5),
      ),
    );
  const on = bodies.filter(onCourse);
  if (on.length < 2) return [];
  const second = on[1] as Array<[number, number]>;
  return [
    {
      code: "rift_broken",
      levelId: L.id,
      score: T.weight * 1.5,
      cell: second[0] as [number, number],
      message: `the rift or river is laid as ${on.length} separate pits (${on.map((b) => b.length).join(", ")} cells) with ground between them, not one crack`,
      action:
        "keep the channel continuous: a land span across it only where a bridge is (and no wider than the bridge); cross it with a bridge op, or let the course run whole",
    },
  ];
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

/** Levels a player can see or walk between from this one: linked by a stair or ladder, or looking through a floor opening. */
function connectedLevels(c: Ctx): ResolvedLevel[] {
  const r = c.resolved;
  if (!r || !c.gen.levelsJudgedTogether) return [];
  const ids = new Set<string>();
  for (const lk of r.links) {
    if (lk.fromLevel === c.L.id) ids.add(lk.toLevel);
    if (lk.toLevel === c.L.id) ids.add(lk.fromLevel);
  }
  for (const lv of r.levels)
    for (const fo of lv.floorOpenings ?? []) {
      if (lv.id === c.L.id && fo.below !== undefined) ids.add(fo.below);
      if (fo.below === c.L.id) ids.add(lv.id);
    }
  return r.levels.filter((l) => ids.has(l.id));
}

/** Generator 3: a stack of built levels is judged as one map, not level by level. */
function stackedLevels(c: Ctx): DesignNote[] {
  const r = c.resolved;
  if (!r || !c.gen.levelsJudgedTogether) return [];
  const out: DesignNote[] = [];
  const need = (c.plan.levels.find((l) => l.id === c.L.id)?.wallHeight ?? 2) + 0.5 + LEVEL_AIR;
  for (const up of r.levels) {
    if (up.elevation <= c.L.elevation || up.elevation - c.L.elevation >= need - 1e-9) continue;
    // only levels that really lie over this one (open floor in both on at least a fifth of the smaller)
    let both = 0;
    let mine = 0;
    for (let i = 0; i < c.W * c.H; i++) {
      const a = c.L.cells.state[i] === CELL.OPEN;
      if (a) mine++;
      if (a && up.cells.state[i] === CELL.OPEN && ((up.cells.flags[i] ?? 0) & CELL_FLAG.NO_FLOOR) === 0)
        both++;
    }
    if (
      up.bounds.w !== c.W ||
      both < 0.2 * Math.max(1, Math.min(mine, up.cells.state.filter((s) => s === CELL.OPEN).length))
    )
      continue;
    // one note per pair: on the lower level, once
    out.push({
      code: "levels_close",
      levelId: c.L.id,
      score: REVIEW.routes.weight * 1.2,
      message: `${up.id} lies only ${up.elevation - c.L.elevation} tiles above ${c.L.id}; walls here stand ${need - 0.5 - LEVEL_AIR} tall on a 0.5 floor, so there is ${(up.elevation - c.L.elevation - need + LEVEL_AIR).toFixed(1)} of clear air under the floor above (players see wall tops touching it)`,
      action: `space stacked levels at least ${need} apart (wall height + 0.5 floor + ${LEVEL_AIR} of air; 4 for the usual 2-tall dungeon walls); stairs lengthen by a cell per tile`,
    });
  }
  return out.slice(0, 1);
}

/** Floor openings: what lies under them, and whether a wall hides them. */
function floorOpeningNotes(c: Ctx): DesignNote[] {
  const out: DesignNote[] = [];
  for (const fo of c.L.floorOpenings ?? []) {
    const n = fo.cells.length;
    if (fo.floorBelow < Math.ceil(n * 0.6))
      out.push({
        code: "opening_over_nothing",
        levelId: c.L.id,
        score: REVIEW.routes.weight * 1.5,
        elementIds: [fo.id],
        cell: fo.cells[0] as [number, number],
        message: `the floor opening ${fo.id} has open floor beneath only ${fo.floorBelow} of its ${n} cells${fo.below ? ` (level ${fo.below})` : " (there is no level below)"}: you would look into solid rock or void`,
        action:
          "put a room of the level below directly under it (same cells, one storey down), or move the opening over a room",
      });
    if (fo.edgeCells >= 4 && fo.hiddenEdge >= 0.4 * fo.edgeCells)
      out.push({
        code: "opening_hidden",
        levelId: c.L.id,
        score: REVIEW.routes.weight,
        elementIds: [fo.id],
        cell: fo.cells[0] as [number, number],
        message: `walls hide the floor opening ${fo.id}: ${fo.hiddenEdge} of its ${fo.edgeCells} edge cells have a full-height wall between the walkway and the hole`,
        action: c.gen.lowOpeningRims
          ? 'keep the hole inside one room with floor all round it (no area boundary or wall on its edge), and leave "rim" unset or low (low_wall, railing, none): a 2-tall wall round a hole reads as a maze of stubs from the table'
          : "keep the hole inside one room with floor all round it (no area boundary or wall on its edge), so players can stand at the rim and look down",
      });
  }
  return out;
}

const LEVEL_AIR = 1;

function flat(c: Ctx): DesignNote[] {
  const T = REVIEW.flat;
  // generator 3: depth is judged over the whole map: a level linked to, or looking down into, a level 1.5 tiles or more
  // away is not flat (the drop between the levels is the depth)
  if (connectedLevels(c).some((l) => Math.abs(l.elevation - c.L.elevation) >= 1.5)) return [];
  // built places get their height from the buildings (storeys, roofs): a street of several buildings may lie flat
  if ((c.L.structures ?? []).filter((s) => s.kind === "building").length >= T.buildingsGiveDepth) return [];
  const bands = new Map<number, number>();
  for (let i = 0; i < c.W * c.H; i++) {
    if (!c.walkable[i]) continue;
    const b = Math.floor((c.L.cells.height[i] as number) / 2);
    bands.set(b, (bands.get(b) ?? 0) + 1);
  }
  const top = maxOf(bands.values());
  const share = top / c.walkCount;
  const levels = [...bands.values()].filter((n) => n / c.walkCount >= T.bandShare).length;
  if (share < T.maxShare && levels >= T.minBands) {
    // generator 3: half-tile lumps (an uneven op) are not depth. When nearly all the walkable ground lies within one
    // tile of one height, no part of the map is a tile or more above or below the rest
    if (!c.gen.depthInTiles) return [];
    const tiles = new Map<number, number>();
    // ground to stand on: not a lava rift (a hazard material) or a pit's floor
    const hazard = hazardOrdinals(c.L);
    const ground = (i: number): boolean => c.walkable[i] === 1 && !hazard.has(c.L.cells.material[i] ?? 0);
    let groundN = 0;
    for (let i = 0; i < c.W * c.H; i++) {
      if (!ground(i)) continue;
      const b = Math.round((c.L.cells.height[i] as number) / 4);
      tiles.set(b, (tiles.get(b) ?? 0) + 1);
      groundN++;
    }
    let dom = 0;
    let domN = -1;
    for (const [b, n] of tiles)
      if (n > domN) {
        domN = n;
        dom = b;
      }
    // cells a tile and a half or more above or below the main level
    let far = 0;
    for (let i = 0; i < c.W * c.H; i++)
      if (ground(i) && Math.abs((c.L.cells.height[i] as number) - dom * 4) >= T.farQ) far++;
    const coarse = 1 - far / Math.max(1, groundN);
    if (coarse < T.coarseShare) return [];
    return [
      {
        code: "flat_map",
        levelId: c.L.id,
        score: T.weight * over(coarse, T.coarseShare),
        message: `little real depth: ${Math.round(coarse * 100)}% of the walkable floor lies within a tile of one height (only lumps and small raised parts differ)`,
        action:
          "give the map one bold change of 1.5 tiles or more over a large area: a raised hall or shelf (platform op, tiers, rise), a sunken floor, or a lower cave level, and put the focal feature on it",
      },
    ];
  }
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

/**
 * Rifts, chasms and rivers (generator 3 records their course): the centreline must stray visibly from the line
 * between its ends, as a real watercourse does. Judged by deviation and bends, not by width.
 */
function channels(c: Ctx): DesignNote[] {
  const T = REVIEW.channels;
  const out: DesignNote[] = [];
  for (const ch of c.L.channels ?? []) {
    const shape = courseShape(ch.centre);
    if (shape.chord < T.minChord) continue;
    const share = shape.deviation / shape.chord;
    const few = shape.chord >= T.bendsFrom && shape.bends < T.minBends;
    if (share >= T.deviation && !few) continue;
    const mid = ch.centre[Math.floor(ch.centre.length / 2)] as Vec2;
    out.push({
      code: "straight_natural",
      levelId: c.L.id,
      score: T.weight * Math.max(1, over(T.deviation, Math.max(share, 0.01))),
      cell: [Math.floor(mid[0]), Math.floor(mid[1])],
      elementIds: [ch.id],
      message: `the ${ch.kind === "river" ? "river" : "rift"} "${ch.id}" runs almost straight: it strays ${shape.deviation.toFixed(1)} cells (${Math.round(share * 100)}% of its ${Math.round(shape.chord)} cells) from the line between its ends, ${shape.bends} bend${shape.bends === 1 ? "" : "s"}`,
      action:
        "let it wander: points that bend about a fifth of its length off the straight line, at least two bends, a cell wider here and narrower there (leave meander out or above 0: 0 keeps it straight)",
    });
  }
  return out;
}

/**
 * River trench: a river cut to one level down a slope sits deeper and deeper below its banks. Measured on the cells:
 * along each water body (ordered from one end), how far below the dry ground beside it the bed lies; a stretch where
 * that depth grows by 2 tiles or more has no fall to take up the slope.
 */
function riverTrench(c: Ctx): DesignNote[] {
  const T = REVIEW.trench;
  const { L, W, H } = c;
  const wet = (i: number): boolean =>
    L.cells.state[i] === CELL.OPEN &&
    ((L.cells.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.NO_FLOOR | CELL_FLAG.BRIDGE)) ===
      CELL_FLAG.WATER;
  const dry = (i: number): boolean =>
    L.cells.state[i] === CELL.OPEN &&
    ((L.cells.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.NO_FLOOR | CELL_FLAG.BRIDGE)) === 0;
  const seen = new Uint8Array(W * H);
  const out: DesignNote[] = [];
  const nb = (i: number): number[] => {
    const x = i % W;
    return [
      x > 0 ? i - 1 : -1,
      x < W - 1 ? i + 1 : -1,
      i >= W ? i - W : -1,
      i < W * (H - 1) ? i + W : -1,
    ].filter((j) => j >= 0);
  };
  const bfs = (start: number, inside: (i: number) => boolean): Map<number, number> => {
    const d = new Map<number, number>([[start, 0]]);
    const q = [start];
    for (let h = 0; h < q.length; h++) {
      const i = q[h] as number;
      for (const j of nb(i))
        if (!d.has(j) && inside(j)) {
          d.set(j, (d.get(i) as number) + 1);
          q.push(j);
        }
    }
    return d;
  };
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || !wet(s)) continue;
    const first = bfs(s, wet);
    for (const i of first.keys()) seen[i] = 1;
    if (first.size < T.minCells) continue;
    // the far end of the body, then distances from it: a position along the course
    let far = s;
    for (const [i, d] of first) if (d > (first.get(far) as number)) far = i;
    const along = bfs(far, wet);
    const reach = maxOf(along.values());
    if (reach < T.minLength) continue;
    const bins = new Map<number, number[]>();
    const where = new Map<number, number>();
    // the face of a fall is not a bank: leave out the water within three cells of a lip
    const lips = (L.falls ?? []).flatMap((f) => f.lip);
    for (const [i, d] of along) {
      const px = L.bounds.x + (i % W);
      const py = L.bounds.y + Math.floor(i / W);
      if (lips.some(([lx, ly]) => (lx - px) * (lx - px) + (ly - py) * (ly - py) <= 16)) continue;
      // dry ground within two cells: the banks
      const x = i % W;
      const y = Math.floor(i / W);
      const banks: number[] = [];
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const j = yy * W + xx;
          if (dry(j)) banks.push(L.cells.height[j] as number);
        }
      if (banks.length === 0) continue;
      banks.sort((a, b) => a - b);
      // the lower bank: a river along the foot of a cliff has one high bank and is not a trench
      const depth = (banks[Math.floor((banks.length - 1) / 4)] as number) - (L.cells.height[i] as number);
      const k = Math.floor(d / 2);
      let arr = bins.get(k);
      if (!arr) {
        arr = [];
        bins.set(k, arr);
      }
      arr.push(depth);
      if (!where.has(k)) where.set(k, i);
    }
    const raw = [...bins]
      .sort((a, b) => a[0] - b[0])
      .map(([k, v]) => [k, [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] as number] as const);
    // a running median of three bins (six cells): one odd bin where the course doubles back is not a trench
    const med = raw.map(([k], j) => {
      const w = raw
        .slice(Math.max(0, j - 1), j + 2)
        .map((r) => r[1])
        .sort((a, b) => a - b);
      return [k, w[Math.floor(w.length / 2)] as number] as const;
    });
    if (med.length < 4) continue;
    let lo = med[0] as readonly [number, number];
    let hi = med[0] as readonly [number, number];
    for (const m of med) {
      if (m[1] < lo[1]) lo = m;
      if (m[1] > hi[1]) hi = m;
    }
    const grow = hi[1] - lo[1];
    if (grow < T.minGrowQ || hi[1] < T.deepQ) continue;
    const at = where.get(hi[0]) as number;
    out.push({
      code: "river_trench",
      levelId: L.id,
      score: T.weight * over(grow, T.minGrowQ),
      cell: [L.bounds.x + (at % W), L.bounds.y + Math.floor(at / W)],
      message: `a water course of ${first.size} cells is cut to one level down a slope: its bed lies ${(lo[1] / 4).toFixed(1)} tiles below the ground beside it in one place and ${(hi[1] / 4).toFixed(1)} in another, with no fall between: it reads as a trench`,
      action:
        "step it down the slope: reaches at different levels with a fall of 1 to 3 tiles between them and a wider pool at each foot (draw it as a chasm op with a water floor, which steps down by itself), or run it along the contour",
    });
  }
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
      const area = (maxOf(xs) - minOf(xs) + 1) * (maxOf(ys) - minOf(ys) + 1);
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
    return { x0: minOf(xs), y0: minOf(ys), x1: maxOf(xs), y1: maxOf(ys) };
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
      score: T.weight * capped(0.8 + pairs.length * 0.4),
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
    if (isWater(op.material)) continue;
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
      score: T.weight * capped(0.8 + lost.length * 0.3),
      cell: (lost[0] as { p: Vec2 }).p,
      elementIds: lost.map((l) => l.id).filter((v, k, s) => s.indexOf(v) === k),
      message: `${lost.length} path end${lost.length === 1 ? "" : "s"} stop in open ground with nothing there`,
      action:
        "end each path at something: an entrance, the focal feature, water, another path or the map edge (or use connect)",
    },
  ];
}

// ───────────────────────── buildings: tone and roofs ─────────────────────────

const buildingsOf = (c: Ctx): ResolvedStructure[] =>
  (c.L.structures ?? []).filter((s) => s.kind === "building");

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
  // ("" counts the odd cell with no material: it has no floor pieces, so no tones or families)
  const count = new Map<Material | "", { n: number; theme: string }>();
  let field = 0;
  for (let i = 0; i < W * H; i++) {
    if (!c.walkable[i]) continue;
    if (((L.cells.flags[i] as number) & (CELL_FLAG.PATH | CELL_FLAG.BRIDGE)) !== 0) continue;
    if (L.areas[(L.cells.area[i] ?? 0) - 1]?.kind === "building") continue;
    const m = L.materials[(L.cells.material[i] ?? 1) - 1] ?? "";
    const theme = cellTheme(L, i, c.defaultTheme);
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
    if (m !== "") for (const t of c.floorTones(e.theme, m)) tones.set(t, [...(tones.get(t) ?? []), m]);
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
  if (top && top[1].n / field >= T.familyFieldShare && c.gen.floorFamilies) {
    // generator 3: measure the floor as it is laid (one dominant family; a second only in caused patches)
    const fams = c.familyList(top[1].theme, top[0]);
    if (fams.length >= 2 && NATURAL_MATERIALS.has(top[0])) {
      const pick = createFamilyPicker(L, h32(c.plan.id));
      const laid = new Map<string, number>();
      let n = 0;
      for (let i = 0; i < W * H; i++) {
        if (!c.walkable[i]) continue;
        if (((L.cells.flags[i] as number) & (CELL_FLAG.PATH | CELL_FLAG.BRIDGE)) !== 0) continue;
        if (L.areas[(L.cells.area[i] ?? 0) - 1]?.kind === "building") continue;
        if (L.materials[(L.cells.material[i] ?? 1) - 1] !== top[0]) continue;
        const f = pick(fams, L.bounds.x + (i % W), L.bounds.y + Math.floor(i / W));
        laid.set(f, (laid.get(f) ?? 0) + 1);
        n++;
      }
      const lead = n > 0 ? maxOf(laid.values()) / n : 1;
      const toneOf = (name: string): Tone | undefined => fams.find((f) => f.name === name)?.tone;
      const names = [...laid.keys()];
      const clash = names.some((a) =>
        names.some(
          (b) =>
            a < b &&
            (laid.get(a) ?? 0) / n >= 0.08 &&
            (laid.get(b) ?? 0) / n >= 0.08 &&
            !tonesClose(toneOf(a), toneOf(b)),
        ),
      );
      // the second family is laid as ragged blobs round a real cause (water, a path, the foot of a rise of a tile or
      // more, a tree, camp or set piece), a few percent of the ground: single squares scattered over open grass fail
      const ps = patchStats(L, h32(c.plan.id), fams);
      if (ps.share > T.patchShare || ps.lonely > T.patchLonely)
        out.push({
          code: "patch_without_cause",
          levelId: L.id,
          score: T.weight * 1.3,
          message: `the second ground family covers ${Math.round(ps.share * 100)}% of the open ground, ${Math.round(ps.lonely * 100)}% of it in single squares or thin strings`,
          action:
            "keep earth and litter patches to ragged blobs of several cells round a real cause (a grove, a trail verge, the foot of a rise of a tile or more, a water edge), a few percent of the ground",
        });
      if (lead < T.laidDominant || clash)
        out.push({
          code: "floor_patchwork",
          levelId: L.id,
          score: T.weight * 1.6 * Math.max(1, over(T.laidDominant, lead)),
          message: `the ${top[0]} floor (${Math.round((top[1].n / field) * 100)}% of the ground) is laid as ${names.length} tile families, the largest only ${Math.round(lead * 100)}%${clash ? ", of clashing tones" : ""}: it reads as a patchwork`,
          action: `lay one family over about ${Math.round(T.laidDominant * 100)}% or more of the ${top[0]} floor; a second only in patches beside water, a path, the foot of rock or a set piece`,
        });
    }
  } else if (top && top[0] !== "" && top[1].n / field >= T.familyFieldShare) {
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

function focalLights(c: Ctx): DesignNote[] {
  if (!c.gen.litLandmarks) return [];
  const T = REVIEW.caveMass;
  const lights = c.L.features.filter((f) => c.givesLight?.(f) ?? LIGHT_FEATURES.has(f.type));
  // generator 5: a focal piece in a room (or a scene) meant to be dim is not in the dark by mistake
  const meantDim = (f: ResolvedFeature): boolean => {
    const a = c.L.areas.find((x) => x.id === f.area);
    return roomMeantDim(a) || (a?.kind !== "room" && a?.kind !== "corridor" && sceneMeantDim(c.plan));
  };
  const gap = (a: (typeof lights)[number], b: (typeof lights)[number]): number => {
    const dx = Math.max(a.at[0] - (b.at[0] + b.size[0] - 1), b.at[0] - (a.at[0] + a.size[0] - 1), 0);
    const dy = Math.max(a.at[1] - (b.at[1] + b.size[1] - 1), b.at[1] - (a.at[1] + a.size[1] - 1), 0);
    return Math.max(dx, dy);
  };
  const out: DesignNote[] = [];
  for (const f of c.L.features) {
    if (!LIT_FOCALS.has(f.type) || lights.some((l) => gap(f, l) <= T.focalLight) || meantDim(f)) continue;
    out.push({
      code: "focal_unlit",
      levelId: c.L.id,
      score: T.focalUnlitWeight,
      cell: [f.at[0], f.at[1]],
      elementIds: [f.id],
      message: `the focal feature ${f.id} (${f.type}) has no light source within ${T.focalLight} cells: it sits in the dark`,
      action: "put a lantern, brazier, torch or crystals within a few cells of it, so the eye is led there",
    });
  }
  return out.slice(0, 2);
}

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
  // generator 3: stairs and ladders join the rooms of different levels, so a loop may run up one stair and down another;
  // the whole plan is judged once (on its first level)
  if (c.resolved && c.gen.levelsJudgedTogether && c.resolved.links.length > 0) {
    if (c.resolved.levels[0]?.id !== L.id) return [];
    const parent = new Map<string, string>();
    const find = (a: string): string => {
      let p = parent.get(a) ?? a;
      while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
      parent.set(a, p);
      return p;
    };
    const joined = new Set<string>();
    const allNodes = new Set<string>();
    let allEdges = 0;
    const join = (a: string, b: string): void => {
      const key = a < b ? `${a}~${b}` : `${b}~${a}`;
      if (a === b || joined.has(key)) return;
      joined.add(key);
      allNodes.add(a);
      allNodes.add(b);
      allEdges++;
      parent.set(find(a), find(b));
    };
    const areaAt = (lv: ResolvedLevel, x: number, y: number): string | null => {
      const i = (y - lv.bounds.y) * lv.bounds.w + (x - lv.bounds.x);
      const a = lv.cells.area[i] ?? 0;
      const id = a > 0 ? lv.areaIds[a - 1] : undefined;
      return id !== undefined &&
        lv.areas.some((q) => q.id === id && q.kind !== "zone" && q.kind !== "building")
        ? `${lv.id}|${id}`
        : null;
    };
    for (const lv of c.resolved.levels)
      for (const o of lv.openings) {
        const [a, b] = o.sides;
        if (a !== null && b !== null) join(`${lv.id}|${a}`, `${lv.id}|${b}`);
      }
    const byId = new Map(c.resolved.levels.map((l) => [l.id, l]));
    for (const lk of c.resolved.links) {
      const lo = byId.get(lk.fromLevel);
      const up = byId.get(lk.toLevel);
      const f = lk.lowerCells[0];
      if (!lo || !up || !f) continue;
      // the foot of a stair stands in the cell before the run (a ladder in its own cell)
      const a = areaAt(lo, f[0], f[1]);
      const b = areaAt(up, lk.arrival[0], lk.arrival[1]);
      if (a && b) join(a, b);
    }
    const comps = new Set([...allNodes].map(find)).size;
    // a loop exists when there are more joins than a forest over the rooms would have
    if (allNodes.size < T.minRooms || allEdges <= allNodes.size - comps) return [];
    return [
      {
        code: "single_route",
        levelId: L.id,
        score: T.weight,
        message: `the ${allNodes.size} rooms across ${c.resolved.levels.length} levels (stairs and ladders counted) connect in a single branching route with no loop`,
        action:
          "add a second way through: a second stair or ladder, or a passage joining two rooms on different branches, so some route returns by a different way",
      },
    ];
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
      score: T.weight * capped(0.8 + n * 0.1),
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
  const groups = new Map<string, { n: number; ids: string[]; theme: string; type: FeatureType }>();
  for (const f of c.L.features) {
    if (!REPEAT_WATCH.has(f.type) || c.dropped?.has(f.id)) continue;
    const k = `${f.type}|${f.variant ?? ""}|${f.hint ?? ""}`;
    const g = groups.get(k) ?? {
      n: 0,
      ids: [],
      theme: elementThemeAt(f.theme, c.L, f.at, c.defaultTheme),
      type: f.type,
    };
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
  // a place of a formal theme may be laid out in mirror symmetry: its cells are not judged (each cell's own theme)
  const formal = (x: number, y: number): boolean => {
    const i = cellIndex(L.bounds, x - L.bounds.x, y - L.bounds.y);
    return i >= 0 && c.formalLayout(cellTheme(L, i, c.defaultTheme));
  };
  // occupied cells: building footprints and blocking features
  const occ = new Set<string>();
  const occupy = (x: number, y: number): void => {
    if (!formal(x, y)) occ.add(`${x},${y}`);
  };
  for (const st of L.structures ?? [])
    if (st.kind === "building") for (const [x, y] of st.cells) occupy(x, y);
  for (const f of L.features)
    if (!NATURAL_FEATURES.has(f.type) && !isBandRock(f.type))
      for (let dy = 0; dy < f.size[1]; dy++)
        for (let dx = 0; dx < f.size[0]; dx++) occupy(f.at[0] + dx, f.at[1] + dy);
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
    // a line's pieces hang overhead (their posts are checked as props)
    if (f.type === "overhead") continue;
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
      score:
        REVIEW.streets.weight *
        Math.min(
          REVIEW.streets.misplacedCap,
          REVIEW.streets.misplacedBase + wrong.length * REVIEW.streets.misplacedPerProp,
        ),
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

/** Small natural rises (outcrop ops) that are plain blocks: square corners with straight sides. */
function squareOutcrops(c: Ctx): DesignNote[] {
  const T = REVIEW.outcrops;
  const square: string[] = [];
  for (const o of c.L.outcrops ?? []) {
    if (o.cells.length < T.minCells) continue;
    for (const comp of components(o.cells))
      if (comp.length >= T.minCells && squareCorners(comp, T.arm) >= T.squareCorners) {
        square.push(o.id);
        break;
      }
  }
  if (square.length === 0) return [];
  return [
    {
      code: "square_outcrop",
      levelId: c.L.id,
      score: T.weight * capped(0.8 + square.length * 0.3),
      elementIds: square,
      message: `${square.join(", ")}: small natural rise${square.length > 1 ? "s are" : " is a"} square block${square.length > 1 ? "s" : ""} (square corners, straight sides)`,
      action:
        "give the rock an irregular outline: generator 3 cuts corners and bites the sides; otherwise use a ragged platform, or clad it with boulders and growth",
    },
  ];
}

function terraces(c: Ctx): DesignNote[] {
  const T = REVIEW.terraces;
  const lv = c.plan.levels.find((l) => l.id === c.L.id);
  const out: DesignNote[] = [];
  for (const op of lv?.terrain ?? []) {
    if (op.op === "platform") {
      // a knoll built as thin plates: two or more raised levels with every step under a tile, square outlines
      const cells = opCells(c, op.shape).filter(
        ([x, y]) => c.walkable[(y - c.L.bounds.y) * c.W + (x - c.L.bounds.x)],
      );
      const levels = new Map<number, Array<[number, number]>>();
      for (const [x, y] of cells) {
        const h = c.L.cells.height[(y - c.L.bounds.y) * c.W + (x - c.L.bounds.x)] as number;
        if (h > 0) levels.set(h, [...(levels.get(h) ?? []), [x, y]]);
      }
      const hs = [...levels.keys()].sort((a, b) => a - b);
      if (hs.length < 2 || hs.some((h, k) => h - (hs[k - 1] ?? 0) >= 4)) continue;
      let sq = 0;
      let plates = 0;
      for (const list of levels.values())
        for (const comp of components(list))
          if (comp.length >= T.minBand) {
            plates++;
            sq += squareCorners(comp, T.arm);
          }
      if (plates < 2) continue;
      out.push({
        code: "square_terraces",
        levelId: c.L.id,
        score: T.weight * Math.max(1, over(sq, T.squareCorners)),
        elementIds: [op.id],
        message: `the rise of ${op.id} is built from ${hs.length} thin plates (steps under a tile, ${sq} square corners): it reads as stacked contour layers`,
        action:
          "make it one rounded mound: fewer, larger steps (a tile or more each) on a ragged outline; a platform op of natural ground with a ragged outline is built this way",
      });
      continue;
    }
    if (op.op !== "uneven") continue;
    // ground the op excludes (a dais, a terrace of its own) is not the op's work
    const skipped = new Set<string>();
    for (const s of op.exclude ?? []) for (const [x, y] of opCells(c, s)) skipped.add(`${x},${y}`);
    const cells = (
      op.shape
        ? opCells(c, op.shape)
        : Array.from(
            { length: c.W * c.H },
            (_, i) => [c.L.bounds.x + (i % c.W), c.L.bounds.y + Math.floor(i / c.W)] as [number, number],
          )
    ).filter(([x, y]) => !skipped.has(`${x},${y}`));
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

// ───────────────────────── cliffs (judged as gen/cliffband.ts builds them) ─────────────────────────

/**
 * Rock of more than one tone family in a cliff (generator 3). Cliffs are judged as the realizer builds them (one tone
 * per cliff: the kind with no piece in the cliff's tone is not built), so this fires only where that rule is off or
 * cannot hold. Cave walls: `cave_rock_tones` in review/caveMass.ts.
 */
function rockTonesMixed(c: Ctx): DesignNote[] {
  const { L } = c;
  if (!c.gen.cliffToneRule) return [];
  const where = new Map<string, Set<string>>();
  const add = (place: string, tones: string[]): void => {
    if (tones.length > 0) where.set(place, new Set([...(where.get(place) ?? []), ...tones]));
  };
  const themeOf = (f: (typeof L.features)[number]): string =>
    elementThemeAt(f.theme, L, f.at, c.defaultTheme);
  const faces = new Set(L.features.filter((f) => f.type === "cliff_face").map(themeOf));
  const crests = new Set(L.features.filter((f) => f.type === "cliff_crest").map(themeOf));
  for (const theme of new Set([...faces, ...crests])) {
    const k = c.rockKinds(theme);
    // the rule narrows each kind to the cliff's tone; without it every piece of the role can stand
    const narrow = k.tone;
    if (faces.has(theme) && k.face) add("the cliffs", c.roleTones(theme, CLIFF_FACE_ROLE, narrow));
    if (crests.has(theme) && k.crest) {
      // boulders of the face's tone (the boulder role's, else the palette's same-tone boulder role), else the other
      // tone as they are: that is the mixed case
      const same = c.roleTones(theme, CLIFF_CREST_ROLE, narrow);
      const alt =
        narrow === undefined || same.length > 0 ? [] : c.roleTones(theme, `${CLIFF_CREST_ROLE}_${narrow}`);
      add("the cliffs", same.length > 0 ? same : alt.length > 0 ? alt : c.roleTones(theme, CLIFF_CREST_ROLE));
    }
  }
  // cave walls: the tone count of the built wall is review/caveMass.ts (`cave_rock_tones`, measured on the realized
  // pieces); not repeated here
  const out: DesignNote[] = [];
  for (const [place, tones] of where) {
    if (tones.size < 2) continue;
    out.push({
      code: "rock_tones_mixed",
      levelId: L.id,
      score: REVIEW.rockTones.weight,
      message: `rock of ${tones.size} tone families (${[...tones].sort().join(", ")}) in ${place}: pale and grey stones side by side read as two kinds of rock`,
      action:
        "keep the cliff's rock to one family: a theme whose cliff and boulders match, or no cliff band here",
    });
  }
  return out;
}

/** The cliff notes of a level, in note order: bare faces, the band's shape, timid rises, a rectangular natural board. */
function cliffChecks(c: Ctx): DesignNote[] {
  const band = cliffBandView(c);
  reportCliffCoverage(c, band);
  const out: DesignNote[] = [];
  bareFaceNotes(c, band, out);
  bandShapeNotes(c, band, out);
  timidRiseNotes(c, out);
  boardFillNotes(c, out);
  return out;
}

/** A cliff edge unit: the middle of the edge, the low cell, the outward step and the rise (tiles). */
interface Unit {
  mid: [number, number];
  low: [number, number];
  out: [number, number];
  rise: number;
}

/** Edge units with the ground heights on either side (tiles above the base plane), judged by what hides the face. */
interface Face extends Unit {
  lo: number;
  hi: number;
}

/**
 * The level's rock band as the checks see it: its pieces and their shapes as the build lays them, the cliff edge units,
 * the faces judged by what hides them (inner cliffs and, generator 3, the board's own edge), and the share helpers.
 */
function cliffBandView(c: Ctx) {
  const { L } = c;
  // (the band as planned: where the realizer drops a kind of rock for tone, it clads those drops with its plain block
  // face instead, which the plan cannot change, so these notes judge the plan)
  const rocks = L.features.filter((f) => isBandRock(f.type));
  const covers = (f: (typeof rocks)[number], px: number, py: number, pad: number): boolean =>
    px >= f.at[0] - pad &&
    px <= f.at[0] + f.size[0] + pad &&
    py >= f.at[1] - pad &&
    py <= f.at[1] + f.size[1] + pad;
  const STEPV: Record<string, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
  const units: Unit[] = [];
  for (const run of L.cliffs ?? [])
    for (const e of run.edges) {
      const [dx, dy] = STEPV[e.side] as [number, number];
      const mid: [number, number] = [e.at[0] + 0.5 + dx * 0.5, e.at[1] + 0.5 + dy * 0.5];
      units.push({ mid, low: [e.at[0] + dx, e.at[1] + dy], out: [dx, dy], rise: (e.high - e.low) / 4 });
    }
  // what really hides a face (gen/cover.ts): the pieces as the build lays them (generator 3 turns and slides them;
  // earlier generators laid every rock at one turn), over the whole height of the drop
  const turned = c.gen.restingCliffBand;
  const shapes: RockShape[] = [];
  for (const f of rocks) {
    const ext = c.rockExtent(
      elementThemeAt(f.theme, c.L, f.at, c.defaultTheme),
      f.type as "cliff_face" | "cliff_crest",
    );
    if (!ext) continue;
    shapes.push({
      cx: f.at[0] + f.size[0] / 2 + (turned ? (f.offset?.[0] ?? 0) : 0),
      cy: f.at[1] + f.size[1] / 2 + (turned ? (f.offset?.[1] ?? 0) : 0),
      rot: turned ? f.rotFine : 0,
      w: ext.w,
      d: ext.d,
      base: f.baseHeight,
      top: f.baseHeight + ext.h,
    });
  }
  const ground = L.elevation + 0.5;
  const faceOf = (u: Unit, lo: number, hi: number): Face => ({ ...u, lo, hi });
  const hides = (u: Face): boolean =>
    edgeHidden(
      shapes,
      u.mid[0],
      u.mid[1],
      u.out[0] === 0 ? 1 : 0,
      u.out[1] === 0 ? 1 : 0,
      ground + u.lo,
      ground + u.hi,
    );
  const faces: Face[] = [];
  const FLAGS_AT = (x: number, y: number): number => {
    const lx = x - L.bounds.x;
    const ly = y - L.bounds.y;
    return lx < 0 || ly < 0 || lx >= c.W || ly >= c.H ? 0 : (L.cells.flags[ly * c.W + lx] as number);
  };
  // a rock ramp climbs the cliff: its cells and the ones beside them are the way up, not bare face
  const rampAt = new Set<string>();
  for (const r of L.ramps ?? []) for (const [rx, ry] of r.cells) rampAt.add(`${rx},${ry}`);
  const nearRamp = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (rampAt.has(`${x + dx},${y + dy}`)) return true;
    return false;
  };
  for (const run of L.cliffs ?? [])
    for (const e of run.edges) {
      const [dx, dy] = STEPV[e.side] as [number, number];
      if (nearRamp(e.at[0], e.at[1])) continue;
      // a route crossing here (steps, a link, a path on both sides) keeps its gap, and the face under water is the
      // water's: neither is bare face
      const f0 = FLAGS_AT(e.at[0], e.at[1]);
      const f1 = FLAGS_AT(e.at[0] + dx, e.at[1] + dy);
      // (nothing can stand on a path: a path cell at the foot or the lip keeps its gap too)
      if (((f0 | f1) & (CELL_FLAG.LINK | CELL_FLAG.STEPS | CELL_FLAG.PATH)) !== 0) continue;
      if ((f1 & CELL_FLAG.WATER) !== 0) continue;
      const mid: [number, number] = [e.at[0] + 0.5 + dx * 0.5, e.at[1] + 0.5 + dy * 0.5];
      faces.push(
        faceOf(
          { mid, low: [e.at[0] + dx, e.at[1] + dy], out: [dx, dy], rise: (e.high - e.low) / 4 },
          e.low / 4,
          e.high / 4,
        ),
      );
    }
  // the board's own edge: open ground standing a tile or more above the base, beside void or off the board
  const edgeFaces: Face[] = [];
  if (c.gen.restingCliffBand)
    for (let ly = 0; ly < c.H; ly++)
      for (let lx = 0; lx < c.W; lx++) {
        const i = ly * c.W + lx;
        const fl = L.cells.flags[i] as number;
        if (L.cells.state[i] !== CELL.OPEN || (fl & (CELL_FLAG.NO_FLOOR | CELL_FLAG.BRIDGE)) !== 0) continue;
        if ((L.cells.material[i] ?? 0) === 0) continue;
        const hh = (L.cells.height[i] ?? 0) / 4;
        if (hh < 1) continue;
        for (const [dx, dy] of Object.values(STEPV)) {
          const nx = lx + dx;
          const ny = ly + dy;
          const out_ =
            nx < 0 || ny < 0 || nx >= c.W || ny >= c.H || L.cells.state[ny * c.W + nx] === CELL.VOID;
          if (!out_) continue;
          const x = L.bounds.x + lx;
          const y = L.bounds.y + ly;
          edgeFaces.push(
            faceOf(
              {
                mid: [x + 0.5 + dx * 0.5, y + 0.5 + dy * 0.5],
                low: [x + dx, y + dy],
                out: [dx, dy],
                rise: hh,
              },
              0,
              hh,
            ),
          );
        }
      }
  const high = units.filter((u) => u.rise >= 2);
  const faceHigh = faces.filter((u) => u.rise >= 2);
  const faceLow = faces.filter((u) => u.rise >= 1 && u.rise < 2);
  // the band measures below (reach, width, crest) look at where pieces stand; only bare face uses `hides`
  const clad = (u: Unit): boolean => rocks.some((f) => covers(f, u.mid[0], u.mid[1], 0.3));
  const share = (list: Unit[], pred: (u: Unit) => boolean): number =>
    list.length === 0 ? 0 : list.filter(pred).length / list.length;
  return { rocks, covers, units, turned, shapes, hides, edgeFaces, high, faceHigh, faceLow, clad, share };
}

type CliffBandView = ReturnType<typeof cliffBandView>;

/** The coverage the band leaves (tall, low and board-edge faces: how many, and where bare) for the caller's measures. */
function reportCliffCoverage(c: Ctx, { hides, faceHigh, faceLow, edgeFaces }: CliffBandView): void {
  const { L } = c;
  c.onCoverage?.({
    levelId: L.id,
    tall: { edges: faceHigh.length, bare: faceHigh.filter((u) => !hides(u)).length },
    low: { edges: faceLow.length, bare: faceLow.filter((u) => !hides(u)).length },
    board: { edges: edgeFaces.length, bare: edgeFaces.filter((u) => !hides(u)).length },
    bareAt: {
      tall: faceHigh.filter((u) => !hides(u)).map((u) => u.mid),
      low: faceLow.filter((u) => !hides(u)).map((u) => u.mid),
      board: edgeFaces.filter((u) => !hides(u)).map((u) => u.mid),
    },
  });
}

/**
 * Bare faces: the board's edge, the tall cliffs (unclad, sheer, thin band, no crest) and the one-tile banks. The band
 * measures (reach, width, crest) look at where pieces stand; only bare face uses `hides`.
 */
function bareFaceNotes(c: Ctx, band: CliffBandView, out: DesignNote[]): void {
  const T = REVIEW.cliffs;
  const { L } = c;
  const { rocks, covers, hides, edgeFaces, high, faceHigh, faceLow, clad, share } = band;
  const bareShare = (list: Face[]): number =>
    list.length === 0 ? 0 : list.filter((u) => !hides(u)).length / list.length;
  if (edgeFaces.length >= T.minUnits) {
    const bare = bareShare(edgeFaces);
    if (bare > T.edgeBare)
      out.push({
        code: "board_edge_bare",
        levelId: L.id,
        // low priority by design (most slabs are tiled beside others, and a piece may not stand beyond the board's
        // bounds): it ranks below every interior cliff and layout note and shows only when the review has room
        score: T.edgeScore,
        message: `${Math.round(bare * 100)}% of the board's outer edge (ground standing a tile or more above the base) shows a bare wall`,
        action:
          "optional: keep a strip of low ground at the board's edge so the band can skirt it from inside the bounds (no rock may stand beyond them: slabs are tiled side by side)",
      });
  }
  if (faceHigh.length >= T.minUnits) {
    const bare = bareShare(faceHigh);
    if (bare > T.unclad)
      out.push({
        code: "cliff_unclad",
        levelId: L.id,
        score: T.weight * over(bare, T.unclad),
        message: `${Math.round(bare * 100)}% of the cliff edge (rises of 2 tiles or more) is not hidden by rock: its face shows as bare blocks`,
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
  if (faceLow.length >= T.minUnits) {
    const bare = bareShare(faceLow);
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
}

/**
 * The band's shape: its outer boundary should wander, its pieces vary in piece and turn, stand unevenly spaced, leave
 * the terraces walkable and rest on something.
 */
function bandShapeNotes(c: Ctx, { rocks, turned, shapes }: CliffBandView, out: DesignNote[]): void {
  const T = REVIEW.cliffs;
  const { L } = c;
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
    const top = maxOf(counts.values()) / rocks.length;
    if (top > T.repetition)
      out.push({
        code: "cliff_repetition",
        levelId: L.id,
        score: T.weight * 0.6 * over(top, T.repetition),
        message: `${Math.round(top * 100)}% of the cliff rocks are the same piece in the same turn`,
        action: "vary the rock: two or three pieces per run, turned freely",
      });
    // rock standing along an edge at a steady interval: a fence of teeth (boulders), or long pieces at one step
    for (const kind of ["cliff_crest", "cliff_face"] as const) {
      const rule = FENCE[kind] as FenceRule;
      const ofKind = rocks.filter((f) => f.type === kind);
      if (ofKind.length < T.minPieces) continue;
      const fence = fenceShare(
        ofKind.map((f) => ({
          x: f.at[0] + f.size[0] / 2 + (turned ? (f.offset?.[0] ?? 0) : 0),
          y: f.at[1] + f.size[1] / 2 + (turned ? (f.offset?.[1] ?? 0) : 0),
        })),
        rule,
      );
      if (fence.share > T.evenSpacing)
        out.push({
          code: "cliff_even_spacing",
          levelId: L.id,
          score: T.weight * 0.7 * over(fence.share, T.evenSpacing),
          message: `${Math.round(fence.share * 100)}% of the ${kind === "cliff_crest" ? "cliff boulders" : "cliff face rocks"} stand in rows at an even interval (${fence.runs.length} runs of ${fence.runs.map((r) => r.n).join(", ")}; about ${Math.round(fence.runs[0]?.gap ?? 0)} tiles apart)`,
          action:
            kind === "cliff_crest"
              ? "set boulders in groups of two to five with clear gaps between the groups, and leave stretches of lip bare where a face rock already hides the drop"
              : "vary the spacing, turn and height of the face rock: overlap some neighbours, leave others apart, let a taller piece take a stretch",
        });
    }
    // rock that buries a terrace: the share of its walkable ground the rock stands on (a terrace of a 2-tile riser
    // keeps most of its width for walking, planting and the eye to rest)
    const walk: Array<{ x: number; y: number; ground: number }> = [];
    for (let ly = 0; ly < c.H; ly++)
      for (let lx = 0; lx < c.W; lx++) {
        const i = ly * c.W + lx;
        if (L.cells.state[i] !== CELL.OPEN || (L.cells.material[i] ?? 0) === 0) continue;
        walk.push({
          x: L.bounds.x + lx,
          y: L.bounds.y + ly,
          ground: L.elevation + 0.5 + (L.cells.height[i] ?? 0) / 4,
        });
      }
    const buried = terraceRockShare(shapes, walk).filter((t) => t.share > T.terraceShare);
    const worst = buried.sort((a, b) => b.share - a.share)[0];
    if (worst)
      out.push({
        code: "cliff_buries_ground",
        levelId: L.id,
        score: T.weight * 0.9 * over(worst.share, T.terraceShare),
        message: `rock stands on ${Math.round(worst.share * 100)}% of the walkable ground of a terrace (${worst.covered} of ${worst.cells} cells): the terrace is more rock than ground`,
        action:
          "fewer, longer face pieces and boulders only in a few groups; face no riser the terrace above needs less, and leave the ground between the cliffs open",
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
}

/** Few, bold rises: most steps a single tile is timid. */
function timidRiseNotes(c: Ctx, out: DesignNote[]): void {
  const T = REVIEW.cliffs;
  const { L } = c;
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
}

/** A natural map should not fill its rectangle. */
function boardFillNotes(c: Ctx, out: DesignNote[]): void {
  const T = REVIEW.cliffs;
  const { L } = c;
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
}

// ───────────────────────── ruins (the building engineer's measures) ─────────────────────────

function ruins(c: Ctx): DesignNote[] {
  const T = REVIEW.ruins;
  const out: DesignNote[] = [];
  for (const st of buildingsOf(c)) {
    // a weathered building must read as neglected: too few signs and it looks like its intact version (generator 3)
    if (st.condition === "weathered" && c.gen.legibleCondition) {
      const wm = weatherMeasures(st, c.L.arrangements);
      const signs = wm ? weatherSigns(wm) : 0;
      if (wm && signs < T.weatherSigns)
        out.push({
          code: "weathered_same_as_intact",
          levelId: c.L.id,
          score: T.weight * (1 + (T.weatherSigns - signs) / T.weatherSigns),
          elementIds: [st.id],
          message: `the weathered building ${st.id} shows ${signs} of 5 signs of neglect and reads as intact (roof patch ${Math.round(wm.roofMissing * 100)}%, boarded windows ${Math.round(wm.boardedWindows * 100)}%, growth at the foot ${wm.baseGrowth.toFixed(2)})`,
          action:
            "give it a roof of its own (a gable or flat roof the patch can fall in), windows to board, and a plot with free ground at its foot; or build it intact",
        });
    }
    // generator 3: a weathered or ruined building in a theme with climbing growth must not be bare of it
    if (st.condition && st.condition !== "intact" && c.gen.legibleCondition && c.hasRole) {
      const has = (n: string): boolean => c.hasRole?.(st.theme, n) === true;
      if (has(RUIN_CLIMBER_ROLE) || has(featureRole("vines"))) {
        const g = growthMeasures(st);
        const level = st.growthLevel ?? (st.condition === "ruined" ? "medium" : "light");
        const min = GROWTH_LEVELS[level].min;
        // judged as coverage of the wall cells (not a share of growth pieces): the level promises a share of the wall
        if (level !== "none" && g.coverage < min)
          out.push({
            code: "growth_bare",
            levelId: c.L.id,
            score: T.weight * (g.coverage === 0 ? 2 : 1 + (min - g.coverage) / min),
            elementIds: [st.id],
            message: `the ${st.condition} building ${st.id} is not ${level === "heavy" ? "overgrown" : "grown over"}: vines and roots cover ${Math.round(g.coverage * 100)}% of its ${g.columns} wall cells, a ${level} level wants ${Math.round(min * 100)}% or more`,
            action:
              'give it free ground at the wall foot (leave a ring of open cells round it) so vines and roots can climb it, set growth: "heavy" for an overgrown place, or build it intact',
          });
      }
    }
    // generator 3: the roof is the larger part of a cottage or inn (the study: 55-65 % of the visible height)
    if (st.style === "cottage" && c.gen.buildingVariety) {
      const rp = roofProportion(st);
      if (rp && rp.share < T.roofShare)
        out.push({
          code: "roof_squat",
          levelId: c.L.id,
          score: T.weight * over(T.roofShare, Math.max(0.1, rp.share)),
          elementIds: [st.id],
          message: `the roof of ${st.id} is only ${Math.round(rp.share * 100)}% of its height (${rp.roof} of ${rp.visible} tiles)`,
          action:
            "let the top storey sit inside the roof (an attic with dormers) or lower the walls so the roof reads as the larger half",
        });
    }
    if (st.condition !== "ruined") continue;
    const m = structureRuinMeasures(st);
    if (!m) continue;
    // generator 3 judges the cut wall tops only: a roofed part standing whole is the anchor, not a flat top
    const legible = c.gen.legibleCondition;
    const flat = legible && m.intactShare > 0 ? 1 - m.cutVariety : 1 - m.topVariety;
    // (generator 3: a collapse steps down in slopes and long runs, so level neighbours alone no longer condemn it; one
    // level line does, and so does a clean cut with long equal runs)
    if (flat > (legible ? T.flatTop3 : T.flatTop) || (legible && m.runShort < T.runShort))
      out.push({
        code: "ruin_flat_top",
        levelId: c.L.id,
        score:
          T.weight *
          Math.max(over(flat, T.flatTop), legible ? over(T.runShort, Math.max(0.1, m.runShort)) : 0),
        elementIds: [st.id],
        message: legible
          ? `the ruin ${st.id} has clean-cut wall tops (${Math.round(m.runShort * 100)}% of its runs of equal height are short; ${Math.round(flat * 100)}% of neighbouring cut tops are level)`
          : `the ruin ${st.id} has a level, even wall top (${Math.round(flat * 100)}% of neighbouring wall tops are the same height)`,
        action:
          "break it further: a taller tower mass, more loss, or another seed, so the wall tops step every one or two cells",
      });
    // generator 3: wall tops that alternate one up, one down read as battlements, not a collapse
    if (legible && m.teeth > T.teeth)
      out.push({
        code: "ruin_teeth",
        levelId: c.L.id,
        score: T.weight * over(m.teeth, T.teeth),
        elementIds: [st.id],
        message: `the ruin ${st.id} has battlement teeth: ${Math.round(m.teeth * 100)}% of its cut wall tops are one-cell peaks or pits (a collapse has long runs and slopes)`,
        action:
          "let the wall fall in long runs: a tall surviving corner, a slope stepping down over several cells, a stretch near ground level, a breach",
      });
    // generator 3: a roof is always held up: no eave over a wall that has fallen away
    if (legible) {
      const bare = roofUnsupportedEdges(st);
      if (bare.length > 0)
        out.push({
          code: "roof_unsupported",
          levelId: c.L.id,
          score: T.weight * 2,
          elementIds: [st.id],
          message: `the roof of ${st.id} hangs over ${bare.length} wall cells that have fallen away (first at (${bare[0]?.at[0]},${bare[0]?.at[1]}) ${bare[0]?.side})`,
          action: "keep that wall standing under the roof, or take the roof off above the lost bay",
        });
    }
    const intact = st.storeys.reduce((t, q) => t + q.wallHeight, 0);
    // a part standing whole under its roof is itself the contrast with the stubs (generator 3)
    if (intact >= T.minIntact && m.contrast < T.contrast && !(legible && m.intactShare > 0))
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
