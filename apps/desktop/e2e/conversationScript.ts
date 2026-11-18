/**
 * Scripted model replies for e2e/conversation.spec.ts: what a model would send, step by step, for
 * brief → clarifying questions → create_plan → edit round 1 (rejected by validation, then corrected)
 * → edit round 2 → resumed chat. Each entry is one provider step (ScriptedStep, main/agent/testing).
 * The real engine executes every tool call with the real core functions.
 */
const call = (callId: string, name: string, input: unknown) => ({ type: "tool_call", callId, name, input });
const say = (text: string) => ({ type: "text", text });

export const AUTHORED_PLAN = {
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
      features: [{ id: "altar", type: "altar", at: [9, 3] }],
    },
  ],
  links: [],
};

/** Moving the altar 40 squares east puts it outside the level: applyOps/validation rejects it. */
export const BAD_EDIT = { op: "move", ids: ["altar"], dx: 40, dy: 0 };
export const GOOD_EDIT = { op: "move", ids: ["altar"], dx: 1, dy: 0 };
export const SECOND_EDIT = { op: "update", id: "hall", set: { notes: "Pillars carved as drowned monks." } };

const usage = { inputTokens: 1200, outputTokens: 600, cacheReadTokens: 9000, cacheWriteTokens: 300 };

export const STEPS = [
  // Turn 1 — brief + one question card (the turn ends waiting for the GM).
  {
    kind: "reply",
    usage,
    parts: [
      say("A crypt under an abbey. One question first."),
      call("tb", "update_brief", { set: { mapType: "Dungeon", system: "daggerheart" } }),
      call("tq", "ask_questions", {
        questions: [{ id: "q1", text: "Which tier?", default: "Tier 2", options: ["Tier 1", "Tier 2"] }],
      }),
    ],
  },
  // Turn 2 — the answer arrives as the tool_result; first draft.
  {
    kind: "reply",
    usage,
    parts: [
      call("tc", "create_plan", {
        replace: false,
        summary: "First draft",
        changes: ["Two rooms and an altar"],
        plan: AUTHORED_PLAN,
      }),
    ],
  },
  { kind: "reply", usage, parts: [say("Here's a first draft: an entry and a hall with an altar.")] },
  // Turn 3 — edit round 1: rejected (altar off the map), then corrected in the same turn.
  {
    kind: "reply",
    usage,
    parts: [
      call("te1", "edit_plan", {
        baseVersion: 1,
        summary: "Moved altar",
        changes: ["Moved the altar east"],
        ops: [BAD_EDIT],
      }),
    ],
  },
  {
    kind: "reply",
    usage,
    parts: [
      call("te1b", "edit_plan", {
        baseVersion: 1,
        summary: "Moved altar",
        changes: ["Moved the altar one square east"],
        ops: [GOOD_EDIT],
      }),
    ],
  },
  { kind: "reply", usage, parts: [say("Moved the altar one square east.")] },
  // Turn 4 — edit round 2.
  {
    kind: "reply",
    usage,
    parts: [
      call("te2", "edit_plan", {
        baseVersion: 2,
        summary: "Hall notes",
        changes: ["Wrote notes for the hall"],
        ops: [SECOND_EDIT],
      }),
    ],
  },
  { kind: "reply", usage, parts: [say("Added notes for the hall. Ready to approve when you are.")] },
  // Turn 5 — after restart: the resumed conversation answers.
  { kind: "reply", usage, parts: [say("Welcome back. The crypt is approved and built.")] },
];
