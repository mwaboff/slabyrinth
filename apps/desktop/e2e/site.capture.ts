/**
 * Marketing screenshots for the landing page (site/) and preview shots of the page itself.
 * NOT part of `npm run test:e2e` (playwright.config.ts only matches *.spec.ts); run with
 * `npm run capture:site` from the repo root (builds the test bundle first).
 *
 * Same safety as the e2e specs: hidden window, throwaway userData, scripted provider instead of Anthropic
 * (no network, no API cost), memory clipboard, no TaleSpire lookup or launch (SLABYRINTH_E2E=1).
 * Output: site/assets/img/*.webp (app, 2x, downscaled) and docs/renders/site-*.png (page previews).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  _electron as electron,
  expect,
  test,
  type CDPSession,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { cleanRun, invoke, mainEntry, newRun, unwrap, type Run } from "./helpers";
import { UI_PLAN } from "./uiScript";

const repo = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

const call = (callId: string, name: string, input: unknown) => ({ type: "tool_call", callId, name, input });
const say = (text: string) => ({ type: "text", text });
const usage = { inputTokens: 1400, outputTokens: 700, cacheReadTokens: 9000, cacheWriteTokens: 300 };

/** Example A (two levels) with a bookshelf left in the middle of the hall, so the check has something to say. */
const plan = structuredClone(UI_PLAN);

const STEPS = [
  {
    kind: "reply",
    usage,
    parts: [
      say("A crypt beneath a ruined abbey, with a flooded level below. Two quick questions first."),
      call("tb", "update_brief", { set: { mapType: "Dungeon", system: "daggerheart" } }),
      call("tq", "ask_questions", {
        questions: [
          {
            id: "q1",
            text: "Which tier are the players?",
            default: "Tier 2",
            options: ["Tier 1", "Tier 2", "Tier 3"],
          },
          {
            id: "q2",
            text: "How should the lower level feel?",
            default: "Flooded cistern",
            options: ["Flooded cistern", "Dry catacombs", "Natural caves"],
          },
        ],
      }),
    ],
  },
  {
    kind: "reply",
    usage,
    parts: [
      call("tc", "create_plan", {
        replace: false,
        summary: "First draft",
        changes: ["Upper crypts with a pillared hall", "Flooded cistern and drowned chapel below"],
        plan,
      }),
    ],
  },
  {
    kind: "reply",
    usage,
    parts: [
      say(
        "Here's a first draft: four rooms in the upper crypts, and a flooded cistern below reached by the ossuary stairs.",
      ),
    ],
  },
  {
    kind: "reply",
    usage,
    parts: [
      call("te", "edit_plan", {
        baseVersion: 1,
        summary: "Cleared the hall",
        changes: ["Moved the bookshelf from the middle of the hall to the south wall"],
        ops: [{ op: "update", id: "shelf_mid", set: { at: [19, 13] } }],
      }),
    ],
  },
  {
    kind: "reply",
    usage,
    parts: [say("Moved the stray bookshelf against the south wall. The plan check is clean now.")],
  },
];

async function launchHiDpi(run: Run): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env["ANTHROPIC_API_KEY"];
  delete env["SLABYRINTH_FAKE_ENGINE"];
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

/** Fit the whole level in view (after a panel opens or the level changes). */
async function fit(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Fit level (0)" }).click();
  await page.waitForTimeout(400);
}

/** Screenshot → downscaled WebP (encoded by Chromium in the page; no extra dependencies). */
async function shotWebp(page: Page, cdp: CDPSession, name: string, width = 2000): Promise<void> {
  await page.mouse.move(0, 0); // nothing hovered
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur(); // no focus rings in frame
  });
  // Playwright's screenshot settles transitions (animations: "disabled") but returns CSS pixels for an
  // Electron page; the 2x capture comes straight from CDP right after it.
  await page.screenshot({ animations: "disabled" });
  const { data: png } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const b64 = await page.evaluate(
    async ([data, w]) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const outW = Math.min(w, bmp.width);
      const outH = Math.round((bmp.height * outW) / bmp.width);
      const cv = new OffscreenCanvas(outW, outH);
      const ctx = cv.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bmp, 0, 0, outW, outH);
      const blob = await cv.convertToBlob({ type: "image/webp", quality: 0.86 });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return `${outW}x${outH}:${btoa(s)}`;
    },
    [png, width] as const,
  );
  const [size, data] = b64.split(":") as [string, string];
  writeFileSync(repo(`site/assets/img/${name}.webp`), Buffer.from(data, "base64"));
  console.log(`site/assets/img/${name}.webp ${size}`);
}

