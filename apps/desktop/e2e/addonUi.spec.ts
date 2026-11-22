/**
 * The TaleSpire add-on's UI in the real app (test mode: a temp Symbiotes folder, an ephemeral port, a memory hotkey
 * registrar): the status light, the add-on dialog's live steps, the build page's Send button turning on by itself
 * when the add-on connects after the page is open, sending and stopping, the automatic-update notice and the update
 * prompt. States the test cannot make for real (port in use, a foreign folder, Wayland…) are pushed as main's own
 * events, for the owner's screenshots in docs/internal/talespire-ui/ (git-ignored).
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AddonStatus, LinkStatus } from "../src/shared/ipc";
import { LINK_CONFIG_FILE } from "../src/main/services/talespire/link/protocol";
import { connectAddon } from "../src/main/services/talespire/link/testing/fakeAddon";
import { fakeAddonStatus, fakeLinkStatus } from "../src/renderer/bridge/fake/talespireLink";
import { cleanRun, invoke, launch, newRun, unwrap, type Run } from "./helpers";
import { UI_PLAN } from "./uiScript";

const HELPER = fileURLToPath(new URL("../../../symbiotes/slabyrinth-helper/", import.meta.url));
const shots = fileURLToPath(new URL("../../../docs/internal/talespire-ui/", import.meta.url));
const usage = { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 };
const STEPS = [
  {
    kind: "reply",
    usage,
    parts: [
      {
        type: "tool_call",
        callId: "tc",
        name: "create_plan",
        input: { replace: false, summary: "First draft", changes: ["Two levels"], plan: UI_PLAN },
      },
    ],
  },
  { kind: "reply", usage, parts: [{ type: "text", text: "First take on the crypt." }] },
];

const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: path.join(shots, name), animations: "disabled" });

/** Pushes a status as main's own event (main re-sends its real one only when that changes). */
function emit(
  app: ElectronApplication,
  channel: "addon:changed" | "link:changed",
  payload: AddonStatus | LinkStatus,
) {
  return app.evaluate(
    ({ BrowserWindow }, [c, p]) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(c, p);
    },
    [channel, payload] as const,
  );
}

async function setScheme(page: Page, scheme: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
}

async function throughSetup(page: Page): Promise<void> {
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
  run = newRun("slabyrinth-e2e-addon-ui-", STEPS);
  mkdirSync(shots, { recursive: true });
});
test.afterEach(() => {
  cleanRun(run);
});

