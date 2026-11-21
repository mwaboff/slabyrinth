/** The fake main's TaleSpire, asset-catalog and palette channels (a pretend install, the bundled palettes alone). */
import { bundledPalettes, resolvePalettesData } from "@slabyrinth/core/palette";
import type { FakeState, HandlerGroup } from "../state";

type TaleSpireChannels =
  | "talespire:locate"
  | "talespire:setPath"
  | "catalog:status"
  | "catalog:refresh"
  | "talespire:copyAndOpen"
  | "talespire:isRunning"
  | "talespire:openUrl"
  | "palettes:list"
  | "palettes:reload"
  | "palettes:openFolder"
  | "palettes:resolveData";

const FAKE_INSTALL = "D:\\SteamLibrary\\steamapps\\common\\TaleSpire";
/** Asset counts the fake catalog reports: the built-in list alone, and a scanned install. */
const BUILTIN_ASSETS = 125;
const INSTALL_ASSETS = 4854;

export function taleSpireHandlers(s: FakeState): HandlerGroup<TaleSpireChannels> {
  return {
    "talespire:locate": async () => {
      await s.sleep(900);
      return { found: s.catalogState === "no_install" ? [] : [{ path: FAKE_INSTALL, source: "steam" }] };
    },
    "talespire:setPath": async ({ path }) => {
      await s.sleep(400);
      if (path === null) return { valid: false, reason: "No folder chosen." };
      s.catalogState = "fresh";
      s.settings.talespire.installPath = path;
      return { valid: true };
    },
    "catalog:status": () => ({
      state: s.catalogState,
      usingBuiltInOnly: s.catalogState === "no_install",
      generatedAt: s.catalogState === "no_install" ? null : new Date().toISOString(),
      assets: s.catalogState === "no_install" ? BUILTIN_ASSETS : INSTALL_ASSETS,
      lastReport: null,
    }),
    "catalog:refresh": async () => {
      await s.sleep(1200);
      return {
        previousGeneratedAt: new Date(Date.now() - 86_400_000).toISOString(),
        sourceUsed: {},
        added: 42,
        removed: [],
        newlyDeprecated: [],
        geometryChanged: [],
        affectedPaletteRoles: [],
      };
    },
    "talespire:copyAndOpen": async ({ chunk }) => {
      await s.sleep(250);
      s.markCopied(chunk);
      if (s.catalogState === "no_install") return { copied: true, running: false, action: "not_installed" };
      const wasRunning = s.tsRunning;
      s.tsRunning = true;
      return { copied: true, running: wasRunning, action: wasRunning ? "focused" : "launched" };
    },
    "talespire:isRunning": () => ({ running: s.tsRunning }),
    "talespire:openUrl": () => {
      s.tsRunning = true;
      return { opened: true };
    },
    "palettes:list": () => [
      { id: "stone_dungeon", name: "Stone dungeon", source: "bundled", issues: 0 },
      { id: "cave", name: "Cave", source: "bundled", issues: 0 },
      { id: "forest", name: "Forest", source: "bundled", issues: 0 },
      { id: "town", name: "Town", source: "bundled", issues: 0 },
      { id: "tavern", name: "Tavern", source: "bundled", extends: "town", issues: 0 },
    ],
    "palettes:reload": () => undefined,
    "palettes:openFolder": () => undefined,
    // the fake main builds with the bundled palettes alone (no user files, no game catalog)
    "palettes:resolveData": () => resolvePalettesData(bundledPalettes()),
  };
}
