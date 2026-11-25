import { describe, expect, it } from "vitest";
import {
  DESIGN_PRINCIPLES,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_VERSION,
  TOOL_DEFINITIONS,
  serializeTools,
  systemPromptFor,
  toolsForConversation,
  validateToolInput,
} from "../../../src/agent";
import { h64hex } from "../../../src/util";
import { DP_1_0_0, DP_1_1_0, DP_1_2_0, DP_1_3_0, DP_1_4_0 } from "../../../src/agent/designPrinciples.frozen";
import { DESIGN_PRINCIPLES_VERSION } from "../../../src/agent/designPrinciples";
import { TOOLS_VERSION } from "../../../src/agent/prompt";

/** Hash of the published sp-1.1.0 text (frozen). */
const SP_1_1_0_HASH = "2176e2d9b0362e06";

describe("working tool list (tools-1.11.0; published versions are pinned by hash below)", () => {
  it("working versions are the ones last opened", () => {
    // generator 6 opened sp-1.15.0, dp-1.5.0, tools-1.11.0 (the 0.4.0 texts are pinned below)
    expect(SYSTEM_PROMPT_VERSION).toBe("sp-1.15.0");
    expect(DESIGN_PRINCIPLES_VERSION).toBe("dp-1.5.0");
    expect(TOOLS_VERSION).toBe("tools-1.11.0");
  });
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

describe("released in 0.1.2: sp-1.11.0, dp-1.1.0, tools-1.7.0 (frozen)", () => {
  it("sp-1.11.0 is byte-identical to the release", () => {
    expect(h64hex(systemPromptFor("sp-1.11.0") ?? "")).toBe("d074cc244ed28a6b");
  });
  it("dp-1.1.0 is byte-identical to the release", () => {
    expect(h64hex(DP_1_1_0)).toBe("867eda4554f73167");
    expect(systemPromptFor("sp-1.11.0")).toContain(DP_1_1_0);
  });
  it("tools-1.7.0 is byte-identical to the release and served from its frozen copy", () => {
    const frozen = serializeTools(toolsForConversation(true, "tools-1.7.0"));
    expect(h64hex(frozen)).toBe("89b914883f0a96b1");
    expect(toolsForConversation(true, "tools-1.7.0").map((t) => t.streamInput)).toEqual(
      TOOL_DEFINITIONS.map((t) => t.streamInput),
    );
    expect(toolsForConversation(false, "tools-1.7.0").map((t) => t.name)).not.toContain("view_map_image");
  });
});

describe("released in 0.2.0: sp-1.12.0, dp-1.2.0, tools-1.8.0 (frozen with generator 3)", () => {
  it("sp-1.12.0 is byte-identical to the release", () => {
    expect(h64hex(systemPromptFor("sp-1.12.0") ?? "")).toBe("6e121502f667d0e5");
  });
  it("dp-1.2.0 is byte-identical to the release and sp-1.12.0 carries it", () => {
    expect(h64hex(DP_1_2_0)).toBe("bcc0e06e28bf86c5");
    expect(systemPromptFor("sp-1.12.0")).toContain(DP_1_2_0);
  });
  it("tools-1.8.0 is byte-identical to the release and served from its frozen copy", () => {
    const frozen = serializeTools(toolsForConversation(true, "tools-1.8.0"));
    expect(h64hex(frozen)).toBe("89e7f4b8549a4d20");
    expect(toolsForConversation(false, "tools-1.8.0").map((t) => t.name)).not.toContain("view_map_image");
  });
});

describe("released in 0.3.0: sp-1.13.0, dp-1.3.0, tools-1.9.0 (frozen with generator 4)", () => {
  it("sp-1.13.0 is byte-identical to the release", () => {
    expect(h64hex(systemPromptFor("sp-1.13.0") ?? "")).toBe("3a3b40c1e0bbe663");
  });
  it("dp-1.3.0 is byte-identical to the release and sp-1.13.0 carries it", () => {
    expect(h64hex(DP_1_3_0)).toBe("b742a7f442a2c475");
    expect(systemPromptFor("sp-1.13.0")).toContain(DP_1_3_0);
  });
  it("tools-1.9.0 is byte-identical to the release and served from its frozen copy", () => {
    const frozen = serializeTools(toolsForConversation(true, "tools-1.9.0"));
    expect(h64hex(frozen)).toBe("63d3313aed2d1faa");
    expect(toolsForConversation(false, "tools-1.9.0").map((t) => t.name)).not.toContain("view_map_image");
  });
  it("the released 0.1.2 texts did not move", () => {
    expect(h64hex(systemPromptFor("sp-1.11.0") ?? "")).toBe("d074cc244ed28a6b");
    expect(h64hex(serializeTools(toolsForConversation(true, "tools-1.7.0")))).toBe("89b914883f0a96b1");
  });
});

describe("released in 0.4.0: sp-1.14.0, dp-1.4.0, tools-1.10.0 (frozen with generator 5)", () => {
  it("sp-1.14.0 is byte-identical to the release", () => {
    expect(h64hex(systemPromptFor("sp-1.14.0") ?? "")).toBe("b7f8febdc9a089f4");
  });
  it("dp-1.4.0 is byte-identical to the release and sp-1.14.0 carries it", () => {
    expect(h64hex(DP_1_4_0)).toBe("8afea61ec9f53ad8");
    expect(systemPromptFor("sp-1.14.0")).toContain(DP_1_4_0);
  });
  it("tools-1.10.0 is byte-identical to the release and served from its frozen copy", () => {
    const frozen = serializeTools(toolsForConversation(true, "tools-1.10.0"));
    expect(h64hex(frozen)).toBe("dc1a240414b9222c");
    expect(toolsForConversation(false, "tools-1.10.0").map((t) => t.name)).not.toContain("view_map_image");
  });
});

describe("system prompt", () => {
  it("is frozen per version", () => {
    expect(SYSTEM_PROMPT_VERSION).toBe("sp-1.15.0");
    // sp-1.10.0 shipped in the owner's second snapshot with dp-1.0.0: frozen byte for byte
    expect(h64hex(systemPromptFor("sp-1.10.0") ?? "")).toBe("74e5072df0fd89e2");
    expect(systemPromptFor(SYSTEM_PROMPT_VERSION)).toBe(SYSTEM_PROMPT);
    expect(systemPromptFor("sp-0.0.0")).toBeNull();
    // Published versions never change: conversations started on sp-1.0.0 keep byte-identical text.
    expect(h64hex(systemPromptFor("sp-1.0.0") ?? "")).toBe("79bd3a0fc09ea537");
    // sp-1.1.0 is published too (0.1.x): its text must never change either.
    expect(h64hex(systemPromptFor("sp-1.1.0") ?? "")).toBe(SP_1_1_0_HASH);
    expect(h64hex(SYSTEM_PROMPT)).toMatchSnapshot();
  });
  it("sp-1.13.0 (and the working prompt after it) says the generator-4 room rules once, where they apply", () => {
    // the dressing how-to lives in the set-dressing section only; the principle carries no list of purposes
    expect(SYSTEM_PROMPT.match(/Rooms dress themselves/g)).toHaveLength(1);
    expect(SYSTEM_PROMPT).toMatch(/Name every room for its use .* and leave its floor off/);
    expect(DESIGN_PRINCIPLES).not.toMatch(/Kitchen|Guard room|Inhabited places are lit/);
    // a carved interior and a kept-up building are told apart, not given contradictory rules
    expect(DESIGN_PRINCIPLES).toMatch(/Rooms cut into rock sit in solid mass/);
    expect(DESIGN_PRINCIPLES).toMatch(/Rooms of a kept-up building .* share their walls/);
    expect(DESIGN_PRINCIPLES).not.toMatch(/roughens the wall tops/);
    // the review runs from generator 2 on, so the prompt no longer scopes it to "a generator-2 plan"
    expect(SYSTEM_PROMPT).not.toMatch(/generator-2 plan/);
  });
  it("sp-1.1.0 makes the checking method explicit", () => {
    expect(SYSTEM_PROMPT).toContain("# Checking your work");
    expect(SYSTEM_PROMPT).toMatch(/Fix every error, and every warning that is a genuine mistake/);
    expect(SYSTEM_PROMPT).toMatch(/tell the GM in a sentence what you left and why/);
    expect(SYSTEM_PROMPT).toMatch(/call compile_preview, resolve its build errors/);
    expect(SYSTEM_PROMPT).toMatch(/Never tell the GM a map is checked, clean or ready unless/);
    expect(SYSTEM_PROMPT).not.toContain("cave_rock");
  });
  it("sp-1.7.0 teaches buildings: style first, every building its own, yards", () => {
    const sp17 = systemPromptFor("sp-1.7.0") ?? "";
    expect(sp17).toContain("# Buildings and yards");
    expect(sp17).toMatch(/pick the style that fits/);
    expect(sp17).toMatch(/Never reuse the previous building's numbers/);
    expect(sp17).toMatch(/kind "enclosure"/);
    expect(sp17).toMatch(/modern or sci-fi block/);
    expect(systemPromptFor("sp-1.6.0")).not.toContain("# Buildings and yards");
  });
  it("sp-1.12.0 is sp-1.11.0 plus the working principles (dp-1.2.0), a few sentences", () => {
    const old = systemPromptFor("sp-1.11.0") ?? "";
    const released = systemPromptFor("sp-1.12.0") ?? "";
    expect(released).not.toBe(old);
    // the building sentences: things attach to the structure; the roof is the larger half of a cottage or inn
    expect(SYSTEM_PROMPT).toContain(
      "- Attach things. Vines climb upper walls and rubble lies at wall feet; little stands alone on open floor.",
    );
    expect(SYSTEM_PROMPT).toContain(
      "On cottages and inns the roof is the larger half; the top storey can sit inside it.",
    );
    expect(released.length - old.length).toBeLessThan(500);
  });
  it("sp-1.11.0: current principles, streets with junctions and green, plot sizes by kind, condition and character honoured", () => {
    expect(SYSTEM_PROMPT).toContain(DESIGN_PRINCIPLES);
    expect(SYSTEM_PROMPT).toMatch(/a side street is a road too, with its own sidewalk/);
    expect(SYSTEM_PROMPT).toMatch(/a watchtower 3 to 5 cells wide/);
    expect(SYSTEM_PROMPT).toMatch(/must be honoured/);
    expect(SYSTEM_PROMPT).toContain("twisted (the shaft corkscrews)");
    expect(SYSTEM_PROMPT).toMatch(/tell the GM instead of quietly building a plain version/);
    expect(SYSTEM_PROMPT).toMatch(/look at a new map.s image once even when the review is clean/);
  });
  it("sp-1.10.0 carries the design principles (dp-1.0.0) and names the DESIGN REVIEW, pruning what they repeat", () => {
    const sp110 = systemPromptFor("sp-1.10.0") ?? "";
    expect(sp110).toContain(DP_1_0_0);
    expect(sp110).toMatch(/ends with a DESIGN REVIEW block/);
    // said in general by the principles now: gone or shortened
    expect(sp110).not.toMatch(/Built places follow order, not nature/);
    expect(sp110).not.toMatch(/Leave open ground on purpose/);
    expect(sp110).toMatch(/Lots, courtyards and clearings get a use/);
    const grew = sp110.length - (systemPromptFor("sp-1.9.0") ?? "").length;
    expect(grew).toBeLessThan(DP_1_0_0.length - 300);
  });
  it("sp-1.9.0 gives every open space a use", () => {
    const sp19 = systemPromptFor("sp-1.9.0") ?? "";
    expect(sp19).toMatch(/Give every open space a use/);
    expect(sp19).toMatch(/purposeless open ground reads as unfinished/);
    expect(systemPromptFor("sp-1.8.0")).not.toMatch(/Give every open space a use/);
  });
  it("sp-1.8.0 teaches massing, silhouette, stacked roofs, roof furniture and light, principles first", () => {
    expect(SYSTEM_PROMPT).toContain("# Buildings and yards");
    expect(SYSTEM_PROMPT).toMatch(/Design it like an architect, in this order/);
    expect(SYSTEM_PROMPT).toMatch(/volumes \[\{id, x, y, w, h, storeys, storeyHeight, roof, on\}\]/);
    expect(SYSTEM_PROMPT).toMatch(/inset 1 steps a storey in/);
    expect(SYSTEM_PROMPT).toMatch(/roof\.layers, bottom first/);
    expect(SYSTEM_PROMPT).toMatch(/wizard_tower/);
    expect(SYSTEM_PROMPT).toMatch(/modern_block/);
    expect(systemPromptFor("sp-1.8.0")).toMatch(/Never reuse the previous building's numbers/);
    expect(SYSTEM_PROMPT).toMatch(/kind "enclosure"/);
    expect(SYSTEM_PROMPT).not.toMatch(/built flat until cone roofs land/);
    expect(systemPromptFor("sp-1.7.0")).not.toMatch(/Design it like an architect/);
  });
  it("sp-1.6.0 teaches winding paths, ragged natural contours and deep water channels", () => {
    expect(SYSTEM_PROMPT).toMatch(/wind and vary in width/);
    expect(SYSTEM_PROMPT).toMatch(/edge "ragged"/);
    expect(SYSTEM_PROMPT).toMatch(/at least a tile deep/);
  });
  it("sp-1.5.0 teaches raised decks on supports, connected kerbed paths, the water plane and outcrops", () => {
    expect(SYSTEM_PROMPT).toMatch(/Raised platform on supports/);
    expect(SYSTEM_PROMPT).toContain("connect: [an area, a feature or a cell");
    expect(SYSTEM_PROMPT).toMatch(/one board-wide water plane/);
    expect(SYSTEM_PROMPT).toMatch(/Outcrops are rock masses/);
  });
  it("sp-1.4.0 teaches theme-neutral set dressing: principles, slots, presets, asset discovery and a final look", () => {
    expect(SYSTEM_PROMPT).toContain("# Set dressing, lighting and density");
    expect(SYSTEM_PROMPT).toMatch(/Big pieces first, then medium, then garnish/);
    expect(SYSTEM_PROMPT).toMatch(/Cluster and overlap/);
    expect(SYSTEM_PROMPT).toMatch(/Dress every edge/);
    expect(SYSTEM_PROMPT).toMatch(/Open space is deliberate/); // sp-1.10.0: in the design principles
    expect(SYSTEM_PROMPT).toMatch(/One dominant material/); // sp-1.10.0: in the design principles
    expect(SYSTEM_PROMPT).toMatch(/A forest hillside/);
    expect(SYSTEM_PROMPT).toMatch(/A ruined temple/);
    expect(SYSTEM_PROMPT).toMatch(/A cave:/);
    expect(SYSTEM_PROMPT).toMatch(/custom_resolved/);
    expect(SYSTEM_PROMPT).toMatch(/flat.*pale.*repetitive.*littered/);
    // the interim cave-heavy wording is gone from the current prompt, kept only in sp-1.3.0
    expect(SYSTEM_PROMPT).not.toMatch(/layer two presets on a large cave/);
    expect(systemPromptFor("sp-1.3.0")).toMatch(/layer two presets on a large cave/);
  });
  it("sp-1.3.0 teaches vertical structure in every setting", () => {
    expect(SYSTEM_PROMPT).toContain("# Height, structure and spans");
    expect(SYSTEM_PROMPT).toMatch(/at least three distinct heights/);
    expect(SYSTEM_PROMPT).toMatch(/platform terrain op/);
    expect(SYSTEM_PROMPT).toMatch(/stairs terrain op/);
    expect(SYSTEM_PROMPT).toMatch(/inclined span/);
    expect(SYSTEM_PROMPT).toMatch(/is this one flat plane/);
    // principles, not a cave manual: outdoor and built-interior examples sit beside the cave one
    expect(SYSTEM_PROMPT).toMatch(/outdoors, a grass plateau/);
    expect(SYSTEM_PROMPT).toMatch(/in a temple/);
  });
  it("sp-1.2.0 (unreleased predecessor) still teaches depth: chasms, bridges, daises, ASCII heights, no_effect and the request checklist", () => {
    const SYSTEM_PROMPT = systemPromptFor("sp-1.2.0") ?? "";
    expect(SYSTEM_PROMPT).toContain("# Depth, chasms and bridges");
    expect(SYSTEM_PROMPT).toMatch(/use one chasm terrain op/);
    expect(SYSTEM_PROMPT).toMatch(/Never fake a chasm with a paint or path op/);
    expect(SYSTEM_PROMPT).toMatch(/kind "bridge"/);
    expect(SYSTEM_PROMPT).toMatch(/height terrain op with layer "over"/);
    expect(SYSTEM_PROMPT).toMatch(/"_" is floor below/);
    expect(SYSTEM_PROMPT).toMatch(/no_effect/);
    expect(SYSTEM_PROMPT).toContain("# Set dressing, lighting and density");
    expect(SYSTEM_PROMPT).toContain("# Finishing a turn");
    expect(SYSTEM_PROMPT).toMatch(/go through their request item by item/);
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
