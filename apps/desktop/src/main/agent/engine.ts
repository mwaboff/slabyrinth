/**
 * ConversationEngine (architecture §3.2): the provider-neutral streaming turn loop.
 *
 * It talks to providers only through ChatProvider (provider/types.ts) and to the project only through the WP5
 * EngineHost port (main/ports/engine.ts). Nothing here assumes Anthropic: effort mechanics, caching, thinking and
 * beta features are the adapter's business; the engine only appends neutral items (append-only transcript) and
 * asks the provider what a switch costs (`describeSwitch`).
 */
import { randomUUID } from "node:crypto";
import {
  CONTINUE_TEXT,
  PROGRESS_LABELS,
  RETRY_HINT_MAX_TOKENS,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_VERSION,
  TOOLS_VERSION,
  briefHash,
  createProgressTracker,
  createToolExecutor,
  defaultExecutorPorts,
  sessionStartText,
  systemPromptFor,
  toolsForConversation,
  type AgentExecuteTool,
  type AgentToolContext,
  type AskQuestionsAnswer,
  type ExecutorPorts,
  type ProgressTracker,
  type ToolOutcome,
  type UpdateBriefInput,
  checkPlan,
  outstandingIssues,
} from "@slabyrinth/core/agent";
import type { DesignBrief, MapPlan, ValidationResult } from "@slabyrinth/core/contracts/plan";
import { describeChanges } from "@slabyrinth/core/history";
import { resolvePlan } from "@slabyrinth/core/resolve";
import { outlineView } from "@slabyrinth/core/text";
import type { AppError, ChatEvent, IpcRequests } from "../../shared/ipc";
import type { ChatMessageMeta, Conversation, ProjectFile } from "../../shared/project";
import { redactString } from "../logger";
import { EnginePortError, type ConversationEngine, type EngineHost } from "../ports/engine";
import { ZERO_USAGE, addCost, addUsage, costOf, promptTokens, ratesFor } from "./cost";
import { errorInfo, isRetryableKind } from "./provider/errors";
import { createDefaultRegistry } from "./provider/registry";
import type {
  AssistantPart,
  ChatItem,
  ChatProvider,
  Cost,
  EffortLevel,
  ModelDescriptor,
  ModelSelection,
  ProviderErrorInfo,
  ProviderId,
  ProviderInfo,
  ProviderRegistry,
  StepEvent,
  StepRequest,
  StepResult,
  SwitchImpact,
  Usage,
} from "./provider/types";

type AssistantItem = Extract<ChatItem, { type: "assistant" }>;
type ToolResultsItem = Extract<ChatItem, { type: "tool_results" }>;

/** The turn's final event; `outstandingIssues` (shared/ipc.ts) is set by the engine guard. */
export type TurnEndEvent = Extract<ChatEvent, { type: "turn_finished" | "turn_failed" }>;

export const MAX_STEPS_PER_TURN = 24;
export const MAX_PAUSES = 5;
export const DEFAULT_MAX_OUTPUT = 64_000;
export const RETRY_MAX_OUTPUT = 128_000;
export const BUSY_BACKOFF_MS = [4_000, 12_000, 30_000] as const;
export const MODEL_CACHE_MS = 24 * 60 * 60 * 1000;

export interface EngineOptions {
  registry?: ProviderRegistry;
  executor?: AgentExecuteTool;
  executorPorts?: ExecutorPorts;
  newId?: () => string;
  now?: () => Date;
  /** Abortable sleep (tests pass a fast one). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random32?: () => number;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** Snaps an effort to what the model offers (UX §5.8: unavailable → the model's default). */
export function snapEffort(effort: EffortLevel | null, d: ModelDescriptor | undefined): EffortLevel | null {
  if (!d || !d.effort.supported) return null;
  if (effort !== null && d.effort.levels.includes(effort)) return effort;
  return d.effort.default;
}

const EFFORT_ORDER: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
export function capEffort(effort: EffortLevel | null, cap: EffortLevel): EffortLevel | null {
  if (effort === null) return null;
  return EFFORT_ORDER.indexOf(effort) > EFFORT_ORDER.indexOf(cap) ? cap : effort;
}

/** The effort last put into effect for `modelId` by a marker in the transcript (null = none yet). */
export function lastMarkerEffort(
  items: readonly ChatItem[],
  modelId: string,
): EffortLevel | null | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.type === "marker" && it.selection.modelId === modelId) return it.selection.effort;
  }
  return undefined;
}

/** Tool calls of an assistant item. */
function toolCalls(item: AssistantItem): Array<Extract<AssistantPart, { type: "tool_call" }>> {
  return item.parts.filter((p): p is Extract<AssistantPart, { type: "tool_call" }> => p.type === "tool_call");
}

const roundCostLadder = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
const roundSecondsLadder = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600];
function roundUp(v: number, ladder: readonly number[]): number {
  return ladder.find((x) => v <= x) ?? Math.ceil(v);
}

/** Expected output tokens per step by intent and effort (built-in table, used until the user has history). */
const OUTPUT_TABLE: Record<"chat" | "plan", Record<EffortLevel, number>> = {
  chat: { low: 400, medium: 800, high: 1500, xhigh: 2500, max: 4000 },
  plan: { low: 6000, medium: 10000, high: 16000, xhigh: 24000, max: 32000 },
};
const STEPS_TABLE = { chat: 1, plan: 3 } as const;
const TOKENS_PER_SECOND: Record<1 | 2 | 3, number> = { 1: 40, 2: 70, 3: 120 };

interface RunningTurn {
  turnId: string;
  abort: AbortController;
  done: Promise<void>;
}

interface TurnState {
  turnId: string;
  conversationId: string;
  selection: ModelSelection;
  effort: EffortLevel | null;
  provider: ChatProvider;
  descriptor: ModelDescriptor | undefined;
  started: number;
  usage: Usage;
  cost: Cost | null;
  versions: number[];
  /** Earlier attempts carried over by Retry (UX §5.6). */
  alternatives?: ChatMessageMeta["alternatives"];
  lastAssistantId: string | null;
}

/** The turn loop's counters: steps run, pauses taken, the output limit (raised once) and busy retries in a row. */
interface TurnLoop {
  steps: number;
  pauses: number;
  maxOutput: number;
  maxTokensRetried: boolean;
  busyRetries: number;
}

/** What a turn does after a step: run another step, or stop (the turn has finished, failed or been cancelled). */
type StepNext = "continue" | "stop";

/** A step's event sink: forwards the provider's stream as chat events and keeps what it streamed and spent. */
interface StepSink {
  onEvent: (e: StepEvent) => void;
  streamed: () => string;
  trackers: Map<string, ProgressTracker>;
  spent: () => Usage;
}

