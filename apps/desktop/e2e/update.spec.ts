/**
 * Update notice in the real app, without any network: the e2e TEST BUILD reads a canned GitHub
 * "latest release" response from SLABYRINTH_E2E_UPDATE_RESPONSE (safe mode only; production bundles drop
 * that code) and runs the startup check once. The chip appears, the popover shows the notes as plain text,
 * and "Skip this version" is remembered in settings.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { cleanRun, invoke, launch, newRun, unwrap, type Run } from "./helpers";

const renders = (name: string): string =>
  fileURLToPath(new URL(`../../../docs/renders/${name}`, import.meta.url));

let run: Run;
test.beforeEach(() => {
  run = newRun("slabyrinth-e2e-update-", []);
});
test.afterEach(() => {
  cleanRun(run);
});

test("update chip → popover → Skip this version", async () => {
  // Past the first-run Setup, so the header (and its chip) is the first thing on screen.
  mkdirSync(run.userData, { recursive: true });
  writeFileSync(
    path.join(run.userData, "settings.json"),
    JSON.stringify({ schema: "slabyrinth/settings@1", setupCompleted: true }),
  );
  const canned = path.join(run.dir, "latest-release.json");
  writeFileSync(
    canned,
    JSON.stringify({
      tag_name: "v99.0.0",
      draft: false,
      prerelease: false,
      published_at: "2026-11-30T09:00:00Z",
      html_url: "https://evil.example/not-used",
      body: "Added\r\n- Stamps\r\n\r\n<b>not html</b>",
    }),
  );
  const { app, page } = await launch(run, { SLABYRINTH_E2E_UPDATE_RESPONSE: canned });
  try {
    const chip = page.getByRole("button", { name: "Update available · 99.0.0" });
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await chip.click();
    const pop = page.getByRole("dialog", { name: "Update available" });
    await expect(pop.getByText("Slabyrinth 99.0.0")).toBeVisible();
    const notes = pop.getByLabel("What's new");
    await expect(notes).toHaveText("Added\n- Stamps\n\n<b>not html</b>");
    expect(await notes.locator("b").count()).toBe(0);

    const status = unwrap(await invoke(page, "updates:status", undefined));
    expect(status.update?.url).toBe("https://github.com/mwaboff/slabyrinth/releases/tag/v99.0.0");

    // Screenshots of the open popover in both themes (docs/renders/real-09-update-*.png).
    await page.screenshot({ path: renders("real-09-update-dark.png"), animations: "disabled" });
    const current = unwrap(await invoke(page, "settings:get", undefined));
    unwrap(await invoke(page, "settings:update", { ui: { ...current.ui, theme: "light" } }));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(pop).toBeVisible();
    await page.screenshot({ path: renders("real-09-update-light.png"), animations: "disabled" });
    unwrap(await invoke(page, "settings:update", { ui: { ...current.ui, theme: "dark" } }));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await pop.getByRole("button", { name: "Skip this version" }).click();
    await expect(chip).toBeHidden();
    const settings = unwrap(await invoke(page, "settings:get", undefined));
    expect(settings.updates).toMatchObject({ autoCheck: true, skippedVersion: "99.0.0" });
    expect(typeof settings.updates.lastCheckedAt).toBe("string");
  } finally {
    await app.close();
  }
});
