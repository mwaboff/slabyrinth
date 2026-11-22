/**
 * Chunk + encode + bundle (architecture §4.6, decisions.md "Chunk alignment markers").
 *  - Fewest slabs (ruling 2026-11-18): the whole build, all levels, is ONE slab whenever it fits under
 *    fill × 30,720 bytes of real gzip (default fill 0.8 ≈ 24 KB). Otherwise whole levels are packed in order into as
 *    few chunks as fit; only a level that does not fit alone is cut into rectangular whole-cell regions (k-d split at
 *    the median source cell along the longer axis, re-measured until it fits).
 *  - When the build has more than one chunk (default "multi-chunk"), every chunk gets the same two alignment
 *    markers (palette marker.alignment, a pillar), one clear cell diagonally outside the global min corner at ground
 *    level and outside the max corner raised to the top of the build. All chunks are normalised with ONE shared
 *    offset, so every chunk has an identical bounding box in all three axes (confirmed in game 2026-11-18).
 *  - Pasted from beside the map (switch pasteBesideMap, generator 4): TaleSpire pastes a slab at the centre of its box,
 *    and a chunk whose placement ray lands on a piece an earlier chunk placed sits about half a tile high, and so does
 *    every chunk after it; with the cursor on bare ground four cells beside the map every chunk landed level (both
 *    measured in game 2026-11-21). So a build of more than one chunk moves its two markers (`besideMapBox`) until the
 *    box's centre is the middle of a bare cell south of the middle of the map's south edge, ANCHOR_CLEARANCE_CELLS
 *    empty cells out: the min marker goes far south, about a map's depth beyond the anchor. A one-chunk build is
 *    unchanged.
 */
import type {
  Box3,
  ChunkOptions,
  CompileDiagnostic,
  CompileDiagnosticCode,
  ExportBundle,
  Placement,
  PlacementSet,
  SlabAsset,
  SlabChunk,
  SlabCodec,
} from "../contracts/compiler";
import type { LevelId } from "../contracts/plan";
import { MARKER_ROLE } from "../palette/roles";
import { sha256Hex } from "../slab/sha256";
import { emptyBox, finiteBox, growBox } from "./geometry";
import { placedBox } from "./placed";
import type { RealizedSet } from "./realize/output";
import { minOf, pushAll } from "../util/lists";

/** The verify codes this stage emits (the water level note; VERIFY_CODES is the union of every check's list). */
export const CHUNK_VERIFY_CODES = ["verify_water_level"] as const satisfies readonly CompileDiagnosticCode[];

export const DEFAULT_FILL = 0.8;
export const DEFAULT_SIDE_BY_SIDE_GAP = 10;
/** Recommended elevation step between stacked levels (BUILD_CONSTANTS.storeyHeight). */
const STOREY = 2.5;

export interface ChunkEncodeOptions extends ChunkOptions {
  /** ISO timestamp for the bundle (injected for deterministic tests). */
  createdAt?: string;
  /** Overrides RealizedSet.resolvedHash (when the set came from elsewhere). */
  resolvedHash?: string;
  /** Alignment marker asset when the set does not carry one. */
  marker?: { uuid: string } | null;
}

/** Empty cells between the build's corner cell and each alignment marker (one clear cell makes them easy to aim at). */
export const MARKER_GAP_CELLS = 1;

interface Item {
  p: Placement;
  box: Box3;
  cx: number;
  cy: number;
  levelId: LevelId;
}

const floor4 = (v: number): number => Math.floor(v * 4 + 1e-9) / 4;

