import { mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { cleanRun, launch, newRun, type Run } from "./helpers";

/**
 * The 3D viewer engine in the real (hidden) window: mounted by the test build's hook on a synthetic town of more than
 * 300,000 pieces over 1024 × 1024 tiles (renderer/features/view3d/harness.tsx, in-memory scene source), it must draw
 * a non-empty frame (read back from the GPU), move, survive a lost GPU context, and keep its frame time. Without
 * WebGL2 in the window, the viewer's typed fallback is checked instead.
 */
interface Measured {
  state: string;
  pieces: number;
  sceneBuildMs: number;
  heap: { before: number; scene: number; loaded: number };
}

let run: Run;
test.beforeEach(() => {
  run = newRun("slabyrinth-view3d-", []);
});
test.afterEach(() => {
  cleanRun(run);
});

test("the 3D viewer draws, moves and keeps its budgets on a 1024 × 1024 map", async () => {
  test.setTimeout(120_000);
  const { app, page } = await launch(run);
  try {
    const m = await page.evaluate(async (): Promise<Measured> => {
      const w = window as unknown as {
        __slabyrinthMountView3d: (side?: number) => Promise<void>;
        __view3d: {
          settled: Promise<string>;
          pieces: number;
          sceneBuildMs: number;
          heap: Measured["heap"];
        };
      };
      await w.__slabyrinthMountView3d(1024);
      const state = await w.__view3d.settled;
      return {
        state,
        pieces: w.__view3d.pieces,
        sceneBuildMs: w.__view3d.sceneBuildMs,
        heap: w.__view3d.heap,
      };
    });
    expect(m.pieces).toBeGreaterThanOrEqual(300_000);
    const harness = page.getByTestId("view3d-harness");
    if (m.state === "error") {
      // no WebGL2 here: the typed fallback, in words
      await expect(harness.getByRole("alert")).toHaveText(/graphics card can't show the 3D view/);
      console.log("view3d e2e: WebGL2 unavailable in the test window; checked the fallback state");
      return;
    }
    const canvas = harness.getByRole("application", { name: "3D view of the map" });
    await expect(canvas).toBeVisible();

    const first = await page.evaluate(() => {
      const h = (window as unknown as { __view3d: { api: { stats(): unknown; sample(): unknown } } })
        .__view3d;
      return {
        stats: h.api.stats() as Record<string, unknown>,
        sample: h.api.sample() as Record<string, number>,
      };
    });
    expect(first.sample["drawnPixels"]).toBeGreaterThan(1000);
    expect(first.sample["distinctIds"]).toBeGreaterThan(10);

    // the mouse: drag to orbit, wheel to zoom toward the cursor
    const cam0 = await page.evaluate(() =>
      (window as unknown as { __view3d: { api: { getCamera(): unknown } } }).__view3d.api.getCamera(),
    );
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no canvas box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 30, { steps: 8 });
    await page.mouse.up();
    await page.mouse.wheel(0, -600);
    const cam1 = await page.evaluate(() =>
      (window as unknown as { __view3d: { api: { getCamera(): unknown } } }).__view3d.api.getCamera(),
    );
    expect(cam1).not.toEqual(cam0);

    // frame time while moving: orbit, then fly close over the middle of the map and pan
    const moving = await page.evaluate(async () => {
      type Api = {
        orbit(a: number, b: number): void;
        pan(x: number, y: number): void;
        setCamera(v: unknown): void;
        stats(): {
          frameMs: number;
          drawCalls: number;
          triangles: number;
          gpuBytes: number;
          limited: boolean;
        };
        sample(): { drawnPixels: number };
        on(e: "frame", fn: (s: { frameMs: number }) => void): () => void;
      };
      const api = (window as unknown as { __view3d: { api: Api } }).__view3d.api;
      const cpu: number[] = [];
      const wall: number[] = [];
      const off = api.on("frame", (s) => cpu.push(s.frameMs));
      const frame = (): Promise<void> =>
        new Promise((r) => {
          const t = performance.now();
          let once = false;
          const done = (): void => {
            if (once) return;
            once = true;
            wall.push(performance.now() - t);
            r();
          };
          requestAnimationFrame(done);
          setTimeout(done, 100);
        });
      for (let i = 0; i < 60; i++) {
        api.orbit(3, 0);
        await frame();
      }
      const far = api.stats();
      api.setCamera({ target: { x: 512, y: 0, z: 512 }, distance: 30, bearing: 225, elevation: 25 });
      for (let i = 0; i < 30; i++) await frame();
      for (let i = 0; i < 60; i++) {
        api.pan(6, 2);
        await frame();
      }
      off();
      const q = (a: number[], p: number): number =>
        [...a].sort((x, y) => x - y)[Math.floor(a.length * p)] ?? 0;
      return {
        cpuMedian: q(cpu, 0.5),
        cpuP95: q(cpu, 0.95),
        wallMedian: q(wall, 0.5),
        far,
        close: api.stats(),
        drawn: api.sample().drawnPixels,
      };
    });
    expect(moving.drawn).toBeGreaterThan(1000);
    expect(moving.close.gpuBytes).toBeLessThanOrEqual(384 * 1024 * 1024);
    expect(moving.cpuMedian).toBeLessThan(16);

    // a lost GPU context: the view says so, and draws again once the context is back
    const restored = await page.evaluate(async () => {
      type Api = {
        state: { kind: string };
        orbit(a: number, b: number): void;
        sample(): { drawnPixels: number };
      };
      const h = (window as unknown as { __view3d: { api: Api } }).__view3d;
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="view3d-harness"] canvas');
      const gl = canvas?.getContext("webgl2");
      const ext = gl?.getExtension("WEBGL_lose_context");
      if (!ext) return { tested: false, lost: "", after: "", drawn: 0 };
      ext.loseContext();
      await new Promise((r) => setTimeout(r, 100));
      const lost = h.api.state.kind;
      ext.restoreContext();
      await new Promise((r) => setTimeout(r, 300));
      h.api.orbit(1, 0);
      await new Promise((r) => setTimeout(r, 500));
      return { tested: true, lost, after: h.api.state.kind, drawn: h.api.sample().drawnPixels };
    });
    if (restored.tested) {
      expect(restored.lost).toBe("lost");
      expect(restored.after).toBe("ready");
      expect(restored.drawn).toBeGreaterThan(1000);
    }
    console.log(
      `view3d e2e: ${m.pieces} pieces, scene build ${m.sceneBuildMs.toFixed(0)} ms; ` +
        `first frame ${String(first.stats["firstFrameMs"])} ms; drawn px ${first.sample["drawnPixels"]}; ` +
        `heap MB before/scene/loaded ${[m.heap.before, m.heap.scene, m.heap.loaded].map((b) => (b / 1e6).toFixed(0)).join("/")}; ` +
        `moving CPU median ${moving.cpuMedian.toFixed(2)} ms p95 ${moving.cpuP95.toFixed(2)} ms, wall median ${moving.wallMedian.toFixed(1)} ms; ` +
        `far ${moving.far.drawCalls} calls ${moving.far.triangles} tris; close ${moving.close.drawCalls} calls ${moving.close.triangles} tris; ` +
        `drawn px close ${moving.drawn}; GPU ${(moving.close.gpuBytes / 1e6).toFixed(1)} MB; context loss ${restored.tested ? "recovered" : "not testable"}`,
    );
  } finally {
    await app.close();
  }
});

