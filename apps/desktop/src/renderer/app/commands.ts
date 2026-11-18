/** Keyboard map (UX §13.2) and app-menu commands. One table drives the menu, the shortcut sheet and the handler. */
import { useEffect } from "react";
import type { IpcEvents } from "../../shared/ipc";
import { useApp } from "../stores/app";
import { useBuild } from "../stores/build";
import { useChat } from "../stores/chat";
import { useMap, ZOOM_STEPS } from "../stores/map";
import { orderedLevels, phaseOf, useProject } from "../stores/project";
import { inTextField } from "../ui/dismiss";
import { copyRoomKey, goHome, newProject, openProject, redo, undo } from "./actions";
import { call } from "../bridge/client";
import { toggleTheme } from "./theme";

export interface Command {
  id: string;
  label: string;
  keys?: string;
  group: "File" | "Edit" | "View" | "Map" | "Help";
  enabled?: () => boolean;
  run: () => void;
}

const inProject = (): boolean =>
  useProject.getState().snap !== null && useApp.getState().route === "workspace";
const hasPlan = (): boolean => (useProject.getState().snap?.head ?? 0) > 0;

function stepZoom(dir: 1 | -1): void {
  const m = useMap.getState();
  const z = m.zoom;
  const next =
    dir > 0
      ? (ZOOM_STEPS.find((s) => s > z + 1e-6) ?? z)
      : ([...ZOOM_STEPS].reverse().find((s) => s < z - 1e-6) ?? z);
  window.dispatchEvent(new CustomEvent("slab:zoom", { detail: next }));
}

function switchLevel(delta: number | { index: number }): void {
  const plan = useProject.getState().snap?.plan ?? null;
  const levels = orderedLevels(plan);
  const cur = levels.findIndex((l) => l.id === useMap.getState().levelId);
  const i = typeof delta === "number" ? cur + delta : delta.index;
  const target = levels[i];
  if (target) useMap.getState().setLevel(target.id);
}

export const COMMANDS: Command[] = [
  { id: "home", group: "File", label: "Home", keys: "Ctrl+Shift+H", run: () => void goHome() },
  { id: "new", group: "File", label: "New project", keys: "Ctrl+N", run: () => void newProject() },
  { id: "open", group: "File", label: "Open project…", keys: "Ctrl+O", run: () => void openProject() },
  {
    id: "saveAs",
    group: "File",
    label: "Save a copy as…",
    keys: "Ctrl+Shift+S",
    enabled: inProject,
    run: () =>
      void call("project:saveCopyAs", undefined).then((r) => {
        if (r) useApp.getState().toast({ lead: "Copy saved.", body: r.path });
      }),
  },
  {
    id: "png",
    group: "File",
    label: "Export map as PNG…",
    keys: "Ctrl+Shift+E",
    enabled: () => inProject() && hasPlan(),
    run: () => {
      useMap.getState().setTab("map");
      useMap.getState().setPng(true);
    },
  },
  {
    id: "roomkey",
    group: "File",
    label: "Export room key (Markdown)",
    enabled: () => inProject() && hasPlan(),
    run: () => void copyRoomKey(),
  },
  {
    id: "close",
    group: "File",
    label: "Close project",
    keys: "Ctrl+W",
    enabled: inProject,
    run: () => void goHome(),
  },
  {
    id: "settings",
    group: "File",
    label: "Settings",
    keys: "Ctrl+,",
    run: () => {
      useApp.getState().openSettings();
    },
  },
  {
    id: "undo",
    group: "Edit",
    label: "Undo plan change",
    keys: "Ctrl+Z",
    enabled: () => inProject() && hasPlan(),
    run: () => void undo(),
  },
  {
    id: "redo",
    group: "Edit",
    label: "Redo",
    keys: "Ctrl+Y",
    enabled: () => inProject() && hasPlan(),
    run: () => void redo(),
  },
  {
    id: "find",
    group: "Edit",
    label: "Find in room key",
    keys: "Ctrl+F",
    enabled: () => inProject() && hasPlan(),
    run: () => window.dispatchEvent(new CustomEvent("slab:find")),
  },
  {
    id: "tabMap",
    group: "View",
    label: "Map",
    keys: "Ctrl+1",
    enabled: inProject,
    run: () => {
      useMap.getState().setTab("map");
    },
  },
  {
    id: "tabBuild",
    group: "View",
    label: "Build",
    keys: "Ctrl+2",
    enabled: () => inProject() && useProject.getState().snap?.approvedVersion !== null,
    run: () => {
      useMap.getState().setTab("build");
    },
  },
  {
    id: "chat",
    group: "View",
    label: "Toggle chat pane",
    keys: "Ctrl+\\",
    enabled: inProject,
    run: () => {
      useApp.getState().toggleChat();
    },
  },
  {
    id: "key",
    group: "View",
    label: "Toggle room key",
    keys: "Ctrl+]",
    enabled: inProject,
    run: () => {
      useMap.getState().toggleKey();
    },
  },
  {
    id: "brief",
    group: "View",
    label: "Toggle brief card",
    keys: "Ctrl+Shift+B",
    enabled: inProject,
    run: () => {
      useApp
        .getState()
        .setBriefOpen(!(useApp.getState().briefOpen ?? phaseOf(useProject.getState().snap) === "brief"));
    },
  },
  {
    id: "theme",
    group: "View",
    label: "Switch theme",
    run: toggleTheme,
  },
  {
    id: "compare",
    group: "Map",
    label: "Compare with previous",
    keys: "C",
    enabled: () => inProject() && (useProject.getState().snap?.head ?? 0) > 1,
    run: () => {
      useMap.getState().setCompare({ on: !useMap.getState().compare.on });
    },
  },
  {
    id: "history",
    group: "Map",
    label: "History",
    keys: "H",
    enabled: () => inProject() && hasPlan(),
    run: () => {
      useMap.getState().setHistory(!useMap.getState().historyOpen);
    },
  },
  {
    id: "approve",
    group: "Map",
    label: "Approve current version",
    keys: "Ctrl+Shift+A",
    enabled: () => inProject() && hasPlan() && useChat.getState().live === null,
    run: () => {
      useMap.getState().setTab("map");
      useMap.getState().setApprove(true);
    },
  },
  {
    id: "build",
    group: "Map",
    label: "Build",
    keys: "Ctrl+B",
    enabled: () => inProject() && useProject.getState().snap?.approvedVersion !== null,
    run: () => {
      useMap.getState().setTab("build");
      void useBuild.getState().run();
    },
  },
  {
    id: "model",
    group: "Map",
    label: "Model & effort…",
    keys: "Ctrl+M",
    enabled: inProject,
    run: () => window.dispatchEvent(new CustomEvent("slab:model")),
  },
  {
    id: "shortcuts",
    group: "Help",
    label: "Keyboard shortcuts",
    keys: "?",
    run: () => {
      useApp.getState().setShortcuts(true);
    },
  },
  {
    id: "about",
    group: "Help",
    label: "About Slabyrinth",
    run: () => {
      useApp.getState().openSettings("about");
    },
  },
];

