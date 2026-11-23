/**
 * The ONE classifier of catalog pieces the palettes do not name yet (owner, 2026-11-23: "new assets in the game after an
 * update ... go into the palette automatically when it makes sense to do so"). The developer's batch
 * (scripts/classify-catalog.ts, then the palette import) and the app on a user's machine (palette/extension.ts) both ask
 * it, so a piece is judged by one rule set wherever it is judged.
 *
 * The rule is the SIBLING rule: a new piece joins the role of a palette piece with the same name stem (digits, letter
 * suffixes and NxM sizes removed), the same kind and pivot (originAt), the same footprint and a height within the role
 * family's tolerance, from the same content pack when both are in the catalog. Measured over the bundled palettes by
 * leave-one-out (test/unit/palette/autoRoles.test.ts pins the floor). The keyword rules of catalog/classify.ts stand
 * behind it only as a report: a piece that only they place is `unsure` and never joins a palette by itself.
 *
 * Hard rules: never a new role (only roles a palette already has, in the themes that have them), never replace or
 * reorder curated variants (the caller appends), never a piece of a pack the palettes do not already use (which also
 * keeps out anything a user would have to install), never a deprecated piece. When unsure, the piece is left out.
 *
 * What a piece is allowed to join depends on its role's family (AUTO_POLICY): on a user's machine only loose dressing
 * ("user"); structural families need facts the catalog cannot tell (tone, facing, slope, end posts, light reach, heights
 * that feed layout), so only the developer's reviewed batch may add to them ("dev"); markers never.
 *
 * Pure and deterministic: the same catalog and palettes give the same answer, sorted.
 */
import type { CatalogAsset, Palette, PaletteVariant } from "../contracts/compiler";
import type { FeatureType } from "../contracts/plan";
import { classifyAsset, footprintOf } from "../catalog/classify";
import { geomOf } from "../catalog/derive";
import { FEATURE_INFO, type FeatureInfo } from "../gen/catalog";
import { own } from "../util/own";

/** Where a role family's new pieces may be added. */
export type AutoWhere = "user" | "dev" | "never";

export interface AutoPolicy {
  readonly where: AutoWhere;
  /** A new piece's weight is its sibling's weight times this. */
  readonly weight: number;
  /** Largest height difference from the sibling, as a share of the sibling's height. */
  readonly heightTolerance: number;
  readonly reason: string;
}

/**
 * Every role family (the role name's first word) the bundled palettes use. A test keeps this list equal to the palettes'
 * families, so a new family must be given a policy before it ships.
 */
export const ROLE_FAMILIES = [
  "balcony",
  "bed",
  "bridge",
  "canopy",
  "cap",
  "chimney",
  "chimney_top",
  "cliff",
  "corner_pier",
  "crenel",
  "facade",
  "facade_post",
  "feature",
  "fill",
  "finial",
  "fire_escape",
  "floor",
  "footing",
  "gate",
  "glow",
  "kerb",
  "ledge",
  "light",
  "link",
  "lintel",
  "magic_beacon",
  "marker",
  "marking",
  "mast",
  "opening",
  "over_door",
  "parapet",
  "pier",
  "porch_post",
  "ramp",
  "roof",
  "roof_clutter",
  "roof_terrace",
  "ruin_block",
  "ruin_growth",
  "ruin_prop",
  "ruin_rubble",
  "ship",
  "sign_band",
  "stairs",
  "stairs_block",
  "stall",
  "step",
  "trim",
  "wall",
  "wall_light",
  "wall_pipe",
  "wall_post",
  "wall_unit",
  "water",
  "window",
] as const;
export type RoleFamily = (typeof ROLE_FAMILIES)[number];

const user = (reason: string): AutoPolicy => ({ where: "user", weight: 0.25, heightTolerance: 0.25, reason });
const dev = (reason: string): AutoPolicy => ({ where: "dev", weight: 0.25, heightTolerance: 0.25, reason });

const TONE = "tone matters and the catalog cannot show it";
const RUNS = "runs join: slope and end posts are measured in game";
const FACING = "facing is not in the catalog";
const LIGHT = "light reach is unmeasured";
const KIT = "a kit piece that joins its neighbours";
const LAYOUT = "its size feeds layout";