export class SlabyrinthConversationEngine implements ConversationEngine {
  private readonly registry: ProviderRegistry;
  private readonly execute: AgentExecuteTool;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random32: () => number;
  /** Plan validation against the build's palettes (the engine guard's outstanding issues). */
  private readonly validate: (p: unknown) => ValidationResult;
  private running: RunningTurn | null = null;
  /** Synchronous lock held while a turn is being set up (between the entry call and startTurn). */
  private starting = false;
  private readonly models = new Map<ProviderId, { at: number; list: ModelDescriptor[] }>();
  /** Time of the last request per conversation (cache warmth for estimates). */
  private readonly lastRequestAt = new Map<string, number>();
  private pendingAlternatives: {
    conversationId: string;
    alternatives: NonNullable<ChatMessageMeta["alternatives"]>;
  } | null = null;

  constructor(
    private readonly host: EngineHost,
    opts: EngineOptions = {},
  ) {
    this.registry =
      opts.registry ??
      createDefaultRegistry({
        log: (m, d) => {
          host.logger.debug(m, d);
        },
      });
    this.execute = opts.executor ?? createToolExecutor(opts.executorPorts);
    const vp = opts.executorPorts?.validatePlan ?? defaultExecutorPorts.validatePlan;
    this.validate = (p) => vp(p, { palettes: host.getBuildPalettes() });
    this.newId = opts.newId ?? randomUUID;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? defaultSleep;
    this.random32 = opts.random32 ?? (() => Math.floor(Math.random() * 0xffffffff));
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private project(): Readonly<ProjectFile> {
    const p = this.host.getProject();
    if (!p) throw new EnginePortError({ code: "no_project", message: "No map is open." });
    return p;
  }

  private conversation(): Readonly<Conversation> {
    const p = this.project();
    const c = p.conversations.find((x) => x.id === p.activeConversationId);
    if (!c) throw new EnginePortError({ code: "internal", message: "No active conversation." });
    return c;
  }

  private provider(id: ProviderId): ChatProvider {
    const p = this.registry.get(id);
    if (!p)
      throw new EnginePortError({
        code: "unsupported",
        message: `The provider "${id}" isn't available in this version.`,
      });
    return p;
  }

  private async configured(id: ProviderId): Promise<ChatProvider> {
    const provider = this.provider(id);
    const key = await this.host.getApiKey(id);
    if (provider.info.needsKey && (key === null || key.length === 0)) {
      throw new EnginePortError({ code: "no_api_key", message: "Add your Anthropic API key to start." });
    }
    const ps = this.host.getSettings().providers[id];
    const cfg: Parameters<ChatProvider["configure"]>[0] = {};
    if (key !== null) cfg.apiKey = key;
    if (ps?.baseUrl !== undefined) cfg.baseUrl = ps.baseUrl;
    if (ps?.options !== undefined) cfg.options = ps.options;
    provider.configure(cfg);
    return provider;
  }

  private cachedDescriptor(sel: Pick<ModelSelection, "providerId" | "modelId">): ModelDescriptor | undefined {
    return this.models.get(sel.providerId)?.list.find((d) => d.modelId === sel.modelId);
  }

  private async descriptor(
    sel: ModelSelection,
    provider: ChatProvider,
  ): Promise<ModelDescriptor | undefined> {
    const cached = this.cachedDescriptor(sel);
    if (cached) return cached;
    const list = await provider.listModels(new AbortController().signal);
    this.models.set(sel.providerId, { at: Date.now(), list });
    return list.find((d) => d.modelId === sel.modelId);
  }

  private emit(e: ChatEvent): void {
    this.host.emit(e);
  }

  private append(
    conversationId: string,
    turnId: string,
    items: ChatItem[],
    meta?: Record<string, ChatMessageMeta>,
  ): void {
    if (items.length === 0) return;
    this.host.appendItems(conversationId, items, meta);
    for (const item of items) this.emit({ type: "item_appended", turnId, item });
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private nextVersionNumber(): number {
    const versions = this.project().history.versions;
    return versions.reduce((m, v) => Math.max(m, v.number), 0) + 1;
  }

  private systemPrompt(conv: Readonly<Conversation>): string {
    const sp = systemPromptFor(conv.systemPromptVersion);
    if (sp === null) {
      this.host.logger.warn("unknown system prompt version; using the current one", {
        version: conv.systemPromptVersion,
      });
      return SYSTEM_PROMPT;
    }
    return sp;
  }

  /** User items carry image blob hashes; the provider needs the bytes. */
  private hydrate(items: readonly ChatItem[]): ChatItem[] {
    const blobs = this.project().blobs;
    return items.map((it) => {
      if (it.type !== "user" || !it.images || it.images.every((i) => i.dataBase64 !== undefined)) return it;
      return {
        ...it,
        images: it.images.map((img) => {
          const b = img.blobHash !== undefined ? blobs[img.blobHash] : undefined;
          return b ? { ...img, dataBase64: b.dataBase64 } : img;
        }),
      };
    });
  }

  private themes(): Array<{ id: string; name: string; description?: string }> {
    return this.host
      .getPalettes()
      .map((p) =>
        p.description !== undefined
          ? { id: p.id, name: p.name, description: p.description }
          : { id: p.id, name: p.name },
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private featureCoverage(theme: string): Record<string, boolean> {
    const palettes = this.host.getPalettes();
    const out: Record<string, boolean> = {};
    const seen = new Set<string>();
    let cur = palettes.find((p) => p.id === theme);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      for (const role of Object.keys(cur.roles))
        if (role.startsWith("feature.")) out[role.slice("feature.".length)] = true;
      const parent = cur.extends;
      cur =
        parent !== undefined
          ? palettes.find((p) => p.id === parent)
          : palettes.find((p) => p.id === "generic" && !seen.has("generic"));
    }
    return out;
  }

  private outline(plan: MapPlan, version: number, levels?: string[]): string {
    try {
      return outlineView(
        plan,
        resolvePlan(plan, this.host.getBuildPalettes(), { planVersion: version }),
        levels ? { version, levels } : { version },
      );
    } catch {
      return outlineView(plan, null, levels ? { version, levels } : { version });
    }
  }

  // ───────────────────────────── ConversationEngine ─────────────────────────────

  conversationDefaults(selection: ModelSelection): ReturnType<ConversationEngine["conversationDefaults"]> {
    const d = this.cachedDescriptor(selection);
    return {
      systemPromptVersion: SYSTEM_PROMPT_VERSION,
      toolsVersion: TOOLS_VERSION,
      imageToolEnabled: d?.imageInput ?? true,
      toolMode: d?.toolCalling ?? "native",
    };
  }

  async send(req: IpcRequests["chat:send"]["req"]): Promise<{ turnId: string }> {
    return this.exclusive(() => this.sendUnlocked(req));
  }

  private async sendUnlocked(req: IpcRequests["chat:send"]["req"]): Promise<{ turnId: string }> {
    const conv = this.conversation();
    if (conv.archived)
      throw new EnginePortError({
        code: "validation",
        message: "This conversation is read-only. Start a new one.",
      });
    const provider = await this.configured(conv.selection.providerId);
    const descriptor = await this.descriptor(conv.selection, provider);
    if (descriptor?.status === "unavailable") {
      throw new EnginePortError({
        code: "provider",
        message: `${descriptor.displayName} is no longer available on your key. Pick another model to continue; your project is unchanged.`,
      });
    }
    const turnId = this.newId();
    const now = this.nowIso();
    const items: ChatItem[] = [];

    // 1. Answers to a pending ask_questions call become its tool_result (also when the GM just typed instead).
    if (conv.pendingQuestions) {
      const answer: AskQuestionsAnswer = {
        answers:
          req.answers && req.answers.callId === conv.pendingQuestions.callId
            ? req.answers.answers.map((a) => ({ id: a.id, answer: a.answer }))
            : [],
      };
      if (req.text.trim().length > 0) answer.note = req.text;
      items.push({
        type: "tool_results",
        id: this.newId(),
        turnId,
        results: [
          {
            callId: conv.pendingQuestions.callId,
            name: "ask_questions",
            isError: false,
            content: [{ type: "text", text: JSON.stringify(answer) }],
          },
        ],
        createdAt: now,
      });
    }
    const user: Extract<ChatItem, { type: "user" }> = {
      type: "user",
      id: this.newId(),
      text: req.text,
      createdAt: now,
    };
    if (req.selection) user.selection = req.selection;
    const blobs = this.project().blobs;
    if (req.imageBlobs && req.imageBlobs.length > 0) {
      user.images = req.imageBlobs
        .filter((h) => blobs[h] !== undefined)
        .map((h) => ({
          mediaType: (blobs[h]?.mediaType ?? "image/png") as "image/png" | "image/jpeg" | "image/webp",
          blobHash: h,
        }));
    }
    items.push(user);
    // 2. What changed since the model last looked.
    items.push(...this.contextItems(conv, now));
    // 3. Effort for this turn (Smart effort, §3.8) and its marker.
    const intent = this.intentOf(req.intent ?? "auto");
    const { effort, marker } = this.turnEffort(conv, provider, descriptor, intent, now);
    if (marker) items.push(marker);

    this.host.updateConversation(conv.id, (c) => {
      delete c.pendingQuestions;
      c.modelSeen = { head: this.project().history.head, briefHash: briefHash(this.project().brief) };
    });
    return this.startTurn({
      turnId,
      conversationId: conv.id,
      selection: conv.selection,
      effort,
      provider,
      descriptor,
      initialItems: items,
      intent,
    });
  }

  private intentOf(intent: "chat" | "plan" | "auto"): "chat" | "plan" {
    if (intent !== "auto") return intent;
    return this.project().history.head > 0 ? "plan" : "chat";
  }

  /** Effort for a turn, and the marker to append when it differs from what is in effect. */
  private turnEffort(
    conv: Readonly<Conversation>,
    provider: ChatProvider,
    d: ModelDescriptor | undefined,
    intent: "chat" | "plan",
    now: string,
    selection: ModelSelection = conv.selection,
  ): { effort: EffortLevel | null; marker: ChatItem | null } {
    let effort = snapEffort(selection.effort, d);
    if (effort === null || !d?.effort.supported) return { effort, marker: null };
    // Smart effort only where an effort change keeps the cache (per-message effort); otherwise it costs more than it saves.
    const cheapSwitch = !provider.describeSwitch(
      selection,
      { ...selection, effort: effort === "low" ? "medium" : "low" },
      0,
    ).cacheReset;
    if (cheapSwitch && intent === "chat" && this.host.getSettings().smartEffort)
      effort = capEffort(effort, "medium");
    const inEffect = lastMarkerEffort(conv.items, selection.modelId) ?? d.effort.default;
    if (effort === inEffect) return { effort, marker: null };
    return {
      effort,
      marker: {
        type: "marker",
        id: this.newId(),
        kind: "selection_changed",
        selection: { ...selection, effort },
        createdAt: now,
      },
    };
  }

  private contextItems(conv: Readonly<Conversation>, now: string): ChatItem[] {
    const project = this.project();
    const head = project.history.head;
    const plan = this.host.getPlan();
    const out: ChatItem[] = [];
    const activeItems = conv.items.filter((i) => i.type !== "marker");
    if (activeItems.length === 0) {
      out.push({
        type: "context",
        id: this.newId(),
        reason: "session_start",
        text: sessionStartText({
          themes: this.themes(),
          builtInAssetsOnly: this.host.getAssetCatalog() === null,
          scannedAt: this.host.getSettings().talespire.lastScanAt,
          brief: project.brief,
          plan,
          head,
          ...(plan ? { outline: this.outline(plan, head) } : {}),
        }),
        createdAt: now,
      });
      return out;
    }
    if (conv.modelSeen.head !== head && plan) {
      const before = conv.modelSeen.head > 0 ? this.host.getPlan(conv.modelSeen.head) : null;
      const desc = describeChanges(before, plan, "user");
      const lead =
        head < conv.modelSeen.head
          ? `The GM went back from v${conv.modelSeen.head}; the current plan is v${head}.`
          : `The plan changed outside this conversation: it is now v${head} (you last saw v${conv.modelSeen.head}).`;
      out.push({
        type: "context",
        id: this.newId(),
        reason: "plan_changed",
        text: [lead, `${desc.summary}.`, ...desc.bullets.map((b) => `- ${b}`), this.outline(plan, head)].join(
          "\n",
        ),
        createdAt: now,
      });
    } else if (conv.modelSeen.head !== head && !plan) {
      out.push({
        type: "context",
        id: this.newId(),
        reason: "plan_changed",
        text: "The GM undid the first draft; there is no plan now.",
        createdAt: now,
      });
    }
    if (conv.modelSeen.briefHash !== briefHash(project.brief)) {
      out.push({
        type: "context",
        id: this.newId(),
        reason: "brief_changed",
        text: `The GM edited the brief. Current brief: ${sessionStartText({ themes: [], builtInAssetsOnly: false, scannedAt: null, brief: project.brief, plan: null, head: 0 }).split("\n")[2] ?? ""}`,
        createdAt: now,
      });
    }
    return out;
  }

  private startTurn(args: {
    turnId: string;
    conversationId: string;
    selection: ModelSelection;
    effort: EffortLevel | null;
    provider: ChatProvider;
    descriptor: ModelDescriptor | undefined;
    initialItems: ChatItem[];
    intent: "chat" | "plan";
  }): Promise<{ turnId: string }> {
    const abort = new AbortController();
    this.host.setBusy({ turnId: args.turnId });
    this.emit({ type: "turn_started", turnId: args.turnId, selection: args.selection });
    this.append(args.conversationId, args.turnId, args.initialItems);
    if (args.intent === "plan")
      this.emit({
        type: "progress",
        turnId: args.turnId,
        step: "reading_brief",
        label: PROGRESS_LABELS.reading_brief,
      });
    const state: TurnState = {
      turnId: args.turnId,
      conversationId: args.conversationId,
      selection: args.selection,
      effort: args.effort,
      provider: args.provider,
      descriptor: args.descriptor,
      started: Date.now(),
      usage: ZERO_USAGE,
      cost: null,
      versions: [],
      lastAssistantId: null,
    };
    if (this.pendingAlternatives?.conversationId === args.conversationId) {
      state.alternatives = this.pendingAlternatives.alternatives;
      this.pendingAlternatives = null;
    }
    const done = this.runTurn(state, abort.signal)
      .catch((err: unknown) => {
        this.host.logger.error("turn crashed", { message: err instanceof Error ? err.message : String(err) });
        this.emit({
          type: "turn_failed",
          turnId: args.turnId,
          error: { code: "internal", message: "Something went wrong while writing the reply." },
          canRetry: true,
        });
      })
      .finally(() => {
        this.running = null;
        this.host.setBusy(null);
        void this.host.flush();
      });
    this.running = { turnId: args.turnId, abort, done };
    return Promise.resolve({ turnId: args.turnId });
  }

  // ───────────────────────────── the turn loop ─────────────────────────────

  /**
   * The turn loop: build the step's request, run it, then act on how it stopped, until the turn finishes, fails or is
   * cancelled. A failed step may be retried after a back-off (busy, network); a cut-off tool call once with more room.
   */
  private async runTurn(t: TurnState, signal: AbortSignal): Promise<void> {
    const loop: TurnLoop = {
      steps: 0,
      pauses: 0,
      maxOutput: DEFAULT_MAX_OUTPUT,
      maxTokensRetried: false,
      busyRetries: 0,
    };
    for (;;) {
      if (loop.steps >= MAX_STEPS_PER_TURN) {
        this.emit({
          type: "notice",
          turnId: t.turnId,
          kind: "truncated",
          text: "Stopped after many steps in one turn. Send a message to continue.",
        });
        this.finish(t, "end_turn", false);
        return;
      }
      const request = this.stepRequest(t, loop.maxOutput);
      const sink = this.stepSink(t, loop.steps);
      let result: StepResult;
      try {
        this.lastRequestAt.set(t.conversationId, Date.now());
        result = await t.provider.runStep(request, sink.onEvent, signal);
      } catch (err) {
        if ((await this.stepFailed(t, err, sink, signal, loop)) === "stop") return;
        continue;
      }
      loop.steps++;
      loop.busyRetries = 0;
      this.account(t, result.usage, result.cost);
      if ((await this.afterStep(t, result, sink, signal, loop)) === "stop") return;
    }
  }

  /** The next step's request: the conversation as it stands, its prompt and tools, at the loop's output limit. */
  private stepRequest(t: TurnState, maxOutput: number): StepRequest {
    const c = this.project().conversations.find((x) => x.id === t.conversationId);
    if (!c) throw new Error("conversation vanished");
    return {
      conversationId: c.id,
      turnId: t.turnId,
      selection: t.selection,
      systemPrompt: this.systemPrompt(c),
      tools: c.toolMode === "none" ? [] : toolsForConversation(c.imageToolEnabled, c.toolsVersion),
      transcript: this.hydrate(c.items),
      maxOutputTokens: maxOutput,
      effort: t.effort,
      toolMode: c.toolMode,
    };
  }

  /**
   * A step that threw: what it streamed is billed (an estimate; the final usage never arrived), then the turn is
   * cancelled, retried after a back-off (busy or connection errors, up to BUSY_BACKOFF_MS.length times in a row) or
   * failed.
   */
  private async stepFailed(
    t: TurnState,
    err: unknown,
    sink: StepSink,
    signal: AbortSignal,
    loop: TurnLoop,
  ): Promise<StepNext> {
    const spent = sink.spent();
    if (promptTokens(spent) + spent.outputTokens > 0)
      this.account(t, spent, costOf(spent, t.descriptor?.pricing ?? null));
    const info = errorInfo(err);
    if (signal.aborted || info?.kind === "cancelled") {
      this.cancelled(t, sink.streamed());
      return "stop";
    }
    if (info && isRetryableKind(info.kind) && loop.busyRetries < BUSY_BACKOFF_MS.length) {
      const delay = info.retryAfterMs ?? BUSY_BACKOFF_MS[loop.busyRetries] ?? 30_000;
      loop.busyRetries++;
      const what =
        info.kind === "network" || info.kind === "timeout" ? "Connection lost" : "Anthropic is busy";
      this.emit({
        type: "notice",
        turnId: t.turnId,
        kind: "retrying",
        text: `${what} — retrying in ${Math.round(delay / 1000)}s.`,
      });
      try {
        await this.sleep(delay, signal);
      } catch {
        this.cancelled(t, "");
        return "stop";
      }
      return "continue";
    }
    this.failed(
      t,
      info ?? {
        kind: "server",
        retryable: false,
        message: err instanceof Error ? redactString(err.message) : "Unknown error.",
      },
      loop.busyRetries > 0,
    );
    return "stop";
  }

  /** Acts on how a step stopped: finish, pause and go on, refuse, handle the output limit, or run the tools. */
  private async afterStep(
    t: TurnState,
    result: StepResult,
    sink: StepSink,
    signal: AbortSignal,
    loop: TurnLoop,
  ): Promise<StepNext> {
    if (result.stopReason === "cancelled") {
      this.cancelled(t, sink.streamed());
      return "stop";
    }
    const assistant = result.assistant;
    switch (result.stopReason) {
      case "end_turn":
      case "error": {
        if (assistant) this.appendAssistant(t, assistant, "complete");
        this.finish(t, "end_turn", false);
        return "stop";
      }
      case "pause": {
        if (assistant) this.appendAssistant(t, assistant, "complete");
        if (++loop.pauses > MAX_PAUSES) {
          this.finish(t, "pause", true);
          return "stop";
        }
        return "continue";
      }
      case "refusal": {
        if (assistant) this.appendAssistant(t, { ...assistant, excludedFromContext: true }, "refused");
        this.emit({
          type: "notice",
          turnId: t.turnId,
          kind: "refusal",
          text: "The request was declined. The plan wasn't changed.",
        });
        this.finish(t, "refusal", false);
        return "stop";
      }
      case "max_tokens":
        return this.outputLimitReached(t, assistant, loop);
      case "tool_use": {
        if (!assistant) {
          this.finish(t, "end_turn", false);
          return "stop";
        }
        const outcome = await this.runTools(t, assistant, sink, signal);
        if (outcome === "await_user") {
          this.finish(t, "tool_use", false);
          return "stop";
        }
        if (signal.aborted) {
          this.cancelled(t, "");
          return "stop";
        }
        return "continue";
      }
    }
  }

  /**
   * The step hit the output limit. A tool input cut off by it is never executed: the step is discarded and retried
   * once with more room (then the turn fails). Plain text is kept as truncated, for Continue.
   */
  private outputLimitReached(t: TurnState, assistant: AssistantItem | undefined, loop: TurnLoop): StepNext {
    if (assistant && toolCalls(assistant).length > 0) {
      if (!loop.maxTokensRetried) {
        loop.maxTokensRetried = true;
        loop.maxOutput = RETRY_MAX_OUTPUT;
        this.append(t.conversationId, t.turnId, [
          {
            type: "context",
            id: this.newId(),
            reason: "retry_hint",
            text: RETRY_HINT_MAX_TOKENS,
            createdAt: this.nowIso(),
          },
        ]);
        this.emit({
          type: "notice",
          turnId: t.turnId,
          kind: "retrying",
          text: "The plan came back incomplete; trying again in smaller pieces.",
        });
        return "continue";
      }
      this.failed(
        t,
        {
          kind: "malformed_output",
          retryable: false,
          message: `That plan came back incomplete, so I didn't apply it. Your map is still v${this.project().history.head}. Very large maps cause this — try again, or ask for one level at a time.`,
        },
        false,
      );
      return "stop";
    }
    if (assistant) this.appendAssistant(t, assistant, "truncated");
    this.emit({
      type: "notice",
      turnId: t.turnId,
      kind: "truncated",
      text: "The reply was cut off. Press Continue for the rest.",
    });
    this.finish(t, "max_tokens", false, true);
    return "stop";
  }

  private stepSink(t: TurnState, step: number): StepSink {
    let text = "";
    let spent: Usage = ZERO_USAGE;
    const trackers = new Map<string, ProgressTracker>();
    const bytes = new Map<string, number>();
    const onEvent = (e: StepEvent): void => {
      switch (e.type) {
        case "started":
          text = "";
          this.emit({ type: "step_started", turnId: t.turnId, step, servedBy: e.servedBy });
          break;
        case "text_delta":
          text += e.text;
          this.emit({ type: "text_delta", turnId: t.turnId, step, text: e.text });
          break;
        case "reasoning_delta":
          this.emit({ type: "reasoning_delta", turnId: t.turnId, step, text: e.text });
          break;
        case "tool_call_start": {
          this.emit({ type: "tool_call_started", turnId: t.turnId, step, callId: e.callId, name: e.name });
          const tracker = createProgressTracker(e.name);
          if (tracker) trackers.set(e.callId, tracker);
          break;
        }
        case "tool_call_delta": {
          const n = (bytes.get(e.callId) ?? 0) + e.partialJson.length;
          bytes.set(e.callId, n);
          this.emit({ type: "tool_call_progress", turnId: t.turnId, callId: e.callId, bytes: n });
          for (const p of trackers.get(e.callId)?.push(e.partialJson) ?? [])
            this.emit({ type: "progress", turnId: t.turnId, step: p.step, label: p.label });
          break;
        }
        case "tool_call_end":
          for (const p of trackers.get(e.callId)?.finish() ?? [])
            this.emit({ type: "progress", turnId: t.turnId, step: p.step, label: p.label });
          break;
        case "notice":
          this.emit({ type: "notice", turnId: t.turnId, kind: e.kind, text: e.text });
          break;
        case "usage":
          // Only counted if the step fails: a successful result carries the full usage itself.
          spent = addUsage(spent, e.usage);
          break;
      }
    };
    return { onEvent, streamed: () => text, trackers, spent: () => spent };
  }

  private account(t: TurnState, usage: Usage, cost: Cost | null): void {
    t.usage = addUsage(t.usage, usage);
    t.cost = addCost(t.cost, cost);
    let totals: { usage: Usage; cost: Cost | null } = { usage: ZERO_USAGE, cost: null };
    this.host.updateConversation(t.conversationId, (c) => {
      c.totals.usage = addUsage(c.totals.usage, usage);
      c.totals.cost = addCost(c.totals.cost, cost);
      totals = { usage: c.totals.usage, cost: c.totals.cost };
    });
    this.host.addSpend(usage, cost);
    this.emit({ type: "usage", turnId: t.turnId, usage, cost, totals });
  }

  private meta(
    t: TurnState,
    item: AssistantItem,
    status: ChatMessageMeta["status"],
    errorCode?: string,
  ): ChatMessageMeta {
    const m: ChatMessageMeta = {
      selection: t.selection,
      servedBy: item.servedBy,
      effortUsed: t.effort,
      durationMs: Date.now() - t.started,
      usage: item.usage ?? ZERO_USAGE,
      cost: t.cost,
      status,
      versions: [...t.versions],
    };
    if (errorCode !== undefined) m.errorCode = errorCode;
    if (t.alternatives) {
      m.alternatives = t.alternatives;
      m.activeAlternative = t.alternatives.length;
    }
    return m;
  }

  private appendAssistant(
    t: TurnState,
    item: AssistantItem,
    status: ChatMessageMeta["status"],
    extra: ChatItem[] = [],
  ): void {
    t.lastAssistantId = item.id;
    this.append(t.conversationId, t.turnId, [item, ...extra], { [item.id]: this.meta(t, item, status) });
  }

  private toolContext(t: TurnState, signal: AbortSignal): AgentToolContext {
    const project = this.project();
    const conv = project.conversations.find((c) => c.id === t.conversationId);
    const head = project.history.head;
    const imageOk = (conv?.imageToolEnabled ?? false) && (t.descriptor?.imageInput ?? false);
    return {
      plan: this.host.getPlan(),
      head,
      brief: project.brief,
      renderImage: imageOk
        ? async (level, region, showIds) => {
            const req: Parameters<EngineHost["requestImage"]>[0] = {
              level,
              showIds: showIds ?? true,
              planVersion: head,
              maxPx: 1024,
            };
            if (region) req.region = region;
            const b64 = await this.host.requestImage(req, signal);
            return new Uint8Array(Buffer.from(b64, "base64"));
          }
        : null,
      estimate: (plan, levels) => this.host.estimateCompile(plan, levels),
      catalog: { themes: this.themes(), featureCoverage: (theme) => this.featureCoverage(theme) },
      newSeed: () => this.random32() >>> 0,
      newPlanId: () => randomUUID(),
      palettes: this.host.getBuildPalettes(),
      nextVersion: this.nextVersionNumber(),
      planAt: (v) => this.host.getPlan(v),
    };
  }

  /** Runs every tool call of a step in order; appends the assistant item and ONE tool_results item. */
  private async runTools(
    t: TurnState,
    assistant: AssistantItem,
    _sink: { trackers: Map<string, ProgressTracker> },
    signal: AbortSignal,
  ): Promise<"continue" | "await_user"> {
    const results: ToolResultsItem["results"] = [];
    let awaitUser = false;
    let pending: { callId: string } | null = null;
    for (const call of toolCalls(assistant)) {
      if (signal.aborted) {
        results.push({
          callId: call.callId,
          name: call.name,
          isError: true,
          content: [{ type: "text", text: "Not run: the GM stopped the reply." }],
        });
        continue;
      }
      if (call.name === "ask_questions" && pending !== null) {
        // One question card at a time: a second ask_questions in the same step is answered at once.
        results.push({
          callId: call.callId,
          name: call.name,
          isError: true,
          content: [
            {
              type: "text",
              text: "Not shown: only one question card at a time. Ask everything in one ask_questions call; the GM is answering the first card.",
            },
          ],
        });
        this.emit({
          type: "tool_call_finished",
          turnId: t.turnId,
          callId: call.callId,
          name: call.name,
          ok: false,
          summary: "rejected",
        });
        continue;
      }
      if (call.name === "create_plan" || call.name === "edit_plan") {
        this.emit({ type: "progress", turnId: t.turnId, step: "checking", label: PROGRESS_LABELS.checking });
      }
      let outcome: ToolOutcome;
      try {
        outcome = await this.execute(this.toolContext(t, signal), call.name, call.input);
      } catch (err) {
        this.host.logger.warn("tool failed", {
          tool: call.name,
          message: err instanceof Error ? err.message : String(err),
        });
        outcome = {
          ok: false,
          content: [
            {
              type: "text",
              text: `${call.name} failed inside the app: nothing was changed. Try again or continue without it.`,
            },
          ],
          errors: [{ code: "unavailable", message: "tool failed" }],
        };
      }
      let summary = outcome.ok ? "done" : "rejected";
      let newVersion: number | undefined;
      if (outcome.ok && outcome.newPlan) {
        const np = outcome.newPlan;
        const commit = this.host.commitVersion({
          plan: np.plan,
          author: "ai",
          summary: np.summary,
          changeSummary: np.changes,
          cause: np.cause === "create" ? { type: "create" } : { type: "ops", ops: np.ops ?? [] },
          messageId: assistant.id,
          cost: t.cost ? { currency: "USD", amount: t.cost.amount } : null,
          baseVersion: this.project().history.head,
        });
        newVersion = commit.version;
        t.versions.push(commit.version);
        summary = np.summary;
        this.host.updateConversation(t.conversationId, (c) => {
          c.modelSeen.head = commit.version;
        });
      }
      if (outcome.ok && outcome.newBrief) {
        const before = this.project().brief;
        const set = ((call.input as Partial<UpdateBriefInput> | null)?.set ?? {}) as Record<string, unknown>;
        const skipped = Object.keys(set).filter((k) => before[k as keyof DesignBrief]?.source === "user");
        this.host.setBrief(outcome.newBrief);
        const brief = outcome.newBrief;
        this.host.updateConversation(t.conversationId, (c) => {
          c.modelSeen.briefHash = briefHash(brief);
        });
        this.emit({ type: "brief_updated", turnId: t.turnId, brief, skipped });
        summary = "Brief updated";
      }
      if (outcome.ok && outcome.awaitUser === true) {
        awaitUser = true;
        pending = { callId: call.callId };
        const input = call.input as {
          questions?: Array<{ id: string; text: string; default: string; options: string[] }>;
        };
        this.emit({
          type: "questions",
          turnId: t.turnId,
          callId: call.callId,
          questions: input.questions ?? [],
        });
        summary = "Questions asked";
      } else {
        results.push({
          callId: call.callId,
          name: call.name,
          isError: !outcome.ok,
          content: outcome.content,
        });
      }
      const finished: Extract<ChatEvent, { type: "tool_call_finished" }> = {
        type: "tool_call_finished",
        turnId: t.turnId,
        callId: call.callId,
        name: call.name,
        ok: outcome.ok,
        summary,
      };
      if (newVersion !== undefined) finished.newVersion = newVersion;
      this.emit(finished);
    }
    const extra: ChatItem[] =
      results.length > 0
        ? [{ type: "tool_results", id: this.newId(), turnId: t.turnId, results, createdAt: this.nowIso() }]
        : [];
    this.appendAssistant(t, assistant, "complete", extra);
    if (pending) {
      const p = pending;
      this.host.updateConversation(t.conversationId, (c) => {
        c.pendingQuestions = { callId: p.callId, itemId: assistant.id };
      });
    }
    return awaitUser ? "await_user" : "continue";
  }

  private finish(
    t: TurnState,
    stopReason: Extract<ChatEvent, { type: "turn_finished" }>["stopReason"],
    _paused: boolean,
    canContinue = false,
  ): void {
    this.host.updateConversation(t.conversationId, (c) => {
      c.totals.turns += 1;
    });
    this.emit(
      this.withOutstanding(t, {
        type: "turn_finished",
        turnId: t.turnId,
        stopReason,
        canContinue,
        canRetry: true,
      }),
    );
  }

  /**
   * Engine guard (decisions.md "Playability validation"): when a turn changed the plan and error-level playability
   * issues remain, the turn's final event carries the outstanding-issue summary so the UI can show it, whatever the
   * model said. Read `outstandingIssues` on turn_finished / turn_failed (see TurnEndEvent).
   */
  private withOutstanding<E extends TurnEndEvent>(t: TurnState, event: E): E {
    if (t.versions.length === 0) return event;
    const plan = this.host.getPlan();
    if (!plan) return event;
    try {
      const checks = checkPlan(plan, this.validate);
      if (checks.errors.length === 0) return event;
      return { ...event, outstandingIssues: outstandingIssues(this.project().history.head, checks) };
    } catch (err) {
      this.host.logger.warn("playability check failed at turn end", {
        message: err instanceof Error ? err.message : String(err),
      });
      return event;
    }
  }

  private cancelled(t: TurnState, streamed: string): void {
    if (streamed.length > 0) {
      const item: AssistantItem = {
        type: "assistant",
        id: this.newId(),
        turnId: t.turnId,
        parts: [{ type: "text", text: streamed }],
        stopReason: "cancelled",
        servedBy: { providerId: t.selection.providerId, modelId: t.selection.modelId },
        excludedFromContext: true,
        createdAt: this.nowIso(),
      };
      this.appendAssistant(t, item, "stopped");
    }
    this.emit(
      this.withOutstanding(t, {
        type: "turn_finished",
        turnId: t.turnId,
        stopReason: "cancelled",
        canContinue: false,
        canRetry: true,
      }),
    );
  }

  private failed(t: TurnState, raw: ProviderErrorInfo, afterRetries: boolean): void {
    // Any provider's message may carry upstream text: mask key-shaped strings before it reaches the renderer.
    const info: ProviderErrorInfo = { ...raw, message: redactString(raw.message) };
    const message =
      afterRetries && (info.kind === "rate_limit" || info.kind === "overloaded")
        ? "Still busy. Try again in a minute, or switch model."
        : info.message;
    const error: AppError =
      info.kind === "auth"
        ? { code: "provider", message: "Your API key was rejected.", provider: info }
        : { code: "provider", message, provider: info };
    this.emit(this.withOutstanding(t, { type: "turn_failed", turnId: t.turnId, error, canRetry: true }));
  }

  // ───────────────────────────── other channels ─────────────────────────────

  async estimate(req: IpcRequests["chat:estimate"]["req"]): Promise<IpcRequests["chat:estimate"]["res"]> {
    const conv = this.conversation();
    const selection = req.selection ?? conv.selection;
    const d =
      this.cachedDescriptor(selection) ??
      (await this.descriptor(selection, this.provider(selection.providerId)).catch(() => undefined));
    const intent = this.intentOf(req.intent ?? "auto");
    const effort = snapEffort(selection.effort, d) ?? "medium";
    const assistants = conv.items.filter(
      (i): i is AssistantItem =>
        i.type === "assistant" && i.usage !== undefined && i.excludedFromContext !== true,
    );
    const lastUsage = assistants[assistants.length - 1]?.usage;
    const context =
      (lastUsage ? promptTokens(lastUsage) + lastUsage.outputTokens : 9000) + Math.ceil(req.text.length / 4);
    const sameModel = assistants
      .filter((a) => a.servedBy.modelId === selection.modelId)
      .map((a) => a.usage?.outputTokens ?? 0);
    const basis: "history" | "table" = sameModel.length >= 3 ? "history" : "table";
    const perStep = basis === "history" ? median(sameModel) : OUTPUT_TABLE[intent][effort];
    const steps = STEPS_TABLE[intent];
    const outTokens = perStep * steps;
    let costUsd: number | null = null;
    if (d?.pricing) {
      const r = ratesFor(d.pricing, context);
      const warm =
        Date.now() - (this.lastRequestAt.get(conv.id) ?? 0) < 5 * 60 * 1000 &&
        selection.modelId === conv.selection.modelId;
      const firstRead = (context * (warm ? r.cacheRead : r.write5m)) / 1e6;
      const laterReads = ((steps - 1) * context * r.cacheRead) / 1e6;
      costUsd = roundUp(firstRead + laterReads + (outTokens * r.output) / 1e6, roundCostLadder);
    }
    const tps = TOKENS_PER_SECOND[d?.speedTier ?? 2];
    const seconds = roundUp(outTokens / tps + 2 * steps, roundSecondsLadder);
    return { costUsd, seconds, basis };
  }

  /** Resolves when no turn is running (headless callers: tests, the eval harness). */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running.done;
  }

  async cancel(turnId: string): Promise<void> {
    if (this.running?.turnId !== turnId) return;
    this.running.abort.abort();
    await this.running.done;
  }

  /**
   * The last turn's response, as Retry sees it: everything after the turn's user item from the first response item
   * on (assistant, tool_results, and any context/marker appended mid-turn such as a retry hint), and the plan
   * versions those assistant items produced.
   */
  private lastTurn(conv: Readonly<Conversation>): {
    userIdx: number;
    cutStart: number;
    cut: ChatItem[];
    assistants: AssistantItem[];
    versions: number[];
  } | null {
    const userIdx = findLastIndex(conv.items, (i) => i.type === "user");
    if (userIdx < 0) return null;
    const rel = conv.items
      .slice(userIdx + 1)
      .findIndex((i) => i.type === "assistant" || i.type === "tool_results");
    const cutStart = rel < 0 ? conv.items.length : userIdx + 1 + rel;
    const cut = conv.items.slice(cutStart);
    const assistants = cut.filter((i): i is AssistantItem => i.type === "assistant");
    const ids = new Set(assistants.map((i) => i.id));
    const fromHistory = this.project()
      .history.versions.filter((v) => v.messageId !== undefined && ids.has(v.messageId))
      .map((v) => v.number);
    const fromMeta = assistants.flatMap((i) => conv.meta[i.id]?.versions ?? []);
    const versions = [...new Set([...fromHistory, ...fromMeta])].sort((x, y) => x - y);
    return { userIdx, cutStart, cut, assistants, versions };
  }

  /** null when Retry may run; otherwise the user-facing reason it may not. */
  private retryBlocker(conv: Readonly<Conversation>): string | null {
    const t = this.lastTurn(conv);
    if (!t) return "Nothing to retry.";
    if (t.versions.length === 0) return null;
    const last = t.versions[t.versions.length - 1];
    if (this.project().history.head !== last) {
      return "You changed the map after this reply. Undo your changes first, or ask for a change instead.";
    }
    return null;
  }

  async retry(req: IpcRequests["chat:retry"]["req"]): Promise<{ turnId: string }> {
    return this.exclusive(async () => {
      const conv = this.conversation();
      const turn = this.lastTurn(conv);
      if (!turn) throw new EnginePortError({ code: "validation", message: "Nothing to retry." });
      const blocker = this.retryBlocker(conv);
      if (blocker) throw new EnginePortError({ code: "validation", message: blocker });
      // Everything that can fail runs BEFORE the conversation or the plan is touched.
      const selection = req.selection ?? conv.selection;
      const provider = await this.configured(selection.providerId);
      const descriptor = await this.descriptor(selection, provider);
      const again = this.retryBlocker(this.conversation());
      if (again !== null) throw new EnginePortError({ code: "validation", message: again });
      let head = this.project().history.head;
      if (turn.versions.length > 0) {
        // Back to before the turn (0 = no plan): an undo, the turn's versions join `undone`, redo brings them back.
        const first = turn.versions[0] ?? 0;
        const before = this.project().history.versions.find((v) => v.number === first)?.parentNumber ?? 0;
        if (head !== before) head = this.host.moveHead(before).head;
      }
      const lastAssistant = turn.assistants[turn.assistants.length - 1];
      const oldMeta = lastAssistant ? conv.meta[lastAssistant.id] : undefined;
      const cutIds = new Set(turn.cut.map((i) => i.id));
      this.host.updateConversation(conv.id, (c) => {
        c.items.splice(turn.cutStart);
        delete c.pendingQuestions;
        c.meta = Object.fromEntries(Object.entries(c.meta).filter(([k]) => !cutIds.has(k)));
        c.modelSeen.head = head;
      });
      if (oldMeta) {
        const rest: Omit<ChatMessageMeta, "alternatives"> = { ...oldMeta };
        delete (rest as ChatMessageMeta).alternatives;
        delete rest.activeAlternative;
        this.pendingAlternatives = {
          conversationId: conv.id,
          alternatives: [...(oldMeta.alternatives ?? []), { items: turn.cut, meta: rest }],
        };
      }
      const fresh = this.conversation();
      const turnId = this.newId();
      const now = this.nowIso();
      const items: ChatItem[] = [...this.contextItems(fresh, now)];
      if (
        req.selection &&
        (req.selection.modelId !== fresh.selection.modelId || req.selection.effort !== fresh.selection.effort)
      ) {
        items.push({
          type: "marker",
          id: this.newId(),
          kind: "selection_changed",
          selection: { ...selection, effort: snapEffort(selection.effort, descriptor) },
          createdAt: now,
        });
      }
      const { effort, marker } = this.turnEffort(
        { ...fresh, items: [...fresh.items, ...items] },
        provider,
        descriptor,
        "plan",
        now,
        selection,
      );
      if (marker) items.push(marker);
      return this.startTurn({
        turnId,
        conversationId: fresh.id,
        selection,
        effort,
        provider,
        descriptor,
        initialItems: items,
        intent: "plan",
      });
    });
  }

  /**
   * Turn-starting entry points run one at a time: a synchronous lock is taken before the first await, so a second
   * concurrent caller gets `busy` instead of starting a second turn. Released on every path; once startTurn has
   * run, `running` holds the turn.
   */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running || this.starting) {
      throw new EnginePortError({ code: "busy", message: "A reply is still being written." });
    }
    this.starting = true;
    try {
      return await fn();
    } finally {
      this.starting = false;
    }
  }

