/**
 * view_map_image end to end with the scripted provider (no network): engine → host.requestImage → ImageBridge →
 * "render:requestImage" → the renderer's responder (shared/imageRequests) → "render:imageResult" → the tool
 * result the model receives.
 *
 * Root cause of the in-app failure (fixed 2026-11-19): nothing in the renderer subscribed to render:requestImage,
 * so every call waited out the bridge timeout ("The map image wasn't rendered in time.") and the model got
 * "view_map_image failed inside the app". The first test pins that failure mode; the second the fixed round trip.
 */
import { describe, expect, it } from "vitest";
import { buildDisplayList, levelLabels } from "@slabyrinth/core/render";
import { resolvePlan } from "@slabyrinth/core/resolve";
import type { DisplayList } from "@slabyrinth/core/contracts/resolved";
import { answerImageRequest, MODEL_VIEW } from "../../shared/imageRequests";
import type { IpcEvents } from "../../shared/ipc";
import type { ImageRequest } from "../ports/engine";
import { ImageBridge } from "../services/imageBridge";
import type { EmitEvent } from "../services/events";
import { SlabyrinthConversationEngine } from "./engine";
import { DefaultProviderRegistry } from "./provider/registry";
import type { ChatItem } from "./provider/types";
import { MemoryHost, newProject } from "./testing/memoryHost";
import { ScriptedProvider, call, say } from "./testing/scriptedProvider";

const PLAN = {
  title: "Image test",
  kind: "dungeon",
  theme: "stone_dungeon",
  levels: [
    {
      id: "l1",
      name: "Hall",
      elevation: 0,
      bounds: { x: 0, y: 0, w: 12, h: 8 },
      base: { type: "solid" },
      areas: [{ id: "hall", kind: "room", name: "Hall", shape: { type: "rect", x: 1, y: 1, w: 8, h: 5 } }],
      features: [{ id: "altar", type: "altar", at: [4, 2] }],
    },
  ],
  links: [],
};

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** MemoryHost whose requestImage goes through the real ImageBridge, as main/app.ts wires it. */
class BridgedHost extends MemoryHost {
  bridge!: ImageBridge;
  override requestImage(req: ImageRequest, signal?: AbortSignal): Promise<string> {
    return this.bridge.request(req, signal);
  }
}

function setup(renderer: "absent" | "present") {
  const provider = new ScriptedProvider([
    { kind: "reply", parts: [call("create_plan", { replace: false, summary: "Draft", plan: PLAN }, "c1")] },
    { kind: "reply", parts: [call("view_map_image", { level: "l1" }, "c2")] },
    { kind: "reply", parts: [say("The hall reads well.")] },
  ]);
  const host = new BridgedHost(newProject());
  const rendered: Array<{ level: string; px: number; items: number }> = [];
  const emit = ((channel, payload) => {
    if (channel !== "render:requestImage" || renderer === "absent") return;
    const req = payload as IpcEvents["render:requestImage"];
    void answerImageRequest(req, {
      getPlan: (version) => {
        const p = host.getPlan(version);
        return p ? Promise.resolve(p) : Promise.reject(new Error(`no plan v${version}`));
      },
      resolve: (plan) => {
        // the renderer resolves against the build's palettes, as the engine does
        const r = resolvePlan(plan, host.getBuildPalettes());
        const labels = levelLabels(r, plan.entryLevel);
        const lists: Record<string, DisplayList> = {};
        for (const l of r.levels)
          lists[l.id] = buildDisplayList(l, MODEL_VIEW, { links: r.links, levelLabels: labels });
        return Promise.resolve({ lists });
      },
      render: (list, px) => {
        rendered.push({ level: list.levelId, px, items: list.items.length });
        return Promise.resolve(PNG);
      },
      send: (result) => {
        host.bridge.handleResult(result);
      },
    });
  }) as EmitEvent;
  host.bridge = new ImageBridge(emit, 50);
  let n = 0;
  const engine = new SlabyrinthConversationEngine(host, {
    registry: new DefaultProviderRegistry([provider]),
    newId: () => `id${++n}`,
    sleep: () => Promise.resolve(),
    random32: () => 42,
  });
  return { provider, host, engine, rendered };
}

function imageResult(items: readonly ChatItem[]) {
  for (const it of items)
    if (it.type === "tool_results") for (const r of it.results) if (r.name === "view_map_image") return r;
  return undefined;
}

describe("view_map_image (scripted provider)", () => {
  it("without a renderer responder the bridge times out and the tool fails (the bug)", async () => {
    const { host, engine } = setup("absent");
    await engine.send({ text: "draw and look", intent: "plan" });
    await engine.whenIdle();
    const r = imageResult(host.conv().items);
    expect(r?.isError).toBe(true);
    expect(JSON.stringify(r?.content)).toContain("failed inside the app");
  });

  it("the renderer responder draws the requested level and the model receives the PNG", async () => {
    const { host, engine, provider, rendered } = setup("present");
    await engine.send({ text: "draw and look", intent: "plan" });
    await engine.whenIdle();
    const r = imageResult(host.conv().items);
    expect(r?.isError ?? false).toBe(false);
    const img = r?.content.find((c) => c.type === "image");
    expect(img).toMatchObject({ type: "image", mediaType: "image/png", dataBase64: PNG });
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.level).toBe("l1");
    expect(rendered[0]?.px).toBeGreaterThanOrEqual(8);
    expect(rendered[0]?.items).toBeGreaterThan(0);
    // the follow-up model request carries the image in the tool result
    const last = provider.requests[provider.requests.length - 1];
    expect(JSON.stringify(last?.transcript ?? last)).toContain(PNG);
    expect(host.bridge.pendingCount).toBe(0);
  });
});
