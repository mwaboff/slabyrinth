/**
 * Scripted model replies for e2e/ui.spec.ts (one entry per provider step, like conversationScript.ts):
 * brief + one question card → create_plan (WP1's two-level example A plus a bookshelf left in the middle of
 * the hall, so the plan check has a warning to list) → one edit through the composer.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const call = (callId: string, name: string, input: unknown) => ({ type: "tool_call", callId, name, input });
const say = (text: string) => ({ type: "text", text });

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../packages/core/test/fixtures/plans/example-a.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, unknown> & { levels: Array<{ id: string; features: unknown[] }> };

/**
 * As the model authors it: the app fills schema, generator and id. The plan keeps the fixture's seed, so the build the
 * test copies is the same every run (a seed the app picked would make the test depend on that seed's build).
 */
const authored: Record<string, unknown> & { levels: Array<{ id: string; features: unknown[] }> } = {
  ...fixture,
};
for (const k of ["schema", "generator", "id"]) Reflect.deleteProperty(authored, k);
const l1 = authored.levels.find((l) => l.id === "l1");
l1?.features.push({ id: "shelf_mid", type: "bookshelf", at: [15, 10] });

export const UI_PLAN = authored;
export const UI_EDIT = {
  op: "update",
  id: "guard",
  set: { notes: "Three skeletal wardens still sit at their dice." },
};

const usage = { inputTokens: 1200, outputTokens: 600, cacheReadTokens: 9000, cacheWriteTokens: 300 };

export const UI_STEPS = [
  {
    kind: "reply",
    usage,
    parts: [
      say("A drowned abbey crypt. One question first."),
      call("tb", "update_brief", { set: { mapType: "Dungeon", system: "daggerheart" } }),
      call("tq", "ask_questions", {
        questions: [{ id: "q1", text: "Which tier?", default: "Tier 2", options: ["Tier 1", "Tier 2"] }],
      }),
    ],
  },
  {
    kind: "reply",
    usage,
    parts: [
      call("tc", "create_plan", {
        replace: false,
        summary: "First draft",
        changes: ["Two levels under the abbey"],
        plan: UI_PLAN,
      }),
    ],
  },
  {
    kind: "reply",
    usage,
    parts: [say("Here's a first draft: the upper crypts and the flooded cistern below.")],
  },
  {
    kind: "reply",
    usage,
    parts: [
      call("te", "edit_plan", {
        baseVersion: 1,
        summary: "Guardroom notes",
        changes: ["Wrote notes for the guardroom"],
        ops: [UI_EDIT],
      }),
    ],
  },
  { kind: "reply", usage, parts: [say("Added notes for the guardroom.")] },
];
