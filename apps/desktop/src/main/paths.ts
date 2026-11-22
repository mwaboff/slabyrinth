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
  /** The TaleSpire add-on link's pairing token. */
  linkTokenFile: string;
  /** A paired copy of the add-on, prepared for installing it by hand. */
  addonPackage: string;
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
    linkTokenFile: path.join(u, "talespire-link.json"),
    addonPackage: path.join(u, "talespire-addon"),
    defaultProjectsFolder: inputs.projectsFolderOverride ?? path.join(inputs.documents, "Slabyrinth"),
  };
}
