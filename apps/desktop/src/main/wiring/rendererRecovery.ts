/**
 * When the window's renderer dies (out of memory on a big map, or a crash), the window is reloaded with
 * `?recovered=oom|crash`, and the renderer says so in plain words (renderer/app/recovered.ts). Project state lives in
 * main, so a reload loses nothing. Repeated crashes never loop: past `maxReloads` in `windowMs` the GM is asked
 * whether to reload once more or close Slabyrinth.
 */
import type { BrowserWindow, RenderProcessGoneDetails } from "electron";
import type { Logger } from "../logger";
import type { Dialogs } from "../services/dialogs";

/** Decides, crash by crash, whether to reload by itself. */
export function crashPolicy(
  windowMs = 120_000,
  maxReloads = 2,
): {
  onGone(reason: RenderProcessGoneDetails["reason"], now: number): "reload" | "ask" | "ignore";
  reset(): void;
} {
  let recent: number[] = [];
  return {
    onGone(reason, now) {
      // a clean exit is the window closing, not a crash
      if (reason === "clean-exit") return "ignore";
      recent = recent.filter((t) => now - t < windowMs);
      recent.push(now);
      return recent.length > maxReloads ? "ask" : "reload";
    },
    reset() {
      recent = [];
    },
  };
}

/** The renderer URL to reload with, saying why. */
export function recoveredUrl(rendererUrl: string, reason: RenderProcessGoneDetails["reason"]): string {
  const u = new URL(rendererUrl);
  u.searchParams.set("recovered", reason === "oom" ? "oom" : "crash");
  return u.href;
}

export function watchRenderer(
  win: BrowserWindow,
  rendererUrl: string,
  deps: { logger: Logger; dialogs: Dialogs; now?: () => number },
): void {
  const policy = crashPolicy();
  const now = deps.now ?? Date.now;
  const reload = (reason: RenderProcessGoneDetails["reason"]): void => {
    if (!win.isDestroyed()) void win.loadURL(recoveredUrl(rendererUrl, reason));
  };
  win.webContents.on("render-process-gone", (_e, details) => {
    const what = policy.onGone(details.reason, now());
    deps.logger.error("renderer gone", { reason: details.reason, exitCode: details.exitCode, then: what });
    if (what === "reload") reload(details.reason);
    else if (what === "ask")
      void deps.dialogs
        .confirm({
          title: "Slabyrinth",
          message:
            details.reason === "oom"
              ? "Slabyrinth keeps running out of memory showing this map."
              : "Slabyrinth's window keeps stopping.",
          detail:
            "Your work is saved. Close other programs and reload, or close Slabyrinth. For maps this big, a smaller Maximum map size in Settings helps.",
          okLabel: "Reload",
          cancelLabel: "Close Slabyrinth",
        })
        .then((again) => {
          if (again) {
            policy.reset();
            reload(details.reason);
          } else if (!win.isDestroyed()) win.close();
        });
  });
}
