/**
 * Data-driven asset classification: lets the app use assets that arrive with a game update without a
 * code or palette change.
 *
 * - `sizeClass` / `footprintOf` measure an asset from catalog geometry (never hand-entered numbers).
 * - `ROLE_RULES` is DATA: per palette role, the keywords (name, tags, kit folder) and size classes that make an
 *   asset a member. Adding a rule is the only change needed for a new kind of asset.
 * - `classifyAsset` scores an asset against the rules, with the reasons, so a match is explainable.
 * - `autoVariantsFor` turns confidently classified, UNCURATED catalog assets into low-weight extra palette
 *   variants. Curated palette entries stay authoritative: auto variants never replace a role, never add a role a
 *   theme does not already have, never exceed the feature's footprint, and carry `source: "auto"` in their name.
 * - `searchCatalog` is the trustworthy search the model and the `custom` feature use: by keyword, role and size
 *   class; every result says what it is (size class, footprint in cells, matched words) and weak matches are
 *   dropped instead of silently returned.
 *
 * The catalog itself stays a runtime input (the user's install); nothing here bundles it.
 */
import type { CatalogAsset, PaletteVariant } from "../contracts/compiler";
import { geomOf } from "./derive";

export type SizeClass = "ground" | "low" | "medium" | "tall" | "huge";

/** Height class from the collider height, bumped to huge for very wide pieces. */
export function sizeClass(a: Pick<CatalogAsset, "size">): SizeClass {
  const h = a.size.y;
  const span = Math.max(a.size.x, a.size.z);
  if (h >= 3.5 || span >= 3.5) return "huge";
  if (h >= 1.9) return "tall";
  if (h >= 0.9) return "medium";
  if (h >= 0.35) return "low";
  return "ground";
}

/** Footprint in cells at rot 0 (tiles round up, props round to nearest; at least 1). */
export function footprintOf(a: Pick<CatalogAsset, "size" | "originAt">): [number, number] {
  if (a.originAt === "minCorner")
    return [Math.max(1, Math.ceil(a.size.x - 0.01)), Math.max(1, Math.ceil(a.size.z - 0.01))];
  return [Math.max(1, Math.round(a.size.x)), Math.max(1, Math.round(a.size.z))];
}

export interface RoleRule {
  role: string;
  /** At least one must appear in the name (or tags when `tagsCount`). */
  any: readonly string[];
  /** None of these may appear in name, tags or folder. */
  none?: readonly string[];
  kind?: "prop" | "tile";
  sizes?: readonly SizeClass[];
  /** Largest footprint allowed (cells, either axis). */
  maxCells?: number;
  /** Tag matches count as name matches (for families whose names are generic, e.g. "Tree 01"). */
  tagsCount?: boolean;
}

const NOT_DECOR = [
  "scifi",
  "cyber",
  "space",
  "modern",
  "office",
  "neon",
  "christmas",
  "festive",
  "car",
  "truck",
];

/**
 * Role membership rules. Feature roles only: floors, walls, doors and stairs stay curated (tone, tiling and
 * facing need a human check). Slot roles (feature.cluster_tall, …) are what theme-neutral set pieces place.
 */
