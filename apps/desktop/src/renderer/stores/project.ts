/** projectStore (architecture §6.3): mirror of the open project's snapshot plus the Home project list. */
import { create } from "zustand";
import type { DesignBrief, MapPlan } from "@slabyrinth/core";
import type { IpcEvents, IpcRequests, ProjectSnapshot } from "../../shared/ipc";
import type { ProjectFile } from "../../shared/project";
import { call } from "../bridge/client";

export type ProjectListEntry = IpcRequests["project:list"]["res"][number];
export type VersionRow = ProjectSnapshot["versions"][number];
export type UiResume = ProjectFile["ui"];
export type PasteGuideResume = NonNullable<ProjectFile["pasteGuide"]>;

interface ProjectState {
  snap: ProjectSnapshot | null;
  list: ProjectListEntry[] | null;
  saveState: "saved" | "saving" | "failed";
  /** Resume state from the snapshot (ProjectFile.ui / pasteGuide). */
  resume: { ui: UiResume | null; pasteGuide: PasteGuideResume | null };
  /** The head before the last plan:changed (for "changed rooms pulse"). */
  prevHead: number;
  setSnapshot: (s: ProjectSnapshot | null) => void;
  refresh: () => Promise<void>;
  loadList: () => Promise<void>;
  applyPlanChanged: (e: IpcEvents["plan:changed"]) => void;
  applyProjectChanged: (e: IpcEvents["project:changed"]) => void;
  setBrief: (b: DesignBrief) => void;
  saveUi: (ui: Partial<Omit<UiResume, "lastActivityAt">>) => void;
  savePasteGuide: (p: PasteGuideResume) => void;
}

let uiTimer: ReturnType<typeof setTimeout> | null = null;
let pendingUi: Partial<Omit<UiResume, "lastActivityAt">> = {};

export const useProject = create<ProjectState>((set, get) => ({
  snap: null,
  list: null,
  saveState: "saved",
  resume: { ui: null, pasteGuide: null },
  prevHead: 0,
  setSnapshot: (snap) => {
    set({
      snap,
      prevHead: snap?.head ?? 0,
      resume: { ui: snap?.ui ?? null, pasteGuide: snap?.pasteGuide ?? null },
    });
  },
  refresh: async () => {
    if (get().snap === null) return;
    const snap = await call("project:snapshot", undefined);
    set({ snap });
  },
  loadList: async () => {
    set({ list: await call("project:list", undefined) });
  },
  applyPlanChanged: (e) => {
    const snap = get().snap;
    if (!snap) return;
    const versions = snap.versions.some((v) => v.number === e.version.number)
      ? snap.versions
      : [...snap.versions, e.version];
    set({ prevHead: snap.head, snap: { ...snap, head: e.head, plan: e.plan, versions } });
    // undone/approved pointers are not in the event: re-read the snapshot (cheap, local).
    void get().refresh();
  },
  applyProjectChanged: (e) => {
    const snap = get().snap;
    if (!snap) return;
    set({ snap: { ...snap, name: e.name, filePath: e.filePath, dirty: e.dirty } });
  },
  setBrief: (brief) => {
    const snap = get().snap;
    if (snap) set({ snap: { ...snap, brief } });
  },
  saveUi: (ui) => {
    pendingUi = { ...pendingUi, ...ui };
    if (uiTimer !== null) clearTimeout(uiTimer);
    uiTimer = setTimeout(() => {
      // main stamps lastActivityAt itself and rejects it in requests
      const payload = { ...pendingUi };
      pendingUi = {};
      uiTimer = null;
      if (get().snap === null) return;
      call("project:setUiState", { ui: payload }).catch((e: unknown) => {
        console.warn("[slabyrinth] could not save the view state", e);
      });
    }, 600);
  },
  savePasteGuide: (p) => {
    set({ resume: { ...get().resume, pasteGuide: p } });
    call("project:setUiState", { pasteGuide: p }).catch(() => undefined);
  },
}));

// ───────────── derived helpers ─────────────

export function phaseOf(snap: ProjectSnapshot | null): "brief" | "plan" | "build" {
  if (!snap || snap.head === 0) return "brief";
  return snap.approvedVersion !== null ? "build" : "plan";
}

export function roomCount(plan: MapPlan | null, levelId?: string): number {
  if (!plan) return 0;
  return plan.levels
    .filter((l) => levelId === undefined || l.id === levelId)
    .reduce((n, l) => n + l.areas.filter((a) => a.key !== undefined).length, 0);
}

/** Entry level first, then by distance in elevation (matches core levelLabels: "L1", "L2"…). */
export function orderedLevels(plan: MapPlan | null): MapPlan["levels"] {
  if (!plan) return [];
  const entry =
    plan.levels.find((l) => l.id === plan.entryLevel) ??
    [...plan.levels].sort((a, b) => Math.abs(a.elevation) - Math.abs(b.elevation))[0];
  const e0 = entry?.elevation ?? 0;
  return plan.levels
    .map((l, i) => ({ l, i }))
    .sort((a, b) => {
      if (a.l === entry) return -1;
      if (b.l === entry) return 1;
      return (
        Math.abs(a.l.elevation - e0) - Math.abs(b.l.elevation - e0) ||
        b.l.elevation - a.l.elevation ||
        a.i - b.i
      );
    })
    .map((x) => x.l);
}

export function levelShort(plan: MapPlan | null, levelId: string): string {
  const i = orderedLevels(plan).findIndex((l) => l.id === levelId);
  return i < 0 ? levelId : `L${i + 1}`;
}

export function latestBuild(snap: ProjectSnapshot | null): ProjectSnapshot["builds"][number] | null {
  return snap?.builds.at(-1) ?? null;
}
