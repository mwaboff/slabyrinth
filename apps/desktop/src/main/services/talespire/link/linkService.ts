/**
 * TaleSpire add-on and link (the addon:* and link:* channels): the add-on's install status (addon.ts), the link server
 * (linkServer.ts) with its hotkeys, the pairing token, and "send this build to the add-on".
 *
 * Events: "addon:changed" when the install status changes (main looks again on window focus and on a timer, so a copy
 * installed by hand shows up), "link:changed" on every link change. Both are sent only when something changed.
 */
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { AddonStatus, LinkStatus } from "../../../../shared/ipc";
import type { Logger } from "../../../logger";
import { writeFileAtomic } from "../../../util/atomicWrite";
import { AppFailure } from "../../../util/errors";
import type { BuildService } from "../../buildService";
import type { Dialogs } from "../../dialogs";
import type { EmitEvent } from "../../events";
import type { ProjectService } from "../../projectService";
import type { SettingsStore } from "../../settingsStore";
import { AddonService, type LinkConfig } from "./addon";
import type { HotkeyRegistrar } from "./hotkeys";
import { LinkServer } from "./linkServer";
import { LINK_MAX_CHARS, MAX_CHUNKS, type ChunkSet } from "./protocol";
import { findSymbiotesFolder, type FolderEnv } from "./symbiotesFolder";

/** How often the add-on's install status is looked at again (also on window focus). */
export const ADDON_RECHECK_MS = 10_000;

export interface LinkServiceDeps {
  /** The listener's port: DEFAULT_LINK_PORT, or 0 (ephemeral) in tests and e2e runs. */
  port: number;
  /** Where this install keeps its pairing token (under userData). */
  tokenFile: string;
  bundledDir: string;
  packageDir: string;
  folderEnv: FolderEnv;
  /** Test and e2e runs only: the one Symbiotes folder to look at (never a real TaleSpire folder). */
  testSymbiotesDir: string | null;
  settings: SettingsStore;
  registrar: HotkeyRegistrar;
  wayland: boolean;
  build: Pick<BuildService, "chunksForSend">;
  projects: Pick<ProjectService, "getProject">;
  dialogs: Dialogs;
  openPath: (dir: string) => Promise<string>;
  emit: EmitEvent;
  logger: Logger;
}

const tokenFileSchema = z.object({ token: z.string().regex(/^[0-9a-f]{32,128}$/) });

/** A chunk set's size and levels from a build record (cells covered, levels placed). */
function setShape(record: Awaited<ReturnType<BuildService["chunksForSend"]>>["record"]): {
  size?: { w: number; h: number };
  levels: number;
} {
  let w = 0;
  let h = 0;
  for (const l of record.levels)
    for (const c of l.chunks) {
      w = Math.max(w, c.region.x1);
      h = Math.max(h, c.region.y1);
    }
  const levels = Math.max(1, Math.min(100, record.levels.length));
  return w >= 1 && h >= 1 && w <= 10_000 && h <= 10_000 ? { size: { w, h }, levels } : { levels };
}

