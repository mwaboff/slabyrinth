/**
 * Pure reducer for "chat:event" streams (architecture §3.9, §6.3). Keeps the committed transcript plus one
 * live turn (stream buffers, tool calls, progress, questions, notices). Events for other turns are ignored
 * (the renderer must drop stale turns, §6.2).
 */
import type { AppError, ChatEvent, OutstandingIssues } from "../../shared/ipc";
import type { ChatItem, Cost, ModelSelection, Usage } from "../../main/agent/provider/types";

export type ProgressStep = Extract<ChatEvent, { type: "progress" }>["step"];
export type Question = Extract<ChatEvent, { type: "questions" }>["questions"][number];
/** How a turn ended: a provider stop reason, or the app's own revision limit. */
export type TurnStopReason = Extract<ChatEvent, { type: "turn_finished" }>["stopReason"];

export interface LiveTool {
  callId: string;
  name: string;
  bytes: number;
  done: boolean;
  ok?: boolean;
  summary?: string;
  newVersion?: number;
}

export interface TurnState {
  turnId: string;
  selection: ModelSelection | null;
  startedAt: number;
  step: number;
  servedBy: { providerId: string; modelId: string } | null;
  /** Text of the step being streamed (cleared when the step's assistant item lands). */
  text: string;
  reasoning: string;
  tools: LiveTool[];
  progress: { step: ProgressStep; label: string; at: number } | null;
  questions: { callId: string; questions: Question[] } | null;
  notices: Array<{ kind: string; text: string }>;
  newVersions: number[];
  status: "running" | "finished" | "stopped" | "failed";
  stopReason?: TurnStopReason;
  error?: AppError;
  canRetry: boolean;
  canContinue: boolean;
  /** The last step's usage and cost (each "usage" event is one step's). */
  usage?: Usage;
  cost?: Cost | null;
  /** What the whole turn has cost so far (every step's cost added up); null while no step has a price. */
  turnCost: Cost | null;
  /** End-of-turn summary: playability issues left after a turn that changed the plan. */
  outstanding?: OutstandingIssues;
}

export interface ChatState {
  items: ChatItem[];
  live: TurnState | null;
  /** The last finished turn (for Stopped/error cards, Retry, Continue). Cleared when a new turn starts. */
  last: TurnState | null;
}

export const emptyChat = (items: ChatItem[] = []): ChatState => ({ items, live: null, last: null });

function newTurn(turnId: string, selection: ModelSelection | null, now: number): TurnState {
  return {
    turnId,
    selection,
    startedAt: now,
    step: 0,
    servedBy: null,
    text: "",
    reasoning: "",
    tools: [],
    progress: null,
    questions: null,
    notices: [],
    newVersions: [],
    status: "running",
    canRetry: false,
    canContinue: false,
    turnCost: null,
  };
}

/** Two costs added up (null = no price known). */
export function addCosts(a: Cost | null | undefined, b: Cost | null | undefined): Cost | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return { currency: "USD", amount: a.amount + b.amount, estimated: a.estimated || b.estimated };
}

function upsert(items: ChatItem[], item: ChatItem): ChatItem[] {
  const i = items.findIndex((x) => x.id === item.id);
  if (i < 0) return [...items, item];
  const next = items.slice();
  next[i] = item;
  return next;
}