export const ROLE_RULES: readonly RoleRule[] = [
  { role: "feature.stalagmite", any: ["stalagmite"], kind: "prop", sizes: ["medium", "tall"], maxCells: 1 },
  {
    role: "feature.cave_column",
    any: ["stalagmite column", "column"],
    none: ["castle", "marble", "palace", "icicle"],
    kind: "prop",
    sizes: ["tall", "huge"],
    maxCells: 1,
  },
  {
    role: "feature.crystal",
    any: ["crystal"],
    none: ["scroll", "chest", "owl", "painting", "ceiling"],
    kind: "prop",
    maxCells: 1,
  },
  {
    role: "feature.mushroom",
    any: ["mushroom", "shroom", "fungus"],
    none: ["soup", "tree w"],
    kind: "prop",
    sizes: ["ground", "low"],
    maxCells: 1,
  },
  {
    role: "feature.giant_mushroom",
    any: ["shroom", "fungus", "mushroom"],
    none: ["soup", "tree w", "top"],
    kind: "prop",
    sizes: ["medium", "tall"],
    maxCells: 1,
  },
  { role: "feature.bush", any: ["bush", "shrub"], none: ["dead"], kind: "prop", maxCells: 2 },
  {
    role: "feature.tall_grass",
    any: ["fern", "grass"],
    none: ["floor", "aberration", "bucket"],
    kind: "prop",
    sizes: ["ground", "low"],
    maxCells: 1,
  },
  {
    role: "feature.flowers",
    any: ["flower", "lily", "blossom"],
    none: ["pad"],
    kind: "prop",
    sizes: ["ground", "low"],
    maxCells: 2,
  },
  {
    role: "feature.pine_tree",
    any: ["pine", "cypress", "fir"],
    none: ["stump", "chopped", "middle"],
    kind: "prop",
    sizes: ["tall", "huge"],
  },
  {
    role: "feature.tree",
    any: ["tree"],
    none: [
      "dead",
      "stump",
      "festive",
      "christmas",
      "bonsai",
      "mid",
      "top",
      "base",
      "pegs",
      "chopped",
      "arch",
      "palm",
      "hell",
      "jungle",
    ],
    kind: "prop",
    sizes: ["tall", "huge"],
  },
  {
    role: "feature.boulder",
    any: ["boulder", "cliff"],
    none: ["snow", "desert", "rock_large", "rock large"],
    kind: "prop",
    sizes: ["medium", "tall"],
    maxCells: 2,
  },
  {
    role: "feature.rock",
    any: ["rock", "pebble", "stone"],
    none: ["wall", "floor", "lantern", "throne", "dragon", "large", "castle", "palace"],
    kind: "prop",
    sizes: ["ground", "low"],
    maxCells: 1,
  },
  {
    role: "feature.bones",
    any: ["bone", "skeleton"],
    none: ["dragon"],
    kind: "prop",
    sizes: ["ground", "low"],
    maxCells: 1,
  },
  {
    role: "feature.skull_pile",
    any: ["skull"],
    none: ["chest", "spine", "chain", "metal", "spike"],
    kind: "prop",
    maxCells: 1,
  },
  {
    role: "feature.rubble",
    any: ["rubble", "rockpile", "debris"],
    none: ["concrete", "palisade"],
    kind: "prop",
    sizes: ["ground", "low"],
    maxCells: 1,
  },
  {
    role: "feature.root",
    any: ["root"],
    none: ["wall"],
    kind: "prop",
    sizes: ["ground", "low", "medium"],
    maxCells: 1,
  },
  { role: "feature.vines", any: ["vine", "ivy"], kind: "prop" },
  { role: "feature.statue_large", any: ["statue"], kind: "prop", sizes: ["tall", "huge"], maxCells: 2 },
  {
    role: "feature.torch_floor",
    any: ["torch"],
    none: ["wall"],
    kind: "prop",
    sizes: ["medium", "tall"],
    maxCells: 1,
  },
  {
    role: "feature.lantern",
    any: ["lantern", "lamp"],
    none: ["wall", "hook", "carry", "genie", "jack", "palace"],
    kind: "prop",
    sizes: ["medium", "tall"],
    maxCells: 1,
  },
  // theme-neutral slots
  {
    role: "feature.cluster_tall",
    any: ["pine", "cypress", "stalagmite column", "column"],
    none: ["stump", "chopped", "middle", "castle", "palace", "icicle"],
    kind: "prop",
    sizes: ["tall", "huge"],
    maxCells: 1,
  },
  {
    role: "feature.undergrowth",
    any: ["bush", "shrub", "fern", "mushroom patch"],
    none: ["dead"],
    kind: "prop",
    sizes: ["low", "medium"],
    maxCells: 1,
  },
  {
    role: "feature.ground_cover",
    any: ["fern", "flower", "pebble", "moss", "clover", "grass"],
    none: ["floor", "bucket", "aberration"],
    kind: "prop",
    sizes: ["ground", "low"],
    maxCells: 1,
  },
  {
    role: "feature.formation",
    any: ["boulder", "cliff", "formation", "flowstone"],
    none: ["snow", "pile", "desert", "rock_large", "rock large"],
    kind: "prop",
    sizes: ["medium", "tall", "huge"],
    maxCells: 2,
  },
  {
    role: "feature.edge_dressing",
    any: ["rock", "boulder", "bush", "pebble"],
    none: ["wall", "floor", "large", "lantern", "dead"],
    kind: "prop",
    sizes: ["low", "medium"],
    maxCells: 1,
  },
  {
    role: "feature.small_detail",
    any: ["pebble", "mushroom single", "skull single", "candle"],
    kind: "prop",
    sizes: ["ground", "low"],
    maxCells: 1,
  },
  {
    role: "feature.tall_marker",
    any: ["pillar", "obelisk", "monolith", "standing", "menhir", "spike"],
    none: ["aberration", "jungle", "wall", "base", "mid", "top"],
    kind: "prop",
    sizes: ["tall"],
    maxCells: 1,
  },
];

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[_\-,()]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);

