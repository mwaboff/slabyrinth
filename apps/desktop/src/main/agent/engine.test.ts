import { afterEach, describe, expect, it } from "vitest";
import { BetaFlags } from "./provider/anthropic/betas";
import { buildRequest } from "./provider/anthropic/render";
import { requestShapeViolations } from "./testing/invariants";
import { applyOps } from "@slabyrinth/core/ops";
import { bundledPalettes } from "@slabyrinth/core/palette";
import { planRules } from "@slabyrinth/core/resolve";
import type { MapPlan } from "@slabyrinth/core/contracts/plan";
import { EnginePortError } from "../ports/engine";
import { SlabyrinthConversationEngine, capEffort, snapEffort } from "./engine";
import { DefaultProviderRegistry } from "./provider/registry";
import type { ChatItem, StepRequest } from "./provider/types";
import { modelSpec, staticDescriptors } from "./provider/anthropic/models";
import { MemoryHost, newProject } from "./testing/memoryHost";
import { ScriptedProvider, call, say, type ScriptedStep } from "./testing/scriptedProvider";

/** The rules of the palettes MemoryHost builds with (the bundled ones). */
const RULES = planRules(bundledPalettes());

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
        {
          id: "entry",
          kind: "room",
          name: "Entry",
          shape: { type: "rect", x: 1, y: 1, w: 6, h: 5 },
          notes: "Collapsed stair.",
        },
        { id: "hall", kind: "room", name: "Hall", shape: { type: "rect", x: 7, y: 1, w: 6, h: 5 } },
      ],
      openings: [{ id: "d1", kind: "door", between: ["entry", "hall"] }],
      features: [{ id: "altar", type: "altar", at: [9, 3] }],
    },
  ],
  links: [],
};

/** Every scripted provider of the suite; afterEach renders each request it got and checks the request shape. */
const ALL_PROVIDERS: ScriptedProvider[] = [];

afterEach(() => {
  for (const p of ALL_PROVIDERS.splice(0)) {
    for (const req of p.requests) {
      for (const perMessageEffort of [true, false]) {
        const { params } = buildRequest(req, {
          spec: modelSpec(req.selection.modelId),
          flags: new BetaFlags(perMessageEffort ? [] : ["perMessageEffort"]),
          effortSupported: true,
          cacheTtl: "5m",
          bindingBehavior: "drop_block",
        });
        expect(requestShapeViolations(params.messages), `request of turn ${req.turnId}`).toEqual([]);
      }
    }
  }
});

function setup(
  steps: ScriptedStep[] | ((req: StepRequest, i: number) => ScriptedStep),
  opts: { apiKey?: string | null } = {},
) {
  const provider = new ScriptedProvider(steps);
  ALL_PROVIDERS.push(provider);
  const host = new MemoryHost(newProject(), opts);
  let n = 0;
  const engine = new SlabyrinthConversationEngine(host, {
    registry: new DefaultProviderRegistry([provider]),
    newId: () => `id${++n}`,
    sleep: () => Promise.resolve(),
    random32: () => 42,
  });
  return { provider, host, engine };
}

const items = (host: MemoryHost): ChatItem[] => host.conv().items;
const finished = (host: MemoryHost) => host.eventsOf("turn_finished");

/** Every tool call sent to the model has exactly one result before the next model turn. */
function assertWellFormed(transcript: readonly ChatItem[]): void {
  const open = new Set<string>();
  for (const it of transcript) {
    if (it.type === "assistant" && it.excludedFromContext !== true) {
      expect([...open], "unanswered tool calls before an assistant turn").toEqual([]);
      for (const p of it.parts) if (p.type === "tool_call") open.add(p.callId);
    }
    if (it.type === "tool_results")
      for (const r of it.results) expect(open.delete(r.callId), `result for ${r.callId}`).toBe(true);
  }
}