test("install from the light, the build page turns Send on when the add-on connects, send, stop", async () => {
  test.setTimeout(180_000);
  const symbiotes = path.join(run.dir, "Symbiotes");
  mkdirSync(symbiotes, { recursive: true });
  const { app, page } = await launch(run, { SLABYRINTH_TEST_SYMBIOTES_DIR: symbiotes });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await throughSetup(page);
    const composer = page.getByLabel("Message Slabyrinth");
    await composer.fill("A crypt under a ruined abbey");
    await composer.press("Enter");
    await expect(page.getByRole("button", { name: /Approve plan v1/ })).toBeVisible({ timeout: 30_000 });

    // the light: not installed
    const light = page.locator(".statusbar .tsind");
    await expect(light).toHaveAccessibleName("TaleSpire add-on: Install TaleSpire add-on");
    await page.locator(".statusbar").screenshot({ path: path.join(shots, "indicator-missing-dark.png") });

    // the dialog: three steps; one click installs; step 2 turns to done, step 3 waits for TaleSpire
    await light.click();
    const dialog = page.getByRole("dialog", { name: "TaleSpire add-on" });
    await expect(dialog.getByText("Turn on Symbiotes in TaleSpire")).toBeVisible();
    await shot(page, "dialog-missing-dark.png");
    await dialog.getByRole("button", { name: "Install" }).click();
    await expect(dialog.getByText(/Installed in TaleSpire's Symbiotes folder/)).toBeVisible();
    await expect(dialog.getByText(/Open the Symbiotes panel and choose Slabyrinth Helper/)).toBeVisible();
    await shot(page, "dialog-installed-dark.png");
    await setScheme(page, "light");
    await shot(page, "dialog-installed-light.png");
    await setScheme(page, "dark");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(light).toHaveAccessibleName("TaleSpire add-on: Add-on not connected");

    // approve and build: the build page waits for the add-on, Send is off
    await page.getByRole("button", { name: /Approve plan v1/ }).click();
    await page
      .getByRole("dialog", { name: "Approve v1" })
      .getByRole("button", { name: "Approve & build" })
      .click();
    await expect(page.getByRole("heading", { name: "Built from v1" })).toBeVisible({ timeout: 60_000 });
    const panel = page.getByRole("region", { name: "Send to TaleSpire" });
    const send = panel.getByRole("button", { name: "Send to TaleSpire" });
    await expect(panel.getByText("Open the Slabyrinth panel in TaleSpire.")).toBeVisible();
    await expect(send).toBeDisabled();
    await shot(page, "build-waiting-dark.png");

    // the GM opens the panel in TaleSpire now: Send turns on by itself
    const pairing = JSON.parse(
      readFileSync(path.join(symbiotes, "slabyrinth-helper", LINK_CONFIG_FILE), "utf8"),
    ) as {
      port: number;
      token: string;
    };
    const addon = await connectAddon(pairing.port, pairing.token);
    await expect(send).toBeEnabled();
    await expect(light).toHaveAccessibleName("TaleSpire add-on: Add-on connected");
    await shot(page, "build-ready-dark.png");
    await setScheme(page, "light");
    await shot(page, "build-ready-light.png");
    await setScheme(page, "dark");

    // send: the add-on loads the map, the page follows its progress and the hotkeys are held
    await send.click();
    await addon.until((s) => s.set !== null);
    await expect(panel.getByRole("progressbar", { name: "Slabs placed" })).toBeVisible();
    await expect(light).toHaveAccessibleName(/Placing map · 1 of 1/);
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as { __slabyrinthHotkeys?: { registered: Map<string, unknown> } }).__slabyrinthHotkeys
              ?.registered.size,
        ),
      )
      .toBe(3);
    await shot(page, "build-placing-dark.png");

    // stop: the add-on is emptied, the hotkeys released, Send is back
    await panel.getByRole("button", { name: "Stop" }).click();
    await addon.until((s) => s.set === null);
    await expect(send).toBeEnabled();

    // the states the test cannot make for real, for the owner's screenshots
    const real = unwrap(await invoke(page, "link:status", undefined));
    // a send waiting for the add-on: Stop is there; a send the add-on didn't answer: one plain line, Send again
    await emit(app, "link:changed", { ...real, send: { ...real.send, state: "sending" } });
    await expect(panel.getByRole("button", { name: "Stop" })).toBeEnabled();
    await shot(page, "build-sending-dark.png");
    await emit(app, "link:changed", {
      ...real,
      send: { ...real.send, state: "failed", error: "The add-on didn't answer within 30 seconds." },
    });
    await expect(panel.getByRole("button", { name: "Send again" })).toBeEnabled();
    await shot(page, "build-noanswer-dark.png");
    // installed by hand where Slabyrinth doesn't look: the light says connected, the dialog says what is wrong
    await emit(app, "addon:changed", {
      ...fakeAddonStatus("not_found"),
      prompt: { show: false, reason: null },
    });
    await emit(app, "link:changed", real);
    await expect(light).toHaveAccessibleName("TaleSpire add-on: Add-on connected");
    await light.click();
    await expect(dialog.getByText(/connected, but Slabyrinth couldn't find/)).toBeVisible();
    await shot(page, "dialog-connected-notfound-dark.png");
    await page.keyboard.press("Escape");
    const states: Array<[string, AddonStatus, LinkStatus]> = [
      [
        "notfound",
        fakeAddonStatus("not_found"),
        { ...real, helper: { state: "none", version: null, reason: null } },
      ],
      [
        "foreign",
        fakeAddonStatus("foreign"),
        { ...real, helper: { state: "none", version: null, reason: null } },
      ],
      [
        "mismatch",
        fakeAddonStatus("mismatch"),
        { ...real, helper: { state: "none", version: null, reason: null } },
      ],
      [
        "outdated",
        fakeAddonStatus("outdated"),
        { ...real, helper: { state: "none", version: null, reason: null } },
      ],
      [
        "refused",
        fakeAddonStatus("installed"),
        { ...real, helper: { state: "refused", version: null, reason: "token" } },
      ],
      ["portinuse", fakeAddonStatus("installed"), { ...real, server: { state: "port_in_use", port: 48731 } }],
      [
        "placing-wayland",
        fakeAddonStatus("installed"),
        (() => {
          const l = fakeLinkStatus({
            helper: "connected",
            wayland: true,
            placing: { name: "Keep", chunk: 3, total: 5 },
          });
          l.hotkeys.state = "partial";
          l.hotkeys.actions.again = {
            status: "refused",
            combo: null,
            wanted: "Ctrl+Alt+S",
            reason: "the desktop refused it",
          };
          return { ...l, send: { ...l.send, buildId: real.send.buildId } };
        })(),
      ],
      [
        "placed",
        fakeAddonStatus("installed"),
        (() => {
          const l = fakeLinkStatus({
            helper: "connected",
            placing: { name: "Keep", chunk: 5, total: 5, phase: "done" },
          });
          return { ...l, send: { ...l.send, buildId: real.send.buildId } };
        })(),
      ],
    ];
    for (const [name, a, l] of states) {
      await emit(app, "addon:changed", { ...a, prompt: { show: false, reason: null } });
      await emit(app, "link:changed", l);
      await expect(light).toHaveAttribute("data-state", /./);
      await page.waitForTimeout(100);
      await shot(page, `state-${name}-dark.png`);
    }
    await setScheme(page, "light");
    await shot(page, "state-placed-light.png");
    await light.click();
    await shot(page, "dialog-placed-wayland-light.png");
    await page.keyboard.press("Escape");
    await setScheme(page, "dark");

    // Settings: the add-on beside the app's own update check
    await page.getByRole("button", { name: /^Settings/ }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "About" }).click();
    await expect(settings.getByText("Setup steps, installing by hand and hotkeys…")).toBeVisible();
    await settings.locator(".tssettings").evaluate((el) => {
      el.closest(".srow")?.scrollIntoView({ block: "start" });
    });
    await shot(page, "settings-dark.png");
    await setScheme(page, "light");
    await shot(page, "settings-light.png");
    await setScheme(page, "dark");
    await settings.getByRole("button", { name: "Done" }).click();

    // a build of several slabs (one per level), read back from the project after a reload: the slab list and the
    // paste guide say where to paste from the recorded paste anchor, with no bundle in memory
    const multi = unwrap(
      await invoke(page, "compile:run", { version: 1, options: { grouping: "per-level" } }),
    );
    expect(multi.chunks.length).toBeGreaterThan(1);
    await page.reload();
    const build = page.getByRole("tab", { name: "Build", exact: true });
    if (await build.isVisible()) await build.click();
    await expect(page.getByText(/Too big for one slab, so it's in \d+ slabs/)).toBeVisible({
      timeout: 30_000,
    });
    if (multi.pasteAnchor)
      await expect(page.locator(".build__foot").filter({ hasText: "split into" })).toContainText(
        "bare ground just outside the middle",
      );
    await shot(page, "build-multislab-dark.png");
    await page.getByRole("button", { name: "Start paste guide" }).click();
    await expect(page.getByRole("complementary", { name: "Paste guide" })).toBeVisible();
    await shot(page, "build-multislab-guide-dark.png");
    addon.ws.close();
  } finally {
    await app.close();
  }
});

