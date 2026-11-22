/**
 * Slabyrinth Helper in TaleSpire's Symbiotes folder: its status, install, update and the automatic update at start.
 *
 * - Install (and "update now", "reinstall") is the user's action: the bundled files are copied into
 *   `<Symbiotes>/slabyrinth-helper/` and the pairing file (port and token, LINK_CONFIG_FILE) is written beside them.
 * - At start an installed, older copy that is recognisably ours (same manifest name and website) is updated by itself;
 *   a missing one is never installed by itself; a newer one is never downgraded; a foreign folder of the same name is
 *   never written to.
 * - Install and update build the whole add-on in a hidden staging folder beside it (`.slabyrinth-helper.installing-*`,
 *   same volume; TaleSpire skips dot-folders), pairing file included, and then swap it in: the old folder is renamed to
 *   a hidden name, the staging folder takes its place, the old one is deleted. An install that stops part way leaves
 *   only a hidden folder, never a half-copy that reads as someone else's; an update is old or new, never a mix, and
 *   carries no stale files of an older version. A failed swap puts the old folder back. The pairing file is kept on an
 *   automatic update.
 * - Leftovers of an interrupted attempt (hidden folders of ours, recognised by name) are cleared on the next install,
 *   update or removal; an old copy left hidden by a swap that stopped between its two renames is put back first.
 *   Nothing else in the Symbiotes folder is touched.
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
  /** The pairing the installed copy must carry; null while the link has no token yet (never throws). */
  pairing: () => LinkConfig | null;
  /** The Symbiotes folder (manual choice first), and every path tried. */
  locate: () => Promise<{ found: FolderCandidate | null; tried: string[] }>;
  /** The bundled version whose prompt the user dismissed. */
  dismissed: () => string | undefined;
  /** Other Symbiotes folders where a copy may still be (the detected one, the one used before a change). */
  others?: () => Promise<string[]>;
  logger: Logger;
  now?: () => Date;
  /** The file operations that change folders (tests make them fail). */
  fileOps?: Partial<FileOps>;
}

export interface FileOps {
  rename: (from: string, to: string) => Promise<void>;
  rm: (dir: string) => Promise<void>;
  writeFile: (file: string, data: Buffer | string) => Promise<void>;
}

const nodeFileOps: FileOps = {
  rename: (from, to) => fsp.rename(from, to),
  rm: (dir) => fsp.rm(dir, { recursive: true }),
  writeFile: (file, data) => fsp.writeFile(file, data),
};

/** Our hidden working folders beside the add-on's: staging, an old copy being swapped out, one being removed. */
const LEFTOVER = new RegExp(
  `^\\.${ADDON_FOLDER_NAME.replace(/[-.]/g, "\\$&")}\\.(installing|old|removing)-[0-9a-f]{8}$`,
);

function hiddenName(kind: "installing" | "old" | "removing"): string {
  return `.${ADDON_FOLDER_NAME}.${kind}-${randomBytes(4).toString("hex")}`;
}

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

