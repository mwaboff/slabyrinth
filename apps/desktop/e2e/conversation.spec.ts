import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { MATERIALS } from "@slabyrinth/core/contracts/plan";
import { loadPalettes, resolveRole } from "@slabyrinth/core/palette";
import { slabCodec } from "@slabyrinth/core/slab";
import type { ChatEvent, IpcRequests, Result } from "../src/shared/ipc";
import { STEPS } from "./conversationScript";

const mainEntry = fileURLToPath(new URL("../out-test/main/index.js", import.meta.url));

/**
 * The whole path with no network and no money spent: the REAL ConversationEngine, through the REAL
 * IPC (renderer → preload → ipcMain), with a scripted ChatProvider registered in place of Anthropic
 * (SLABYRINTH_E2E_PROVIDER_SCRIPT, honoured only in hidden e2e runs), the real core tools, the real
 * compiler worker and the real slab codec. Every launch is hidden, uses a throwaway userData folder,
 * a memory clipboard and no TaleSpire lookup or launch.
 */
interface Run {
  dir: string;
  userData: string;
  script: string;
  log: string;
}

async function launch(run: Run): Promise<{ app: ElectronApplication; page: Page }> {
  expect(
    existsSync(mainEntry),
    `${mainEntry} missing: run npm run build:test -w @slabyrinth/desktop first`,
  ).toBe(true);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env["ANTHROPIC_API_KEY"]; // belt and braces: safe mode ignores it anyway
  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...env,
      SLABYRINTH_E2E: "1",
      SLABYRINTH_USER_DATA: run.userData,
      SLABYRINTH_E2E_PROVIDER_SCRIPT: run.script,
      SLABYRINTH_E2E_PROVIDER_LOG: run.log,
    },
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

type Invoke = <C extends keyof IpcRequests>(
  channel: C,
  req: IpcRequests[C]["req"],
) => Promise<Result<IpcRequests[C]["res"]>>;

function invoker(page: Page): Invoke {
  return (channel, req) =>
    page.evaluate(([c, r]) => window.slabyrinth.invoke(c as never, r as never), [channel, req] as const);
}

/** Sends a message and collects every chat event of that turn until it finishes or fails. */
function chat(page: Page, req: IpcRequests["chat:send"]["req"]): Promise<ChatEvent[]> {
  return page.evaluate(
    (r) =>
      new Promise<ChatEvent[]>((resolve, reject) => {
        const events: ChatEvent[] = [];
        const off = window.slabyrinth.on("chat:event", (e) => {
          events.push(e);
          if (e.type === "turn_finished" || e.type === "turn_failed") {
            off();
            resolve(events);
          }
        });
        void window.slabyrinth.invoke("chat:send", r).then((res) => {
          if (!res.ok) {
            off();
            reject(new Error(`${res.error.code}: ${res.error.message}`));
          }
        });
      }),
    req,
  );
}

const last = (events: ChatEvent[]): ChatEvent | undefined => events[events.length - 1];
const toolResults = (events: ChatEvent[]) =>
  events.flatMap((e) =>
    e.type === "tool_call_finished" ? [{ name: e.name, ok: e.ok, v: e.newVersion }] : [],
  );

let run: Run;
test.beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "slabyrinth-e2e-conv-"));
  run = {
    dir,
    userData: path.join(dir, "userData"),
    script: path.join(dir, "steps.json"),
    log: path.join(dir, "requests.jsonl"),
  };
  writeFileSync(run.script, JSON.stringify(STEPS));
});
test.afterEach(() => {
  rmSync(run.dir, { recursive: true, force: true });
});

