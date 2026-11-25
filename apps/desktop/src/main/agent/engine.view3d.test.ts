/**
 * The model's 3D pictures in whole conversations with the fake model (no network): the one look after a first draft,
 * view_build_3d asked for and answered with a sheet that reaches the provider as an image block, the revision that
 * follows, the per-message budget, 3D off, a generator-5 conversation (released tools) that never sees any of it,
 * older pictures replaced by their captions once a newer version is built, Stop while a picture is being made, the
 * changes-per-message limit, and the picture in the pre-send cost estimate.
 */
import { describe, expect, it } from "vitest";
import {
  DROPPED_PICTURE_TEXT,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_VERSION,
  TOOLS_VERSION,
  type Render3dRequest,
  type Render3dResult,
} from "@slabyrinth/core/agent";
import type { AppSettings } from "../../shared/project";
import { indexElements } from "@slabyrinth/core/plan";
import type { Finding, Scene } from "@slabyrinth/scene3d";
import { findingsText, type PlannedKind } from "../../shared/view3dPictures";
import { SlabyrinthConversationEngine } from "./engine";
import { SHEET_TOKENS, trimStalePictures } from "./pictures";
import { BetaFlags } from "./provider/anthropic/betas";
import { modelSpec } from "./provider/anthropic/models";
import { buildRequest } from "./provider/anthropic/render";
import { DefaultProviderRegistry } from "./provider/registry";
import type { ChatItem, StepRequest } from "./provider/types";
import { MemoryHost, defaultSettings, newProject } from "./testing/memoryHost";
import { ScriptedProvider, call, say, type ScriptedStep } from "./testing/scriptedProvider";

const PLAN = {
  title: "Roadside Inn",
  kind: "building",
  theme: "stone_dungeon",
  levels: [
    {
      id: "l1",
      name: "Ground",
      elevation: 0,
      bounds: { x: 0, y: 0, w: 16, h: 10 },
      base: { type: "solid" },
      areas: [
        { id: "tap", kind: "room", name: "Taproom", shape: { type: "rect", x: 1, y: 1, w: 6, h: 5 } },
        { id: "kitchen", kind: "room", name: "Kitchen", shape: { type: "rect", x: 7, y: 1, w: 6, h: 5 } },
      ],
      openings: [{ id: "d1", kind: "door", between: ["tap", "kitchen"] }],
      features: [],
    },
  ],
  links: [],
};

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** A host whose scene worker answers with a fixed sheet, captions per view asked and one measured finding. */
class PictureHost extends MemoryHost {
  asked: Render3dRequest[] = [];
  hang = false;
  /** When set, every picture carries this one measured finding, worded and marked by the app's own findingsText. */
  finding: { owner: string; message: string } | null = null;
  render3d(req: Render3dRequest, signal: AbortSignal): Promise<Render3dResult> {
    if (this.finding) {
      this.asked.push(req);
      const plan = this.getPlan();
      const index = plan ? indexElements(plan) : null;
      const kindOf: PlannedKind = (id) => index?.get(id)?.kind ?? null;
      const b = { min: { x: 3, y: 0, z: 1 }, max: { x: 4, y: 1, z: 2 } };
      const scene = {
        levels: [{ id: "l1", name: "Ground", index: 0, bounds: b }],
        instances: [{ aabb: b }],
      } as unknown as Scene;
      const f: Finding = {
        code: "floating",
        severity: "fault",
        where: { levelId: "l1", levelIndex: 0, box: b, cells: [[3, 1]], elementId: null },
        pieces: [{ index: 0, name: "Boulder", uuid: "u", elementId: this.finding.owner }],
        measure: {},
        message: this.finding.message,
      };
      return Promise.resolve({
        png: PNG,
        captions: ["1. The whole map"],
        suggestions: findingsText(scene, [f], [new Set([0])], kindOf),
      });
    }
    return this.fixedPicture(req, signal);
  }
  private fixedPicture(req: Render3dRequest, signal: AbortSignal): Promise<Render3dResult> {
    this.asked.push(req);
    if (this.hang)
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("stopped"));
        });
      });
    const shots = req.shots ?? ["overview"];
    return Promise.resolve({
      png: PNG,
      captions: shots.map((s, i) => `${String(i + 1)}. ${s}`),
      suggestions:
        "Measured on the pieces in view (faults first):\n- view 1, level l1, tap, square 3,1: a 0.4-tile gap in tap's wall where no opening is planned\nOther views: interior:tap.",
    });
  }
}

