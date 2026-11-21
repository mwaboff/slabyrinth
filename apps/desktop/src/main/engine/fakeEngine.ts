import { randomUUID } from "node:crypto";
import type { ChatItem, ModelDescriptor, ModelSelection, ProviderInfo } from "../agent/provider/types";
import type { IpcRequests } from "../../shared/ipc";
import type { ChatMessageMeta } from "../../shared/project";
import type { ApplyOps, MapPlan } from "@slabyrinth/core";
import {
  EnginePortError,
  type CommitVersionInput,
  type ConversationEngine,
  type EngineFactory,
  type EngineHost,
} from "../ports/engine";
import { staticDescriptors } from "../agent/provider/anthropic/models";
import { ANTHROPIC_INFO } from "../agent/provider/anthropic/provider";
import { FAKE_USAGE, pick, type RecordedStep, type Recording } from "./recordings";

/**
 * Fake ConversationEngine: replays recorded event streams (engine/recordings.ts) through the REAL
 * host and IPC — items are appended to the project, versions committed, events emitted, autosave
 * flushed — so the renderer can build chat against it before WP4's engine exists.
 * Send "#ask" for a question card, "#fail" for a provider error; the first message draws a plan.
 */
export interface FakeEngineOptions {
  /** Multiplies recorded delays (0 = instant; e2e uses 0). */
  speed?: number;
  /** core applyOps, for edit_plan recordings (null: edits report failure). */
  applyOps?: ApplyOps | null;
}

/** Same provider info and model table as the real engine (no duplicate tables to drift). */
const PROVIDERS: Array<ProviderInfo & { enabled: boolean }> = [{ ...ANTHROPIC_INFO, enabled: true }];
const MODELS: ModelDescriptor[] = staticDescriptors();

/** What a replayed step and the replayed turn cost (USD). */
const FAKE_STEP_COST = 0.01;

/** One replay in progress: the turn, and what it has committed and streamed so far. */
interface ReplayRun {
  turnId: string;
  conversationId: string;
  selection: ModelSelection;
  started: number;
  versions: number[];
  /** Text streamed since the last assistant message (kept display-only when the turn is cancelled). */
  streamed: string;
  lastAssistantId: string | null;
}

export class FakeEngine implements ConversationEngine {
  private running: { turnId: string; abort: AbortController; done: Promise<void> } | null = null;
  private lastUser: IpcRequests["chat:send"]["req"] | null = null;

  constructor(
    private readonly host: EngineHost,
    private readonly opts: FakeEngineOptions = {},
  ) {}

  conversationDefaults(): ReturnType<ConversationEngine["conversationDefaults"]> {
    return {
      systemPromptVersion: "sp-fake-0",
      toolsVersion: "tools-fake-0",
      imageToolEnabled: true,
      toolMode: "native",
    };
  }

  private conversation() {
    const p = this.host.getProject();
    if (!p) throw new EnginePortError({ code: "no_project", message: "No map is open." });
    const c = p.conversations.find((x) => x.id === p.activeConversationId);
    if (!c) throw new EnginePortError({ code: "internal", message: "No active conversation." });
    return c;
  }

  async send(req: IpcRequests["chat:send"]["req"]): Promise<{ turnId: string }> {
    if (this.running) throw new EnginePortError({ code: "busy", message: "A reply is still being written." });
    const conv = this.conversation();
    const turnId = randomUUID();
    const now = new Date().toISOString();
    const items: ChatItem[] = [];
    if (req.answers && conv.pendingQuestions?.callId === req.answers.callId) {
      items.push({
        type: "tool_results",
        id: randomUUID(),
        turnId,
        results: [
          {
            callId: req.answers.callId,
            name: "ask_questions",
            isError: false,
            content: [{ type: "text", text: JSON.stringify(req.answers.answers) }],
          },
        ],
        createdAt: now,
      });
    }
    const user: ChatItem = { type: "user", id: randomUUID(), text: req.text, createdAt: now };
    if (req.selection) user.selection = req.selection;
    items.push(user);
    this.host.appendItems(conv.id, items);
    this.host.updateConversation(conv.id, (c) => {
      delete c.pendingQuestions;
    });
    this.lastUser = req;
    this.start(turnId, pick(req.text, this.host.getPlan() !== null), conv.selection, items);
    return Promise.resolve({ turnId });
  }

