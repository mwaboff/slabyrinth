/** Update notice state (decisions.md "Update notice"). Main does every check; this store only mirrors it. */
import { create } from "zustand";
import type { UpdateStatus } from "../../shared/ipc";
import { tryCall } from "../bridge/client";

interface UpdatesState {
  status: UpdateStatus | null;
  /** "Later": hide the chip for this session (until a newer status arrives). */
  laterFor: string | null;
  set: (s: UpdateStatus) => void;
  load: () => Promise<void>;
  /** Manual "Check for updates" (ignores the daily throttle). Never throws. */
  check: () => Promise<void>;
  skip: (version: string) => Promise<void>;
  later: () => void;
}

export const useUpdates = create<UpdatesState>((set, get) => ({
  status: null,
  laterFor: null,
  set: (status) => {
    set({ status });
  },
  load: async () => {
    const r = await tryCall("updates:status", undefined);
    if (r.ok) set({ status: r.value });
  },
  check: async () => {
    const cur = get().status;
    if (cur) set({ status: { ...cur, state: "checking" } });
    const r = await tryCall("updates:check", { manual: true });
    if (r.ok) set({ status: r.value, laterFor: null });
    else if (cur) set({ status: { ...cur, state: "failed" } });
  },
  skip: async (version) => {
    const r = await tryCall("updates:skip", { version });
    if (r.ok) set({ status: r.value });
  },
  later: () => {
    set({ laterFor: get().status?.update?.version ?? null });
  },
}));

/** The chip shows only for an available, not skipped, not "Later"-ed version. */
export function chipVersion(s: Pick<UpdatesState, "status" | "laterFor">): string | null {
  const st = s.status;
  if (st?.state !== "available" || !st.update || st.skipped) return null;
  return st.update.version === s.laterFor ? null : st.update.version;
}
