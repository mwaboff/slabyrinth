/**
 * The TaleSpire add-on store against the fake bridge (main's stand-in, validated with main's request schemas): each
 * state the designer shows, each action, and the selectors the UI reads.
 */
import { afterEach, describe, expect, it } from "vitest";
import { setBridge } from "../bridge/client";
import { createFakeBridge, parseScenario } from "../bridge/fake/fakeBridge";
import { fakeAddonStatus, fakeLinkStatus } from "../bridge/fake/talespireLink";
import {
  addonAction,
  autoUpdated,
  canSend,
  hotkeysNeedFallback,
  placingProgress,
  updatePromptOpen,
  useTaleSpireLink,
} from "./talespireLink";

afterEach(() => {
  useTaleSpireLink.setState({ addon: null, link: null, busy: null, error: null });
});

function bridge(flags: string) {
  const b = createFakeBridge({ scenario: parseScenario(`?fake=${flags}`), speed: 0 });
  setBridge(b);
  b.on("addon:changed", (s) => {
    useTaleSpireLink.getState().setAddon(s);
  });
  b.on("link:changed", (s) => {
    useTaleSpireLink.getState().setLink(s);
  });
  return b;
}

describe("install, update, uninstall", () => {
  it("loads the state, installs, and the row then offers nothing", async () => {
    bridge("addon-missing");
    await useTaleSpireLink.getState().load();
    expect(addonAction(useTaleSpireLink.getState().addon)).toBe("install");
    expect(await useTaleSpireLink.getState().install()).toBe(true);
    expect(useTaleSpireLink.getState().addon).toMatchObject({
      state: "installed",
      update: { state: "updated" },
    });
    expect(addonAction(useTaleSpireLink.getState().addon)).toBe("none");
  });

  it("not found: the row offers to choose the folder, and install fails with the reason kept", async () => {
    bridge("addon-notfound");
    await useTaleSpireLink.getState().load();
    expect(addonAction(useTaleSpireLink.getState().addon)).toBe("choose_folder");
    expect(await useTaleSpireLink.getState().install()).toBe(false);
    expect(useTaleSpireLink.getState().error).toMatchObject({ action: "install", code: "not_found" });
    expect(useTaleSpireLink.getState().busy).toBeNull();
  });

  it("outdated after a failed automatic update: the dialog is open with the reason; update now closes it", async () => {
    bridge("addon-autofail");
    await useTaleSpireLink.getState().load();
    const a = useTaleSpireLink.getState().addon;
    expect(updatePromptOpen(a)).toBe(true);
    expect(a?.prompt.reason).toMatch(/failed/);
    expect(addonAction(a)).toBe("update");
    await useTaleSpireLink.getState().install();
    expect(updatePromptOpen(useTaleSpireLink.getState().addon)).toBe(false);
  });

  it('"don\'t ask again" closes the dialog for this version and keeps the outdated status', async () => {
    bridge("addon-outdated");
    await useTaleSpireLink.getState().load();
    await useTaleSpireLink.getState().dismissPrompt();
    const a = useTaleSpireLink.getState().addon;
    expect(a).toMatchObject({ state: "outdated", prompt: { show: false } });
  });

  it("uninstall drops the link; a foreign folder is refused", async () => {
    bridge("addon-installed,helper-connected");
    await useTaleSpireLink.getState().load();
    expect(await useTaleSpireLink.getState().uninstall()).toBe(true);
    expect(useTaleSpireLink.getState().addon?.state).toBe("missing");
    expect(useTaleSpireLink.getState().link?.helper.state).toBe("none");
    bridge("addon-foreign");
    await useTaleSpireLink.getState().load();
    expect(addonAction(useTaleSpireLink.getState().addon)).toBe("blocked");
    expect(await useTaleSpireLink.getState().uninstall()).toBe(false);
    expect(useTaleSpireLink.getState().error?.code).toBe("validation");
  });

  it("a folder chosen by hand shows its warning and the copy left behind; move installs and removes it", async () => {
    bridge("addon-installed");
    await useTaleSpireLink.getState().load();
    await useTaleSpireLink.getState().chooseFolder();
    const a = useTaleSpireLink.getState().addon;
    expect(a).toMatchObject({ folderSource: "manual", state: "missing" });
    expect(a?.folderWarning).toMatch(/doesn't look like/);
    expect(a?.elsewhere).not.toBeNull();
    expect(await useTaleSpireLink.getState().move()).toBe(true);
    expect(useTaleSpireLink.getState().addon).toMatchObject({ state: "installed", elsewhere: null });
  });
});

describe("send to the add-on", () => {
  it("cannot send with no add-on connected", async () => {
    bridge("helper-none");
    await useTaleSpireLink.getState().load();
    expect(canSend(useTaleSpireLink.getState().link)).toBe(false);
  });

  it("the button can be enabled the moment the add-on connects (link:changed), whatever was open first", async () => {
    const b = bridge("helper-none");
    await useTaleSpireLink.getState().load();
    b.emit("link:changed", fakeLinkStatus({ helper: "connected" }));
    expect(canSend(useTaleSpireLink.getState().link)).toBe(true);
    expect(canSend(useTaleSpireLink.getState().link, "send")).toBe(false);
  });
});

describe("selectors", () => {
  it("progress, finished, hotkeys fallback, automatic update notice", () => {
    expect(placingProgress(null)).toBeNull();
    expect(
      placingProgress(fakeLinkStatus({ helper: "connected", placing: { name: "M", chunk: 3, total: 5 } })),
    ).toEqual({
      placed: 2,
      total: 5,
      finished: false,
    });
    expect(
      placingProgress(
        fakeLinkStatus({ helper: "connected", placing: { name: "M", chunk: 5, total: 5, phase: "done" } }),
      ),
    ).toEqual({ placed: 5, total: 5, finished: true });
    const placing = fakeLinkStatus({ helper: "connected", placing: { name: "M", chunk: 1, total: 2 } });
    expect(hotkeysNeedFallback(placing)).toBe(false);
    expect(hotkeysNeedFallback({ ...placing, hotkeys: { ...placing.hotkeys, state: "partial" } })).toBe(true);
    expect(hotkeysNeedFallback(fakeLinkStatus({ helper: "connected" }))).toBe(false);
    const updated = {
      ...fakeAddonStatus("installed"),
      update: {
        state: "updated" as const,
        automatic: true,
        from: "0.1.0",
        to: "0.2.0",
        at: "x",
        error: null,
      },
    };
    expect(autoUpdated(updated)).toEqual({ from: "0.1.0", to: "0.2.0" });
    expect(autoUpdated(fakeAddonStatus("installed"))).toBeNull();
  });
});
