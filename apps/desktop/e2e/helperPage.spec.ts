/**
 * The TaleSpire add-on's real page (symbiotes/slabyrinth-helper: index.html, app.js, sequencer.js, style.css) in a
 * real Chromium (an Electron window standing in for TaleSpire's web view), against a fake `TS` API and the app's real
 * link server. Covers: pairing, a set sent from the app, Next / Back / Again by the app's hotkeys and by the panel's
 * buttons, Finish (picking tool, hotkeys released), Start over, and the appearance kept across a reload.
 *
 * TaleSpire documents no way to test a symbiote outside the game, so this is as close as it gets; what only the game
 * can show (placement, the build plane, the hand) stays with the owner.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { memoryLogger } from "../src/main/logger";
import { LinkServer } from "../src/main/services/talespire/link/linkServer";
import { LINK_CONFIG_FILE, type ChunkSet } from "../src/main/services/talespire/link/protocol";

const HELPER = fileURLToPath(new URL("../../../symbiotes/slabyrinth-helper/", import.meta.url));
const HOST = fileURLToPath(new URL("./helperHost.mjs", import.meta.url));
const TOKEN = "e2e0".repeat(12);
const SLAB = "H4sIAAAAAAAEADv369xFJgZGBgYGt3SdZ+fP7XfrVvghbvHxkgJITIfxBEMDTwOQCQAbEZZYKAAAAA==";
const SET: ChunkSet = {
  format: "slabyrinth-chunks",
  version: 1,
  name: "Two halves",
  size: { w: 20, h: 10 },
  levels: 1,
  chunks: [
    { label: "West (l1-01)", slab: SLAB },
    { label: "East (l1-02)", slab: SLAB },
  ],
};
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".md": "text/markdown",
};

/** The fake TaleSpire API, injected before the page's scripts run (TaleSpire injects its own at DOMContentLoaded). */
const FAKE_TS = `
  window.__ts = { hand: [], picks: 0 };
  window.TS = {
    slabs: {
      sendSlabToHand: (s) => { window.__ts.hand.push(s); return Promise.resolve(undefined); },
      getMaxSlabSizeInBytes: () => Promise.resolve(30720),
    },
    clients: {
      whoAmI: () => Promise.resolve({ id: "c1" }),
      getMoreInfo: () => Promise.resolve([{ id: "c1", clientMode: "gm" }]),
    },
    picking: { startPicking: () => { window.__ts.picks++; return Promise.resolve("pick-1"); } },
  };
  document.addEventListener("DOMContentLoaded", () =>
    setTimeout(() => window.handleStateChange({ kind: "hasInitialized" }), 0));
`;

let dir: string;
let files: Server;
let filesPort: number;
let link: LinkServer;
let electronApp: ElectronApplication;
let page: Page;
const registered = new Map<string, () => void>();

/** Serves the add-on folder as TaleSpire's local server would, plus the pairing file the app writes on install. */
function serveHelper(linkPort: number): Promise<Server> {
  const server = createServer((req, res) => {
    const name = (req.url ?? "/").split("?")[0]?.replace(/^\/+/, "") || "index.html";
    if (name === LINK_CONFIG_FILE) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ port: linkPort, token: TOKEN }));
      return;
    }
    if (!/^[\w.-]+$/.test(name)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = readFileSync(path.join(HELPER, name));
      res.writeHead(200, { "Content-Type": TYPES[path.extname(name)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

test.beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "slab-helper-page-"));
  link = new LinkServer({
    port: 0,
    token: () => TOKEN,
    wayland: false,
    logger: memoryLogger(),
    registrar: {
      register: (acc, cb) => {
        if (registered.has(acc)) return false;
        registered.set(acc, cb);
        return true;
      },
      unregister: (acc) => {
        registered.delete(acc);
      },
    },
    onChange: () => undefined,
  });
  await link.start();
  files = await serveHelper(link.port);
  const addr = files.address();
  filesPort = typeof addr === "object" && addr ? addr.port : 0;
  electronApp = await electron.launch({ args: [HOST], env: { ...process.env, HELPER_HOST_USER_DATA: dir } });
  page = await electronApp.firstWindow();
  await page.addInitScript(FAKE_TS);
});

test.afterAll(async () => {
  await electronApp.close();
  await link.close();
  await new Promise<void>((r) => {
    files.close(() => {
      r();
    });
  });
  rmSync(dir, { recursive: true, force: true });
});

const title = (): ReturnType<Page["locator"]> => page.locator("#now-title");
const press = (accelerator: string): void => {
  const cb = registered.get(accelerator);
  if (!cb) throw new Error(`${accelerator} is not registered`);
  cb();
};
const handCount = (): Promise<number> =>
  page.evaluate(() => (window as unknown as { __ts: { hand: string[] } }).__ts.hand.length);

