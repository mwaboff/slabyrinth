/**
 * Palette loading and layering (architecture §4.2): bundled defaults (core/data/palettes) + user files
 * (userData/palettes/<id>.json). A user file with `overrides: true` replaces/deletes roles of the bundled palette
 * with the same id; a user file without it is a whole palette (new theme, or a full replacement).
 */
import type {
  AssetAvailability,
  CatalogAsset,
  OrientationCalibration,
  Palette,
  PaletteCatalog,
  PaletteOverride,
} from "../contracts/compiler";
import type { ThemeId } from "../contracts/plan";
import { NULL_AVAILABILITY } from "../catalog/availability";
import { BUNDLED_ORIENTATION, BUNDLED_PALETTES } from "./bundled";
import { dict, own } from "./own";
import { parseOrientation, parsePalette, parsePaletteOverride } from "./schema";
import { withAutoVariants } from "./auto";

export interface PaletteLoadIssue {
  severity: "error" | "warning";
  /** File name or palette id the issue is about. */
  source: string;
  message: string;
}

/** Applies one override onto a palette (roles replaced wholesale; `null` deletes a role). Pure. */
export function applyOverride(base: Palette, o: PaletteOverride): Palette {
  const roles: Palette["roles"] = dict();
  for (const [role, def] of Object.entries(base.roles)) if (!Object.hasOwn(o.roles, role)) roles[role] = def;
  for (const [role, def] of Object.entries(o.roles)) if (def !== null) roles[role] = def;
  const defaults = { ...base.defaults };
  if (o.defaults?.floor !== undefined) defaults.floor = o.defaults.floor;
  if (o.defaults?.wallStyle !== undefined) defaults.wallStyle = o.defaults.wallStyle;
  if (o.defaults?.caveFloor !== undefined) defaults.caveFloor = o.defaults.caveFloor;
  if (o.defaults?.interior !== undefined) defaults.interior = o.defaults.interior;
  return {
    ...base,
    name: o.name ?? base.name,
    defaults,
    roles,
    source: { ...(base.source ?? {}), editedByUser: true },
  };
}

/**
 * Merges bundled palettes with user files (already-parsed JSON values, any order). Invalid files are skipped with
 * an issue; nothing throws. Also checks `extends` (unknown parent, cycles).
 */
export function mergePalettes(
  bundled: readonly unknown[],
  user: ReadonlyArray<{ source: string; data: unknown }> = [],
): { palettes: Record<ThemeId, Palette>; issues: PaletteLoadIssue[] } {
  const issues: PaletteLoadIssue[] = [];
  const palettes: Record<ThemeId, Palette> = dict();
  for (const [i, b] of bundled.entries()) {
    const r = parsePalette(b);
    if (r.ok) palettes[r.value.id] = r.value;
    else issues.push({ severity: "error", source: `bundled #${i}`, message: r.error });
  }
  const overrides: Array<{ source: string; o: PaletteOverride }> = [];
  for (const u of user) {
    const isOverride =
      typeof u.data === "object" && u.data !== null && (u.data as { overrides?: unknown }).overrides === true;
    if (isOverride) {
      const r = parsePaletteOverride(u.data);
      if (r.ok) overrides.push({ source: u.source, o: r.value });
      else issues.push({ severity: "error", source: u.source, message: r.error });
    } else {
      const r = parsePalette(u.data);
      if (r.ok) {
        if (own(palettes, r.value.id))
          issues.push({
            severity: "warning",
            source: u.source,
            message: `replaces the bundled palette "${r.value.id}"`,
          });
        palettes[r.value.id] = { ...r.value, source: { ...(r.value.source ?? {}), editedByUser: true } };
      } else issues.push({ severity: "error", source: u.source, message: r.error });
    }
  }
  for (const { source, o } of overrides) {
    const base = own(palettes, o.id);
    if (!base) {
      issues.push({ severity: "warning", source, message: `override for unknown palette "${o.id}" ignored` });
      continue;
    }
    palettes[o.id] = applyOverride(base, o);
  }
  for (const p of Object.values(palettes)) {
    const seen = new Set<string>([p.id]);
    let cur = p.extends;
    while (cur !== undefined) {
      if (seen.has(cur)) {
        issues.push({
          severity: "error",
          source: p.id,
          message: `extends cycle through "${cur}"; inheritance cut`,
        });
        const fixed: Palette = { ...p };
        delete fixed.extends;
        palettes[p.id] = fixed;
        break;
      }
      const parent = own(palettes, cur);
      if (!parent) {
        issues.push({ severity: "warning", source: p.id, message: `extends unknown palette "${cur}"` });
        break;
      }
      seen.add(cur);
      cur = parent.extends;
    }
  }
  if (!own(palettes, "generic"))
    issues.push({
      severity: "warning",
      source: "generic",
      message: "no generic palette: the last fallback step is unavailable",
    });
  return { palettes, issues };
}

/** The bundled palettes merged with optional user files, as a PaletteCatalog. */
export function loadPalettes(
  opts: {
    user?: ReadonlyArray<{ source: string; data: unknown }>;
    availability?: AssetAvailability;
    bundled?: readonly unknown[];
    /**
     * The scanned catalog: assets a game update added join the roles they classify into as low-weight extra
     * variants (palette/auto.ts). Curated entries stay authoritative.
     */
    catalog?: readonly CatalogAsset[];
  } = {},
): PaletteCatalog & { issues: PaletteLoadIssue[]; autoVariants: number } {
  const merged = mergePalettes(opts.bundled ?? BUNDLED_PALETTES, opts.user ?? []);
  const auto = opts.catalog
    ? withAutoVariants(merged.palettes, opts.catalog)
    : { palettes: merged.palettes, added: 0 };
  return {
    palettes: auto.palettes,
    availability: opts.availability ?? NULL_AVAILABILITY,
    issues: merged.issues,
    autoVariants: auto.added,
  };
}

let bundled: PaletteCatalog | null = null;

/**
 * The palettes Slabyrinth ships with, alone (no user files, no game catalog), built once and shared: do not change
 * the object. The released generators resolve against these whatever a plan is compiled with (their output is
 * frozen, palette/view.ts `resolveView`), and a test or script that means "the bundled palettes" says so here.
 */
export function bundledPalettes(): PaletteCatalog {
  bundled ??= loadPalettes();
  return bundled;
}

/** Bundled orientation, optionally replaced by a user file (userData/orientation.json). Invalid user data is ignored. */
export function loadOrientation(user?: unknown): {
  orientation: OrientationCalibration;
  issues: PaletteLoadIssue[];
} {
  const base = parseOrientation(BUNDLED_ORIENTATION);
  if (!base.ok) throw new Error(`bundled orientation.json is invalid: ${base.error}`);
  if (user === undefined || user === null) return { orientation: base.value, issues: [] };
  const r = parseOrientation(user);
  if (r.ok) return { orientation: r.value, issues: [] };
  return {
    orientation: base.value,
    issues: [{ severity: "error", source: "orientation.json", message: r.error }],
  };
}
