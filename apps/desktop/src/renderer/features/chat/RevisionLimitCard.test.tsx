/** The revision-limit card: plain words, the spend so far, Keep going with the allowance, That's enough. */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatEvent, SlabyrinthApi } from "../../../shared/ipc";
import type { AppSettings } from "../../../shared/project";
import { setBridge } from "../../bridge/client";
import { useChat } from "../../stores/chat";
import { chatReducer, emptyChat, type TurnState } from "../../stores/chatReducer";
import { useSettings } from "../../stores/settings";
import { RevisionLimitCard, timesWord } from "./RevisionLimitCard";

const sel = { providerId: "anthropic", modelId: "m", effort: null };
const usd = (amount: number) => ({ currency: "USD" as const, amount, estimated: true });
const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A turn that made `versions` and stopped at the limit, its steps costing `costs`. */
function limitTurn(turnId: string, versions: number[], costs: number[]): TurnState {
  const events: ChatEvent[] = [{ type: "turn_started", turnId, selection: sel }];
  for (const v of versions)
    events.push({
      type: "tool_call_finished",
      turnId,
      callId: `c${String(v)}`,
      name: "edit_plan",
      ok: true,
      summary: "x",
      newVersion: v,
    });
  for (const c of costs)
    events.push({
      type: "usage",
      turnId,
      usage: zero,
      cost: usd(c),
      totals: { usage: zero, cost: null },
    });
  events.push({
    type: "turn_finished",
    turnId,
    stopReason: "revision_limit",
    canContinue: true,
    canRetry: true,
  });
  let st = emptyChat();
  for (const e of events) st = chatReducer(st, e);
  if (!st.last) throw new Error("no finished turn");
  return st.last;
}

function bridgeRecording(calls: Array<[string, unknown]>): void {
  setBridge({
    invoke: (channel: string, req: unknown) => {
      calls.push([channel, req]);
      return Promise.resolve({ ok: true, value: channel === "chat:continue" ? { turnId: "t2" } : undefined });
    },
    on: () => () => undefined,
    send: () => undefined,
  } as unknown as SlabyrinthApi);
}

function withLimit(n: number): void {
  useSettings.setState({
    settings: { agent: { maxRevisionsPerTurn: n, view3d: true, maxPicturesPerTurn: 6 } } as AppSettings,
  });
}

afterEach(() => {
  cleanup();
  useChat.setState({ live: null, last: null, carried: null, inFlight: false });
  useSettings.setState({ settings: null });
});

describe("RevisionLimitCard", () => {
  it("says what happened in plain words, with what this message has cost (every step added up)", () => {
    withLimit(4);
    const turn = limitTurn("t1", [2, 3, 4, 5], [0.1, 0.12, 0.2]);
    render(<RevisionLimitCard turn={turn} />);
    expect(
      screen.getByText("Claude has changed the map 4 times for this message and wants to keep going."),
    ).toBeInTheDocument();
    expect(screen.getByText(/This message has cost about \$0\.42 so far\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep going (up to 4 more changes)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "That's enough" })).toBeInTheDocument();
    expect(timesWord(1)).toBe("once");
    expect(timesWord(2)).toBe("twice");
  });

  it("Keep going asks for another allowance of the setting's size, by keyboard", async () => {
    withLimit(3);
    const calls: Array<[string, unknown]> = [];
    bridgeRecording(calls);
    const turn = limitTurn("t1", [1, 2, 3], [0.2]);
    useChat.setState({ last: turn });
    render(<RevisionLimitCard turn={turn} />);
    const keep = screen.getByRole("button", { name: "Keep going (up to 3 more changes)" });
    await userEvent.tab();
    expect(keep).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(calls).toContainEqual(["chat:continue", { allowance: 3 }]);
    expect(useChat.getState().carried).toEqual({ changes: 3, cost: usd(0.2) });
  });

  it("counts from the GM's message across Keep going, and a new message starts the count again", async () => {
    withLimit(2);
    const calls: Array<[string, unknown]> = [];
    bridgeRecording(calls);
    useChat.setState({ carried: { changes: 2, cost: usd(0.3) } });
    const turn = limitTurn("t2", [3, 4], [0.1, 0.05]);
    render(<RevisionLimitCard turn={turn} />);
    expect(
      screen.getByText("Claude has changed the map 4 times for this message and wants to keep going."),
    ).toBeInTheDocument();
    expect(screen.getByText(/cost about \$0\.45 so far/)).toBeInTheDocument();
    useChat.setState({ draft: "Something else" });
    await act(async () => {
      await useChat.getState().send();
    });
    expect(useChat.getState().carried).toBeNull();
  });

  it("That's enough closes the card and hands over the composer", async () => {
    withLimit(4);
    const turn = limitTurn("t1", [1, 2, 3, 4], []);
    render(<RevisionLimitCard turn={turn} />);
    // no price known (a local model): the cost sentence is left out
    expect(screen.queryByText(/has cost/)).toBeNull();
    const tick = useChat.getState().focusTick;
    await userEvent.click(screen.getByRole("button", { name: "That's enough" }));
    expect(screen.queryByText(/wants to keep going/)).toBeNull();
    expect(useChat.getState().focusTick).toBe(tick + 1);
  });

  it("shows nothing for a turn that ended any other way", () => {
    withLimit(4);
    const turn = { ...limitTurn("t1", [1], []), stopReason: "end_turn" as const };
    const { container } = render(<RevisionLimitCard turn={turn} />);
    expect(container).toBeEmptyDOMElement();
  });
});
