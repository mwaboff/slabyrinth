import { describe, expect, it } from "vitest";
import {
  createProgressTracker,
  extractJsonObject,
  jsonProtocolSection,
  jsonToolResultsText,
  mergeBrief,
  briefHash,
  parseJsonReply,
  rejectionText,
  sessionStartText,
  toolsForConversation,
} from "../../../src/agent";
import { loadPlan } from "../../fixtures";

describe("JSON reply protocol", () => {
  it("embeds every tool schema", () => {
    const s = jsonProtocolSection(toolsForConversation(false));
    expect(s).toContain("## edit_plan");
    expect(s).not.toContain("## view_map_image");
    expect(s).toContain('"say"');
  });

  it("extracts the first balanced object, tolerating fences and braces in strings", () => {
    expect(extractJsonObject('Sure!\n```json\n{"say":"a}b","calls":[]}\n```')).toBe(
      '{"say":"a}b","calls":[]}',
    );
    expect(extractJsonObject('x {"a":{"b":1}} y {"c":2}')).toBe('{"a":{"b":1}}');
    expect(extractJsonObject("no json here")).toBeNull();
  });

  it("validates calls with the same schemas as native tools", () => {
    const ok = parseJsonReply(
      '{"say":"Looking.","calls":[{"tool":"view_plan","input":{"format":"outline"}}]}',
    );
    expect(ok).toEqual({
      kind: "reply",
      say: "Looking.",
      calls: [{ tool: "view_plan", input: { format: "outline" } }],
    });
    const bad = parseJsonReply('{"say":"","calls":[{"tool":"view_plan","input":{"format":"svg"}}]}');
    expect(bad.kind).toBe("invalid");
    if (bad.kind === "invalid") expect(bad.errors[0]?.path).toBe("/calls/0/input/format");
    expect(parseJsonReply('{"say": "cut off", "calls": [').kind).toBe("invalid");
    expect(parseJsonReply("Just chatting.")).toEqual({ kind: "text", say: "Just chatting." });
    expect(parseJsonReply('{"calls":[{"tool":"rm_rf","input":{}}]}', ["view_plan"]).kind).toBe("invalid");
  });

  it("renders tool results as one text block", () => {
    const t = jsonToolResultsText([
      {
        callId: "c1",
        name: "view_plan",
        isError: false,
        content: [
          { type: "text", text: "PLAN v1" },
          { type: "image", mediaType: "image/png", dataBase64: "AA" },
        ],
      },
    ]);
    expect(t).toBe(
      "TOOL RESULTS\n## view_plan (c1) OK\nPLAN v1\n[image omitted: this model does not read images]",
    );
  });
});

describe("progress parser", () => {
  it("reports levels, openings, furnishing and notes from a streamed create_plan", () => {
    const plan = loadPlan("example-a");
    const json = JSON.stringify({ replace: false, summary: "Draft", plan });
    const tracker = createProgressTracker("create_plan", 200);
    expect(tracker).not.toBeNull();
    const events = [];
    for (let i = 0; i < json.length; i += 97) events.push(...(tracker?.push(json.slice(i, i + 97)) ?? []));
    events.push(...(tracker?.finish() ?? []));
    const steps = events.map((e) => e.step);
    expect(steps[0]).toBe("laying_out_level");
    expect(steps).toContain("placing_openings");
    expect(steps).toContain("furnishing");
    expect(events.filter((e) => e.step === "laying_out_level").length).toBe(plan.levels.length);
  });

  it("classifies edit ops and ignores other tools", () => {
    const tracker = createProgressTracker("edit_plan", 1);
    const ev =
      tracker?.push(
        '{"ops":[{"op":"add_features","level":"l1","features":[]},{"op":"update","id":"a","set":{"notes":"x"}}]}',
      ) ?? [];
    expect(ev.map((e) => e.step)).toEqual(["furnishing", "writing_notes"]);
    expect(createProgressTracker("view_plan")).toBeNull();
  });
});

describe("report and context texts", () => {
  it("formats a rejection exactly as §3.4", () => {
    expect(
      rejectionText("edit_plan", 7, [
        { op: 2, code: "unknown_id", msg: 'no element "hal"', hint: 'did you mean "hall"?' },
      ]),
    ).toBe(
      '{"status":"rejected","version":7,"errors":[{"op":2,"code":"unknown_id","msg":"no element \\"hal\\"","hint":"did you mean \\"hall\\"?"}]}\n' +
        "REJECTED: nothing was applied; the plan is still v7. Fix all errors and call edit_plan again.",
    );
  });

  it("brief merge and hash", () => {
    const m = mergeBrief(
      { mapType: { value: "Cave", source: "user" } },
      { mapType: "Dungeon", tone: "eerie" },
    );
    expect(m.skipped).toEqual(["mapType"]);
    expect(m.updated).toEqual(["tone"]);
    expect(briefHash(m.brief)).toBe(briefHash(structuredClone(m.brief)));
  });

  it("session start lists themes and the asset source, never dates of its own", () => {
    const t = sessionStartText({
      themes: [{ id: "cave", name: "Natural cave" }],
      builtInAssetsOnly: true,
      scannedAt: null,
      brief: {},
      plan: null,
      head: 0,
    });
    expect(t).toBe(
      'Installed themes: cave "Natural cave".\nAsset library: built-in set (TaleSpire install not found).\nCurrent brief: {}.\nPlan: none yet.',
    );
  });
});
