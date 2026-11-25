/**
 * The revision limit (AppSettings.agent.maxRevisionsPerTurn): once the model has committed its allowance of plan
 * versions in one turn and wants another step, the engine stops between steps with stopReason "revision_limit"
 * (every version and tool result kept, no step run or billed after it); "Keep going" (continue) grants another
 * allowance. The provider requests that follow a stop are checked for a valid shape (tool results, then the user's
 * continue text).
 */
import { afterEach, describe, expect, it } from "vitest";
import { CONTINUE_TEXT } from "@slabyrinth/core/agent";
import type { AppSettings } from "../../shared/project";
import { SlabyrinthConversationEngine } from "./engine";
import { BetaFlags } from "./provider/anthropic/betas";
import { modelSpec } from "./provider/anthropic/models";
import { buildRequest } from "./provider/anthropic/render";
import { DefaultProviderRegistry } from "./provider/registry";
import type { ChatItem, StepRequest } from "./provider/types";
import { requestShapeViolations } from "./testing/invariants";
import { MemoryHost, defaultSettings, newProject } from "./testing/memoryHost";
import { ScriptedProvider, call, say, type ScriptedStep } from "./testing/scriptedProvider";

const AUTHORED = {
  title: "Abbey Crypt",
  kind: "dungeon",
  theme: "stone_dungeon",
  levels: [
    {
      id: "l1",
      name: "Upper Crypt",
      elevation: 0,
      bounds: { x: 0, y: 0, w: 16, h: 10 },
      base: { type: "solid" },
      areas: [
        { id: "entry", kind: "room", name: "Entry", shape: { type: "rect", x: 1, y: 1, w: 6, h: 5 } },
        { id: "hall", kind: "room", name: "Hall", shape: { type: "rect", x: 7, y: 1, w: 6, h: 5 } },
      ],
      openings: [{ id: "d1", kind: "door", between: ["entry", "hall"] }],
      features: [],
    },
  ],
  links: [],
};

const create = (): ScriptedStep => ({
  kind: "reply",
  parts: [call("create_plan", { replace: false, summary: "First draft", plan: AUTHORED })],
});
const edit = (base: number): ScriptedStep => ({
  kind: "reply",
  parts: [
    call("edit_plan", {
      baseVersion: base,
      summary: `Hall notes ${String(base)}`,
      changes: ["Notes"],
      ops: [{ op: "update", id: "hall", set: { notes: `Pass ${String(base)}.` } }],
    }),
  ],
});
const done = (): ScriptedStep => ({ kind: "reply", parts: [say("Done.")] });

const PROVIDERS: ScriptedProvider[] = [];
afterEach(() => {
  for (const p of PROVIDERS.splice(0))
    for (const req of p.requests) {
      const { params } = buildRequest(req, {
        spec: modelSpec(req.selection.modelId),
        flags: new BetaFlags([]),
        effortSupported: true,
        cacheTtl: "5m",
        bindingBehavior: "drop_block",
      });
      expect(requestShapeViolations(params.messages), `request of turn ${req.turnId}`).toEqual([]);
    }
});

/** settings: the host's live settings object (a test may change it between turns, as Settings does). */
function setup(steps: ScriptedStep[], settings: AppSettings = defaultSettings()) {
  const provider = new ScriptedProvider(steps);
  PROVIDERS.push(provider);
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

function withLimit(n: number): AppSettings {
  return { ...defaultSettings(), agent: { maxRevisionsPerTurn: n, view3d: true, maxPicturesPerTurn: 6 } };
}

const last = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];
const stops = (host: MemoryHost) => host.eventsOf("turn_finished").map((e) => e.stopReason);
const lastText = (req: StepRequest | undefined): string | undefined => {
  const u = req?.transcript.filter((i): i is Extract<ChatItem, { type: "user" }> => i.type === "user");
  return u ? last(u)?.text : undefined;
};

