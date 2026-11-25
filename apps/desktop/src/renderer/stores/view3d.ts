/**
 * The 3D tab's own view choices (renderer only, never saved): which level it shows up to, roofs, the kinds of piece
 * hidden through the colour key, the cut height, and whether the GM has dismissed the first-use hint. The choices
 * last while the project is open (switching Map ↔ 3D keeps them) and reset when another project opens; the hint, once
 * dismissed, stays dismissed until the app restarts (the settings file has no place for it without a contract change).
 */
import { create } from "zustand";
import type { ColourClass } from "@slabyrinth/scene3d";

export interface View3dChoices {
  /** Show this level and the ones below it (null: every level). */
  cutLevelId: string | null;
  roofsHidden: boolean;
  hiddenClasses: readonly ColourClass[];
  /** Hide what stands above this height in tiles (null: off). */
  cutHeight: number | null;
}

interface View3dUi extends View3dChoices {
  hintDismissed: boolean;
  helpOpen: boolean;
  setCutLevel: (id: string | null) => void;
  setRoofsHidden: (hidden: boolean) => void;
  toggleClass: (c: ColourClass) => void;
  showAllClasses: () => void;
  setCutHeight: (y: number | null) => void;
  dismissHint: () => void;
  setHelpOpen: (open: boolean) => void;
  /** Back to every level, roofs on, nothing hidden (a new project). The hint stays as it is. */
  resetView: () => void;
}

const fresh = (): View3dChoices => ({
  cutLevelId: null,
  roofsHidden: false,
  hiddenClasses: [],
  cutHeight: null,
});

export const useView3d = create<View3dUi>((set, get) => ({
  ...fresh(),
  hintDismissed: false,
  helpOpen: false,
  setCutLevel: (cutLevelId) => {
    if (cutLevelId !== get().cutLevelId) set({ cutLevelId, cutHeight: null });
  },
  setRoofsHidden: (roofsHidden) => {
    set({ roofsHidden });
  },
  toggleClass: (c) => {
    const h = get().hiddenClasses;
    set({ hiddenClasses: h.includes(c) ? h.filter((x) => x !== c) : [...h, c] });
  },
  showAllClasses: () => {
    set({ hiddenClasses: [] });
  },
  setCutHeight: (cutHeight) => {
    set({ cutHeight });
  },
  dismissHint: () => {
    set({ hintDismissed: true });
  },
  setHelpOpen: (helpOpen) => {
    set({ helpOpen });
  },
  resetView: () => {
    set({ ...fresh(), helpOpen: false });
  },
}));
