/** Thread entries keep transcript order even when item timestamps tie or interleave (found in the real app). */
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../../main/agent/provider/types";
import { buildEntries } from "./Thread";

const t = (s: number): string => new Date(Date.UTC(2026, 10, 18, 12, 0, s)).toISOString();
const user = (id: string, at: string): ChatItem => ({ type: "user", id, text: id, createdAt: at });
const ai = (id: string, turnId: string, at: string): ChatItem => ({
  type: "assistant",
  id,
  turnId,
  parts: [{ type: "text", text: id }],
  stopReason: "end_turn",
  servedBy: { providerId: "anthropic", modelId: "m" },
  createdAt: at,
});

describe("buildEntries", () => {
  it("never moves a user message after the reply to it", () => {
    // the engine stamped the user item after the assistant items of the same turn
    const items = [ai("welcome", "t0", t(0)), user("ask", t(9)), ai("reply", "t1", t(5))];
    const kinds = buildEntries(items, [], [], []).map((e) =>
      e.kind === "user" ? `u:${e.item.id}` : e.kind === "ai" ? `a:${e.items[0]?.id ?? ""}` : e.kind,
    );
    expect(kinds).toEqual(["a:welcome", "u:ask", "a:reply"]);
  });

  it("slots user edits and builds in by time", () => {
    const items = [user("ask", t(1)), ai("reply", "t1", t(2)), user("later", t(10))];
    const versions = [
      {
        number: 2,
        parentNumber: 1,
        author: "user" as const,
        createdAt: t(5),
        summary: "You edited notes for 4",
        changeSummary: [],
        causeType: "ops" as const,
      },
    ];
    const kinds = buildEntries(items, versions, [], []).map((e) => e.kind);
    expect(kinds).toEqual(["user", "ai", "sys", "user"]);
  });
});
