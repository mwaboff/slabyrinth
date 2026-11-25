import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { cleanRun, launch, newRun, type Run } from "./helpers";
import { UI_PLAN } from "./uiScript";

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
      await expect(harness.getByRole("alert")).toHaveText(/graphics acceleration/);
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
const TAB_STEPS = [
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
const uiShots = fileURLToPath(new URL("../../../docs/internal/renders/ui/", import.meta.url));

test("the 3D tab: a plan drawn in 3D (or its still picture), roofs off, shown up to a level", async () => {
  test.setTimeout(150_000);
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
    await composer.fill("A crypt under a ruined abbey");
    await composer.press("Enter");
    await expect(page.getByRole("button", { name: /Approve plan v1/ })).toBeVisible({ timeout: 30_000 });

    // the tab sits between Map and Build
    const stageTabs = page.getByRole("tablist", { name: "Stage" }).getByRole("tab");
    await expect(stageTabs).toHaveText(["Map", "3D", "Build"]);
    await stageTabs.nth(1).click();
    const bar = page.getByRole("toolbar", { name: "3D view" });
    await expect(bar).toContainText("3D of v1");

    // a drawn frame, or (no WebGL2 in this window) the still picture from main
    await expect.poll(async () => (await probe(page)).mode, { timeout: 60_000 }).toMatch(/^(ready|still)$/);
    const mode = (await probe(page)).mode;
    if (mode === "still") {
      await expect(page.locator(".v3still__img")).toBeVisible({ timeout: 30_000 });
      console.log("view3d tab e2e: WebGL2 unavailable in the test window; checked the still picture");
    } else {
      await expect.poll(async () => (await probe(page)).drawn, { timeout: 30_000 }).toBeGreaterThan(1000);
      // test mode has no TaleSpire: every piece is a box, and the tab says why and what to do
      await expect(page.getByRole("status", { name: "3D view status" })).toContainText(
        "Showing boxes because TaleSpire was not found",
      );
      // roofs off
      const roofs = bar.getByRole("button", { name: "Roofs" });
      await expect(roofs).toHaveAttribute("aria-pressed", "true");
      await roofs.click();
      await expect(roofs).toHaveAttribute("aria-pressed", "false");
      await expect.poll(async () => (await probe(page)).hideRoofs).toBe(true);
    }
    // show up to the lowest level
    const levels = bar.getByRole("combobox", { name: "Show up to" });
    await levels.selectOption({ index: 1 });
    await expect(levels).toHaveValue("0");
    if (mode !== "still") {
      await expect.poll(async () => (await probe(page)).cutLevel).toBe(0);
      await expect.poll(async () => (await probe(page)).drawn).toBeGreaterThan(100);
    }

    mkdirSync(uiShots, { recursive: true });
    await page.screenshot({ path: path.join(uiShots, "view3d-tab.png"), animations: "disabled" });
  } finally {
    await app.close();
    cleanRun(tabRun);
  }
});