/** Shortcuts not in the menu (UX §13.2), listed on the sheet. */
export const EXTRA_KEYS: Array<[string, string]> = [
  ["/", "Focus composer"],
  ["Enter / Shift+Enter", "Send / new line"],
  ["Esc", "Stop · clear selection · close popover"],
  ["Alt+1…9, PgUp/PgDn", "Switch level"],
  ["V · Space (hold)", "Select tool · temporary pan"],
  ["+ − 0 1", "Zoom in / out / fit / 100%"],
  ["Arrows (map)", "Pan 2 squares"],
  ["Tab (room selected)", "Next room"],
  ["R or Enter (room selected)", "Reference in chat"],
  ["E (room selected)", "Edit notes"],
  ["L", "Legend"],
  ["N, Ctrl+Shift+C", "Paste guide: next"],
];

function matches(e: KeyboardEvent, keys: string): boolean {
  const parts = keys.split("+");
  const key = parts.at(-1) ?? "";
  const ctrl = parts.includes("Ctrl");
  const shift = parts.includes("Shift");
  const alt = parts.includes("Alt");
  if ((e.ctrlKey || e.metaKey) !== ctrl || e.altKey !== alt) return false;
  if (key.length === 1 && /[a-z]/i.test(key))
    return e.shiftKey === shift && e.key.toLowerCase() === key.toLowerCase();
  if (key === "\\") return e.code === "Backslash";
  if (key === "]") return e.code === "BracketRight";
  if (key === ",") return e.code === "Comma";
  if (key === "?") return e.key === "?";
  if (/^\d$/.test(key)) return e.key === key && e.shiftKey === shift;
  return e.key === key && e.shiftKey === shift;
}

export function runMenuCommand(cmd: IpcEvents["menu:command"]["command"]): void {
  const map: Record<string, string> = {
    new: "new",
    open: "open",
    save: "saveAs",
    saveAs: "saveAs",
    undo: "undo",
    redo: "redo",
    export: "png",
    settings: "settings",
  };
  const c = COMMANDS.find((x) => x.id === map[cmd]);
  if (c && (c.enabled?.() ?? true)) c.run();
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      const typing = inTextField(e.target);
      // Alt alone opens the app menu (Windows convention)
      if (e.key === "Alt" && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        useApp.getState().setMenu(!useApp.getState().menuOpen);
        return;
      }
      if (e.altKey && /^[1-9]$/.test(e.key) && inProject()) {
        e.preventDefault();
        switchLevel({ index: Number(e.key) - 1 });
        return;
      }
      if (!typing && (e.key === "PageUp" || e.key === "PageDown") && inProject()) {
        e.preventDefault();
        switchLevel(e.key === "PageUp" ? -1 : 1);
        return;
      }
      if (!typing && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (inProject()) void redo();
        return;
      }
      for (const c of COMMANDS) {
        if (c.keys === undefined) continue;
        const single = !c.keys.includes("+") || c.keys === "?";
        if (single && typing) continue;
        if ((c.id === "undo" || c.id === "redo") && typing) continue;
        if (!matches(e, c.keys)) continue;
        if (!(c.enabled?.() ?? true)) return;
        e.preventDefault();
        c.run();
        return;
      }
      if (!typing && e.key === "/" && inProject()) {
        e.preventDefault();
        useApp.getState().toggleChat(true);
        useChat.getState().focusComposer();
        return;
      }
      if (!typing && inProject()) {
        if (e.key === "+" || e.key === "=") stepZoom(1);
        else if (e.key === "-") stepZoom(-1);
        else if (e.key === "0") window.dispatchEvent(new CustomEvent("slab:fit"));
        else if (e.key === "1" && !e.ctrlKey)
          window.dispatchEvent(new CustomEvent("slab:zoom", { detail: 1 }));
        else if (e.key.toLowerCase() === "v" && !e.ctrlKey) useMap.getState().setTool("select");
        else if (e.key.toLowerCase() === "l" && !e.ctrlKey)
          useMap.getState().setLegend(!useMap.getState().legendOpen);
        else if (
          (e.key.toLowerCase() === "n" && !e.ctrlKey) ||
          (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c")
        ) {
          if (useMap.getState().tab === "build" && useBuild.getState().guideOpen)
            void useBuild.getState().dispatch({ type: "next", at: new Date().toISOString() });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}