test("app screenshots for the landing page", async () => {
  test.setTimeout(240_000);
  const run = newRun("slabyrinth-site-", STEPS);
  const { app, page } = await launchHiDpi(run);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    // 2x pixels for sharp marketing shots.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });

    // Setup (no real key: the scripted provider accepts any).
    const setup = page.getByRole("dialog", { name: "Welcome to Slabyrinth" });
    await setup.getByLabel("Anthropic API key").fill("sk-ant-e2e-test-0000000000000000");
    await setup.getByRole("button", { name: "Check key" }).click();
    await expect(setup.getByText(/Key works/)).toBeVisible({ timeout: 15_000 });
    await setup.getByRole("button", { name: "Next" }).click();
    await setup.getByRole("button", { name: "Continue without it" }).click();
    await setup.getByRole("radio", { name: "Daggerheart" }).click();
    await setup.getByRole("button", { name: "Start mapping" }).click();
    await expect(setup).toBeHidden();
    unwrap(await invoke(page, "project:rename", { name: "The Drowned Abbey" }));
    // Hide the "TaleSpire wasn't found" banner (e2e runs never look for the game).
    await page.getByRole("button", { name: "Continue without it" }).click();

    // 1 · Talk
    const composer = page.getByLabel("Message Slabyrinth");
    await composer.fill("A two-level crypt under a ruined abbey for four players");
    await composer.press("Enter");
    const card = page.getByRole("group", { name: "Clarifying questions" });
    await expect(card.getByText("Which tier are the players?")).toBeVisible({ timeout: 20_000 });
    await card.getByRole("button", { name: "Tier 2" }).click();
    await card.getByRole("button", { name: "Flooded cistern" }).click();
    await page.getByRole("button", { name: /Collapse brief/ }).click();
    await shotWebp(page, cdp, "step-talk");
    await card.getByRole("button", { name: "Send answers" }).click();
    const approve1 = page.getByRole("button", { name: /Approve plan v1/ });
    await expect(approve1).toBeVisible({ timeout: 30_000 });
    await expect(approve1).toBeEnabled({ timeout: 10_000 });

    // 3 · Check (v1 has a warning)
    await page.getByRole("button", { name: /warning/ }).click();
    const issues = page.getByRole("dialog", { name: "Plan issues" });
    await expect(issues.getByText(/bookshelf "shelf_mid"/)).toBeVisible();
    await shotWebp(page, cdp, "step-check");
    await page.keyboard.press("Escape");
    await expect(issues).toBeHidden();

    // Fix it through chat → v2, issue-free
    await composer.fill("Fix the issue in the hall");
    await composer.press("Enter");
    const approve2 = page.getByRole("button", { name: /Approve plan v2/ });
    await expect(approve2).toBeVisible({ timeout: 30_000 });
    await expect(approve2).toBeEnabled({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /warning/ })).toHaveCount(0);

    // Hero · L1, clean, room key open
    const showKey = page.getByRole("button", { name: /Show room key/ });
    if (await showKey.isVisible()) await showKey.click();
    const key = page.getByRole("complementary", { name: "Room key" });
    await expect(key).toBeVisible();
    await fit(page);
    await shotWebp(page, cdp, "hero", 2400);

    // 2 · Plan · L2 with a room selected
    await page.getByRole("tab", { name: /L2 Cistern Depths/ }).click();
    const map2 = page.getByRole("application", { name: /Map of L2, Cistern Depths/ });
    await expect(map2).toBeVisible();
    await key.getByRole("button", { name: /Flooded Cistern/ }).click();
    await expect(key.getByRole("button", { name: /Flooded Cistern/, expanded: true })).toBeVisible();
    await fit(page);
    await shotWebp(page, cdp, "step-plan");

    // Light mode · L1 with the hall selected
    await page.getByRole("tab", { name: /L1 Upper Crypts/ }).click();
    await page.getByRole("button", { name: /^Settings/ }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Appearance" }).click();
    await settings.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await settings.getByRole("button", { name: "Done" }).click();
    await expect(settings).toBeHidden();
    await key.getByRole("button", { name: /Hall of Pillars/ }).click();
    await expect(key.getByText("GM notes")).toBeVisible();
    await fit(page);
    await shotWebp(page, cdp, "light");

    // Back to dark → 4 · Build
    await page.getByRole("button", { name: /^Settings/ }).click();
    await settings.getByRole("button", { name: "Appearance" }).click();
    await settings.getByRole("radio", { name: "Dark" }).click();
    await settings.getByRole("button", { name: "Done" }).click();
    await approve2.click();
    const dlg = page.getByRole("dialog", { name: "Approve v2" });
    await dlg.getByRole("button", { name: "Approve & build" }).click();
    await expect(page.getByRole("heading", { name: "Built from v2" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Build check passed")).toBeVisible();
    await shotWebp(page, cdp, "step-build");
  } finally {
    await app.close();
    cleanRun(run);
  }
});

const PREVIEW_MAIN = `
import { app, BrowserWindow } from "electron";
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { sandbox: true, javascript: true } });
  void w.loadURL(process.env.SITE_URL);
});
`;

test("landing page previews", async () => {
  test.setTimeout(120_000);
  const dir = mkdtempSync(path.join(os.tmpdir(), "slabyrinth-site-preview-"));
  const main = path.join(dir, "main.mjs");
  writeFileSync(main, PREVIEW_MAIN);
  const app = await electron.launch({
    args: [main],
    env: { ...process.env, SITE_URL: pathToFileURL(repo("site/index.html")).href },
    timeout: 30_000,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("load");
    for (const [label, size] of [
      ["desktop", { width: 1440, height: 900 }],
      ["phone", { width: 390, height: 844 }],
    ] as const) {
      for (const scheme of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize(size);
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${label}-${scheme} horizontal overflow`).toBeLessThanOrEqual(0);
        // fullPage repeats the first viewport in Electron: make the viewport as tall as the page instead.
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.setViewportSize({ width: size.width, height });
        await page.waitForFunction(() =>
          Array.from(document.images).every((i) => i.complete || getComputedStyle(i).display === "none"),
        );
        await page.screenshot({
          path: repo(`docs/renders/site-${label}-${scheme}.png`),
          animations: "disabled",
        });
      }
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