function colName(i: number): string {
  let s = "";
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function chunkAndEncode(
  set: PlacementSet,
  codec: SlabCodec,
  opts: ChunkEncodeOptions = {},
): ExportBundle {
  const rs = set as Partial<RealizedSet> & PlacementSet;
  const fill = opts.fill ?? DEFAULT_FILL;
  const budget = Math.floor(fill * codec.limits.maxCompressedBytes);
  const alignment = opts.alignment ?? "multi-chunk";
  const layout = opts.levelLayout ?? "stacked";
  const diagnostics: CompileDiagnostic[] = [...set.diagnostics];
  const markerAsset = opts.marker !== undefined ? opts.marker : (rs.marker ?? null);
  const laid = layoutBuild(set, opts, codec);
  if (laid.overflow) {
    diagnostics.push(laid.overflow);
    return emptyBundle(set, rs, opts, diagnostics, laid.levelPlacement);
  }
  const packing = startPacking(codec, opts, budget, markerAsset, laid);
  const { found, withMarkers, anchor } = packRegions(packing, alignment, besideMap(set), diagnostics);
  const chunks = buildChunks(packing, found, withMarkers);
  return finishBundle({ set, rs, opts, laid, chunks, diagnostics, withMarkers, layout, anchor });
}

/** Whether the set's generator pastes a multi-chunk build from beside the map (switch pasteBesideMap). */
function besideMap(set: PlacementSet): boolean {
  return (set as Partial<RealizedSet>).facts?.profile.pasteBesideMap === true;
}

/** Empty cells between the paste anchor's cell and the map (the margin of the passing in-game test, 2026-11-21). */
export const ANCHOR_CLEARANCE_CELLS = 4;

/**
 * The shared box of a build pasted from beside the map, in world tiles on x and z (the markers are 1×1 pieces with
 * their pivot at the min corner, so the box runs from the min marker's min corner to the far side of the max marker).
 * The map spans gmin..gmax. The anchor cell is centred on the middle of the south edge (x) and lies
 * ANCHOR_CLEARANCE_CELLS empty cells south of it (z = gmin.z − clearance − 1). The max marker stands where it always
 * did, one clear cell beyond the north-east corner (one cell further east when that puts the x centre mid-cell); the
 * min marker one clear cell west of the map and as far south as makes the box's centre the anchor cell's middle.
 */
export interface BesideMapBox {
  readonly min: { readonly x: number; readonly z: number };
  readonly max: { readonly x: number; readonly z: number };
  /** Min corner of the anchor cell (the box centre is this + 0.5 on both axes). */
  readonly anchor: { readonly x: number; readonly z: number };
}

export function besideMapBox(
  gmin: { readonly x: number; readonly z: number },
  gmax: { readonly x: number; readonly z: number },
): BesideMapBox {
  const mg = 1 + MARKER_GAP_CELLS;
  const anchor = { x: Math.floor((gmin.x + gmax.x) / 2), z: gmin.z - ANCHOR_CLEARANCE_CELLS - 1 };
  // the centre on each axis is anchor + 0.5, so min + max = 2 × anchor + 1
  const minX = gmin.x - mg;
  const maxZ = gmax.z + mg;
  return {
    min: { x: minX, z: 2 * anchor.z + 1 - maxZ },
    max: { x: 2 * anchor.x + 1 - minX, z: maxZ },
    anchor,
  };
}

/** A region of the build that is encoded as one chunk: its levels, items, cell rectangle, assets and encoding. */
interface Region {
  levelId: LevelId;
  levelIds: LevelId[];
  items: Item[];
  rect: { x: number; y: number; w: number; h: number };
  enc: { slab: string; rawBytes: number; compressedBytes: number };
  assets: SlabAsset[];
}

/**
 * How the laid-out build is packed into chunks: the alignment markers and the shared offset, the slab assets of a set of
 * items, the level order, and `split` (whole levels packed into as few groups as fit, each cut until it fits).
 */
function startPacking(
  codec: SlabCodec,
  opts: ChunkEncodeOptions,
  budget: number,
  markerAsset: { uuid: string } | null,
  { levels, perLevelRaw, gmin, gmax }: ReturnType<typeof layoutBuild>,
) {
  const grouping: "fewest" | "per-level" = opts.grouping ?? "fewest";
  // Markers sit diagonally outside the corner cells with MARKER_GAP_CELLS empty cells in between: the min marker at
  // ground level (min y), the max marker raised to the top of the build (max y).
  // With `beside` (pasteBesideMap) they stand at the corners of besideMapBox instead.
  const mg = 1 + MARKER_GAP_CELLS;
  const markersFor = (
    on: boolean,
    beside: BesideMapBox | null = null,
  ): Array<{ uuid: string; x: number; y: number; z: number }> =>
    on && markerAsset
      ? beside
        ? [
            { uuid: markerAsset.uuid, x: beside.min.x, y: gmin.y, z: beside.min.z },
            { uuid: markerAsset.uuid, x: beside.max.x - 1, y: gmax.y, z: beside.max.z - 1 },
          ]
        : [
            { uuid: markerAsset.uuid, x: gmin.x - mg, y: gmin.y, z: gmin.z - mg },
            { uuid: markerAsset.uuid, x: gmax.x + mg - 1, y: gmax.y, z: gmax.z + mg - 1 },
          ]
      : [];
  const offsetFor = (on: boolean, beside: BesideMapBox | null = null): { x: number; y: number; z: number } =>
    on && markerAsset
      ? beside
        ? { x: beside.min.x, y: gmin.y, z: beside.min.z }
        : { x: gmin.x - mg, y: gmin.y, z: gmin.z - mg }
      : gmin;
  const besideBox = besideMapBox(gmin, gmax);
  // (layout transform, items, global bounds and the coordinate check live in layoutBuild, shared with estimate)

  const toAssets = (
    items: Item[],
    markers: ReturnType<typeof markersFor>,
    off: { x: number; y: number; z: number },
  ): SlabAsset[] => {
    const out: SlabAsset[] = items.map((it) => ({
      uuid: it.p.asset,
      sx: codec.toScaled(it.p.x - off.x),
      sy: codec.toScaled(it.p.y - off.y),
      sz: codec.toScaled(it.p.z - off.z),
      rot: codec.degreesToRot(it.p.rot),
    }));
    for (const m of markers)
      out.push({
        uuid: m.uuid,
        sx: codec.toScaled(m.x - off.x),
        sy: codec.toScaled(m.y - off.y),
        sz: codec.toScaled(m.z - off.z),
        rot: 0,
      });
    return out;
  };

  /**
   * The slab of these assets, or null when it cannot be one slab: more pieces of one kind (or more kinds) than the
   * format counts. Such a set is cut further like one over the byte budget (a large map has that many floor tiles).
   */
  const encodeIfFits = (assets: SlabAsset[]): ReturnType<SlabCodec["encode"]> | null => {
    if (assets.length > codec.limits.maxAssetsPerLayout) {
      const perKind = new Map<string, number>();
      for (const a of assets) perKind.set(a.uuid, (perKind.get(a.uuid) ?? 0) + 1);
      if (perKind.size > codec.limits.maxLayouts) return null;
      for (const n of perKind.values()) if (n > codec.limits.maxAssetsPerLayout) return null;
    }
    return codec.encode(assets);
  };

  const levelOrder = new Map(levels.map((l, i) => [l.levelId, i]));
  const levelsOf = (items: Item[]): LevelId[] =>
    [...new Set(items.map((i) => i.levelId))].sort(
      (a, b) => (levelOrder.get(a) ?? 0) - (levelOrder.get(b) ?? 0),
    );

  /** Groups of items to cut into regions: whole levels packed in order into as few groups as fit (or one per level). */
  const groupsFor = (
    withMarkers: boolean,
    beside: BesideMapBox | null,
  ): Array<{ levelId: LevelId; items: Item[] }> => {
    const nonEmpty = perLevelRaw.filter((l) => l.items.length > 0);
    if (grouping === "per-level") return nonEmpty;
    const markers = markersFor(withMarkers, beside);
    const off = offsetFor(withMarkers, beside);
    const fits = (items: Item[]): boolean => {
      const enc = encodeIfFits(toAssets(items, markers, off));
      return enc !== null && enc.compressedBytes <= budget;
    };
    const out: Array<{ levelId: LevelId; items: Item[] }> = [];
    let cur: { levelId: LevelId; items: Item[] } | null = null;
    for (const l of nonEmpty) {
      if (cur && fits([...cur.items, ...l.items])) {
        cur.items = [...cur.items, ...l.items];
        continue;
      }
      if (cur) out.push(cur);
      cur = { levelId: l.levelId, items: [...l.items] };
    }
    if (cur) out.push(cur);
    return out;
  };

  const split = (
    withMarkers: boolean,
    beside: BesideMapBox | null = null,
  ): { regions: Region[]; oversize: CompileDiagnostic[]; splits: number } => {
    const markers = markersFor(withMarkers, beside);
    const off = offsetFor(withMarkers, beside);
    const regions: Region[] = [];
    const oversize: CompileDiagnostic[] = [];
    let splits = 0;
    const rectOf = (items: Item[]): Region["rect"] => {
      // (a loop, not Math.min(...): a region can hold more items than a call takes arguments)
      let x = Infinity,
        y = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const i of items) {
        x = Math.min(x, i.cx);
        y = Math.min(y, i.cy);
        x1 = Math.max(x1, i.cx);
        y1 = Math.max(y1, i.cy);
      }
      return { x, y, w: x1 - x + 1, h: y1 - y + 1 };
    };
    const rec = (levelId: LevelId, items: Item[]): void => {
      if (items.length === 0) return;
      const rect = rectOf(items);
      const assets = toAssets(items, markers, off);
      const enc = encodeIfFits(assets);
      if (enc !== null && enc.compressedBytes <= budget) {
        regions.push({
          levelId: levelsOf(items)[0] ?? levelId,
          levelIds: levelsOf(items),
          items,
          rect,
          enc,
          assets,
        });
        return;
      }
      // split along the longer axis at the median source cell
      const axis: "cx" | "cy" = rect.w >= rect.h ? "cx" : "cy";
      const tryAxes: Array<"cx" | "cy"> = [axis, axis === "cx" ? "cy" : "cx"];
      for (const ax of tryAxes) {
        const vals = items.map((i) => i[ax]).sort((a, b) => a - b);
        let m = vals[Math.floor(vals.length / 2)] ?? 0;
        if (m === vals[0]) m = vals.find((v) => v > m) ?? m;
        const lo = items.filter((i) => i[ax] < m);
        const hi = items.filter((i) => i[ax] >= m);
        if (lo.length && hi.length) {
          splits++;
          rec(levelId, lo);
          rec(levelId, hi);
          return;
        }
      }
      if (enc === null || enc.compressedBytes > codec.limits.maxCompressedBytes) {
        oversize.push({
          severity: "error",
          code: "chunk_oversize",
          stage: "chunk",
          levelId,
          cell: [rect.x, rect.y],
          message:
            enc === null
              ? `A single cell holds more pieces of one kind than a slab can (limit ${codec.limits.maxAssetsPerLayout})`
              : `A single cell holds ${enc.compressedBytes} bytes of slab data (limit ${codec.limits.maxCompressedBytes})`,
        });
        return;
      }
      regions.push({
        levelId: levelsOf(items)[0] ?? levelId,
        levelIds: levelsOf(items),
        items,
        rect,
        enc,
        assets,
      });
    };
    for (const g of groupsFor(withMarkers, beside)) rec(g.levelId, g.items);
    return { regions, oversize, splits };
  };
  return { codec, budget, markerAsset, levelOrder, split, besideBox, gmin };
}

