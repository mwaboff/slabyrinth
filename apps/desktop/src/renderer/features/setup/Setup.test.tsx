import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IpcRequests, SlabyrinthApi } from "../../../shared/ipc";
import type { AppSettings } from "../../../shared/project";
import type { ProviderInfo } from "../../../main/agent/provider/types";
import { setBridge } from "../../bridge/client";
import { useApp } from "../../stores/app";
import { useSettings } from "../../stores/settings";
import { SettingsModal } from "../settings/SettingsModal";
import { ApiKeyField, KEY_STORAGE_TEXT, KeyStorageNote, UNREADABLE_KEY_TEXT, UnreadableKeyNote } from "./Setup";

type Row = IpcRequests["secrets:status"]["res"]["anthropic"];
type Status = Record<string, Row>;
const KEY = "sk-ant-api03-TYPED-not-real-0000000000-x7X7";

/** Records every IPC call; `answer` gives each channel's value. */
function stubBridge(answer: (channel: string, req: unknown) => unknown): Array<[string, unknown]> {
  const calls: Array<[string, unknown]> = [];
  const api = {
    invoke: (channel: string, req: unknown) => {
      calls.push([channel, req]);
      return Promise.resolve({ ok: true, value: answer(channel, req) });
    },
    on: () => () => undefined,
    send: () => undefined,
  };
  setBridge(api as unknown as SlabyrinthApi);
  return calls;
}

afterEach(() => {
  useSettings.setState({ secrets: {}, settings: null, providers: [], models: [] });
});

describe("UnreadableKeyNote", () => {
  it("tells the user to enter the key again when the saved key can't be decrypted", () => {
    useSettings.setState({
      secrets: { anthropic: { hasKey: false, backend: "os", hint: null, unreadable: true } },
    });
    render(<UnreadableKeyNote />);
    expect(screen.getByRole("status")).toHaveTextContent(UNREADABLE_KEY_TEXT);
    expect(UNREADABLE_KEY_TEXT).toMatch(/could not be read.*Enter it again/);
  });

  it("shows nothing when there is no stale key, and disappears once a new key is stored", () => {
    useSettings.setState({ secrets: { anthropic: { hasKey: false, backend: null, hint: null } } });
    const { container } = render(<UnreadableKeyNote />);
    expect(container).toBeEmptyDOMElement();
    act(() => {
      useSettings.setState({
        secrets: { anthropic: { hasKey: false, backend: "os", hint: null, unreadable: true } },
      });
    });
    expect(screen.getByText(UNREADABLE_KEY_TEXT)).toBeInTheDocument();
    act(() => {
      useSettings.setState({ secrets: { anthropic: { hasKey: true, backend: "os", hint: "sk-ant-…c3D4" } } });
    });
    expect(container).toBeEmptyDOMElement();
  });
});

describe("KeyStorageNote", () => {
  it("claims secure storage only for the OS backend, and says the truth otherwise", () => {
    const row = (backend: Row["backend"], extra: Partial<Row> = {}) => ({
      anthropic: { hasKey: backend !== null, backend, hint: backend ? "sk-ant-…a1B2" : null, ...extra },
    });
    useSettings.setState({ secrets: row("os") });
    const { container, rerender } = render(<KeyStorageNote />);
    expect(container).toHaveTextContent(KEY_STORAGE_TEXT.os);
    for (const [backend, text] of [
      ["basic_text", KEY_STORAGE_TEXT.basic_text],
      ["memory_only", KEY_STORAGE_TEXT.memory_only],
      [null, KEY_STORAGE_TEXT.none],
    ] as const) {
      act(() => {
        useSettings.setState({ secrets: row(backend) });
      });
      rerender(<KeyStorageNote />);
      expect(container).toHaveTextContent(text);
      expect(container).not.toHaveTextContent(/secure storage/);
    }
    expect(KEY_STORAGE_TEXT.memory_only).toBe(
      "No system keyring was found, so the key is kept for this session only and you'll need to enter it again next time.",
    );
    // No "Store anyway" unless main says weak storage is possible.
    expect(screen.queryByRole("button", { name: /Store anyway/ })).toBeNull();
  });

  it("'Store anyway (less secure)' asks main to persist the session key (no key in the request)", async () => {
    let status: Status = {
      anthropic: { hasKey: true, backend: "memory_only", hint: "sk-ant-…a1B2", weakAvailable: true },
    };
    const calls = stubBridge((channel) => {
      if (channel === "secrets:storeWeak") {
        status = { anthropic: { hasKey: true, backend: "basic_text", hint: "sk-ant-…a1B2" } };
        return { stored: true, backend: "basic_text" };
      }
      if (channel === "secrets:status") return status;
      return undefined;
    });
    useSettings.setState({ secrets: status });
    render(<KeyStorageNote />);
    await userEvent.click(screen.getByRole("button", { name: "Store anyway (less secure)" }));
    await screen.findByText(KEY_STORAGE_TEXT.basic_text);
    expect(calls).toContainEqual(["secrets:storeWeak", { providerId: "anthropic" }]);
  });
});

