import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { ChatEvent, ProjectSnapshot } from "../src/shared/ipc";
import { cleanRun, invoke, launch, mainEntry, newRun, unwrap, type Run } from "./helpers";

/**
 * E2E smoke (architecture §7.3). Every launch is hidden (SLABYRINTH_E2E=1: no window is shown,
 * no dialogs, memory clipboard, no TaleSpire lookup/launch) and uses a throwaway userData folder.
 * Chat runs the real engine with the scripted provider below (no network, no key leaves the test).
 */
const say = (text: string) => ({ type: "text", text });
const call = (callId: string, name: string, input: unknown) => ({ type: "tool_call", callId, name, input });
const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A two-room crypt, as a model would author it (the app fills schema, generator and id; the seed is fixed). */
const CRYPT = {
  title: "The Fake Crypt",
  kind: "dungeon",
  seed: 4242,
  theme: "stone_dungeon",
  entryLevel: "l1",
  levels: [
    {
      id: "l1",
      name: "Crypt",
      elevation: 0,
      bounds: { x: 0, y: 0, w: 20, h: 14 },
      base: { type: "solid" },
      areas: [
        {
          id: "entry",
          kind: "room",
          name: "Entry Hall",
          key: "1",
          shape: { type: "rect", x: 2, y: 4, w: 6, h: 6 },
        },
        {
          id: "tomb",
          kind: "room",
          name: "Tomb",
          key: "2",
          shape: { type: "rect", x: 11, y: 3, w: 7, h: 8 },
        },
        {
          id: "c1",
          kind: "corridor",
          shape: { type: "route", from: "entry", to: "tomb", width: 1, bend: "hv", openings: "door" },
        },
      ],
      features: [{ id: "coffin", type: "sarcophagus", at: [14, 6], size: [1, 2] }],
    },
  ],
};

const STEPS = [
  {
    kind: "reply",
    usage,
    parts: [call("c1", "create_plan", { replace: false, summary: "First draft", plan: CRYPT })],
  },
  { kind: "reply", usage, parts: [say("Here's a first draft.")] },
  {
    kind: "reply",
    usage,
    parts: [
      call("e1", "edit_plan", {
        baseVersion: 1,
        summary: "Brazier",
        changes: ["Added a brazier in the entry hall"],
        ops: [
          { op: "add_features", level: "l1", features: [{ id: "brazier1", type: "brazier", at: [4, 6] }] },
        ],
      }),
    ],
  },
  { kind: "reply", usage, parts: [say("Added a brazier.")] },
];

let run: Run;
test.beforeEach(() => {
  run = newRun("slabyrinth-e2e-smoke-", STEPS);
});
test.afterEach(() => {
  cleanRun(run);
});

test("app boots with the secure bridge only", async () => {
  const { app, page } = await launch(run);
  try {
    const bridge = await page.evaluate(() => ({
      keys: Object.keys(window.slabyrinth).sort(),
      hasRequire: "require" in window,
      hasProcess: "process" in window,
    }));
    expect(bridge).toEqual({ keys: ["invoke", "on", "send"], hasRequire: false, hasProcess: false });
    const unknown = await page.evaluate(() =>
      (window.slabyrinth.invoke as (c: string, r: unknown) => Promise<unknown>)("fs:readFile", {
        path: "/etc/passwd",
      }),
    );
    expect(unknown).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(unwrap(await invoke(page, "settings:get", undefined)).ui.theme).toBe("dark");
  } finally {
    await app.close();
  }
});

test("the window icon (the logo) ships next to the main bundle and decodes in the main process", async () => {
  const mainDir = path.dirname(mainEntry);
  const files = readdirSync(mainDir, { recursive: true, encoding: "utf8" }).map((f) => path.join(mainDir, f));
  const png = files.find((f) => /512x512.*\.png$/.test(path.basename(f)));
  const ico = files.find((f) => /^icon.*\.ico$/.test(path.basename(f)));
  expect(png, "512x512 PNG emitted into out-test/main").toBeDefined();
  expect(ico, "icon.ico emitted into out-test/main").toBeDefined();
  const bundle = files
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  for (const f of [png, ico]) expect(bundle).toContain(path.basename(f ?? ""));

  const { app } = await launch(run);
  try {
    const decoded = await app.evaluate(
      ({ nativeImage }, [p, i]) => {
        const size = (f: string): { empty: boolean; width: number } => {
          const img = nativeImage.createFromPath(f);
          return { empty: img.isEmpty(), width: img.getSize().width };
        };
        return { png: size(p), ico: process.platform === "win32" ? size(i) : null };
      },
      [png ?? "", ico ?? ""] as const,
    );
    expect(decoded.png).toEqual({ empty: false, width: 512 });
    if (decoded.ico) expect(decoded.ico.empty).toBe(false);
  } finally {
    await app.close();
  }
});

