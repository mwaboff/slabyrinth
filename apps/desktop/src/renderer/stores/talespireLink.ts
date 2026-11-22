/**
 * The TaleSpire add-on and its link, as main reports them (addon:* and link:* channels, "addon:changed" and
 * "link:changed" events). Main does all the work; this store mirrors its state, runs the actions and keeps the last
 * failure of each for the UI. The selectors below are what the UI reads (docs/internal/handoff-talespire-link.md).
 */
import { create } from "zustand";
import type { AddonStatus, AppError, LinkStatus } from "../../shared/ipc";
import { tryCall } from "../bridge/client";

export type LinkAction =
  "install" | "uninstall" | "chooseFolder" | "openFolder" | "dismissPrompt" | "send" | "stop";

interface TaleSpireLinkState {
  addon: AddonStatus | null;
  link: LinkStatus | null;
  /** The action running now (one at a time per kind is enough for the UI's buttons). */
  busy: LinkAction | null;
  /** The last failure, until the next action or a dismiss. */
  error: { action: LinkAction; code: AppError["code"]; message: string } | null;
  setAddon: (s: AddonStatus) => void;
  setLink: (s: LinkStatus) => void;
  /** Fetches both (at start). */
  load: () => Promise<void>;
  /** Looks for the add-on again ("Check again"). */
  recheck: () => Promise<void>;
  /** Install, update now or reinstall (also the update dialog's one-click button). Resolves true on success. */
  install: () => Promise<boolean>;
  /** Choose the Symbiotes folder (reset: find it automatically again). */
  chooseFolder: (reset?: boolean) => Promise<void>;
  /** Removes the add-on (elsewhere: the copy left in the folder used before). Resolves true on success. */
  uninstall: (elsewhere?: boolean) => Promise<boolean>;
  /** "Move it": install in the folder in use, then remove the copy elsewhere. */
  move: () => Promise<boolean>;
  /** Opens the installed add-on's folder, or a paired copy for a manual install ("package"). */
  openFolder: (which: "installed" | "package") => Promise<string | null>;
  /** "Don't ask again" for the update dialog, for this bundled version. */
  dismissPrompt: () => Promise<void>;
  /** Sends a build to the connected add-on. Resolves true when it was sent (progress arrives as link:changed). */
  send: (buildId: string) => Promise<boolean>;
  /** Empties the add-on and releases the hotkeys. */
  stop: () => Promise<void>;
  clearError: () => void;
  // ── the UI's own state (this session only) ──
  /** The add-on dialog (install guide and management). */
  dialogOpen: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  /** "Not now" on the update prompt: closed until the next start. */
  promptSnoozed: boolean;
  snoozePrompt: () => void;
  /** The quiet "the add-on was updated" notice was dismissed. */
  noticeDismissed: boolean;
  dismissNotice: () => void;
}

