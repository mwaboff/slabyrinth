/**
 * Retry rules (decisions.md, "Retry after the user changed the map") in the real app: real engine, IPC and UI,
 * scripted provider, hidden window (SLABYRINTH_E2E=1).
 *  (a) Retry of the turn that drew the first plan puts the map back to "no plan" (the stage shows the brief's
 *      "No map yet"), and the retried turn draws a plan again.
 *  (b) After the user moves the head away from the last reply's version (Undo), Retry is refused: the refusal
 *      is shown inline in the chat and nothing changes (head, thread, no provider request).
 */
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { cleanRun, invoke, launch, newRun, unwrap, type Run } from "./helpers";
import { UI_EDIT, UI_PLAN } from "./uiScript";

const call = (callId: string, name: string, input: unknown) => ({ type: "tool_call", callId, name, input });
const say = (text: string) => ({ type: "text", text });
const usage = { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 };
const draft = (callId: string, delayMs = 0) => ({
  kind: "reply",
  usage,
  delayMs,
  parts: [
    call(callId, "create_plan", {
      replace: false,
      summary: "First draft",
      changes: ["Two levels"],
      plan: UI_PLAN,
    }),
  ],
});

const RETRY_STEPS = [
  draft("tc1"),
  { kind: "reply", usage, parts: [say("First take on the crypt.")] },
  // Retry of that turn (slow, so the spec can see the map back at "no plan" while it runs):
  draft("tc2", 5000),
  { kind: "reply", usage, parts: [say("Second take on the crypt.")] },
  // An edit turn (v2 → v3):
  {
    kind: "reply",
    usage,
    parts: [
      call("te", "edit_plan", {
        baseVersion: 2,
        summary: "Guardroom notes",
        changes: ["Notes"],
        ops: [UI_EDIT],
      }),
    ],
  },
  { kind: "reply", usage, parts: [say("Added notes for the guardroom.")] },
];

const requests = (run: Run): number =>
  existsSync(run.log)
    ? readFileSync(run.log, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "").length
    : 0;

async function finishSetup(page: Page): Promise<void> {
  const setup = page.getByRole("dialog", { name: "Welcome to Slabyrinth" });
  await setup.getByLabel("Anthropic API key").fill("sk-ant-e2e-test-0000000000000000");
  await setup.getByRole("button", { name: "Check key" }).click();
  await expect(setup.getByText(/Key works/)).toBeVisible({ timeout: 15_000 });
  await setup.getByRole("button", { name: "Next" }).click();
  await setup.getByRole("button", { name: "Continue without it" }).click({ timeout: 15_000 });
  await setup.getByRole("button", { name: "Start mapping" }).click();
  await expect(setup).toBeHidden();
}

let run: Run;
test.beforeEach(() => {
  run = newRun("slabyrinth-e2e-retry-", RETRY_STEPS);
});
test.afterEach(() => {
  cleanRun(run);
});

test("Retry: the first draft goes back to no plan; a map changed after the reply refuses Retry", async () => {
  test.setTimeout(180_000);
  const { app, page } = await launch(run);
  try {
    await page.setViewportSize({ width: 1600, height: 960 });
    await finishSetup(page);
    const composer = page.getByLabel("Message Slabyrinth");
    const thread = page.getByRole("log", { name: "Conversation" });
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    const head = async (): Promise<number> => unwrap(await invoke(page, "project:snapshot", undefined)).head;

    // ── (a) the first-draft turn, then Retry ──
    await composer.fill("A crypt under a ruined abbey");
    await composer.press("Enter");
    await expect(page.getByRole("button", { name: /Approve plan v1/ })).toBeVisible({ timeout: 30_000 });
    await expect(thread.getByText("First take on the crypt.")).toBeVisible();
    expect(await head()).toBe(1);

    await retry.click();
    // While the retried turn runs: the head is back at 0 (no plan) and the stage is back at the brief.
    await expect.poll(head, { timeout: 4000 }).toBe(0);
    await expect(page.getByText("No levels yet")).toBeVisible({ timeout: 4000 });
    await expect(page.getByRole("heading", { name: /No map yet|Drafting the plan/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Approve plan v1/ })).toHaveCount(0);
    // Then the retried turn draws again (v2).
    await expect(page.getByRole("button", { name: /Approve plan v2/ })).toBeVisible({ timeout: 30_000 });
    await expect(thread.getByText("Second take on the crypt.")).toBeVisible();
    await expect(thread.getByText("First take on the crypt.")).toHaveCount(0);
    const snap = unwrap(await invoke(page, "project:snapshot", undefined));
    expect(snap.head).toBe(2);
    // v1 was undone by the Retry (parent 0 = no plan), v2 was drawn from no plan.
    expect(snap.versions.find((v) => v.number === 2)?.parentNumber ?? 0).toBe(0);
    expect(requests(run)).toBe(4);

    // ── (b) a later reply, then the user moves the map (Undo), then Retry ──
    await composer.fill("Write notes for the guardroom");
    await composer.press("Enter");
    await expect(page.getByRole("button", { name: /Approve plan v3/ })).toBeVisible({ timeout: 30_000 });
    await expect(thread.getByText("Added notes for the guardroom.")).toBeVisible();
    await page.getByRole("button", { name: /History · / }).click();
    const history = page.getByRole("complementary", { name: "Version history" });
    await history.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("button", { name: /Approve plan v2/ })).toBeVisible();
    await history.getByRole("button", { name: "Close history (H)" }).click();

    const itemsBefore = unwrap(await invoke(page, "project:snapshot", undefined)).conversation.items.length;
    const sent = requests(run);
    await retry.click();
    await expect(
      page.getByRole("status").filter({ hasText: "You changed the map after this reply." }),
    ).toBeVisible();
    const after = unwrap(await invoke(page, "project:snapshot", undefined));
    expect(after.head).toBe(2);
    expect(after.conversation.items).toHaveLength(itemsBefore);
    await expect(thread.getByText("Added notes for the guardroom.")).toBeVisible();
    expect(requests(run)).toBe(sent);
  } finally {
    await app.close();
  }
});
