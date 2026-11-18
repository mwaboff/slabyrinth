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
 */
import type {
  Box3,
  ChunkOptions,
  CompileDiagnostic,
  ExportBundle,
  Placement,
  PlacementSet,
  SlabAsset,
  SlabChunk,
  SlabCodec,
} from "../contracts/compiler";
import type { LevelId } from "../contracts/plan";
import { sha256Hex } from "../slab/sha256";
import { emptyBox, finiteBox, growBox } from "./geometry";
import { placementBoxes, type RealizedSet } from "./realize";

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
  const { levels, levelPlacement, perLevelRaw, gmin, gmax, overflow } = layoutBuild(set, opts, codec);
  if (overflow) {
    diagnostics.push(overflow);
    return emptyBundle(set, rs, opts, diagnostics, levelPlacement);
  }
  const grouping: "fewest" | "per-level" = opts.grouping ?? "fewest";
  // Markers sit diagonally outside the corner cells with MARKER_GAP_CELLS empty cells in between: the min marker at
  // ground level (min y), the max marker raised to the top of the build (max y).
  const mg = 1 + MARKER_GAP_CELLS;
  const markersFor = (on: boolean): Array<{ uuid: string; x: number; y: number; z: number }> =>
    on && markerAsset
      ? [
          { uuid: markerAsset.uuid, x: gmin.x - mg, y: gmin.y, z: gmin.z - mg },
          { uuid: markerAsset.uuid, x: gmax.x + mg - 1, y: gmax.y, z: gmax.z + mg - 1 },
        ]
      : [];
  const offsetFor = (on: boolean): { x: number; y: number; z: number } =>
    on && markerAsset ? { x: gmin.x - mg, y: gmin.y, z: gmin.z - mg } : gmin;
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

  interface Region {
    levelId: LevelId;
    levelIds: LevelId[];
    items: Item[];
    rect: { x: number; y: number; w: number; h: number };
    enc: { slab: string; rawBytes: number; compressedBytes: number };
    assets: SlabAsset[];
  }

  const levelOrder = new Map(levels.map((l, i) => [l.levelId, i]));
  const levelsOf = (items: Item[]): LevelId[] =>
    [...new Set(items.map((i) => i.levelId))].sort(
      (a, b) => (levelOrder.get(a) ?? 0) - (levelOrder.get(b) ?? 0),
    );

  /** Groups of items to cut into regions: whole levels packed in order into as few groups as fit (or one per level). */
  const groupsFor = (withMarkers: boolean): Array<{ levelId: LevelId; items: Item[] }> => {
    const nonEmpty = perLevelRaw.filter((l) => l.items.length > 0);
    if (grouping === "per-level") return nonEmpty;
    const markers = markersFor(withMarkers);
    const off = offsetFor(withMarkers);
    const fits = (items: Item[]): boolean =>
      codec.encode(toAssets(items, markers, off)).compressedBytes <= budget;
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
  ): { regions: Region[]; oversize: CompileDiagnostic[]; splits: number } => {
    const markers = markersFor(withMarkers);
    const off = offsetFor(withMarkers);
    const regions: Region[] = [];
    const oversize: CompileDiagnostic[] = [];
    let splits = 0;
    const rectOf = (items: Item[]): Region["rect"] => {
      const xs = items.map((i) => i.cx);
      const ys = items.map((i) => i.cy);
      const x = Math.min(...xs),
        y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x + 1, h: Math.max(...ys) - y + 1 };
    };
    const rec = (levelId: LevelId, items: Item[]): void => {
      if (items.length === 0) return;
      const rect = rectOf(items);
      const assets = toAssets(items, markers, off);
      const enc = codec.encode(assets);
      if (enc.compressedBytes <= budget) {
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
      if (enc.compressedBytes > codec.limits.maxCompressedBytes) {
        oversize.push({
          severity: "error",
          code: "chunk_oversize",
          stage: "chunk",
          levelId,
          cell: [rect.x, rect.y],
          message: `A single cell holds ${enc.compressedBytes} bytes of slab data (limit ${codec.limits.maxCompressedBytes})`,
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
    for (const g of groupsFor(withMarkers)) rec(g.levelId, g.items);
    return { regions, oversize, splits };
  };

  let pass = split(alignment === "always");
  let withMarkers = alignment === "always";
  if (alignment === "multi-chunk" && pass.regions.length > 1) {
    pass = split(true);
    withMarkers = true;
  }
  if (withMarkers && !markerAsset) {
    diagnostics.push({
      severity: "warning",
      code: "role_missing",
      stage: "chunk",
      role: "marker.alignment",
      message: "No marker.alignment asset in the palettes; chunks carry no alignment markers",
    });
    withMarkers = false;
  }
  diagnostics.push(...pass.oversize);
  if (pass.splits > 0) {
    diagnostics.push({
      severity: "info",
      code: "chunk_split",
      stage: "chunk",
      message: `Split into ${pass.regions.length} chunks to stay under ${budget} bytes each`,
      count: pass.splits,
    });
  }

  // ── order: by first level, then row-major by region rect ──
  const regions = [...pass.regions].sort(
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
    const minCellX = Math.min(...mine.map((r) => r.rect.x));
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
    instructions: pasteInstructions(chunks, withMarkers, layout),
    assetSource: rs.assetSource ?? "builtin",
    substitutions: (rs.substitutions ?? []).map((s) => ({
      role: s.role,
      wanted: s.wanted,
      used: s.used,
      count: s.count,
    })),
    levelPlacement,
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
  const minElev = Math.min(...levels.map((l) => elevOf.get(l.levelId) ?? 0), Infinity);
  const shift = new Map<LevelId, { dx: number; dy: number }>();
  const levelPlacement: ExportBundle["levelPlacement"] = [];
  let cursorX = 0;
  levels.forEach((l, i) => {
    const elev = elevOf.get(l.levelId) ?? 0;
    if (layout === "side_by_side") {
      const b = emptyBox();
      for (const p of l.placements) growBox(b, boxOf(p));
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
      const b0 = boxOf(p0);
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
  const extent = Math.max(gmax.x - gmin.x + 2 * mg, gmax.z - gmin.z + 2 * mg, gmax.y - gmin.y + 3);
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

function boxOf(p: Placement): Box3 {
  return placementBoxes.get(p) ?? { min: { x: p.x, y: p.y, z: p.z }, max: { x: p.x, y: p.y, z: p.z } };
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
    markers
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