const settingsWith = (agent: Partial<NonNullable<AppSettings["agent"]>>): AppSettings => ({
  ...defaultSettings(),
  agent: { maxRevisionsPerTurn: 4, view3d: true, maxPicturesPerTurn: 6, ...agent },
});

function setup(
  steps: ScriptedStep[] | ((req: StepRequest, i: number) => ScriptedStep),
  o: { settings?: AppSettings; released?: boolean; cacheColdMs?: number } = {},
) {
  const provider = new ScriptedProvider(steps);
  // a conversation started now (generator 6's working texts), or on the 0.4.0 release's texts (generator 5)
  const project = newProject(undefined, {
    systemPromptVersion: o.released ? "sp-1.14.0" : SYSTEM_PROMPT_VERSION,
    toolsVersion: o.released ? "tools-1.10.0" : TOOLS_VERSION,
    imageToolEnabled: true,
    toolMode: "native",
  });
  const host = new PictureHost(project, { settings: o.settings ?? settingsWith({}) });
  let n = 0;
  const engine = new SlabyrinthConversationEngine(host, {
    registry: new DefaultProviderRegistry([provider]),
    newId: () => `id${String(++n)}`,
    sleep: () => Promise.resolve(),
    random32: () => 42,
    ...(o.cacheColdMs !== undefined ? { cacheColdMs: o.cacheColdMs } : {}),
  });
  return { provider, host, engine };
}

type Result = Extract<ChatItem, { type: "tool_results" }>["results"][number];
function resultOf(host: MemoryHost, callId: string): Result | undefined {
  for (const it of host.conv().items)
    if (it.type === "tool_results") for (const r of it.results) if (r.callId === callId) return r;
  return undefined;
}
const textOf = (r: Result | undefined): string =>
  (r?.content ?? []).map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
const hasImage = (r: Result | undefined): boolean => (r?.content ?? []).some((c) => c.type === "image");
const imagesSent = (req: StepRequest | undefined): number =>
  (req?.transcript ?? []).reduce(
    (n, it) =>
      n +
      (it.type === "tool_results"
        ? it.results.reduce((m, r) => m + r.content.filter((c) => c.type === "image").length, 0)
        : 0),
    0,
  );

const draft = (id = "c1") =>
  call("create_plan", { replace: false, summary: "Inn", changes: ["Taproom and kitchen"], plan: PLAN }, id);
const rename = (base: number, id: string, name: string) =>
  call(
    "edit_plan",
    {
      baseVersion: base,
      summary: "Renamed the taproom",
      changes: [`Taproom is now ${name}`],
      ops: [{ op: "update", id: "tap", set: { name } }],
    },
    id,
  );

