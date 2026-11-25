/**
 * Test builds only (main.tsx loads it when import.meta.env.MODE is "test"): mounts the bare viewer over the app on the
 * synthetic town (≥ 300,000 pieces over 1024 × 1024 tiles) through the in-memory source, and exposes the viewer API
 * and a few measurements on `window.__view3d` for the e2e spec.
 */
import { createRoot } from "react-dom/client";
import { createRef } from "react";
import { View3dCanvas } from "./View3dCanvas";
import { memorySceneSource } from "./memorySceneSource";
import { syntheticTown } from "./synthetic";
import type { View3dApi, View3dState } from "./engine/engine";

export interface View3dHarness {
  api: View3dApi | null;
  pieces: number;
  sceneBuildMs: number;
  /** JS heap (Chromium's performance.memory) before the scene, after it was built, and after the viewer loaded it. */
  heap: { before: number; scene: number; loaded: number };
  states: View3dState["kind"][];
  /** Resolves when the viewer drew pieces, or failed. */
  settled: Promise<View3dState["kind"]>;
}

const heapNow = (): number =>
  (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;

/** A frame scheduler that does not stall when the window is hidden (rAF is paused there): the first of both wins. */
function schedule(fn: (t: number) => void): number {
  let done = false;
  const run = (t: number): void => {
    if (done) return;
    done = true;
    fn(t);
  };
  requestAnimationFrame(run);
  setTimeout(() => {
    run(performance.now());
  }, 32);
  return 0;
}

export async function mountView3dHarness(side = 1024): Promise<void> {
  const before = heapNow();
  const t0 = performance.now();
  const scene = await syntheticTown({ side });
  const sceneBuildMs = performance.now() - t0;
  const afterScene = heapNow();
  const host = document.createElement("div");
  host.dataset["testid"] = "view3d-harness";
  host.style.cssText = "position:fixed;inset:0;z-index:10000;";
  document.body.append(host);
  const ref = createRef<View3dApi | null>();
  let settle: (k: View3dState["kind"]) => void = () => undefined;
  const h: View3dHarness = {
    api: null,
    pieces: scene.instances.length,
    sceneBuildMs,
    heap: { before, scene: afterScene, loaded: 0 },
    states: [],
    settled: new Promise((r) => (settle = r)),
  };
  (window as unknown as { __view3d: View3dHarness }).__view3d = h;
  const source = memorySceneSource(new Map([["synthetic", scene]]));
  createRoot(host).render(
    <View3dCanvas
      ref={ref}
      source={source}
      target={{ buildId: "synthetic" }}
      options={{ schedule }}
      onState={(s) => {
        h.states.push(s.kind);
        h.api = ref.current;
        if (s.kind === "error") settle("error");
      }}
      onFrame={(st) => {
        h.api = ref.current;
        if (st.drawCalls > 0) {
          h.heap.loaded = heapNow();
          settle("ready");
        }
      }}
    />,
  );
}