describe("full scripted conversation: brief → questions → create_plan → two edit_plan rounds → compile_preview", () => {
  it("runs end to end against a fake provider", async () => {
    const opsA = [{ op: "update", id: "hall", set: { notes: "Pillars carved as drowned monks." } }];
    const opsB = [{ op: "move", ids: ["altar"], dx: 1, dy: 0 }];
    const { host, engine, provider } = setup([
      // Turn 1: brief + one question card.
      {
        kind: "reply",
        parts: [
          say("A crypt — one question."),
          call("update_brief", { set: { mapType: "Dungeon", system: "daggerheart" } }, "tb"),
          call(
            "ask_questions",
            { questions: [{ id: "q1", text: "Tier?", default: "Tier 2", options: ["Tier 1", "Tier 2"] }] },
            "tq",
          ),
        ],
      },
      // Turn 2: first draft, then a short reply.
      {
        kind: "reply",
        parts: [
          call(
            "create_plan",
            { replace: false, summary: "First draft", changes: ["Two rooms and an altar"], plan: AUTHORED },
            "tc",
          ),
        ],
      },
      { kind: "reply", parts: [say("Here's a first draft.")] },
      // Turn 3: first edit round.
      {
        kind: "reply",
        parts: [
          call(
            "edit_plan",
            { baseVersion: 1, summary: "Hall notes", changes: ["Wrote notes for the hall"], ops: opsA },
            "te1",
          ),
        ],
      },
      { kind: "reply", parts: [say("Added notes.")] },
      // Turn 4: second edit round, then compile_preview before saying it's ready.
      {
        kind: "reply",
        parts: [
          call(
            "edit_plan",
            { baseVersion: 2, summary: "Moved altar", changes: ["Moved the altar east"], ops: opsB },
            "te2",
          ),
        ],
      },
      { kind: "reply", parts: [call("compile_preview", {}, "tp")] },
      { kind: "reply", parts: [say("Ready to build: one slab.")] },
    ]);

    await engine.send({ text: "A crypt for my Daggerheart group", intent: "chat" });
    await engine.whenIdle();
    expect(host.eventsOf("questions")[0]).toMatchObject({ callId: "tq" });
    expect(host.conv().pendingQuestions).toEqual({ callId: "tq", itemId: "a0" });
    expect(host.project?.brief.mapType).toEqual({ value: "Dungeon", source: "ai" });
    expect(finished(host)[0]?.stopReason).toBe("tool_use");

    await engine.send({
      text: "",
      answers: { callId: "tq", answers: [{ id: "q1", answer: "Tier 2" }] },
      intent: "plan",
    });
    await engine.whenIdle();
    expect(host.project?.history.head).toBe(1);
    // The answers became ask_questions' tool_result, sent together with the update_brief result.
    const req2 = provider.requests[1];
    const answers = req2?.transcript.flatMap((i) => (i.type === "tool_results" ? i.results : []));
    expect(answers?.map((r) => r.callId)).toEqual(["tb", "tq"]);
    expect(host.eventsOf("progress").map((p) => p.step)).toContain("checking");

    await engine.send({ text: "Give the hall some notes", intent: "plan" });
    await engine.whenIdle();
    await engine.send({ text: "Move the altar one east, then check the build", intent: "plan" });
    await engine.whenIdle();

    const p = host.project;
    expect(p?.history.head).toBe(3);
    // Ops-caused versions carry exactly the ops that turn the head into the new plan (replay-checked).
    const v2 = p?.history.versions.find((v) => v.number === 2);
    expect(v2?.cause).toEqual({ type: "ops", ops: opsA });
    const replay = applyOps(host.getPlan(2) as MapPlan, opsB as never, RULES);
    expect(replay.ok && JSON.stringify(replay.plan)).toBe(JSON.stringify(host.getPlan(3)));
    expect(host.getPlan(3)?.levels[0]?.features[0]?.at).toEqual([10, 3]);

    // Requests are append-only: each transcript extends the previous one.
    for (let i = 1; i < provider.requests.length; i++) {
      const prev = provider.requests[i - 1]?.transcript ?? [];
      expect(provider.requests[i]?.transcript.slice(0, prev.length)).toEqual(prev);
      expect(provider.requests[i]?.systemPrompt).toBe(provider.requests[0]?.systemPrompt);
      expect(provider.requests[i]?.tools).toEqual(provider.requests[0]?.tools);
    }
    assertWellFormed(items(host));
    expect(items(host).filter((i) => i.type === "context" && i.reason === "session_start")).toHaveLength(1);
    expect(host.conv().totals.turns).toBe(4);
    expect(host.conv().totals.usage.outputTokens).toBe(500 * 8);
    expect(host.spend.cost?.amount).toBeCloseTo(host.conv().totals.cost?.amount ?? -1, 9);
    expect(host.conv().modelSeen.head).toBe(3);
    expect(host.busy).toBeNull();
    expect(host.flushes).toBe(4);
    const compile = items(host)
      .flatMap((i) => (i.type === "tool_results" ? i.results : []))
      .find((r) => r.callId === "tp");
    expect(compile?.content[0]?.type === "text" && compile.content[0].text).toContain("one slab");
    // Every assistant item has meta with the versions its turn produced.
    const metaVersions = Object.values(host.conv().meta).flatMap((m) => m.versions);
    expect(new Set(metaVersions)).toEqual(new Set([1, 2, 3]));
  });
});

