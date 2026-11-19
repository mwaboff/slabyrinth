import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import {
  INVALID_JSON_KEY,
  createToolExecutor,
  defaultExecutorPorts,
  invalidJsonInput,
  type AgentToolContext,
  type ExecutorPorts,
} from "../../../src/agent";
import { loadPlan } from "../../fixtures";

const exec = createToolExecutor();

function authored(plan: MapPlan): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...plan };
  delete rest["schema"];
  delete rest["generator"];
  delete rest["id"];
  return rest;
}

function ctx(
  plan: MapPlan | null,
  head = plan ? 3 : 0,
  over: Partial<AgentToolContext> = {},
): AgentToolContext {
  return {
    plan,
    head,
    brief: {},
    renderImage: null,
    estimate: (p) => ({
      perLevel: p.levels.map((l) => ({ levelId: l.id, assets: 12, estimatedChunks: 1 })),
      totalAssets: 12,
      estimatedChunks: 1,
      diagnostics: [],
    }),
    catalog: {
      themes: [{ id: "stone_dungeon", name: "Stone dungeon" }],
      featureCoverage: () => ({ bed: true, rug: true }),
    },
    newSeed: () => 1234,
    newPlanId: () => "00000000-0000-4000-8000-000000000001",
    ...over,
  };
}

function text(o: { content: Array<{ type: string; text?: string }> }): string {
  return o.content.map((c) => c.text ?? "").join("\n");
}

