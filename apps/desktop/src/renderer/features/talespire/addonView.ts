/**
 * The TaleSpire add-on's states in words: one summary for the status light, the setup steps of the add-on dialog, the
 * hotkeys and the build page's "Send to TaleSpire" panel. Pure functions over the store's state
 * (stores/talespireLink.ts), so one table-driven test covers every state, and every surface says the same thing.
 */
import type { AddonStatus, LinkStatus } from "../../../shared/ipc";
import { addonAction, canSend, placingProgress, type LinkAction } from "../../stores/talespireLink";

/** The light's look: its colour and its shape both say it (never colour alone). */
export type Light = "ok" | "busy" | "idle" | "action" | "warn" | "error";

export type SummaryKey =
  | "checking"
  | "port_in_use"
  | "link_failed"
  | "not_found"
  | "foreign"
  | "refused"
  | "mismatch"
  | "placing"
  | "place_failed"
  | "placed"
  | "outdated"
  | "missing"
  | "connected"
  | "waiting";

export interface AddonSummary {
  key: SummaryKey;
  light: Light;
  /** A few words, for the status bar. */
  label: string;
  /** One plain sentence: what it means or what to do. */
  detail: string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`;

const REFUSED_DETAIL: Record<NonNullable<LinkStatus["helper"]["reason"]>, string> = {
  token: "The add-on open in TaleSpire isn't paired with this Slabyrinth. Reinstall it.",
  protocol: "The add-on open in TaleSpire is too old for this Slabyrinth. Reinstall it.",
  origin: "Something other than the add-on tried to connect, so Slabyrinth refused it.",
};

/**
 * The one state the status light shows, most urgent first. A paired connection proves a working install, so it ranks
 * above every folder problem (not found, not installed there, taken, paired with another copy): a GM who copied the
 * add-on by hand into a folder Slabyrinth doesn't use (likely on Linux) sees "Add-on connected". The folder problem
 * still shows in the dialog and in Settings (`folderProblem`, the Folder row).
 */
export function addonSummary(addon: AddonStatus | null, link: LinkStatus | null): AddonSummary {
  if (!addon || !link)
    return {
      key: "checking",
      light: "idle",
      label: "Checking add-on…",
      detail: "Looking for the TaleSpire add-on.",
    };
  if (link.server.state === "port_in_use")
    return {
      key: "port_in_use",
      light: "error",
      label: "Add-on link blocked",
      detail: `Another program is using Slabyrinth's port ${String(link.server.port)}. Slabyrinth tries again every 15 seconds.`,
    };
  if (link.server.state === "failed")
    return {
      key: "link_failed",
      light: "error",
      label: "Add-on link off",
      detail: "Slabyrinth couldn't start its link to the add-on. Restart Slabyrinth to try again.",
    };
  const connected = link.helper.state === "connected";
  if (!connected && addon.state === "not_found")
    return {
      key: "not_found",
      light: "warn",
      label: "Add-on folder not found",
      detail: "Slabyrinth couldn't find TaleSpire's Symbiotes folder. Choose it by hand.",
    };
  if (!connected && addon.state === "foreign")
    return {
      key: "foreign",
      light: "warn",
      label: "Add-on folder taken",
      detail:
        "A different add-on is in TaleSpire's slabyrinth-helper folder. Rename or remove that folder, then install.",
    };
  if (link.helper.state === "refused")
    return {
      key: "refused",
      light: "warn",
      label: link.helper.reason === "origin" ? "Connection refused" : "Reinstall the add-on",
      detail: REFUSED_DETAIL[link.helper.reason ?? "token"],
    };
  if (!connected && addon.state === "mismatch")
    return {
      key: "mismatch",
      light: "warn",
      label: "Reinstall the add-on",
      detail: "The installed add-on is paired with another copy of Slabyrinth.",
    };
  const placing = connected ? link.set : null;
  if (placing) {
    if (placing.finished || placing.phase === "done")
      return {
        key: "placed",
        light: "ok",
        label: "Map placed",
        detail: `All ${plural(placing.total, "slab")} of ${placing.name} are placed.`,
      };
    if (placing.phase === "failed")
      return {
        key: "place_failed",
        light: "warn",
        label: `Slab ${String(placing.chunk)} didn't place`,
        detail: `Slab ${String(placing.chunk)} of ${String(placing.total)} didn't reach your hand. The add-on panel says why.`,
      };
    return {
      key: "placing",
      light: "busy",
      label: `Placing map · ${String(placing.chunk)} of ${String(placing.total)}`,
      detail: `${placing.name}: slab ${String(placing.chunk)} of ${String(placing.total)}.`,
    };
  }
  if (addon.state === "outdated")
    return {
      key: "outdated",
      light: "warn",
      label: "Update TaleSpire add-on",
      detail: `Version ${addon.installedVersion ?? "?"} is installed; this Slabyrinth comes with ${addon.bundledVersion}.`,
    };
  if (!connected && addon.state === "missing")
    return {
      key: "missing",
      light: "action",
      label: "Install TaleSpire add-on",
      detail: "It puts each slab of a big map in your hand in TaleSpire, one at a time.",
    };
  if (connected)
    return {
      key: "connected",
      light: "ok",
      label: "Add-on connected",
      detail: "Slabyrinth Helper is open in TaleSpire.",
    };
  return {
    key: "waiting",
    light: "idle",
    label: "Add-on not connected",
    detail: "Open Slabyrinth Helper in TaleSpire's Symbiotes panel.",
  };
}