/** The policy of every role family. `feature` is refined per feature type by its traits (featurePolicy). */
export const AUTO_POLICY: Readonly<Record<RoleFamily, AutoPolicy>> = {
  balcony: dev(KIT),
  bed: dev(TONE),
  bridge: dev(KIT),
  canopy: dev(KIT),
  cap: dev(TONE),
  chimney: dev(KIT),
  chimney_top: dev(KIT),
  cliff: dev(TONE),
  corner_pier: dev(KIT),
  crenel: dev(KIT),
  facade: dev(KIT),
  facade_post: dev(KIT),
  feature: user("loose dressing"),
  fill: dev(TONE),
  finial: dev(KIT),
  fire_escape: dev(KIT),
  floor: dev(TONE),
  footing: dev(KIT),
  gate: dev(FACING),
  glow: dev(LIGHT),
  kerb: dev(RUNS),
  ledge: dev(RUNS),
  light: dev(LIGHT),
  link: dev(FACING),
  lintel: dev(KIT),
  magic_beacon: dev(LIGHT),
  marker: { where: "never", weight: 0, heightTolerance: 0, reason: "the alignment marker is chosen by hand" },
  marking: dev(FACING),
  mast: dev(KIT),
  opening: dev(FACING),
  over_door: dev(KIT),
  parapet: dev(RUNS),
  pier: dev(LAYOUT),
  porch_post: dev(KIT),
  ramp: dev(FACING),
  roof: dev(KIT),
  roof_clutter: dev(LAYOUT),
  roof_terrace: dev(KIT),
  ruin_block: dev(KIT),
  ruin_growth: user("loose dressing"),
  ruin_prop: user("loose dressing"),
  ruin_rubble: user("loose dressing"),
  ship: dev(KIT),
  sign_band: dev(KIT),
  stairs: dev(FACING),
  stairs_block: dev(FACING),
  stall: dev(KIT),
  step: dev(FACING),
  trim: dev(RUNS),
  wall: dev(RUNS),
  wall_light: dev(LIGHT),
  wall_pipe: dev(KIT),
  wall_post: dev(RUNS),
  wall_unit: dev(KIT),
  water: dev(TONE),
  window: dev(FACING),
};

/** A family no row names (a user's own palette): only the reviewed batch may extend it. */
const UNKNOWN_FAMILY = dev("a role family the policy table does not know");

/**
 * Feature traits that make a feature type more than loose dressing: lights (reach), what other pieces stand on or sit
 * at (their height feeds layout and seating), columns that carry a hall, pieces hung on walls or ceilings (mounting is
 * measured), wall huggers and beds (their sides matter), rock-band pieces (built by the band passes).
 */
const NOT_LOOSE: ReadonlyArray<keyof FeatureInfo> = [
  "light",
  "openFire",
  "support",
  "carriesHall",
  "ceilingMounted",
  "wallMounted",
  "seat",
  "seatsAt",
  "sleepsIn",
  "wallHugger",
  "bandRock",
];

/** The policy of one role: its family's row, a feature type refined by its traits. */
export function rolePolicy(role: string): AutoPolicy {
  const dot = role.indexOf(".");
  const family = dot < 0 ? role : role.slice(0, dot);
  const row = (AUTO_POLICY as Readonly<Record<string, AutoPolicy>>)[family];
  if (!Object.hasOwn(AUTO_POLICY, family) || row === undefined) return UNKNOWN_FAMILY;
  if (family !== "feature") return row;
  const type = role.slice(dot + 1);
  const info: FeatureInfo | undefined = Object.hasOwn(FEATURE_INFO, type)
    ? FEATURE_INFO[type as FeatureType]
    : undefined;
  if (!info) return dev("not a feature type");
  const trait = NOT_LOOSE.find((t) => Boolean(info[t]));
  return trait === undefined ? row : dev(`feature trait ${trait}`);
}

/**
 * A piece name's stem: lower case, separators as spaces, without numbers, NxM sizes, letter suffixes ("01 B", "2a")
 * and trailing digits ("lamp01"). "Stalagmite Column 05" → "stalagmite column"; "md_wall_1x1_02" → "md wall".
 */
export function stemOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[_\-,()[\]]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/[0-9]+$/, ""))
    .filter((w) => w.length > 1 && !/^[0-9]+([a-z]|x[0-9]+(x[0-9]+)?)?$/.test(w))
    .join(" ");
}

/** What the classifier reads of a piece: name, kind, pack and geometry. */
export interface PieceFacts {
  readonly uuid: string;
  readonly name: string;
  readonly kind: "tile" | "prop";
  /** Content pack; absent when unknown (a palette piece the catalog does not list). */
  readonly pack?: string;
  readonly geom: PaletteVariant["geom"];
}

