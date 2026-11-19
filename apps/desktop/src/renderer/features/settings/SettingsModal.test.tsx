import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SlabyrinthApi } from "../../../shared/ipc";
import type { AppSettings } from "../../../shared/project";
import { setBridge } from "../../bridge/client";
import { useApp } from "../../stores/app";
import { useSettings } from "../../stores/settings";
import { SettingsModal, THIRD_PARTY_NOTICES_URL } from "./SettingsModal";

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
