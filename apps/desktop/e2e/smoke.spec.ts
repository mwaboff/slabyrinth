import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { ChatEvent, ProjectSnapshot, Result } from "../src/shared/ipc";

const mainEntry = fileURLToPath(new URL("../out-test/main/index.js", import.meta.url));

/**
 * E2E smoke (architecture §7.3). Every launch is hidden (SLABYRINTH_E2E=1: no window is shown,
 * no dialogs, memory clipboard, no TaleSpire lookup/launch) and uses a throwaway userData folder.
 * The fake engine replays a recorded stream through the real IPC.
 */
async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  // Fail fast (no Electron error dialog) when the app has not been built.
  expect(
    existsSync(mainEntry),
    `${mainEntry} missing: run npm run build:test -w @slabyrinth/desktop first`,
  ).toBe(true);
  const app = await electron.launch({
    args: [mainEntry],
    // SLABYRINTH_FAKE_ENGINE: the recorded-stream fake engine (explicit test switch; the default is the real one).
    env: { ...process.env, SLABYRINTH_E2E: "1", SLABYRINTH_FAKE_ENGINE: "1", SLABYRINTH_USER_DATA: userData },
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  await expect(page.locator("html")).toHaveAttribute("data-slabyrinth-ready", "true");
  return { app, page };
}

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

let userData: string;
test.beforeEach(() => {
  userData = mkdtempSync(path.join(os.tmpdir(), "slabyrinth-e2e-"));
});
test.afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

test("app boots with the secure bridge only", async () => {
  const { app, page } = await launch(userData);
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
    const settings = await page.evaluate(() => window.slabyrinth.invoke("settings:get", undefined));
    expect(unwrap(settings).ui.theme).toBe("dark");
  } finally {
    await app.close();
  }
});

test("boot → create project → chat (fake engine) → save → reopen after restart", async () => {
  const saved = { filePath: "" };
  {
    const { app, page } = await launch(userData);
    try {
      const snap = unwrap(
        await page.evaluate(() => window.slabyrinth.invoke("project:new", { name: "E2E Crypt" })),
      );
      expect(snap.conversation.phase).toBe("brief");
      saved.filePath = snap.filePath as string;

      const chat = (text: string): Promise<ChatEvent> =>
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
      expect(await chat("A small crypt with two rooms")).toMatchObject({
        type: "turn_finished",
        stopReason: "end_turn",
      });
      // Second turn: edit_plan through core applyOps (an ops version, replayed from its keyframe on reopen).
      expect(await chat("add a brazier")).toMatchObject({ type: "turn_finished" });

      const after = unwrap(
        await page.evaluate(() => window.slabyrinth.invoke("project:snapshot", undefined)),
      );
      expect(after.head).toBe(2);
      expect(after.plan?.title).toBe("The Fake Crypt");

      const build = unwrap(await page.evaluate(() => window.slabyrinth.invoke("compile:run", {})));
      expect(build.chunks.length).toBeGreaterThanOrEqual(1);
      expect(build.planVersion).toBe(2);
      // Default build: one slab holding every level (decisions.md "Export: fewest slabs possible").
      expect(build.chunks).toHaveLength(1);
      const chunk = { buildId: build.buildId, chunkId: build.chunks[0]?.id ?? "" };
      const copied = unwrap(
        await page.evaluate(
          ([text, c]) => window.slabyrinth.invoke("talespire:copyAndOpen", { text, chunk: c }),
          [build.chunks[0]?.slab ?? "", chunk] as const,
        ),
      );
      expect(copied).toMatchObject({ copied: true, action: "not_installed" });
      unwrap(
        await page.evaluate(() =>
          window.slabyrinth.invoke("project:setUiState", { ui: { tab: "build", zoom: 2 } }),
        ),
      );
    } finally {
      await app.close(); // before-quit flushes the autosave
    }
  }
  expect(existsSync(saved.filePath)).toBe(true);
  {
    const { app, page } = await launch(userData);
    try {
      const list = unwrap(await page.evaluate(() => window.slabyrinth.invoke("project:list", undefined)));
      expect(list.map((p) => p.name)).toContain("E2E Crypt");
      const reopened: ProjectSnapshot | null = unwrap(
        await page.evaluate((p) => window.slabyrinth.invoke("project:open", { path: p }), saved.filePath),
      );
      expect(reopened?.head).toBe(2);
      expect(reopened?.plan?.levels[0]?.features.some((f) => f.type === "brazier")).toBe(true);
      const v1 = unwrap(
        await page.evaluate(() => window.slabyrinth.invoke("plan:getVersion", { version: 1 })),
      );
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