  private start(turnId: string, rec: Recording, selection: ModelSelection, initialItems: ChatItem[]): void {
    const abort = new AbortController();
    this.host.setBusy({ turnId });
    this.host.emit({ type: "turn_started", turnId, selection });
    for (const item of initialItems) this.host.emit({ type: "item_appended", turnId, item });
    const done = this.replay(turnId, rec, selection, abort.signal).finally(() => {
      this.running = null;
      this.host.setBusy(null);
      void this.host.flush();
    });
    this.running = { turnId, abort, done };
  }

  private async wait(ms: number | undefined, signal: AbortSignal): Promise<void> {
    const d = (ms ?? 0) * (this.opts.speed ?? 1);
    const aborted = (): boolean => signal.aborted;
    if (aborted()) throw new Error("aborted");
    await new Promise<void>((resolve) => setTimeout(resolve, d));
    if (aborted()) throw new Error("aborted");
  }

  /**
   * Replays a recording step by step (each after its delay), then records the turn's spend and finishes it. A "fail"
   * step ends the turn as failed; a cancel (the wait throws) keeps what was streamed, display-only.
   */
  private async replay(
    turnId: string,
    rec: Recording,
    selection: ModelSelection,
    signal: AbortSignal,
  ): Promise<void> {
    const run: ReplayRun = {
      turnId,
      conversationId: this.conversation().id,
      selection,
      started: Date.now(),
      versions: [],
      streamed: "",
      lastAssistantId: null,
    };
    try {
      for (const step of rec.steps) {
        await this.wait(step.delayMs, signal);
        if (this.replayStep(run, step) === "failed") return;
      }
      this.finishReplay(run, rec);
    } catch {
      this.replayCancelled(run);
    }
  }

  private replayStep(run: ReplayRun, step: RecordedStep): "ok" | "failed" {
    const { turnId } = run;
    switch (step.kind) {
      case "event":
        if (step.event.type === "text_delta") run.streamed += step.event.text;
        if (step.event.type === "questions") {
          const callId = step.event.callId;
          this.host.updateConversation(run.conversationId, (c) => {
            c.pendingQuestions = { callId, itemId: run.lastAssistantId ?? "" };
          });
        }
        this.host.emit({ ...step.event, turnId });
        return "ok";
      case "brief":
        this.host.setBrief(step.brief);
        this.host.emit({ type: "brief_updated", turnId, brief: step.brief, skipped: [] });
        return "ok";
      case "commit":
        this.replayCommit(run, step);
        return "ok";
      case "assistant":
        this.replayAssistant(run, step);
        return "ok";
      case "fail":
        this.host.emit({
          type: "turn_failed",
          turnId,
          error: { code: step.code, message: step.message },
          canRetry: true,
        });
        return "failed";
    }
  }

  /** A recorded create_plan or edit_plan: commits a version (an edit's ops applied to the head plan). */
  private replayCommit(run: ReplayRun, step: Extract<RecordedStep, { kind: "commit" }>): void {
    const { turnId } = run;
    let plan: MapPlan;
    let cause: CommitVersionInput["cause"];
    if (step.tool === "create_plan") {
      plan = step.plan;
      cause = { type: "create" };
    } else {
      const current = this.host.getPlan();
      const ops = current ? step.ops(current) : [];
      const applied = current && this.opts.applyOps ? this.opts.applyOps(current, ops) : null;
      if (!applied?.ok) {
        this.host.emit({
          type: "tool_call_finished",
          turnId,
          callId: step.callId,
          name: step.tool,
          ok: false,
          summary: "The edit couldn't be applied.",
        });
        return;
      }
      plan = applied.plan;
      cause = { type: "ops", ops };
    }
    const r = this.host.commitVersion({
      plan,
      author: "ai",
      summary: step.summary,
      changeSummary: step.changeSummary,
      cause,
      cost: { currency: "USD", amount: FAKE_STEP_COST },
    });
    run.versions.push(r.version);
    this.host.emit({
      type: "tool_call_finished",
      turnId,
      callId: step.callId,
      name: step.tool,
      ok: true,
      summary: step.summary,
      newVersion: r.version,
    });
  }

