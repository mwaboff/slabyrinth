/**
 * The link between the services and the window, built before either exists: events go to the attached window (none
 * before `attach`), IPC is trusted only from the attached renderer URL, and a plan change runs the hook set once the
 * services that react to it exist.
 */
import type { BrowserWindow } from "electron";
import { makeSenderCheck } from "../ipc/router";
import type { EmitEvent } from "../services/events";

export class WindowLink {
  private window: BrowserWindow | null = null;
  private trusted: (url: string) => boolean = () => false;
  private planChanged: () => void = () => undefined;

  /** Sends an event to the window; "plan:changed" also runs the plan-change hook. */
  readonly emit: EmitEvent = (channel, payload) => {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, payload);
    if (channel === "plan:changed") this.planChanged();
  };

  /** Is IPC from this sender URL trusted (the attached renderer)? */
  readonly isTrusted = (url: string): boolean => this.trusted(url);

  readonly getWindow = (): BrowserWindow | null => this.window;

  /** Routes events to this window and trusts IPC only from `rendererUrl`. */
  attach(win: BrowserWindow, rendererUrl: string): void {
    this.window = win;
    this.trusted = makeSenderCheck(rendererUrl);
  }

  /** What runs after each "plan:changed" event (set once, when the services it uses exist). */
  onPlanChanged(fn: () => void): void {
    this.planChanged = fn;
  }
}