/** Lower-cased "name tags folder" text, with separators normalised to spaces. */
function textOf(a: CatalogAsset): { name: string; tags: string; all: string } {
  const name = ` ${words(a.name).join(" ")} `;
  const tags = ` ${a.tags.flatMap(words).join(" ")} `;
  const folder = ` ${words(a.folder).join(" ")} `;
  return { name, tags, all: `${name}${tags}${folder}` };
}

/** Whole-word (or word-prefix, for plurals) containment: "root" matches "roots", not "uproot". */
function hasWord(hay: string, needle: string): boolean {
  const n = words(needle).join(" ");
  return hay.includes(` ${n}`) && n.length > 0;
}

/** Whole-word containment for strict search: "lamp" matches "lamp", "lamps", "lamp01"; "car" not "carton". */
function hasWholeWord(hay: string, needle: string): boolean {
  const n = words(needle).join(" ");
  if (n.length === 0) return false;
  const toks = ` ${hay
    .trim()
    .split(" ")
    .map((w) => w.replace(/[0-9]+$/, ""))
    .join(" ")} `;
  return [n, `${n}s`, `${n}es`].some((v) => toks.includes(` ${v} `));
}

export interface Classification {
  role: string;
  score: number;
  reasons: string[];
}

/** Every rule the asset satisfies, best first. Deprecated assets match nothing. */
export function classifyAsset(a: CatalogAsset, rules: readonly RoleRule[] = ROLE_RULES): Classification[] {
  if (a.deprecated) return [];
  const t = textOf(a);
  if (NOT_DECOR.some((w) => hasWord(t.all, w))) return [];
  const sc = sizeClass(a);
  const fp = footprintOf(a);
  const out: Classification[] = [];
  for (const r of rules) {
    if (r.kind && a.kind !== r.kind) continue;
    if (r.sizes && !r.sizes.includes(sc)) continue;
    if (r.maxCells !== undefined && Math.max(fp[0], fp[1]) > r.maxCells) continue;
    if (r.none?.some((w) => hasWord(t.all, w))) continue;
    const inName = r.any.filter((w) => hasWord(t.name, w));
    const inTags = r.tagsCount ? r.any.filter((w) => hasWord(t.tags, w)) : [];
    if (inName.length === 0 && inTags.length === 0) continue;
    out.push({
      role: r.role,
      score: inName.length * 3 + inTags.length,
      reasons: [
        ...inName.map((w) => `name "${w}"`),
        ...inTags.map((w) => `tag "${w}"`),
        `size ${sc}`,
        `${fp[0]}×${fp[1]} cells`,
      ],
    });
  }
  return out.sort((x, y) => y.score - x.score || (x.role < y.role ? -1 : 1));
}

/** Catalog-derived palette variant (geometry and footprint from the catalog record). */
export function variantFromCatalog(a: CatalogAsset, weight: number): PaletteVariant {
  return { asset: a.uuid, name: `${a.name} (auto)`, geom: geomOf(a), footprint: footprintOf(a), weight };
}

/**
 * Extra variants for roles that already exist, from uncurated catalog assets. `known` = every uuid the curated
 * palettes reference (never duplicated); `roleFits(role, footprint)` lets the caller reject pieces larger than the
 * feature's footprint. At most `perRole` per role, each with `weight` (curated variants default to 1).
 */
