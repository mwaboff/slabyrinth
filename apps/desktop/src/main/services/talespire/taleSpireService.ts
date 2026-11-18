import * as path from "node:path";
import type { IpcRequests } from "../../../shared/ipc";
import type { Logger } from "../../logger";
import type { ClipboardService } from "../clipboardService";
import type { SettingsStore } from "../settingsStore";
import { locateTaleSpireViaSteam, TALESPIRE_APP_ID, validateInstall, type LocatorEnv } from "./steamLocator";

/**
 * TaleSpireService (architecture §6.6, talespire-assets.md §10): locate the install, detect whether
 * the game runs WITHOUT touching it, and "Copy & open TaleSpire":
 *   1. write the slab to the clipboard (main);
 *   2. running → try to bring its window forward (Windows: WScript.Shell.AppActivate(pid);
 *      Linux X11: wmctrl/xdotool), else "focus_unavailable" (Alt+Tab hint);
 *   3. not running → launch through Steam (steam://rungameid/720620) — never the exe directly,
 *      never a talespire:// URL.
 */
export const STEAM_LAUNCH_URL = `steam://rungameid/${TALESPIRE_APP_ID}`;
const TALESPIRE_ASSET_URL =
  /^talespire:\/\/asset\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProcessProbe {
  /** Run a program without a shell. Rejects on non-zero exit. */
  execFile(file: string, args: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string }>;
  listProcDirs(): Promise<string[]>;
  readCmdline(pid: string): Promise<string | null>;
  env: NodeJS.ProcessEnv;
}

export interface TaleSpireDeps {
  platform: NodeJS.Platform;
  locator: LocatorEnv;
  probe: ProcessProbe;
  settings: SettingsStore;
  clipboard: ClipboardService;
  openExternal: (url: string) => Promise<void>;
  logger: Logger;
}

export type CopyAndOpenResult = IpcRequests["talespire:copyAndOpen"]["res"];

export class TaleSpireService {
  private located: string[] | null = null;

  constructor(private readonly deps: TaleSpireDeps) {}

  /** Install folders: settings override first (if still valid), then Steam libraries. Cached. */
  async locate(refresh = false): Promise<IpcRequests["talespire:locate"]["res"]> {
    const found: IpcRequests["talespire:locate"]["res"]["found"] = [];
    const override = this.deps.settings.get().talespire.installPath;
    if (override !== null && (await validateInstall(this.deps.locator, override)).valid) {
      found.push({ path: override, source: "settings" });
    }
    if (this.located === null || refresh) {
      try {
        this.located = await locateTaleSpireViaSteam(this.deps.locator);
      } catch (err) {
        this.deps.logger.warn("steam lookup failed", { error: err });
        this.located = [];
      }
    }
    for (const p of this.located) {
      if (!found.some((f) => samePath(f.path, p, this.deps.platform)))
        found.push({ path: p, source: "steam" });
    }
    return { found };
  }

  async resolveInstall(): Promise<string | null> {
    return (await this.locate()).found[0]?.path ?? null;
  }

  /** Checks a folder against core's install rule without saving it (dialog:pickFolder). */
  async checkInstall(
    dir: string,
  ): Promise<
    | { path: string; valid: true }
    | { path: string; valid: false; reason: "not_found" | "not_talespire"; message: string }
  > {
    const v = await validateInstall(this.deps.locator, dir);
    if (v.valid) return { path: v.path, valid: true };
    return {
      path: v.path,
      valid: false,
      reason: v.code ?? "not_talespire",
      message: v.reason ?? "That folder isn't a TaleSpire install.",
    };
  }

  async setPath(dir: string | null): Promise<{ valid: boolean; reason?: string }> {
    if (dir === null) {
      await this.deps.settings.updateInternal((s) => {
        s.talespire.installPath = null;
        return s;
      });
      return { valid: true };
    }
    const v = await validateInstall(this.deps.locator, dir);
    if (!v.valid) return v.reason === undefined ? { valid: false } : { valid: false, reason: v.reason };
    await this.deps.settings.updateInternal((s) => {
      s.talespire.installPath = v.path;
      return s;
    });
    this.deps.logger.info("talespire path set", { path: v.path });
    return { valid: true };
  }