/** A palette piece in one theme's role, as a sibling a new piece may join. */
export interface Sibling {
  readonly theme: string;
  readonly role: string;
  readonly piece: PieceFacts;
  readonly variant: PaletteVariant;
}

const kindOfGeom = (g: PaletteVariant["geom"]): "tile" | "prop" =>
  g.originAt === "minCorner" ? "tile" : "prop";

/**
 * Whether `piece` may join `sibling`'s role: same stem, kind, pivot and footprint (as laid, not turned), a height within
 * the role's tolerance, the same pack when both are known; never a sibling built of several parts or with a footprint
 * the curator set by hand (both say something the catalog does not).
 */
export function fitsSibling(piece: PieceFacts, sibling: Sibling): boolean {
  const s = sibling.piece;
  if (stemOf(piece.name) !== stemOf(s.name) || stemOf(piece.name) === "") return false;
  if (piece.kind !== s.kind || piece.geom.originAt !== s.geom.originAt) return false;
  if (piece.pack !== undefined && s.pack !== undefined && piece.pack !== s.pack) return false;
  if ((sibling.variant.parts?.length ?? 0) > 0) return false;
  const own = footprintOf({ size: s.geom.size, originAt: s.geom.originAt });
  const set = sibling.variant.footprint;
  if (set !== undefined && (set[0] !== own[0] || set[1] !== own[1])) return false;
  const fp = footprintOf({ size: piece.geom.size, originAt: piece.geom.originAt });
  if (fp[0] !== own[0] || fp[1] !== own[1]) return false;
  const tol = rolePolicy(sibling.role).heightTolerance;
  const h = s.geom.size.y;
  return h > 0 && Math.abs(piece.geom.size.y - h) <= tol * h + 1e-9;
}

/** The palettes' pieces by stem, with every uuid they name (preferred, alternates and parts). */
export interface SiblingIndex {
  readonly byStem: ReadonlyMap<string, readonly Sibling[]>;
  /** Lower-case uuids the palettes already name, in any role. */
  readonly known: ReadonlySet<string>;
}

/** Indexes `palettes` (each theme's own roles; aliases with no variants have none). `catalog` gives packs and kinds. */
export function siblingIndex(
  palettes: Readonly<Record<string, Palette>>,
  catalog: ReadonlyMap<string, CatalogAsset> = new Map(),
): SiblingIndex {
  const byStem = new Map<string, Sibling[]>();
  const known = new Set<string>();
  for (const theme of Object.keys(palettes).sort()) {
    const p = palettes[theme];
    if (!p) continue;
    for (const role of Object.keys(p.roles).sort()) {
      const def = own(p.roles, role);
      for (const v of def && Array.isArray(def.variants) ? def.variants : []) {
        const uuid = v.asset.toLowerCase();
        known.add(uuid);
        for (const a of v.alternates ?? []) known.add(a.toLowerCase());
        for (const part of v.parts ?? []) known.add(part.asset.toLowerCase());
        const rec = catalog.get(uuid);
        const name = rec?.name ?? v.name ?? "";
        const piece: PieceFacts = {
          uuid,
          name,
          kind: rec?.kind ?? kindOfGeom(v.geom),
          ...(rec ? { pack: rec.pack } : {}),
          geom: v.geom,
        };
        const stem = stemOf(name);
        if (stem === "") continue;
        let list = byStem.get(stem);
        if (!list) byStem.set(stem, (list = []));
        list.push({ theme, role, piece, variant: v });
      }
    }
  }
  return { byStem, known };
}

/**
 * The siblings `piece` joins, in index order: of the palette pieces it fits, the one nearest in height (ties: the
 * lower uuid), in every role and theme that piece has. A curator who split a stem's pieces between roles by size
 * (stalagmites and tall clusters, roots and large roots) split them by the very fact this compares. `skip` leaves one
 * uuid out (the leave-one-out measure).
 */
export function fittingSiblings(piece: PieceFacts, index: SiblingIndex, skip?: string): Sibling[] {
  const fit = (index.byStem.get(stemOf(piece.name)) ?? []).filter(
    (s) => s.piece.uuid !== skip && fitsSibling(piece, s),
  );
  const h = piece.geom.size.y;
  let nearest: PieceFacts | undefined;
  for (const s of fit) {
    const d = Math.abs(s.piece.geom.size.y - h);
    const n = nearest === undefined ? Infinity : Math.abs(nearest.geom.size.y - h);
    if (d < n - 1e-9 || (Math.abs(d - n) <= 1e-9 && nearest !== undefined && s.piece.uuid < nearest.uuid))
      nearest = s.piece;
  }
  return fit.filter((s) => s.piece.uuid === nearest?.uuid);
}