test("the 3D viewer hands over from the boxes scene to the detailed one without an error", async () => {
  test.setTimeout(120_000);
  const { app, page } = await launch(run);
  type Harness = { headers: number[]; states: string[]; api: { sample(): { drawnPixels: number } } | null };
  const harness = (): Promise<{ headers: number[]; states: string[]; drawn: number }> =>
    page.evaluate(() => {
      const h = (window as unknown as { __view3d: Harness }).__view3d;
      return { headers: [...h.headers], states: [...h.states], drawn: h.api?.sample().drawnPixels ?? 0 };
    });
  try {
    // boxes first, then the detailed scene once its shapes are "read" (the in-memory source, as main does it)
    const state = await page.evaluate(async () => {
      const w = window as unknown as {
        __slabyrinthMountView3d: (side?: number, o?: { detail?: boolean }) => Promise<void>;
        __view3d: { settled: Promise<string> };
      };
      await w.__slabyrinthMountView3d(256, { detail: true });
      return w.__view3d.settled;
    });
    if (state === "error") {
      console.log("view3d hand-over e2e: WebGL2 unavailable in the test window; nothing to hand over");
      return;
    }
    await expect.poll(async () => (await harness()).headers.length, { timeout: 30_000 }).toBe(2);
    const h = await harness();
    expect(h.headers[0]).toBeGreaterThan(0);
    expect(h.headers[1]).toBe(0);
    expect(h.states).not.toContain("error");
    await expect.poll(async () => (await harness()).drawn, { timeout: 30_000 }).toBeGreaterThan(1000);
    expect((await harness()).states.at(-1)).toBe("ready");
  } finally {
    await app.close();
  }
});

