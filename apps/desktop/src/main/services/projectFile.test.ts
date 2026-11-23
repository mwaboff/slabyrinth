import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROJECT_FORMAT, PROJECT_FORMAT_VERSION } from "../../shared/project";
import { FIXTURE_PLAN } from "../fixturePlan";
import { buildSnapshot, parseProject, serializeProject } from "./projectFile";

/** Every file here is built inside the test: no real project file is ever read. */
const bytes = (json: unknown): Buffer => Buffer.from(JSON.stringify(json));
const noMigration = (): null => null;
const conv = (p: Record<string, unknown>): Record<string, unknown> =>
  (p["conversations"] as Array<Record<string, unknown>>)[0] ?? {};

/** A project as an early build wrote it: no bookkeeping fields added since, a long tone, odd resume state. */
function oldShapeProject(): Record<string, unknown> {
  const plan = structuredClone(FIXTURE_PLAN);
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    appVersion: "0.1.0",
    id: "p-old",
    name: "Old crypt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    brief: {
      tone: { value: "x".repeat(300), source: "user" },
      party: { value: { size: 40 }, source: "ai" },
      "x-future": { kept: true },
    },
    plan,
    history: {
      head: 1,
      versions: [
        {
          number: 1,
          parentNumber: 0,
          author: "ai",
          createdAt: "2026-01-01T00:00:00.000Z",
          summary: "First draft",
          cause: { type: "create" },
          snapshot: plan,
        },
      ],
      undone: [],
      approvedVersion: null,
    },
    conversations: [
      {
        id: "c1",
        createdAt: "2026-01-01T00:00:00.000Z",
        selection: { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "medium" },
        items: [{ type: "user", id: "u1", text: "A crypt", createdAt: "2026-01-01T00:00:00.000Z" }],
      },
    ],
    activeConversationId: "c1",
    builds: [],
    spend: {
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: null,
    },
    blobs: {},
    stamps: {},
    ui: { tab: "map", zoom: "far" },
  };
}