describe("create_plan", () => {
  it("accepts a fixture plan, fills app-owned fields and reports the new version", async () => {
    const out = await exec(ctx(null, 0, { nextVersion: 1 }), "create_plan", {
      replace: false,
      summary: "First draft",
      plan: authored(loadPlan("two-rooms-door")),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.newPlan?.cause).toBe("create");
    expect(out.newPlan?.plan.id).toBe("00000000-0000-4000-8000-000000000001");
    const report = JSON.parse(firstLine(out)) as {
      status: string;
      version: number;
      added: string[];
    };
    expect(report).toMatchObject({ status: "applied", version: 1 });
    expect(report.added).toContain("front");
  });

  it("fills omitted level lists and seed", async () => {
    const out = await exec(ctx(null), "create_plan", {
      replace: false,
      summary: "Tiny",
      plan: {
        title: "Tiny",
        kind: "dungeon",
        theme: "stone_dungeon",
        levels: [
          {
            id: "l1",
            name: "One",
            elevation: 0,
            bounds: { x: 0, y: 0, w: 8, h: 8 },
            base: { type: "solid" },
            areas: [{ id: "r1", kind: "room", shape: { type: "rect", x: 1, y: 1, w: 4, h: 4 } }],
          },
        ],
        links: [],
      },
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.newPlan?.plan.seed).toBe(1234);
  });

  it("numbers unnumbered rooms like adding them would (entry level first), keeps given numbers", async () => {
    const lvl = (id: string, elevation: number, areas: unknown[]) => ({
      id,
      name: id,
      elevation,
      bounds: { x: 0, y: 0, w: 12, h: 8 },
      base: { type: "solid" },
      areas,
    });
    const rect = (x: number) => ({ type: "rect", x, y: 1, w: 3, h: 3 });
    const out = await exec(ctx(null), "create_plan", {
      replace: false,
      summary: "Two levels",
      plan: {
        title: "Two levels",
        kind: "dungeon",
        theme: "stone_dungeon",
        entryLevel: "up",
        levels: [
          lvl("down", -2.5, [{ id: "d1", kind: "cave", shape: rect(1) }]),
          lvl("up", 0, [
            { id: "u1", kind: "room", shape: rect(1) },
            {
              id: "c1",
              kind: "corridor",
              shape: {
                type: "path",
                points: [
                  [4, 2],
                  [5, 2],
                ],
                width: 1,
              },
            },
            { id: "u2", kind: "room", key: "9", shape: rect(6) },
          ]),
        ],
        links: [],
      },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const keys = Object.fromEntries(
      (out.newPlan?.plan.levels ?? []).flatMap((l) => l.areas.map((a) => [a.id, a.key])),
    );
    expect(keys).toEqual({ d1: "11", u1: "10", c1: undefined, u2: "9" });
    // the result the model reads shows the assigned numbers
    expect(text(out)).toContain("[10]");
  });

  it("refuses to replace an existing plan without replace: true", async () => {
    const plan = loadPlan("two-rooms-door");
    const out = await exec(ctx(plan), "create_plan", {
      replace: false,
      summary: "Again",
      plan: authored(plan),
    });
    expect(out.ok).toBe(false);
    expect(text(out)).toContain('"code":"plan_exists"');
    expect(text(out)).toContain("REJECTED: nothing was applied; the plan is still v3.");
  });

  it("rejects an invalid plan with paths and hints, leaving nothing applied", async () => {
    const plan = authored(loadPlan("two-rooms-door")) as { levels: Array<{ areas: Array<{ id: string }> }> };
    const area = plan.levels[0]?.areas[0];
    if (area) area.id = "Bad Id";
    const out = await exec(ctx(null), "create_plan", { replace: false, summary: "Broken", plan });
    expect(out.ok).toBe(false);
    const t = text(out);
    expect(t).toMatch(/"status":"rejected","version":0/);
    expect(t).toContain("/plan/levels/0/areas/0/id");
    expect(t).toContain("hint");
    expect(t).toContain("there is still no plan");
  });
});

describe("edit_plan", () => {
  const plan = loadPlan("two-rooms-door");

  it("applies ops transactionally and returns the change report plus a view", async () => {
    const out = await exec(ctx(plan, 3), "edit_plan", {
      baseVersion: 3,
      summary: "Notes for the front room",
      changes: ["Wrote GM notes for 1"],
      ops: [{ op: "update", id: "front", set: { notes: "A dusty entry hall." } }],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.newPlan?.cause).toBe("ops");
    expect(out.newPlan?.ops).toHaveLength(1);
    expect(text(out)).toMatch(/^\{"status":"applied","version":4,"updated":\["front"\]/);
    expect(out.content.length).toBe(2);
  });

  it("rejects an unknown id with the op index and a hint, plan unchanged", async () => {
    const out = await exec(ctx(plan, 3), "edit_plan", {
      baseVersion: 3,
      summary: "x",
      changes: [],
      ops: [
        { op: "update", id: "front", set: { notes: "ok" } },
        { op: "update", id: "frnt", set: { notes: "typo" } },
      ],
    });
    expect(out.ok).toBe(false);
    const t = text(out);
    expect(t).toMatch(/\{"op":1,"code":"unknown_id"/);
    expect(t).toContain(
      "REJECTED: nothing was applied; the plan is still v3. Fix all errors and call edit_plan again.",
    );
  });

  it("reports stale_version with the changes since the base and a fresh outline", async () => {
    const older = structuredClone(plan);
    const first = older.levels[0]?.features[0];
    if (first) first.at = [2, 2];
    const out = await exec(ctx(plan, 5, { planAt: () => older }), "edit_plan", {
      baseVersion: 4,
      summary: "x",
      changes: [],
      ops: [{ op: "renumber" }],
    });
    expect(out.ok).toBe(false);
    const t = text(out);
    expect(t).toContain('"code":"stale_version"');
    expect(t).toContain("Changes since v4: bed");
    expect(t).toContain("PLAN v5");
  });

  it("validates ops against the schema before running (op index in the error)", async () => {
    const out = await exec(ctx(plan, 3), "edit_plan", {
      baseVersion: 3,
      summary: "x",
      changes: [],
      ops: [{ op: "renumber" }, { op: "teleport", id: "front" }],
    });
    expect(out.ok).toBe(false);
    expect(text(out)).toMatch(/"op":1/);
  });

  it("answers no_plan when there is nothing to edit", async () => {
    const out = await exec(ctx(null), "edit_plan", {
      baseVersion: 0,
      summary: "x",
      changes: [],
      ops: [{ op: "renumber" }],
    });
    expect(out.ok).toBe(false);
    expect(text(out)).toContain("no_plan");
  });

  it("dedupes and caps errors at 20 with the total", async () => {
    const ops = Array.from({ length: 30 }, (_, i) => ({
      op: "update",
      id: `missing${i}`,
      set: { notes: "x" },
    }));
    const out = await exec(ctx(plan, 3), "edit_plan", { baseVersion: 3, summary: "x", changes: [], ops });
    expect(out.ok).toBe(false);
    const header = JSON.parse(text(out).split("\n")[0] ?? "{}") as { errors: unknown[]; total?: number };
    expect(header.errors.length).toBeLessThanOrEqual(20);
    if (header.errors.length === 20) expect(header.total).toBeGreaterThan(20);
  });
});

describe("invalid and truncated input", () => {
  it("answers unparseable JSON with the INVALID_JSON error result", async () => {
    const raw = '{"baseVersion":3,"summary":"cut off","ops":[{"op":"upd';
    const out = await exec(ctx(loadPlan("single-room")), "edit_plan", invalidJsonInput(raw));
    expect(out.ok).toBe(false);
    expect(JSON.parse(text(out))).toEqual({ INVALID_JSON: raw });
    expect(INVALID_JSON_KEY).toBe("__invalid_json__");
  });

  it("rejects a silently truncated object that parsed (missing required fields)", async () => {
    const out = await exec(ctx(loadPlan("single-room"), 3), "edit_plan", { baseVersion: 3, summary: "cut" });
    expect(out.ok).toBe(false);
    expect(text(out)).toContain('"path":"/ops"');
    expect(text(out)).toContain('"path":"/changes"');
  });

  it("rejects unknown tools and wrong types for every tool", async () => {
    expect((await exec(ctx(null), "draw_map", {})).ok).toBe(false);
    for (const [name, bad] of [
      ["update_brief", { set: { system: "pathfinder" } }],
      ["ask_questions", { questions: [] }],
      ["create_plan", { replace: "no", summary: "x", plan: {} }],
      ["view_plan", { format: "svg" }],
      ["view_map_image", {}],
      ["compile_preview", { levels: "l1" }],
      ["list_catalog", { what: "everything" }],
    ] as const) {
      const out = await exec(ctx(loadPlan("single-room")), name, bad);
      expect(out.ok, name).toBe(false);
      expect(text(out), name).toContain("REJECTED");
    }
  });
});

describe("other tools", () => {
  const plan = loadPlan("two-rooms-door");

  it("update_brief keeps fields the GM set", async () => {
    const out = await exec(
      ctx(null, 0, { brief: { tone: { value: "grim", source: "user" } } }),
      "update_brief",
      { set: { tone: "cheerful", mapType: "Tavern" } },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.newBrief?.tone).toEqual({ value: "grim", source: "user" });
    expect(out.newBrief?.mapType).toEqual({ value: "Tavern", source: "ai" });
    expect(text(out)).toContain('"skipped":["tone"]');
  });

  it("ask_questions ends the turn without a result", async () => {
    const out = await exec(ctx(null), "ask_questions", {
      questions: [{ id: "q1", text: "Tier?", default: "Tier 2", options: ["1", "2"] }],
    });
    expect(out).toEqual({ ok: true, content: [], awaitUser: true });
  });

  it("view_plan outline, ascii and json", async () => {
    const o = await exec(ctx(plan, 3), "view_plan", { format: "outline" });
    expect(text(o)).toContain("PLAN v3");
    const a = await exec(ctx(plan, 3), "view_plan", { format: "ascii", level: "l1" });
    expect(a.ok).toBe(true);
    const j = await exec(ctx(plan, 3), "view_plan", { format: "json", ids: ["bed", "nope"] });
    expect(JSON.parse(text(j))).toMatchObject({
      version: 3,
      elements: { bed: { level: "l1", type: "bed" } },
      notFound: ["nope"],
    });
    const bad = await exec(ctx(plan, 3), "view_plan", { format: "ascii", level: "l9" });
    expect(text(bad)).toContain("unknown_level");
  });

  it("view_map_image is unavailable without a renderer and returns a PNG with one", async () => {
    expect(text(await exec(ctx(plan), "view_map_image", { level: "l1" }))).toContain(
      "unavailable on this model",
    );
    const out = await exec(
      ctx(plan, 3, { renderImage: () => Promise.resolve(new Uint8Array([137, 80, 78, 71])) }),
      "view_map_image",
      { level: "l1" },
    );
    expect(out.ok).toBe(true);
    expect(out.content[1]).toEqual({ type: "image", mediaType: "image/png", dataBase64: "iVBORw==" });
  });

  it("compile_preview says one slab when it fits", async () => {
    const out = await exec(ctx(plan, 3), "compile_preview", {});
    expect(JSON.parse(text(out))).toMatchObject({
      version: 3,
      totalAssets: 12,
      estimatedChunks: 1,
      build: expect.stringContaining("one slab") as unknown,
    });
    const none = await exec(ctx(plan, 3, { estimate: () => null }), "compile_preview", {});
    expect(text(none)).toContain("unavailable");
  });

  it("list_catalog", async () => {
    expect(text(await exec(ctx(null), "list_catalog", { what: "themes" }))).toContain("stone_dungeon");
    expect(
      JSON.parse(text(await exec(ctx(null), "list_catalog", { what: "features", theme: "stone_dungeon" }))),
    ).toMatchObject({ withAssets: ["bed", "rug"] });
    expect(text(await exec(ctx(null), "list_catalog", { what: "features", theme: "lava" }))).toContain(
      "theme_unknown",
    );
  });
});

function firstLine(o: { content: Array<{ type: string; text?: string }> }): string {
  return (o.content[0]?.text ?? "{}").split("\n")[0] ?? "{}";
}

/** Two rooms joined by door d1 (on the edge x=7, y=3); an altar at `altar` (7,3 blocks the door). */
function doorPlan(altar: [number, number]): Record<string, unknown> {
  return {
    title: "Blocked",
    kind: "dungeon",
    theme: "stone_dungeon",
    levels: [
      {
        id: "l1",
        name: "One",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 16, h: 10 },
        base: { type: "solid" },
        areas: [
          { id: "entry", kind: "room", shape: { type: "rect", x: 1, y: 1, w: 6, h: 5 } },
          { id: "hall", kind: "room", shape: { type: "rect", x: 7, y: 1, w: 6, h: 5 } },
        ],
        openings: [{ id: "d1", kind: "door", between: ["entry", "hall"] }],
        features: [{ id: "altar", type: "altar", at: altar }],
      },
    ],
    links: [],
  };
}

describe("playability checks in create/edit results", () => {
  it("a blocked door is applied but reported as NOT CLEAN, with hint, cell and a marked map", async () => {
    const out = await exec(ctx(null, 0, { nextVersion: 1 }), "create_plan", {
      replace: false,
      summary: "Draft",
      plan: doorPlan([7, 3]),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.newPlan).toBeDefined();
    const report = JSON.parse(firstLine(out)) as {
      status: string;
      errors: Array<{ code: string; msg: string; hint?: string }>;
    };
    expect(report.status).toBe("applied");
    expect(report.errors[0]).toMatchObject({
      code: "opening_blocked",
      hint: expect.stringContaining("altar") as unknown,
    });
    expect(report.errors[0]?.msg).toContain("[d1 @7,3]");
    expect(text(out)).toContain("CHECKS: NOT CLEAN — 1 error, 0 warnings");
    expect(text({ content: out.content.slice(-1) })).toMatch(/ISSUES ON l1[\s\S]*!/);
  });

  it("the fixing edit reports CHECKS: clean", async () => {
    const created = await exec(ctx(null), "create_plan", {
      replace: false,
      summary: "Draft",
      plan: doorPlan([7, 3]),
    });
    if (!created.ok || !created.newPlan) throw new Error("create failed");
    const out = await exec(ctx(created.newPlan.plan, 1), "edit_plan", {
      baseVersion: 1,
      summary: "Cleared the door",
      changes: ["Moved the altar off the doorway"],
      ops: [{ op: "move", ids: ["altar"], dx: 3, dy: 0 }],
    });
    expect(out.ok).toBe(true);
    expect(text(out)).toContain("CHECKS: clean");
    expect(JSON.parse(firstLine(out))).not.toHaveProperty("errors");
  });

  it("view_plan shows the checks too", async () => {
    const created = await exec(ctx(null), "create_plan", {
      replace: false,
      summary: "Draft",
      plan: doorPlan([7, 3]),
    });
    if (!created.ok || !created.newPlan) throw new Error("create failed");
    const o = await exec(ctx(created.newPlan.plan, 1), "view_plan", { format: "outline" });
    expect(text(o)).toContain("opening_blocked d1 @7,3");
    expect(text(o)).toContain("CHECKS: NOT CLEAN");
    const a = await exec(ctx(created.newPlan.plan, 1), "view_plan", { format: "ascii", level: "l1" });
    expect(text(a)).toContain("! 7,3 error opening_blocked d1");
  });
});

describe("compile_preview build checks", () => {
  it("passes hint, cell, side, ids and assets through, errors first, info summarised", async () => {
    const diagnostics = [
      {
        severity: "info",
        code: "verify_door_no_floor",
        stage: "verify",
        message: "patched",
        repaired: "added floor under d2",
      },
      {
        severity: "warning",
        code: "verify_props_overlap",
        stage: "verify",
        message: "chair overlaps table",
        elementIds: ["c1", "t1"],
        assets: ["Chair", "Table"],
        cell: [3, 4],
        hint: "move c1 one cell west",
      },
      {
        severity: "error",
        code: "verify_door_blocked",
        stage: "verify",
        message: "door d1 is blocked",
        elementId: "d1",
        elementIds: ["d1", "altar"],
        assets: ["Altar"],
        cell: [7, 3],
        side: "W",
        levelId: "l1",
        hint: "move altar away from 7,3",
      },
      { severity: "info", code: "role_missing", stage: "realize", message: "no rug", count: 3 },
    ];
    const plan = loadPlan("two-rooms-door");
    const out = await exec(
      ctx(plan, 3, {
        estimate: () =>
          ({
            perLevel: [{ levelId: "l1", assets: 9, estimatedChunks: 1 }],
            totalAssets: 9,
            estimatedChunks: 1,
            diagnostics,
          }) as never,
      }),
      "compile_preview",
      {},
    );
    const r = JSON.parse(text(out)) as Record<string, unknown>;
    expect(r["checks"]).toMatch(/^NOT CLEAN: 1 error\(s\), 1 warning\(s\)/);
    expect(r["errors"]).toEqual([
      {
        severity: "error",
        code: "verify_door_blocked",
        msg: "door d1 is blocked",
        hint: "move altar away from 7,3",
        level: "l1",
        ids: ["d1", "altar"],
        cell: [7, 3],
        side: "W",
        assets: ["Altar"],
      },
    ]);
    expect(r["warnings"]).toMatchObject([
      { code: "verify_props_overlap", hint: "move c1 one cell west", assets: ["Chair", "Table"] },
    ]);
    expect(r["repairedAutomatically"]).toEqual(["added floor under d2"]);
    expect(r["notes"]).toEqual({ role_missing: 3 });
  });

  it("caps long lists and says so", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      severity: "error",
      code: "verify_wall_gap",
      stage: "verify",
      message: `gap ${i}`,
    }));
    const out = await exec(
      ctx(loadPlan("two-rooms-door"), 3, {
        estimate: () => ({ perLevel: [], totalAssets: 0, estimatedChunks: 1, diagnostics: many }) as never,
      }),
      "compile_preview",
      {},
    );
    const r = JSON.parse(text(out)) as { errors: unknown[]; moreErrors: number };
    expect(r.errors).toHaveLength(40);
    expect(r.moreErrors).toBe(10);
  });
});

describe("injected ports", () => {
  it("degrades to an outline when the resolver is unavailable", async () => {
    const ports: ExecutorPorts = {
      ...defaultExecutorPorts,
      resolvePlan: null,
      changedViews: null,
      ascii: null,
    };
    const e = createToolExecutor(ports);
    const plan = loadPlan("two-rooms-door");
    const out = await e(ctx(plan, 3), "edit_plan", {
      baseVersion: 3,
      summary: "n",
      changes: [],
      ops: [{ op: "update", id: "back", set: { notes: "x" } }],
    });
    expect(out.ok).toBe(true);
    expect(text(out)).toContain("PLAN v4");
    const a = await e(ctx(plan, 3), "view_plan", { format: "ascii" });
    expect(text(a)).toContain("unavailable");
  });
});