type Packing = ReturnType<typeof startPacking>;

/**
 * The regions, with alignment markers when the build needs them (always, or when it is more than one chunk); notes a
 * missing marker asset, oversize cells and the split.
 */
function packRegions(
  { budget, markerAsset, split, besideBox, gmin }: Packing,
  alignment: NonNullable<ChunkOptions["alignment"]>,
  pasteBeside: boolean,
  diagnostics: CompileDiagnostic[],
): { found: readonly Region[]; withMarkers: boolean; anchor: ExportBundle["pasteAnchor"] } {
  let pass = split(alignment === "always");
  let withMarkers = alignment === "always";
  const multi = pass.regions.length > 1;
  if (alignment === "multi-chunk" && multi) withMarkers = true;
  // the paste anchor is the centre of the shared box, which only the markers make shared
  const beside = pasteBeside && multi && withMarkers && markerAsset !== null;
  if ((alignment === "multi-chunk" && multi) || beside) pass = split(true, beside ? besideBox : null);
  const anchor: ExportBundle["pasteAnchor"] = beside
    ? { side: "south", clearanceCells: ANCHOR_CLEARANCE_CELLS, farMarkerCells: gmin.z - besideBox.min.z - 1 }
    : undefined;
  if (withMarkers && !markerAsset) {
    diagnostics.push({
      severity: "warning",
      code: "role_missing",
      stage: "chunk",
      role: MARKER_ROLE,
      message: `No ${MARKER_ROLE} asset in the palettes; chunks carry no alignment markers`,
    });
    withMarkers = false;
  }
  pushAll(diagnostics, pass.oversize);
  if (pass.splits > 0) {
    diagnostics.push({
      severity: "info",
      code: "chunk_split",
      stage: "chunk",
      message: `Split into ${pass.regions.length} chunks to stay under ${budget} bytes each`,
      count: pass.splits,
    });
  }
  return { found: pass.regions, withMarkers, anchor };
}