export function autoVariantsFor(
  assets: readonly CatalogAsset[],
  known: ReadonlySet<string>,
  roleFits: (role: string, footprint: readonly [number, number]) => boolean,
  opts: { perRole?: number; weight?: number } = {},
): Record<string, PaletteVariant[]> {
  const perRole = opts.perRole ?? 4;
  const weight = opts.weight ?? 0.2;
  const out: Record<string, PaletteVariant[]> = {};
  const sorted = [...assets].sort((x, y) => (x.uuid < y.uuid ? -1 : x.uuid > y.uuid ? 1 : 0));
  for (const a of sorted) {
    if (known.has(a.uuid.toLowerCase())) continue;
    const fp = footprintOf(a);
    for (const c of classifyAsset(a)) {
      if (c.score < 3 || !roleFits(c.role, fp)) continue;
      const list = (out[c.role] ??= []);
      if (list.length < perRole) list.push(variantFromCatalog(a, weight));
    }
  }
  return out;
}

export interface CatalogQuery {
  /** Free words, e.g. "gnarled root". Adjectives that match nothing are ignored, not fatal. */
  keywords?: string;
  role?: string;
  size?: SizeClass | readonly SizeClass[];
  kind?: "prop" | "tile";
  limit?: number;
  /**
   * Strict matching for custom features, because loose matching picked unrelated assets ("car" became a cardboard
   * Carton, "fire hydrant" a fireplace bellows, "bus stop" a Stop sign). Whole words only (a plural s/es and a trailing number allowed:
   * "light" matches "Light01", "car" never matches "Carton"), and the head noun — the last word of the hint —
   * must be in the name: a hit on an adjective alone ("fire", "stop") is no hit.
   */
  strict?: boolean;
}

export interface CatalogHit {
  uuid: string;
  name: string;
  kind: "prop" | "tile";
  folder: string;
  sizeClass: SizeClass;
  footprint: [number, number];
  height: number;
  roles: string[];
  score: number;
  matched: string[];
}

const STOP = new Set([
  "a",
  "an",
  "the",
  "of",
  "with",
  "and",
  "on",
  "in",
  "across",
  "to",
  "for",
  "very",
  "big",
  "small",
  "large",
  "huge",
  "tiny",
  "old",
]);

/**
 * Ranked catalog search. A hit must match at least one keyword in its NAME (tags and kit only add score), or —
 * with no keywords — belong to the requested role. Props rank above tiles unless `kind` says otherwise. Results
 * carry size class, footprint and the words that matched, so the caller sees what it will get.
 */
export function searchCatalog(assets: readonly CatalogAsset[], q: CatalogQuery): CatalogHit[] {
  const kw = words(q.keywords ?? "").filter((w) => !STOP.has(w));
  const sizes = q.size === undefined ? null : typeof q.size === "string" ? [q.size] : q.size;
  const hits: CatalogHit[] = [];
  for (const a of assets) {
    if (a.deprecated || (q.kind && a.kind !== q.kind)) continue;
    const sc = sizeClass(a);
    if (sizes && !sizes.includes(sc)) continue;
    const roles = classifyAsset(a).map((c) => c.role);
    if (q.role && !roles.includes(q.role)) continue;
    const t = textOf(a);
    const inName = kw.filter((w) => (q.strict === true ? hasWholeWord(t.name, w) : hasWord(t.name, w)));
    if (kw.length > 0 && inName.length === 0) continue;
    if (q.strict === true && kw.length > 0 && !inName.includes(kw[kw.length - 1] as string)) continue;
    const inTags = kw.filter((w) => !inName.includes(w) && hasWord(t.tags, w));
    // later words of a phrase are usually its head noun ("gnarled tree ROOT"): they weigh slightly more
    // and an asset whose name is mostly the matched words ("Root 02") beats one that merely contains one
    const nameWords = words(a.name).filter((w) => !/^[0-9]+$/.test(w) && !STOP.has(w));
    let score =
      inName.reduce((sum, w) => sum + 3 + kw.indexOf(w) / Math.max(1, kw.length), 0) +
      (2 * inName.length) / Math.max(1, nameWords.length) +
      inTags.length * 0.5 +
      (q.role ? 2 : 0);
    if (!q.kind && a.kind === "tile") score -= 2;
    hits.push({
      uuid: a.uuid,
      name: a.name,
      kind: a.kind,
      folder: a.folder,
      sizeClass: sc,
      footprint: footprintOf(a),
      height: Math.round(a.size.y * 100) / 100,
      roles,
      score,
      matched: [...inName, ...inTags],
    });
  }
  hits.sort((x, y) => y.score - x.score || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return hits.slice(0, q.limit ?? 20);
}
