import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Palette } from "@slabyrinth/core";
import { BUNDLED_PALETTES, loadOrientation, loadPalettes } from "@slabyrinth/core/palette";
import { parseJsonText, type Unparsed } from "@slabyrinth/core/util";
import type { Logger } from "../logger";

/**
 * Palettes (architecture §4, compiler.ts): core's bundled defaults layered with user files in
 * userData/palettes, merged and validated by core (`loadPalettes`, `loadOrientation`) — the same
 * code and the same bundled data the compiler uses, so the themes the model is offered are exactly
 * the ones that build. A user file with `overrides: true` replaces roles of the bundled palette with
 * the same id (null deletes a role); any other user file is a whole new theme. Alias roles (no
 * variants, only `fallback`) are valid (contract ruling 2026-11-18).
 */
export interface PaletteEntry {
  id: string;
  name: string;
  source: "bundled" | "user";
  extends?: string;
  issues: number;
}

interface UserFile {
  file: string;
  json: unknown;
}

export interface PaletteServiceDeps {
  userDir: string;
  orientationOverride: string;
  logger: Logger;
  openPath: (dir: string) => Promise<string>;
  /** After every load (startup or reload): the palettes may have changed. */
  onLoaded?: () => void;
}

async function readUserDir(dir: string, logger: Logger): Promise<UserFile[]> {
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.toLowerCase().endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: UserFile[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      out.push({ file, json: parseJsonText(await fsp.readFile(file, "utf8")) });
    } catch (err) {
      logger.warn("palette unreadable", { file, error: err });
      out.push({ file, json: null });
    }
  }
  return out;
}

export class PaletteService {
  private user: UserFile[] = [];
  private effective: Palette[] = [];
  private entries: PaletteEntry[] = [];
  private orientationUser: unknown = null;

  constructor(private readonly deps: PaletteServiceDeps) {}

  async load(): Promise<void> {
    this.user = await readUserDir(this.deps.userDir, this.deps.logger);
    this.orientationUser = await readJsonFile(this.deps.orientationOverride);
    const userInputs = this.userInputs();
    const loaded = loadPalettes({ user: userInputs });
    this.effective = Object.values(loaded.palettes);
    const issuesBy = new Map<string, number>();
    for (const i of loaded.issues) issuesBy.set(i.source, (issuesBy.get(i.source) ?? 0) + 1);

    const bundledIds = new Set<string>();
    const entries: PaletteEntry[] = [];
    for (const b of BUNDLED_PALETTES as ReadonlyArray<{ id?: unknown; name?: unknown; extends?: unknown }>) {
      if (typeof b.id !== "string") continue;
      bundledIds.add(b.id);
      const e: PaletteEntry = {
        id: b.id,
        name: typeof b.name === "string" ? b.name : b.id,
        source: "bundled",
        issues: 0,
      };
      if (typeof b.extends === "string") e.extends = b.extends;
      entries.push(e);
    }
    for (const f of this.user) {
      const source = path.basename(f.file);
      const p = (f.json ?? {}) as { id?: unknown; name?: unknown; extends?: unknown; overrides?: unknown };
      const e: PaletteEntry = {
        id: typeof p.id === "string" ? p.id : path.basename(f.file, ".json"),
        name: typeof p.name === "string" ? p.name : path.basename(f.file, ".json"),
        source: "user",
        issues: f.json === null ? 1 : (issuesBy.get(source) ?? 0),
      };
      const ext = p.overrides === true ? p.id : p.extends;
      if (typeof ext === "string") e.extends = ext;
      entries.push(e);
    }
    const orientationIssues = loadOrientation(this.orientationUser).issues;
    for (const i of [...loaded.issues, ...orientationIssues])
      this.deps.logger.warn("palette issue", { source: i.source, severity: i.severity, message: i.message });
    this.entries = entries;
    this.deps.logger.info("palettes loaded", { bundled: bundledIds.size, user: this.user.length });
    this.deps.onLoaded?.();
  }

  private userInputs(): Array<{ source: string; data: unknown }> {
    return this.user
      .filter((f) => f.json !== null)
      .map((f) => ({ source: path.basename(f.file), data: f.json }));
  }

  list(): PaletteEntry[] {
    return this.entries;
  }

  /** Effective palettes (bundled + user), as core merged them. */
  palettes(): Palette[] {
    return this.effective;
  }

  /** Raw inputs for the compile worker (it builds core's PaletteCatalog itself). */
  compileInputs(): {
    palettes: Palette[];
    userPalettes: Array<{ source: string; data: unknown }>;
    orientation: unknown;
    orientationOverride: unknown;
  } {
    return {
      palettes: this.effective,
      userPalettes: this.userInputs(),
      orientation: loadOrientation(this.orientationUser).orientation,
      orientationOverride: this.orientationUser,
    };
  }

  /** Stable hash input for BuildRecord.settings.paletteHash/orientationHash. */
  fingerprints(): { palettes: string; orientation: string } {
    return {
      palettes: JSON.stringify(this.effective),
      orientation: JSON.stringify(loadOrientation(this.orientationUser).orientation),
    };
  }

  async openFolder(): Promise<void> {
    await fsp.mkdir(this.deps.userDir, { recursive: true });
    const err = await this.deps.openPath(this.deps.userDir);
    if (err) this.deps.logger.warn("open palettes folder failed", { error: err });
  }
}

/** A JSON file, unchecked (core loadOrientation checks it); null when missing or unreadable. */
async function readJsonFile(file: string): Promise<Unparsed | null> {
  try {
    return parseJsonText(await fsp.readFile(file, "utf8"));
  } catch {
    return null;
  }
}
