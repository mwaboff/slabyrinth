/**
 * Slabyrinth Helper in TaleSpire's Symbiotes folder: its status, install, update and the automatic update at start.
 *
 * - Install (and "update now", "reinstall") is the user's action: the bundled files are copied into
 *   `<Symbiotes>/slabyrinth-helper/` and the pairing file (port and token, LINK_CONFIG_FILE) is written beside them.
 * - At start an installed, older copy that is recognisably ours (same manifest name and website) is updated by itself;
 *   a missing one is never installed by itself; a newer one is never downgraded; a foreign folder of the same name is
 *   never written to.
 * - Files are replaced one at a time through a temporary file and a rename, manifest.json last, so an update that
 *   stops half way still reads as the old version and is tried again. The pairing file is kept on an automatic update.
 *   Nothing else in the Symbiotes folder (or the add-on folder) is deleted.
 * - A failure never throws out of the automatic update: it is recorded with a plain reason for the UI.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { AddonStatus } from "../../../../shared/ipc";
import type { Logger } from "../../../logger";
import { AppFailure, isNodeError } from "../../../util/errors";
import { pathKey } from "../../../util/safePath";
import { compareVersions, parseVersion } from "../../semver";
import { LINK_CONFIG_FILE } from "./protocol";
import type { FolderCandidate } from "./symbiotesFolder";

export const ADDON_FOLDER_NAME = "slabyrinth-helper";

const manifestSchema = z.object({
  name: z.string().max(200),
  version: z.string().max(32),
  about: z.object({ website: z.string().max(300).optional() }).optional(),
});
type Manifest = z.infer<typeof manifestSchema>;

const configSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1).max(128),
});
export type LinkConfig = z.infer<typeof configSchema>;

export interface AddonDeps {
  /** The add-on as shipped with the app (resources in a packaged app; symbiotes/slabyrinth-helper in development). */
  bundledDir: string;
  /** Where a paired copy is prepared for a manual install (under userData). */
  packageDir: string;
  /** The pairing the installed copy must carry. */
  pairing: () => LinkConfig;
  /** The Symbiotes folder (manual choice first), and every path tried. */
  locate: () => Promise<{ found: FolderCandidate | null; tried: string[] }>;
  /** The bundled version whose prompt the user dismissed. */
  dismissed: () => string | undefined;
  /** Other Symbiotes folders where a copy may still be (the detected one, the one used before a change). */
  others?: () => Promise<string[]>;
  logger: Logger;
  now?: () => Date;
  /** The two steps of removing a folder (tests make them fail). */
  removal?: { rename: (from: string, to: string) => Promise<void>; rm: (dir: string) => Promise<void> };
}

const nodeRemoval = {
  rename: (from: string, to: string) => fsp.rename(from, to),
  rm: (dir: string) => fsp.rm(dir, { recursive: true }),
};

