/**
 * The map size setting reaches the model's tools and its context: a plan wider than the standard 320 cells is refused
 * at the standard size and accepted at "large-512", and the model is told the active limits once.
 */
import { describe, expect, it } from "vitest";
import type { SizeTierId } from "@slabyrinth/core/plan";
import { SlabyrinthConversationEngine } from "./engine";
import { DefaultProviderRegistry } from "./provider/registry";
import type { ChatItem } from "./provider/types";
import { MemoryHost, defaultSettings, newProject } from "./testing/memoryHost";
import { ScriptedProvider, call, say } from "./testing/scriptedProvider";
import { SIZE_TIER_PREFIX, sizeTierText } from "./sizeTierText";
import { checkSecondsPerStep } from "../../shared/sizeTier";

/** A thin level wider than the standard size allows (cheap to resolve: 400 × 12 cells). */
const WIDE = {
  title: "Long Road",
  kind: "outdoor",
  theme: "stone_dungeon",
  levels: [
    {
      id: "l1",
      name: "Road",
      elevation: 0,
      bounds: { x: 0, y: 0, w: 400, h: 12 },
      base: { type: "solid" },
      areas: [{ id: "a", kind: "room", name: "Hall", shape: { type: "rect", x: 1, y: 1, w: 8, h: 6 } }],
      openings: [],
      features: [],
    },
  ],
  links: [],
};

function setup(mapSize: SizeTierId | undefined) {
  const provider = new ScriptedProvider([
    { kind: "reply", parts: [call("create_plan", { replace: false, summary: "Draft", plan: WIDE }, "c1")] },
    { kind: "reply", parts: [say("Done.")] },
  ]);
  const settings = { ...defaultSettings(), ...(mapSize !== undefined ? { mapSize } : {}) };
  const host = new MemoryHost(newProject(), { settings });
  let n = 0;
  const engine = new SlabyrinthConversationEngine(host, {
    registry: new DefaultProviderRegistry([provider]),
    newId: () => `id${String(++n)}`,
    sleep: () => Promise.resolve(),
    random32: () => 42,
  });
  return { provider, host, engine };
}

const contextText = (items: readonly ChatItem[]): string =>
  items.flatMap((i) => (i.type === "context" ? [i.text] : [])).join("\n");

describe("map size setting in the conversation", () => {
  it("standard: the wide plan is refused, and the model is told nothing extra", async () => {
    const { host, engine } = setup(undefined);
    await engine.send({ text: "draw", intent: "plan" });
    await engine.whenIdle();
    expect(host.project?.history.head).toBe(0);
    expect(contextText(host.conv().items)).not.toContain(SIZE_TIER_PREFIX);
  });

  it("large-512: the wide plan is accepted, and the session start names the limits", async () => {
    const { host, engine, provider } = setup("large-512");
    await engine.send({ text: "draw", intent: "plan" });
    await engine.whenIdle();
    expect(host.project?.history.head).toBe(1);
    expect(host.getPlan()?.levels[0]?.bounds.w).toBe(400);
    const sent = JSON.stringify(provider.requests[0]?.transcript);
    expect(sent).toContain("at most 512 cells a side and 1,048,576 cells over all levels together");
    expect(sizeTierText("standard")).toBe(
      "Map size setting: standard, at most 320 cells a side and 204,800 cells over all levels together.",
    );
  });
});

describe("the time estimate at the experimental sizes", () => {
  it("adds main's plan check and review per step, from the measured table", async () => {
    const seconds = async (size: SizeTierId | undefined): Promise<number> => {
      const { engine, host } = setup(size);
      const selection = { ...host.conv().selection, effort: "low" as const };
      return (await engine.estimate({ text: "widen the road", intent: "plan", selection })).seconds ?? 0;
    };
    const standard = await seconds(undefined);
    const big = await seconds("large-1024");
    // three steps of a plan turn, each about 16 s of checks and 8 s of review at 1024
    expect(big).toBeGreaterThan(standard);
    expect(checkSecondsPerStep("large-1024")).toBe(24);
    expect(checkSecondsPerStep("standard")).toBe(0);
  });
});