/** A rename of the add-on's folder that failed: on Windows a file in it is open (TaleSpire running, a virus scan). */
export function plainSwapReason(err: unknown): string {
  const code = isNodeError(err) ? err.code : undefined;
  if (code === "EPERM" || code === "EACCES" || code === "EBUSY")
    return "A file of the add-on is in use, or the folder can't be changed. Close TaleSpire and try again.";
  return plainReason(err);
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
    if (!cfg.success || want === null || cfg.data.token !== want.token) mismatch.push("token");
    if (!cfg.success || want === null || cfg.data.port !== want.port) mismatch.push("port");
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
    const found = (await this.d.locate()).found;
    if (found) await this.clearLeftovers(path.join(found.path, ADDON_FOLDER_NAME));
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
    const found = (await this.d.locate()).found;
    if (found) await this.clearLeftovers(path.join(found.path, ADDON_FOLDER_NAME));
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
    await this.clearLeftovers(dir);
    const hidden = path.join(symbiotes, hiddenName("removing"));
    const ops = this.ops();
    try {
      await ops.rename(dir, hidden);
    } catch (err) {
      this.d.logger.warn("add-on removal failed", { error: err });
      throw new AppFailure("io", `The add-on could not be removed: ${plainReason(err)}`);
    }
    try {
      await ops.rm(hidden);
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
    try {
      await this.stageAndSwap(dir, true);
    } catch (err) {
      throw new AppFailure("io", err instanceof CopyError ? err.reason : plainReason(err));
    }
    return dir;
  }

  private ops(): FileOps {
    return { ...nodeFileOps, ...this.d.fileOps };
  }

  /** Our manifest in `dir` (a real folder, not a link), or null. */
  private async oursAt(dir: string): Promise<boolean> {
    const st = await fsp.lstat(dir).catch(() => null);
    if (!st?.isDirectory() || st.isSymbolicLink()) return false;
    const m = manifestSchema.safeParse(await readJson(path.join(dir, "manifest.json")));
    return m.success && this.ours(m.data, await this.bundledManifest());
  }

  /**
   * Our hidden leftovers beside `dir` (the add-on folder) from an attempt that stopped: an old copy a swap left hidden
   * is put back when `dir` is missing; every other one is deleted. Only real folders named like ours. Never throws.
   */
  private async clearLeftovers(dir: string): Promise<void> {
    const parent = path.dirname(dir);
    const names = (await fsp.readdir(parent).catch(() => [] as string[])).filter((n) => LEFTOVER.test(n));
    const ops = this.ops();
    for (const name of names.sort()) {
      const p = path.join(parent, name);
      const st = await fsp.lstat(p).catch(() => null);
      if (!st?.isDirectory() || st.isSymbolicLink()) continue;
      try {
        const missing = (await fsp.lstat(dir).catch(() => null)) === null;
        if (name.includes(".old-") && missing && (await this.oursAt(p))) {
          await ops.rename(p, dir);
          this.d.logger.info("add-on: put back the copy an interrupted update left hidden");
        } else {
          await ops.rm(p);
          this.d.logger.info("add-on: cleared a leftover of an interrupted attempt", { name });
        }
      } catch (err) {
        this.d.logger.info("add-on: a leftover folder could not be cleared (tried again next time)", {
          name,
          error: err,
        });
      }
    }
  }

  /**
   * Builds the add-on in a hidden staging folder beside `dir` (the bundled files, and the pairing file: the current
   * pairing with `writeConfig`, else the one `dir` already has), then swaps it in by rename. A failure before the swap
   * leaves `dir` as it was; a failed swap puts the old folder back. Throws CopyError with a plain reason for a failed
   * swap, the file-system error for a failed copy.
   */
  private async stageAndSwap(dir: string, writeConfig: boolean): Promise<void> {
    const ops = this.ops();
    const parent = path.dirname(dir);
    await fsp.mkdir(parent, { recursive: true });
    await this.clearLeftovers(dir);
    let config: Buffer | string | null;
    if (writeConfig) {
      const pairing = this.d.pairing();
      if (pairing === null)
        throw new CopyError("Slabyrinth's link is still starting. Try again in a moment.");
      config = `${JSON.stringify(pairing, null, 2)}\n`;
    } else config = await fsp.readFile(path.join(dir, LINK_CONFIG_FILE)).catch(() => null);
    // README.md is the developers' notes (not shipped in a packaged app either; electron-builder.yml)
    const files = (await listFiles(this.d.bundledDir)).filter(
      (f) => f !== LINK_CONFIG_FILE && f !== "README.md",
    );
    const ordered = [...files.filter((f) => f !== "manifest.json"), "manifest.json"];
    const staging = path.join(parent, hiddenName("installing"));
    const dropStaging = (): Promise<void> =>
      fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    try {
      await fsp.mkdir(staging);
      if (config !== null) await ops.writeFile(path.join(staging, LINK_CONFIG_FILE), config);
      for (const f of ordered) {
        const target = path.join(staging, f);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await ops.writeFile(target, await fsp.readFile(path.join(this.d.bundledDir, f)));
      }
    } catch (err) {
      await dropStaging();
      throw err;
    }
    const old = (await fsp.lstat(dir).catch(() => null)) ? path.join(parent, hiddenName("old")) : null;
    if (old !== null)
      try {
        await ops.rename(dir, old);
      } catch (err) {
        await dropStaging();
        throw new CopyError(plainSwapReason(err), err);
      }
    try {
      await ops.rename(staging, dir);
    } catch (err) {
      if (old !== null)
        await ops.rename(old, dir).catch((e: unknown) => {
          // the next attempt puts it back (clearLeftovers)
          this.d.logger.warn("add-on: the old copy could not be put back yet", { error: e });
        });
      await dropStaging();
      throw new CopyError(plainSwapReason(err), err);
    }
    if (old !== null)
      await ops.rm(old).catch((err: unknown) => {
        this.d.logger.info("add-on: the replaced copy is left hidden; cleared next time", { error: err });
      });
  }

  private async copy(
    dir: string,
    o: { writeConfig: boolean; automatic: boolean; from: string | null },
  ): Promise<void> {
    const b = await this.bundledManifest();
    try {
      await this.stageAndSwap(dir, o.writeConfig);
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
      const error = err instanceof CopyError ? err.reason : plainReason(err);
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
}

/** An install step that failed, with its reason in plain words. */
class CopyError extends Error {
  constructor(
    readonly reason: string,
    cause?: unknown,
  ) {
    super(reason, { cause });
    this.name = "CopyError";
  }
}
