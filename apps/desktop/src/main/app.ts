import * as fs from "node:fs";
import { Worker } from "node:worker_threads";
import { safeStorage, type BrowserWindow } from "electron";
import type { MapPlan } from "@slabyrinth/core";
import type { SizeTierId } from "@slabyrinth/core/plan";
import { planRules } from "@slabyrinth/core/resolve";
import { activeSizeTier } from "../shared/sizeTier";
import type { EngineKind } from "./engineWiring";
import type { Dispatch } from "./ipc/router";
import type { Logger } from "./logger";
import type { AppPaths } from "./paths";
import { createCoreCatalogReader } from "./ports/catalog";
import { createPlanCorePort, type PlanCorePort } from "./ports/core";
import type { ConversationEngine } from "./ports/engine";
import { BuildPalettes } from "./services/buildPalettes";
import { BuildService } from "./services/buildService";
import { CompileService } from "./services/compileService";
import type { EmitEvent } from "./services/events";
import { ExportService } from "./services/exportService";
import { ImageBridge } from "./services/imageBridge";
import { PaletteService } from "./services/paletteService";
import { ProjectService } from "./services/projectService";
import { SecretStore } from "./services/secretStore";
import { SettingsStore } from "./services/settingsStore";
import { CatalogService } from "./services/talespire/catalogService";
import { TaleSpireService } from "./services/talespire/taleSpireService";
import { TaleSpireLinkService } from "./services/talespire/link/linkService";
import { DEFAULT_LINK_PORT } from "./services/talespire/link/protocol";
import type { UpdateService } from "./services/updateService";
import { cleanupTempFiles } from "./util/atomicWrite";
import { startEngine } from "./wiring/engine";
import { installMenu, wireIpc } from "./wiring/ipcAndMenu";
import { outsideWorld, type OutsideWorld } from "./wiring/outsideWorld";
import { runShutdown } from "./wiring/shutdown";
import { thumbnailRefresher } from "./wiring/thumbnails";
import { startUpdates } from "./wiring/updates";
import { WindowLink } from "./wiring/windowLink";

/**
 * Composition root: builds every main-process service, wires the engine port, the IPC router,
 * the menu and the image bridge. `safeMode` (smoke and e2e runs) swaps every effect on the outside
 * world for an inert double: no TaleSpire lookup/launch/focus, memory clipboard, no dialogs (wiring/outsideWorld.ts).
 *
 * createAppServices is the list of steps; each step builds one group of services from the ones before it. The
 * wiring/ files hold the steps that are more than a constructor call.
 */