describe("project files from disk are validated before anything reads them", () => {
  it("opens a file in an older shape: missing bookkeeping gets its start value, content is kept", () => {
    const r = parseProject(bytes(oldShapeProject()), noMigration);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.project.conversations[0];
    expect(c?.modelSeen).toEqual({ head: 0, briefHash: "" });
    expect(c?.archived).toBe(false);
    expect(c?.meta).toEqual({});
    expect(r.project.history.versions[0]?.changeSummary).toEqual([]);
    // the GM's content survives untouched, also beyond today's limits; unknown keys round-trip
    expect(r.project.brief.tone?.value).toHaveLength(300);
    expect(r.project.brief.party?.value).toEqual({ size: 40 });
    expect((r.project.brief as Record<string, unknown>)["x-future"]).toEqual({ kept: true });
    // resume state that does not fit is reset, not a reason to refuse
    expect(r.project.ui).toEqual({ tab: "map" });
    expect(() => buildSnapshot(r.project, null, false, null)).not.toThrow();
  });

  it("opens builds saved with and without a paste anchor (added 2026-11-22)", () => {
    const build = (extra: Record<string, unknown>): Record<string, unknown> => ({
      id: "b1",
      versionNumber: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      levels: [{ levelId: "l1", pasteOrder: 1, chunks: [{ id: "l1-01", pasted: false }] }],
      ...extra,
    });
    const withBuild = (b: Record<string, unknown>): Record<string, unknown> => ({
      ...oldShapeProject(),
      builds: [b],
    });
    const old = parseProject(bytes(withBuild(build({}))), noMigration);
    expect(old.ok && old.project.builds[0]?.pasteAnchor).toBeUndefined();
    const anchor = { side: "south", clearanceCells: 5, farMarkerCells: 37 };
    const now = parseProject(bytes(withBuild(build({ pasteAnchor: anchor }))), noMigration);
    expect(now.ok && now.project.builds[0]?.pasteAnchor).toEqual(anchor);
    const bad = parseProject(bytes(withBuild(build({ pasteAnchor: { side: "up" } }))), noMigration);
    expect(bad.ok).toBe(false);
  });

  it("refuses a damaged file with a message saying what is wrong, never by throwing", () => {
    const cases: Array<[string, (p: Record<string, unknown>) => void, RegExp]> = [
      ["empty plan", (p) => (p["plan"] = {}), /plan/],
      ["plan level without bounds", (p) => (p["plan"] = { ...FIXTURE_PLAN, levels: [{ id: "l1" }] }), /plan/],
      [
        "brief value of the wrong type",
        (p) => (p["brief"] = { tone: { value: 7, source: "user" } }),
        /brief/,
      ],
      ["brief field without a source", (p) => (p["brief"] = { tone: { value: "grim" } }), /brief/],
      [
        "transcript item without its text",
        (p) => (p["conversations"] = [{ ...conv(p), items: [{ type: "user", id: "u" }] }]),
        /conversations/,
      ],
      [
        "unknown transcript item",
        (p) => (p["conversations"] = [{ ...conv(p), items: [{ type: "weird", id: "u" }] }]),
        /conversations/,
      ],
      [
        "history head not a number",
        (p) => ((p["history"] as Record<string, unknown>)["head"] = "1"),
        /history/,
      ],
    ];
    for (const [name, mutate, where] of cases) {
      const p = oldShapeProject();
      mutate(p);
      const r = parseProject(bytes(p), noMigration);
      expect(r.ok, name).toBe(false);
      if (!r.ok) {
        expect(r.reason, name).toBe("invalid");
        expect(r.message, name).toMatch(/damaged/);
        expect(r.message, name).toMatch(where);
      }
    }
  });

  it("random damage is either refused or yields a project the views can read", () => {
    let seed = 12345;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const junk = [null, 7, "x", [], {}, true];
    const paths = (o: unknown, at: string[] = []): string[][] =>
      typeof o !== "object" || o === null
        ? [at]
        : [at, ...Object.entries(o).flatMap(([k, v]) => (at.length < 6 ? paths(v, [...at, k]) : []))];
    const all = paths(oldShapeProject()).filter((p) => p.length > 0);
    for (let i = 0; i < 300; i++) {
      const p = oldShapeProject();
      const path = all[rand(all.length)] ?? [];
      let o = p;
      for (const k of path.slice(0, -1)) o = o[k] as Record<string, unknown>;
      const last = path[path.length - 1] ?? "";
      if (rand(2) === 0) Reflect.deleteProperty(o, last);
      else o[last] = junk[rand(junk.length)];
      const r = parseProject(bytes(p), noMigration);
      if (r.ok) expect(() => buildSnapshot(r.project, null, false, null), path.join(".")).not.toThrow();
    }
  });

  it("a plan stating light, condition and wealth (2026-11-23) saves and reopens unchanged, same format version", () => {
    const p = oldShapeProject();
    const plan = structuredClone(FIXTURE_PLAN) as unknown as {
      levels: Array<Record<string, unknown> & { areas: Array<Record<string, unknown>> }>;
    };
    const level = plan.levels[0];
    if (!level?.areas[0]) throw new Error("fixture has no area");
    Object.assign(level, { light: "dim", condition: "weathered", wealth: "poor" });
    Object.assign(level.areas[0], { light: "dark", condition: "ruined", wealth: "lavish" });
    p["plan"] = plan;
    const first = parseProject(bytes(p), noMigration);
    if (!first.ok) throw new Error(first.message);
    const again = parseProject(Buffer.from(serializeProject(first.project)), noMigration);
    if (!again.ok) throw new Error(again.message);
    expect(again.project.plan).toEqual(plan);
    expect(again.project.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(again.migratedFrom).toBeNull();
  });

  it("every stored fixture plan opens as a project's head plan", () => {
    const dir = new URL("../../../../../packages/core/test/fixtures/plans/", import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const plan: unknown = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
      const p = oldShapeProject();
      p["plan"] = plan;
      const r = parseProject(bytes(p), noMigration);
      expect(r.ok ? "ok" : r.message, f).toBe("ok");
    }
  });
});