/** The chunks in paste order (by first level, then row-major by region rect), labelled and with their paste notes. */
function buildChunks(
  { codec, levelOrder }: Packing,
  found: readonly Region[],
  withMarkers: boolean,
): SlabChunk[] {
  const regions = [...found].sort(
    (a, b) =>
      (levelOrder.get(a.levelId) ?? 0) - (levelOrder.get(b.levelId) ?? 0) ||
      a.rect.y - b.rect.y ||
      a.rect.x - b.rect.x,
  );
  const chunks: SlabChunk[] = [];
  const firstMin = new Map<string, { x: number; y: number; z: number }>();
  const markerNote = withMarkers
    ? "Aim so the south-west alignment pillar lands exactly on the pillar already placed, then commit; right-click before the next chunk."
    : "Paste on an empty board or build plane.";
  const groupKey = (r: Region): string => r.levelIds.join("+");
  for (const key of [...new Set(regions.map(groupKey))]) {
    const mine = regions.filter((r) => groupKey(r) === key);
    const xs = [...new Set(mine.map((r) => r.rect.x))].sort((a, b) => a - b);
    const ys = [...new Set(mine.map((r) => r.rect.y))].sort((a, b) => a - b);
    const minCellX = minOf(mine.map((r) => r.rect.x));
    mine.forEach((r, i) => {
      const cb = emptyBox();
      for (const it of r.items) growBox(cb, it.box);
      const bounds = finiteBox(cb);
      const fm = firstMin.get(key) ?? bounds.min;
      if (!firstMin.has(key)) firstMin.set(key, bounds.min);
      const raw = codec.encodeRaw(r.assets);
      const col = xs.indexOf(r.rect.x);
      const row = ys.indexOf(r.rect.y);
      const levelsText = r.levelIds.length > 1 ? `levels ${r.levelIds.join(", ")}` : `level ${r.levelId}`;
      const label =
        regions.length === 1
          ? "Whole build"
          : mine.length === 1
            ? r.levelIds.length > 1
              ? `Levels ${r.levelIds.join(" + ")}`
              : "Whole level"
            : positionLabel(col, xs.length, row, ys.length);
      chunks.push({
        id: `${key}-${String(i + 1).padStart(2, "0")}`,
        levelId: r.levelId,
        levelIds: r.levelIds,
        index: i + 1,
        countInLevel: mine.length,
        slab: r.enc.slab,
        compressedBytes: r.enc.compressedBytes,
        base64Length: r.enc.slab.length,
        assetCount: r.assets.length,
        bounds,
        cellRect: r.rect,
        pasteNote:
          regions.length > 1
            ? `Paste ${chunks.length + 1} of ${regions.length} (${levelsText}). ${markerNote}`
            : `One slab (${levelsText}). ${markerNote}`,
        hasAlignmentMarkers: withMarkers,
        label,
        columns: `${colName(r.rect.x - minCellX)}–${colName(r.rect.x - minCellX + r.rect.w - 1)}`,
        offsetFromFirst: {
          x: round4(bounds.min.x - fm.x),
          y: round4(bounds.min.y - fm.y),
          z: round4(bounds.min.z - fm.z),
        },
        contentHash: sha256Hex(raw),
      });
    });
  }
  return chunks;
}

