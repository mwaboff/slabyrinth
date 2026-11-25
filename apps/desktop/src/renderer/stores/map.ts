/** mapStore (architecture §6.3): active level, view transform, layers, selection, hover, compare, history. */
import { create } from "zustand";
import type { DisplayOptions, HitTarget } from "@slabyrinth/core";
import type { UiIssue } from "../../shared/resolveCore";

export interface Layers {
  grid: boolean;
  roomNumbers: boolean;
  roomNames: boolean;
  furniture: boolean;
  gmLayer: boolean;
  legend: boolean;
}

export interface Sel {
  areaIds: string[];
  featureIds: string[];
  openingIds: string[];
  linkIds: string[];
}

export const emptySel = (): Sel => ({ areaIds: [], featureIds: [], openingIds: [], linkIds: [] });
export const selIsEmpty = (s: Sel): boolean =>
  s.areaIds.length + s.featureIds.length + s.openingIds.length + s.linkIds.length === 0;

/** 24 px per cell at 100% (architecture §5.4). */
export const PX_PER_CELL = 24;
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

/** The stage tabs: Map · 3D · Build (design 4.1). */
export type StageTab = "map" | "3d" | "build";

interface MapState {
  tab: StageTab;
  levelId: string | null;
  zoom: number;
  /** Pixel offset of cell (0,0) in canvas CSS px. */
  pan: [number, number];
  fitTick: number;
  fitted: boolean;
  tool: "select" | "pan";
  layers: Layers;
  sel: Sel;
  hover: HitTarget | null;
  hoverCell: [number, number] | null;
  compare: { on: boolean; against: number | null };
  previewVersion: number | null;
  historyOpen: boolean;
  keyCollapsed: boolean;
  keyFilter: string;
  editRoomId: string | null;
  legendOpen: boolean;
  pulse: { ids: string[]; at: number } | null;
  pngOpen: boolean;
  approveOpen: boolean;
  /** Plan-check issues of the head version (validatePlan, computed in resolve.worker). */
  issues: UiIssue[];
  issuesOpen: boolean;
  setIssues: (i: UiIssue[]) => void;
  setIssuesOpen: (open: boolean) => void;
  setTab: (t: StageTab) => void;
  setLevel: (id: string) => void;
  setView: (zoom: number, pan: [number, number]) => void;
  requestFit: () => void;
  markFitted: () => void;
  setTool: (t: "select" | "pan") => void;
  toggleLayer: (k: keyof Layers) => void;
  select: (s: Sel) => void;
  clearSel: () => void;
  setHover: (h: HitTarget | null, cell: [number, number] | null) => void;
  setCompare: (c: Partial<MapState["compare"]>) => void;
  preview: (v: number | null) => void;
  setHistory: (open: boolean) => void;
  toggleKey: (open?: boolean) => void;
  setKeyFilter: (f: string) => void;
  editRoom: (id: string | null) => void;
  setLegend: (open: boolean) => void;
  pulseRooms: (ids: string[]) => void;
  setPng: (open: boolean) => void;
  setApprove: (open: boolean) => void;
  reset: () => void;
}

const initial = {
  tab: "map" as const,
  levelId: null,
  zoom: 1,
  pan: [0, 0] as [number, number],
  fitTick: 0,
  fitted: false,
  tool: "select" as const,
  layers: { grid: true, roomNumbers: true, roomNames: true, furniture: true, gmLayer: true, legend: false },
  sel: emptySel(),
  hover: null,
  hoverCell: null,
  compare: { on: false, against: null },
  previewVersion: null,
  historyOpen: false,
  keyCollapsed: false,
  keyFilter: "",
  editRoomId: null,
  legendOpen: true,
  pulse: null,
  pngOpen: false,
  approveOpen: false,
  issues: [] as UiIssue[],
  issuesOpen: false,
};

export const useMap = create<MapState>((set, get) => ({
  ...initial,
  setTab: (tab) => {
    set({ tab });
  },
  setLevel: (levelId) => {
    if (levelId === get().levelId) return;
    set({ levelId, sel: emptySel(), hover: null, fitTick: get().fitTick + 1, editRoomId: null });
  },
  setView: (zoom, pan) => {
    set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)), pan });
  },
  requestFit: () => {
    set({ fitTick: get().fitTick + 1 });
  },
  markFitted: () => {
    set({ fitted: true });
  },
  setTool: (tool) => {
    set({ tool });
  },
  toggleLayer: (k) => {
    set({ layers: { ...get().layers, [k]: !get().layers[k] } });
  },
  select: (sel) => {
    set({
      sel,
      editRoomId: get().editRoomId !== null && sel.areaIds[0] !== get().editRoomId ? null : get().editRoomId,
    });
  },
  clearSel: () => {
    set({ sel: emptySel(), editRoomId: null });
  },
  setHover: (hover, hoverCell) => {
    set({ hover, hoverCell });
  },
  setCompare: (c) => {
    set({ compare: { ...get().compare, ...c } });
  },
  preview: (previewVersion) => {
    set({ previewVersion });
  },
  setHistory: (historyOpen) => {
    set({ historyOpen });
  },
  toggleKey: (open) => {
    set({ keyCollapsed: open === undefined ? !get().keyCollapsed : !open });
  },
  setKeyFilter: (keyFilter) => {
    set({ keyFilter });
  },
  editRoom: (editRoomId) => {
    set({ editRoomId });
  },
  setLegend: (legendOpen) => {
    set({ legendOpen });
  },
  pulseRooms: (ids) => {
    set({ pulse: ids.length > 0 ? { ids, at: Date.now() } : null });
  },
  setPng: (pngOpen) => {
    set({ pngOpen });
  },
  setApprove: (approveOpen) => {
    set({ approveOpen });
  },
  setIssues: (issues) => {
    set({ issues });
  },
  setIssuesOpen: (issuesOpen) => {
    set({ issuesOpen });
  },
  reset: () => {
    set({ ...initial, sel: emptySel(), fitTick: get().fitTick + 1 });
  },
}));

export function displayOptions(l: Layers): DisplayOptions {
  return {
    grid: l.grid,
    roomNumbers: l.roomNumbers,
    roomNames: l.roomNames,
    furniture: l.furniture,
    gmLayer: l.gmLayer,
    legend: false,
  };
}