test("an older copy is updated at start with a quiet notice; one put there later gets the update prompt", async () => {
  test.setTimeout(120_000);
  const symbiotes = path.join(run.dir, "Symbiotes");
  const addonDir = path.join(symbiotes, "slabyrinth-helper");
  mkdirSync(symbiotes, { recursive: true });
  cpSync(HELPER, addonDir, { recursive: true });
  const manifestFile = path.join(addonDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { version: string };
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: "0.0.1" }));

  const { app, page } = await launch(run, { SLABYRINTH_TEST_SYMBIOTES_DIR: symbiotes });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await throughSetup(page);
    // the notice: quiet, under the title bar, dismissible
    const notice = page.getByRole("status").filter({ hasText: "Slabyrinth Helper was updated" });
    await expect(notice).toContainText(`(0.0.1 → ${manifest.version})`);
    await shot(page, "notice-updated-dark.png");
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await expect(notice).toBeHidden();

    // an older copy put there by hand after the start: the prompt offers the update in one click
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: "0.0.2" }));
    // the dialog's Check again looks at once (main also looks on focus and every 10 s); the prompt waits for the
    // dialog to close
    await page.locator(".tsind").first().click();
    const dialog = page.getByRole("dialog", { name: "TaleSpire add-on" });
    await dialog.getByRole("button", { name: "Check again" }).click();
    await expect(dialog.getByText("Update TaleSpire add-on", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    const prompt = page.getByRole("dialog", { name: "Update the TaleSpire add-on?" });
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText(/after Slabyrinth started/);
    await shot(page, "update-prompt-dark.png");
    await setScheme(page, "light");
    await shot(page, "update-prompt-light.png");
    await setScheme(page, "dark");
    await prompt.getByRole("button", { name: "Update now" }).click();
    await expect(prompt).toBeHidden();
    expect((JSON.parse(readFileSync(manifestFile, "utf8")) as { version: string }).version).toBe(
      manifest.version,
    );
  } finally {
    await app.close();
  }
});