/**
 * The bundle: each level's paste order, the stats, the water level notes (diagnostics and instructions: TaleSpire water
 * is a board-wide plane the slab cannot carry) and the paste instructions.
 */
function finishBundle(b: {
  set: PlacementSet;
  rs: Partial<RealizedSet> & PlacementSet;
  opts: ChunkEncodeOptions;
  laid: ReturnType<typeof layoutBuild>;
  chunks: SlabChunk[];
  diagnostics: CompileDiagnostic[];
  withMarkers: boolean;
  layout: NonNullable<ChunkOptions["levelLayout"]>;
  /** Where the cursor goes when the build is pasted from beside the map (besideMapBox). */
  anchor: ExportBundle["pasteAnchor"];
}): ExportBundle {
  const { set, rs, opts, chunks, diagnostics, withMarkers, layout, anchor } = b;
  const { levels, levelPlacement, gmin } = b.laid;
  // paste order per level = position of the first chunk that contains it
  for (const lp of levelPlacement) {
    const k = chunks.findIndex((c) => c.levelIds.includes(lp.levelId));
    if (k >= 0) lp.pasteOrder = k + 1;
  }

  const perLevelStats = levels.map((l) => ({
    levelId: l.levelId,
    assets: l.placements.length,
    chunks: chunks.filter((c) => c.levelIds.includes(l.levelId)).length,
  }));
  const dropped = set.diagnostics
    .filter(
      (d) =>
        d.code === "role_missing" ||
        d.code === "asset_unknown" ||
        d.code === "custom_unresolved" ||
        d.code === "thick_wall_conflict",
    )
    .reduce((s, d) => s + (d.count ?? 1), 0);
  // TaleSpire water is a board-wide plane the slab cannot carry: tell the GM where to set it (above the slab base)
  const waterLevels = (rs.levelInfo ?? [])
    .filter((l) => l.waterLevel !== undefined)
    .map((l) => {
      const rel = (v: number): number => Math.round((v - gmin.y) * 4) / 4;
      const [lo, hi] = l.waterRange ?? [l.waterLevel ?? 0, l.waterLevel ?? 0];
      return { levelId: l.levelId, aboveBase: rel(l.waterLevel ?? 0), min: rel(lo), max: rel(hi) };
    });
  for (const w of waterLevels)
    diagnostics.push({
      severity: "info",
      code: "verify_water_level",
      stage: "verify",
      levelId: w.levelId,
      message: `Level ${w.levelId} has water. TaleSpire keeps water as one board-wide water plane that a slab cannot carry: after pasting, set the water level to about ${w.aboveBase} tiles (${w.aboveBase * 5} ft) above the bottom of the pasted slab — anywhere between ${w.min} and ${w.max} fills the channels without flooding the banks: raise the water until it just covers the stream bed and stop while it is still below the banks. If you paste the slab with its bottom on the board's ground (0), that is ${w.aboveBase} tiles above the board's zero. Raising the water also surrounds the whole map with water.`,
      hint: "Use TaleSpire's water tool. The channels are built with their bed, so they also look right without water.",
    });
  const waterNote = waterLevels.length
    ? "\n\n" +
      waterLevels
        .map(
          (w) =>
            `Water (level ${w.levelId}): set TaleSpire's water level to about ${w.aboveBase} tiles (${w.aboveBase * 5} ft) above the bottom of the slab, anywhere between ${w.min} and ${w.max} (raise it until it just covers the stream bed, and stop below the banks); pasted with its bottom at the board's ground that is ${w.aboveBase} above the board's zero. The water plane covers the whole board, so the map will be surrounded by water.`,
        )
        .join("\n")
    : "";
  return {
    planId: set.planId,
    planVersion: set.planVersion,
    resolvedHash: opts.resolvedHash ?? rs.resolvedHash ?? "",
    createdAt: opts.createdAt ?? new Date().toISOString(),
    chunks,
    diagnostics,
    stats: {
      totalAssets: chunks.reduce((s, c) => s + c.assetCount, 0),
      totalChunks: chunks.length,
      perLevel: perLevelStats,
      droppedPlacements: dropped,
    },
    instructions: pasteInstructions(chunks, withMarkers, layout, anchor) + waterNote,
    ...(waterLevels.length ? { waterLevels } : {}),
    assetSource: rs.assetSource ?? "builtin",
    substitutions: (rs.substitutions ?? []).map((s) => ({
      role: s.role,
      wanted: s.wanted,
      used: s.used,
      count: s.count,
    })),
    levelPlacement,
    ...(anchor ? { pasteAnchor: anchor } : {}),
  };
}