test("pairs with the app, places a sent map by hotkeys and buttons, finishes, starts over", async () => {
  await page.goto(`http://127.0.0.1:${String(filesPort)}/index.html`);
  await expect(page.locator("#light-link .light-label")).toHaveText("Connected to Slabyrinth");
  await expect.poll(() => link.status().helper.state).toBe("connected");
  await expect(page.locator("#diag-pairing")).toHaveText(`paired (port ${String(link.port)})`);

  // the app sends the build: the panel shows it and asks for the build plane; the hotkeys are held
  link.load(SET, "build-1");
  await expect(page.locator("#map-name")).toHaveText("Two halves");
  await expect(page.locator("#map-meta")).toHaveText("2 chunks · 20 × 10 cells · 1 level");
  await expect(title()).toHaveText("Press G to raise the build plane");
  await expect.poll(() => link.status().send.state).toBe("loaded");
  await expect.poll(() => registered.size).toBe(3);
  await expect(page.locator("#btn-next .ctl-key")).toHaveText("Ctrl+Alt+D");

  // Next (hotkey): chunk 1 in hand; Next: chunk 2; Back: chunk 1; Again: chunk 1 again
  press("Control+Alt+D");
  await expect(title()).toHaveText("Click one spot to place it");
  press("Control+Alt+D");
  await expect(page.locator("#now-step")).toHaveText("Chunk 2 of 2 in hand");
  press("Control+Alt+A");
  await expect(page.locator("#now-step")).toHaveText("Chunk 1 of 2 in hand");
  press("Control+Alt+S");
  await expect.poll(handCount).toBe(4);
  await expect.poll(() => link.status().set?.chunk).toBe(1);

  // the panel's own buttons, to the end: the picking tool takes the hand, the app sees it finished
  await page.locator("#btn-next").click();
  await expect(page.locator("#now-step")).toHaveText("Chunk 2 of 2 in hand");
  await expect(page.locator("#btn-next .ctl-label")).toHaveText("Finish");
  await page.locator("#btn-next").click();
  await expect(title()).toHaveText("Switched to the picking tool");
  expect(await page.evaluate(() => (window as unknown as { __ts: { picks: number } }).__ts.picks)).toBe(1);
  await expect.poll(() => link.status().set?.finished).toBe(true);
  await expect.poll(() => registered.size).toBe(0);
  await expect(page.locator("#hk-next-result")).toHaveText("Ready: works while a map is being placed.");

  // Start over: back to the first step, nothing put in the hand, hotkeys held again
  const before = await handCount();
  await expect(page.locator("#btn-send .ctl-label")).toHaveText("Start over");
  await page.locator("#btn-send").click();
  await expect(title()).toHaveText("Press G to raise the build plane");
  expect(await handCount()).toBe(before);
  await expect.poll(() => registered.size).toBe(3);

  // the app empties the panel
  link.command("unload");
  await expect(page.locator("#map-info")).toBeHidden();
  await expect.poll(() => registered.size).toBe(0);
});

test("keeps the chosen look across a reload, and opens in Slabyrinth by default", async () => {
  await page.goto(`http://127.0.0.1:${String(filesPort)}/index.html`);
  await page.evaluate(() => {
    localStorage.removeItem("slabyrinth-helper.design");
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "slabyrinth");
  await page.locator("#appearance summary").click();
  await page.locator("#design-native").check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "native");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "native");
  await expect(page.locator("#design-native")).toBeChecked();
});

const shots = fileURLToPath(new URL("../../../docs/internal/talespire-ui/", import.meta.url));

test("a map pasted from beside it: the panel says where to click and which pillars to delete", async () => {
  mkdirSync(shots, { recursive: true });
  await page.setViewportSize({ width: 420, height: 760 });
  await page.goto(`http://127.0.0.1:${String(filesPort)}/index.html`);
  await expect(page.locator("#light-link .light-label")).toHaveText("Connected to Slabyrinth");
  link.load({ ...SET, anchor: { side: "south", clearanceCells: 4, farMarkerCells: 31 } }, "build-2");
  await expect(title()).toHaveText("Press G to raise the build plane");
  await page.locator("#btn-next").click();
  await expect(title()).toHaveText("Click just south of where the map goes");
  await expect(page.locator("#now-detail")).toContainText(
    "The map lands north of the cursor, about 5 cells away.",
  );
  await page.screenshot({ path: path.join(shots, "addon-panel-anchor-chunk1.png"), animations: "disabled" });
  await page.locator("#btn-next").click();
  await expect(page.locator("#now-step")).toHaveText("Chunk 2 of 2 in hand");
  await page.locator("#btn-next").click();
  await expect(page.locator("#now-detail")).toContainText(
    "one just past the map's north-east corner, and one about 31 cells south of the map.",
  );
  await page.screenshot({ path: path.join(shots, "addon-panel-anchor-done.png"), animations: "disabled" });
  link.command("unload");
  await expect(page.locator("#map-info")).toBeHidden();
});
