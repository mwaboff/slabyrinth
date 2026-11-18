/** App-level UI state: route, overlays, toasts, banners, theme. */
import { create } from "zustand";

export type Route = "boot" | "setup" | "home" | "workspace";
export type SettingsSection = "ai" | "spending" | "talespire" | "projects" | "appearance" | "about";

export interface Toast {
  id: number;
  lead: string;
  body?: string;
  tone?: "ok" | "warn" | "error";
  action?: { label: string; run: () => void };
  ms?: number;
}

export interface ConfirmRequest {
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  onConfirm: () => void;
}

interface AppState {
  route: Route;
  platform: "win32" | "linux" | "darwin";
  version: string;
  settingsOpen: SettingsSection | null;
  shortcutsOpen: boolean;
  menuOpen: boolean;
  toasts: Toast[];
  confirm: ConfirmRequest | null;
  /** Non-blocking banners under the title bar. */
  banners: { tsMissing: boolean; offline: boolean; saveFailed: string | null };
  tsBannerDismissed: boolean;
  chatCollapsed: boolean;
  briefOpen: boolean | null;
  setBriefOpen: (open: boolean | null) => void;
  setRoute: (r: Route) => void;
  openSettings: (s?: SettingsSection) => void;
  closeSettings: () => void;
  setShortcuts: (open: boolean) => void;
  setMenu: (open: boolean) => void;
  toast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
  askConfirm: (c: ConfirmRequest | null) => void;
  setBanner: (patch: Partial<AppState["banners"]>) => void;
  dismissTsBanner: () => void;
  toggleChat: (open?: boolean) => void;
  setInfo: (platform: AppState["platform"], version: string) => void;
}

let toastSeq = 1;

export const useApp = create<AppState>((set, get) => ({
  route: "boot",
  platform: "linux",
  version: "",
  settingsOpen: null,
  shortcutsOpen: false,
  menuOpen: false,
  toasts: [],
  confirm: null,
  banners: { tsMissing: false, offline: false, saveFailed: null },
  tsBannerDismissed: false,
  chatCollapsed: false,
  briefOpen: null,
  setBriefOpen: (briefOpen) => {
    set({ briefOpen });
  },
  setRoute: (route) => {
    set({ route, menuOpen: false });
  },
  openSettings: (s = "ai") => {
    set({ settingsOpen: s, menuOpen: false });
  },
  closeSettings: () => {
    set({ settingsOpen: null });
  },
  setShortcuts: (shortcutsOpen) => {
    set({ shortcutsOpen });
  },
  setMenu: (menuOpen) => {
    set({ menuOpen });
  },
  toast: (t) => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts.slice(-2), { ...t, id }] });
    setTimeout(() => {
      get().dismissToast(id);
    }, t.ms ?? 4000);
  },
  dismissToast: (id) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  askConfirm: (confirm) => {
    set({ confirm });
  },
  setBanner: (patch) => {
    set({ banners: { ...get().banners, ...patch } });
  },
  dismissTsBanner: () => {
    set({ tsBannerDismissed: true });
  },
  toggleChat: (open) => {
    set({ chatCollapsed: open === undefined ? !get().chatCollapsed : !open });
  },
  setInfo: (platform, version) => {
    set({ platform, version });
  },
}));
