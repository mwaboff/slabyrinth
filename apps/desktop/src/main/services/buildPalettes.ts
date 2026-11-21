import type { AssetCatalog, Palette, PaletteCatalog } from "@slabyrinth/core";
import { resolvePalettesData, type ResolvePalettesData } from "@slabyrinth/core/palette";
import { availabilityFromCatalog, buildPaletteCatalog } from "../ports/compile";
import type { PaletteService } from "./paletteService";
import type { CatalogService } from "./talespire/catalogService";

export interface BuildPalettesDeps {
  palettes: Pick<PaletteService, "palettes" | "compileInputs">;
  catalog: Pick<CatalogService, "current">;
}

/**
 * The palettes builds compile with (the bundled palettes, the user's palette files and the scanned game assets),
 * for everything outside the compile worker that resolves a plan: the agent's views, checks and design review, plan
 * validation and `materialize` (registered with core's hooks in app.ts), and the 2D preview, which receives them as
 * plain data (`data()`, IPC "palettes:resolveData"). They are built by the same function as the compile worker's
 * (ports/compile.ts `buildPaletteCatalog`), so preview, agent and build resolve a plan alike.
 *
 * Rebuilt only when the palette files are reloaded or the asset catalog changes (both replace the objects this keys
 * on: PaletteService's effective list and CatalogService's current catalog).
 */
export class BuildPalettes {
  private memo: {
    effective: Palette[];
    catalog: AssetCatalog | null;
    palettes: PaletteCatalog;
    data?: ResolvePalettesData;
  } | null = null;

  constructor(private readonly deps: BuildPalettesDeps) {}

  current(): PaletteCatalog {
    return this.entry().palettes;
  }

  /** The current palettes as plain data, for the renderer; its `key` changes whenever they do. */
  data(): ResolvePalettesData {
    const entry = this.entry();
    entry.data ??= resolvePalettesData(entry.palettes);
    return entry.data;
  }

  private entry(): NonNullable<BuildPalettes["memo"]> {
    const effective = this.deps.palettes.palettes();
    const catalog = this.deps.catalog.current();
    if (this.memo?.effective !== effective || this.memo.catalog !== catalog) {
      const { userPalettes } = this.deps.palettes.compileInputs();
      this.memo = {
        effective,
        catalog,
        palettes: buildPaletteCatalog(userPalettes, availabilityFromCatalog(catalog)),
      };
    }
    return this.memo;
  }
}