  /** A recorded assistant message: appended with its meta; the streamed text it holds is now saved. */
  private replayAssistant(run: ReplayRun, step: Extract<RecordedStep, { kind: "assistant" }>): void {
    const { turnId, selection } = run;
    const id = randomUUID();
    run.lastAssistantId = id;
    const item: ChatItem = {
      type: "assistant",
      id,
      turnId,
      parts: step.parts,
      stopReason: step.stopReason,
      servedBy: { providerId: selection.providerId, modelId: selection.modelId },
      usage: FAKE_USAGE,
      createdAt: new Date().toISOString(),
    };
    const meta: ChatMessageMeta = {
      selection,
      servedBy: item.servedBy,
      effortUsed: selection.effort,
      durationMs: Date.now() - run.started,
      usage: FAKE_USAGE,
      cost: { currency: "USD", amount: FAKE_STEP_COST, estimated: true },
      status: "complete",
      versions: [...run.versions],
    };
    this.host.appendItems(run.conversationId, [item], { [id]: meta });
    this.host.emit({ type: "item_appended", turnId, item });
    run.streamed = "";
  }

  /** The turn's spend added to the totals, then turn_finished (tool_use while a question card waits). */
  private finishReplay(run: ReplayRun, rec: Recording): void {
    const { turnId } = run;
    const cost = { currency: "USD" as const, amount: FAKE_STEP_COST, estimated: true };
    this.host.addSpend(FAKE_USAGE, cost);
    let totals = { usage: FAKE_USAGE, cost: cost as typeof cost | null };
    this.host.updateConversation(run.conversationId, (c) => {
      c.totals.turns += 1;
      c.totals.usage = {
        inputTokens: c.totals.usage.inputTokens + FAKE_USAGE.inputTokens,
        outputTokens: c.totals.usage.outputTokens + FAKE_USAGE.outputTokens,
        cacheReadTokens: c.totals.usage.cacheReadTokens + FAKE_USAGE.cacheReadTokens,
        cacheWriteTokens: c.totals.usage.cacheWriteTokens + FAKE_USAGE.cacheWriteTokens,
      };
      c.totals.cost = {
        currency: "USD",
        amount: (c.totals.cost?.amount ?? 0) + cost.amount,
        estimated: true,
      };
      totals = { usage: c.totals.usage, cost: c.totals.cost };
    });
    this.host.emit({ type: "usage", turnId, usage: FAKE_USAGE, cost, totals });
    const awaitingAnswers = rec.steps.some((s) => s.kind === "event" && s.event.type === "questions");
    this.host.emit({
      type: "turn_finished",
      turnId,
      stopReason: awaitingAnswers ? "tool_use" : "end_turn",
      canContinue: false,
      canRetry: true,
    });
  }

  /** Cancelled: keep streamed text display-only (excludedFromContext), like the real engine. */
  private replayCancelled(run: ReplayRun): void {
    const { turnId, selection } = run;
    if (run.streamed.length > 0) {
      const item: ChatItem = {
        type: "assistant",
        id: randomUUID(),
        turnId,
        parts: [{ type: "text", text: run.streamed }],
        stopReason: "cancelled",
        servedBy: { providerId: selection.providerId, modelId: selection.modelId },
        excludedFromContext: true,
        createdAt: new Date().toISOString(),
      };
      this.host.appendItems(run.conversationId, [item]);
      this.host.emit({ type: "item_appended", turnId, item });
    }
    this.host.emit({
      type: "turn_finished",
      turnId,
      stopReason: "cancelled",
      canContinue: false,
      canRetry: true,
    });
  }

