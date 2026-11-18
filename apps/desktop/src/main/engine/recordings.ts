import type { DesignBrief, MapPlan, PlanOp } from "@slabyrinth/core";
import type { AssistantPart, StopReason } from "../agent/provider/types";
import type { ChatEvent } from "../../shared/ipc";

/**
 * Recorded event streams for the fake engine. They follow the real turn shape (§3.2): user item,
 * step_started, deltas, tool calls with progress, plan version commits, usage, turn_finished.
 * The UI engineer can add recordings here; `pick()` chooses one from the message text.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RecordedEvent = DistributiveOmit<ChatEvent, "turnId">;

export type RecordedStep =
  | { kind: "event"; event: RecordedEvent; delayMs?: number }
  /** Appends the final assistant item of a step (emits item_appended). */
  | { kind: "assistant"; parts: AssistantPart[]; stopReason: StopReason; delayMs?: number }
  /**
   * Commits a plan version through the host, then emits tool_call_finished: create_plan carries the
   * whole plan; edit_plan carries ops, applied to the head with core applyOps (versions caused by ops
   * are replayed from keyframes, so the ops must reproduce the plan exactly).
   */
  | {
      kind: "commit";
      callId: string;
      tool: "create_plan";
      plan: MapPlan;
      summary: string;
      changeSummary: string[];
      delayMs?: number;
    }
  | {
      kind: "commit";
      callId: string;
      tool: "edit_plan";
      ops: (current: MapPlan) => PlanOp[];
      summary: string;
      changeSummary: string[];
      delayMs?: number;
    }
  | { kind: "brief"; brief: DesignBrief; delayMs?: number }
  | { kind: "fail"; code: "provider" | "internal"; message: string; delayMs?: number };

export interface Recording {
  id: string;
  steps: RecordedStep[];
}

export const FIXTURE_PLAN: MapPlan = {
  schema: "slabyrinth/plan@1",
  generator: 1,
  id: "00000000-0000-4000-8000-00000000f4ce",
  title: "The Fake Crypt",
  summary: "A two-room crypt produced by the fake engine (recorded stream).",
  kind: "dungeon",
  seed: 4242,
  theme: "stone_dungeon",
  entryLevel: "l1",
  levels: [
    {
      id: "l1",
      name: "Crypt",
      elevation: 0,
      bounds: { x: 0, y: 0, w: 20, h: 14 },
      base: { type: "solid" },
      areas: [
        {
          id: "entry",
          kind: "room",
          name: "Entry Hall",
          key: "1",
          shape: { type: "rect", x: 2, y: 4, w: 6, h: 6 },
          notes: "Dusty footprints lead east.",
        },
        {
          id: "tomb",
          kind: "room",
          name: "Tomb of the Abbot",
          key: "2",
          shape: { type: "rect", x: 11, y: 3, w: 7, h: 8 },
          readAloud: "A stone coffin rests under a cracked vault.",
        },
        {
          id: "c1",
          kind: "corridor",
          shape: { type: "route", from: "entry", to: "tomb", width: 1, bend: "hv", openings: "door" },
        },
      ],
      openings: [],
      walls: [],
      features: [{ id: "coffin", type: "sarcophagus", at: [14, 6], size: [1, 2] }],
      terrain: [],
      labels: [],
    },
  ],
  links: [],
};

const usage = { inputTokens: 1200, outputTokens: 900, cacheReadTokens: 8000, cacheWriteTokens: 0 };

export const FIRST_PLAN: Recording = {
  id: "first-plan",
  steps: [
    {
      kind: "event",
      event: {
        type: "step_started",
        step: 0,
        servedBy: { providerId: "anthropic", modelId: "claude-opus-5-5" },
      },
    },
    {
      kind: "event",
      event: {
        type: "reasoning_delta",
        step: 0,
        text: "Two rooms joined by a short corridor fits the brief.",
      },
      delayMs: 30,
    },
    { kind: "event", event: { type: "text_delta", step: 0, text: "Here's a first draft: " }, delayMs: 30 },
    {
      kind: "event",
      event: { type: "text_delta", step: 0, text: "an entry hall and the abbot's tomb." },
      delayMs: 30,
    },
    {
      kind: "brief",
      brief: {
        mapType: { value: "Dungeon", source: "ai" },
        levels: { value: { count: 1, names: ["Crypt"] }, source: "ai" },
      },
      delayMs: 20,
    },
    {
      kind: "event",
      event: { type: "tool_call_started", step: 0, callId: "call_1", name: "create_plan" },
      delayMs: 20,
    },
    {
      kind: "event",
      event: { type: "progress", step: "laying_out_level", label: "Laying out Level 1" },
      delayMs: 40,
    },
    { kind: "event", event: { type: "tool_call_progress", callId: "call_1", bytes: 900 }, delayMs: 20 },
    {
      kind: "event",
      event: { type: "progress", step: "placing_openings", label: "Placing doors and stairs" },
      delayMs: 40,
    },
    {
      kind: "event",
      event: { type: "progress", step: "writing_notes", label: "Writing GM notes" },
      delayMs: 40,
    },
    { kind: "event", event: { type: "progress", step: "checking", label: "Checking the plan" }, delayMs: 40 },
    {
      kind: "commit",
      callId: "call_1",
      tool: "create_plan",
      plan: FIXTURE_PLAN,
      summary: "First draft: Entry Hall and Tomb",
      changeSummary: [
        "Added Entry Hall (1)",
        "Added Tomb of the Abbot (2)",
        "Joined them with a corridor and doors",
      ],
      delayMs: 20,
    },
    {
      kind: "assistant",
      parts: [
        { type: "text", text: "Here's a first draft: an entry hall and the abbot's tomb." },
        { type: "tool_call", callId: "call_1", name: "create_plan", input: { summary: "First draft" } },
      ],
      stopReason: "tool_use",
    },
    {
      kind: "event",
      event: {
        type: "step_started",
        step: 1,
        servedBy: { providerId: "anthropic", modelId: "claude-opus-5-5" },
      },
    },
    {
      kind: "event",
      event: {
        type: "text_delta",
        step: 1,
        text: "Have a look at the map. Want a second level below the tomb?",
      },
      delayMs: 30,
    },
    {
      kind: "assistant",
      parts: [{ type: "text", text: "Have a look at the map. Want a second level below the tomb?" }],
      stopReason: "end_turn",
    },
  ],
};