describe("revision limit", () => {
  it("stops between steps once the allowance is spent, keeping every version, with no step run after it", async () => {
    const { host, engine, provider } = setup([create(), edit(1), edit(2), done()], withLimit(2));
    await engine.send({ text: "a crypt, then polish it", intent: "plan" });
    await engine.whenIdle();
    expect(stops(host)).toEqual(["revision_limit"]);
    const end = last(host.eventsOf("turn_finished"));
    expect(end).toMatchObject({ canContinue: true, canRetry: true });
    expect(provider.requests).toHaveLength(2); // no third step asked for, so none billed
    expect(host.project?.history.head).toBe(2);
    // the turn's last item is the edit's tool result: nothing is lost or left unanswered
    expect(last(host.conv().items)?.type).toBe("tool_results");
    expect(host.eventsOf("usage")).toHaveLength(2);
    expect(host.busy).toBeNull();
  });

  it("Keep going grants another allowance and the conversation goes on from the tool results", async () => {
    const { host, engine, provider } = setup([create(), edit(1), edit(2), edit(3), done()], withLimit(2));
    await engine.send({ text: "a crypt, then polish it", intent: "plan" });
    await engine.whenIdle();
    await engine.continue({ allowance: 2 });
    await engine.whenIdle();
    expect(stops(host)).toEqual(["revision_limit", "revision_limit"]);
    expect(host.project?.history.head).toBe(4);
    // the continue turn's first request ends with the GM's continue text after the earlier tool results
    expect(lastText(provider.requests[2])).toBe(CONTINUE_TEXT);
    await engine.continue({ allowance: 2 });
    await engine.whenIdle();
    expect(last(stops(host))).toBe("end_turn");
    expect(provider.requests).toHaveLength(5);
  });

  it("spending stays right across a stop and Keep going: every step counted once", async () => {
    const { host, engine } = setup([create(), edit(1), edit(2), done()], withLimit(2));
    await engine.send({ text: "a crypt", intent: "plan" });
    await engine.whenIdle();
    await engine.continue({ allowance: 2 });
    await engine.whenIdle();
    const steps = host.eventsOf("usage");
    expect(steps).toHaveLength(4);
    const sum = steps.reduce((a, e) => a + (e.cost?.amount ?? 0), 0);
    expect(sum).toBeGreaterThan(0);
    expect(host.spend.cost?.amount).toBeCloseTo(sum, 6);
    expect(host.conv().totals.cost?.amount).toBeCloseTo(sum, 6);
    expect(host.conv().totals.turns).toBe(2);
    // each turn's message meta carries that turn's own spend (the last assistant item of a turn holds its total)
    const perTurn = new Map<string, number>();
    for (const it of host.conv().items)
      if (it.type === "assistant") perTurn.set(it.turnId, host.conv().meta[it.id]?.cost?.amount ?? 0);
    expect(perTurn.size).toBe(2);
    expect([...perTurn.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(sum, 6);
  });

  it("a turn that needs fewer changes than the limit ends as before, with no question", async () => {
    const { host, engine, provider } = setup([create(), edit(1), done()], withLimit(4));
    await engine.send({ text: "a crypt", intent: "plan" });
    await engine.whenIdle();
    expect(stops(host)).toEqual(["end_turn"]);
    expect(provider.requests).toHaveLength(3);
  });

  it("an older settings file (no agent group) uses the default of 4", async () => {
    const settings = defaultSettings();
    expect(settings.agent).toBeUndefined();
    const { host, engine, provider } = setup([create(), edit(1), edit(2), edit(3), edit(4)], settings);
    await engine.send({ text: "a crypt", intent: "plan" });
    await engine.whenIdle();
    expect(stops(host)).toEqual(["revision_limit"]);
    expect(provider.requests).toHaveLength(4);
    expect(host.project?.history.head).toBe(4);
  });

  it("a limit changed between messages applies from the next message; an allowance overrides it", async () => {
    const settings = withLimit(1);
    const { host, engine, provider } = setup(
      [create(), edit(1), edit(2), edit(3), edit(4), done()],
      settings,
    );
    await engine.send({ text: "a crypt", intent: "plan" });
    await engine.whenIdle();
    expect(provider.requests).toHaveLength(1);
    settings.agent = { maxRevisionsPerTurn: 3, view3d: true, maxPicturesPerTurn: 6 };
    await engine.continue();
    await engine.whenIdle();
    expect(provider.requests).toHaveLength(4);
    expect(host.project?.history.head).toBe(4);
    await engine.continue({ allowance: 1 });
    await engine.whenIdle();
    expect(stops(host)).toEqual(["revision_limit", "revision_limit", "revision_limit"]);
    expect(host.project?.history.head).toBe(5);
  });

  it("a rejected edit is not a change: only committed versions count", async () => {
    const bad: ScriptedStep = {
      kind: "reply",
      parts: [
        call("edit_plan", {
          baseVersion: 99,
          summary: "Stale",
          changes: ["x"],
          ops: [{ op: "update", id: "hall", set: { notes: "x" } }],
        }),
      ],
    };
    const { host, engine, provider } = setup([create(), bad, edit(1), done()], withLimit(2));
    await engine.send({ text: "a crypt", intent: "plan" });
    await engine.whenIdle();
    expect(stops(host)).toEqual(["revision_limit"]);
    expect(provider.requests).toHaveLength(3);
    expect(host.project?.history.head).toBe(2);
  });
});
