/**
 * Update notice in the real app, without any network: the e2e TEST BUILD reads a canned GitHub
 * "latest release" response from SLABYRINTH_E2E_UPDATE_RESPONSE (safe mode only; production bundles drop
 * that code) and runs the startup check once. The chip appears, the popover shows the notes as the allow-listed
 * Markdown subset (headings, lists, bold, code) with hostile HTML and links left as text, and "Skip this version"
 * is remembered in settings.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { cleanRun, invoke, launch, newRun, unwrap, type Run } from "./helpers";

const renders = (name: string): string =>
  fileURLToPath(new URL(`../../../docs/renders/${name}`, import.meta.url));

/** A hostile line among ordinary notes: the HTML must show as literal text, the link as its text only. */
const HOSTILE =
  '<img src=x onerror=alert(1)> <a href="https://evil.example">x</a> [click](javascript:alert(1))';
const HOSTILE_SHOWN = '<img src=x onerror=alert(1)> <a href="https://evil.example">x</a> click';
const NOTES_BODY = [
  "### Added",
  "",
  "- **Stamps**: place a saved room again in one click.",
  "- Undo a stamp with `Ctrl+Z`, like any other change.",
  "",
  "### Fixed",
  "",
  "- Stairs no longer end inside a wall.",
  `- ${HOSTILE}`,
].join("\r\n");

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
      body: NOTES_BODY,
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
    await expect(notes.getByRole("heading", { name: "Added" })).toBeVisible();
    await expect(notes.getByRole("heading", { name: "Fixed" })).toBeVisible();
    await expect(notes.locator("li")).toHaveCount(4);
    await expect(notes.locator("strong")).toHaveText("Stamps");
    await expect(notes.locator("code")).toHaveText("Ctrl+Z");
    await expect(notes).toContainText(HOSTILE_SHOWN);
    // Nothing from the notes became markup: no dangerous elements, no attribute other than our static classes.
    const found = await notes.evaluate((root) => ({
      dangerous: root.querySelectorAll("a, img, script, iframe, style, object, embed, form, svg, b").length,
      attrs: [...root.querySelectorAll("*")].flatMap((el) =>
        el.getAttributeNames().filter((n) => n !== "class"),
      ),
    }));
    expect(found).toEqual({ dangerous: 0, attrs: [] });

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
