import { afterEach, describe, expect, it, vi } from "vitest";
import { SlabyrinthConversationEngine } from "./engine";
import { staticDescriptors } from "./provider/anthropic/models";
import { DefaultProviderRegistry } from "./provider/registry";
import type { ModelDescriptor } from "./provider/types";
import { MemoryHost, newProject, type MemoryHostOptions } from "./testing/memoryHost";
import { ScriptedProvider, call, say, type ScriptedStep } from "./testing/scriptedProvider";
import { DEADLINES } from "../util/deadline";

/** A provider whose model list never answers until its signal ends (a stalled connection), then falls back. */
function stalledModels(steps: ScriptedStep[]): ScriptedProvider {
  return Object.assign(new ScriptedProvider(steps), {
    listModels: (signal: AbortSignal): Promise<ModelDescriptor[]> =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          resolve(staticDescriptors());
        });
      }),
  });
}

function setup(provider: ScriptedProvider, opts: MemoryHostOptions = {}) {
  const host = new MemoryHost(newProject(), opts);
  let n = 0;
  const engine = new SlabyrinthConversationEngine(host, {
    registry: new DefaultProviderRegistry([provider]),
    newId: () => `id${++n}`,
    sleep: () => Promise.resolve(),
    random32: () => 42,
  });
  return { host, engine };
}

const PLAN = {
  title: "Crypt",
  kind: "dungeon",
  theme: "stone_dungeon",
  seed: 7,
  levels: [
    {
      id: "l1",
      name: "Crypt",
      elevation: 0,
      bounds: { x: 0, y: 0, w: 12, h: 8 },
      base: { type: "solid" },
      areas: [{ id: "hall", kind: "room", name: "Hall", shape: { type: "rect", x: 1, y: 1, w: 6, h: 5 } }],
    },
  ],
  links: [],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("a turn never hangs on the outside world", () => {
  it("the first send of a session does not wait past the deadline for a stalled model list", async () => {
    vi.useFakeTimers();
    const steps: ScriptedStep[] = [{ kind: "reply", parts: [say("Hello.")] }];
    const { host, engine } = setup(stalledModels(steps));
    const sent = engine.send({ text: "hi" });
    await vi.advanceTimersByTimeAsync(DEADLINES.modelListForTurnMs);
    await expect(sent).resolves.toMatchObject({ turnId: expect.any(String) as unknown });
    vi.useRealTimers();
    await engine.whenIdle();
    expect(host.eventsOf("turn_finished")).toHaveLength(1);
  });

  it("Stop ends a turn whose compile_preview never returns", async () => {
    let asked: () => void = () => undefined;
    const estimating = new Promise<void>((r) => (asked = r));
    const steps: ScriptedStep[] = [
      { kind: "reply", parts: [call("create_plan", { replace: false, summary: "Draft", plan: PLAN }, "c1")] },
      { kind: "reply", parts: [call("compile_preview", {}, "p1")] },
      { kind: "reply", parts: [say("Done.")] },
    ];
    const { host, engine } = setup(new ScriptedProvider(steps), {
      // a compile that loops: answers only when its signal ends
      estimate: (_plan, _levels, signal) =>
        new Promise((_resolve, reject) => {
          asked();
          signal.addEventListener("abort", () => {
            reject(new Error("stopped"));
          });
        }),
    });
    const { turnId } = await engine.send({ text: "draw" });
    await estimating;
    await engine.cancel(turnId);
    expect(host.eventsOf("turn_finished").at(-1)).toMatchObject({ stopReason: "cancelled" });
    expect(host.busy).toBeNull();
  });
});
