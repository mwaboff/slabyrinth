/**
 * Marketing screenshots for the landing page (site/) and preview shots of the page itself.
 * NOT part of `npm run test:e2e` (playwright.config.ts only matches *.spec.ts); run with
 * `npm run capture:site` from the repo root (builds the test bundle first).
 *
 * Same safety as the e2e specs: hidden window, throwaway userData, scripted provider instead of Anthropic
 * (no network, no API cost), memory clipboard, no TaleSpire lookup or launch (SLABYRINTH_E2E=1).
 * Output: site/assets/img/*.webp (app, 2x, downscaled) and docs/renders/site-*.png (page previews).
 * SLABYRINTH_CAPTURE_PROJECT=<path to a .slabyrinth file> shoots that map instead of the scripted one
 * (the file is copied into the throwaway userData first; see the project test below).
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Frame what is drawn on a level rather than its whole bounds (a real map rarely fills them). Fit first,
 * find the bounding box of the wall ink on the map canvas (bright pixels in dark theme, dark ones in light),
 * then zoom and centre through the map view's own navigation events. Navigation only; the project is unchanged.
 */
async function frame(page: Page): Promise<void> {
  await fit(page);
  const map = page.getByRole("application", { name: /^Map of / });
  const box = await map.boundingBox();
  if (!box) return;
  const ink = await page.evaluate(() => {
    const cv = document.querySelector<HTMLCanvasElement>("canvas.canvas__el");
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx || cv.width === 0) return null;
    const light = document.documentElement.getAttribute("data-theme") === "light";
    const { data, width, height } = ctx.getImageData(0, 0, cv.width, cv.height);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let y = 0; y < height; y += 2)
      for (let x = 0; x < width; x += 2) {
        const i = (y * width + x) * 4;
        const lum = 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
        if ((data[i + 3] ?? 0) > 200 && (light ? lum < 70 : lum > 190)) {
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
    if (!Number.isFinite(x0)) return null;
    const r = cv.getBoundingClientRect();
    const k = r.width / cv.width;
    return { x0: r.left + x0 * k, y0: r.top + y0 * k, x1: r.left + x1 * k, y1: r.top + y1 * k };
  });
  if (!ink) return;
  // Where fit() put the level (same formula as MapView: 48 px padding, 24 px per cell at zoom 1).
  const snap = unwrap(await invoke(page, "project:snapshot", undefined));
  const name = (await map.getAttribute("aria-label")) ?? "";
  const level = snap.plan?.levels.find((l) => name.includes(`, ${l.name}`)) ?? snap.plan?.levels[0];
  if (!level) return;
  const b = level.bounds;
  const z = Math.min((box.width - 96) / (b.w * 24), (box.height - 96) / (b.h * 24));
  const s = 24 * z;
  const pan = [(box.width - b.w * s) / 2 - b.x * s, (box.height - b.h * s) / 2 - b.y * s] as const;
  const cell = [
    ((ink.x0 + ink.x1) / 2 - box.x - pan[0]) / s,
    ((ink.y0 + ink.y1) / 2 - box.y - pan[1]) / s,
  ] as const;
  const pad = 56;
  const f = Math.min(
    (box.width - 2 * pad) / (ink.x1 - ink.x0),
    (box.height - 2 * pad) / (ink.y1 - ink.y0),
    4,
  );
  console.log(
    `frame ${level.name}: ink ${Math.round(ink.x1 - ink.x0)}x${Math.round(ink.y1 - ink.y0)} zoom ${z.toFixed(3)} x${f.toFixed(2)}`,
  );
  // The map view's own navigation events: zoom about the centre, then centre on a cell.
  await page.evaluate((nz) => window.dispatchEvent(new CustomEvent("slab:zoom", { detail: nz })), z * f);
  await page.waitForTimeout(300);
  await page.evaluate((c) => window.dispatchEvent(new CustomEvent("slab:revealCell", { detail: c })), [
    cell[0] - 0.5,
    cell[1] - 0.5,
  ] as const);
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

/**
 * Launch hidden at 1440×900 CSS px with 2x pixels, walk the first-run setup (no real key: the scripted
 * provider accepts any) and hide the "TaleSpire wasn't found" banner (e2e runs never look for the game).
 * Setup leaves an empty untitled map open.
 */
async function prepare(run: Run): Promise<{ app: ElectronApplication; page: Page; cdp: CDPSession }> {
  const { app, page } = await launchHiDpi(run);
  await page.setViewportSize({ width: 1440, height: 900 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  const setup = page.getByRole("dialog", { name: "Welcome to Slabyrinth" });
  await setup.getByLabel("Anthropic API key").fill("sk-ant-e2e-test-0000000000000000");
  await setup.getByRole("button", { name: "Check key" }).click();
  await expect(setup.getByText(/Key works/)).toBeVisible({ timeout: 15_000 });
  await setup.getByRole("button", { name: "Next" }).click();
  await setup.getByRole("button", { name: "Continue without it" }).click();
  await setup.getByRole("radio", { name: "Daggerheart" }).click();
  await setup.getByRole("button", { name: "Start mapping" }).click();
  await expect(setup).toBeHidden();
  await page.getByRole("button", { name: "Continue without it" }).click();
  return { app, page, cdp };
}

/**
 * Optional: shoot an existing project instead of the scripted map. The file is COPIED into the throwaway
 * userData's projects folder (safe mode uses <userData>/Projects), so the original is never opened or changed.
 * Its conversation, versions and builds are already in the file: no provider calls are made.
 */
const CAPTURE_PROJECT = process.env["SLABYRINTH_CAPTURE_PROJECT"];

test("app screenshots for the landing page (scripted map)", async () => {
  test.skip(Boolean(CAPTURE_PROJECT), "SLABYRINTH_CAPTURE_PROJECT is set: the project capture runs instead");
  test.setTimeout(240_000);
  const run = newRun("slabyrinth-site-", STEPS);
  const { app, page, cdp } = await prepare(run);
  try {
    unwrap(await invoke(page, "project:rename", { name: "The Drowned Abbey" }));

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

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Scroll the conversation like a user would (mouse wheel over the thread): to the top, the bottom, or until
 * the message matching `target` sits near the top. The thread keeps itself pinned against programmatic scrolls.
 */
async function scrollChat(page: Page, target: "top" | "bottom" | RegExp): Promise<void> {
  const thread = page.getByRole("log", { name: "Conversation" });
  const tb = await thread.boundingBox();
  if (!tb) return;
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  if (typeof target === "string") {
    for (let i = 0; i < 40; i++) await page.mouse.wheel(0, target === "top" ? -2000 : 2000);
    await page.waitForTimeout(300);
    return;
  }
  // Approach from the bottom (newest first), as a reader scrolling back would.
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(300);
  const msg = thread.getByText(target).last();
  for (let i = 0; i < 80; i++) {
    const mb = await msg.boundingBox();
    if (!mb) break;
    const off = mb.y - (tb.y + 16);
    if (Math.abs(off) < 40) break;
    await page.mouse.wheel(0, Math.max(-400, Math.min(400, off)));
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
}

/**
 * Shot list for an existing project (one map end to end; every frame 1440×900 CSS px at 2x, map framed
 * on what is drawn, room key open, chat at its latest message unless noted):
 *   hero        Map · L1
 *   step-plan   Map · L1 · History panel open (named versions)
 *   step-talk   Map · L3 · chat scrolled to the first message
 *   step-check  Plan issues popover if the head version has findings; otherwise Map · L2 with the chat
 *               scrolled to the message matching SLABYRINTH_CAPTURE_CHECK (regex), or skipped
 *   export      Map · L1 · Export PNG dialog open (print-light preview)
 *   step-build  Build tab of the latest build
 *   light       Light theme · Map · L1
 */
test("app screenshots for the landing page (existing project)", async () => {
  test.skip(!CAPTURE_PROJECT, "set SLABYRINTH_CAPTURE_PROJECT to a .slabyrinth file to use this capture");
  test.setTimeout(300_000);
  const source = CAPTURE_PROJECT ?? "";
  const run = newRun("slabyrinth-site-project-", STEPS);
  const projects = path.join(run.userData, "Projects");
  mkdirSync(projects, { recursive: true });
  const copy = path.join(projects, path.basename(source));
  copyFileSync(source, copy); // the original is only read, never opened by the app
  const { app, page, cdp } = await prepare(run);
  try {
    // Home → the copied project.
    await page.getByRole("button", { name: /^Slabyrinth$/ }).click();
    const listed = unwrap(await invoke(page, "project:list", undefined)).find(
      (p) => path.basename(p.path) === path.basename(copy),
    );
    if (!listed) throw new Error("copied project not listed on Home");
    const cont = page.getByRole("region", { name: "Continue" });
    if (await cont.getByRole("heading", { name: listed.name, exact: true }).isVisible()) {
      await cont.getByRole("button", { name: /Continue/ }).click();
    } else {
      await page
        .getByRole("group", { name: new RegExp(`^${esc(listed.name)},`) })
        .getByRole("button", { name: listed.name, exact: true })
        .first()
        .click();
    }
    await expect(page.getByRole("application", { name: /Map of L1/ })).toBeVisible({ timeout: 20_000 });

    const levelTab = (n: number) => page.getByRole("tab", { name: new RegExp(`^L${n}\\b`) });
    const showKey = async () => {
      const btn = page.getByRole("button", { name: /Show room key/ });
      if (await btn.isVisible()) await btn.click();
    };

    // hero
    await page.getByRole("tab", { name: "Map", exact: true }).click();
    await levelTab(1).click();
    await showKey();
    await frame(page);
    await shotWebp(page, cdp, "hero", 2400);

    // step-plan: history
    await page.getByRole("button", { name: /^History · \d+/ }).click();
    await expect(page.getByRole("complementary", { name: "Version history" })).toBeVisible();
    await frame(page);
    await shotWebp(page, cdp, "step-plan");
    await page.getByRole("button", { name: "Close history (H)" }).click();

    // step-talk: the conversation from its first message, next to the level drawn last (L3)
    await levelTab(3).click();
    await showKey();
    await frame(page);
    await scrollChat(page, "top");
    await shotWebp(page, cdp, "step-talk");

    // step-check: open findings on the head version if any; else the chat message matching
    // SLABYRINTH_CAPTURE_CHECK (e.g. where the plan check's findings were handed back to Claude), on L2
    await levelTab(2).click();
    await showKey();
    await frame(page);
    const chip = page.getByRole("button", { name: /\d+ (warning|error|issue|blocking)/i });
    const check = process.env["SLABYRINTH_CAPTURE_CHECK"];
    if (await chip.isVisible()) {
      await chip.click();
      await expect(page.getByRole("dialog", { name: "Plan issues" })).toBeVisible();
      await shotWebp(page, cdp, "step-check");
      await page.keyboard.press("Escape");
    } else if (check) {
      await scrollChat(page, new RegExp(check));
      await shotWebp(page, cdp, "step-check");
    } else {
      console.log("step-check: no open findings and no SLABYRINTH_CAPTURE_CHECK, not captured");
    }
    await scrollChat(page, "bottom");

    // export
    await levelTab(1).click();
    await frame(page);
    // export
    await page.getByRole("button", { name: /Export PNG/ }).click();
    const png = page.getByRole("dialog", { name: "Export PNG" });
    await expect(png).toBeVisible();
    await page.waitForTimeout(800); // preview render
    await shotWebp(page, cdp, "export");
    await png.getByRole("button", { name: "Cancel" }).click();

    // step-build
    await page.getByRole("tab", { name: "Build", exact: true }).click();
    await expect(page.getByRole("heading", { name: /^Built from v\d+/ })).toBeVisible({ timeout: 60_000 });
    await shotWebp(page, cdp, "step-build");

    // light
    await page.getByRole("button", { name: /^Settings/ }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Appearance" }).click();
    await settings.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await settings.getByRole("button", { name: "Done" }).click();
    await expect(settings).toBeHidden();
    await page.getByRole("tab", { name: "Map", exact: true }).click();
    await levelTab(1).click();
    await showKey();
    await frame(page);
    await shotWebp(page, cdp, "light");
  } finally {
    await app.close();
    cleanRun(run); // removes the copy too
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