  async continue(): Promise<{ turnId: string }> {
    return this.send({ text: CONTINUE_TEXT, intent: "chat" });
  }

  selectAlternative(req: IpcRequests["chat:selectAlternative"]["req"]): Promise<void> {
    const conv = this.conversation();
    this.host.updateConversation(conv.id, (c) => {
      const m = c.meta[req.messageId];
      if (m) m.activeAlternative = req.index;
    });
    return Promise.resolve();
  }

  async previewSwitch(selection: ModelSelection): Promise<SwitchImpact> {
    const conv = this.conversation();
    const provider = this.provider(selection.providerId);
    const d =
      this.cachedDescriptor(selection) ?? (await this.descriptor(selection, provider).catch(() => undefined));
    const snapped = { ...selection, effort: snapEffort(selection.effort, d) };
    const last = [...conv.items]
      .reverse()
      .find((i): i is AssistantItem => i.type === "assistant" && i.usage !== undefined);
    const tokens = last?.usage ? promptTokens(last.usage) + last.usage.outputTokens : 0;
    const impact = provider.describeSwitch(conv.selection, snapped, tokens);
    if (selection.effort !== null && snapped.effort !== selection.effort && d) {
      return {
        ...impact,
        messages: [
          ...impact.messages,
          `${d.displayName} doesn't offer that effort — using ${String(snapped.effort)}.`,
        ],
      };
    }
    return impact;
  }

