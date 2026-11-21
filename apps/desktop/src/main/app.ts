import * as fs from "node:fs";
import { Worker } from "node:worker_threads";
import { safeStorage, type BrowserWindow } from "electron";
import { planRules } from "@slabyrinth/core/resolve";
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
import type { UpdateService } from "./services/updateService";
import { cleanupTempFiles } from "./util/atomicWrite";
import { startEngine } from "./wiring/engine";
import { installMenu, wireIpc } from "./wiring/ipcAndMenu";
import { outsideWorld, type OutsideWorld } from "./wiring/outsideWorld";
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

export async function createAppServices(ctx: AppContext): Promise<AppServices> {
  const { paths, logger, safeMode } = ctx;
  const link = new WindowLink();
  const emit = link.emit;
  const { settings, secrets } = await startSettings(ctx, emit);
  const outside = outsideWorld({ safeMode, userData: paths.userData, logger }, link.getWindow);
  void cleanupTempFiles(settings.get().projects.folder);
  const assets = await startAssets(ctx, emit, settings, outside);
  const projects = startProjects(ctx, emit, settings, assets.core, outside);
  const work = startBuildWork(ctx, emit, settings, projects, assets, outside);
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
    startUpdateCheck,
    engine,
    engineKind,
    dispatch,
    attachWindow(win, url) {
      link.attach(win, url);
    },
    async shutdown() {
      assets.catalog.unwatch();
      work.imageBridge.cancelAll();
      work.compiler.cancel();
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
  const core = createPlanCorePort(() => planRules(buildPalettes.current()));
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
): BuildWork {
  const { logger } = ctx;
  const workerUrl = new URL("./compile.worker.js", import.meta.url);
  const compiler = new CompileService({
    spawn: () => new Worker(workerUrl),
    emit,
    logger: logger.child("compile"),
  });
  const build = new BuildService({
    projects,
    compiler,
    palettes: assets.palettes,
    catalog: assets.catalog,
    settings,
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