/** A file-system failure in plain words. */
export function plainReason(err: unknown): string {
  const code = isNodeError(err) ? err.code : undefined;
  switch (code) {
    case "EPERM":
    case "EACCES":
      return "Slabyrinth isn't allowed to write in the Symbiotes folder.";
    case "EBUSY":
      return "A file of the add-on is in use. Close TaleSpire and try again.";
    case "ENOSPC":
      return "The disk is full.";
    case "ENOENT":
      return "The Symbiotes folder went away while copying.";
    case "EROFS":
      return "The Symbiotes folder is on a read-only drive.";
    default:
      return `The files could not be copied${code ? ` (${code})` : ""}.`;
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Every file of a folder, relative, dot-files skipped (TaleSpire ignores them too). */
async function listFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Writes a file through a temporary dot-file beside it and a rename (TaleSpire ignores dot-files). */
async function replaceFile(target: string, data: Buffer | string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.slabyrinth-tmp`);
  await fsp.writeFile(tmp, data);
  try {
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** A chosen folder that is not TaleSpire's Symbiotes folder (kept, with this warning). */
export function folderWarning(folder: string): string | null {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  const [last, parent] = [parts.at(-1) ?? "", parts.at(-2) ?? ""];
  if (last.toLowerCase() === "symbiotes" && parent.toLowerCase() === "talespire") return null;
  return "This folder doesn't look like TaleSpire's Symbiotes folder (…/TaleSpire/Symbiotes). TaleSpire only loads add-ons from there.";
}

function newer(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x !== null && y !== null && compareVersions(x, y) > 0;
}

export class AddonService {
  private bundled: Manifest | null = null;
  private update: AddonStatus["update"] = {
    state: "none",
    automatic: false,
    from: null,
    to: null,
    at: null,
    error: null,
  };
  /** Set once the automatic update has looked (so a later outdated copy says why it was not updated). */
  private autoChecked = false;

  constructor(private readonly d: AddonDeps) {}

  private now(): string {
    return (this.d.now?.() ?? new Date()).toISOString();
  }

  /** The bundled manifest (read once). */
  async bundledManifest(): Promise<Manifest> {
    if (this.bundled) return this.bundled;
    const m = manifestSchema.safeParse(await readJson(path.join(this.d.bundledDir, "manifest.json")));
    if (!m.success) throw new Error(`the bundled add-on has no readable manifest (${this.d.bundledDir})`);
    this.bundled = m.data;
    return m.data;
  }

  private ours(m: Manifest, b: Manifest): boolean {
    return m.name === b.name && (m.about?.website ?? null) === (b.about?.website ?? null);
  }

  /** Our installed manifest in a Symbiotes folder: only a real folder (no link) holding our manifest; else null. */
  private async oursIn(symbiotes: string): Promise<Manifest | null> {
    const dir = path.join(symbiotes, ADDON_FOLDER_NAME);
    const st = await fsp.lstat(dir).catch(() => null);
    if (!st?.isDirectory() || st.isSymbolicLink()) return null;
    const m = manifestSchema.safeParse(await readJson(path.join(dir, "manifest.json")));
    return m.success && this.ours(m.data, await this.bundledManifest()) ? m.data : null;
  }

  private async elsewhere(current: string | null): Promise<AddonStatus["elsewhere"]> {
    for (const other of (await this.d.others?.()) ?? []) {
      if (current !== null && pathKey(other) === pathKey(current)) continue;
      const m = await this.oursIn(other);
      if (m) return { folder: other, version: m.version };
    }
    return null;
  }

  async status(): Promise<AddonStatus> {
    const b = await this.bundledManifest();
    const { found, tried } = await this.d.locate();
    const base: AddonStatus = {
      state: "not_found",
      folder: found?.path ?? null,
      folderSource: found?.source ?? null,
      tried,
      folderWarning: found?.source === "manual" ? folderWarning(found.path) : null,
      elsewhere: await this.elsewhere(found?.path ?? null),
      addonPath: null,
      bundledVersion: b.version,
      installedVersion: null,
      mismatch: [],
      update: { ...this.update },
      prompt: { show: false, reason: null },
      checkedAt: this.now(),
    };
    if (!found) return base;
    const dir = path.join(found.path, ADDON_FOLDER_NAME);
    const st = await fsp.stat(dir).catch(() => null);
    if (!st) return { ...base, state: "missing" };
    if (!st.isDirectory()) return { ...base, state: "foreign", addonPath: dir };
    const m = manifestSchema.safeParse(await readJson(path.join(dir, "manifest.json")));
    if (!m.success || !this.ours(m.data, b)) return { ...base, state: "foreign", addonPath: dir };
    const installed = { ...base, addonPath: dir, installedVersion: m.data.version };
    if (newer(b.version, m.data.version)) {
      const dismissed = this.d.dismissed() === b.version;
      return { ...installed, state: "outdated", prompt: { show: !dismissed, reason: this.whyNotUpdated() } };
    }
    const cfg = configSchema.safeParse(await readJson(path.join(dir, LINK_CONFIG_FILE)));
    const want = this.d.pairing();
    const mismatch: AddonStatus["mismatch"] = [];
    if (!cfg.success || cfg.data.token !== want.token) mismatch.push("token");
    if (!cfg.success || cfg.data.port !== want.port) mismatch.push("port");
    return { ...installed, state: mismatch.length ? "mismatch" : "installed", mismatch };
  }

  private whyNotUpdated(): string {
    if (this.update.state === "failed")
      return `${this.update.automatic ? "Updating it by itself" : "The last update"} failed: ${this.update.error ?? "unknown"}`;
    if (this.autoChecked) return "An older copy was put in the Symbiotes folder after Slabyrinth started.";
    return "Slabyrinth has not tried to update it yet.";
  }

  /**
   * At start: update an installed, older copy of ours. Never installs, never downgrades, never touches a foreign
   * folder, never throws. Returns the status after.
   */
  async autoUpdate(): Promise<AddonStatus> {
    const s = await this.status();
    if (s.state !== "outdated" || !s.addonPath) {
      this.autoChecked = true;
      return s;
    }
    await this.copy(s.addonPath, { writeConfig: false, automatic: true, from: s.installedVersion });
    this.autoChecked = true;
    return this.status();
  }

  /** The user's install, update or reinstall. Throws a plain Error when there is nowhere to put it. */
  async install(): Promise<AddonStatus> {
    const s = await this.status();
    if (s.state === "not_found" || !s.folder)
      throw new AppFailure("not_found", "TaleSpire's Symbiotes folder wasn't found.");
    if (s.state === "foreign")
      throw new AppFailure(
        "validation",
        `${ADDON_FOLDER_NAME} in the Symbiotes folder belongs to another add-on, so Slabyrinth won't write into it.`,
      );
    const dir = path.join(s.folder, ADDON_FOLDER_NAME);
    await this.copy(dir, { writeConfig: true, automatic: false, from: s.installedVersion });
    return this.status();
  }

  /**
   * Removes our add-on's folder from a Symbiotes folder (the one in use, or `elsewhere`'s): only a real folder (not a
   * link or junction) directly inside it, holding our manifest. It is first renamed to a hidden name beside it, so a
   * file in use stops it before anything is deleted; the hidden copy is then deleted. Nothing else is touched.
   */
  async uninstall(elsewhere: boolean): Promise<AddonStatus> {
    const s = await this.status();
    const symbiotes = elsewhere ? (s.elsewhere?.folder ?? null) : s.folder;
    if (symbiotes === null) throw new AppFailure("not_found", "There is no add-on to remove there.");
    const dir = await this.ownFolder(symbiotes);
    const hidden = path.join(symbiotes, `.${ADDON_FOLDER_NAME}.removing-${randomBytes(4).toString("hex")}`);
    const removal = this.d.removal ?? nodeRemoval;
    try {
      await removal.rename(dir, hidden);
    } catch (err) {
      this.d.logger.warn("add-on removal failed", { error: err });
      throw new AppFailure("io", `The add-on could not be removed: ${plainReason(err)}`);
    }
    try {
      await removal.rm(hidden);
    } catch (err) {
      this.d.logger.warn("add-on removal left files", { error: err });
      throw new AppFailure(
        "io",
        `The add-on is gone from TaleSpire's list, but some files are left in ${hidden}. Delete that folder after closing TaleSpire.`,
      );
    }
    this.d.logger.info("add-on removed", { elsewhere });
    return this.status();
  }

  /** The add-on folder in `symbiotes`, checked safe to delete; refuses (validation) anything else. */
  private async ownFolder(symbiotes: string): Promise<string> {
    const dir = path.join(symbiotes, ADDON_FOLDER_NAME);
    const st = await fsp.lstat(dir).catch(() => null);
    if (!st) throw new AppFailure("not_found", "The add-on isn't installed there.");
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new AppFailure("validation", `${dir} is a link or not a folder, so Slabyrinth won't delete it.`);
    const [parent, real] = await Promise.all([fsp.realpath(symbiotes), fsp.realpath(dir)]);
    if (pathKey(path.dirname(real)) !== pathKey(parent))
      throw new AppFailure(
        "validation",
        `${dir} points outside the Symbiotes folder, so Slabyrinth won't delete it.`,
      );
    if (!(await this.oursIn(symbiotes)))
      throw new AppFailure("validation", `${dir} belongs to another add-on, so Slabyrinth won't delete it.`);
    return dir;
  }

  /** A paired copy under userData, for "install it by hand". Returns its folder. */
  async preparePackage(): Promise<string> {
    const dir = path.join(this.d.packageDir, ADDON_FOLDER_NAME);
    await this.copyFiles(dir, true);
    return dir;
  }

  private async copy(
    dir: string,
    o: { writeConfig: boolean; automatic: boolean; from: string | null },
  ): Promise<void> {
    const b = await this.bundledManifest();
    try {
      await this.copyFiles(dir, o.writeConfig);
      this.update = {
        state: "updated",
        automatic: o.automatic,
        from: o.from,
        to: b.version,
        at: this.now(),
        error: null,
      };
      this.d.logger.info("add-on installed", { automatic: o.automatic, from: o.from, to: b.version });
    } catch (err) {
      const error = plainReason(err);
      this.update = {
        state: "failed",
        automatic: o.automatic,
        from: o.from,
        to: b.version,
        at: this.now(),
        error,
      };
      this.d.logger.warn("add-on install failed", { automatic: o.automatic, error: err });
      if (!o.automatic) throw new AppFailure("io", error);
    }
  }

  /** Copies the bundled files into `dir` (manifest.json last), and the pairing file when asked. */
  private async copyFiles(dir: string, writeConfig: boolean): Promise<void> {
    // README.md is the developers' notes (not shipped in a packaged app either; electron-builder.yml)
    const files = (await listFiles(this.d.bundledDir)).filter(
      (f) => f !== LINK_CONFIG_FILE && f !== "README.md",
    );
    const ordered = [...files.filter((f) => f !== "manifest.json"), "manifest.json"];
    await fsp.mkdir(dir, { recursive: true });
    if (writeConfig)
      await replaceFile(path.join(dir, LINK_CONFIG_FILE), `${JSON.stringify(this.d.pairing(), null, 2)}\n`);
    for (const f of ordered)
      await replaceFile(path.join(dir, f), await fsp.readFile(path.join(this.d.bundledDir, f)));
  }
}
