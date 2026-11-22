/**
 * The add-on's surfaces against the fake bridge (main's stand-in): the status light, the dialog's live steps, the
 * uninstall confirmation, the update prompt and the build page's Send button turning on by itself.
 */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setBridge } from "../../bridge/client";
import { createFakeBridge, parseScenario } from "../../bridge/fake/fakeBridge";
import { fakeAddonStatus, fakeLinkStatus } from "../../bridge/fake/talespireLink";
import { ConfirmDialog } from "../../app/ConfirmDialog";
import { useApp } from "../../stores/app";
import { useTaleSpireLink } from "../../stores/talespireLink";
import { AddonDialog } from "./AddonDialog";
import { AddonIndicator } from "./AddonParts";
import { AddonUpdatePrompt, AddonUpdatedNotice } from "./AddonUpdate";
import { SendToTaleSpire } from "./SendToTaleSpire";

afterEach(() => {
  useTaleSpireLink.setState({
    addon: null,
    link: null,
    busy: null,
    error: null,
    stoppedSend: null,
    dialogOpen: false,
    promptSnoozed: false,
    noticeDismissed: false,
  });
  useApp.setState({ route: "boot", confirm: null });
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

describe("status light", () => {
  it("shows the state in words and opens the add-on dialog", async () => {
    useTaleSpireLink.setState({
      addon: fakeAddonStatus("missing"),
      link: fakeLinkStatus({ helper: "none" }),
    });
    render(<AddonIndicator />);
    const btn = screen.getByRole("button", { name: "TaleSpire add-on: Install TaleSpire add-on" });
    expect(screen.getByRole("status")).toHaveTextContent(/Install TaleSpire add-on\. It puts each slab/);
    await userEvent.click(btn);
    expect(useTaleSpireLink.getState().dialogOpen).toBe(true);
    act(() => {
      useTaleSpireLink.setState({
        link: fakeLinkStatus({ helper: "connected", placing: { name: "Keep", chunk: 2, total: 4 } }),
        addon: fakeAddonStatus("installed"),
      });
    });
    expect(screen.getByRole("button", { name: /Placing map · 2 of 4/ })).toBeInTheDocument();
  });
});

describe("add-on dialog", () => {
  it("installs in one click, then turns to Connected by itself; Escape closes it", async () => {
    const b = bridge("addon-missing");
    await useTaleSpireLink.getState().load();
    useTaleSpireLink.getState().openDialog();
    render(<AddonDialog />);
    const dialog = screen.getByRole("dialog", { name: "TaleSpire add-on" });
    expect(within(dialog).getByText("Turn on Symbiotes in TaleSpire")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    expect(await within(dialog).findByText(/Installed in TaleSpire's Symbiotes folder/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Open the Symbiotes panel and choose Slabyrinth Helper/),
    ).toBeInTheDocument();
    act(() => {
      b.emit("link:changed", fakeLinkStatus({ helper: "connected" }));
    });
    expect(within(dialog).getByText(/^Connected \(version/)).toBeInTheDocument();
    expect(within(dialog).getAllByText(/\(done\)/)).toHaveLength(3);
    await userEvent.keyboard("{Escape}");
    expect(useTaleSpireLink.getState().dialogOpen).toBe(false);
  });

  it("uninstall asks first, saying what is removed and what stays", async () => {
    bridge("addon-installed");
    await useTaleSpireLink.getState().load();
    useTaleSpireLink.getState().openDialog();
    render(
      <>
        <AddonDialog />
        <ConfirmDialog />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    const confirm = screen.getByRole("alertdialog", { name: "Uninstall the TaleSpire add-on?" });
    expect(confirm).toHaveTextContent(/removes Slabyrinth Helper \(its slabyrinth-helper folder\)/);
    expect(confirm).toHaveTextContent(/keeps the panel's own remembered look and hotkey choices/);
    await userEvent.click(within(confirm).getByRole("button", { name: "Uninstall" }));
    await vi.waitFor(() => {
      expect(useTaleSpireLink.getState().addon?.state).toBe("missing");
    });
  });

  it("not found: Change location is the way on, with the places looked", async () => {
    bridge("addon-notfound");
    await useTaleSpireLink.getState().load();
    useTaleSpireLink.getState().openDialog();
    render(<AddonDialog />);
    expect(screen.getAllByText("Add-on folder not found").length).toBeGreaterThan(0);
    expect(screen.getByText("Places Slabyrinth looked")).toBeInTheDocument();
    // TaleSpire's own setting and its folder button, by their names in TaleSpire
    expect(screen.getByText("Game Settings > Modding Settings > Symbiotes")).toBeInTheDocument();
    expect(screen.getByText("Enable Symbiotes")).toBeInTheDocument();
    expect(screen.getByText(/press "Open Symbiotes Directory" in TaleSpire/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Change location…" }));
    // the fake's picker returns a folder that doesn't look like TaleSpire's: kept, with a warning
    expect(await screen.findByText(/doesn't look like TaleSpire's Symbiotes folder/)).toBeInTheDocument();
    expect(screen.getByText("Chosen by you")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use automatic detection" })).toBeInTheDocument();
  });
});

describe("installed by hand where Slabyrinth doesn't look", () => {
  it("the light says connected; the dialog's Folder row says what is wrong with the folder", () => {
    useTaleSpireLink.setState({
      addon: fakeAddonStatus("not_found"),
      link: fakeLinkStatus({ helper: "connected" }),
      dialogOpen: true,
    });
    render(
      <>
        <AddonIndicator />
        <AddonDialog />
      </>,
    );
    expect(screen.getByRole("button", { name: "TaleSpire add-on: Add-on connected" })).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "TaleSpire add-on" });
    expect(within(dialog).getByText(/connected, but Slabyrinth couldn't find/)).toBeInTheDocument();
  });
});

describe("update prompt and notice", () => {
  it("offers the update with the plain reason; Update now closes it", async () => {
    useApp.setState({ route: "home" });
    bridge("addon-autofail");
    await useTaleSpireLink.getState().load();
    render(<AddonUpdatePrompt />);
    const dialog = screen.getByRole("dialog", { name: "Update the TaleSpire add-on?" });
    expect(dialog).toHaveTextContent(/A file of the add-on is in use/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Update now" }));
    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("Not now closes it for this session; Don't ask again is saved", async () => {
    useApp.setState({ route: "home" });
    bridge("addon-autofail");
    await useTaleSpireLink.getState().load();
    const { unmount } = render(<AddonUpdatePrompt />);
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();
    useTaleSpireLink.setState({ promptSnoozed: false });
    render(<AddonUpdatePrompt />);
    await userEvent.click(screen.getByRole("button", { name: "Don't ask again for this version" }));
    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(useTaleSpireLink.getState().addon?.prompt.show).toBe(false);
  });

  it("an automatic update is a quiet, dismissible notice", async () => {
    const addon = fakeAddonStatus("installed");
    addon.update = { state: "updated", automatic: true, from: "0.2.0", to: "0.3.0", at: null, error: null };
    useTaleSpireLink.setState({ addon });
    render(<AddonUpdatedNotice />);
    expect(screen.getByRole("status")).toHaveTextContent("Slabyrinth Helper was updated (0.2.0 → 0.3.0).");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Send to TaleSpire", () => {
  it("turns on by itself the moment the add-on connects", async () => {
    useTaleSpireLink.setState({
      addon: fakeAddonStatus("installed"),
      link: fakeLinkStatus({ helper: "none" }),
    });
    const send = vi.fn(() => Promise.resolve(true));
    useTaleSpireLink.setState({ send });
    render(<SendToTaleSpire buildId="b1" multi={false} anchor={null} emptyChunk={false} />);
    expect(screen.getByText(/Open the Slabyrinth panel in TaleSpire/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send to TaleSpire" })).toBeDisabled();
    act(() => {
      useTaleSpireLink.getState().setLink(fakeLinkStatus({ helper: "connected" }));
    });
    const btn = screen.getByRole("button", { name: "Send to TaleSpire" });
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    expect(send).toHaveBeenCalledWith("b1");
  });

  it("while placing: progress, hotkeys, Stop; a multi-slab build shows where to paste", () => {
    const link = fakeLinkStatus({ helper: "connected", placing: { name: "Keep", chunk: 2, total: 3 } });
    useTaleSpireLink.setState({
      addon: fakeAddonStatus("installed"),
      link: { ...link, send: { ...link.send, buildId: "b1" } },
    });
    render(
      <SendToTaleSpire
        buildId="b1"
        multi
        anchor={{ side: "south", clearanceCells: 4, farMarkerCells: 31 }}
        emptyChunk={false}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "Slabs placed" })).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByRole("list", { name: "Hotkeys in TaleSpire" })).toHaveTextContent("Ctrl Alt D");
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(screen.getByRole("list", { name: "Placing a map of several slabs" })).toHaveTextContent(
      /31 empty cells between it and the map southward/,
    );
  });

  it("Sending… has a Stop; a send that gets no answer says so plainly and offers Send again", async () => {
    bridge("addon-installed,helper-connected");
    await useTaleSpireLink.getState().load();
    const link = useTaleSpireLink.getState().link;
    if (!link) throw new Error("no link");
    act(() => {
      useTaleSpireLink
        .getState()
        .setLink({ ...link, send: { ...link.send, state: "sending", buildId: "b1" } });
    });
    render(<SendToTaleSpire buildId="b1" multi={false} anchor={null} emptyChunk={false} />);
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    // main still says sending (no deadline yet): the panel lets go of it anyway
    expect(await screen.findByRole("button", { name: "Send to TaleSpire" })).toBeEnabled();
    act(() => {
      useTaleSpireLink
        .getState()
        .setLink({ ...link, send: { ...link.send, state: "failed", buildId: "b1", error: null } });
    });
    expect(
      screen.getByText("TaleSpire didn't answer. Check the Slabyrinth panel is open, then send again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send again" })).toBeEnabled();
    // main's own reason (its 30 s deadline) is shown plainly, once
    const late =
      "The add-on didn't answer within 30 seconds. Check Slabyrinth Helper in TaleSpire, then send again.";
    act(() => {
      useTaleSpireLink
        .getState()
        .setLink({ ...link, send: { ...link.send, state: "failed", buildId: "b1", error: late } });
    });
    expect(screen.getAllByText(late)).toHaveLength(1);
  });

  it("Stop while main prepares the map is a quiet cancel", async () => {
    setBridge({
      ...createFakeBridge({ scenario: parseScenario(""), speed: 0 }),
      invoke: () => Promise.resolve({ ok: false, error: { code: "cancelled", message: "Cancelled." } }),
    } as unknown as Parameters<typeof setBridge>[0]);
    // the real action (another test here swaps `send` for a mock)
    useTaleSpireLink.setState({ send: useTaleSpireLink.getInitialState().send });
    expect(await useTaleSpireLink.getState().send("b1")).toBe(false);
    expect(useTaleSpireLink.getState().error).toBeNull();
  });

  it("not installed: one line and a button to the dialog; an empty slab is refused in plain words", async () => {
    useTaleSpireLink.setState({
      addon: fakeAddonStatus("missing"),
      link: fakeLinkStatus({ helper: "none" }),
    });
    const { unmount } = render(
      <SendToTaleSpire buildId="b1" multi={false} anchor={null} emptyChunk={false} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Set up the TaleSpire add-on" }));
    expect(useTaleSpireLink.getState().dialogOpen).toBe(true);
    unmount();
    useTaleSpireLink.setState({
      addon: fakeAddonStatus("installed"),
      link: fakeLinkStatus({ helper: "connected" }),
    });
    render(<SendToTaleSpire buildId="b1" multi={false} anchor={null} emptyChunk />);
    expect(screen.getByText(/TaleSpire crashes on an empty slab/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send to TaleSpire" })).toBeDisabled();
  });
});