test("real engine end to end: brief → questions → plan → edits → approve → build → restart → resume", async () => {
  test.setTimeout(120_000);
  const saved = { filePath: "", builtUuids: [] as string[] };
  {
    const { app, page } = await launch(run);
    const invoke = invoker(page);
    try {
      const snap = unwrap(await invoke("project:new", { name: "E2E Abbey" }));
      saved.filePath = snap.filePath ?? "";
      expect(snap.conversation.selection).toEqual({
        providerId: "anthropic",
        modelId: "claude-opus-5-5",
        effort: "medium",
      });

      // No key yet: a clean, typed state — not an exception, not "unsupported".
      const noKey = await invoke("chat:send", { text: "hello" });
      expect(noKey).toMatchObject({ ok: false, error: { code: "no_api_key" } });
      expect(unwrap(await invoke("secrets:status", undefined))["anthropic"]).toMatchObject({ hasKey: false });
      // A test key (never sent anywhere: the scripted provider stands in for Anthropic).
      unwrap(
        await invoke("secrets:setApiKey", {
          providerId: "anthropic",
          apiKey: "sk-ant-e2e-test-0000000000000000",
          storage: "memory_only",
        }),
      );
      expect(unwrap(await invoke("secrets:status", undefined))["anthropic"]).toMatchObject({ hasKey: true });

      // Turn 1: brief + clarifying question card.
      const t1 = await chat(page, { text: "A crypt under a ruined abbey for four players" });
      expect(t1.find((e) => e.type === "questions")).toMatchObject({ callId: "tq" });
      expect(t1.find((e) => e.type === "brief_updated")).toBeTruthy();
      expect(last(t1)).toMatchObject({ type: "turn_finished" });

      // Turn 2: answers → create_plan.
      const t2 = await chat(page, {
        text: "Tier 2",
        answers: { callId: "tq", answers: [{ id: "q1", answer: "Tier 2" }] },
      });
      expect(toolResults(t2)).toEqual([{ name: "create_plan", ok: true, v: 1 }]);
      expect(last(t2)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });

      // Turn 3: edit round 1 — rejected by validation, then corrected.
      const t3 = await chat(page, { text: "Move the altar a bit east" });
      expect(toolResults(t3)).toEqual([
        { name: "edit_plan", ok: false, v: undefined },
        { name: "edit_plan", ok: true, v: 2 },
      ]);

      // Turn 4: edit round 2.
      const t4 = await chat(page, { text: "Describe the hall" });
      expect(toolResults(t4)).toEqual([{ name: "edit_plan", ok: true, v: 3 }]);
      const usage = t4.filter((e) => e.type === "usage");
      expect(usage.length).toBeGreaterThan(0);
      expect(usage.at(-1)).toMatchObject({
        cost: { currency: "USD" },
        totals: { cost: { currency: "USD" } },
      });

      const afterEdits = unwrap(await invoke("project:snapshot", undefined));
      expect(afterEdits.head).toBe(3);
      expect(afterEdits.plan?.levels[0]?.features.find((f) => f.id === "altar")?.at).toEqual([10, 3]);
      expect(afterEdits.conversation.totals.turns).toBe(4);
      expect(afterEdits.conversation.totals.cost?.amount ?? 0).toBeGreaterThan(0);
      const settings = unwrap(await invoke("settings:get", undefined));
      expect(settings.spending.allTime.cost?.amount ?? 0).toBeGreaterThan(0);

      // Approve → build with the real compiler (worker) → one slab holding every level.
      expect(unwrap(await invoke("plan:approve", { version: 3 }))).toMatchObject({ approved: true });
      const bundle = unwrap(await invoke("compile:run", {}));
      expect(bundle.planVersion).toBe(3);
      expect(bundle.chunks).toHaveLength(1);
      const chunk = bundle.chunks[0];
      if (!chunk) throw new Error("no chunk");
      expect(chunk.levelIds).toEqual(["l1"]);
      expect(chunk.hasAlignmentMarkers).toBe(false);
      expect(chunk.slab.startsWith("NOT-A-REAL-SLAB")).toBe(false);

      const decoded = slabCodec.decode(chunk.slab);
      expect(decoded.version).toBe(2);
      expect(decoded.assets).toHaveLength(chunk.assetCount);
      saved.builtUuids = [...new Set(decoded.assets.map((a) => a.uuid))];
      const palettes = loadPalettes();
      for (const role of ["feature.altar", "opening.door", "wall.wall"]) {
        const wanted =
          resolveRole(palettes, "stone_dungeon", role).resolution?.variants.map((v) => v.uuid) ?? [];
        expect(wanted.length, `${role} resolves`).toBeGreaterThan(0);
        expect(
          saved.builtUuids.some((u) => wanted.includes(u)),
          `${role} is in the slab`,
        ).toBe(true);
      }
      // Floors: which floor a room gets is the generator's choice (since generator 4 it follows the room's
      // purpose and the plan's random seed, which the app picks per run), so the check is that the slab holds
      // the stone_dungeon floor of SOME material, not that it holds flagstone.
      const floorUuids = new Set(
        MATERIALS.flatMap(
          (m) =>
            resolveRole(palettes, "stone_dungeon", `floor.${m}`).resolution?.variants.map((v) => v.uuid) ??
            [],
        ),
      );
      expect(floorUuids.size, "stone_dungeon has floors").toBeGreaterThan(0);
      expect(
        saved.builtUuids.some((u) => floorUuids.has(u)),
        "a stone_dungeon floor is in the slab",
      ).toBe(true);
    } finally {
      await app.close(); // before-quit flushes the autosave
    }
  }

  // Restart: the project reopens with history, conversation and build intact, and the chat resumes.
  expect(existsSync(saved.filePath)).toBe(true);
  {
    const { app, page } = await launch(run);
    const invoke = invoker(page);
    try {
      const reopened = unwrap(await invoke("project:open", { path: saved.filePath }));
      if (!reopened) throw new Error("not reopened");
      expect(reopened.head).toBe(3);
      expect(reopened.approvedVersion).toBe(3);
      expect(reopened.builds).toHaveLength(1);
      expect(reopened.builds[0]?.levels.flatMap((l) => l.chunks)[0]?.levelIds).toEqual(["l1"]);
      const userTexts = reopened.conversation.items.flatMap((i) => (i.type === "user" ? [i.text] : []));
      expect(userTexts).toEqual([
        "A crypt under a ruined abbey for four players",
        "Tier 2",
        "Move the altar a bit east",
        "Describe the hall",
      ]);
      expect(reopened.ui.tab).toBeDefined();

      // The key was memory-only: the restarted app asks for it again (typed state), then resumes.
      expect(await invoke("chat:send", { text: "Are we done?" })).toMatchObject({
        ok: false,
        error: { code: "no_api_key" },
      });
      unwrap(
        await invoke("secrets:setApiKey", {
          providerId: "anthropic",
          apiKey: "sk-ant-e2e-test-0000000000000000",
          storage: "memory_only",
        }),
      );
      const t5 = await chat(page, { text: "Are we done?" });
      expect(last(t5)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });

      // The resumed request carried the whole earlier conversation to the model.
      const requests = readFileSync(run.log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { transcript: Array<{ type: string; text?: string }> });
      expect(requests).toHaveLength(STEPS.length);
      const resumed = requests.at(-1)?.transcript ?? [];
      expect(resumed.filter((i) => i.type === "user").map((i) => i.text)).toEqual([
        ...userTexts,
        "Are we done?",
      ]);
      expect(resumed.filter((i) => i.type === "assistant").length).toBeGreaterThanOrEqual(8);
      const final = unwrap(await invoke("project:snapshot", undefined));
      expect(final.conversation.totals.turns).toBe(5);
    } finally {
      await app.close();
    }
  }
  expect(saved.builtUuids.length).toBeGreaterThan(0);
});
