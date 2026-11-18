import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryLogger } from "../../logger";
import { ClipboardService, memoryClipboard } from "../clipboardService";
import { SettingsStore } from "../settingsStore";
import { tempDir } from "../testing/helpers";
import type { LocatorEnv } from "./steamLocator";
import { STEAM_LAUNCH_URL, TaleSpireService, type ProcessProbe } from "./taleSpireService";

/**
 * Every OS effect is a double: these tests never run tasklist/PowerShell, never touch the real
 * clipboard and never open a URL (TaleSpire is running on the development machine).
 */
let dir: string;
beforeEach(async () => {
  dir = await tempDir("slab-ts-");
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

interface Rig {
  service: TaleSpireService;
  clip: ReturnType<typeof memoryClipboard>;
  opened: string[];
  execs: Array<{ file: string; args: string[] }>;
  settings: SettingsStore;
}

async function rig(opts: {
  platform?: NodeJS.Platform;
  installed?: boolean;
  tasklist?: string;
  activate?: string;
  procs?: Record<string, string>;
  openFails?: boolean;
  wayland?: boolean;
}): Promise<Rig> {
  const platform = opts.platform ?? "win32";
  const install = path.join(dir, "TaleSpire");
  if (opts.installed === true) {
    await fsp.mkdir(path.join(install, "Taleweaver"), { recursive: true });
  }
  const settings = new SettingsStore({
    file: path.join(dir, "settings.json"),
    defaultProjectsFolder: dir,
    logger: memoryLogger(),
  });
  await settings.load();
  if (opts.installed === true) {
    await settings.updateInternal((s) => {
      s.talespire.installPath = install;
      return s;
    });
  }
  const execs: Rig["execs"] = [];
  const probe: ProcessProbe = {
    execFile: (file, args) => {
      execs.push({ file, args });
      if (file === "tasklist")
        return Promise.resolve({
          stdout: opts.tasklist ?? "INFO: No tasks are running which match the specified criteria.\r\n",
        });
      if (file === "powershell.exe") return Promise.resolve({ stdout: opts.activate ?? "False\r\n" });
      if (file === "wmctrl") return Promise.reject(new Error("not installed"));
      if (file === "xdotool") return Promise.resolve({ stdout: "" });
      return Promise.reject(new Error(`unexpected ${file}`));
    },
    listProcDirs: () => Promise.resolve(Object.keys(opts.procs ?? {})),
    readCmdline: (pid) => Promise.resolve(opts.procs?.[pid] ?? null),
    env: opts.wayland === true ? { WAYLAND_DISPLAY: "wayland-0" } : { DISPLAY: ":0" },
  };
  const locator: LocatorEnv = {
    platform,
    homedir: dir,
    execFile: () => Promise.reject(new Error("no registry")),
    fs: {
      // Real temp folder only; never look at the real Steam install.
      stat: async (p) => {
        if (!p.startsWith(dir)) return null;
        try {
          const st = await fsp.stat(p);
          return { size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() };
        } catch {
          return null;
        }
      },
      readFile: () => Promise.reject(new Error("not used")),
      readText: () => Promise.reject(new Error("not used")),
      listDir: () => Promise.resolve([]),
    },
  };
  const clip = memoryClipboard();
  const opened: string[] = [];
  const service = new TaleSpireService({
    platform,
    locator,
    probe,
    settings,
    clipboard: new ClipboardService(clip),
    openExternal: (url) => {
      if (opts.openFails === true) return Promise.reject(new Error("no handler"));
      opened.push(url);
      return Promise.resolve();
    },
    logger: memoryLogger(),
  });
  return { service, clip, opened, execs, settings };
}

const RUNNING = '"TaleSpire.exe","4242","Console","1","1,234,567 K"\r\n';

describe("TaleSpireService.copyAndOpen", () => {
  it("not running, installed → copies, then launches through Steam (never the exe)", async () => {
    const r = await rig({ installed: true });
    const res = await r.service.copyAndOpen("H4sIAAAA");
    expect(res).toMatchObject({ copied: true, running: false, action: "launched" });
    expect(r.clip.last).toBe("H4sIAAAA");
    expect(r.opened).toEqual([STEAM_LAUNCH_URL]);
    expect(r.execs.map((e) => e.file)).toEqual(["tasklist"]);
  });

  it("running → focuses the window by pid (Windows)", async () => {
    const r = await rig({ installed: true, tasklist: RUNNING, activate: "True\r\n" });
    const res = await r.service.copyAndOpen("slab");
    expect(res).toMatchObject({ copied: true, running: true, action: "focused" });
    expect(r.opened).toEqual([]);
    expect(r.execs[1]?.args.join(" ")).toContain("AppActivate(4242)");
  });

  it("running but focusing fails → copied only with the Alt+Tab hint", async () => {
    const r = await rig({ installed: true, tasklist: RUNNING, activate: "False" });
    expect(await r.service.copyAndOpen("slab")).toMatchObject({
      action: "focus_unavailable",
      message: expect.stringContaining("Alt+Tab") as unknown,
    });
  });

  it("not installed → copied, nothing launched", async () => {
    const r = await rig({ installed: false });
    expect(await r.service.copyAndOpen("slab")).toMatchObject({ copied: true, action: "not_installed" });
    expect(r.opened).toEqual([]);
  });

  it("launch failure is reported after a successful copy", async () => {
    const r = await rig({ installed: true, openFails: true });
    expect(await r.service.copyAndOpen("slab")).toMatchObject({ copied: true, action: "failed" });
  });

  it("Linux: detects the Proton process from /proc and refuses to raise windows on Wayland", async () => {
    const procs = {
      "17": "/usr/bin/bash",
      "880": "Z:\\steamapps\\common\\TaleSpire\\TaleSpire.exe -foo",
      "900": "TaleSpireUrlRelay.exe x",
    };
    const x11 = await rig({ platform: "linux", installed: true, procs });
    expect(await x11.service.isRunning()).toEqual({ running: true, pids: [880] });
    expect((await x11.service.copyAndOpen("s")).action).toBe("focused"); // xdotool double succeeds
    const wl = await rig({ platform: "linux", installed: true, procs, wayland: true });
    expect((await wl.service.copyAndOpen("s")).action).toBe("focus_unavailable");
  });
});

describe("TaleSpireService paths and URLs", () => {
  it("setPath validates the folder and stores it", async () => {
    const r = await rig({});
    expect(await r.service.setPath(path.join(dir, "nope"))).toMatchObject({ valid: false });
    await fsp.mkdir(path.join(dir, "TS", "Taleweaver"), { recursive: true });
    expect(await r.service.setPath(path.join(dir, "TS"))).toEqual({ valid: true });
    expect(r.settings.get().talespire.installPath).toBe(path.join(dir, "TS"));
    expect((await r.service.locate()).found).toEqual([{ path: path.join(dir, "TS"), source: "settings" }]);
    expect(await r.service.setPath(null)).toEqual({ valid: true });
    expect(r.settings.get().talespire.installPath).toBeNull();
  });

  it("checkInstall applies core's install rule with a typed reason, without saving", async () => {
    const r = await rig({});
    expect(await r.service.checkInstall(path.join(dir, "nope"))).toMatchObject({
      valid: false,
      reason: "not_found",
    });
    await fsp.mkdir(path.join(dir, "Other"), { recursive: true });
    expect(await r.service.checkInstall(path.join(dir, "Other"))).toMatchObject({
      valid: false,
      reason: "not_talespire",
      message: expect.stringMatching(/TaleSpire/) as unknown,
    });
    await fsp.mkdir(path.join(dir, "TS", "Taleweaver"), { recursive: true });
    expect(await r.service.checkInstall(path.join(dir, "TS", "Taleweaver"))).toEqual({
      path: path.join(dir, "TS"),
      valid: true,
    });
    expect(r.settings.get().talespire.installPath).toBeNull();
  });

  it("openUrl accepts only the Steam launch URL and talespire://asset/<uuid>", async () => {
    const r = await rig({});
    expect(await r.service.openUrl("steam://rungameid/720620")).toEqual({ opened: true });
    expect(await r.service.openUrl("talespire://asset/0f3e2a1b-1111-4222-8333-444455556666")).toEqual({
      opened: true,
    });
    for (const bad of [
      "talespire://goto/1,2",
      "talespire://dice/d20",
      "steam://rungameid/1",
      "https://evil.example",
      "file:///C:/Windows/system32/calc.exe",
      "talespire://asset/x;calc",
    ]) {
      expect(await r.service.openUrl(bad)).toEqual({ opened: false });
    }
    expect(r.opened).toHaveLength(2);
  });
});