export const useTaleSpireLink = create<TaleSpireLinkState>((set, get) => {
  /** Runs one action: busy while it runs, the failure kept, the result applied by `apply`. */
  async function act<T>(
    action: LinkAction,
    run: () => Promise<{ ok: true; value: T } | { ok: false; error: AppError }>,
    apply: (v: T) => void,
  ): Promise<boolean> {
    set({ busy: action, error: null });
    const r = await run();
    if (r.ok) {
      apply(r.value);
      set({ busy: null });
      return true;
    }
    set({ busy: null, error: { action, code: r.error.code, message: r.error.message } });
    return false;
  }
  return {
    addon: null,
    link: null,
    busy: null,
    error: null,
    setAddon: (addon) => {
      set({ addon });
    },
    setLink: (link) => {
      set({ link });
    },
    load: async () => {
      const [a, l] = await Promise.all([
        tryCall("addon:status", undefined),
        tryCall("link:status", undefined),
      ]);
      if (a.ok) set({ addon: a.value });
      if (l.ok) set({ link: l.value });
    },
    recheck: async () => {
      const a = await tryCall("addon:status", undefined);
      if (a.ok) set({ addon: a.value });
    },
    install: async () => {
      const ok = await act(
        "install",
        () => tryCall("addon:install", undefined),
        (addon) => {
          set({ addon });
        },
      );
      // a failed install changes the status too (update.state "failed"): show it
      if (!ok) await get().recheck();
      return ok;
    },
    chooseFolder: async (reset = false) => {
      await act(
        "chooseFolder",
        () => tryCall("addon:chooseFolder", { reset }),
        (addon) => {
          if (addon) set({ addon });
        },
      );
    },
    uninstall: async (elsewhere = false) => {
      const ok = await act(
        "uninstall",
        () => tryCall("addon:uninstall", { elsewhere }),
        (addon) => {
          set({ addon });
        },
      );
      if (!ok) await get().recheck();
      return ok;
    },
    move: async () => (await get().install()) && (await get().uninstall(true)),
    openFolder: async (which) => {
      let opened: string | null = null;
      await act(
        "openFolder",
        () => tryCall("addon:openFolder", { which }),
        (r) => {
          opened = r.opened ? r.path : null;
        },
      );
      return opened;
    },
    dismissPrompt: async () => {
      const version = get().addon?.bundledVersion;
      if (!version) return;
      await act(
        "dismissPrompt",
        () => tryCall("addon:dismissPrompt", { version }),
        (addon) => {
          set({ addon });
        },
      );
    },
    send: (buildId) =>
      act(
        "send",
        () => tryCall("link:send", { buildId }),
        () => undefined,
      ),
    stop: async () => {
      await act(
        "stop",
        () => tryCall("link:stop", undefined),
        () => undefined,
      );
    },
    clearError: () => {
      set({ error: null });
    },
    dialogOpen: false,
    openDialog: () => {
      set({ dialogOpen: true });
    },
    closeDialog: () => {
      set({ dialogOpen: false });
    },
    promptSnoozed: false,
    snoozePrompt: () => {
      set({ promptSnoozed: true });
    },
    noticeDismissed: false,
    dismissNotice: () => {
      set({ noticeDismissed: true });
    },
  };
});

// ── selectors (pure; the UI's questions) ──

/** "Send to TaleSpire" is possible: the add-on is connected and nothing is being sent. */
export function canSend(link: LinkStatus | null, busy: LinkAction | null = null): boolean {
  return link?.helper.state === "connected" && link.send.state !== "sending" && busy !== "send";
}

/** Progress of the map in the add-on: chunks placed of total (the GM's Next presses), or null with none loaded. */
export function placingProgress(
  link: LinkStatus | null,
): { placed: number; total: number; finished: boolean } | null {
  const s = link?.set;
  if (!s) return null;
  const placed = s.finished ? s.total : Math.max(0, s.chunk - 1);
  return { placed, total: s.total, finished: s.finished };
}

/** What the add-on's install row should offer. */
export function addonAction(
  addon: AddonStatus | null,
): "choose_folder" | "install" | "update" | "reinstall" | "none" | "blocked" {
  switch (addon?.state) {
    case undefined:
      return "none";
    case "not_found":
      return "choose_folder";
    case "missing":
      return "install";
    case "outdated":
      return "update";
    case "mismatch":
      return "reinstall";
    case "foreign":
      return "blocked";
    default:
      return "none";
  }
}

/** The update dialog is open (main decides; "don't ask again" closes it for this bundled version). */
export function updatePromptOpen(addon: AddonStatus | null): boolean {
  return addon?.prompt.show === true;
}

/** An automatic update just happened this run: old -> new, for a quiet notice. */
export function autoUpdated(addon: AddonStatus | null): { from: string | null; to: string } | null {
  const u = addon?.update;
  return u?.state === "updated" && u.automatic && u.to !== null ? { from: u.from, to: u.to } : null;
}

/** The hotkeys are not all working while a map is being placed: say "use the buttons in the add-on panel". */
export function hotkeysNeedFallback(link: LinkStatus | null): boolean {
  if (!link || link.hotkeys.state === "off") return false;
  return link.hotkeys.state !== "active";
}
