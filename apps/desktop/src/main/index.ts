import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, nativeImage } from "electron";
import { createAppServices, type AppServices } from "./app";
import { windowIconPath } from "./appIcon";
import { APP_ID } from "./appIdentity";
import { FIXTURE_PLAN } from "./fixturePlan";
import { createFileLogger } from "./logger";
import { makeAppPaths } from "./paths";
import { installSecurityPolicy } from "./security";
import { isSmokeRun, runSmoke } from "./smoke";
import { createMainWindow, rendererUrl } from "./window";

/**
 * Electron main entry (WP5): error boundary, single-instance lock, file association, services,
 * the one secure window, orderly shutdown (final autosave) and the smoke path.
 * Smoke (SLABYRINTH_SMOKE=1) and e2e (SLABYRINTH_E2E=1) runs are hidden, use a throwaway userData
 * folder (or SLABYRINTH_USER_DATA) and inert doubles for every outside effect (see app.ts).
 */
const devServerUrl = !app.isPackaged ? process.env["ELECTRON_RENDERER_URL"] : undefined;
const isDev = !app.isPackaged;
const smoke = isSmokeRun();
const safeMode = smoke || process.env["SLABYRINTH_E2E"] === "1";
const hidden = safeMode;

if (safeMode) {
  const dir =
    process.env["SLABYRINTH_USER_DATA"] ?? fs.mkdtempSync(path.join(os.tmpdir(), "slabyrinth-run-"));
  app.setPath("userData", dir);
}

const paths = makeAppPaths({
  userData: app.getPath("userData"),
  documents: app.getPath("documents"),
  projectsFolderOverride: safeMode ? path.join(app.getPath("userData"), "Projects") : undefined,
});
/** The main-only `debugLogging` feature flag (settings.json "x-featureFlags"), read before the logger exists. */
function debugLoggingFlag(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.settingsFile, "utf8")) as Partial<
      Record<"x-featureFlags", Partial<Record<"debugLogging", unknown>> | null>
    >;
    return raw["x-featureFlags"]?.debugLogging === true;
  } catch {
    return false;
  }
}
const logger = createFileLogger({
  dir: paths.logs,
  minLevel: isDev || debugLoggingFlag() ? "debug" : "info",
});
const appVersion = app.getVersion();

let services: AppServices | null = null;
let started = false;
let quitting = false;

