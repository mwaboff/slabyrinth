import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SlabyrinthApi } from "../../../shared/ipc";
import type { AppSettings } from "../../../shared/project";
import { bridge, setBridge } from "../../bridge/client";
import { createFakeBridge } from "../../bridge/fake/fakeBridge";
import { useApp } from "../../stores/app";
import { useSettings } from "../../stores/settings";
import { SettingsModal, THIRD_PARTY_NOTICES_URL } from "./SettingsModal";

/**
 * The settings controls against the fake main, which parses every request with main's own schemas: a control that
 * sends a field main refuses (0.3.0 spread the stored `talespire` group, with the main-owned installPath and
 * lastScanAt, into every change) leaves the setting unchanged here as it did in the app.
 */
describe("Settings controls save through main's request schema", () => {
  async function saved(): Promise<AppSettings> {
    const r = await bridge().invoke("settings:get", undefined);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }

  it("TaleSpire ▸ alignment pillars and level layout stick, and main-owned fields stay", async () => {
    setBridge(createFakeBridge({ speed: 0 }));
    await useSettings.getState().load();
    const before = await saved();
    expect(before.talespire).toMatchObject({ alignmentMarkers: false, levelLayout: "stacked" });
    useApp.setState({ settingsOpen: "talespire" });
    render(<SettingsModal />);
    await userEvent.click(
      screen.getByRole("checkbox", { name: /Add alignment pillars to single-slab builds/ }),
    );
    await waitFor(async () => {
      expect((await saved()).talespire.alignmentMarkers).toBe(true);
    });
    await userEvent.click(screen.getByRole("radio", { name: "Side by side" }));
    await waitFor(async () => {
      expect((await saved()).talespire.levelLayout).toBe("side_by_side");
    });
    const after = await saved();
    expect(after.talespire.installPath).toBe(before.talespire.installPath);
    expect(after.talespire.lastScanAt).toBe(before.talespire.lastScanAt);
    expect(useSettings.getState().settings?.talespire).toEqual(after.talespire);
  });

  it("Spending warnings and the projects folder go through as single fields", async () => {
    setBridge(createFakeBridge({ speed: 0 }));
    await useSettings.getState().load();
    const before = await saved();
    await useSettings.getState().update({ spending: { perActionWarnUsd: 3 } });
    await useSettings.getState().update({ projects: { folder: "D:\\Maps" } });
    const after = await saved();
    expect(after.spending).toEqual({ ...before.spending, perActionWarnUsd: 3 });
    expect(after.projects).toEqual({ ...before.projects, folder: "D:\\Maps" });
  });

  it("a patch spread from the stored settings does not compile", () => {
    const s = {
      talespire: { installPath: null, lastScanAt: null, levelLayout: "stacked", alignmentMarkers: false },
    };
    // never called: the point is the compile error under `npm run typecheck`
    const send = (): Promise<void> =>
      // @ts-expect-error installPath and lastScanAt are main-owned: settings:update refuses them
      useSettings.getState().update({ talespire: { ...s.talespire, alignmentMarkers: true } });
    expect(typeof send).toBe("function");
  });
});

describe("Settings ▸ About ▸ Licences", () => {
  it("opens the third-party notices in the repository", async () => {
    const calls: Array<[string, unknown]> = [];
    setBridge({
      invoke: (channel: string, req: unknown) => {
        calls.push([channel, req]);
        const value =
          channel === "app:getInfo"
            ? { version: "0.1.0", platform: "linux", userDataPath: "/data" }
            : undefined;
        return Promise.resolve({ ok: true, value });
      },
      on: () => () => undefined,
      send: () => undefined,
    } as unknown as SlabyrinthApi);
    useApp.setState({ settingsOpen: "about", version: "0.1.0" });
    useSettings.setState({
      settings: {
        defaultSelection: { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "medium" },
        updates: { autoCheck: true },
      } as unknown as AppSettings,
    });
    render(<SettingsModal />);
    expect(screen.getByText(/THIRD-PARTY-NOTICES\.txt in the app's folder/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Third-party notices" }));
    expect(calls).toContainEqual(["shell:openExternal", { url: THIRD_PARTY_NOTICES_URL }]);
    expect(THIRD_PARTY_NOTICES_URL).toMatch(
      /^https:\/\/github\.com\/mwaboff\/slabyrinth\/blob\/main\/apps\/desktop\/third-party\/THIRD-PARTY-NOTICES\.txt$/,
    );
  });
});