describe("playability checks (decisions.md 'Playability validation')", () => {
  // The altar sits on cell 7,3, right inside door d1 between entry and hall.
  const BLOCKED = structuredClone(AUTHORED);
  const blockedFeature = BLOCKED.levels[0]?.features[0];
  if (blockedFeature) blockedFeature.at = [7, 3];

  const resultText = (host: MemoryHost, callId: string): string =>
    items(host)
      .flatMap((i) => (i.type === "tool_results" ? i.results : []))
      .find((r) => r.callId === callId)
      ?.content.map((c) => (c.type === "text" ? c.text : ""))
      .join("\n") ?? "";

  it("draft with a blocked door → the result reports it → the model fixes it → final state clean", async () => {
    const { host, engine, provider } = setup([
      {
        kind: "reply",
        parts: [call("create_plan", { replace: false, summary: "Draft", plan: BLOCKED }, "c1")],
      },
      // The model reads the CHECKS line and fixes the door in the same turn, as the prompt asks.
      {
        kind: "reply",
        parts: [
          call(
            "edit_plan",
            {
              baseVersion: 1,
              summary: "Cleared the doorway",
              changes: ["Moved the altar off the doorway"],
              ops: [{ op: "move", ids: ["altar"], dx: 3, dy: 0 }],
            },
            "e1",
          ),
        ],
      },
      { kind: "reply", parts: [say("Drafted; I moved the altar off the doorway.")] },
    ]);
    await engine.send({ text: "draw", intent: "plan" });
    await engine.whenIdle();

    const first = resultText(host, "c1");
    expect(first).toContain('"code":"opening_blocked"');
    expect(first).toContain("CHECKS: NOT CLEAN — 1 error");
    expect(first).toMatch(/hint/);
    // The model saw the report before its fixing step.
    const seen = JSON.stringify(provider.requests[1]?.transcript.at(-1));
    expect(seen).toContain("opening_blocked");

    expect(resultText(host, "e1")).toContain("CHECKS: clean");
    expect(host.project?.history.head).toBe(2);
    const end = finished(host).at(-1);
    expect(end?.stopReason).toBe("end_turn");
    expect(end?.outstandingIssues).toBeUndefined();
  });

  it("engine guard: a turn that leaves error-level issues carries them on turn_finished", async () => {
    const { host, engine } = setup([
      {
        kind: "reply",
        parts: [call("create_plan", { replace: false, summary: "Draft", plan: BLOCKED }, "c1")],
      },
      { kind: "reply", parts: [say("Here's your map, all checked!")] },
    ]);
    await engine.send({ text: "draw", intent: "plan" });
    await engine.whenIdle();
    const end = finished(host).at(-1);
    expect(end?.outstandingIssues).toMatchObject({
      version: 1,
      errors: 1,
      items: [
        {
          severity: "error",
          code: "opening_blocked",
          elementId: "d1",
          cell: [7, 3],
          hint: expect.stringContaining("altar") as unknown,
        },
      ],
    });
  });

  it("no summary when the turn did not change the plan", async () => {
    const { host, engine } = setup([
      {
        kind: "reply",
        parts: [call("create_plan", { replace: false, summary: "Draft", plan: BLOCKED }, "c1")],
      },
      { kind: "reply", parts: [say("Drafted.")] },
      { kind: "reply", parts: [say("Just chatting.")] },
    ]);
    await engine.send({ text: "draw", intent: "plan" });
    await engine.whenIdle();
    await engine.send({ text: "thanks", intent: "chat" });
    await engine.whenIdle();
    expect(finished(host).at(-1)?.outstandingIssues).toBeUndefined();
  });
});