function fatal(err: unknown): void {
  logger.error("fatal startup error", { error: err });
  if (hidden) process.stderr.write(`SMOKE_FAIL fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  else
    dialog.showErrorBox(
      "Slabyrinth couldn't start",
      `Something went wrong while starting. Details are in the log:\n${paths.logs}`,
    );
  app.exit(1);
}

// Error boundary for the main process: log everything; only startup failures are fatal.
process.on("uncaughtException", (err) => {
  logger.error("uncaught exception", { error: err });
  if (!started) fatal(err);
});
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", { error: reason });
});

function projectArg(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (a.toLowerCase().endsWith(".slabyrinth") && fs.existsSync(a)) return path.resolve(a);
  }
  return null;
}

function openFromArgs(argv: string[]): void {
  const file = projectArg(argv);
  if (!file || !services) return;
  services.projects.open({ path: file }, true).catch((err: unknown) => {
    logger.warn("open from file association failed", { error: err });
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  installSecurityPolicy(isDev && devServerUrl !== undefined);
  // Windows: match the AppUserModelID the installer gives the shortcuts, so the running window groups
  // under the pinned/Start-menu icon (Electron's default is "electron.app.Slabyrinth"). Dev runs keep
  // the default so they don't merge with an installed copy.
  if (process.platform === "win32" && app.isPackaged) app.setAppUserModelId(APP_ID);

  app.on("second-instance", (_event, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    openFromArgs(argv);
  });

  void app
    .whenReady()
    .then(async () => {
      logger.info("starting", {
        version: appVersion,
        packaged: app.isPackaged,
        platform: process.platform,
        safeMode,
      });
      services = await createAppServices({ paths, logger, isDev, safeMode, appVersion });
      const s = services;
      const win = createMainWindow({
        show: !hidden,
        devServerUrl,
        stateFile: safeMode ? undefined : paths.windowState,
      });
      s.attachWindow(win, rendererUrl(devServerUrl));

      const file = projectArg(process.argv);
      if (file) openFromArgs(process.argv);
      else if (!safeMode && s.settings.get().ui.onLaunch === "last_project") {
        const last = s.settings.get().projects.recent[0];
        if (last !== undefined && fs.existsSync(last)) {
          s.projects.open({ path: last }, true).catch((err: unknown) => {
            logger.warn("reopen last project failed", { error: err });
          });
        }
      }

      // Asset library check in the background: never blocks startup (decisions: non-blocking).
      void s.catalog
        .startup()
        .then(() => (!safeMode && s.settings.flag("watchTaleSpire") ? s.catalog.watch() : undefined))
        .catch((err: unknown) => {
          logger.warn("catalog startup failed", { error: err });
        });

      // Update notice: one background check a few seconds after startup, at most daily, packaged builds only
      // (never in smoke/e2e runs except the e2e test build's canned response). Shows a chip; never a dialog.
      setTimeout(
        () => {
          s.startUpdateCheck(app.isPackaged);
        },
        safeMode ? 0 : 5000,
      );

      started = true;

      if (smoke) {
        runSmoke(win, [
          () => {
            // the compiler is always core's (the only backend); the engine must be the real one
            const line = `engine=${s.engineKind} compile=core`;
            if (app.isPackaged && s.engineKind !== "real")
              throw new Error(`packaged build is not wired to the real engine (${line})`);
            return Promise.resolve(line);
          },
          () => {
            // Palettes and orientation are compiled into core: no data folder is needed or shipped.
            const n = s.palettes.list().filter((p) => p.source === "bundled").length;
            if (n === 0) throw new Error("no bundled palettes");
            return Promise.resolve(`palettes=${String(n)} user=${paths.userPalettes}`);
          },
          () => {
            // The window icon resolves and decodes (from the asar in a packaged build). Windows also
            // checks the Linux PNG, so a path problem shows up there too; nativeImage reads .ico only
            // on Windows, so Linux checks just its own PNG.
            const platforms: NodeJS.Platform[] =
              process.platform === "win32" ? ["win32", "linux"] : ["linux"];
            const sizes = platforms.map((p) => {
              const file = windowIconPath(p);
              const img = nativeImage.createFromPath(file);
              if (img.isEmpty()) throw new Error(`window icon for ${p} is empty or missing: ${file}`);
              const { width, height } = img.getSize();
              return `${p}=${path.basename(file)}@${String(width)}x${String(height)}`;
            });
            return Promise.resolve(`icon ${sizes.join(" ")}`);
          },
          () => {
            // Test-only code (the scripted e2e provider) must not be in this bundle. The marker is
            // assembled at run time so this check itself doesn't put it into the bundle.
            const testMarker = ["SLABYRINTH", "TEST", "ONLY", "E2E", "PROVIDER"].join("-");
            const mainDir = path.dirname(fileURLToPath(import.meta.url));
            const files = [
              ...fs.readdirSync(mainDir).map((n) => path.join(mainDir, n)),
              ...(fs.existsSync(path.join(mainDir, "chunks"))
                ? fs.readdirSync(path.join(mainDir, "chunks")).map((n) => path.join(mainDir, "chunks", n))
                : []),
            ].filter((f) => f.endsWith(".js"));
            const leaked = files.filter(
              (f) => /e2eProvider/i.test(path.basename(f)) || fs.readFileSync(f, "utf8").includes(testMarker),
            );
            if (__SLABYRINTH_TEST_BUILD__ || leaked.length > 0) {
              if (app.isPackaged)
                throw new Error(`test-only code in the packaged app: ${leaked.join(", ") || "test build"}`);
              return Promise.resolve("test-code=present (test build)");
            }
            return Promise.resolve(`test-code=absent (${String(files.length)} main files checked)`);
          },
          async () => {
            // Proves the compile worker loads from the packaged app (asar).
            const est = await s.build.estimate(FIXTURE_PLAN);
            return `worker=ok estimate.levels=${String(est.perLevel.length)}`;
          },
          async () => {
            const r = await s.dispatch("app:getInfo", rendererUrl(devServerUrl), undefined);
            if (!r.ok) throw new Error("ipc dispatch failed");
            return "ipc=ok";
          },
          async () => {
            // Chat is wired: with no API key the real engine answers the typed "no_api_key" state
            // (never "unsupported"), without any network call. Throwaway userData: nothing persists.
            if (s.engineKind !== "real") return `chat=skipped (engine=${s.engineKind})`;
            const url = rendererUrl(devServerUrl);
            const created = await s.dispatch("project:new", url, { name: "Smoke" });
            if (!created.ok) throw new Error(`project:new failed: ${created.error.code}`);
            const r = await s.dispatch("chat:send", url, { text: "smoke" });
            if (r.ok || r.error.code !== "no_api_key")
              throw new Error(`chat:send without a key answered ${r.ok ? "ok" : r.error.code}`);
            return "chat=no_api_key";
          },
        ]);
      }
    })
    .catch(fatal);

  app.on("before-quit", (event) => {
    if (quitting || !services) return;
    event.preventDefault();
    quitting = true;
    void services
      .shutdown()
      .catch((err: unknown) => {
        logger.error("shutdown failed", { error: err });
      })
      .finally(() => {
        logger.info("stopped");
        app.quit();
      });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