  async cancel(turnId: string): Promise<void> {
    if (this.running?.turnId !== turnId) return;
    this.running.abort.abort();
    await this.running.done;
  }

  estimate(): Promise<IpcRequests["chat:estimate"]["res"]> {
    return Promise.resolve({ costUsd: 0.02, seconds: 8, basis: "table" });
  }

  retry(): Promise<{ turnId: string }> {
    if (!this.lastUser) throw new EnginePortError({ code: "validation", message: "Nothing to retry." });
    return this.send({ ...this.lastUser, text: this.lastUser.text });
  }

  continue(): Promise<{ turnId: string }> {
    return this.send({ text: "(continue)" });
  }

  selectAlternative(req: IpcRequests["chat:selectAlternative"]["req"]): Promise<void> {
    const conv = this.conversation();
    this.host.updateConversation(conv.id, (c) => {
      const m = c.meta[req.messageId];
      if (m) m.activeAlternative = req.index;
    });
    return Promise.resolve();
  }

  previewSwitch(selection: ModelSelection): Promise<IpcRequests["chat:previewSwitch"]["res"]> {
    const current = this.conversation().selection;
    const modelChanged = current.modelId !== selection.modelId || current.providerId !== selection.providerId;
    return Promise.resolve({
      cacheReset: modelChanged,
      reasoningDropped: modelChanged,
      estimatedExtraCost: modelChanged ? 0.05 : 0,
      messages: modelChanged ? ["The next message re-reads the conversation (about $0.05)."] : [],
    });
  }

  setSelection(selection: ModelSelection): Promise<{ selection: ModelSelection }> {
    if (this.running) throw new EnginePortError({ code: "busy", message: "Wait for the reply to finish." });
    const conv = this.conversation();
    const marker: ChatItem = {
      type: "marker",
      id: randomUUID(),
      kind: "selection_changed",
      selection,
      createdAt: new Date().toISOString(),
    };
    this.host.updateConversation(conv.id, (c) => {
      c.selection = selection;
      c.selectionLog.push({
        at: marker.createdAt,
        afterItemId: c.items[c.items.length - 1]?.id ?? null,
        selection,
      });
    });
    this.host.appendItems(conv.id, [marker]);
    return Promise.resolve({ selection });
  }

  setEffort(effort: ModelSelection["effort"]): Promise<{ selection: ModelSelection }> {
    return this.setSelection({ ...this.conversation().selection, effort });
  }

  listProviders(): Promise<Array<ProviderInfo & { enabled: boolean }>> {
    return Promise.resolve(structuredClone(PROVIDERS));
  }

  async checkProvider(
    providerId: string,
  ): Promise<{ ok: true } | { ok: false; error: { kind: "auth"; retryable: false; message: string } }> {
    const key = await this.host.getApiKey(providerId);
    return key === null
      ? { ok: false, error: { kind: "auth", retryable: false, message: "No API key is set." } }
      : { ok: true };
  }

  listModels(providerId: string): Promise<ModelDescriptor[]> {
    return Promise.resolve(providerId === "anthropic" ? structuredClone(MODELS) : []);
  }

  async onProjectClosing(): Promise<void> {
    if (this.running) {
      this.running.abort.abort();
      await this.running.done.catch(() => undefined);
    }
  }

  onProjectOpened(): void {
    // nothing to resume in the fake
  }

  async dispose(): Promise<void> {
    await this.onProjectClosing();
  }
}

export const createFakeEngine =
  (opts: FakeEngineOptions = {}): EngineFactory =>
  (host) =>
    new FakeEngine(host, opts);