/** Level layout transform, items with world boxes, global bounds and the coordinate-range check. Shared by
 * chunkAndEncode and estimate, so the estimate is never more optimistic than compile about coord_overflow. */
function layoutBuild(
  set: PlacementSet,
  opts: Pick<ChunkEncodeOptions, "levels" | "levelLayout" | "sideBySideGap">,
  codec: Pick<SlabCodec, "limits">,
): {
  levels: PlacementSet["levels"];
  levelPlacement: ExportBundle["levelPlacement"];
  perLevelRaw: Array<{ levelId: LevelId; items: Item[] }>;
  gmin: { x: number; y: number; z: number };
  gmax: { x: number; y: number; z: number };
  overflow: CompileDiagnostic | null;
} {
  const rs = set as Partial<RealizedSet> & PlacementSet;
  const layout = opts.levelLayout ?? "stacked";
  const gap = opts.sideBySideGap ?? DEFAULT_SIDE_BY_SIDE_GAP;
  const levelsWanted = opts.levels ? new Set(opts.levels) : null;
  const levels = set.levels.filter((l) => !levelsWanted || levelsWanted.has(l.levelId));
  const elevOf = new Map((rs.levelInfo ?? []).map((l) => [l.levelId, l.elevation]));
  const minElev = Math.min(minOf(levels.map((l) => elevOf.get(l.levelId) ?? 0)), Infinity);
  const shift = new Map<LevelId, { dx: number; dy: number }>();
  const levelPlacement: ExportBundle["levelPlacement"] = [];
  let cursorX = 0;
  levels.forEach((l, i) => {
    const elev = elevOf.get(l.levelId) ?? 0;
    if (layout === "side_by_side") {
      const b = emptyBox();
      for (const p of l.placements) growBox(b, placedBox(set, p));
      const minX = Number.isFinite(b.min.x) ? Math.floor(b.min.x) : 0;
      const width = Number.isFinite(b.max.x) ? Math.ceil(b.max.x) - minX : 0;
      const dx = i === 0 ? 0 : cursorX - minX;
      shift.set(l.levelId, { dx, dy: -(elev - minElev) });
      levelPlacement.push({ levelId: l.levelId, pasteOrder: i + 1, kind: "side-by-side", offsetSq: dx });
      cursorX = minX + dx + width + gap;
    } else {
      shift.set(l.levelId, { dx: 0, dy: 0 });
      const storeys = Math.round(((elev - (Number.isFinite(minElev) ? minElev : 0)) / STOREY) * 100) / 100;
      levelPlacement.push(
        storeys === 0
          ? { levelId: l.levelId, pasteOrder: i + 1, kind: "ground" }
          : { levelId: l.levelId, pasteOrder: i + 1, kind: "storeys-up", storeys },
      );
    }
  });

  // ── items with world boxes and source cells ──
  const perLevelRaw = levels.map((l) => {
    const s = shift.get(l.levelId) ?? { dx: 0, dy: 0 };
    const items: Item[] = l.placements.map((p0) => {
      const p = s.dx || s.dy ? { ...p0, x: p0.x + s.dx, y: p0.y + s.dy } : p0;
      const b0 = placedBox(set, p0);
      const box = {
        min: { x: b0.min.x + s.dx, y: b0.min.y + s.dy, z: b0.min.z },
        max: { x: b0.max.x + s.dx, y: b0.max.y + s.dy, z: b0.max.z },
      };
      const cell = p0.source.cell ?? [Math.floor(p0.x), Math.floor(-p0.z)];
      return { p, box, cx: cell[0], cy: cell[1], levelId: l.levelId };
    });
    return { levelId: l.levelId, items };
  });

  // ── global bounds ──
  const g = emptyBox();
  for (const l of perLevelRaw)
    for (const it of l.items) {
      growBox(g, it.box);
      growBox(g, { min: { x: it.p.x, y: it.p.y, z: it.p.z }, max: { x: it.p.x, y: it.p.y, z: it.p.z } });
    }
  const empty = !Number.isFinite(g.min.x);
  const gmin = empty
    ? { x: 0, y: 0, z: 0 }
    : { x: Math.floor(g.min.x + 1e-9), y: floor4(g.min.y), z: Math.floor(g.min.z + 1e-9) };
  const gmax = empty
    ? { x: 0, y: 0, z: 0 }
    : { x: Math.ceil(g.max.x - 1e-9), y: Math.ceil(g.max.y * 4 - 1e-9) / 4, z: Math.ceil(g.max.z - 1e-9) };

  const mg = 1 + MARKER_GAP_CELLS;
  // a build pasted from beside the map may stretch its box south to about twice the map depth (besideMapBox); the
  // check takes that box whenever the generator may use it, so the estimate never promises what compile refuses
  const box = besideMap(set)
    ? besideMapBox(gmin, gmax)
    : { min: { x: gmin.x - mg, z: gmin.z - mg }, max: { x: gmax.x + mg, z: gmax.z + mg } };
  const extent = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, gmax.y - gmin.y + 3);
  const overflow: CompileDiagnostic | null =
    extent * 100 > codec.limits.maxCoord
      ? {
          severity: "error",
          code: "coord_overflow",
          stage: "chunk",
          message: `The build spans ${extent} tiles; the slab format allows ${Math.floor(codec.limits.maxCoord / 100)}`,
          hint: `Move the levels (bounds) closer together: everything, stacked or side by side, must fit within ${Math.floor(codec.limits.maxCoord / 100) - 4} tiles in each direction.`,
        }
      : null;
  return { levels, levelPlacement, perLevelRaw, gmin, gmax, overflow };
}

