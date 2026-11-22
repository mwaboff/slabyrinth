/**
 * The app's effects on the outside world, as the services take them: dialogs, the clipboard, opening links and
 * folders, the trash, and what the TaleSpire lookup reads (the Steam locator's files and commands, the process
 * probe). `safeMode` (smoke and e2e runs) swaps every one for an inert double: no TaleSpire lookup/launch/focus,
 * memory clipboard, no dialogs, a trash folder under the user data.
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { clipboard, dialog, shell, type BrowserWindow } from "electron";
import type { Logger } from "../logger";
import { ClipboardService, memoryClipboard } from "../services/clipboardService";
import { cancelAllDialogs, type Dialogs } from "../services/dialogs";
import { nodeReadonlyFs, type LocatorEnv } from "../services/talespire/steamLocator";
import type { ProcessProbe } from "../services/talespire/taleSpireService";

/** A command's time limit, and its output limit, when the app runs one (registry and process queries). */
const EXEC_TIMEOUT_MS = 10_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;
/** The Steam locator's commands get a shorter limit: a slow registry query must not hold up the start. */
const LOCATOR_TIMEOUT_MS = 5000;

export interface OutsideWorld {
  dialogs: Dialogs;
  clipboard: ClipboardService;
  openExternal: (url: string) => Promise<void>;
  /** Opens a folder in the system's file manager ("" on success, as Electron's shell.openPath). */
  openPath: (dir: string) => Promise<string>;
  trashItem: (file: string) => Promise<void>;
  showItemInFolder: (file: string) => void;
  locator: LocatorEnv;
  probe: ProcessProbe;
}

export function outsideWorld(
  opts: { safeMode: boolean; userData: string; logger: Logger },
  getWindow: () => BrowserWindow | null,
): OutsideWorld {
  return opts.safeMode ? inertWorld(opts.userData, opts.logger) : realWorld(getWindow);
}

function realWorld(getWindow: () => BrowserWindow | null): OutsideWorld {
  return {
    dialogs: electronDialogs(getWindow),
    clipboard: new ClipboardService(clipboard),
    openExternal: (url) => shell.openExternal(url),
    openPath: (dir) => shell.openPath(dir),
    trashItem: (file) => shell.trashItem(file),
    showItemInFolder: (file) => {
      shell.showItemInFolder(file);
    },
    locator: {
      platform: process.platform,
      homedir: os.homedir(),
      execFile: (f, a) => execFileP(f, a, { timeoutMs: LOCATOR_TIMEOUT_MS }),
      fs: nodeReadonlyFs,
    },
    probe: {
      execFile: execFileP,
      listProcDirs: () => fsp.readdir("/proc").catch(() => []),
      readCmdline: (pid) =>
        fsp.readFile(`/proc/${pid}/cmdline`, "utf8").then(
          (s) => s.replace(/\0/g, " "),
          () => null,
        ),
      env: process.env,
    },
  };
}

function inertWorld(userData: string, logger: Logger): OutsideWorld {
  const memory = memoryClipboard();
  // Safe mode only (e2e/smoke): lets a Playwright spec read `.last` via electronApp.evaluate.
  (globalThis as { __slabyrinthClipboard?: typeof memory }).__slabyrinthClipboard = memory;
  return {
    dialogs: cancelAllDialogs,
    clipboard: new ClipboardService(memory),
    openExternal: (url) => {
      logger.info("safe mode: openExternal suppressed", { scheme: url.split(":")[0] });
      return Promise.resolve();
    },
    openPath: () => Promise.resolve(""),
    trashItem: async (file) => {
      const dir = path.join(userData, "trash");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.rename(file, path.join(dir, `${String(Date.now())}-${path.basename(file)}`));
    },
    showItemInFolder: () => undefined,
    locator: inertLocator,
    probe: inertProbe,
  };
}

const execFileP = (
  file: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<{ stdout: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: opts?.timeoutMs ?? EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER },
      (err, stdout) => {
        if (err) reject(new Error(err.message, { cause: err }));
        else resolve({ stdout });
      },
    );
  });

function electronDialogs(getWindow: () => BrowserWindow | null): Dialogs {
  const parent = (): BrowserWindow | undefined => getWindow() ?? undefined;
  return {
    async openFile(o) {
      const opts = {
        title: o.title,
        filters: o.filters,
        properties: ["openFile" as const],
        ...(o.defaultPath ? { defaultPath: o.defaultPath } : {}),
      };
      const w = parent();
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    async saveFile(o) {
      const opts = { title: o.title, defaultPath: o.defaultPath, filters: o.filters };
      const w = parent();
      const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    async chooseFolder(o) {
      const opts = {
        title: o.title,
        properties: ["openDirectory" as const, "createDirectory" as const],
        ...(o.defaultPath ? { defaultPath: o.defaultPath } : {}),
      };
      const w = parent();
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    async confirm(o) {
      const opts = {
        type: "question" as const,
        title: o.title,
        message: o.message,
        buttons: [o.okLabel, o.cancelLabel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        ...(o.detail ? { detail: o.detail } : {}),
      };
      const w = parent();
      const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
      return r.response === 0;
    },
  };
}

const disabled = (): Promise<never> => Promise.reject(new Error("disabled in safe mode"));

const inertLocator: LocatorEnv = {
  platform: process.platform,
  homedir: os.homedir(),
  execFile: disabled,
  fs: {
    stat: () => Promise.resolve(null),
    readFile: disabled,
    readText: disabled,
    listDir: () => Promise.resolve([]),
  },
};

const inertProbe: ProcessProbe = {
  execFile: disabled,
  listProcDirs: () => Promise.resolve([]),
  readCmdline: () => Promise.resolve(null),
  env: {},
};
