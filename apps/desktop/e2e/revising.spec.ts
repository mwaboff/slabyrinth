/**
 * A revision in progress is visible everywhere: working card in the chat, stepper, map badge and bar, status bar,
 * labelled Stop. The scripted provider holds the edit mid-turn (plan tool streamed, not applied) so the spec can
 * look at it. Screenshots (dark and light) go to docs/internal/ui-test/ (git-ignored), not docs/renders/.
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { cleanRun, launch, newRun, type Run } from "./helpers";
import { UI_EDIT, UI_PLAN } from "./uiScript";

const call = (callId: string, name: string, input: unknown) => ({ type: "tool_call", callId, name, input });
const say = (text: string) => ({ type: "text", text });
const usage = { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 };

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
  { kind: "reply", usage, parts: [say("First take on the crypt.")] },
  {
    kind: "reply",
    usage,
    holdAfterToolStartMs: 60_000,
    parts: [
      call("te", "edit_plan", {
        baseVersion: 1,
        summary: "Guardroom notes",
        changes: ["Notes"],
        ops: [UI_EDIT],
      }),
    ],
  },
  { kind: "reply", usage, parts: [say("Added notes for the guardroom.")] },
];

const outDir = fileURLToPath(new URL("../../../docs/internal/ui-test/", import.meta.url));
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: `${outDir}${name}`, animations: "disabled" });

let run: Run;
test.beforeEach(() => {
  run = newRun("slabyrinth-e2e-revising-", STEPS);
  mkdirSync(outDir, { recursive: true });
});
test.afterEach(() => {
  cleanRun(run);
});

test("a revision in progress shows in the chat, stepper, map, status bar and Stop, then ends cleanly", async () => {
  test.setTimeout(120_000);
  const { app, page } = await launch(run);
  try {
    await page.setViewportSize({ width: 1600, height: 960 });
    const setup = page.getByRole("dialog", { name: "Welcome to Slabyrinth" });
    await setup.getByLabel("Anthropic API key").fill("sk-ant-e2e-test-0000000000000000");
    await setup.getByRole("button", { name: "Check key" }).click();
    await expect(setup.getByText(/Key works/)).toBeVisible({ timeout: 15_000 });
    await setup.getByRole("button", { name: "Next" }).click();
    await setup.getByRole("button", { name: "Continue without it" }).click({ timeout: 15_000 });
    await setup.getByRole("button", { name: "Start mapping" }).click();
    await expect(setup).toBeHidden();

    const composer = page.getByLabel("Message Slabyrinth");
    await composer.fill("A crypt under a ruined abbey");
    await composer.press("Enter");
    await expect(page.getByRole("button", { name: /Approve plan v1/ })).toBeVisible({ timeout: 30_000 });

    await composer.fill("Write notes for the guardroom");
    await composer.press("Enter");

    // chat: working card at the end of the thread
    const card = page.locator(".working");
    await expect(card.getByText("Revising plan v1 → v2")).toBeVisible({ timeout: 15_000 });
    // the live step line comes from the progress events / open tool calls (exact wording depends on them)
    await expect(card.locator(".working__step")).not.toHaveText("");
    console.log("step line:", await card.locator(".working__step").innerText());
    // stepper, map, status bar
    await expect(page.locator(".step--busy")).toContainText("Plan v1 · revising");
    await expect(page.locator(".revisebar")).toBeVisible();
    await expect(page.locator(".revising")).toContainText("Revising…");
    await expect(page.locator(".statusbar__live")).toContainText("Revising…");
    const approve = page.getByRole("button", { name: /Approve plan v1/ });
    await expect(approve).toBeDisabled();
    await expect(approve).toHaveAttribute("title", /revision finishes/);
    // the composer's stop button names itself
    const stop = page.getByRole("button", { name: "Stop (Esc)" });
    await expect(stop).toContainText("Stop");
    // the live region said so
    await expect(
      page.getByRole("status").filter({ hasText: "Slabyrinth is working on plan v1." }),
    ).toHaveCount(1);

    await shot(page, "revising-dark.png");
    await page.getByRole("button", { name: /^Theme:/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await shot(page, "revising-light.png");

    // Stop ends every signal cleanly
    await stop.click();
    await expect(card).toHaveCount(0);
    await expect(page.locator(".revisebar")).toHaveCount(0);
    await expect(page.locator(".revising")).toHaveCount(0);
    await expect(page.locator(".statusbar__live")).toHaveCount(0);
    await expect(page.locator(".step--busy")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Stopped." })).toHaveCount(1);
  } finally {
    await app.close();
  }
});