/** The coord_overflow error compile would report for this placement set (null when the build fits). */
export function extentDiagnostic(
  set: PlacementSet,
  codec: Pick<SlabCodec, "limits">,
  opts: Pick<ChunkEncodeOptions, "levels" | "levelLayout" | "sideBySideGap"> = {},
): CompileDiagnostic | null {
  return layoutBuild(set, opts, codec).overflow;
}

const round4 = (v: number): number => Math.round(v * 10000) / 10000 || 0;

function positionLabel(col: number, cols: number, row: number, rows: number): string {
  const h =
    cols === 1
      ? ""
      : cols === 2
        ? (["West", "East"][col] ?? "")
        : cols === 3
          ? (["West", "Centre", "East"][col] ?? "")
          : `Column ${col + 1}`;
  const v =
    rows === 1
      ? ""
      : rows === 2
        ? (["North", "South"][row] ?? "")
        : rows === 3
          ? (["North", "Middle", "South"][row] ?? "")
          : `Row ${row + 1}`;
  if (h && v) return /^(Column|Row)/.test(h) || /^(Column|Row)/.test(v) ? `${v}, ${h}` : `${v}-${h}`;
  return h || v || "Whole level";
}

export function pasteInstructions(
  chunks: SlabChunk[],
  markers: boolean,
  layout: "stacked" | "side_by_side",
  /** Where the cursor goes when the build is pasted from beside the map. */
  anchor?: ExportBundle["pasteAnchor"],
): string {
  if (chunks.length === 0) return "Nothing to paste.";
  if (chunks.length === 1) {
    return [
      "1. Open TaleSpire in build mode on an empty board (or raise a build plane with G).",
      "2. Copy the slab, press Ctrl+V, and left-click (hold briefly) to place it.",
    ].join("\n");
  }
  const lines = [
    `This build has ${chunks.length} chunks${layout === "stacked" ? ", stacked at their real heights" : ", with levels laid side by side"}.`,
    "",
    "1. Use an empty board, or raise a build plane (G) at a known height.",
    "2. Do not move the camera between chunks.",
    anchor
      ? `3. Keep the cursor on one bare cell ${anchor.clearanceCells + 1} cells ${anchor.side} of the middle of the map’s ${anchor.side} edge (${anchor.clearanceCells} empty cells between it and the map): that cell is the middle of every chunk. Each chunk carries the same two alignment pillars, one clear cell beyond the north-east corner (raised to the top) and one at ground level ${anchor.farMarkerCells} cells ${anchor.side} of the map, one cell beyond its west edge. Place every chunk so its pillars land exactly on the pillars already placed.`
      : markers
        ? "3. Each chunk carries the same two alignment pillars, one clear cell outside the south-west corner (at ground level) and the north-east corner (raised to the top). Place every chunk so its south-west pillar lands exactly on the pillar already placed."
        : "3. Paste every chunk with the cursor on the same cell.",
    "4. Right-click between chunks to drop the slab in hand.",
    markers ? "5. When all chunks are placed, delete the two alignment pillars." : "",
    "",
    "Paste order:",
    ...chunks.map((c, i) => {
      const lv = c.levelIds;
      return `${i + 1}. ${c.id} (${c.label}; ${lv.length > 1 ? "levels" : "level"} ${lv.join(", ")}; ${c.assetCount} assets)`;
    }),
  ];
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

function emptyBundle(
  set: PlacementSet,
  rs: Partial<RealizedSet>,
  opts: ChunkEncodeOptions,
  diagnostics: CompileDiagnostic[],
  levelPlacement: ExportBundle["levelPlacement"],
): ExportBundle {
  return {
    planId: set.planId,
    planVersion: set.planVersion,
    resolvedHash: opts.resolvedHash ?? rs.resolvedHash ?? "",
    createdAt: opts.createdAt ?? new Date().toISOString(),
    chunks: [],
    diagnostics,
    stats: {
      totalAssets: 0,
      totalChunks: 0,
      perLevel: set.levels.map((l) => ({ levelId: l.levelId, assets: l.placements.length, chunks: 0 })),
      droppedPlacements: 0,
    },
    instructions: "Build refused: see diagnostics.",
    assetSource: rs.assetSource ?? "builtin",
    substitutions: rs.substitutions ?? [],
    levelPlacement,
  };
}