/** One new piece in one theme's role. */
export interface AutoPiece {
  readonly uuid: string;
  readonly name: string;
  readonly theme: string;
  readonly role: string;
  readonly where: AutoWhere;
  /** The palette variant it joins as (geometry from the catalog, the rest from its sibling). */
  readonly variant: PaletteVariant;
  /** The uuid of the palette piece it was modelled on (its sibling nearest in height). */
  readonly model: string;
  /** The name of every fitting sibling in this role. */
  readonly siblings: readonly string[];
}

/** A new piece the classifier would not place by itself, with why and where the keyword rules would put it. */
export interface AutoUnsure {
  readonly uuid: string;
  readonly name: string;
  readonly basis: "sibling" | "keyword" | "none";
  readonly roles: readonly string[];
  readonly reasons: readonly string[];
}

/** A pack's folder with no palette piece at all: a new kit for an engineer, never placed by itself. */
export interface AutoNewKit {
  readonly pack: string;
  readonly folder: string;
  readonly pieces: number;
}

export interface AutoClassification {
  /** Sure pieces, sorted by uuid, theme, role. */
  readonly pieces: readonly AutoPiece[];
  readonly unsure: readonly AutoUnsure[];
  readonly newKits: readonly AutoNewKit[];
}

export interface ClassifyOptions {
  /** Lower-case uuids already reviewed (the developer's seen list): never proposed again. */
  readonly seen?: ReadonlySet<string>;
  /** Lower-case uuids never to use (a user's exclusions, the developer's rejections). */
  readonly exclude?: ReadonlySet<string>;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The variant a new piece joins a role as: its own geometry, its sibling's key, facing, turn, offset and stacking. */
function variantFor(a: CatalogAsset, model: Sibling, fitting: readonly Sibling[]): PaletteVariant {
  const m = model.variant;
  const optIn = fitting.some((s) => (s.variant.weight ?? 1) === 0);
  const weight = optIn ? 0 : (m.weight ?? 1) * rolePolicy(model.role).weight;
  const fp = footprintOf(a);
  const v: PaletteVariant = {
    asset: a.uuid.toLowerCase(),
    name: a.name,
    geom: geomOf(a),
    footprint: [fp[0], fp[1]],
    weight,
  };
  if (m.variant !== undefined) v.variant = m.variant;
  if (m.facing !== undefined) v.facing = { ...m.facing };
  if (m.rot !== undefined) v.rot = m.rot;
  if (m.offset !== undefined) v.offset = { ...m.offset };
  if (m.stack !== undefined) v.stack = { ...m.stack };
  return v;
}

/**
 * Classifies the catalog pieces the palettes do not name (and `seen` and `exclude` leave in) by the sibling rule. A
 * piece is sure when it fits a sibling and so does every other new piece of its stem group in its pack (a kit is
 * judged as a set); otherwise the whole group is reported unsure. Pieces whose stem no palette piece has are reported
 * with the keyword rules' guess, and folders with no palette piece as new kits.
 */
export function classifyNew(
  assets: readonly CatalogAsset[],
  palettes: Readonly<Record<string, Palette>>,
  opts: ClassifyOptions = {},
): AutoClassification {
  const catalog = new Map(assets.map((a) => [a.uuid.toLowerCase(), a]));
  const index = siblingIndex(palettes, catalog);
  const usedPacks = new Set<string>();
  const usedFolders = new Set<string>();
  for (const uuid of index.known) {
    const rec = catalog.get(uuid);
    if (rec) {
      usedPacks.add(rec.pack);
      usedFolders.add(`${rec.pack}\u0000${rec.folder}`);
    }
  }
  const candidates = [...assets]
    .filter((a) => {
      const u = a.uuid.toLowerCase();
      return (
        !a.deprecated &&
        usedPacks.has(a.pack) &&
        !index.known.has(u) &&
        !(opts.seen?.has(u) ?? false) &&
        !(opts.exclude?.has(u) ?? false)
      );
    })
    .sort((x, y) => byText(x.uuid.toLowerCase(), y.uuid.toLowerCase()));

  const factsOf = (a: CatalogAsset): PieceFacts => ({
    uuid: a.uuid.toLowerCase(),
    name: a.name,
    kind: a.kind,
    pack: a.pack,
    geom: geomOf(a),
  });
  // stem groups per pack: a kit is judged as a set
  const groups = new Map<string, CatalogAsset[]>();
  const newKits = new Map<string, AutoNewKit>();
  for (const a of candidates) {
    const key = `${a.pack}\u0000${stemOf(a.name)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(a);
    const folder = `${a.pack}\u0000${a.folder}`;
    if (!usedFolders.has(folder)) {
      const k = newKits.get(folder);
      newKits.set(folder, { pack: a.pack, folder: a.folder, pieces: (k?.pieces ?? 0) + 1 });
    }
  }

  const pieces: AutoPiece[] = [];
  const unsure: AutoUnsure[] = [];
  for (const group of groups.values()) {
    const fits = group.map((a) => ({ a, fitting: fittingSiblings(factsOf(a), index) }));
    const stemKnown = (index.byStem.get(stemOf(group[0]?.name ?? "")) ?? []).length > 0;
    const whole = fits.every((f) => f.fitting.length > 0);
    for (const { a, fitting } of fits) {
      const uuid = a.uuid.toLowerCase();
      if (!whole || fitting.length === 0) {
        const keyword = classifyAsset(a).map((c) => c.role);
        const roles = [...new Set(fitting.length > 0 ? fitting.map((s) => s.role) : keyword)].sort(byText);
        unsure.push({
          uuid,
          name: a.name,
          basis: fitting.length > 0 || stemKnown ? "sibling" : keyword.length > 0 ? "keyword" : "none",
          roles,
          reasons: [
            fitting.length > 0
              ? "another new piece of its stem fits no palette piece"
              : stemKnown
                ? "its stem's palette pieces differ in kind, pack, footprint or height"
                : keyword.length > 0
                  ? "no palette piece shares its stem; only the keyword rules place it"
                  : "no palette piece shares its stem",
          ],
        });
        continue;
      }
      const byRole = new Map<string, Sibling[]>();
      for (const s of fitting) {
        const k = `${s.theme}\u0000${s.role}`;
        const list = byRole.get(k);
        if (list) list.push(s);
        else byRole.set(k, [s]);
      }
      for (const list of byRole.values()) {
        // the sibling nearest in height is the model (ties: palette order, which is sorted)
        const h = a.size.y;
        const model = [...list].sort(
          (x, y) => Math.abs(x.piece.geom.size.y - h) - Math.abs(y.piece.geom.size.y - h),
        )[0] as Sibling;
        const policy = rolePolicy(model.role);
        if (policy.where === "never") continue;
        pieces.push({
          uuid,
          name: a.name,
          theme: model.theme,
          role: model.role,
          where: policy.where,
          variant: variantFor(a, model, list),
          model: model.piece.uuid,
          siblings: [...new Set(list.map((s) => s.piece.name))].sort(byText),
        });
      }
    }
  }
  pieces.sort((x, y) => byText(x.uuid, y.uuid) || byText(x.theme, y.theme) || byText(x.role, y.role));
  unsure.sort((x, y) => byText(x.uuid, y.uuid));
  return {
    pieces,
    unsure,
    newKits: [...newKits.values()].sort((x, y) => byText(x.pack, y.pack) || byText(x.folder, y.folder)),
  };
}

/** One leave-one-out result: a palette piece's roles predicted from the other palette pieces. */
export interface AgreementRow {
  readonly uuid: string;
  readonly name: string;
  readonly actual: readonly string[];
  readonly predicted: readonly string[];
}

/**
 * The sibling rule's agreement with the curator, from palette data alone: for every piece the palettes name, the roles
 * it would join from the OTHER pieces (any theme), beside the roles it has. Pieces built of parts and pieces whose stem
 * no other piece shares predict nothing (they are the rule's misses, not its errors).
 */
export function siblingAgreement(palettes: Readonly<Record<string, Palette>>): AgreementRow[] {
  const index = siblingIndex(palettes);
  const pieces = new Map<string, { piece: PieceFacts; roles: Set<string> }>();
  for (const list of index.byStem.values())
    for (const s of list) {
      if ((s.variant.parts?.length ?? 0) > 0) continue;
      const e = pieces.get(s.piece.uuid);
      if (e) e.roles.add(s.role);
      else pieces.set(s.piece.uuid, { piece: s.piece, roles: new Set([s.role]) });
    }
  return [...pieces.values()]
    .map(({ piece, roles }) => ({
      uuid: piece.uuid,
      name: piece.name,
      actual: [...roles].sort(byText),
      predicted: [...new Set(fittingSiblings(piece, index, piece.uuid).map((s) => s.role))].sort(byText),
    }))
    .sort((x, y) => byText(x.uuid, y.uuid));
}