/** The 3D tab's viewer as the test build exposes it (renderer/features/view3d/View3dStage.tsx). */
interface TabProbe {
  /** "none" (no tab yet), "still" (no WebGL2: the still picture), or the viewer's state ("loading", "ready", …). */
  mode: string;
  drawn: number;
  hideRoofs: boolean | null;
  cutLevel: number | null;
}
const probe = (page: Page): Promise<TabProbe> =>
  page.evaluate(() => {
    type Api = {
      sample(): { drawnPixels: number };
      getFilters(): { hideRoofs: boolean; cutLevel: number | null };
    };
    const t = (
      window as unknown as { __slabyrinthView3dTab?: { api: Api | null; state: string; noGl: boolean } }
    ).__slabyrinthView3dTab;
    if (!t) return { mode: "none", drawn: 0, hideRoofs: null, cutLevel: null };
    if (t.noGl) return { mode: "still", drawn: 0, hideRoofs: null, cutLevel: null };
    const f = t.api?.getFilters();
    return {
      mode: t.state,
      drawn: t.state === "ready" ? (t.api?.sample().drawnPixels ?? 0) : 0,
      hideRoofs: f?.hideRoofs ?? null,
      cutLevel: f?.cutLevel ?? null,
    };
  });

const usage = { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** The Lost Mine fixture as the model authors it: a street of roofed cottages over mine workings (two levels). */
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../packages/core/test/fixtures/plans/stated-character-v1.json", import.meta.url),
    ),
    "utf8",
  ),
) as Record<string, unknown>;
const MINE: Record<string, unknown> = { ...fixture };
for (const k of ["schema", "generator", "id"]) Reflect.deleteProperty(MINE, k);

const TAB_STEPS = [
  {
    kind: "reply",
    usage,
    parts: [
      {
        type: "tool_call",
        callId: "tc",
        name: "create_plan",
        input: {
          replace: false,
          summary: "First draft",
          changes: ["A street over the workings"],
          plan: MINE,
        },
      },
    ],
  },
  { kind: "reply", usage, parts: [{ type: "text", text: "First take on the mining camp." }] },
];

/** Where the tab's screenshots go (git-ignored): SLAB_UI_SHOTS, else this checkout's docs/internal/renders/ui. */
const uiShots =
  process.env["SLAB_UI_SHOTS"] ??
  fileURLToPath(new URL("../../../docs/internal/renders/ui/", import.meta.url));
const shoot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(uiShots, { recursive: true });
  await page.screenshot({ path: path.join(uiShots, name), animations: "disabled" });
};

/** Clicks points across the canvas until one lands on a piece (the card names it). */
async function clickAPiece(page: Page, canvas: Locator): Promise<boolean> {
  const box = await canvas.boundingBox();
  if (!box) return false;
  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.45, 0.55],
    [0.55, 0.45],
    [0.4, 0.5],
    [0.6, 0.5],
    [0.5, 0.6],
    [0.5, 0.4],
  ] as const) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    if (await page.getByRole("region", { name: "Selected piece" }).isVisible()) return true;
  }
  return false;
}

