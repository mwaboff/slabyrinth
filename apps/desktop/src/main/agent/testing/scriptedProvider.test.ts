import { describe, expect, it } from "vitest";
import type { StepRequest } from "../provider/types";
import { ScriptedProvider, say } from "./scriptedProvider";

const request = {
  turnId: "t1",
  selection: { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "medium" },
} as unknown as StepRequest;

describe("ScriptedProvider delayMs (e2e specs observe the app mid-turn)", () => {
  it("waits before answering", async () => {
    const p = new ScriptedProvider([{ kind: "reply", delayMs: 120, parts: [say("late")] }]);
    const t0 = Date.now();
    const r = await p.runStep(request, () => undefined, new AbortController().signal);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(r.assistant?.parts).toEqual([say("late")]);
  });

  it("is cancelled by Stop", async () => {
    const p = new ScriptedProvider([{ kind: "reply", delayMs: 60_000, parts: [say("never")] }]);
    const ac = new AbortController();
    const run = p.runStep(request, () => undefined, ac.signal);
    ac.abort();
    await expect(run).rejects.toMatchObject({ info: { kind: "cancelled" } });
  });
});