/** Where TaleSpire itself shows its Symbiotes folder (verified against TaleSpire's own settings screen). */
export const TALESPIRE_SYMBIOTES_SETTING = "Game Settings > Modding Settings > Symbiotes";
export const OPEN_SYMBIOTES_DIRECTORY_HINT =
  `To see the folder, press "Open Symbiotes Directory" in TaleSpire (${TALESPIRE_SYMBIOTES_SETTING}), ` +
  'then pick that same folder here with "Change location…".';

/**
 * A folder problem while the add-on is connected anyway (a copy installed by hand somewhere Slabyrinth doesn't look):
 * the light says connected, so the Folder row says this. Null when there is none, or when not connected (the light
 * says it then).
 */
export function folderProblem(addon: AddonStatus | null, link: LinkStatus | null): string | null {
  if (link?.helper.state !== "connected" || !addon) return null;
  const update = "Choose the folder TaleSpire uses, so Slabyrinth can keep the add-on up to date.";
  switch (addon.state) {
    case "not_found":
      return `The add-on is connected, but Slabyrinth couldn't find TaleSpire's Symbiotes folder. ${update}`;
    case "missing":
      return `The add-on is connected, but it isn't in this folder: TaleSpire runs a copy from somewhere else. ${update}`;
    case "foreign":
      return `The add-on is connected from somewhere else; this folder's slabyrinth-helper folder holds a different add-on. ${update}`;
    case "mismatch":
      return `The add-on is connected from somewhere else; the copy in this folder is paired with another Slabyrinth. ${update}`;
    default:
      return null;
  }
}

/** The add-on's main button, by what the store offers (null: nothing to do). */
export function primaryAction(
  addon: AddonStatus | null,
  link: LinkStatus | null,
): { kind: "install" | "choose_folder" | "open_folder"; label: string } | null {
  if (link?.helper.state === "refused" && link.helper.reason !== "origin" && addon?.folder)
    return { kind: "install", label: "Reinstall" };
  switch (addonAction(addon)) {
    case "install":
      return { kind: "install", label: "Install" };
    case "update":
      return { kind: "install", label: "Update now" };
    case "reinstall":
      return { kind: "install", label: "Reinstall" };
    case "choose_folder":
      return { kind: "choose_folder", label: "Choose folder…" };
    case "blocked":
      return { kind: "open_folder", label: "Open folder" };
    default:
      return null;
  }
}

/** Installed in TaleSpire's folder (any version of ours). */
export function isInstalled(addon: AddonStatus | null): boolean {
  return addon?.state === "installed" || addon?.state === "outdated" || addon?.state === "mismatch";
}

