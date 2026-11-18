import * as path from "node:path";

/** Every file location the main process uses (architecture §6.4 "Other files under userData"). */
export interface AppPaths {
  userData: string;
  logs: string;
  settingsFile: string;
  secretFile: string;
  catalogDir: string;
  catalogFile: string;
  userPalettes: string;
  orientationOverride: string;
  thumbs: string;
  windowState: string;
  /** Default projects folder (Documents/Slabyrinth). */
  defaultProjectsFolder: string;
}

export interface PathInputs {
  userData: string;
  documents: string;
  /** Test/dev override of the projects folder. */
  projectsFolderOverride?: string | undefined;
}

export function makeAppPaths(inputs: PathInputs): AppPaths {
  const u = inputs.userData;
  return {
    userData: u,
    logs: path.join(u, "logs"),
    settingsFile: path.join(u, "settings.json"),
    secretFile: path.join(u, "secret.bin"),
    catalogDir: path.join(u, "catalog"),
    catalogFile: path.join(u, "catalog", "catalog.json"),
    /** User palettes and overrides (bundled palettes and orientation are compiled into core). */
    userPalettes: path.join(u, "palettes"),
    orientationOverride: path.join(u, "orientation.json"),
    thumbs: path.join(u, "thumbs"),
    windowState: path.join(u, "window-state.json"),
    defaultProjectsFolder: inputs.projectsFolderOverride ?? path.join(inputs.documents, "Slabyrinth"),
  };
}