export const CHAT_REPLY: Recording = {
  id: "chat-reply",
  steps: [
    {
      kind: "event",
      event: {
        type: "step_started",
        step: 0,
        servedBy: { providerId: "anthropic", modelId: "claude-opus-5-5" },
      },
    },
    { kind: "event", event: { type: "text_delta", step: 0, text: "Noted. " }, delayMs: 30 },
    {
      kind: "event",
      event: { type: "text_delta", step: 0, text: "I'll keep that in mind for the next revision." },
      delayMs: 30,
    },
    {
      kind: "assistant",
      parts: [{ type: "text", text: "Noted. I'll keep that in mind for the next revision." }],
      stopReason: "end_turn",
    },
  ],
};

export const EDIT_PLAN: Recording = {
  id: "edit-plan",
  steps: [
    {
      kind: "event",
      event: {
        type: "step_started",
        step: 0,
        servedBy: { providerId: "anthropic", modelId: "claude-opus-5-5" },
      },
    },
    {
      kind: "event",
      event: { type: "tool_call_started", step: 0, callId: "call_e1", name: "edit_plan" },
      delayMs: 20,
    },
    { kind: "event", event: { type: "progress", step: "furnishing", label: "Furnishing" }, delayMs: 40 },
    {
      kind: "commit",
      callId: "call_e1",
      tool: "edit_plan",
      ops: (current) => {
        const n = current.levels[0]?.features.length ?? 0;
        return [
          {
            op: "add_features",
            level: "l1",
            features: [
              { id: `brazier_${String(n)}`, type: "brazier", at: [2 + (n % 6), 5 + (Math.floor(n / 6) % 4)] },
            ],
          },
        ];
      },
      summary: "Added a brazier to the Entry Hall",
      changeSummary: ["Added a brazier in the Entry Hall (1)"],
      delayMs: 20,
    },
    {
      kind: "assistant",
      parts: [
        { type: "tool_call", callId: "call_e1", name: "edit_plan", input: { summary: "Added a brazier" } },
      ],
      stopReason: "tool_use",
    },
    {
      kind: "event",
      event: {
        type: "step_started",
        step: 1,
        servedBy: { providerId: "anthropic", modelId: "claude-opus-5-5" },
      },
    },
    {
      kind: "assistant",
      parts: [{ type: "text", text: "Done: a brazier now lights the Entry Hall." }],
      stopReason: "end_turn",
    },
  ],
};

export const QUESTIONS: Recording = {
  id: "questions",
  steps: [
    {
      kind: "event",
      event: {
        type: "step_started",
        step: 0,
        servedBy: { providerId: "anthropic", modelId: "claude-opus-5-5" },
      },
    },
    {
      kind: "event",
      event: { type: "tool_call_started", step: 0, callId: "call_q1", name: "ask_questions" },
    },
    {
      kind: "event",
      event: {
        type: "questions",
        callId: "call_q1",
        questions: [
          {
            id: "q1",
            text: "Which game system?",
            default: "Daggerheart",
            options: ["Daggerheart", "D&D 5e", "Other"],
          },
          { id: "q2", text: "How many levels?", default: "1", options: ["1", "2", "3"] },
        ],
      },
      delayMs: 20,
    },
    {
      kind: "assistant",
      parts: [{ type: "tool_call", callId: "call_q1", name: "ask_questions", input: {} }],
      stopReason: "tool_use",
    },
  ],
};

export const PROVIDER_ERROR: Recording = {
  id: "provider-error",
  steps: [
    {
      kind: "event",
      event: {
        type: "step_started",
        step: 0,
        servedBy: { providerId: "anthropic", modelId: "claude-opus-5-5" },
      },
    },
    {
      kind: "event",
      event: { type: "notice", kind: "retrying", text: "Claude is busy, retrying in 4 s" },
      delayMs: 30,
    },
    {
      kind: "fail",
      code: "provider",
      message: "Claude is overloaded right now. Try again in a minute.",
      delayMs: 30,
    },
  ],
};

export const RECORDINGS = { FIRST_PLAN, CHAT_REPLY, EDIT_PLAN, QUESTIONS, PROVIDER_ERROR };

/** Chooses a recording: keywords first, otherwise the first plan, then plain replies. */
export function pick(text: string, hasPlan: boolean): Recording {
  const t = text.toLowerCase();
  if (t.includes("#fail")) return PROVIDER_ERROR;
  if (t.includes("#ask")) return QUESTIONS;
  if (!hasPlan) return FIRST_PLAN;
  if (/\b(add|change|move|make|bigger|smaller|brazier)\b/.test(t)) return EDIT_PLAN;
  return CHAT_REPLY;
}

export const FAKE_USAGE = usage;