describe("stop reasons and failures", () => {
  it("cancel keeps streamed text display-only and ends the turn", async () => {
    const { host, engine } = setup([{ kind: "hang" }]);
    const { turnId } = await engine.send({ text: "draw" });
    await new Promise((r) => setTimeout(r, 5));
    await engine.cancel(turnId);
    const last = items(host).at(-1);
    expect(last).toMatchObject({
      type: "assistant",
      stopReason: "cancelled",
      excludedFromContext: true,
      parts: [{ type: "text", text: "Partial answer" }],
    });
    expect(finished(host).at(-1)).toMatchObject({ stopReason: "cancelled", canRetry: true });
    expect(host.busy).toBeNull();
  });

  it("refusal: output kept for display only, plan unchanged, notice shown", async () => {
    const { host, engine } = setup([
      { kind: "reply", parts: [say("I can't help with that")], stopReason: "refusal" },
    ]);
    await engine.send({ text: "x" });
    await engine.whenIdle();
    expect(items(host).at(-1)).toMatchObject({ type: "assistant", excludedFromContext: true });
    expect(host.eventsOf("notice").filter((n) => n.kind === "refusal")).toHaveLength(1);
    expect(host.project?.history.head).toBe(0);
    expect(Object.values(host.conv().meta)[0]?.status).toBe("refused");
  });

  it("max_tokens with a tool call: discard, retry once with 128K and a hint; never run the cut-off call", async () => {
    const { host, engine, provider } = setup([
      {
        kind: "reply",
        parts: [call("create_plan", { replace: false, summary: "cut", plan: {} })],
        stopReason: "max_tokens",
      },
      {
        kind: "reply",
        parts: [call("create_plan", { replace: false, summary: "Draft", plan: AUTHORED }, "ok")],
      },
      { kind: "reply", parts: [say("Done.")] },
    ]);
    await engine.send({ text: "draw" });
    await engine.whenIdle();
    expect(provider.requests[1]?.maxOutputTokens).toBe(128_000);
    expect(provider.requests[1]?.transcript.at(-1)).toMatchObject({ type: "context", reason: "retry_hint" });
    expect(host.project?.history.head).toBe(1);
    assertWellFormed(items(host));
  });

  it("max_tokens twice fails the turn with the 'came back incomplete' copy", async () => {
    const cut: ScriptedStep = { kind: "reply", parts: [call("create_plan", {})], stopReason: "max_tokens" };
    const { host, engine } = setup([cut, { ...cut, parts: [call("create_plan", {})] }]);
    await engine.send({ text: "draw" });
    await engine.whenIdle();
    expect(host.eventsOf("turn_failed")[0]?.error.message).toContain("came back incomplete");
    expect(host.project?.history.head).toBe(0);
  });

  it("max_tokens on text offers Continue", async () => {
    const { host, engine, provider } = setup([
      { kind: "reply", parts: [say("Long answer…")], stopReason: "max_tokens" },
      { kind: "reply", parts: [say("…the rest.")] },
    ]);
    await engine.send({ text: "tell me" });
    await engine.whenIdle();
    expect(finished(host)[0]).toMatchObject({ stopReason: "max_tokens", canContinue: true });
    await engine.continue();
    await engine.whenIdle();
    expect(provider.requests[1]?.transcript.at(-1)).toMatchObject({ type: "user" });
  });

  it("pause re-issues the step (capped)", async () => {
    const { host, engine, provider } = setup([
      { kind: "reply", parts: [say("Working")], stopReason: "pause" },
      { kind: "reply", parts: [say("Done")] },
    ]);
    await engine.send({ text: "x" });
    await engine.whenIdle();
    expect(provider.requests).toHaveLength(2);
    expect(finished(host)[0]?.stopReason).toBe("end_turn");
  });

  it("rate limit / overload: backs off with notices, then succeeds", async () => {
    const { host, engine } = setup([
      { kind: "error", info: { kind: "rate_limit", retryable: true, message: "busy", retryAfterMs: 1000 } },
      { kind: "error", info: { kind: "overloaded", retryable: true, message: "busy" } },
      { kind: "reply", parts: [say("ok")] },
    ]);
    await engine.send({ text: "x" });
    await engine.whenIdle();
    expect(
      host
        .eventsOf("notice")
        .filter((n) => n.kind === "retrying")
        .map((n) => n.text),
    ).toEqual(["Anthropic is busy — retrying in 1s.", "Anthropic is busy — retrying in 12s."]);
    expect(finished(host)[0]?.stopReason).toBe("end_turn");
  });

  it("after three busy retries the turn fails with 'Still busy'", async () => {
    const busy: ScriptedStep = {
      kind: "error",
      info: { kind: "overloaded", retryable: true, message: "busy" },
    };
    const { host, engine } = setup([busy, busy, busy, busy]);
    await engine.send({ text: "x" });
    await engine.whenIdle();
    expect(host.eventsOf("turn_failed")[0]?.error).toMatchObject({
      code: "provider",
      message: expect.stringContaining("Still busy") as unknown,
    });
  });

  it("non-retryable errors fail immediately", async () => {
    const { host, engine } = setup([
      { kind: "error", info: { kind: "auth", retryable: false, message: "bad key", httpStatus: 401 } },
    ]);
    await engine.send({ text: "x" });
    await engine.whenIdle();
    expect(host.eventsOf("turn_failed")[0]?.error).toMatchObject({
      message: "Your API key was rejected.",
      provider: { kind: "auth" },
    });
  });

  it("masks key-shaped text in provider and raw error messages before they reach the UI", async () => {
    const leaked = "sk-ant-api03-LEAKED-not-real-111111111111-z9Y8";
    const viaInfo = setup([
      { kind: "error", info: { kind: "invalid_request", retryable: false, message: `rejected ${leaked}` } },
    ]);
    await viaInfo.engine.send({ text: "x" });
    await viaInfo.engine.whenIdle();
    const raw = setup(() => {
      throw new Error(`socket hang up ${leaked}`);
    });
    await raw.engine.send({ text: "x" });
    await raw.engine.whenIdle();
    for (const host of [viaInfo.host, raw.host]) {
      const failedEvents = host.eventsOf("turn_failed");
      expect(failedEvents).toHaveLength(1);
      expect(JSON.stringify(failedEvents)).not.toContain("LEAKED-not-real");
      expect(failedEvents[0]?.error.message).toContain("sk-ant-…[redacted]");
    }
  });

  it("refuses to send without a key and while a turn runs", async () => {
    const noKey = setup([], { apiKey: null });
    await expect(noKey.engine.send({ text: "x" })).rejects.toBeInstanceOf(EnginePortError);
    const { engine } = setup([{ kind: "hang" }]);
    const { turnId } = await engine.send({ text: "x" });
    await expect(engine.send({ text: "y" })).rejects.toMatchObject({ error: { code: "busy" } });
    await expect(
      engine.setSelection({ providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "high" }),
    ).rejects.toMatchObject({ error: { code: "busy" } });
    await engine.cancel(turnId);
  });
});