  async setSelection(selection: ModelSelection): Promise<{ selection: ModelSelection }> {
    if (this.running || this.starting) {
      throw new EnginePortError({ code: "busy", message: "Wait for the reply to finish." });
    }
    const conv = this.conversation();
    const provider = this.provider(selection.providerId);
    const d =
      this.cachedDescriptor(selection) ?? (await this.descriptor(selection, provider).catch(() => undefined));
    const snapped: ModelSelection = { ...selection, effort: snapEffort(selection.effort, d) };
    if (
      snapped.providerId === conv.selection.providerId &&
      snapped.modelId === conv.selection.modelId &&
      snapped.effort === conv.selection.effort
    ) {
      return { selection: snapped };
    }
    const marker: ChatItem = {
      type: "marker",
      id: this.newId(),
      kind: "selection_changed",
      selection: snapped,
      createdAt: this.nowIso(),
    };
    this.host.updateConversation(conv.id, (c) => {
      c.selection = snapped;
      c.selectionLog.push({
        at: marker.createdAt,
        afterItemId: c.items[c.items.length - 1]?.id ?? null,
        selection: snapped,
      });
    });
    this.host.appendItems(conv.id, [marker]);
    return { selection: snapped };
  }

  async setEffort(effort: EffortLevel | null): Promise<{ selection: ModelSelection }> {
    return this.setSelection({ ...this.conversation().selection, effort });
  }