describe("3D pictures in a conversation", () => {
  it("first draft gets one overview; the model asks for a view, gets a sheet with findings, and revises", async () => {
    const { provider, host, engine } = setup([
      { kind: "reply", parts: [draft()] },
      { kind: "reply", parts: [call("view_build_3d", { shots: ["front:tap", "interior:tap"] }, "v1")] },
      { kind: "reply", parts: [rename(1, "e1", "Common room")] },
      { kind: "reply", parts: [say("Closed the gap and renamed the room.")] },
    ]);
    await engine.send({ text: "An inn by the road", intent: "plan" });
    await engine.whenIdle();

    // the one look: an overview of a one-level map, appended to the create_plan result
    expect(host.asked[0]).toEqual({ shots: ["overview"], max: 1 });
    const look = resultOf(host, "c1");
    expect(hasImage(look)).toBe(true);
    expect(textOf(look)).toContain("3D PICTURE of plan v1: the app's one look at your first draft");
    // the model's own request: its views, a sheet, captions and the measured finding with its place
    expect(host.asked[1]).toEqual({ shots: ["front:tap", "interior:tap"] });
    const sheet = resultOf(host, "v1");
    expect(sheet?.isError).toBe(false);
    expect(hasImage(sheet)).toBe(true);
    expect(textOf(sheet)).toContain("1. front:tap\n2. interior:tap");
    expect(textOf(sheet)).toContain("level l1, tap, square 3,1: a 0.4-tile gap");
    // the revision after it
    expect(host.project?.history.head).toBe(2);
    expect(host.eventsOf("turn_finished")[0]?.stopReason).toBe("end_turn");

    // the step after the look sends both pictures, as the SDK's base64 image blocks inside tool_result blocks
    const req = provider.requests[2];
    expect(imagesSent(req)).toBe(2);
    if (!req) throw new Error("no request");
    const { params } = buildRequest(req, {
      spec: modelSpec(req.selection.modelId),
      flags: new BetaFlags([]),
      effortSupported: true,
      cacheTtl: "5m",
      bindingBehavior: "drop_block",
    });
    const blocks = params.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const viewResult = blocks.find((b) => b.type === "tool_result" && b.tool_use_id === "v1");
    expect(viewResult).toMatchObject({
      type: "tool_result",
      tool_use_id: "v1",
      content: [
        { type: "text" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        { type: "text" },
      ],
    });
    // the tool and its guidance are in what the model was given
    expect(req.tools.map((t) => t.name)).toContain("view_build_3d");
    expect(req.systemPrompt).toContain("# Looking at the build in 3D");
  });

  it("a map of several levels gets an overview and up to three levels from above", async () => {
    const tall = {
      ...PLAN,
      levels: [
        PLAN.levels[0],
        { ...PLAN.levels[0], id: "l2", name: "Upstairs", elevation: 2.5, areas: [], openings: [] },
      ],
    };
    const { host, engine } = setup([
      {
        kind: "reply",
        parts: [call("create_plan", { replace: false, summary: "Inn", plan: tall }, "c1")],
      },
      { kind: "reply", parts: [say("Done.")] },
    ]);
    await engine.send({ text: "two floors", intent: "plan" });
    await engine.whenIdle();
    expect(host.project?.history.head).toBe(1);
    expect(host.asked).toEqual([{ shots: ["overview", "level:l1", "level:l2"], max: 3 }]);
  });

  it("past the message's budget the tool refuses in plain words; the next message has a new budget", async () => {
    const { host, engine } = setup(
      [
        { kind: "reply", parts: [draft()] },
        { kind: "reply", parts: [call("view_build_3d", {}, "v1")] },
        { kind: "reply", parts: [say("Out of pictures.")] },
        { kind: "reply", parts: [call("view_build_3d", { shots: ["flagged"] }, "v2")] },
        { kind: "reply", parts: [say("Looked.")] },
      ],
      { settings: settingsWith({ maxPicturesPerTurn: 1 }) },
    );
    await engine.send({ text: "draft it", intent: "plan" });
    await engine.whenIdle();
    const refused = resultOf(host, "v1");
    expect(refused?.isError).toBe(true);
    expect(textOf(refused)).toContain("no more 3D pictures for this message (the GM allows 1 per message)");
    expect(textOf(refused)).toContain("next message");
    expect(host.asked).toHaveLength(1);
    await engine.send({ text: "look again", intent: "plan" });
    await engine.whenIdle();
    expect(hasImage(resultOf(host, "v2"))).toBe(true);
  });

  it("with 3D off there is no look and the tool says so", async () => {
    const { host, engine } = setup(
      [
        { kind: "reply", parts: [draft()] },
        { kind: "reply", parts: [call("view_build_3d", {}, "v1")] },
        { kind: "reply", parts: [say("ok")] },
      ],
      { settings: settingsWith({ view3d: false }) },
    );
    await engine.send({ text: "draft it", intent: "plan" });
    await engine.whenIdle();
    expect(host.asked).toEqual([]);
    expect(hasImage(resultOf(host, "c1"))).toBe(false);
    expect(textOf(resultOf(host, "v1"))).toContain("3D pictures are not available now");
  });

  it("a generator-5 conversation (released texts) never sees the tool, its guidance or the look", async () => {
    const { provider, host, engine } = setup(
      [
        { kind: "reply", parts: [draft()] },
        { kind: "reply", parts: [say("Done.")] },
      ],
      { released: true },
    );
    await engine.send({ text: "draft it", intent: "plan" });
    await engine.whenIdle();
    expect(host.project?.history.head).toBe(1);
    expect(host.asked).toEqual([]);
    expect(hasImage(resultOf(host, "c1"))).toBe(false);
    for (const req of provider.requests) {
      expect(req.tools.map((t) => t.name)).not.toContain("view_build_3d");
      expect(req.systemPrompt).not.toContain("view_build_3d");
      expect(req.systemPrompt).not.toBe(SYSTEM_PROMPT);
    }
  });

  it("once a newer version is built, older pictures are replaced by their captions at the next message", async () => {
    const steps: ScriptedStep[] = [
      { kind: "reply", parts: [draft()] },
      { kind: "reply", parts: [say("Draft.")] },
      { kind: "reply", parts: [rename(1, "e1", "Common room")] },
      { kind: "reply", parts: [say("Renamed.")] },
      { kind: "reply", parts: [say("Anything else?")] },
    ];
    // a cold cache (cacheColdMs 0): every stale picture goes at the start of a message
    const { provider, host, engine } = setup(steps, { cacheColdMs: 0 });
    await engine.send({ text: "draft it", intent: "plan" });
    await engine.whenIdle();
    await engine.send({ text: "rename the taproom", intent: "plan" });
    await engine.whenIdle();
    // the rename turn still had the v1 picture (never trimmed mid-turn or before a newer version exists)
    expect(imagesSent(provider.requests[2])).toBe(1);
    await engine.send({ text: "thanks", intent: "chat" });
    await engine.whenIdle();
    const look = resultOf(host, "c1");
    expect(hasImage(look)).toBe(false);
    expect(textOf(look)).toContain("3D PICTURE of plan v1");
    expect(textOf(look)).toContain(DROPPED_PICTURE_TEXT);
    expect(imagesSent(provider.requests[4])).toBe(0);
  });

  it("while the cache is warm, up to four stale pictures stay; beyond that the oldest go", () => {
    const pic = (v: number, id: string): ChatItem => ({
      type: "tool_results",
      id,
      turnId: "t",
      createdAt: "",
      results: [
        {
          callId: id,
          name: "view_build_3d",
          isError: false,
          content: [
            { type: "text", text: `3D PICTURE of plan v${String(v)} (flat colours).\n1. overview` },
            { type: "image", mediaType: "image/png", dataBase64: "AA==" },
          ],
        },
      ],
    });
    const items = [1, 2, 3, 4, 5, 6, 7].map((v) => pic(v, `p${String(v)}`));
    expect(trimStalePictures(items, 7, false)).toBe(2);
    const kept = items.map((it) =>
      it.type === "tool_results" && it.results[0]?.content.some((c) => c.type === "image") ? 1 : 0,
    );
    expect(kept).toEqual([0, 0, 1, 1, 1, 1, 1]);
    expect(trimStalePictures(items, 7, true)).toBe(4);
    expect(trimStalePictures(items, 7, true)).toBe(0);
    // after an undo to v5, the picture of v7 no longer shows the map either
    const undone = [5, 7].map((v) => pic(v, `u${String(v)}`));
    expect(trimStalePictures(undone, 5, true)).toBe(1);
    expect(undone.map((it) => (it.type === "tool_results" ? it.results[0]?.content.length : 0))).toEqual([
      2, 2,
    ]);
    expect(
      undone.map(
        (it) => it.type === "tool_results" && it.results[0]?.content.some((c) => c.type === "image"),
      ),
    ).toEqual([true, false]);
  });

  it("two first drafts in one step get one look", async () => {
    const { host, engine } = setup([
      {
        kind: "reply",
        parts: [draft("c1"), call("create_plan", { replace: true, summary: "Inn again", plan: PLAN }, "c2")],
      },
      { kind: "reply", parts: [say("Done.")] },
    ]);
    await engine.send({ text: "draft it twice", intent: "plan" });
    await engine.whenIdle();
    expect(host.asked).toHaveLength(1);
    expect(hasImage(resultOf(host, "c1"))).toBe(true);
    expect(hasImage(resultOf(host, "c2"))).toBe(false);
  });

  it("Stop while a picture is being made ends the turn and the picture is not counted", async () => {
    const { host, engine } = setup([
      { kind: "reply", parts: [draft()] },
      { kind: "reply", parts: [say("unused")] },
    ]);
    host.hang = true;
    const { turnId } = await engine.send({ text: "draft it", intent: "plan" });
    for (let i = 0; i < 50 && host.asked.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(host.asked).toHaveLength(1);
    await engine.cancel(turnId);
    expect(host.eventsOf("turn_finished").at(-1)?.stopReason).toBe("cancelled");
    // the draft itself was kept, without a picture
    expect(host.project?.history.head).toBe(1);
    expect(hasImage(resultOf(host, "c1"))).toBe(false);
  });

  it("the look counts inside the changes-per-message limit's turn and is kept when the limit stops it", async () => {
    const { host, engine } = setup(
      [
        { kind: "reply", parts: [draft()] },
        { kind: "reply", parts: [say("unused")] },
      ],
      { settings: settingsWith({ maxRevisionsPerTurn: 1 }) },
    );
    await engine.send({ text: "draft it", intent: "plan" });
    await engine.whenIdle();
    expect(host.eventsOf("turn_finished")[0]?.stopReason).toBe("revision_limit");
    expect(hasImage(resultOf(host, "c1"))).toBe(true);
  });

  it("the pre-send estimate of a first draft includes the look's picture", async () => {
    const on = setup([]);
    const off = setup([], { settings: settingsWith({ view3d: false }) });
    // the model list is cached on the first send of each engine; estimate needs the descriptor
    const a = await on.engine.estimate({ text: "draw it", intent: "plan" });
    const b = await off.engine.estimate({ text: "draw it", intent: "plan" });
    expect(a.costUsd).not.toBeNull();
    // the estimate is rounded up a ladder ($0.01, 0.02, 0.05 …), so one sheet (≈ $0.005 written) may not show
    expect(a.costUsd ?? 0).toBeGreaterThanOrEqual(b.costUsd ?? 0);
    expect(SHEET_TOKENS).toBe(1049);
  });
});

/**
 * A fake model that does what the guidance says with the measured faults: an edit for a "Plan fix" it has not tried
 * yet, then one look to see it; nothing for what the app placed; never a second revision for the same finding.
 */
function guidedModel(): (req: StepRequest, i: number) => ScriptedStep {
  const tried = new Set<string>();
  let looks = 0;
  let edits = 0;
  return (req) => {
    const last = req.transcript.at(-1);
    if (last?.type !== "tool_results") {
      // a new message: the first one asks for a draft, a later one about the map gets one look
      const drafted = req.transcript.some((it) => it.type === "tool_results");
      return { kind: "reply", parts: [drafted ? call("view_build_3d", {}, "look0") : draft()] };
    }
    const r = last.results[0];
    const text = (r?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
    if (r?.name === "edit_plan") {
      looks++;
      return {
        kind: "reply",
        parts: [call("view_build_3d", { shots: ["changed"] }, `look${String(looks)}`)],
      };
    }
    const lines = text.split("\n").filter((l) => l.startsWith("- view"));
    const fixable = lines.filter((l) => l.includes("Plan fix:"));
    const fresh = fixable.find((l) => !tried.has(l.slice(l.indexOf(": ") + 2)));
    if (fresh !== undefined) {
      tried.add(fresh.slice(fresh.indexOf(": ") + 2));
      edits++;
      return { kind: "reply", parts: [rename(edits, `e${String(edits)}`, `Room ${String(edits)}`)] };
    }
    const left =
      lines.length > 0 ? " One thing in the 3D view is the app's or did not change with my fix." : "";
    return { kind: "reply", parts: [say(`Done.${left}`)] };
  };
}

describe("measured faults the plan cannot fix (no loop)", () => {
  const withAltar = {
    ...PLAN,
    levels: [{ ...PLAN.levels[0], features: [{ id: "altar", type: "altar", at: [9, 3] }] }],
  };

  it("an app-placed fault comes back on every look: the model edits nothing for it and the turn ends", async () => {
    const { provider, host, engine } = setup(guidedModel());
    host.finding = { owner: "rubble_scatter", message: "a boulder floats 0.3 tiles above the floor" };
    await engine.send({ text: "draft it", intent: "plan" });
    await engine.whenIdle();
    const look = textOf(resultOf(host, "c1"));
    expect(look).toContain("The app placed this: a plan change will not fix it");
    // the GM asks about it: one look, the same fault, still the app's: no edit, no loop
    await engine.send({ text: "the boulder floats, can you fix it?", intent: "plan" });
    await engine.whenIdle();
    expect(textOf(resultOf(host, "look0"))).toContain("The app placed this");
    expect(host.project?.history.head).toBe(1);
    expect(host.asked).toHaveLength(2);
    expect(host.eventsOf("turn_finished").map((e) => e.stopReason)).toEqual(["end_turn", "end_turn"]);
    expect(provider.requests.length).toBeLessThan(6);
  });

  it("a plan-fixable fault that stays after one fix gets one revision, then the GM is told", async () => {
    const steps = guidedModel();
    const { host, engine } = setup((req, i) => {
      const s = steps(req, i);
      // the draft carries the altar the finding is on
      if (s.kind === "reply" && s.parts[0]?.type === "tool_call" && s.parts[0].name === "create_plan")
        return {
          kind: "reply",
          parts: [call("create_plan", { replace: false, summary: "Inn", plan: withAltar }, "c1")],
        };
      return s;
    });
    host.finding = { owner: "altar", message: "the altar floats 0.3 tiles above the floor" };
    await engine.send({ text: "draft it", intent: "plan" });
    await engine.whenIdle();
    expect(textOf(resultOf(host, "c1"))).toContain("Plan fix: move it or pick another support for it.");
    // one revision for the finding, one look at it, then the turn ends (well inside the changes-per-message limit)
    expect(host.project?.history.head).toBe(2);
    expect(host.asked).toHaveLength(2);
    expect(host.eventsOf("turn_finished").map((e) => e.stopReason)).toEqual(["end_turn"]);
  });
});
