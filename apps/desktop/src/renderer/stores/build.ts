/** buildStore (architecture §6.3): last bundle, compile progress, copy/paste tracking, paste guide. */
import { create } from "zustand";
import type { ExportBundle } from "@slabyrinth/core";
import type { IpcEvents } from "../../shared/ipc";
import { BridgeError, call, errorMessage } from "../bridge/client";
import { buildModel } from "../features/build/model";
import { initPaste, pasteReducer, type PasteEvent, type PasteState } from "../features/build/pasteMachine";
import { useApp } from "./app";
import { latestBuild, useProject } from "./project";

interface BuildState {
  bundle: ExportBundle | null;
  building: boolean;
  progress: IpcEvents["compile:progress"] | null;
  paste: PasteState | null;
  pasteFor: string | null;
  guideOpen: boolean;
  /** Slab id whose Copy button shows "Copied ✓" (2.5 s). */
  flash: { id: string; opened: boolean } | null;
  error: string | null;
  setProgress: (p: IpcEvents["compile:progress"]) => void;
  run: (version?: number) => Promise<void>;
  syncFromSnapshot: () => void;
  dispatch: (e: PasteEvent) => Promise<void>;
  copy: (slabId: string, openTaleSpire: boolean) => Promise<void>;
  setGuide: (open: boolean) => void;
  slabText: (slabId: string) => Promise<string | null>;
  reset: () => void;
}

class StaleBuildError extends Error {
  constructor() {
    super("This map changed since this build. Build again to copy it.");
  }
}

let flashTimer: ReturnType<typeof setTimeout> | null = null;

