import { describe, expect, it } from "vitest";
import {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_VERSION,
  TOOL_DEFINITIONS,
  serializeTools,
  systemPromptFor,
  toolsForConversation,
  validateToolInput,
} from "../../../src/agent";
import { h64hex } from "../../../src/util";

describe("frozen tool list", () => {
  it("serializes deterministically (the bytes are the cache key)", () => {
    const a = serializeTools(toolsForConversation(true));
    const b = serializeTools(toolsForConversation(true));
    expect(a).toBe(b);
    expect(a).toMatchSnapshot();
    // A cheap guard that also shows up in review diffs when the tool bytes change.
    expect(h64hex(a)).toMatchSnapshot();
  });

  it("keeps the contract order and drops view_map_image for models without image input", () => {
    expect(toolsForConversation(true).map((t) => t.name)).toEqual(TOOL_DEFINITIONS.map((t) => t.name));
    expect(toolsForConversation(false).map((t) => t.name)).not.toContain("view_map_image");
    expect(toolsForConversation(false)).toHaveLength(TOOL_DEFINITIONS.length - 1);
  });

  it("schemas have sorted keys at every level", () => {
    const check = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(check);
      else if (typeof v === "object" && v !== null) {
        const keys = Object.keys(v);
        expect(keys).toEqual([...keys].sort());
        Object.values(v).forEach(check);
      }
    };
    for (const t of toolsForConversation(true)) check(t.inputSchema);
  });
});

describe("system prompt", () => {
  it("is frozen per version", () => {
    expect(SYSTEM_PROMPT_VERSION).toBe("sp-1.1.0");
    expect(systemPromptFor(SYSTEM_PROMPT_VERSION)).toBe(SYSTEM_PROMPT);
    expect(systemPromptFor("sp-0.0.0")).toBeNull();
    // Published versions never change: conversations started on sp-1.0.0 keep byte-identical text.
    expect(h64hex(systemPromptFor("sp-1.0.0") ?? "")).toBe("79bd3a0fc09ea537");
    expect(h64hex(SYSTEM_PROMPT)).toMatchSnapshot();
  });
  it("sp-1.1.0 makes the checking method explicit", () => {
    expect(SYSTEM_PROMPT).toContain("# Checking your work");
    expect(SYSTEM_PROMPT).toMatch(/Fix every error, and every warning that is a genuine mistake/);
    expect(SYSTEM_PROMPT).toMatch(/tell the GM in a sentence what you left and why/);
    expect(SYSTEM_PROMPT).toMatch(/call compile_preview, resolve its build errors/);
    expect(SYSTEM_PROMPT).toMatch(/Never tell the GM a map is checked, clean or ready unless/);
    expect(SYSTEM_PROMPT).not.toContain("cave_rock");
  });
  it("contains nothing volatile and follows the GM-notes and one-slab decisions", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(SYSTEM_PROMPT).toMatch(/only when the GM asks/);
    expect(SYSTEM_PROMPT).toMatch(/one slab/);
  });
});

describe("architecture §3 examples pass the tool schemas", () => {
  it("edit_plan with a between-door and a stairs link", () => {
    const r = validateToolInput("edit_plan", {
      baseVersion: 7,
      summary: "Added secret door to crypt",
      changes: ["Added a secret door between 3 and 5"],
      ops: [
        {
          op: "add",
          element: {
            kind: "opening",
            level: "l1",
            value: { id: "d_secret", kind: "secret_door", between: ["hall", "ossuary"], position: 0.5 },
          },
        },
        {
          op: "add",
          element: {
            kind: "link",
            value: {
              id: "stair_main",
              kind: "stairs",
              from: { level: "l2", at: [26, 11] },
              to: { level: "l1" },
              dir: "N",
            },
          },
        },
        { op: "update", id: "hall", set: { notes: "Pillars carved as drowned monks." } },
      ],
    });
    expect(r.ok).toBe(true);
  });
  it("view_plan, update_brief, ask_questions, list_catalog", () => {
    expect(
      validateToolInput("view_plan", { format: "ascii", level: "l1", region: { x: 0, y: 0, w: 10, h: 10 } })
        .ok,
    ).toBe(true);
    expect(
      validateToolInput("update_brief", {
        set: { mapType: "Dungeon", system: "daggerheart", party: { tier: 2, size: 4 } },
      }).ok,
    ).toBe(true);
    expect(
      validateToolInput("ask_questions", {
        questions: [
          { id: "q1", text: "Party tier?", default: "I'll assume Tier 2", options: ["Tier 1", "Tier 2"] },
        ],
      }).ok,
    ).toBe(true);
    expect(validateToolInput("list_catalog", { what: "features", theme: "stone_dungeon" }).ok).toBe(true);
  });
});
