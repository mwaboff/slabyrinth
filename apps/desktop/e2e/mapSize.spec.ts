/**
 * The experimental "Maximum map size" setting in the real app (scripted provider in place of Anthropic, no network):
 * a plan wider than the standard 320 cells is refused at the standard size; after the GM picks 512 × 512 in Settings,
 * the model is told the new limits in the app's context message and the same plan is accepted.
 */
import { expect, test, type Page } from "@playwright/test";
import type { ChatEvent } from "../src/shared/ipc";
import { cleanRun, invoke, launch, newRun, unwrap, type Run } from "./helpers";

const usage = { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 };
const WIDE = {
  title: "Long Road",
  kind: "dungeon",
  theme: "stone_dungeon",
  seed: 7,
  levels: [
    {
      id: "l1",
      name: "Road",
      elevation: 0,
      bounds: { x: 0, y: 0, w: 400, h: 12 },
      base: { type: "solid" },
      areas: [{ id: "a", kind: "room", name: "Hall", shape: { type: "rect", x: 1, y: 1, w: 8, h: 6 } }],
      openings: [],
      features: [],
    },
  ],
  links: [],
};
const create = (callId: string) => ({
  kind: "reply",
  usage,
  parts: [
    {
      type: "tool_call",
      callId,
      name: "create_plan",
      input: { replace: false, summary: "Draft", changes: ["A long road"], plan: WIDE },
    },
  ],
});
const say = (text: string) => ({ kind: "reply", usage, parts: [{ type: "text", text }] });
const STEPS = [create("c1"), say("That is too wide for now."), create("c2"), say("Drawn.")];

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

let run: Run;
test.beforeEach(() => {
  run = newRun("slabyrinth-e2e-mapsize-", STEPS);
});
test.afterEach(() => {
  cleanRun(run);
});

test("a larger map size is chosen in Settings, told to the model, and used by validation", async () => {
  test.setTimeout(120_000);
  const { app, page } = await launch(run);
  try {
    const setup = page.getByRole("dialog", { name: "Welcome to Slabyrinth" });
    await setup.getByLabel("Anthropic API key").fill("sk-ant-e2e-test-0000000000000000");
    await setup.getByRole("button", { name: "Check key" }).click();
    await expect(setup.getByText(/Key works/)).toBeVisible({ timeout: 15_000 });
    await setup.getByRole("button", { name: "Next" }).click();
    await setup.getByRole("button", { name: "Continue without it" }).click({ timeout: 15_000 });
    await setup.getByRole("button", { name: "Start mapping" }).click();
    await expect(setup).toBeHidden();

    // standard: refused, with the hint naming the setting
    expect(await chat(page, "A long road")).toMatchObject({ type: "turn_finished" });
    expect(unwrap(await invoke(page, "project:snapshot", undefined)).head).toBe(0);
    const before = JSON.stringify(
      unwrap(await invoke(page, "project:snapshot", undefined)).conversation.items,
    );
    expect(before).toMatch(/bounds_exceeded/);
    expect(before).not.toContain("Map size setting:");

    // the GM picks 512 × 512 in Settings > Experimental
    await page.getByRole("button", { name: /^Settings/ }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Experimental" }).click();
    await settings.getByRole("radio", { name: "512 × 512" }).click();
    await expect(settings.getByRole("note")).toContainText("1.2 GB of memory");
    await expect
      .poll(async () => unwrap(await invoke(page, "settings:get", undefined)).mapSize)
      .toBe("large-512");
    await settings.getByRole("button", { name: "Done" }).click();

    // the next turn: the model is told the limits, and the same plan is accepted
    expect(await chat(page, "Try again")).toMatchObject({ type: "turn_finished" });
    const snap = unwrap(await invoke(page, "project:snapshot", undefined));
    expect(snap.head).toBe(1);
    expect(snap.plan?.levels[0]?.bounds.w).toBe(400);
    expect(JSON.stringify(snap.conversation.items)).toContain(
      "Map size setting: larger maps (experimental), at most 512 cells a side and 1,048,576 cells over all levels together",
    );
  } finally {
    await app.close();
  }
});