describe("ApiKeyField", () => {
  function rigKey(check: IpcRequests["secrets:setApiKey"]["res"]["check"], keep: boolean) {
    return stubBridge((channel) => {
      if (channel === "secrets:setApiKey") return { stored: keep, backend: "os", check };
      if (channel === "secrets:status")
        return { anthropic: keep ? { hasKey: true, backend: "os", hint: "sk-ant-…x7X7" } : { hasKey: false, backend: null, hint: null } };
      return undefined;
    });
  }

  it("clears the typed key from the field as soon as it is submitted; a rejected key is reported as not saved", async () => {
    const calls = rigKey(
      { ok: false, error: { kind: "auth", retryable: false, httpStatus: 401, message: "rejected" } },
      false,
    );
    render(<ApiKeyField />);
    const input = screen.getByLabelText<HTMLInputElement>("Anthropic API key");
    await userEvent.type(input, `${KEY}{Enter}`);
    expect(input.value).toBe("");
    expect(await screen.findByText(/rejected that key.*The key was not saved\./)).toBeInTheDocument();
    expect(input.value).toBe("");
    expect(calls[0]).toEqual(["secrets:setApiKey", { providerId: "anthropic", apiKey: KEY, verify: true }]);
    expect(JSON.stringify(useSettings.getState())).not.toContain("TYPED-not-real");
    expect(document.body.innerHTML).not.toContain("TYPED-not-real");
  });

  it("a network failure keeps the key and says it could not be checked", async () => {
    rigKey({ ok: false, error: { kind: "network", retryable: true, message: "Connection lost." } }, true);
    render(<ApiKeyField />);
    const input = screen.getByLabelText<HTMLInputElement>("Anthropic API key");
    await userEvent.type(input, `${KEY}{Enter}`);
    expect(await screen.findByText(/saved, but it could not be checked/)).toBeInTheDocument();
    expect(input.value).toBe("");
    await waitFor(() => {
      expect(useSettings.getState().secrets["anthropic"]?.hasKey).toBe(true);
    });
  });
});

describe("Settings ▸ AI provider", () => {
  it("offers 'Remove saved key' when the saved key is unreadable", async () => {
    let status: Status = { anthropic: { hasKey: false, backend: "os", hint: null, unreadable: true } };
    const calls = stubBridge((channel) => {
      if (channel === "secrets:clearApiKey") {
        status = { anthropic: { hasKey: false, backend: null, hint: null } };
        return undefined;
      }
      if (channel === "secrets:status") return status;
      return undefined;
    });
    useApp.setState({ settingsOpen: "ai" });
    useSettings.setState({
      settings: {
        defaultSelection: { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "medium" },
        smartEffort: true,
      } as unknown as AppSettings,
      providers: [
        {
          id: "anthropic",
          displayName: "Anthropic (Claude)",
          nature: "Cloud · your API key",
          needsKey: true,
          available: true,
          enabled: true,
        } as unknown as ProviderInfo & { enabled: boolean },
      ],
      models: [],
      secrets: status,
    });
    render(<SettingsModal />);
    expect(screen.getByText(UNREADABLE_KEY_TEXT)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove saved key" }));
    expect(calls).toContainEqual(["secrets:clearApiKey", { providerId: "anthropic" }]);
    await waitFor(() => {
      expect(screen.queryByText(UNREADABLE_KEY_TEXT)).toBeNull();
    });
    expect(screen.queryByRole("button", { name: "Remove saved key" })).toBeNull();
  });
});
