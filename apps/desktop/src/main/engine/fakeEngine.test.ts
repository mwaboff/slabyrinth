import * as fsp from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { bundledPalettes } from "@slabyrinth/core/palette";
import type { ChatEvent } from "../../shared/ipc";
import type { ConversationEngine, EngineHost } from "../ports/engine";
import { memoryLogger } from "../logger";
import { corePort, projectRig, type ProjectRig } from "../services/testing/helpers";
import { FakeEngine } from "./fakeEngine";

let rig: ProjectRig | null = null;
afterEach(async () => {
  if (rig) {
    await rig.projects.close({}).catch(() => undefined);
    await fsp.rm(rig.dir, { recursive: true, force: true });
  }
  rig = null;
});

/** Minimal EngineHost over the real ProjectService (the same mapping main/app.ts uses). */
function hostFor(r: ProjectRig): EngineHost {
  const p = r.projects;
  return {
    getProject: () => p.getProject(),
    getPlan: (v) => (p.isOpen ? p.getPlan(v) : null),
    commitVersion: (i) => p.commitVersion(i),
    moveHead: (v) => p.moveHead(v),
    appendItems: (id, items, meta) => {
      p.appendItems(id, items, meta);
    },
    updateConversation: (id, fn) => {
      p.updateConversation(id, fn);
    },
    setBrief: (b) => {
      p.setBrief(b);
    },
    setBusy: (t) => {
      if (p.isOpen) p.setBusy(t);
    },
    addSpend: (u, c) => {
      p.addSpend(u, c);
    },
    emit: (e) => {
      r.emit("chat:event", e);
    },
    requestImage: () => Promise.reject(new Error("no renderer")),
    getApiKey: () => Promise.resolve(null),
    getSettings: () => r.settings.get(),
    estimateCompile: () => Promise.resolve(null),
    getAssetCatalog: () => null,
    getPalettes: () => [],
    getBuildPalettes: () => bundledPalettes(),
    flush: () => p.flush(),
    logger: memoryLogger(),
  };
}

const chatEvents = (r: ProjectRig): ChatEvent[] =>
  r.emit.events.filter((e) => e.channel === "chat:event").map((e) => e.payload as ChatEvent);

async function untilFinished(r: ProjectRig, turnId: string): Promise<ChatEvent> {
  for (let i = 0; i < 200; i++) {
    const end = chatEvents(r).find(
      (e) => e.turnId === turnId && (e.type === "turn_finished" || e.type === "turn_failed"),
    );
    if (end) return end;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("turn did not finish");
}

describe("FakeEngine (recorded streams through the real host)", () => {
  it("first message draws a plan: items, version, brief, events and autosave", async () => {
    rig = await projectRig();
    const engine = new FakeEngine(hostFor(rig), { speed: 0, applyOps: corePort().applyChecked });
    rig.projects.setEngineHooks({
      onClosing: () => engine.onProjectClosing(),
      onOpened: () => undefined,
      conversationDefaults: () => engine.conversationDefaults(),
    });
    const snap = await rig.projects.create({ name: "Chat" });
    expect(rig.projects.getProject()?.conversations[0]?.systemPromptVersion).toBe("sp-fake-0");

    const { turnId } = await engine.send({ text: "A small crypt for Daggerheart" });
    await expect(engine.send({ text: "again" })).rejects.toMatchObject({ error: { code: "busy" } });
    expect(await untilFinished(rig, turnId)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });

    const types = chatEvents(rig).map((e) => e.type);
    expect(types[0]).toBe("turn_started");
    expect(types).toContain("progress");
    expect(types).toContain("tool_call_finished");
    expect(chatEvents(rig).find((e) => e.type === "tool_call_finished")).toMatchObject({ newVersion: 1 });

    const after = rig.projects.snapshot();
    expect(after.head).toBe(1);
    expect(after.busy).toBeNull();
    expect(after.brief.mapType).toEqual({ value: "Dungeon", source: "ai" });
    expect(after.conversation.items.map((i) => i.type)).toEqual(["user", "assistant", "assistant"]);
    expect(after.conversation.totals.turns).toBe(1);

    await rig.projects.flush();
    const saved = JSON.parse(await fsp.readFile(snap.filePath as string, "utf8")) as {
      conversations: Array<{ items: unknown[] }>;
    };
    expect(saved.conversations[0]?.items).toHaveLength(3);

    // A follow-up edit creates v2.
    const second = await engine.send({ text: "add a brazier" });
    await untilFinished(rig, second.turnId);
    expect(rig.projects.snapshot().head).toBe(2);
  });

  it("question cards: pending questions are answered by the next send", async () => {
    rig = await projectRig();
    const engine = new FakeEngine(hostFor(rig), { speed: 0, applyOps: corePort().applyChecked });
    await rig.projects.create({ name: "Ask" });
    const { turnId } = await engine.send({ text: "#ask please" });
    await untilFinished(rig, turnId);
    const conv = rig.projects.getProject()?.conversations[0];
    expect(conv?.pendingQuestions?.callId).toBe("call_q1");
    const t2 = await engine.send({
      text: "ok",
      answers: { callId: "call_q1", answers: [{ id: "q1", answer: "Daggerheart" }] },
    });
    await untilFinished(rig, t2.turnId);
    const items = rig.projects.getProject()?.conversations[0]?.items ?? [];
    expect(items.some((i) => i.type === "tool_results")).toBe(true);
    expect(rig.projects.getProject()?.conversations[0]?.pendingQuestions).toBeUndefined();
  });

  it("cancel keeps streamed text display-only; failures emit turn_failed", async () => {
    rig = await projectRig();
    const engine = new FakeEngine(hostFor(rig), { speed: 1 });
    await rig.projects.create({ name: "Stop" });
    const { turnId } = await engine.send({ text: "draw it" });
    await new Promise((r) => setTimeout(r, 120));
    await engine.cancel(turnId);
    expect(await untilFinished(rig, turnId)).toMatchObject({ stopReason: "cancelled" });
    const stopped = rig.projects
      .getProject()
      ?.conversations[0]?.items.find((i) => i.type === "assistant" && i.excludedFromContext === true);
    expect(stopped).toBeDefined();
    expect(rig.projects.snapshot().busy).toBeNull();

    const fast = new FakeEngine(hostFor(rig), { speed: 0, applyOps: corePort().applyChecked });
    const f = await fast.send({ text: "#fail" });
    expect(await untilFinished(rig, f.turnId)).toMatchObject({ type: "turn_failed", canRetry: true });
  });

  it("selection changes append a marker; providers/models/check work without a key", async () => {
    rig = await projectRig();
    const engine = new FakeEngine(hostFor(rig), { speed: 0, applyOps: corePort().applyChecked });
    await rig.projects.create({ name: "Models" });
    const sel = { providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "high" as const };
    expect((await engine.previewSwitch(sel)).cacheReset).toBe(true);
    await engine.setSelection(sel);
    expect(rig.projects.snapshot().conversation.selection).toEqual(sel);
    expect(rig.projects.snapshot().conversation.items.at(-1)?.type).toBe("marker");
    expect((await engine.listProviders()).map((p) => p.id)).toEqual(["anthropic"]); // as the real registry
    const port: ConversationEngine = engine;
    expect((await port.listModels("anthropic", false)).find((m) => m.status === "recommended")?.modelId).toBe(
      "claude-opus-5-5",
    );
    expect(await engine.checkProvider("anthropic")).toMatchObject({ ok: false, error: { kind: "auth" } });
  });
});
