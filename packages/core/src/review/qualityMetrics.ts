/**
 * The quality meter's metrics, each defined once (generator 5, WP1 of the arrangement plan): what it measures, its unit
 * and tier, the range skilled builds fall in, where that range comes from and how much to trust it, and whether it is
 * meant to become a hard rule. The slab tier is computed in review/qualitySlab.ts (placed pieces only, so it runs on any
 * decoded slab); the map tier in review/qualityMap.ts (it needs the resolved map). The CLI's `quality` command prints
 * this table beside a build's values, and the generator-5 golden keeps a baseline of them per fixture plan
 * (test/golden/generator5/__golden__/generator5.quality.txt), so a later change shows its effect as a diff.
 *
 * Targets. Slab-tier ranges were measured with this meter on the community training slabs (the decoded sets outside the
 * repo; only aggregate ranges come here): the range of the seven hand-built buildings, rounded outward, which is what
 * our maps are closest to (the vessels, 14 of 24 sets, run denser and more symmetric). A one-sided metric keeps only the
 * side that matters. Map-tier ranges come from the analysts' technique catalogue (the build plan §3.1); they cannot be
 * measured on a slab with no plan.
 *
 * Nothing here fails a build. `hard` marks the plan's hard rules: they are checked on the output of the recipe that
 * claims them (test/fixtures/quality.ts helpers, called by the packages that build those recipes), never on whole
 * builds while the techniques that satisfy them are unbuilt.
 */

/** Where a metric is computed from: placed pieces alone, or the resolved map with its build. */
export type MetricTier = "slab" | "map";

/** How a metric is read: a share (0..1), a count, or a ratio. */
export type MetricUnit = "share" | "count" | "ratio" | "per tile";

export interface QualityMetric {
  readonly id: string;
  /** Short label for the table. */
  readonly label: string;
  /** What is measured, exactly (the code follows this sentence). */
  readonly definition: string;
  readonly unit: MetricUnit;
  readonly tier: MetricTier;
  /** The range skilled builds fall in; null = reported only (size-dependent, or no trustworthy target). */
  readonly target: { readonly min?: number; readonly max?: number } | null;
  /** Where the target comes from. */
  readonly source: string;
  readonly confidence: "high" | "medium" | "low";
  /** Meant to become a hard rule for the recipe output that claims it (never for whole builds yet). */
  readonly hard: boolean;
}

/** Source line of a slab-tier target measured on the seven hand-built buildings. */
const HB = (range: string, grid?: string): string =>
  `training: hand-built buildings ${range} (7 sets)${grid ? `; grid-built ${grid}` : ""}`;

