/**
 * Recorded-shape transcript fixtures for render/replay tests: Anthropic content blocks as the API returns them
 * (thinking with signatures, a mid-stream refusal fallback, a server compaction block) stored verbatim in
 * providerState.raw.
 */
import type { ChatItem } from "../provider/types";

const T = "2026-11-18T10:00:00.000Z";

export const RECORDED_TRANSCRIPT: ChatItem[] = [
  { type: "user", id: "u1", text: "A two-level crypt under a ruined abbey.", createdAt: T },
  {
    type: "context",
    id: "c1",
    reason: "session_start",
    text: 'Installed themes: stone_dungeon "Stone dungeon".\nPlan: none yet.',
    createdAt: T,
  },
  {
    type: "marker",
    id: "m1",
    kind: "selection_changed",
    selection: { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "high" },
    createdAt: T,
  },
  {
    type: "assistant",
    id: "a1",
    turnId: "t1",
    parts: [{ type: "tool_call", callId: "toolu_01", name: "ask_questions", input: { questions: [] } }],
    stopReason: "tool_use",
    servedBy: { providerId: "anthropic", modelId: "claude-opus-5-5" },
    providerState: {
      providerId: "anthropic",
      modelId: "claude-opus-5-5",
      raw: [
        { type: "thinking", thinking: "The GM wants a crypt; ask about the party.", signature: "sig-opus-1" },
        { type: "text", text: "A couple of quick questions first.", citations: null },
        {
          type: "tool_use",
          id: "toolu_01",
          name: "ask_questions",
          input: { questions: [{ id: "q1", text: "Tier?", default: "Tier 2", options: ["1", "2"] }] },
        },
      ],
    },
    createdAt: T,
  },
  {
    type: "tool_results",
    id: "r1",
    turnId: "t2",
    results: [
      {
        callId: "toolu_01",
        name: "ask_questions",
        isError: false,
        content: [{ type: "text", text: '{"answers":[{"id":"q1","answer":"2"}]}' }],
      },
    ],
    createdAt: T,
  },
  {
    type: "user",
    id: "u2",
    text: "Make the lower level flooded.",
    selection: {
      levelId: "l1",
      areaIds: ["hall"],
      featureIds: [],
      openingIds: [],
      linkIds: [],
      rect: { x: 2, y: 3, w: 4, h: 4 },
    },
    createdAt: T,
  },
  {
    type: "assistant",
    id: "a2",
    turnId: "t2",
    parts: [{ type: "text", text: "Drafting now." }],
    stopReason: "tool_use",
    servedBy: { providerId: "anthropic", modelId: "claude-opus-4-8" },
    providerState: {
      providerId: "anthropic",
      modelId: "claude-opus-5-5",
      raw: [
        { type: "thinking", thinking: "", signature: "sig-opus-2" },
        { type: "text", text: "Here is the", citations: null },
        { type: "tool_use", id: "toolu_declined", name: "create_plan", input: {} },
        {
          type: "fallback",
          from: { model: "claude-opus-5-5" },
          to: { model: "claude-opus-4-8" },
          trigger: { type: "refusal", category: "cyber" },
        },
        { type: "thinking", thinking: "Continue the draft.", signature: "sig-48-1" },
        { type: "tool_use", id: "toolu_02", name: "view_plan", input: { format: "outline" } },
      ],
    },
    createdAt: T,
  },
  {
    type: "tool_results",
    id: "r2",
    turnId: "t2",
    results: [
      { callId: "toolu_02", name: "view_plan", isError: true, content: [{ type: "text", text: "no_plan" }] },
    ],
    createdAt: T,
  },
  { type: "context", id: "c2", reason: "retry_hint", text: "Split large changes.", createdAt: T },
  {
    type: "assistant",
    id: "a3",
    turnId: "t2",
    parts: [
      { type: "text", text: "Done." },
      { type: "notice", kind: "compaction", text: "summarized" },
    ],
    stopReason: "end_turn",
    servedBy: { providerId: "anthropic", modelId: "claude-opus-5-5" },
    providerState: {
      providerId: "anthropic",
      modelId: "claude-opus-5-5",
      raw: [
        {
          type: "compaction",
          content: "Summary of the earlier conversation.",
          encrypted_content: "enc",
          signature: "sig-c",
        },
        { type: "text", text: "Done.", citations: null },
      ],
    },
    createdAt: T,
  },
  {
    type: "assistant",
    id: "a4",
    turnId: "t3",
    parts: [{ type: "text", text: "Partial…" }],
    stopReason: "cancelled",
    servedBy: { providerId: "anthropic", modelId: "claude-opus-5-5" },
    excludedFromContext: true,
    createdAt: T,
  },
  {
    type: "marker",
    id: "m2",
    kind: "selection_changed",
    selection: { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "low" },
    createdAt: T,
  },
  { type: "user", id: "u3", text: "Thanks!", createdAt: T },
];
