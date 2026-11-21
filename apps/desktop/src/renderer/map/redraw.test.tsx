/** Streaming chat tokens must not redraw the map (each token would repaint the whole canvas). */
import { beforeAll, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { MapPlan } from "@slabyrinth/core";
import exampleA from "../../../../../packages/core/test/fixtures/plans/example-a.json?raw";
import { setBridge } from "../bridge/client";
import { createFakeBridge } from "../bridge/fake/fakeBridge";
import { MapContent } from "../features/stage/Stage";
import { mapDrawStats } from "./MapView";
import { useChat } from "../stores/chat";
import { useMap } from "../stores/map";

beforeAll(() => {
  // the map resolves against the build's palettes, which come from main ("palettes:resolveData")
  setBridge(createFakeBridge({ speed: 0 }));
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  // jsdom has no ResizeObserver
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

describe("map redraws", () => {
  it("a burst of text deltas causes zero map draws", async () => {
    const plan = JSON.parse(exampleA) as MapPlan;
    useMap.getState().setLevel("l1");
    render(<MapContent plan={plan} version={1} />);
    await screen.findByRole("application", {}, { timeout: 5000 });
    const sel = { providerId: "anthropic", modelId: "m", effort: null };
    act(() => {
      useChat.getState().dispatch({ type: "turn_started", turnId: "t", selection: sel });
    });
    const before = mapDrawStats.runs;
    act(() => {
      for (let i = 0; i < 50; i++)
        useChat.getState().dispatch({ type: "text_delta", turnId: "t", step: 0, text: "word " });
      useChat.getState().dispatch({ type: "tool_call_progress", turnId: "t", callId: "c", bytes: 10 });
    });
    expect(mapDrawStats.runs).toBe(before);
    // but a real change (selection) does redraw
    act(() => {
      useMap.getState().select({ areaIds: ["hall"], featureIds: [], openingIds: [], linkIds: [] });
    });
    expect(mapDrawStats.runs).toBeGreaterThan(before);
  });
});
