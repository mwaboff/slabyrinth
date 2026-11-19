import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SlabyrinthApi, UpdateStatus } from "../../../shared/ipc";
import type { AppSettings } from "../../../shared/project";
import { setBridge } from "../../bridge/client";
import { useApp } from "../../stores/app";
import { useSettings } from "../../stores/settings";
import { useUpdates } from "../../stores/updates";
import { SettingsModal } from "../settings/SettingsModal";
import { NOTES_MAX_LINES } from "../../../shared/releaseNotes";
import { TRUNCATED_TEXT } from "./ReleaseNotes";
import { INSTALL_TEXT, UpdateChip } from "./UpdateChip";

const NOTES =
  "### Added\n- Stamps\n\n<b>bold</b> **real bold** [link](https://evil.example) <img src=x onerror=alert(1)>";

function available(over: Partial<UpdateStatus> = {}, notes = NOTES): UpdateStatus {
  return {
    state: "available",
    currentVersion: "0.1.0",
    lastCheckedAt: "2026-12-01T10:00:00Z",
    update: {
      version: "0.2.0",
      tag: "v0.2.0",
      publishedAt: "2026-11-30T09:00:00Z",
      notes,
      url: "https://github.com/mwaboff/slabyrinth/releases/tag/v0.2.0",
    },
    skipped: false,
    ...over,
  };
}

function stubBridge(answer: (channel: string, req: unknown) => unknown): Array<[string, unknown]> {
  const calls: Array<[string, unknown]> = [];
  setBridge({
    invoke: (channel: string, req: unknown) => {
      calls.push([channel, req]);
      return Promise.resolve({ ok: true, value: answer(channel, req) });
    },
    on: () => () => undefined,
    send: () => undefined,
  } as unknown as SlabyrinthApi);
  return calls;
}

afterEach(() => {
  useUpdates.setState({ status: null, laterFor: null });
  useApp.setState({ platform: "linux" });
});

describe("UpdateChip", () => {
  it("appears only for an available, not skipped version", () => {
    const { container } = render(<UpdateChip />);
    expect(container).toBeEmptyDOMElement();
    for (const status of [
      { ...available(), state: "up_to_date" as const, update: null },
      { ...available(), state: "failed" as const, update: null },
      available({ skipped: true }),
    ]) {
      act(() => {
        useUpdates.setState({ status });
      });
      expect(container).toBeEmptyDOMElement();
    }
    act(() => {
      useUpdates.setState({ status: available() });
    });
    expect(screen.getByRole("button", { name: "Update available · 0.2.0" })).toBeInTheDocument();
  });

  it("opens a popover with date, formatted notes and install advice; Download opens the release page", async () => {
    useApp.setState({ platform: "win32" });
    useUpdates.setState({ status: available() });
    const calls = stubBridge((channel) => (channel === "shell:openExternal" ? { opened: true } : undefined));
    render(<UpdateChip />);
    const chip = screen.getByRole("button", { name: /Update available/ });
    await userEvent.click(chip);
    const pop = screen.getByRole("dialog", { name: "Update available" });
    expect(within(pop).getByText("Slabyrinth 0.2.0")).toBeInTheDocument();
    expect(pop).toHaveTextContent(/Published .*2026/);
    expect(pop).toHaveTextContent("you have 0.1.0");
    // Untrusted notes: the Markdown subset is formatted; HTML and links stay text.
    const notes = within(pop).getByLabelText("What's new");
    expect(within(notes).getByRole("heading", { name: "Added" })).toBeInTheDocument();
    expect(within(notes).getByRole("listitem")).toHaveTextContent("Stamps");
    expect(notes.querySelector("strong")).toHaveTextContent("real bold");
    expect(notes).toHaveTextContent("<b>bold</b> real bold link <img src=x onerror=alert(1)>");
    expect(pop.querySelector("img, a")).toBeNull();
    expect(notes.querySelector("b")).toBeNull();
    expect(notes.textContent).not.toContain("evil.example");
    expect(within(pop).getByText(INSTALL_TEXT.win32)).toBeInTheDocument();
    await userEvent.click(within(pop).getByRole("button", { name: "Download" }));
    expect(calls).toContainEqual([
      "shell:openExternal",
      { url: "https://github.com/mwaboff/slabyrinth/releases/tag/v0.2.0" },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(chip).toHaveFocus();
  });

  it("caps long notes with a plain-text note pointing to the release page", async () => {
    useUpdates.setState({ status: available({}, "- item\n".repeat(NOTES_MAX_LINES + 100)) });
    render(<UpdateChip />);
    await userEvent.click(screen.getByRole("button", { name: /Update available/ }));
    const notes = screen.getByLabelText("What's new");
    expect(within(notes).getAllByRole("listitem").length).toBeLessThanOrEqual(NOTES_MAX_LINES);
    expect(within(notes).getByText(TRUNCATED_TEXT)).toBeInTheDocument();
    expect(notes.querySelector("a")).toBeNull();
  });

  it("Skip this version asks main and hides the chip; Later hides it for this session", async () => {
    useUpdates.setState({ status: available() });
    const calls = stubBridge((channel) =>
      channel === "updates:skip" ? available({ skipped: true }) : undefined,
    );
    const { container } = render(<UpdateChip />);
    await userEvent.click(screen.getByRole("button", { name: /Update available/ }));
    await userEvent.click(screen.getByRole("button", { name: "Skip this version" }));
    expect(calls).toContainEqual(["updates:skip", { version: "0.2.0" }]);
    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });

    act(() => {
      useUpdates.setState({ status: available() });
    });
    await userEvent.click(screen.getByRole("button", { name: /Update available/ }));
    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(container).toBeEmptyDOMElement();
    // A newer version shows again.
    act(() => {
      useUpdates.setState({
        status: available({
          update: { ...(available().update as NonNullable<UpdateStatus["update"]>), version: "0.3.0" },
        }),
      });
    });
    expect(screen.getByRole("button", { name: "Update available · 0.3.0" })).toBeInTheDocument();
  });

  it("has install advice for every release target", () => {
    expect(INSTALL_TEXT.win32).toMatch(/installer.*portable/);
    expect(INSTALL_TEXT.linux).toMatch(/AppImage/);
    for (const t of Object.values(INSTALL_TEXT)) expect(t).toMatch(/settings, key and maps are kept/);
  });
});

