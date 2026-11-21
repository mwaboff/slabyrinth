import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { Worker } from "node:worker_threads";
import { clipboard, dialog, ipcMain, Menu, safeStorage, shell, type BrowserWindow } from "electron";
import { planRules } from "@slabyrinth/core/resolve";
import type { IpcEvents } from "../shared/ipc";
import { resolveApiKey, selectEngine, type EngineKind } from "./engineWiring";
import { createDispatcher, makeSenderCheck, registerIpc, type Dispatch } from "./ipc/router";
import { createHandlers } from "./ipc/handlers";
import { requestSchemas, sendSchemas } from "./ipc/schemas";
import type { Logger } from "./logger";
import { buildMenuTemplate } from "./menu";
import type { AppPaths } from "./paths";
import { createCoreCatalogReader } from "./ports/catalog";
import { createPlanCorePort } from "./ports/core";
import type { ConversationEngine, EngineHost } from "./ports/engine";
import { BuildPalettes } from "./services/buildPalettes";
import { BuildService } from "./services/buildService";
import { ClipboardService, memoryClipboard } from "./services/clipboardService";
import { CompileService } from "./services/compileService";
import { cancelAllDialogs, type Dialogs } from "./services/dialogs";
import type { EmitEvent } from "./services/events";
import { ExportService } from "./services/exportService";
import { ImageBridge } from "./services/imageBridge";
import { PaletteService } from "./services/paletteService";
import { ProjectService } from "./services/projectService";
import { SecretStore } from "./services/secretStore";
import { SettingsStore } from "./services/settingsStore";
import { CatalogService } from "./services/talespire/catalogService";
import { nodeReadonlyFs, type LocatorEnv } from "./services/talespire/steamLocator";
import { TaleSpireService, type ProcessProbe } from "./services/talespire/taleSpireService";
import { UpdateService, type FetchLike } from "./services/updateService";
import { cleanupTempFiles } from "./util/atomicWrite";

/**
 * Composition root: builds every main-process service, wires the engine port, the IPC router,
 * the menu and the image bridge. `safeMode` (smoke and e2e runs) swaps every effect on the outside
 * world for an inert double: no TaleSpire lookup/launch/focus, memory clipboard, no dialogs.
 */
export interface AppContext {
  paths: AppPaths;
  logger: Logger;
  isDev: boolean;
  safeMode: boolean;
  appVersion: string;
}