export interface AppContext {
  paths: AppPaths;
  logger: Logger;
  isDev: boolean;
  safeMode: boolean;
  appVersion: string;
  /** The bundled TaleSpire add-on (resources in a packaged app, the repo's symbiotes folder in development). */
  addonDir: string;
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
  /** The TaleSpire add-on and its link (started in the background). */
  link: TaleSpireLinkService;
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

export async function createAppServices(ctx: AppContext): Promise<AppServices> {
  const { paths, logger, safeMode } = ctx;
  const link = new WindowLink();
  const emit = link.emit;
  const { settings, secrets } = await startSettings(ctx, emit);
  const outside = outsideWorld({ safeMode, userData: paths.userData, logger }, link.getWindow);
  void cleanupTempFiles(settings.get().projects.folder);
  // The map size tier plans are held to: the setting, raised to what the open project's plan needs (shared/sizeTier.ts).
  const openPlan = { current: (): MapPlan | null => null };
  const sizeTier = (): SizeTierId => activeSizeTier(settings.get().mapSize, openPlan.current());
  const assets = await startAssets(ctx, emit, settings, outside, sizeTier);
  const projects = startProjects(ctx, emit, settings, assets.core, outside);
  openPlan.current = () => projects.getPlan();
  const work = startBuildWork(ctx, emit, settings, projects, assets, outside, sizeTier);
  const { updates, startUpdateCheck } = startUpdates({
    appVersion: ctx.appVersion,
    safeMode,
    settings,
    logger,
    emit,
  });
  const { engine, engineKind } = await startEngine({
    isDev: ctx.isDev,
    safeMode,
    logger,
    emit,
    settings,
    secrets,
    projects,
    ...assets,
    ...work,
  });
  link.onPlanChanged(thumbnailRefresher(projects, work.imageBridge));
  const talespireLink = startTaleSpireLink(ctx, emit, settings, projects, work.build, outside);
  const dispatch = wireIpc(
    {
      appInfo: {
        version: ctx.appVersion,
        platform: process.platform as "win32" | "linux" | "darwin",
        userDataPath: paths.userData,
      },
      settings,
      secrets,
      projects,
      engine: () => engine,
      catalog: assets.catalog,
      talespire: assets.talespire,
      clipboard: outside.clipboard,
      build: work.build,
      exporter: work.exporter,
      palettes: assets.palettes,
      buildPalettes: assets.buildPalettes,
      dialogs: outside.dialogs,
      openExternal: outside.openExternal,
      updates,
      link: talespireLink,
      logger: logger.child("ipc"),
    },
    work.imageBridge,
    link.isTrusted,
    logger.child("ipc"),
  );
  installMenu({ emit, projects, paths, isDev: ctx.isDev });

  return {
    settings,
    secrets,
    projects,
    palettes: assets.palettes,
    catalog: assets.catalog,
    talespire: assets.talespire,
    ...work,
    updates,
    link: talespireLink,
    startUpdateCheck,
    engine,
    engineKind,
    dispatch,
    attachWindow(win, url) {
      link.attach(win, url);
      // a copy of the add-on installed by hand shows up when the user comes back to the app
      win.on("focus", () => {
        void talespireLink.recheck();
      });
    },
    // the final save first; every other step has a time limit (wiring/shutdown.ts)
    shutdown: () =>
      runShutdown({
        halt: [
          () => {
            assets.catalog.unwatch();
          },
          () => {
            work.imageBridge.cancelAll();
          },
          () => {
            work.compiler.cancel();
          },
        ],
        save: () => projects.close({}),
        releaseLock: () => {
          projects.releaseLockSync(fs.unlinkSync);
        },
        steps: [
          { name: "talespire link", run: () => talespireLink.shutdown() },
          { name: "engine", run: () => engine?.dispose() },
        ],
        logger,
      }),
  };
}

/** Settings (loaded, changes sent to the renderer) and the secret store. */
async function startSettings(
  ctx: AppContext,
  emit: EmitEvent,
): Promise<{ settings: SettingsStore; secrets: SecretStore }> {
  const { paths, logger } = ctx;
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
  return { settings, secrets };
}

interface Assets {
  palettes: PaletteService;
  talespire: TaleSpireService;
  catalog: CatalogService;
  /** The build's palettes: everything that resolves a plan resolves against them (services/buildPalettes.ts). */
  buildPalettes: BuildPalettes;
  /** Plan validation, `materialize` and history replay in this process, with rules from the build palettes. */
  core: PlanCorePort;
}

/**
 * Palettes (loaded), TaleSpire, the asset catalog, the build's palettes and the plan core port. The renderer is told
 * when the build palettes change (after palettes load and after each catalog check); it fetches them.
 */
async function startAssets(
  ctx: AppContext,
  emit: EmitEvent,
  settings: SettingsStore,
  outside: OutsideWorld,
  sizeTier: () => SizeTierId,
): Promise<Assets> {
  const { paths, logger } = ctx;
  // Set once the build palettes exist (below): tells the renderer when they change.
  let announcePalettes: () => void = () => undefined;
  const palettes = new PaletteService({
    userDir: paths.userPalettes,
    orientationOverride: paths.orientationOverride,
    logger: logger.child("palettes"),
    openPath: outside.openPath,
    onLoaded: () => {
      announcePalettes();
    },
  });
  await palettes.load();
  const talespire = new TaleSpireService({
    platform: process.platform,
    locator: outside.locator,
    probe: outside.probe,
    settings,
    clipboard: outside.clipboard,
    openExternal: outside.openExternal,
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
  const buildPalettes = new BuildPalettes({ palettes, catalog });
  const core = createPlanCorePort(() => planRules(buildPalettes.current(), { sizeTier: sizeTier() }));
  let announcedKey: string | null = null;
  announcePalettes = () => {
    const { key } = buildPalettes.data();
    if (key === announcedKey) return;
    announcedKey = key;
    emit("palettes:changed", { key });
  };
  return { palettes, talespire, catalog, buildPalettes, core };
}

function startProjects(
  ctx: AppContext,
  emit: EmitEvent,
  settings: SettingsStore,
  core: PlanCorePort,
  outside: OutsideWorld,
): ProjectService {
  return new ProjectService({
    settings,
    core,
    dialogs: outside.dialogs,
    emit,
    logger: ctx.logger.child("projects"),
    appVersion: ctx.appVersion,
    trashItem: outside.trashItem,
    showItemInFolder: outside.showItemInFolder,
  });
}

/**
 * The TaleSpire add-on and its link: listens on 127.0.0.1 (the real port; an ephemeral one in safe mode), updates an
 * installed older add-on, and looks at its install status every few seconds. Safe mode looks only at the test folder
 * named by SLABYRINTH_TEST_SYMBIOTES_DIR (never a real TaleSpire folder) and never registers a real hotkey.
 */
function startTaleSpireLink(
  ctx: AppContext,
  emit: EmitEvent,
  settings: SettingsStore,
  projects: ProjectService,
  build: BuildService,
  outside: OutsideWorld,
): TaleSpireLinkService {
  const { paths, safeMode, logger } = ctx;
  const env = process.env;
  const service = new TaleSpireLinkService({
    port: safeMode ? 0 : DEFAULT_LINK_PORT,
    tokenFile: paths.linkTokenFile,
    bundledDir: ctx.addonDir,
    packageDir: paths.addonPackage,
    folderEnv: {
      platform: outside.locator.platform,
      homedir: outside.locator.homedir,
      fs: outside.locator.fs,
    },
    testSymbiotesDir: safeMode ? (env["SLABYRINTH_TEST_SYMBIOTES_DIR"] ?? null) : null,
    settings,
    registrar: outside.hotkeys,
    wayland:
      process.platform === "linux" && (env["XDG_SESSION_TYPE"] === "wayland" || !!env["WAYLAND_DISPLAY"]),
    build,
    projects,
    dialogs: outside.dialogs,
    openPath: outside.openPath,
    emit,
    logger: logger.child("talespire-link"),
  });
  void service.start().then(() => {
    service.watch();
  });
  return service;
}

interface BuildWork {
  compiler: CompileService;
  build: BuildService;
  exporter: ExportService;
  imageBridge: ImageBridge;
}

/** The compile worker, builds, exports and the image bridge. */
function startBuildWork(
  ctx: AppContext,
  emit: EmitEvent,
  settings: SettingsStore,
  projects: ProjectService,
  assets: Assets,
  outside: OutsideWorld,
  sizeTier: () => SizeTierId,
): BuildWork {
  const { logger } = ctx;
  const workerUrl = new URL("./compile.worker.js", import.meta.url);
  const compiler = new CompileService({
    // a 1024 × 1024 build peaks near 2.6 GB (docs/internal/handoff-size-tiers.md): give each worker a 4 GB heap; every
    // request gets its own worker, so a resolve and a compile of one big map never share one
    spawn: () => new Worker(workerUrl, { resourceLimits: { maxOldGenerationSizeMb: 4096 } }),
    emit,
    logger: logger.child("compile"),
  });
  const build = new BuildService({
    projects,
    compiler,
    palettes: assets.palettes,
    catalog: assets.catalog,
    settings,
    sizeTier,
    dialogs: outside.dialogs,
    logger: logger.child("build"),
  });
  const exporter = new ExportService({
    projects,
    dialogs: outside.dialogs,
    clipboard: outside.clipboard,
    logger: logger.child("export"),
    documentsFolder: () => settings.get().projects.folder,
  });
  return { compiler, build, exporter, imageBridge: new ImageBridge(emit) };
}
