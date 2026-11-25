/**
 * The real UI in the real app: Electron + preload bridge + real engine (scripted provider in place of
 * Anthropic), real compiler and slab codec — driven only through what the user sees (roles, labels, text).
 * Hidden window, throwaway userData, memory clipboard, no TaleSpire lookup or launch (SLABYRINTH_E2E=1).
 * Screenshots of every stage go to docs/renders/real-*.png.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { slabCodec } from "@slabyrinth/core/slab";
import { cleanRun, invoke, launch, newRun, unwrap, type Run } from "./helpers";
import { UI_STEPS } from "./uiScript";

const renders = (name: string): string =>
  fileURLToPath(new URL(`../../../docs/renders/${name}`, import.meta.url));
/**
 * `animations: "disabled"` finishes CSS transitions before capturing. Without it a button that had just become
 * enabled (e.g. Approve, re-enabled as the plan turn ends) was captured at the first frame of its 150 ms
 * background transition: the old disabled surface with the new enabled text colour.
 */
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: renders(name), animations: "disabled" });

/** Share of non-transparent pixels on the map canvas (the map really drew). */
function inkedShare(page: Page): Promise<number> {
  return page.evaluate(() => {
    const cv = document.querySelector<HTMLCanvasElement>("canvas.canvas__el");
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx || cv.width === 0) return 0;
    const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
    let inked = 0;
    for (let i = 3; i < data.length; i += 16) if ((data[i] ?? 0) > 0) inked++;
    return inked / (data.length / 16);
  });
}

let run: Run;
test.beforeEach(() => {
  run = newRun("slabyrinth-e2e-ui-", UI_STEPS);
});
test.afterEach(() => {
  cleanRun(run);
});