  /** Detects the game process (read-only: tasklist / /proc). */
  async isRunning(): Promise<{ running: boolean; pids: number[] }> {
    try {
      if (this.deps.platform === "win32") {
        const { stdout } = await this.deps.probe.execFile(
          "tasklist",
          ["/FI", "IMAGENAME eq TaleSpire.exe", "/FO", "CSV", "/NH"],
          { timeoutMs: 5000 },
        );
        const pids: number[] = [];
        for (const line of stdout.split(/\r?\n/)) {
          const m = /^"TaleSpire\.exe","(\d+)"/i.exec(line.trim());
          if (m?.[1] !== undefined) pids.push(Number(m[1]));
        }
        return { running: pids.length > 0, pids };
      }
      if (this.deps.platform === "linux") {
        const pids: number[] = [];
        for (const d of await this.deps.probe.listProcDirs()) {
          if (!/^\d+$/.test(d)) continue;
          const cmd = await this.deps.probe.readCmdline(d);
          if (cmd !== null && /TaleSpire\.exe/i.test(cmd) && !/TaleSpireUrlRelay/i.test(cmd))
            pids.push(Number(d));
        }
        return { running: pids.length > 0, pids };
      }
    } catch (err) {
      this.deps.logger.info("process probe failed", { error: err });
    }
    return { running: false, pids: [] };
  }

  /** Best effort; true only when the OS reported success. */
  private async focus(pids: number[]): Promise<boolean> {
    const { probe, platform } = this.deps;
    try {
      if (platform === "win32") {
        for (const pid of pids) {
          if (!Number.isInteger(pid) || pid <= 0) continue;
          const { stdout } = await probe.execFile(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              `(New-Object -ComObject WScript.Shell).AppActivate(${String(pid)})`,
            ],
            { timeoutMs: 5000 },
          );
          if (/true/i.test(stdout)) return true;
        }
        return false;
      }
      if (platform === "linux") {
        // Wayland does not let one app raise another's window.
        if (probe.env["WAYLAND_DISPLAY"] && !probe.env["DISPLAY"]) return false;
        try {
          await probe.execFile("wmctrl", ["-a", "TaleSpire"], { timeoutMs: 3000 });
          return true;
        } catch {
          await probe.execFile("xdotool", ["search", "--name", "^TaleSpire$", "windowactivate"], {
            timeoutMs: 3000,
          });
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  async copyAndOpen(text: string): Promise<CopyAndOpenResult> {
    try {
      this.deps.clipboard.writeText(text);
    } catch (err) {
      this.deps.logger.error("clipboard write failed", { error: err });
      return {
        copied: false,
        running: false,
        action: "failed",
        message: "Couldn't copy the slab to the clipboard.",
      };
    }
    const { running, pids } = await this.isRunning();
    if (running) {
      const focused = await this.focus(pids);
      return focused
        ? { copied: true, running, action: "focused", message: "In TaleSpire, press Ctrl+V in build mode." }
        : {
            copied: true,
            running,
            action: "focus_unavailable",
            message: "Switch to TaleSpire (Alt+Tab) and press Ctrl+V.",
          };
    }
    const install = await this.resolveInstall();
    if (install === null) {
      return {
        copied: true,
        running,
        action: "not_installed",
        message: "Paste it in TaleSpire with Ctrl+V in build mode.",
      };
    }
    try {
      await this.deps.openExternal(STEAM_LAUNCH_URL);
      return {
        copied: true,
        running,
        action: "launched",
        message: "Starting TaleSpire… Open your board, switch to build mode, and press Ctrl+V.",
      };
    } catch (err) {
      this.deps.logger.warn("steam launch failed", { error: err });
      return {
        copied: true,
        running,
        action: "failed",
        message:
          "Slab copied, but TaleSpire didn't start. Start it from Steam, then press Ctrl+V in build mode.",
      };
    }
  }

  /** Only "talespire://asset/<uuid>" and the Steam launch URL. */
  async openUrl(url: string): Promise<{ opened: boolean }> {
    if (url !== STEAM_LAUNCH_URL && !TALESPIRE_ASSET_URL.test(url)) return { opened: false };
    try {
      await this.deps.openExternal(url);
      return { opened: true };
    } catch {
      return { opened: false };
    }
  }
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string): string =>
    platform === "win32" ? path.win32.normalize(p).toLowerCase() : path.posix.normalize(p);
  return norm(a) === norm(b);
}