/** Every metric of the meter, in report order (slab tier first). */
export const QUALITY_METRICS = [
  {
    id: "pieces",
    label: "pieces",
    definition: "placements (markers excluded)",
    unit: "count",
    tier: "slab",
    target: null,
    source: "size, reported only",
    confidence: "high",
    hard: false,
  },
  {
    id: "prop_share",
    label: "prop share",
    definition: "props (non-tile pieces) / all pieces",
    unit: "share",
    tier: "slab",
    target: { min: 0.22, max: 0.57 },
    source: HB("0.23–0.56", "0.07"),
    confidence: "high",
    hard: false,
  },
  {
    id: "overlap_share",
    label: "overlap share",
    definition: "pieces whose box interpenetrates another's by more than 0.02 on every axis / all pieces",
    unit: "share",
    tier: "slab",
    target: { min: 0.49 },
    source: HB("0.49–0.91", "0.15"),
    confidence: "high",
    hard: false,
  },
  {
    id: "pieces_per_tile",
    label: "pieces per tile",
    definition:
      "pieces / occupied 1 × 1 columns (a column is occupied when a footprint reaches 0.02 into it)",
    unit: "ratio",
    tier: "slab",
    target: { min: 1.3, max: 6.4 },
    source: HB("1.39–6.30", "4.6"),
    confidence: "medium",
    hard: false,
  },
  {
    id: "pieces_per_column",
    label: "pieces per column",
    definition:
      "mean number of footprints covering an occupied 1 × 1 column (a big piece counts in every column)",
    unit: "ratio",
    tier: "slab",
    target: { min: 3.7, max: 13.1 },
    source: HB("3.78–13.03", "5.9"),
    confidence: "medium",
    hard: false,
  },
  {
    id: "prop_off_axis",
    label: "props off-axis",
    definition: "props whose yaw is not a quarter turn / props",
    unit: "share",
    tier: "slab",
    target: { min: 0.01, max: 0.43 },
    source: HB("0.02–0.42"),
    confidence: "high",
    hard: false,
  },
  {
    id: "structure_off_axis",
    label: "tiles off-axis",
    definition: "tiles whose yaw is not a quarter turn / tiles",
    unit: "share",
    tier: "slab",
    target: { max: 0 },
    source: "training: every set 0 (24 sets)",
    confidence: "high",
    hard: true,
  },
  {
    id: "prop_off_height_grid",
    label: "props off 0.25 grid",
    definition:
      "props whose stored height is more than 0.01 off the slab's own 0.25 grid (phase: the tiles' most common one) / props",
    unit: "share",
    tier: "slab",
    target: { min: 0.61, max: 0.89 },
    source: HB("0.62–0.89", "0.69 of its few props"),
    confidence: "high",
    hard: false,
  },
  {
    id: "prop_rest_contact",
    label: "props resting",
    definition:
      "props whose base lies within 0.05 of the top of (or inside) a piece under their centre, or on the build's lowest level / props",
    unit: "share",
    tier: "slab",
    target: { min: 0.82 },
    source: `${HB("0.82–0.97", "0.56")}; recipe output ≥ 0.95 (plan §3.1)`,
    confidence: "medium",
    hard: true,
  },
  {
    id: "prop_on_prop",
    label: "props on props",
    definition: "props whose highest support (as for resting) is another prop, not a tile / props",
    unit: "share",
    tier: "slab",
    target: { min: 0.4 },
    source: HB("0.40–0.72", "0.06"),
    confidence: "medium",
    hard: false,
  },
  {
    id: "symmetry_structure",
    label: "structure mirrored",
    definition:
      "best over both plan axes and every plane (0.25 buckets): tiles with a same-asset partner mirrored within 0.15 / tiles",
    unit: "share",
    tier: "slab",
    target: { min: 0.37 },
    source: `${HB("0.38–0.63", "0.90")}; plan said ≥ 0.5`,
    confidence: "medium",
    hard: false,
  },
  {
    id: "symmetry_dressing",
    label: "dressing mirrored",
    definition:
      "as structure mirrored, over loose dressing (our role feature; a class reading on a decoded slab)",
    unit: "share",
    tier: "slab",
    target: { max: 0.48 },
    source: `${HB("0.15–0.48", "0.30")}; plan said ≤ 0.4`,
    confidence: "medium",
    hard: false,
  },
  {
    id: "distinct_assets",
    label: "distinct assets",
    definition: "different asset ids",
    unit: "count",
    tier: "slab",
    target: null,
    source: `size-dependent, reported only (${HB("54–233")})`,
    confidence: "medium",
    hard: false,
  },
  {
    id: "top_asset_share",
    label: "top asset share",
    definition: "pieces of the most used asset / all pieces",
    unit: "share",
    tier: "slab",
    target: { max: 0.28 },
    source: HB("0.06–0.28", "0.60"),
    confidence: "high",
    hard: false,
  },
  {
    id: "largest_kit_share",
    label: "largest kit share",
    definition: "pieces of the most used kit (pack folder) / all pieces; only when every piece names its kit",
    unit: "share",
    tier: "slab",
    target: { max: 0.32 },
    source: `${HB("0.13–0.31", "0.93")}; our palettes carry no kit, so builds report none`,
    confidence: "medium",
    hard: false,
  },
  {
    id: "coplanar_share",
    label: "coplanar flat tops",
    definition:
      "flat pieces (box height ≤ 0.5) whose top lies within 0.02 of an overlapping (≥ 0.05 tile²) flat top / flat pieces",
    unit: "share",
    tier: "slab",
    target: null,
    source: `${HB("0.07–0.53")}: collider tops are not mesh faces, so no whole-build target; recipe output 0 (plan §3.1, flicker)`,
    confidence: "low",
    hard: true,
  },
  {
    id: "stamped_groups",
    label: "stamped groups",
    definition:
      "groups of ≥ 4 identical dressing pieces linked within 1.5 (height within 0.5), all at one heading",
    unit: "count",
    tier: "slab",
    target: { max: 7 },
    source: `${HB("0–7")}; recipe output 0 (plan §3.1)`,
    confidence: "medium",
    hard: true,
  },
  {
    id: "exact_duplicates",
    label: "exact duplicates",
    definition: "pieces of one asset at one place (within 0.005) and yaw as another",
    unit: "count",
    tier: "slab",
    target: { max: 0 },
    source: HB("0"),
    confidence: "high",
    hard: true,
  },
  {
    id: "props_near_wall",
    label: "loose props by walls",
    definition:
      "loose features (not wall- or ceiling-mounted, natural, band rock, road, small thing or landmark) in rooms and corridors with a footprint cell within one tile of a wall or of a cell that is not open / those features",
    unit: "share",
    tier: "map",
    target: { min: 0.75 },
    source: "plan §3.1 (4 batches; the interiors review uses 0.6 for furniture)",
    confidence: "high",
    hard: false,
  },
  {
    id: "lane_blocked",
    label: "lane blocked",
    definition:
      "lane cells covered by a blocking feature / lane cells; a room's lane is one shortest path (kept nearest the straight line) between each pair of its walkable openings",
    unit: "share",
    tier: "map",
    target: { max: 0.1 },
    source: "plan §3.1 and §3.2 lane_blocked",
    confidence: "medium",
    hard: true,
  },
  {
    id: "focal_contrast",
    label: "focal : calm detail",
    definition:
      "over 3 × 3-cell blocks with ≥ 3 walkable cells: the densest block's loose pieces (role feature) per walkable cell / the median block's (taken as at least one piece per block)",
    unit: "ratio",
    tier: "map",
    target: { min: 3 },
    source: "plan §3.1 (focal : calm 2–8 ×, 4 batches)",
    confidence: "medium",
    hard: false,
  },
  {
    id: "lights_per_floor_tile",
    label: "lights per floor tile",
    definition: "light features in rooms and corridors / their walkable cells",
    unit: "per tile",
    tier: "map",
    target: { min: 0.05, max: 0.38 },
    source: "plan §3.1 (0.05–0.38, ≈ 0.16; 5 batches)",
    confidence: "medium",
    hard: false,
  },
  {
    id: "doors_lit",
    label: "outside doors lit",
    definition:
      "walkable ground openings of intact buildings with a building door light or a light feature within one cell of a door cell / those openings",
    unit: "share",
    tier: "map",
    target: { min: 0.8 },
    source: "plan §3.1 (one light each side of an external door)",
    confidence: "medium",
    hard: false,
  },
  {
    id: "band_coverage",
    label: "band course coverage",
    definition:
      "perimeter edges of the upper floor lines of buildings of ≥ 2 storeys where a flat piece (≤ 0.6 high) of the building spans the floor line and stands proud of the face / those edges",
    unit: "share",
    tier: "map",
    target: { min: 0.8 },
    source: "plan §3.1 (band at every floor line; 3 batches)",
    confidence: "medium",
    hard: true,
  },
] as const satisfies readonly QualityMetric[];

export type QualityMetricId = (typeof QUALITY_METRICS)[number]["id"];

/** A metric by id. */
export function qualityMetric(id: QualityMetricId): QualityMetric {
  return QUALITY_METRICS.find((x) => x.id === id) as QualityMetric;
}

/** Is a value inside its metric's target (true when the metric has none or there is nothing to measure)? */
export function withinTarget(id: QualityMetricId, value: number | null): boolean {
  const t = qualityMetric(id).target;
  if (t === null || value === null) return true;
  return (t.min === undefined || value >= t.min) && (t.max === undefined || value <= t.max);
}

/** The target as text: "≥ 0.49", "≤ 0.1", "0.05–0.38", or "–". */
export function targetText(id: QualityMetricId): string {
  const t = qualityMetric(id).target;
  if (t === null) return "–";
  if (t.min !== undefined && t.max !== undefined) return t.min === t.max ? `${t.min}` : `${t.min}–${t.max}`;
  if (t.min !== undefined) return `≥ ${t.min}`;
  return `≤ ${String(t.max)}`;
}