  listProviders(): Promise<Array<ProviderInfo & { enabled: boolean }>> {
    const settings = this.host.getSettings();
    return Promise.resolve(
      this.registry
        .list()
        .map((p) => ({ ...p.info, enabled: settings.providers[p.id]?.enabled ?? p.id === "anthropic" })),
    );
  }

  async checkProvider(
    providerId: ProviderId,
  ): Promise<{ ok: true } | { ok: false; error: ProviderErrorInfo }> {
    try {
      const p = await this.configured(providerId);
      const res = await p.checkConnection(AbortSignal.timeout(20_000));
      return res.ok ? res : { ok: false, error: { ...res.error, message: redactString(res.error.message) } };
    } catch (err) {
      if (err instanceof EnginePortError)
        return { ok: false, error: { kind: "auth", retryable: false, message: err.message } };
      const info = errorInfo(err);
      return {
        ok: false,
        error: info
          ? { ...info, message: redactString(info.message) }
          : { kind: "network", retryable: true, message: "Couldn't reach the provider." },
      };
    }
  }

  async listModels(providerId: ProviderId, refresh: boolean): Promise<ModelDescriptor[]> {
    const cached = this.models.get(providerId);
    if (cached && !refresh && Date.now() - cached.at < MODEL_CACHE_MS) return cached.list;
    const provider = this.provider(providerId);
    try {
      await this.configured(providerId);
    } catch {
      // No key yet: the provider falls back to its bundled table.
    }
    const list = await provider.listModels(AbortSignal.timeout(20_000));
    this.models.set(providerId, { at: Date.now(), list });
    return list;
  }

