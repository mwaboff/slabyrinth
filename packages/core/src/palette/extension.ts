/**
 * The palette extension: catalog pieces the user's game has and the palettes do not name, that the shared classifier
 * (palette/autoRoles.ts) places surely in a LOOSE DRESSING role (owner, 2026-11-23: on a user's machine, props, clutter,
 * ground cover and decoration only; never walls, floors, roofs, doors, stairs or the ship kit).
 *
 * It is not merged into the palettes. It travels beside them on the palette catalog (`buildPaletteCatalog`), and only a
 * plan whose generator has the switch `catalogExtension` builds with it, and only in realize (and verify, which judges
 * what realize built): the resolver never sees it, so a map's layout is the same on every machine and only some
 * dressing picks differ. Realize draws an extension piece in two stages (compile/realize/context.ts `pick`): a hash of
 * its own decides "curated or extension" at the extension's share (at most `EXTENSION_SHARE`), then the piece is picked
 * within that set. A game update therefore only moves the cells that draw an extension piece.
 *
 * The extension is a pure function of the catalog, the bundled palettes and the user's exclusions, and its `hash` is
 * its content: the same library gives the same hash on every machine, and a build records it (the app's build record)
 * so a rebuild with another library can say so.
 */
import type { CatalogAsset, Palette, PaletteVariant } from "../contracts/compiler";
import { canonicalJson } from "../util/canonical";
import { h64hex } from "../util/hash";
import { classifyNew } from "./autoRoles";

/** Largest share of a role's picks extension pieces may take. */
export const EXTENSION_SHARE = 0.25;

/** One catalog piece joining one theme's role. */
export interface ExtensionPiece {
  readonly uuid: string;
  readonly name: string;
  readonly theme: string;
  readonly role: string;
  readonly variant: PaletteVariant;
  /** The palette piece it was modelled on: the role takes it only while that piece is one of its variants. */
  readonly model: string;
}

export interface PaletteExtension {
  /** Content hash: equal hashes, equal extensions. */
  readonly hash: string;
  /** Sorted by uuid, theme, role. */
  readonly pieces: readonly ExtensionPiece[];
}

const hashOf = (pieces: readonly ExtensionPiece[]): string => h64hex(canonicalJson(pieces));

export const EMPTY_EXTENSION: PaletteExtension = { hash: hashOf([]), pieces: [] };

/**
 * The extension of `palettes` (the bundled palettes) from a scanned catalog: the classifier's sure pieces in
 * user-policy roles, less the user's exclusions (lower- or mixed-case uuids).
 */
export function paletteExtension(
  assets: readonly CatalogAsset[],
  palettes: Readonly<Record<string, Palette>>,
  exclude: Iterable<string> = [],
): PaletteExtension {
  const out = classifyNew(assets, palettes, {
    exclude: new Set([...exclude].map((u) => u.toLowerCase())),
  });
  const pieces: ExtensionPiece[] = out.pieces
    .filter((p) => p.where === "user")
    .map((p) => ({
      uuid: p.uuid,
      name: p.name,
      theme: p.theme,
      role: p.role,
      variant: p.variant,
      model: p.model,
    }));
  return pieces.length === 0 ? EMPTY_EXTENSION : { hash: hashOf(pieces), pieces };
}

/** The extension a palette catalog carries (`buildPaletteCatalog`), if any. */
export function extensionOf(catalog: object): PaletteExtension | undefined {
  const e = (catalog as { extension?: PaletteExtension }).extension;
  return e !== undefined && Array.isArray(e.pieces) ? e : undefined;
}

/**
 * The palettes' own pieces without the variants the released generators' keyword enrichment added at run time
 * (palette/auto.ts `withAutoVariants`, which names each " (auto)"; generators 1 to 4 keep building with them, so their
 * output on a machine with the game installed is what it was). Generator 5 builds from these and its extension.
 */
export function isLegacyAutoVariant(v: Pick<PaletteVariant, "name">): boolean {
  return v.name?.endsWith(" (auto)") ?? false;
}
