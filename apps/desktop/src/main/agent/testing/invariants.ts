/**
 * Request-shape invariants for rendered Anthropic requests (tests only):
 *  - every assistant tool_use is answered by tool_result blocks at the START of the very next message, which is a
 *    user message, and every result answers a tool_use of that assistant message;
 *  - no system entry follows an assistant entry, and a system entry with content follows a user message and is
 *    the last entry or followed by an assistant message.
 * Returns the list of violations (empty = valid).
 */
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

type Block = { type?: unknown; id?: unknown; tool_use_id?: unknown };

const blocks = (m: BetaMessageParam | undefined): Block[] =>
  Array.isArray(m?.content) ? (m.content as Block[]) : [];

export function requestShapeViolations(messages: readonly BetaMessageParam[]): string[] {
  const bad: string[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    if (m.role === "assistant") {
      const uses = blocks(m)
        .filter((b) => b.type === "tool_use")
        .map((b) => String(b.id));
      if (uses.length > 0) {
        if (next?.role !== "user") bad.push(`messages.${i}: tool_use not followed by a user message`);
        else {
          const nb = blocks(next);
          const lead = nb.slice(0, uses.length);
          const results = lead.filter((b) => b.type === "tool_result").map((b) => String(b.tool_use_id));
          for (const u of uses)
            if (!results.includes(u))
              bad.push(`messages.${i}: tool_use ${u} has no tool_result first in the next message`);
        }
      }
    }
    if (m.role === "user") {
      const results = blocks(m).filter((b) => b.type === "tool_result");
      if (results.length > 0) {
        const prevUses =
          prev?.role === "assistant"
            ? blocks(prev)
                .filter((b) => b.type === "tool_use")
                .map((b) => String(b.id))
            : [];
        for (const r of results)
          if (!prevUses.includes(String(r.tool_use_id)))
            bad.push(`messages.${i}: tool_result ${String(r.tool_use_id)} without its tool_use just before`);
      }
    }
    if (m.role === "system") {
      if (prev?.role === "assistant")
        bad.push(`messages.${i}: system entry right after an assistant message`);
      const hasContent = blocks(m).length > 0;
      if (hasContent) {
        if (prev?.role !== "user")
          bad.push(`messages.${i}: system message with content does not follow a user message`);
        if (next !== undefined && next.role !== "assistant")
          bad.push(`messages.${i}: system message with content followed by ${next.role}`);
      }
    }
  });
  return bad;
}