export interface AppServices {
  settings: SettingsStore;
  secrets: SecretStore;
  projects: ProjectService;
  palettes: PaletteService;
  catalog: CatalogService;
  talespire: TaleSpireService;
  compiler: CompileService;
  build: BuildService;
  exporter: ExportService;
  imageBridge: ImageBridge;
  updates: UpdateService;
  /** Starts the background update check when it may run (packaged, not safe mode, daily, autoCheck on). */
  startUpdateCheck(packaged: boolean): void;
  engine: ConversationEngine | null;
  /** "none" only when construction failed (logged); chat then answers "internal". */
  engineKind: EngineKind | "none";
  dispatch: Dispatch;
  /** Routes events to this window and trusts IPC only from `rendererUrl`. */
  attachWindow(win: BrowserWindow, rendererUrl: string): void;
  shutdown(): Promise<void>;
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
      { windowsHide: true, timeout: opts?.timeoutMs ?? 10_000, maxBuffer: 4 * 1024 * 1024 },
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

const inertLocator: LocatorEnv = {
  platform: process.platform,
  homedir: os.homedir(),
  execFile: () => Promise.reject(new Error("disabled in safe mode")),
  fs: {
    stat: () => Promise.resolve(null),
    readFile: () => Promise.reject(new Error("disabled in safe mode")),
    readText: () => Promise.reject(new Error("disabled in safe mode")),
    listDir: () => Promise.resolve([]),
  },
};

const inertProbe: ProcessProbe = {
  execFile: () => Promise.reject(new Error("disabled in safe mode")),
  listProcDirs: () => Promise.resolve([]),
  readCmdline: () => Promise.resolve(null),
  env: {},
};

export async function createAppServices(ctx: AppContext): Promise<AppServices> {
  const { paths, logger, safeMode } = ctx;
  let window: BrowserWindow | null = null;
  const send = (channel: string, payload: unknown): void => {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };
  let afterPlanChanged: () => void = () => undefined;
  const emit: EmitEvent = (channel, payload) => {
    send(channel, payload);
    if (channel === "plan:changed") afterPlanChanged();
  };

  // ── settings & secrets
  const settings = new SettingsStore({
    file: paths.settingsFile,
    defaultProjectsFolder: paths.defaultProjectsFolder,
    logger: logger.child("settings"),
  });
  await settings.load();
  settings.onChange((s) => {
    emit("settings:changed", s);
  });
  const secrets = new SecretStore({
    file: paths.secretFile,
    safeStorage,
    platform: process.platform,
    logger: logger.child("secrets"),
    knownProviders: ["anthropic"],
  });

  const dialogs = safeMode ? cancelAllDialogs : electronDialogs(() => window);
  let clipboardService: ClipboardService;
  if (safeMode) {
    const memory = memoryClipboard();
    // Safe mode only (e2e/smoke): lets a Playwright spec read `.last` via electronApp.evaluate.
    (globalThis as { __slabyrinthClipboard?: typeof memory }).__slabyrinthClipboard = memory;
    clipboardService = new ClipboardService(memory);
  } else {
    clipboardService = new ClipboardService(clipboard);
  }
  const openExternal = safeMode
    ? (url: string): Promise<void> => {
        logger.info("safe mode: openExternal suppressed", { scheme: url.split(":")[0] });
        return Promise.resolve();
      }
    : (url: string): Promise<void> => shell.openExternal(url);

  void cleanupTempFiles(settings.get().projects.folder);

  // ── palettes, TaleSpire, catalog
  // Set once the build palettes exist (below): tells the renderer when they change.
  let announcePalettes: () => void = () => undefined;
  const palettes = new PaletteService({
    userDir: paths.userPalettes,
    orientationOverride: paths.orientationOverride,
    logger: logger.child("palettes"),
    openPath: safeMode ? () => Promise.resolve("") : (dir) => shell.openPath(dir),
    onLoaded: () => {
      announcePalettes();
    },
  });
  await palettes.load();

  const locator: LocatorEnv = safeMode
    ? inertLocator
    : {
        platform: process.platform,
        homedir: os.homedir(),
        execFile: (f, a) => execFileP(f, a, { timeoutMs: 5000 }),
        fs: nodeReadonlyFs,
      };
  const probe: ProcessProbe = safeMode
    ? inertProbe
    : {
        execFile: execFileP,
        listProcDirs: () => fsp.readdir("/proc").catch(() => []),
        readCmdline: (pid) =>
          fsp.readFile(`/proc/${pid}/cmdline`, "utf8").then(
            (s) => s.replace(/\0/g, " "),
            () => null,
          ),
        env: process.env,
      };
  const talespire = new TaleSpireService({
    platform: process.platform,
    locator,
    probe,
    settings,
    clipboard: clipboardService,
    openExternal,
    logger: logger.child("talespire"),
  });

  const reader = createCoreCatalogReader();
  logger.info("catalog reader", { kind: reader.kind });
  const catalog = new CatalogService({
    catalogFile: paths.catalogFile,
    reader,
    resolveInstall: () => talespire.resolveInstall(),
    palettes: () => palettes.palettes(),
    emit,
    logger: logger.child("catalog"),
    suppressWarning: () => settings.get().suppressAssetWarning,
    onScanned: async (at) => {
      await settings.updateInternal((s) => {
        s.talespire.lastScanAt = at;
        return s;
      });
    },
    onChecked: () => {
      announcePalettes();
    },
  });

  // ── the build's palettes: everything that resolves a plan resolves against them (services/buildPalettes.ts).
  // Plan validation, `materialize` and history replay in this process get their rules from them (the core port
  // below); the renderer fetches them.
  const buildPalettes = new BuildPalettes({ palettes, catalog });

  // ── core ports
  const core = createPlanCorePort(() => planRules(buildPalettes.current()));

  // ── projects
  const projects = new ProjectService({
    settings,
    core,
    dialogs,
    emit,
    logger: logger.child("projects"),
    appVersion: ctx.appVersion,
    trashItem: safeMode
      ? async (file) => {
          const dir = path.join(paths.userData, "trash");
          await fsp.mkdir(dir, { recursive: true });
          await fsp.rename(file, path.join(dir, `${String(Date.now())}-${path.basename(file)}`));
        }
      : (file) => shell.trashItem(file),
    showItemInFolder: safeMode
      ? () => undefined
      : (file) => {
          shell.showItemInFolder(file);
        },
  });
  let announcedKey: string | null = null;
  announcePalettes = () => {
    const { key } = buildPalettes.data();
    if (key === announcedKey) return;
    announcedKey = key;
    emit("palettes:changed", { key });
  };

  // ── compile worker
  // The fake compiler is a dev aid only: packaged builds ignore the flag.
  const compileBackend: "core" | "fake" = ctx.isDev && settings.flag("fakeCompile") ? "fake" : "core";
  logger.info("compile backend", { backend: compileBackend });
  const workerUrl = new URL("./compile.worker.js", import.meta.url);
  const compiler = new CompileService({
    spawn: () => new Worker(workerUrl),
    backend: compileBackend,
    emit,
    logger: logger.child("compile"),
  });
  const build = new BuildService({
    projects,
    compiler,
    palettes,
    catalog,
    settings,
    dialogs,
    logger: logger.child("build"),
  });
  const exporter = new ExportService({
    projects,
    dialogs,
    clipboard: clipboardService,
    logger: logger.child("export"),
    documentsFolder: () => settings.get().projects.folder,
  });
  const imageBridge = new ImageBridge(emit);

  // ── update notice: GitHub latest release (main only). The e2e TEST BUILD may inject a canned response file
  // (SLABYRINTH_E2E_UPDATE_RESPONSE, safe mode only); production bundles drop that branch at build time.
  let updateFetch: FetchLike | undefined;
  let forceUpdateCheck = false;
  if (__SLABYRINTH_TEST_BUILD__ && safeMode) {
    const canned = process.env["SLABYRINTH_E2E_UPDATE_RESPONSE"] ?? "";
    if (canned !== "") {
      updateFetch = async () =>
        new Response(await fsp.readFile(canned, "utf8"), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      forceUpdateCheck = true;
    }
  }
  const updates = new UpdateService({
    currentVersion: ctx.appVersion,
    settings,
    logger: logger.child("updates"),
    ...(updateFetch ? { fetch: updateFetch } : {}),
    onAvailable: (status) => {
      emit("updates:available", status);
    },
  });

  // ── engine
  const host: EngineHost = {
    getProject: () => projects.getProject(),
    getPlan: (v) => (projects.isOpen ? projects.getPlan(v) : null),
    commitVersion: (i) => projects.commitVersion(i),
    moveHead: (v) => projects.moveHead(v),
    appendItems: (id, items, meta) => {
      projects.appendItems(id, items, meta);
    },
    updateConversation: (id, fn) => {
      projects.updateConversation(id, fn);
    },
    setBrief: (b) => {
      projects.setBrief(b);
    },
    setBusy: (t) => {
      if (projects.isOpen) projects.setBusy(t);
    },
    addSpend: (u, c) => {
      if (projects.isOpen) projects.addSpend(u, c);
      void settings.addSpend(u, c).catch(() => undefined);
    },
    emit: (e) => {
      emit("chat:event", e);
    },
    requestImage: (r, signal) => imageBridge.request(r, signal),
    // ANTHROPIC_API_KEY from the environment: development builds only, never in smoke/e2e runs (§6.5).
    getApiKey: async (id) =>
      resolveApiKey(await secrets.getApiKey(id), id, { isDev: ctx.isDev, safeMode, env: process.env }),
    getSettings: () => settings.get(),
    estimateCompile: async (plan, levels) =>
      compiler.backend === "none" ? null : build.estimate(plan, levels),
    getAssetCatalog: () => catalog.current(),
    getPalettes: () => palettes.palettes(),
    getBuildPalettes: () => buildPalettes.current(),
    flush: () => projects.flush(),
    logger: logger.child("engine"),
  };
  let engine: ConversationEngine | null = null;
  let engineKind: AppServices["engineKind"] = "none";
  try {
    const selected = await selectEngine({
      isDev: ctx.isDev,
      safeMode,
      env: process.env,
      fakeEngineFlag: settings.flag("fakeEngine"),
      applyOps: core.applyChecked,
    });
    engine = selected.factory(host);
    engineKind = selected.kind;
  } catch (err) {
    logger.error("engine construction failed", { error: err });
  }
  logger.info("conversation engine", { kind: engineKind });
  const eng = engine;
  projects.setEngineHooks(
    eng
      ? {
          onClosing: () => eng.onProjectClosing(),
          onOpened: () => {
            eng.onProjectOpened();
          },
          conversationDefaults: (sel) => eng.conversationDefaults(sel),
        }
      : null,
  );

  // Home thumbnails through the image bridge (best effort, after plan changes settle).
  let thumbTimer: NodeJS.Timeout | null = null;
  afterPlanChanged = () => {
    if (thumbTimer) clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => {
      const target = projects.thumbnailTarget();
      if (!target) return;
      const projectId = projects.getProject()?.id;
      imageBridge
        .request({ level: target.levelId, showIds: false, planVersion: target.version, maxPx: 320 })
        .then((png) => {
          if (projects.getProject()?.id === projectId)
            projects.setThumbnail(target.levelId, target.version, png);
        })
        .catch(() => undefined);
    }, 3000);
  };

  // ── IPC
  let isTrusted: (url: string) => boolean = () => false;
  const handlers = createHandlers({
    appInfo: {
      version: ctx.appVersion,
      platform: process.platform as "win32" | "linux" | "darwin",
      userDataPath: paths.userData,
    },
    settings,
    secrets,
    projects,
    engine: () => engine,
    catalog,
    talespire,
    clipboard: clipboardService,
    build,
    exporter,
    palettes,
    buildPalettes,
    dialogs,
    openExternal,
    updates,
    logger: logger.child("ipc"),
  });
  const dispatch = createDispatcher(handlers, requestSchemas, (url) => isTrusted(url), logger.child("ipc"));
  registerIpc(
    ipcMain,
    dispatch,
    {
      "render:imageResult": (r) => {
        imageBridge.handleResult(r);
      },
    },
    sendSchemas,
    (url) => isTrusted(url),
    logger.child("ipc"),
  );

  const menuCommand = (command: IpcEvents["menu:command"]["command"]): void => {
    emit("menu:command", { command });
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        command: menuCommand,
        flush: () => {
          void projects.flush().catch(() => undefined);
        },
        openDataFolder: () => {
          void shell.openPath(paths.userData);
        },
        openLogsFolder: () => {
          void shell.openPath(paths.logs);
        },
        isDev: ctx.isDev,
        platform: process.platform,
      }),
    ),
  );

  return {
    settings,
    secrets,
    projects,
    palettes,
    catalog,
    talespire,
    compiler,
    build,
    exporter,
    imageBridge,
    updates,
    startUpdateCheck(packaged) {
      void updates.startupCheck({ packaged, safeMode, force: forceUpdateCheck }).catch((err: unknown) => {
        logger.warn("update check failed", { error: err });
      });
    },
    engine,
    engineKind,
    dispatch,
    attachWindow(win, url) {
      window = win;
      isTrusted = makeSenderCheck(url);
    },
    async shutdown() {
      catalog.unwatch();
      imageBridge.cancelAll();
      compiler.cancel();
      try {
        await projects.close({});
      } catch (err) {
        logger.error("final save failed", { error: err });
        projects.releaseLockSync(fs.unlinkSync);
      }
      await engine?.dispose().catch(() => undefined);
    },
  };
}
