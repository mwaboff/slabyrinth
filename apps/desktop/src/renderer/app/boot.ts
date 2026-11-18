/**
 * Startup: install the bridge (real preload, or the fake when absent / `?fake` in the URL), load settings,
 * subscribe to main's events, and pick the first route. A project may already be open from a file
 * association, so project:snapshot is asked first (WP5 note).
 */
import type { SlabyrinthApi } from "../../shared/ipc";
import { call, on, setBridge, tryCall } from "../bridge/client";
import { useApp } from "../stores/app";
import { useChat } from "../stores/chat";
import { useMap } from "../stores/map";
import { useProject } from "../stores/project";
import { useSettings } from "../stores/settings";
import { useBuild } from "../stores/build";
import { openSnapshot } from "./actions";
import { runMenuCommand } from "./commands";

export async function installBridge(): Promise<"real" | "fake"> {
  const url = new URL(window.location.href);
  const real = (window as unknown as { slabyrinth?: SlabyrinthApi }).slabyrinth;
  // The fake bridge exists only in the dev server and unit tests. import.meta.env.DEV is a build-time
  // constant, so production/test builds drop this branch and never emit the fake chunk.
  if (import.meta.env.DEV) {
    if (!real || url.searchParams.has("fake")) {
      const { createFakeBridge, parseScenario } = await import("../bridge/fake/fakeBridge");
      setBridge(createFakeBridge({ scenario: parseScenario(url.search) }));
      return "fake";
    }
  }
  if (!real) throw new Error("The secure bridge to the main process is missing (preload did not load).");
  setBridge(real);
  return "real";
}

let unsubs: Array<() => void> = [];

export function subscribeEvents(): void {
  for (const u of unsubs) u();
  unsubs = [
    on("chat:event", (e) => {
      useChat.getState().dispatch(e);
      if (e.type === "brief_updated") useProject.getState().setBrief(e.brief);
      if (e.type === "turn_finished" || e.type === "turn_failed") {
        void useProject
          .getState()
          .refresh()
          .then(() => {
            const snap = useProject.getState().snap;
            if (snap) useChat.getState().setMeta(snap.conversation.meta, snap.conversation.items);
          });
      }
    }),
    on("plan:changed", (e) => {
      const before = useProject.getState().snap?.head ?? 0;
      useProject.getState().applyPlanChanged(e);
      useMap.getState().preview(null);
      if (e.plan === null) {
        // e.g. Retry of the turn that drew the first plan: back to the brief, nothing to check or compare
        useMap.getState().setIssues([]);
        useMap.getState().setCompare({ on: false, against: null });
        useMap.getState().setTab("map");
      }
      if (before > 0 && e.head > 0 && e.head !== before) {
        void tryCall("plan:diff", { from: before, to: e.head }).then((r) => {
          if (r.ok) useMap.getState().pulseRooms([...r.value.areas.added, ...r.value.areas.changed]);
        });
      }
    }),
    on("project:changed", (e) => {
      useProject.getState().applyProjectChanged(e);
    }),
    on("settings:changed", (s) => {
      useSettings.getState().apply(s);
    }),
    on("catalog:warning", (w) => {
      if (w.kind === "no_install" && useSettings.getState().settings?.suppressAssetWarning !== true)
        useApp.getState().setBanner({ tsMissing: true });
      void useSettings.getState().refreshCatalog();
    }),
    on("catalog:changed", (r) => {
      void useSettings.getState().refreshCatalog();
      if (r.added > 0 || r.removed.length > 0)
        useApp.getState().toast({
          lead: `TaleSpire was updated — ${r.added} new assets found.`,
          body: "The asset library is up to date.",
          action: {
            label: "View",
            run: () => {
              useApp.getState().openSettings("talespire");
            },
          },
        });
    }),
    on("compile:progress", (p) => {
      useBuild.getState().setProgress(p);
    }),
    on("menu:command", (m) => {
      runMenuCommand(m.command);
    }),
  ];
  const online = (): void => {
    useApp.getState().setBanner({ offline: !navigator.onLine });
  };
  window.addEventListener("online", online);
  window.addEventListener("offline", online);
  online();
}

export async function boot(): Promise<void> {
  await installBridge();
  subscribeEvents();
  const info = await call("app:getInfo", undefined);
  useApp.getState().setInfo(info.platform, info.version);
  await useSettings.getState().load();
  const settings = useSettings.getState().settings;
  const catalog = useSettings.getState().catalog;
  if (catalog?.state === "no_install" && settings?.suppressAssetWarning !== true)
    useApp.getState().setBanner({ tsMissing: true });
  if (settings && !settings.setupCompleted) {
    useApp.getState().setRoute("setup");
    return;
  }
  const snap = await tryCall("project:snapshot", undefined);
  if (snap.ok) {
    openSnapshot(snap.value);
    return;
  }
  if (settings?.ui.onLaunch === "last_project" && settings.projects.recent[0] !== undefined) {
    const r = await tryCall("project:open", { path: settings.projects.recent[0] });
    if (r.ok && r.value) {
      openSnapshot(r.value);
      return;
    }
  }
  useApp.getState().setRoute("home");
  void useProject.getState().loadList();
}
