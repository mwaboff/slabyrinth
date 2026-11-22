/** The tools that talk with the GM: update_brief (merged into the design brief) and ask_questions (waits for the GM). */
import { mergeBrief } from "../brief";
import { validateToolInput } from "../inputs";
import type { ToolOutcome } from "../tools";
import type { AgentToolContext } from "./ports";
import { fail } from "./results";

export function runUpdateBrief(ctx: AgentToolContext, input: unknown): ToolOutcome {
  const v = validateToolInput("update_brief", input);
  if (!v.ok) return fail("update_brief", ctx.head, v.errors);
  const merged = mergeBrief(ctx.brief, v.value.set);
  const text =
    JSON.stringify({ status: "applied", updated: merged.updated, skipped: merged.skipped }) +
    (merged.skipped.length > 0 ? `\nThe GM set ${merged.skipped.join(", ")} by hand; those were kept.` : "");
  return { ok: true, content: [{ type: "text", text }], newBrief: merged.brief };
}

export function runAskQuestions(ctx: AgentToolContext, input: unknown): ToolOutcome {
  const v = validateToolInput("ask_questions", input);
  if (!v.ok) return fail("ask_questions", ctx.head, v.errors);
  const ids = v.value.questions.map((q) => q.id);
  if (new Set(ids).size !== ids.length) {
    return fail("ask_questions", ctx.head, [
      {
        code: "invalid_input",
        path: "/questions",
        msg: "question ids must be unique",
        hint: 'use ids like "q1", "q2"',
      },
    ]);
  }
  return { ok: true, content: [], awaitUser: true };
}