const chat = (page: Page, text: string): Promise<ChatEvent> =>
  page.evaluate(
    (t) =>
      new Promise<ChatEvent>((resolve, reject) => {
        const off = window.slabyrinth.on("chat:event", (e) => {
          if (e.type === "turn_finished" || e.type === "turn_failed") {
            off();
            resolve(e);
          }
        });
        void window.slabyrinth.invoke("chat:send", { text: t }).then((r) => {
          if (!r.ok) reject(new Error(r.error.message));
        });
      }),
    text,
  );

test("boot → create project → chat (scripted provider) → save → reopen after restart", async () => {
  const saved = { filePath: "" };
  {
    const { app, page } = await launch(run);
    try {
      const snap = unwrap(await invoke(page, "project:new", { name: "E2E Crypt" }));
      expect(snap.conversation.phase).toBe("brief");
      saved.filePath = snap.filePath as string;
      // A test key (never sent anywhere: the scripted provider stands in for Anthropic).
      unwrap(
        await invoke(page, "secrets:setApiKey", {
          providerId: "anthropic",
          apiKey: "sk-ant-e2e-test-0000000000000000",
          storage: "memory_only",
        }),
      );

      expect(await chat(page, "A small crypt with two rooms")).toMatchObject({
        type: "turn_finished",
        stopReason: "end_turn",
      });
      // Second turn: edit_plan through core applyOps (an ops version, replayed from its keyframe on reopen).
      expect(await chat(page, "add a brazier")).toMatchObject({ type: "turn_finished" });

      const after = unwrap(await invoke(page, "project:snapshot", undefined));
      expect(after.head).toBe(2);
      expect(after.plan?.title).toBe("The Fake Crypt");

      const build = unwrap(await invoke(page, "compile:run", {}));
      expect(build.chunks.length).toBeGreaterThanOrEqual(1);
      expect(build.planVersion).toBe(2);
      // Default build: one slab holding every level (decisions.md "Export: fewest slabs possible").
      expect(build.chunks).toHaveLength(1);
      const chunk = { buildId: build.buildId, chunkId: build.chunks[0]?.id ?? "" };
      const copied = unwrap(
        await invoke(page, "talespire:copyAndOpen", { text: build.chunks[0]?.slab ?? "", chunk }),
      );
      expect(copied).toMatchObject({ copied: true, action: "not_installed" });
      unwrap(await invoke(page, "project:setUiState", { ui: { tab: "build", zoom: 2 } }));
    } finally {
      await app.close(); // before-quit flushes the autosave
    }
  }
  expect(existsSync(saved.filePath)).toBe(true);
  {
    const { app, page } = await launch(run);
    try {
      const list = unwrap(await invoke(page, "project:list", undefined));
      expect(list.map((p) => p.name)).toContain("E2E Crypt");
      const reopened: ProjectSnapshot | null = unwrap(
        await invoke(page, "project:open", { path: saved.filePath }),
      );
      expect(reopened?.head).toBe(2);
      expect(reopened?.plan?.levels[0]?.features.some((f) => f.type === "brazier")).toBe(true);
      const v1 = unwrap(await invoke(page, "plan:getVersion", { version: 1 }));
      expect(v1.levels[0]?.features.some((f) => f.type === "brazier")).toBe(false);
      expect(reopened?.plan?.title).toBe("The Fake Crypt");
      expect(reopened?.conversation.items.flatMap((i) => (i.type === "user" ? [i.text] : []))).toEqual([
        "A small crypt with two rooms",
        "add a brazier",
      ]);
      expect(reopened?.builds).toHaveLength(1);
      expect(reopened?.builds[0]?.levels.flatMap((l) => l.chunks)[0]?.copiedAt).toEqual(expect.any(String));
      expect(reopened?.dirty).toBe(false);
    } finally {
      await app.close();
    }
  }
});