describe("model and effort switching", () => {
  it("snaps and caps effort", () => {
    const opus = staticDescriptors()[0];
    expect(snapEffort("xhigh", opus)).toBe("xhigh");
    expect(snapEffort(null, opus)).toBe("medium");
    expect(
      snapEffort("high", {
        ...opus,
        effort: { supported: true, levels: ["low", "medium"], default: "medium" },
      } as never),
    ).toBe("medium");
    expect(snapEffort("high", { ...opus, effort: { supported: false } } as never)).toBeNull();
    expect(capEffort("max", "medium")).toBe("medium");
    expect(capEffort("low", "medium")).toBe("low");
  });

  it("selection changes apply at turn boundaries as appended markers; effort snaps to the model", async () => {
    const { host, engine, provider } = setup([
      { kind: "reply", parts: [say("a")] },
      { kind: "reply", parts: [say("b")] },
    ]);
    await engine.send({ text: "hello", intent: "plan" });
    await engine.whenIdle();
    const before = items(host).length;
    const r = await engine.setSelection({
      providerId: "anthropic",
      modelId: "claude-sonnet-5-5",
      effort: "max",
    });
    expect(r.selection.effort).toBe("max");
    expect(items(host).slice(before)).toMatchObject([
      { type: "marker", selection: { modelId: "claude-sonnet-5-5", effort: "max" } },
    ]);
    expect(host.conv().selectionLog).toHaveLength(1);
    await engine.send({ text: "go on", intent: "plan" });
    await engine.whenIdle();
    expect(provider.requests[1]?.selection.modelId).toBe("claude-sonnet-5-5");
    expect(provider.requests[1]?.effort).toBe("max");
    // Unchanged selection appends nothing.
    await engine.setEffort("max");
    expect(items(host).filter((i) => i.type === "marker")).toHaveLength(1);
  });

  it("Smart effort caps chat turns at medium through a marker, only when that keeps the cache", async () => {
    const { host, engine, provider } = setup([
      { kind: "reply", parts: [say("a")] },
      { kind: "reply", parts: [say("b")] },
    ]);
    await engine.setEffort("high");
    await engine.send({ text: "sounds good", intent: "chat" });
    await engine.whenIdle();
    expect(provider.requests[0]?.effort).toBe("medium");
    expect(items(host).flatMap((m) => (m.type === "marker" ? [m.selection.effort] : []))).toEqual([
      "high",
      "medium",
    ]);
    provider.perMessageEffort = false;
    await engine.send({ text: "ok", intent: "chat" });
    await engine.whenIdle();
    expect(provider.requests[1]?.effort).toBe("high");
  });

  it("previewSwitch asks the provider and reports effort snapping", async () => {
    const { engine } = setup([]);
    const impact = await engine.previewSwitch({
      providerId: "anthropic",
      modelId: "claude-fable-5-2",
      effort: "medium",
    });
    expect(impact.cacheReset).toBe(true);
  });
});

