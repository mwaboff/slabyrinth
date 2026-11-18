/**
 * Native dialogs as a port, so services stay testable and e2e/smoke runs never block on a modal.
 * The Electron implementation lives in main/app.ts; tests and headless runs use a scripted fake.
 */
export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface Dialogs {
  openFile(opts: { title: string; filters: FileFilter[]; defaultPath?: string }): Promise<string | null>;
  saveFile(opts: { title: string; defaultPath: string; filters: FileFilter[] }): Promise<string | null>;
  chooseFolder(opts: { title: string; defaultPath?: string }): Promise<string | null>;
  /** Returns true when the user picks the first (affirmative) button. */
  confirm(opts: {
    title: string;
    message: string;
    detail?: string;
    okLabel: string;
    cancelLabel: string;
  }): Promise<boolean>;
}

/** Headless dialogs: every prompt is cancelled (used in smoke/e2e runs and as the test default). */
export const cancelAllDialogs: Dialogs = {
  openFile: () => Promise.resolve(null),
  saveFile: () => Promise.resolve(null),
  chooseFolder: () => Promise.resolve(null),
  confirm: () => Promise.resolve(false),
};

export const PROJECT_FILTER: FileFilter = { name: "Slabyrinth project", extensions: ["slabyrinth"] };