export function chatReducer(state: ChatState, e: ChatEvent, now: number = Date.now()): ChatState {
  if (e.type === "turn_started") {
    return { ...state, live: newTurn(e.turnId, e.selection, now), last: null };
  }
  const live = state.live;
  // Items can arrive for a turn we joined late (resume while busy): accept them, but never touch a different live turn.
  if (live === null) {
    if (e.type === "item_appended") return { ...state, items: upsert(state.items, e.item) };
    return state;
  }
  if (e.turnId !== live.turnId) return state;

  const set = (patch: Partial<TurnState>): ChatState => ({ ...state, live: { ...live, ...patch } });

  switch (e.type) {
    case "item_appended": {
      const items = upsert(state.items, e.item);
      if (e.item.type === "assistant") return { ...state, items, live: { ...live, text: "", reasoning: "" } };
      return { ...state, items };
    }
    case "step_started":
      return set({ step: e.step, servedBy: e.servedBy, text: "", reasoning: "" });
    case "text_delta":
      return set({ text: live.text + e.text });
    case "reasoning_delta":
      return set({ reasoning: live.reasoning + e.text });
    case "tool_call_started":
      return set({
        tools: [
          ...live.tools.filter((t) => t.callId !== e.callId),
          { callId: e.callId, name: e.name, bytes: 0, done: false },
        ],
      });
    case "tool_call_progress":
      return set({ tools: live.tools.map((t) => (t.callId === e.callId ? { ...t, bytes: e.bytes } : t)) });
    case "progress":
      return set({ progress: { step: e.step, label: e.label, at: now } });
    case "brief_updated":
      return state; // routed to the project store by the caller
    case "questions":
      return set({ questions: { callId: e.callId, questions: e.questions } });
    case "tool_call_finished": {
      const tools = live.tools.map((t) => {
        if (t.callId !== e.callId) return t;
        const done: LiveTool = { ...t, done: true, ok: e.ok, summary: e.summary };
        if (e.newVersion !== undefined) done.newVersion = e.newVersion;
        return done;
      });
      const newVersions = e.newVersion !== undefined ? [...live.newVersions, e.newVersion] : live.newVersions;
      return set({ tools, newVersions, progress: e.newVersion !== undefined ? null : live.progress });
    }
    case "notice":
      return set({ notices: [...live.notices, { kind: e.kind, text: e.text }] });
    case "usage":
      return set({ usage: e.usage, cost: e.cost, turnCost: addCosts(live.turnCost, e.cost) });
    case "turn_finished": {
      const done: TurnState = {
        ...live,
        status: e.stopReason === "cancelled" ? "stopped" : "finished",
        stopReason: e.stopReason,
        canRetry: e.canRetry,
        canContinue: e.canContinue,
        text: "",
        reasoning: "",
        progress: null,
      };
      if (e.outstandingIssues) done.outstanding = e.outstandingIssues;
      return { ...state, live: null, last: done };
    }
    case "turn_failed": {
      const done: TurnState = {
        ...live,
        status: "failed",
        error: e.error,
        canRetry: e.canRetry,
        text: "",
        reasoning: "",
        progress: null,
      };
      if (e.outstandingIssues) done.outstanding = e.outstandingIssues;
      return { ...state, live: null, last: done };
    }
    default:
      return state;
  }
}

/** ask_questions calls in the transcript that have no tool_result yet (the open Question card). */
export function pendingQuestions(
  items: readonly ChatItem[],
): { callId: string; itemId: string; questions: Question[] } | null {
  const answered = new Set<string>();
  for (const it of items) if (it.type === "tool_results") for (const r of it.results) answered.add(r.callId);
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.type === "user") return null;
    if (it?.type !== "assistant") continue;
    for (const p of it.parts) {
      if (p.type === "tool_call" && p.name === "ask_questions" && !answered.has(p.callId)) {
        const input = p.input as { questions?: Question[] } | null;
        return { callId: p.callId, itemId: it.id, questions: input?.questions ?? [] };
      }
    }
  }
  return null;
}

/** Answers previously given to an ask_questions call (from its tool_result JSON). */
export function answersFor(
  items: readonly ChatItem[],
  callId: string,
): Array<{ id: string; answer: string | null }> | null {
  for (const it of items) {
    if (it.type !== "tool_results") continue;
    for (const r of it.results) {
      if (r.callId !== callId) continue;
      const t = r.content.find((c) => c.type === "text");
      if (!t) return [];
      try {
        const parsed: unknown = JSON.parse(t.text);
        const answers =
          typeof parsed === "object" && parsed !== null
            ? (parsed as { answers?: unknown }).answers
            : undefined;
        return Array.isArray(answers)
          ? answers.filter(
              (a): a is { id: string; answer: string | null } =>
                typeof a === "object" &&
                a !== null &&
                typeof (a as { id?: unknown }).id === "string" &&
                ["string", "object"].includes(typeof (a as { answer?: unknown }).answer),
            )
          : [];
      } catch {
        return [];
      }
    }
  }
  return null;
}

export const PROGRESS_ORDER: ProgressStep[] = [
  "reading_brief",
  "laying_out_level",
  "placing_openings",
  "furnishing",
  "writing_notes",
  "checking",
];