export const useBuild = create<BuildState>((set, get) => ({
  bundle: null,
  building: false,
  progress: null,
  paste: null,
  pasteFor: null,
  guideOpen: false,
  flash: null,
  error: null,
  setProgress: (progress) => {
    set({ progress });
  },
  reset: () => {
    set({
      bundle: null,
      building: false,
      progress: null,
      paste: null,
      pasteFor: null,
      guideOpen: false,
      flash: null,
      error: null,
    });
  },
  run: async (version) => {
    if (get().building) return;
    set({ building: true, progress: null, error: null });
    try {
      // No options: main reads the TaleSpire settings (BuildService.defaultOptions), the one place they become chunk
      // options. A copy here once turned "no pillars on single-slab builds" into alignment "none", so split builds
      // carried no pillars and every slab landed centred on the cursor (owner, 0.3.0).
      const bundle = await call("compile:run", version !== undefined ? { version } : {});
      set({ bundle });
      await useProject.getState().refresh();
      set({ pasteFor: null });
      get().syncFromSnapshot();
    } catch (e) {
      // pressing Cancel is not a failure: say it was stopped, don't show the "didn't finish" panel
      if (e instanceof BridgeError && e.appError.code === "cancelled")
        useApp.getState().toast({
          lead: "Build stopped.",
          body: "Nothing was changed. Build again when you're ready.",
        });
      else set({ error: errorMessage(e) });
    } finally {
      set({ building: false, progress: null });
    }
  },
  syncFromSnapshot: () => {
    const rec = latestBuild(useProject.getState().snap);
    if (!rec) {
      set({ paste: null, pasteFor: null });
      return;
    }
    const model = buildModel(rec, get().bundle?.planVersion === rec.versionNumber ? get().bundle : null);
    if (get().pasteFor === rec.id && get().paste) {
      // keep the guide step; refresh ticks from the record
      const cur = get().paste as PasteState;
      const pasted = { ...cur.pasted };
      for (const sl of model.slabs) pasted[sl.id] = sl.pasted;
      set({ paste: { ...cur, pasted } });
      return;
    }
    const saved = useProject.getState().resume.pasteGuide;
    const step = saved?.buildId === rec.id ? saved.currentStep : undefined;
    set({ paste: initPaste(model.slabs, step), pasteFor: rec.id });
  },
  dispatch: async (e) => {
    const cur = get().paste;
    const rec = latestBuild(useProject.getState().snap);
    if (!cur || !rec) return;
    const { state, effects } = pasteReducer(cur, e);
    set({ paste: state });
    for (const fx of effects) {
      if (fx.type === "copy") await get().copy(fx.slabId, true);
      else if (fx.type === "set_pasted")
        // the pasted tick is a convenience: the paste guide goes on without it, the failure is logged
        await call("build:setPasted", { buildId: rec.id, chunkId: fx.slabId, pasted: fx.pasted }).catch(
          (err: unknown) => {
            console.warn("[slabyrinth] could not record the pasted slab", err);
          },
        );
      else useProject.getState().savePasteGuide({ buildId: rec.id, currentStep: fx.step });
    }
  },
  slabText: async (slabId) => {
    let bundle = get().bundle;
    const rec = latestBuild(useProject.getState().snap);
    if (!rec) return null;
    if (bundle?.planVersion !== rec.versionNumber) {
      // Slab strings are not stored; recompile (deterministic) — WP5: build is read back from the snapshot.
      bundle = await call("compile:run", { version: rec.versionNumber });
      set({ bundle });
    }
    const chunk = bundle.chunks.find((c) => c.id === slabId);
    const recorded = rec.levels.flatMap((l) => l.chunks).find((c) => c.id === slabId);
    // A re-copy after a restart recompiles with the build's recorded settings; if the content differs the build is stale.
    if (!chunk || (recorded !== undefined && recorded.contentHash !== chunk.contentHash))
      throw new StaleBuildError();
    return chunk.slab;
  },
  copy: async (slabId, openTaleSpire) => {
    const rec = latestBuild(useProject.getState().snap);
    const toast = useApp.getState().toast;
    if (!rec) return;
    try {
      const raw = await get().slabText(slabId);
      if (raw === null) throw new Error("Slab not found — rebuild and try again.");
      const text = rec.settings.copyFormat === "fenced" ? "```\n" + raw + "\n```" : raw;
      const model = buildModel(rec, get().bundle);
      const row = model.slabs.find((s) => s.id === slabId);
      const which = model.single
        ? "Slab copied."
        : `Part ${row?.step ?? "?"} of ${model.slabs.length} copied.`;
      let opened = false;
      if (openTaleSpire) {
        // chunk: main records copiedAt on the BuildRecord chunk.
        const r = await call("talespire:copyAndOpen", { text, chunk: { buildId: rec.id, chunkId: slabId } });
        if (!r.copied) throw new Error("copy failed");
        opened = r.action === "focused" || r.action === "launched";
        if (r.action === "focused")
          toast({ lead: which, body: "TaleSpire is in front — press Ctrl+V in build mode." });
        else if (r.action === "launched")
          toast({
            lead: `${which} Starting TaleSpire…`,
            body: "Open your board, switch to build mode, and press Ctrl+V.",
            ms: 6000,
          });
        else if (r.action === "focus_unavailable")
          toast({ lead: which, body: "Switch to TaleSpire (Alt+Tab) and press Ctrl+V." });
        else if (r.action === "failed")
          toast({
            lead: "Slab copied, but TaleSpire didn't start.",
            body: "Start it from Steam, then press Ctrl+V in build mode.",
            tone: "warn",
          });
        else toast({ lead: which, body: "Paste it in TaleSpire with Ctrl+V in build mode." });
      } else {
        await call("clipboard:writeText", { text, chunk: { buildId: rec.id, chunkId: slabId } });
        toast({ lead: which, body: "In TaleSpire, press Ctrl+V in build mode." });
      }
      const cur = get().paste;
      if (cur)
        set({ paste: pasteReducer(cur, { type: "copied", slabId, at: new Date().toISOString() }).state });
      if (flashTimer !== null) clearTimeout(flashTimer);
      set({ flash: { id: slabId, opened } });
      flashTimer = setTimeout(() => {
        set({ flash: null });
      }, 2500);
    } catch (e) {
      if (e instanceof StaleBuildError) {
        toast({
          lead: "This map changed since this build.",
          body: "Build again to copy it.",
          tone: "warn",
          ms: 6000,
        });
        return;
      }
      toast({
        lead: "Couldn't copy to the clipboard.",
        body: `Use Show text and press Ctrl+C, or save it as a file. ${errorMessage(e)}`,
        tone: "error",
        ms: 6000,
      });
    }
  },
  setGuide: (guideOpen) => {
    set({ guideOpen });
  },
}));
