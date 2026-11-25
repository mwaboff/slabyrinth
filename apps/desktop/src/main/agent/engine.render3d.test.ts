/**
 * The model's 3D pictures on the tool context (ToolContext.render3d): supplied from the host's scene worker when 3D is
 * on, the model takes images and the budget is above 0; each call is one picture, and past
 * AppSettings.agent.maxPicturesPerTurn for one message it refuses in plain words. A new message has a new budget.
 * No model-facing text: the tool that calls it waits on a new generator, so the test calls it from an executor.
 */
import { describe, expect, it } from "vitest";
import type {
  AgentExecuteTool,
  AgentToolContext,
  Render3dRequest,
  Render3dResult,
} from "@slabyrinth/core/agent";
import type { AppSettings } from "../../shared/project";
import { SlabyrinthConversationEngine } from "./engine";
import { DefaultProviderRegistry } from "./provider/registry";
import { MemoryHost, defaultSettings, newProject } from "./testing/memoryHost";
import { ScriptedProvider, call, say } from "./testing/scriptedProvider";

class PictureHost extends MemoryHost {
  asked: Render3dRequest[] = [];
  render3d(req: Render3dRequest): Promise<Render3dResult> {
    this.asked.push(req);
    return Promise.resolve({
      png: new Uint8Array([137, 80, 78, 71]),
      captions: ["1. The whole map"],
      suggestions: "",
    });
  }
}

function setup(settings: AppSettings, opts: { host3d?: boolean; images?: boolean } = {}) {
  // each view_plan call asks for `n` pictures (input.n), recording what render3d answered
  const outcomes: string[] = [];
  const contexts: AgentToolContext[] = [];
  const executor: AgentExecuteTool = async (ctx, _name, input) => {
    contexts.push(ctx);
    const n = (input as { n?: number }).n ?? 1;
    for (let i = 0; i < n; i++) {
      try {
        const r = await (ctx.render3d ?? (() => Promise.reject(new Error("none"))))({ shots: ["overview"] });
        outcomes.push(`ok ${String(r.png.length)}`);
      } catch (e) {
        outcomes.push(e instanceof Error ? e.message : String(e));
      }
    }
    return { ok: true, content: [{ type: "text", text: "looked" }] };
  };
  const provider = new ScriptedProvider([
    { kind: "reply", parts: [call("view_plan", { n: 2 }, "c1")] },
    { kind: "reply", parts: [call("view_plan", { n: 2 }, "c2")] },
    { kind: "reply", parts: [say("Done.")] },
    { kind: "reply", parts: [call("view_plan", { n: 1 }, "c3")] },
    { kind: "reply", parts: [say("Done again.")] },
  ]);
  const pictures = new PictureHost(newProject(), { settings });
  const host = opts.host3d === false ? new MemoryHost(newProject(), { settings }) : pictures;
  if (opts.images === false) {
    const conv = host.conv();
    conv.imageToolEnabled = false;
  }
  let id = 0;
  const engine = new SlabyrinthConversationEngine(host, {
    registry: new DefaultProviderRegistry([provider]),
    executor,
    newId: () => `id${String(++id)}`,
    sleep: () => Promise.resolve(),
    random32: () => 42,
  });
  return { pictures, engine, outcomes, contexts };
}

const withPictures = (n: number, view3d = true): AppSettings => ({
  ...defaultSettings(),
  agent: { maxRevisionsPerTurn: 4, view3d, maxPicturesPerTurn: n },
});

describe("render3d on the tool context", () => {
  it("counts pictures per message and refuses past the budget; the next message starts again", async () => {
    const { pictures, engine, outcomes } = setup(withPictures(3));
    await engine.send({ text: "look at it", intent: "plan" });
    await engine.whenIdle();
    expect(outcomes).toEqual([
      "ok 4",
      "ok 4",
      "ok 4",
      "no more 3D pictures for this message (the GM allows 3 per message)",
    ]);
    expect(pictures.asked).toHaveLength(3);
    await engine.send({ text: "and again", intent: "plan" });
    await engine.whenIdle();
    expect(outcomes.at(-1)).toBe("ok 4");
  });

  it("is null with 3D off, a budget of 0, no image input, or no scene worker", async () => {
    for (const [settings, opts] of [
      [withPictures(6, false), {}],
      [withPictures(0), {}],
      [withPictures(6), { images: false }],
      [withPictures(6), { host3d: false }],
    ] as const) {
      const { engine, contexts } = setup(settings, opts);
      await engine.send({ text: "look", intent: "plan" });
      await engine.whenIdle();
      expect(contexts[0]?.render3d ?? null).toBeNull();
    }
  });
});
