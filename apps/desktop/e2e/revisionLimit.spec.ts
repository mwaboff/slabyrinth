/**
 * The revision limit in the real app (scripted provider in place of Anthropic, no network): the GM sets "Changes per
 * message" to 1 in Settings, Claude stops after one change and the chat asks; Keep going grants one more, the count runs
 * from the GM's message, and That's enough closes the card with every change kept.
 */
import { expect, test } from "@playwright/test";
import { cleanRun, invoke, launch, newRun, unwrap, type Run } from "./helpers";
import { UI_EDIT, UI_PLAN } from "./uiScript";

const usage = { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 };
const call = (callId: string, name: string, input: unknown) => ({ type: "tool_call", callId, name, input });

const STEPS = [
  {
    kind: "reply",
    usage,
    parts: [
      call("tc", "create_plan", {
        replace: false,
        summary: "First draft",
        changes: ["Two levels"],
        plan: UI_PLAN,
      }),
    ],
  },
  {
    kind: "reply",
    usage,
    parts: [
      call("te", "edit_plan", {
        baseVersion: 1,
        summary: "Guardroom notes",
        changes: ["Notes"],
        ops: [UI_EDIT],
      }),
    ],
  },
];

let run: Run;
test.beforeEach(() => {
  run = newRun("slabyrinth-e2e-revlimit-", STEPS);
});
test.afterEach(() => {
  cleanRun(run);
});

test("Changes per message: Claude stops at the limit, Keep going grants more, That's enough closes the card", async () => {
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
    await expect.poll(async () => (await invoke(page, "project:snapshot", undefined)).ok).toBe(true);

    // Settings > AI: one change per message
    await page.getByRole("button", { name: /^Settings/ }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    const limit = settings.getByRole("combobox", { name: "Changes per message" });
    await expect(limit).toHaveValue("4");
    await limit.selectOption("1");
    await expect
      .poll(async () => unwrap(await invoke(page, "settings:get", undefined)).agent?.maxRevisionsPerTurn)
      .toBe(1);
    await settings.getByRole("button", { name: "Done" }).click();

    const composer = page.getByLabel("Message Slabyrinth");
    await composer.fill("A crypt under a ruined abbey");
    await composer.press("Enter");
    const card = page.getByRole("status", { name: "Claude is waiting for you" });
    await expect(card).toContainText(
      "Claude has changed the map once for this message and wants to keep going.",
      { timeout: 30_000 },
    );
    await expect(card).toContainText(/This message has cost about \$\d+\.\d\d so far/);
    expect(unwrap(await invoke(page, "project:snapshot", undefined)).head).toBe(1);

    await card.getByRole("button", { name: "Keep going (up to 1 more change)" }).click();
    await expect(card).toContainText("Claude has changed the map twice for this message", {
      timeout: 30_000,
    });
    expect(unwrap(await invoke(page, "project:snapshot", undefined)).head).toBe(2);

    await card.getByRole("button", { name: "That's enough" }).click();
    await expect(card).toHaveCount(0);
    await expect(composer).toBeFocused();
    expect(unwrap(await invoke(page, "project:snapshot", undefined)).head).toBe(2);
  } finally {
    await app.close();
  }
});