/** first: to do before the current step (it can't be checked from here) */
export type StepState = "done" | "current" | "first" | "todo";

/** The three setup steps of the add-on dialog: turn Symbiotes on, install, open it in TaleSpire. */
export function setupSteps(
  addon: AddonStatus | null,
  link: LinkStatus | null,
): { enable: StepState; install: StepState; open: StepState } {
  const connected = link?.helper.state === "connected";
  const installed = addon?.state === "installed" && link?.helper.state !== "refused";
  return {
    enable: connected ? "done" : installed ? "current" : "first",
    install: installed || connected ? "done" : "current",
    open: connected ? "done" : installed ? "current" : "todo",
  };
}

/** Where the Symbiotes folder came from, in words. */
export function folderSourceLabel(source: AddonStatus["folderSource"]): string {
  switch (source) {
    case "manual":
      return "Chosen by you";
    case "proton":
      return "Detected (Steam Proton)";
    case "default":
      return "Detected";
    default:
      return "Not found";
  }
}

export const HOTKEY_NAMES = { next: "Next", back: "Back", again: "Again" } as const;

/** Each hotkey: its keys and its state in words. */
export function hotkeyRows(link: LinkStatus | null): Array<{
  action: keyof typeof HOTKEY_NAMES;
  name: string;
  combo: string | null;
  state: string;
  ok: boolean;
}> {
  if (!link) return [];
  return (["next", "back", "again"] as const).map((action) => {
    const k = link.hotkeys.actions[action];
    const state =
      k.status === "active"
        ? "On"
        : k.status === "standby"
          ? "Turns on while a map is placed"
          : k.status === "refused"
            ? `Not available${k.reason !== undefined && k.reason !== "" ? `: ${k.reason}` : ""}`
            : "Not set";
    return {
      action,
      name: HOTKEY_NAMES[action],
      combo: k.combo ?? k.wanted ?? null,
      state,
      ok: k.status === "active" || k.status === "standby",
    };
  });
}

/** The build page's "Send to TaleSpire" panel. */
export type SendView =
  | { kind: "setup"; summary: AddonSummary }
  | { kind: "fix"; summary: AddonSummary }
  | { kind: "blocked"; summary: AddonSummary }
  | { kind: "waiting" }
  | { kind: "empty_chunk" }
  | { kind: "ready"; other: string | null }
  | { kind: "sending" }
  | {
      kind: "placing";
      name: string;
      chunk: number;
      total: number;
      placed: number;
      phase: NonNullable<LinkStatus["set"]>["phase"];
      status: string;
    }
  | { kind: "finished"; name: string; total: number };

/**
 * What the panel shows for this build. `emptyChunk`: a part of the build has no assets (TaleSpire crashes on an empty
 * slab, so the store and main refuse to send it).
 */
export function sendView(
  addon: AddonStatus | null,
  link: LinkStatus | null,
  busy: LinkAction | null,
  buildId: string,
  emptyChunk: boolean,
): SendView {
  const summary = addonSummary(addon, link);
  if (summary.key === "port_in_use" || summary.key === "link_failed" || summary.key === "checking")
    return { kind: "blocked", summary };
  const connected = link?.helper.state === "connected";
  if (!connected) {
    if (summary.key === "missing" || summary.key === "not_found" || summary.key === "foreign")
      return { kind: "setup", summary };
    if (summary.key === "waiting") return { kind: "waiting" };
    return { kind: "fix", summary };
  }
  if (busy === "send" || link.send.state === "sending") return { kind: "sending" };
  const set = link.set;
  const ours = set !== null && link.send.buildId === buildId;
  if (set && ours) {
    const p = placingProgress(link);
    if (set.finished || set.phase === "done") return { kind: "finished", name: set.name, total: set.total };
    return {
      kind: "placing",
      name: set.name,
      chunk: set.chunk,
      total: set.total,
      placed: p?.placed ?? 0,
      phase: set.phase,
      status: set.status,
    };
  }
  if (emptyChunk) return { kind: "empty_chunk" };
  if (!canSend(link, busy)) return { kind: "sending" };
  return { kind: "ready", other: set ? set.name : null };
}
