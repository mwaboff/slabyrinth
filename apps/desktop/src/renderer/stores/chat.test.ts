/** chatStore guards: one turn at a time from the renderer, quiet "busy", per-project reset, retry refusal. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Result, SlabyrinthApi } from "../../shared/ipc";
import type { ChatItem } from "../../main/agent/provider/types";
import { setBridge } from "../bridge/client";
import { useChat } from "./chat";

const sel = { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "medium" as const };
let invoke: ReturnType<typeof vi.fn>;
let next: Result<unknown>;
/** What project:snapshot answers (the conversation main holds after a Retry cut it). */
let snapItems: Array<{ id: string }> = [];

beforeEach(() => {
  next = { ok: true, value: { turnId: "t1" } };
  snapItems = [];
  invoke = vi.fn(
    (channel: string) =>
      new Promise<Result<unknown>>((r) =>
        setTimeout(() => {
          r(
            channel === "project:snapshot"
              ? { ok: true, value: { conversation: { items: snapItems } } }
              : next,
          );
        }, 5),
      ),
  );
  setBridge({ invoke, on: () => () => undefined, send: () => undefined } as unknown as SlabyrinthApi);
  useChat.getState().hydrate([], {}, sel, null);
});

const sends = (): number => invoke.mock.calls.filter((c) => c[0] === "chat:send").length;

describe("chat store", () => {
  it("a double click (or Enter key-repeat) sends one message only", async () => {
    useChat.getState().setDraft("Draw the crypt");
    const a = useChat.getState().send();
    const b = useChat.getState().send();
    expect(await b).toBe(false);
    expect(await a).toBe(true);
    expect(sends()).toBe(1);
    // still guarded until turn_started arrives…
    useChat.getState().setDraft("again");
    expect(await useChat.getState().send()).toBe(false);
    useChat.getState().dispatch({ type: "turn_started", turnId: "t1", selection: sel });
    expect(useChat.getState().inFlight).toBe(false);
  });

  it("treats a busy refusal quietly and keeps the draft", async () => {
    next = { ok: false, error: { code: "busy", message: "A reply is still being written." } };
    useChat.getState().setDraft("Make it bigger");
    await expect(useChat.getState().send()).resolves.toBe(false);
    expect(useChat.getState().draft).toBe("Make it bigger");
    expect(useChat.getState().inFlight).toBe(false);
  });

  it("clears the guard and rethrows other failures", async () => {
    next = { ok: false, error: { code: "no_api_key", message: "Add your Anthropic API key to start." } };
    useChat.getState().setDraft("hello");
    await expect(useChat.getState().send()).rejects.toThrow("Add your Anthropic API key");
    expect(useChat.getState().inFlight).toBe(false);
  });

  it("does not carry chips, draft or estimate into another project", () => {
    useChat.getState().addRef({ type: "room", id: "hall", levelId: "l1", label: "Hall", key: "2" });
    useChat.getState().setDraft("about the hall");
    useChat.getState().setEstimate({ costUsd: 0.05, seconds: 30 });
    useChat.getState().hydrate([], {}, sel, null);
    expect(useChat.getState()).toMatchObject({ refs: [], draft: "", estimate: null });
  });

  it("shows a refused Retry's reason and never sends twice", async () => {
    next = {
      ok: false,
      error: { code: "validation", message: "You changed the map after this reply, so it can't be retried." },
    };
    await useChat.getState().retry();
    expect(useChat.getState().retryError).toBe(
      "You changed the map after this reply, so it can't be retried.",
    );
    next = { ok: true, value: { turnId: "t2" } };
    const a = useChat.getState().retry();
    const b = useChat.getState().retry();
    await Promise.all([a, b]);
    expect(invoke.mock.calls.filter((c) => c[0] === "chat:retry")).toHaveLength(2); // 1 refused + 1 sent
    expect(useChat.getState().retryError).toBeNull();
  });

  it("drops the retried turn's replies that main cut, keeping the user message", async () => {
    const user: ChatItem = { type: "user", id: "u1", text: "Draw the crypt", createdAt: "t" };
    const old: ChatItem = {
      type: "assistant",
      id: "a1",
      turnId: "t0",
      parts: [{ type: "text", text: "First take." }],
      stopReason: "end_turn",
      servedBy: { providerId: "anthropic", modelId: sel.modelId },
      createdAt: "t",
    };
    useChat.getState().hydrate([user, old], {}, sel, null);
    snapItems = [user];
    next = { ok: true, value: { turnId: "t2" } };
    await useChat.getState().retry();
    expect(useChat.getState().items.map((i) => i.id)).toEqual(["u1"]);
  });
});