test("the 3D tab: what it is, how to move, the colour key, a clicked piece, roofs and levels", async () => {
  test.setTimeout(180_000);
  const tabRun = newRun("slabyrinth-view3d-tab-", TAB_STEPS);
  const { app, page } = await launch(tabRun);
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
    await composer.fill("A mining camp over its workings");
    await composer.press("Enter");
    const approve = page.getByRole("button", { name: /Approve plan v1/ });
    await expect(approve).toBeVisible({ timeout: 30_000 });

    // the tab sits between Map and Build; the main action stays in the status bar
    const stageTabs = page.getByRole("tablist", { name: "Stage" }).getByRole("tab");
    await expect(stageTabs).toHaveText(["Map", "3D", "Build"]);
    await stageTabs.nth(1).click();
    const bar = page.getByRole("toolbar", { name: "3D view" });
    await expect(bar).toContainText("v1 as TaleSpire will get it");
    await expect(approve).toBeVisible();
    const levelTabs = page.getByRole("tablist", { name: "Levels shown in 3D" }).getByRole("tab");
    await expect(levelTabs).toHaveText(["All levels", "L1Forgotten Row", "L2Forgotten workings"]);

    // a drawn frame, or (no WebGL2 in this window) the still picture from main
    await expect.poll(async () => (await probe(page)).mode, { timeout: 60_000 }).toMatch(/^(ready|still)$/);
    const mode = (await probe(page)).mode;
    if (mode === "still") {
      await expect(page.locator(".v3still__img")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/graphics card can't show the 3D view/)).toBeVisible();
      await levelTabs.nth(2).click();
      await expect(levelTabs.nth(2)).toHaveAttribute("aria-selected", "true");
      await shoot(page, "surface-still.png");
      console.log("view3d tab e2e: WebGL2 unavailable in the test window; checked the still picture");
      return;
    }
    await expect.poll(async () => (await probe(page)).drawn, { timeout: 30_000 }).toBeGreaterThan(1000);

    // first use: what this is and how to move
    const hint = page.getByRole("region", { name: "About the 3D view" });
    await expect(hint).toContainText("This is what TaleSpire will get");
    const key = page.getByRole("complementary", { name: "Colour key" });
    await expect(key.getByRole("checkbox", { name: /Roof/ })).toBeVisible({ timeout: 30_000 });
    await shoot(page, "surface-first-run.png");
    await hint.getByRole("button", { name: "Got it" }).click();
    await expect(hint).toBeHidden();

    // test mode has no TaleSpire: every piece is a box, said once (the banner, when shown, has the button)
    const status = page.getByRole("status", { name: "3D view status" });
    await expect(status).toContainText("plain box of its real size");
    await shoot(page, "surface-normal.png");

    // the Controls card, from the toolbar
    await bar.getByRole("button", { name: "Controls" }).click();
    await expect(page.getByRole("dialog", { name: "3D controls" })).toContainText("W A S D");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "3D controls" })).toBeHidden();

    // the keyboard on the focused view: T looks straight down
    const canvas = page.getByRole("application", { name: "3D view of v1" });
    await canvas.focus();
    const elevation = (): Promise<number> =>
      page.evaluate(() => {
        const t = (
          window as unknown as {
            __slabyrinthView3dTab?: { api: { getCamera(): { elevation: number } } | null };
          }
        ).__slabyrinthView3dTab;
        return t?.api?.getCamera().elevation ?? 0;
      });
    await page.keyboard.press("t");
    await expect.poll(elevation).toBeGreaterThan(80);
    await page.keyboard.press("0");
    await expect.poll(elevation).toBeLessThan(80);
    // Enter is the keyboard's click (what is in the middle of the view); Esc clears it
    const card = page.getByRole("region", { name: "Selected piece" });
    await page.keyboard.press("Enter");
    await expect(card).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();

    // a clicked piece says what it is, with Show on map and Mention in chat
    expect(await clickAPiece(page, canvas)).toBe(true);
    await expect(card.getByRole("button", { name: "Show on map" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Mention in chat" })).toBeVisible();
    await shoot(page, "surface-piece-selected.png");
    await card.getByRole("button", { name: "Clear (Esc)" }).click();
    await expect(card).toBeHidden();

    // the colour key hides a kind of piece; the status line says so, with one way back
    await key.getByText("Wall", { exact: true }).click();
    await expect(status).toContainText("Hidden: wall.");
    await status.getByRole("button", { name: "Show everything" }).click();
    await expect(status).not.toContainText("Hidden:");

    // roofs off (R on the tab, and the button agrees), then the lower level: the street above is hidden
    await page.keyboard.press("r");
    const roofs = bar.getByRole("button", { name: "Hide roofs" });
    await expect(roofs).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await probe(page)).hideRoofs).toBe(true);
    await levelTabs.nth(2).click();
    await expect(levelTabs.nth(2)).toHaveAttribute("aria-selected", "true");
    await expect.poll(async () => (await probe(page)).cutLevel).toBe(0);
    await expect.poll(async () => (await probe(page)).drawn).toBeGreaterThan(100);
    await expect(status).toContainText("Hidden: L1 Forgotten Row, roofs.");
    await page.waitForTimeout(400);
    await shoot(page, "surface-roofs-hidden-lower-level.png");
    // PgUp steps back up to every level
    await canvas.focus();
    await page.keyboard.press("PageUp");
    await page.keyboard.press("PageUp");
    await expect(levelTabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect.poll(async () => (await probe(page)).cutLevel).toBe(null);

    // without the banner, the boxes note carries its own way to fix it
    const continueWithout = page.getByRole("button", { name: "Continue without it" });
    if (await continueWithout.isVisible()) await continueWithout.click();
    await expect(status.getByRole("button", { name: "Locate TaleSpire…" })).toBeVisible();
    await status.getByRole("button", { name: "Show everything" }).click();
    await page.waitForTimeout(400);
    await shoot(page, "surface-boxes-notice.png");
  } finally {
    await app.close();
    cleanRun(tabRun);
  }
});
