import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, screen } from "electron";
import { clampToDisplays, loadWindowState, saveWindowState, type WindowState } from "./windowState";

export interface MainWindowOptions {
  /** Show the window once it is ready. False for smoke and e2e runs. */
  show: boolean;
  /** Vite dev server URL (development only); otherwise the bundled index.html is loaded. */
  devServerUrl: string | undefined;
  /** userData/window-state.json; omitted = default size, nothing persisted. */
  stateFile?: string | undefined;
}

export const rendererIndexPath = (): string =>
  fileURLToPath(new URL("../renderer/index.html", import.meta.url));

/** The URL the renderer is loaded from (used for the IPC sender check). */
export function rendererUrl(devServerUrl: string | undefined): string {
  return devServerUrl ?? pathToFileURL(rendererIndexPath()).href;
}

/** Creates the single application window with the §6.5 webPreferences. */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  let state: WindowState = { width: 1280, height: 800, maximized: false };
  if (options.stateFile !== undefined) {
    state = clampToDisplays(
      loadWindowState(options.stateFile),
      screen.getAllDisplays().map((d) => d.workArea),
    );
  }
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 960,
    minHeight: 600,
    show: false,
    // No backgroundColor: colours come only from renderer theme tokens; the window is shown on
    // ready-to-show, after the first paint.
    title: "Slabyrinth",
    autoHideMenuBar: true,
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  });

  if (options.show) {
    win.once("ready-to-show", () => {
      if (state.maximized) win.maximize();
      win.show();
    });
  }

  if (options.stateFile !== undefined) {
    const file = options.stateFile;
    let timer: NodeJS.Timeout | null = null;
    const persist = (): void => {
      if (win.isDestroyed() || win.isMinimized()) return;
      const b = win.getNormalBounds();
      saveWindowState(file, {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        maximized: win.isMaximized(),
      });
    };
    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(persist, 500);
    };
    win.on("resize", schedule);
    win.on("move", schedule);
    win.on("close", () => {
      if (timer) clearTimeout(timer);
      persist();
    });
  }

  if (options.devServerUrl !== undefined) {
    void win.loadURL(options.devServerUrl);
  } else {
    void win.loadFile(rendererIndexPath());
  }
  return win;
}