describe("Settings ▸ About ▸ Updates", () => {
  function openAbout(updates: AppSettings["updates"]) {
    useApp.setState({ settingsOpen: "about", version: "0.1.0" });
    useSettings.setState({
      settings: {
        defaultSelection: { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "medium" },
        updates,
      } as unknown as AppSettings,
    });
    render(<SettingsModal />);
  }

  it("checks on demand and shows each state", async () => {
    let answer: UpdateStatus = { ...available(), state: "up_to_date", update: null };
    const calls = stubBridge((channel) => {
      if (channel === "updates:check") return answer;
      if (channel === "app:getInfo") return { version: "0.1.0", platform: "linux", userDataPath: "/data" };
      return undefined;
    });
    useUpdates.setState({
      status: { state: "idle", currentVersion: "0.1.0", lastCheckedAt: null, update: null, skipped: false },
    });
    openAbout({ autoCheck: true });
    expect(screen.getByText("Not checked yet.")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Check for updates" });
    await userEvent.click(btn);
    expect(calls).toContainEqual(["updates:check", { manual: true }]);
    expect(await screen.findByText("You're up to date.")).toBeInTheDocument();

    answer = { ...available(), state: "failed", update: null };
    await userEvent.click(btn);
    expect(await screen.findByText("Couldn't check for updates. Try again later.")).toBeInTheDocument();

    answer = available({ skipped: true });
    await userEvent.click(btn);
    expect(await screen.findByText(/Slabyrinth 0\.2\.0 is available \(you skipped it\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();

    act(() => {
      useUpdates.setState({ status: { ...available(), state: "checking" } });
    });
    expect(screen.getByText("Checking for updates…")).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  it("the automatic-check toggle writes settings.updates.autoCheck", async () => {
    const calls = stubBridge((channel, req) => {
      if (channel === "settings:update") return { updates: (req as { updates: unknown }).updates };
      if (channel === "app:getInfo") return { version: "0.1.0", platform: "linux", userDataPath: "/data" };
      return undefined;
    });
    openAbout({ autoCheck: true });
    const box = screen.getByRole("checkbox", { name: /Check for updates automatically/ });
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(calls).toContainEqual(["settings:update", { updates: { autoCheck: false } }]);
  });
});