  async onProjectClosing(): Promise<void> {
    if (this.running) {
      this.running.abort.abort();
      await this.running.done.catch(() => undefined);
    }
    await this.host.flush();
  }

  /**
   * Resume bookkeeping: any tool call without a result (a turn interrupted mid-tools, a crash, an older bug) gets an
   * error result inserted DIRECTLY after its assistant item, so every request stays valid. The one exception is the
   * pending question card on the last assistant item, which the GM's next message answers.
   */
  onProjectOpened(): void {
    const p = this.host.getProject();
    if (!p) return;
    const conv = p.conversations.find((c) => c.id === p.activeConversationId);
    if (!conv) return;
    const repairs = danglingToolCalls(conv.items, conv.pendingQuestions);
    const stalePending =
      conv.pendingQuestions !== undefined &&
      repairs.some((r) => r.calls.some((c) => c.callId === conv.pendingQuestions?.callId));
    if (repairs.length === 0) return;
    const now = this.nowIso();
    this.host.updateConversation(conv.id, (c) => {
      // Insert from the back so earlier indices stay valid.
      for (const r of [...repairs].reverse()) {
        c.items.splice(r.index + 1, 0, {
          type: "tool_results",
          id: this.newId(),
          turnId: r.turnId,
          results: r.calls.map((call) => ({
            callId: call.callId,
            name: call.name,
            isError: true,
            content: [
              {
                type: "text",
                text: "Not run: the app closed before this call finished. Nothing was changed.",
              },
            ],
          })),
          createdAt: now,
        });
      }
      if (stalePending) delete c.pendingQuestions;
    });
  }