test("the real UI: setup → brief → plan → map → edit → history → approve → build → PNG → settings → resume", async () => {
  test.setTimeout(240_000);
  let copiedText: string | null | undefined;
  {
    const { app, page } = await launch(run);
    try {
      await page.setViewportSize({ width: 1600, height: 960 });

      // ── 1. First run: setup with no key and no TaleSpire ──
      const setup = page.getByRole("dialog", { name: "Welcome to Slabyrinth" });
      await expect(setup.getByRole("heading", { name: "Connect Claude" })).toBeVisible();
      await shot(page, "real-01-setup.png");
      await setup.getByLabel("Anthropic API key").fill("sk-ant-e2e-test-0000000000000000");
      await setup.getByRole("button", { name: "Check key" }).click();
      await expect(setup.getByText(/Key works/)).toBeVisible({ timeout: 15_000 });
      await setup.getByRole("button", { name: "Next" }).click();
      await expect(setup.getByText("TaleSpire wasn't found on this PC.")).toBeVisible({ timeout: 15_000 });
      await setup.getByRole("button", { name: "Continue without it" }).click();
      await expect(setup.getByRole("heading", { name: "How you play" })).toBeVisible();
      await setup.getByRole("radio", { name: "Daggerheart" }).click();
      await setup.getByRole("button", { name: "Start mapping" }).click();
      await expect(setup).toBeHidden();

      // Setup lands in a new map; go to Home and back in through the Continue card.
      await expect(page.getByLabel("Message Slabyrinth")).toBeVisible();
      await page.getByRole("button", { name: /^Slabyrinth$/ }).click();
      const cont = page.getByRole("region", { name: "Continue" });
      await expect(cont.getByRole("heading", { name: "Untitled map" })).toBeVisible();
      await shot(page, "real-02-home.png");
      await cont.getByRole("button", { name: /Continue/ }).click();

      // ── 2. Brief → question card → plan ──
      const composer = page.getByLabel("Message Slabyrinth");
      await composer.fill("A crypt under a ruined abbey for four players");
      await composer.press("Enter");
      const card = page.getByRole("group", { name: "Clarifying questions" });
      await expect(card.getByText("Which tier?")).toBeVisible({ timeout: 20_000 });
      await card.getByRole("button", { name: "Tier 2" }).click();
      await expect(card.getByRole("button", { name: "Tier 2" })).toHaveAttribute("aria-pressed", "true");
      await card.getByRole("button", { name: "Send answers" }).click();
      const approveBtn = page.getByRole("button", { name: /Approve plan v1/ });
      await expect(approveBtn).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/Answered: Tier 2/)).toBeVisible();
      await expect.poll(() => inkedShare(page), { timeout: 15_000 }).toBeGreaterThan(0.2);

      // ── 3. The map: select a room, key panel, level tabs, zoom, issues ──
      const canvas = page.getByRole("application", { name: /Map of L1/ });
      const box = await canvas.boundingBox();
      if (!box) throw new Error("no map canvas");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); // centre of the level = Hall of Pillars
      const selbar = page.getByRole("toolbar", { name: "Selection" });
      await expect(selbar.getByText("Hall of Pillars")).toBeVisible();
      const key = page.getByRole("complementary", { name: "Room key" });
      await expect(key.getByRole("button", { name: /Hall of Pillars/, expanded: true })).toBeVisible();
      await expect(key.getByText("GM notes")).toBeVisible();
      await expect(approveBtn).toBeEnabled({ timeout: 10_000 });
      await shot(page, "real-03-plan.png");

      await page.getByRole("tab", { name: /L2 Cistern Depths/ }).click();
      await expect(page.getByRole("application", { name: /Map of L2, Cistern Depths/ })).toBeVisible();
      await expect(key.getByText(/Flooded Cistern/)).toBeVisible();
      await page.getByRole("tab", { name: /L1 Upper Crypts/ }).click();
      const zoomLabel = page.getByRole("button", { name: /^\d+%$/ });
      const before = await zoomLabel.innerText();
      await page.getByRole("button", { name: "Zoom in (+)" }).click();
      await expect(zoomLabel).not.toHaveText(before);

      const chip = page.getByRole("button", { name: /warning/ });
      await expect(chip).toBeVisible();
      await chip.click();
      const issues = page.getByRole("dialog", { name: "Plan issues" });
      await expect(issues.getByText(/bookshelf "shelf_mid" stands in the middle of the floor/)).toBeVisible();
      await shot(page, "real-04-issues.png");
      await issues.getByRole("button", { name: /bookshelf "shelf_mid"/ }).click(); // shows it on the map
      await expect(issues).toBeHidden();

      // ── 4. An edit through the composer ──
      await composer.fill("Write notes for the guardroom");
      await composer.press("Enter");
      await expect(page.getByRole("button", { name: /Approve plan v2/ })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Added notes for the guardroom.")).toBeVisible();

      // History: undo then redo moves the head pointer.
      await page.getByRole("button", { name: /History · 2/ }).click();
      const history = page.getByRole("complementary", { name: "Version history" });
      await history.getByRole("button", { name: "Undo" }).click();
      await expect(page.getByRole("button", { name: /Approve plan v1/ })).toBeVisible();
      await history.getByRole("button", { name: "Redo" }).click();
      await expect(page.getByRole("button", { name: /Approve plan v2/ })).toBeVisible();
      await history.getByRole("button", { name: "Close history (H)" }).click();

      // ── 5. Approve → build → copy → pasted ──
      await page.getByRole("button", { name: /Approve plan v2/ }).click();
      const approve = page.getByRole("dialog", { name: "Approve v2" });
      await expect(approve.getByText("These warnings can be approved anyway.")).toBeVisible();
      await approve.getByRole("button", { name: "Approve & build" }).click();
      await expect(page.getByRole("heading", { name: "Built from v2" })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(/The whole map, every level, in one slab/)).toBeVisible();
      await shot(page, "real-05-build.png");

      await page.getByRole("button", { name: "Copy", exact: true }).click();
      await expect(page.getByText("Slab copied.", { exact: true })).toBeVisible();
      // The copied text: re-derive the build shown (same version, deterministic) and decode it with core's codec.
      const snap = unwrap(await invoke(page, "project:snapshot", undefined));
      const rec = snap.builds.at(-1);
      expect(rec?.versionNumber).toBe(2);
      const recChunk = rec?.levels.flatMap((l) => l.chunks)[0];
      expect(recChunk?.copiedAt).toBeTruthy();
      // The memory clipboard main uses in e2e mode (globalThis.__slabyrinthClipboard, safe mode only).
      copiedText = await app.evaluate(
        () =>
          (globalThis as { __slabyrinthClipboard?: { last: string | null } }).__slabyrinthClipboard?.last ??
          null,
      );
      expect(copiedText).toBeTruthy();
      expect(slabCodec.decode(copiedText ?? "").assets.length).toBeGreaterThan(0);

      const pasted = page.getByRole("checkbox", { name: "Pasted" });
      await page.getByText("Pasted", { exact: true }).click(); // the visible label, as a user would
      await expect(pasted).toBeChecked();
      await expect
        .poll(
          async () =>
            unwrap(await invoke(page, "project:snapshot", undefined))
              .builds.at(-1)
              ?.levels.flatMap((l) => l.chunks)[0]?.pasted,
        )
        .toBe(true);

      // A build the plan has moved past (Undo to v1): Approve & rebuild is the main action, the copy is "anyway".
      await page.getByRole("tab", { name: "Map", exact: true }).click();
      await page.getByRole("button", { name: /History · / }).click();
      await history.getByRole("button", { name: "Undo" }).click();
      await history.getByRole("button", { name: "Close history (H)" }).click();
      await page.getByRole("tab", { name: "Build", exact: true }).click();
      await expect(page.getByRole("button", { name: "Approve v1 & rebuild" })).toHaveClass(/btn--primary/);
      const staleCopy = page.getByRole("button", { name: /^Copy v2 .*anyway$/ });
      await expect(staleCopy).toBeVisible();
      await expect(staleCopy).not.toHaveClass(/btn--primary/);
      await expect(page.getByRole("button", { name: "Copy & open TaleSpire" })).toHaveCount(0);
      await page.getByRole("tab", { name: "Map", exact: true }).click();
      await page.getByRole("button", { name: /History · / }).click();
      await history.getByRole("button", { name: "Redo" }).click();
      await history.getByRole("button", { name: "Close history (H)" }).click();

      // ── 6. Export PNG: change an option; it persists after reopening ──
      await page.getByRole("tab", { name: "Map", exact: true }).click();
      await page.getByRole("button", { name: /Export PNG/ }).click();
      let png = page.getByRole("dialog", { name: "Export PNG" });
      await png.getByRole("radio", { name: "Player-safe" }).click();
      await expect(png.getByRole("radio", { name: "Player-safe" })).toHaveAttribute("aria-checked", "true");
      await shot(page, "real-06-export.png");
      await png.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: /Export PNG/ }).click();
      png = page.getByRole("dialog", { name: "Export PNG" });
      await expect(png.getByRole("radio", { name: "Player-safe" })).toHaveAttribute("aria-checked", "true");
      await png.getByRole("button", { name: "Cancel" }).click();

      // ── 7. Settings: light theme and back; the real provider's models ──
      await page.getByRole("button", { name: /^Settings/ }).click();
      const settings = page.getByRole("dialog", { name: "Settings" });
      const models = settings.getByRole("radiogroup", { name: "Default model" });
      await expect(models.getByRole("radio")).not.toHaveCount(0);
      await expect(models.getByRole("radio", { name: /Opus/ })).toHaveAttribute("aria-checked", "true");
      await expect(settings.getByRole("radiogroup", { name: "Effort" })).toBeVisible();
      await settings.getByRole("button", { name: "Appearance" }).click();
      await settings.getByRole("radio", { name: "Light" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await settings.getByRole("button", { name: "AI provider" }).click();
      await shot(page, "real-07-settings-light.png");
      await settings.getByRole("button", { name: "Appearance" }).click();
      await settings.getByRole("radio", { name: "Dark" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      // TaleSpire: the pillar box saves through main's request schema (0.3.0 refused it: "Unrecognized keys") and
      // keeps main's own TaleSpire fields; untick it again so the restart below rebuilds the same slab.
      await settings.getByRole("button", { name: "TaleSpire & assets" }).click();
      const pillars = settings.getByRole("checkbox", { name: /Add alignment pillars to single-slab builds/ });
      const savedTs = async () => unwrap(await invoke(page, "settings:get", undefined)).talespire;
      const tsBefore = await savedTs();
      for (const on of [true, false]) {
        await settings.getByText("Add alignment pillars to single-slab builds").click();
        await expect.poll(async () => (await savedTs()).alignmentMarkers).toBe(on);
        await expect(pillars).toBeChecked({ checked: on });
      }
      expect(await savedTs()).toEqual(tsBefore);
      await expect(page.getByText(/Invalid request/)).toHaveCount(0);
      await settings.getByRole("button", { name: "Done" }).click();

      // Leave the map tab showing L2 so the resumed view can be checked.
      await page.getByRole("tab", { name: /L2 Cistern Depths/ }).click();
      await page.waitForTimeout(1200); // resume state is saved debounced
    } finally {
      await app.close(); // before-quit flushes the autosave
    }
  }

  // ── 8. Relaunch with the same userData: Home lists the map; everything is restored ──
  {
    const { app, page } = await launch(run);
    try {
      await page.setViewportSize({ width: 1600, height: 960 });
      const cont = page.getByRole("region", { name: "Continue" });
      await expect(cont.getByRole("heading", { name: "Untitled map" })).toBeVisible();
      await cont.getByRole("button", { name: /Continue/ }).click();
      const thread = page.getByRole("log", { name: "Conversation" });
      await expect(thread.getByText("A crypt under a ruined abbey for four players")).toBeVisible();
      await expect(thread.getByText("Write notes for the guardroom")).toBeVisible();
      await expect(page.getByRole("tab", { name: /L2 Cistern Depths/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.getByRole("button", { name: /Open build/ }).first()).toBeVisible();
      await expect.poll(() => inkedShare(page), { timeout: 15_000 }).toBeGreaterThan(0.2);
      const snap = unwrap(await invoke(page, "project:snapshot", undefined));
      expect(snap.head).toBe(2);
      expect(snap.approvedVersion).toBe(2);
      expect(snap.builds).toHaveLength(1);
      expect(snap.pngExport?.gmLayer).toBe(false);
      await shot(page, "real-08-resumed.png");

      // The build tab shows the same slab; re-copy after restart recompiles it — decode what main hands back.
      await page.getByRole("tab", { name: "Build", exact: true }).click();
      await expect(page.getByRole("checkbox", { name: "Pasted" })).toBeChecked();
      const bundle = unwrap(await invoke(page, "compile:run", { version: 2 }));
      const chunk = bundle.chunks[0];
      if (!chunk) throw new Error("no chunk");
      expect(chunk.contentHash).toBe(snap.builds[0]?.levels.flatMap((l) => l.chunks)[0]?.contentHash);
      // What Copy put on the clipboard before the restart is exactly the built slab string.
      expect(copiedText).toBe(chunk.slab);
      expect(slabCodec.decode(chunk.slab).assets).toHaveLength(chunk.assetCount);
    } finally {
      await app.close();
    }
  }
});