describe("context, retry and resume", () => {
  it("announces plan changes made outside the conversation", async () => {
    const { host, engine, provider } = setup([
      {
        kind: "reply",
        parts: [call("create_plan", { replace: false, summary: "Draft", plan: AUTHORED }, "c1")],
      },
      { kind: "reply", parts: [say("ok")] },
      { kind: "reply", parts: [say("seen")] },
    ]);
    await engine.send({ text: "draw" });
    await engine.whenIdle();
    const plan = host.getPlan() as MapPlan;
    const edited = applyOps(plan, [{ op: "update", id: "hall", set: { name: "Great Hall" } }], RULES);
    if (!edited.ok) throw new Error("edit failed");
    host.commitVersion({
      plan: edited.plan,
      author: "user",
      summary: "You renamed hall",
      cause: { type: "ops", ops: [{ op: "update", id: "hall", set: { name: "Great Hall" } }] },
    });
    await engine.send({ text: "what changed?" });
    await engine.whenIdle();
    const ctx = provider.requests[2]?.transcript.find(
      (i) => i.type === "context" && i.reason === "plan_changed",
    );
    expect(ctx?.type === "context" && ctx.text).toContain("it is now v2 (you last saw v1)");
  });

  it("retry moves the tail into alternatives and undoes the turn's versions", async () => {
    const { host, engine } = setup([
      {
        kind: "reply",
        parts: [call("create_plan", { replace: false, summary: "Draft", plan: AUTHORED }, "c1")],
      },
      { kind: "reply", parts: [say("v1 done")] },
      {
        kind: "reply",
        parts: [
          call(
            "edit_plan",
            { baseVersion: 1, summary: "Bad", changes: [], ops: [{ op: "remove", ids: ["altar"] }] },
            "e1",
          ),
        ],
      },
      { kind: "reply", parts: [say("removed")] },
      { kind: "reply", parts: [say("second try")] },
    ]);
    await engine.send({ text: "draw" });
    await engine.whenIdle();
    await engine.send({ text: "remove the altar" });
    await engine.whenIdle();
    expect(host.project?.history.head).toBe(2);
    await engine.retry({});
    await engine.whenIdle();
    const p = host.project;
    // Retry moves head back (an undo through EngineHost.moveHead), it does not add a restore version.
    expect(p?.history.versions.some((v) => v.cause.type === "restore")).toBe(false);
    expect(p?.history.head).toBe(1);
    expect(p?.history.undone).toContain(2);
    expect(host.getPlan()?.levels[0]?.features.map((f) => f.id)).toEqual(["altar"]);
    const metas = Object.values(host.conv().meta);
    expect(metas.at(-1)?.alternatives?.[0]?.items.some((i) => i.type === "assistant")).toBe(true);
    assertWellFormed(items(host));
  });

  it("resume after a crash mid-tools answers dangling calls so the transcript stays valid", () => {
    const { host, engine } = setup([]);
    host.appendItems("conv1", [
      { type: "user", id: "u", text: "x", createdAt: "t" },
      {
        type: "assistant",
        id: "a",
        turnId: "t1",
        parts: [call("view_plan", { format: "outline" }, "dangling")],
        stopReason: "tool_use",
        servedBy: { providerId: "anthropic", modelId: "claude-opus-5-5" },
        createdAt: "t",
      },
    ]);
    engine.onProjectOpened();
    expect(items(host).at(-1)).toMatchObject({
      type: "tool_results",
      results: [{ callId: "dangling", isError: true }],
    });
    assertWellFormed(items(host));
  });
});