export class TaleSpireLinkService {
  private token: string | null = null;
  private readonly server: LinkServer;
  private readonly addon: AddonService;
  private lastAddon = "";
  private lastLink = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: LinkServiceDeps) {
    this.server = new LinkServer({
      port: d.port,
      token: () => this.token,
      registrar: d.registrar,
      wayland: d.wayland,
      logger: d.logger.child("link"),
      onChange: (s) => {
        this.emitLink(s);
      },
    });
    this.addon = new AddonService({
      bundledDir: d.bundledDir,
      packageDir: d.packageDir,
      pairing: () => this.pairing(),
      locate: () => this.locate(),
      dismissed: () => d.settings.get().talespire.addonPromptDismissed,
      others: () => this.otherFolders(),
      logger: d.logger.child("addon"),
    });
  }

  /** The Symbiotes folder used before a change this run. */
  private previousFolder: string | null = null;

  /** Where another copy may be: the folder used before a change, and the detected one when a folder was chosen. */
  private async otherFolders(): Promise<string[]> {
    const out = this.previousFolder ? [this.previousFolder] : [];
    if (this.d.testSymbiotesDir === null && this.d.settings.get().talespire.symbiotesFolder) {
      const auto = await findSymbiotesFolder(this.d.folderEnv, null);
      if (auto.found) out.push(auto.found.path);
    }
    return out;
  }

  /** Loads or makes the pairing token, starts the listener, updates an installed older add-on. Never throws. */
  async start(): Promise<void> {
    try {
      this.token = await this.loadToken();
      await this.server.start();
    } catch (err) {
      this.d.logger.warn("link start failed", { error: err });
    }
    try {
      this.emitAddon(await this.addon.autoUpdate());
    } catch (err) {
      this.d.logger.warn("add-on check at start failed", { error: err });
    }
  }

  /** Looks at the add-on again now and every ADDON_RECHECK_MS. */
  watch(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.recheck();
    }, ADDON_RECHECK_MS);
    this.timer.unref();
  }

  /** Window focus, the timer: look again, tell the renderer when it changed. */
  async recheck(): Promise<void> {
    try {
      this.emitAddon(await this.addon.status());
    } catch (err) {
      this.d.logger.info("add-on recheck failed", { error: err });
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.server.close();
  }

  // ── add-on ──

  async addonStatus(): Promise<AddonStatus> {
    return this.emitAddon(await this.addon.status());
  }

  async install(): Promise<AddonStatus> {
    try {
      return this.emitAddon(await this.addon.install());
    } catch (err) {
      void this.recheck();
      throw err;
    }
  }

  /**
   * Native picker (or reset to automatic); a picked TaleSpire folder means its Symbiotes folder. A folder the app
   * cannot write in is refused; one that does not look like TaleSpire's is kept with a warning. A copy left in the
   * folder used before shows as AddonStatus.elsewhere (the UI offers to move it).
   */
  async chooseFolder(reset: boolean): Promise<AddonStatus | null> {
    const before = (await this.addon.status()).folder;
    let chosen: string | null = null;
    if (!reset) {
      const picked = await this.d.dialogs.chooseFolder({
        title: "Choose TaleSpire's Symbiotes folder",
        ...(before ? { defaultPath: before } : {}),
      });
      if (picked === null) return null;
      const inner = path.join(picked, "Symbiotes");
      chosen = (await fsp.stat(inner).catch(() => null))?.isDirectory() ? inner : picked;
      try {
        await fsp.access(chosen, fsConstants.W_OK);
      } catch {
        throw new AppFailure("validation", "Slabyrinth can't write in that folder. Choose another one.");
      }
    }
    await this.d.settings.updateInternal((s) => {
      s.talespire.symbiotesFolder = chosen;
      return s;
    });
    if (before !== null) this.previousFolder = before;
    return this.addonStatus();
  }

  /** Removes the add-on (or its copy elsewhere); the add-on's link drops and the hotkeys are released. */
  async uninstall(elsewhere: boolean): Promise<AddonStatus> {
    if (!elsewhere) this.server.command("unload");
    try {
      const s = await this.addon.uninstall(elsewhere);
      if (!elsewhere) this.server.dropHelper();
      return this.emitAddon(s);
    } catch (err) {
      void this.recheck();
      throw err;
    }
  }

  async openFolder(which: "installed" | "package"): Promise<{ opened: boolean; path: string | null }> {
    let dir: string | null;
    if (which === "package") dir = await this.addon.preparePackage();
    else {
      const s = await this.addon.status();
      dir = s.addonPath && s.state !== "foreign" ? s.addonPath : s.folder;
      if (dir) await fsp.mkdir(dir, { recursive: true }).catch(() => undefined);
    }
    if (!dir) return { opened: false, path: null };
    const err = await this.d.openPath(dir);
    return { opened: err === "", path: dir };
  }

  async dismissPrompt(version: string): Promise<AddonStatus> {
    await this.d.settings.updateInternal((s) => {
      s.talespire.addonPromptDismissed = version;
      return s;
    });
    return this.addonStatus();
  }

  // ── link ──

  linkStatus(): LinkStatus {
    return this.server.status();
  }

  /** Sends a build's chunks to the connected add-on. */
  async send(buildId: string): Promise<{ chunks: number }> {
    if (!this.server.connected)
      throw new AppFailure(
        "validation",
        "The TaleSpire add-on isn't connected. Open Slabyrinth Helper in TaleSpire.",
      );
    const { record, chunks } = await this.d.build.chunksForSend(buildId);
    if (chunks.length === 0) throw new AppFailure("validation", "This build has no chunks.");
    if (chunks.length > MAX_CHUNKS)
      throw new AppFailure(
        "validation",
        `This build has ${String(chunks.length)} chunks; the add-on takes ${String(MAX_CHUNKS)}.`,
      );
    // an empty slab crashes TaleSpire's slab spawn: never send one (the add-on refuses them too)
    const empty = chunks.find((c) => c.assetCount <= 0);
    if (empty)
      throw new AppFailure(
        "validation",
        `Chunk ${empty.id} has no assets, and TaleSpire crashes on an empty slab. Build again.`,
      );
    const name =
      (this.d.projects.getProject()?.name ?? "Slabyrinth map").trim().slice(0, 200) || "Slabyrinth map";
    const set: ChunkSet = {
      format: "slabyrinth-chunks",
      version: 1,
      name,
      ...setShape(record),
      chunks: chunks.map((c) => ({ label: `${c.label} (${c.id})`.slice(0, 200), slab: c.slab })),
    };
    if (JSON.stringify(set).length > LINK_MAX_CHARS - 1024)
      throw new AppFailure("validation", "This build is too big to send to the add-on in one go.");
    this.server.load(set, buildId);
    return { chunks: chunks.length };
  }

  /** Empties the add-on and releases the hotkeys. */
  stop(): void {
    this.server.command("unload");
  }

  // ── internals ──

  private pairing(): LinkConfig {
    if (this.token === null) throw new Error("the pairing token is not loaded yet");
    return { port: this.d.port === 0 ? this.server.port : this.d.port, token: this.token };
  }

  private async locate(): Promise<Awaited<ReturnType<typeof findSymbiotesFolder>>> {
    const manual = this.d.settings.get().talespire.symbiotesFolder ?? null;
    const test = this.d.testSymbiotesDir;
    if (manual === null && test !== null) {
      // safe mode's locator reads nothing; the test folder is a real temp folder
      const exists = (await fsp.stat(test).catch(() => null))?.isDirectory() === true;
      return { found: exists ? { path: test, source: "default" } : null, tried: [test] };
    }
    return findSymbiotesFolder(this.d.folderEnv, manual);
  }

  private async loadToken(): Promise<string> {
    try {
      const raw: unknown = JSON.parse(await fsp.readFile(this.d.tokenFile, "utf8"));
      const t = tokenFileSchema.safeParse(raw);
      if (t.success) return t.data.token;
    } catch {
      // none yet, or unreadable: make a new one (the add-on is then paired again on its next install)
    }
    const token = randomBytes(24).toString("hex");
    await fsp.mkdir(path.dirname(this.d.tokenFile), { recursive: true });
    await writeFileAtomic(this.d.tokenFile, `${JSON.stringify({ token })}\n`);
    return token;
  }

  private emitAddon(s: AddonStatus): AddonStatus {
    const key = JSON.stringify({ ...s, checkedAt: null });
    if (key !== this.lastAddon) {
      this.lastAddon = key;
      this.d.emit("addon:changed", s);
    }
    return s;
  }

  private emitLink(s: LinkStatus): void {
    const key = JSON.stringify(s);
    if (key === this.lastLink) return;
    this.lastLink = key;
    this.d.emit("link:changed", s);
  }
}