  async dispose(): Promise<void> {
    await this.onProjectClosing();
  }
}

/**
 * Tool calls with no result before the next model turn, per assistant item. The pending question card is exempt
 * only while it belongs to the LAST assistant item.
 */
export function danglingToolCalls(
  items: readonly ChatItem[],
  pending?: { callId: string; itemId: string },
): Array<{ index: number; turnId: string; calls: Array<Extract<AssistantPart, { type: "tool_call" }>> }> {
  const live = items
    .map((it, index) => ({ it, index }))
    .filter(
      (x): x is { it: AssistantItem; index: number } =>
        x.it.type === "assistant" && x.it.excludedFromContext !== true,
    );
  const out: ReturnType<typeof danglingToolCalls> = [];
  live.forEach(({ it, index }, k) => {
    const end = live[k + 1]?.index ?? items.length;
    const answered = new Set(
      items
        .slice(index + 1, end)
        .flatMap((i) => (i.type === "tool_results" ? i.results.map((r) => r.callId) : [])),
    );
    const isLast = k === live.length - 1;
    const calls = toolCalls(it).filter(
      (c) => !answered.has(c.callId) && !(isLast && pending?.callId === c.callId && pending.itemId === it.id),
    );
    if (calls.length > 0) out.push({ index, turnId: it.turnId, calls });
  });
  return out;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

function findLastIndex<T>(xs: readonly T[], pred: (x: T, i: number) => boolean, from = 0): number {
  for (let i = xs.length - 1; i >= from; i--) if (pred(xs[i] as T, i)) return i;
  return -1;
}