describe("review fixes", () => {
  const draft = (id = "c1"): ScriptedStep => ({
    kind: "reply",
    parts: [call("create_plan", { replace: false, summary: "Draft", plan: AUTHORED }, id)],
  });

  it("1: concurrent calls on every turn-starting entry point start exactly one turn", async () => {
    const { host, engine, provider } = setup([
      { kind: "reply", parts: [say("a")] },
      { kind: "reply", parts: [say("b")] },
    ]);
    const r = await Promise.allSettled([
      engine.send({ text: "x" }),
      engine.send({ text: "y" }),
      engine.continue(),
      engine.retry({}),
      engine.setEffort("low"),
    ]);
    expect(r.map((x) => x.status)).toEqual(["fulfilled", "rejected", "rejected", "rejected", "rejected"]);
    for (const x of r.slice(1))
      expect(x.status === "rejected" && (x.reason as EnginePortError).error.code).toBe("busy");
    await engine.whenIdle();
    expect(provider.requests).toHaveLength(1);
    expect(items(host).filter((i) => i.type === "user")).toHaveLength(1);
    // The lock is released on error paths too.
    const noKey = setup([{ kind: "reply", parts: [say("ok")] }], { apiKey: null });
    await expect(noKey.engine.send({ text: "x" })).rejects.toMatchObject({ error: { code: "no_api_key" } });
    await expect(noKey.engine.send({ text: "x" })).rejects.toMatchObject({ error: { code: "no_api_key" } });
    // And a later call after the turn ends works.
    await engine.send({ text: "z" });
    await engine.whenIdle();
    expect(provider.requests).toHaveLength(2);
  });

  it("2: changing effort while a question card is pending keeps every request valid", async () => {
    const { host, engine, provider } = setup([
      {
        kind: "reply",
        parts: [
          call(
            "ask_questions",
            { questions: [{ id: "q1", text: "Size?", default: "small", options: ["small", "big"] }] },
            "q",
          ),
        ],
      },
      { kind: "reply", parts: [say("ok")] },
    ]);
    await engine.send({ text: "hi" });
    await engine.whenIdle();
    await engine.setEffort("high");
    await engine.send({ text: "small", answers: { callId: "q", answers: [{ id: "q1", answer: "small" }] } });
    await engine.whenIdle();
    expect(provider.requests).toHaveLength(2);
    assertWellFormed(items(host));
    // (the afterEach invariant renders both requests and checks their shape)
  });

  it("3: a second ask_questions in one step is answered at once; the first stays the card", async () => {
    const q = { questions: [{ id: "q1", text: "Size?", default: "small", options: ["small", "big"] }] };
    const { host, engine } = setup([
      { kind: "reply", parts: [call("ask_questions", q, "qa"), call("ask_questions", q, "qb")] },
      { kind: "reply", parts: [say("ok")] },
    ]);
    await engine.send({ text: "hi" });
    await engine.whenIdle();
    expect(host.conv().pendingQuestions?.callId).toBe("qa");
    const qb = items(host)
      .flatMap((i) => (i.type === "tool_results" ? i.results : []))
      .find((r) => r.callId === "qb");
    expect(qb).toMatchObject({ isError: true });
    expect(host.eventsOf("questions")).toHaveLength(1);
    await engine.send({ text: "small" });
    await engine.whenIdle();
    assertWellFormed(items(host));
  });

  it("3: resume repair inserts missing results right after their assistant item, for any tool", () => {
    const { host, engine } = setup([]);
    const sel = { providerId: "anthropic", modelId: "claude-opus-5-5" } as const;
    host.appendItems("conv1", [
      { type: "user", id: "u1", text: "x", createdAt: "t" },
      {
        type: "assistant",
        id: "a1",
        turnId: "t1",
        parts: [
          call("view_plan", { format: "outline" }, "lost"),
          call("list_catalog", { what: "themes" }, "ok1"),
        ],
        stopReason: "tool_use",
        servedBy: sel,
        createdAt: "t",
      },
      {
        type: "tool_results",
        id: "r1",
        turnId: "t1",
        results: [
          { callId: "ok1", name: "list_catalog", isError: false, content: [{ type: "text", text: "{}" }] },
        ],
        createdAt: "t",
      },
      {
        type: "assistant",
        id: "a2",
        turnId: "t1",
        parts: [say("done")],
        stopReason: "end_turn",
        servedBy: sel,
        createdAt: "t",
      },
      { type: "user", id: "u2", text: "next", createdAt: "t" },
      {
        type: "assistant",
        id: "a3",
        turnId: "t2",
        parts: [call("ask_questions", {}, "pq")],
        stopReason: "tool_use",
        servedBy: sel,
        createdAt: "t",
      },
    ]);
    host.updateConversation("conv1", (c) => {
      c.pendingQuestions = { callId: "pq", itemId: "a3" };
    });
    engine.onProjectOpened();
    const it = items(host);
    expect(it.map((i) => i.id).slice(0, 4)).toEqual(["u1", "a1", "id1", "r1"]);
    expect(it[2]).toMatchObject({ type: "tool_results", results: [{ callId: "lost", isError: true }] });
    expect(it.at(-1)?.id).toBe("a3"); // the live question card is left for the GM's answer
    expect(host.conv().pendingQuestions?.callId).toBe("pq");
  });

  it("4: Retry is refused, with nothing changed, when the GM edited the map after the reply", async () => {
    const { host, engine } = setup([
      draft(),
      { kind: "reply", parts: [say("v1")] },
      {
        kind: "reply",
        parts: [
          call(
            "edit_plan",
            { baseVersion: 1, summary: "rm", changes: [], ops: [{ op: "remove", ids: ["altar"] }] },
            "e1",
          ),
        ],
      },
      { kind: "reply", parts: [say("removed")] },
    ]);
    await engine.send({ text: "draw" });
    await engine.whenIdle();
    await engine.send({ text: "remove altar" });
    await engine.whenIdle();
    const ops = [{ op: "update" as const, id: "hall", set: { name: "Great Hall" } }];
    const e = applyOps(host.getPlan() as MapPlan, ops, RULES);
    if (!e.ok) throw new Error("edit");
    host.commitVersion({ plan: e.plan, author: "user", summary: "rename", cause: { type: "ops", ops } });
    const before = JSON.stringify(host.project);
    await expect(engine.retry({})).rejects.toMatchObject({
      error: {
        code: "validation",
        message:
          "You changed the map after this reply. Undo your changes first, or ask for a change instead.",
      },
    });
    expect(JSON.stringify(host.project)).toBe(before);
    expect(host.getPlan()?.levels[0]?.areas[1]?.name).toBe("Great Hall");
  });

  it("5: Retry of the turn that drew the first plan goes back to no plan; redo would bring v1 back", async () => {
    const { host, engine, provider } = setup([
      draft("c1"),
      { kind: "reply", parts: [say("done")] },
      draft("c2"),
      { kind: "reply", parts: [say("again")] },
    ]);
    await engine.send({ text: "draw" });
    await engine.whenIdle();
    await engine.retry({});
    // The retried request sees no plan and the model's create_plan succeeds again.
    await engine.whenIdle();
    expect(provider.requests[2]?.transcript.some((i) => i.type === "tool_results")).toBe(false);
    const c2 = items(host)
      .flatMap((i) => (i.type === "tool_results" ? i.results : []))
      .find((r) => r.callId === "c2");
    expect(c2?.isError).toBe(false);
    expect(host.project?.history.head).toBe(2);
    expect(host.project?.history.undone).toContain(1);
  });

  it("6: Retry after a mid-turn max_tokens retry removes the whole turn, retry hint included", async () => {
    const { host, engine, provider } = setup([
      draft(),
      { kind: "reply", parts: [say("v1")] },
      {
        kind: "reply",
        parts: [
          call(
            "edit_plan",
            { baseVersion: 1, summary: "rm", changes: [], ops: [{ op: "remove", ids: ["altar"] }] },
            "e1",
          ),
        ],
      },
      {
        kind: "reply",
        parts: [call("edit_plan", { baseVersion: 2, summary: "cut", changes: [], ops: [] }, "e2")],
        stopReason: "max_tokens",
      },
      { kind: "reply", parts: [say("done")] },
      { kind: "reply", parts: [say("retried")] },
    ]);
    await engine.send({ text: "draw" });
    await engine.whenIdle();
    await engine.send({ text: "remove altar" });
    await engine.whenIdle();
    await engine.retry({});
    await engine.whenIdle();
    expect(host.project?.history.head).toBe(1);
    const retried = provider.requests.at(-1)?.transcript ?? [];
    const lastUser = retried.findLastIndex((i) => i.type === "user");
    expect(retried.slice(lastUser + 1).some((i) => i.type === "context" && i.reason === "retry_hint")).toBe(
      false,
    );
    expect(JSON.stringify(retried)).not.toContain('"e1"');
    const alt = Object.values(host.conv().meta).at(-1)?.alternatives?.[0];
    expect(alt?.items.some((i) => i.type === "context" && i.reason === "retry_hint")).toBe(true);
    expect(alt?.meta.status).toBe("complete");
  });

  it("10: usage of a step that streamed and then failed is counted", async () => {
    const { host } = setup([]);
    const p = new ScriptedProvider([{ kind: "reply", parts: [say("ok")] }]);
    // A provider that reports partial usage, then drops mid-stream once.
    let first = true;
    const runStep = p.runStep.bind(p);
    p.runStep = async (req, onEvent, signal) => {
      if (first) {
        first = false;
        onEvent({
          type: "usage",
          usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
        });
        throw Object.assign(new Error("drop"), {
          info: { kind: "network", retryable: true, message: "Connection lost." },
        });
      }
      return runStep(req, onEvent, signal);
    };
    const e2 = new SlabyrinthConversationEngine(host, {
      registry: new DefaultProviderRegistry([p]),
      sleep: () => Promise.resolve(),
    });
    await e2.send({ text: "x" });
    await e2.whenIdle();
    expect(host.conv().totals.usage.outputTokens).toBe(40 + 500);
    expect(host.eventsOf("usage")[0]?.usage.outputTokens).toBe(40);
  });
});

describe("estimates", () => {
  it("prices the next turn from the table, rounded", async () => {
    const { engine } = setup([]);
    await engine.listModels("anthropic", false);
    const chat = await engine.estimate({ text: "hello", intent: "chat" });
    const plan = await engine.estimate({ text: "draw a dungeon", intent: "plan" });
    expect(chat.basis).toBe("table");
    expect(chat.costUsd).not.toBeNull();
    expect(plan.costUsd ?? 0).toBeGreaterThan(chat.costUsd ?? 0);
    expect([5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600]).toContain(plan.seconds);
  });
});
