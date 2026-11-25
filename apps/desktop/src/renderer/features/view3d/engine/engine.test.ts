import { beforeAll, describe, expect, it } from "vitest";
import type { Scene } from "@slabyrinth/scene3d";
import { memorySceneSource, type MemoryBuild, type MemorySourceOptions } from "../memorySceneSource";
import type { SceneSource } from "../sceneSource";
import { syntheticTown } from "../synthetic";
import { View3dEngine, type EngineOptions } from "./engine";
import { fakeBackend, type FakeBackend } from "./fakeBackend";

const W = 1600;
const H = 900;

/** An engine on the fake backend with frames run by hand. */
function rig(opts: EngineOptions = {}): {
  engine: View3dEngine;
  backend: FakeBackend;
  queued: () => number;
  settle: (ticks?: number) => Promise<void>;
} {
  const queue: ((t: number) => void)[] = [];
  const backend = fakeBackend();
  const canvas = {
    clientWidth: W,
    clientHeight: H,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) as DOMRect,
  };
  const engine = new View3dEngine(backend, canvas, {
    schedule: (fn) => queue.push(fn),
    cancelSchedule: () => undefined,
    reducedMotion: () => true,
    ...opts,
  });
  engine.resize(W, H);
  const settle = async (ticks = 400): Promise<void> => {
    let quiet = 0;
    for (let i = 0; i < ticks && quiet < 4; i++) {
      const fns = queue.splice(0);
      for (const f of fns) f(performance.now());
      await new Promise((r) => setTimeout(r, 0));
      quiet = fns.length === 0 && queue.length === 0 ? quiet + 1 : 0;
    }
  };
  return { engine, backend, queued: () => queue.length, settle };
}

let town: Scene;
let townBoxes: Scene;
beforeAll(async () => {
  town = await syntheticTown({ side: 192 });
  townBoxes = await syntheticTown({ side: 192, boxes: true });
});

const source = (b: MemoryBuild, o?: MemorySourceOptions): SceneSource =>
  memorySceneSource(new Map([["b1", b]]), o);

describe("viewer engine", () => {
  it("opens a scene, pulls the chunks in view and draws them", async () => {
    const { engine, backend, settle } = rig();
    const states: string[] = [];
    engine.on("state", (s) => states.push(s.kind));
    engine.open(source(town), "b1");
    await settle();
    expect(states[0]).toBe("loading");
    expect(states.at(-1)).toBe("ready");
    const st = engine.stats();
    expect(st.instancesDrawn).toBeGreaterThan(0);
    expect(st.firstFrameMs).not.toBeNull();
    expect(st.chunksLoaded).toBeGreaterThan(0);
    expect(backend.last.instances).toBeGreaterThan(0);
    // framed on the whole map: every chunk is in view, so all were pulled
    expect(st.instancesLoaded).toBe(town.instances.length);
  });

  it("draws only when something changed (no idle loop)", async () => {
    const { engine, backend, queued, settle } = rig();
    engine.open(source(town), "b1");
    await settle();
    const draws = backend.draws;
    expect(queued()).toBe(0);
    await settle(20);
    expect(backend.draws).toBe(draws);
    engine.orbit(10, 0);
    engine.orbit(10, 0);
    expect(queued()).toBe(1);
    await settle();
    expect(backend.draws).toBeGreaterThan(draws);
  });

  it("near the ground, swaps boxes for meshes as they arrive, under the budget", async () => {
    const { engine, backend, settle } = rig();
    engine.open(source(town), "b1");
    await settle();
    const cam = engine.getCamera();
    engine.setCamera({ ...cam, target: { x: 96, y: 0, z: 96 }, distance: 25, elevation: 30 });
    await settle();
    expect(backend.last.meshCalls).toBeGreaterThan(0);
    const st = engine.stats();
    expect(st.meshesResident).toBeGreaterThan(0);
    expect(st.gpuBytes).toBeLessThanOrEqual(st.gpuBudgetBytes);
  });

  it("only pulls the chunks a close view needs", async () => {
    const { engine, settle } = rig();
    engine.open(source(town), "b1");
    // set a close camera as soon as the header arrives (before any chunk)
    engine.on("header", () => {
      engine.setCamera({ target: { x: 10, y: 0, z: 10 }, distance: 12, bearing: 225, elevation: 30 });
    });
    await settle();
    const st = engine.stats();
    expect(st.chunksLoaded).toBeGreaterThan(0);
    expect(st.chunksLoaded).toBeLessThan(st.chunks);
  });

  it("swaps to the detailed scene when the shapes are read, keeping the camera", async () => {
    const { engine, backend, settle } = rig();
    const headers: number[] = [];
    engine.on("header", (h) => headers.push(h.pendingDetail));
    engine.open(source({ boxes: townBoxes, detail: town }, { detailAfterMs: 5 }), "b1");
    await settle(30);
    expect(headers[0]).toBeGreaterThan(0);
    const cam = { target: { x: 96, y: 0, z: 96 }, distance: 25, bearing: 200, elevation: 30 };
    engine.setCamera(cam);
    await new Promise((r) => setTimeout(r, 20));
    await settle();
    expect(headers).toHaveLength(2);
    expect(headers[1]).toBe(0);
    expect(engine.getCamera()).toEqual(cam);
    expect(backend.last.meshCalls).toBeGreaterThan(0);
  });

  it("survives losing the GPU context and draws again when it returns", async () => {
    const { engine, backend, settle } = rig();
    engine.open(source(town), "b1");
    await settle();
    backend.lose();
    engine.contextLost();
    expect(engine.state.kind).toBe("lost");
    engine.orbit(5, 0);
    await settle();
    backend.restore();
    engine.contextRestored();
    await settle();
    expect(engine.state.kind).toBe("ready");
    expect(backend.buffers.size).toBeGreaterThan(0);
    expect(backend.last.instances).toBeGreaterThan(0);
  });

  it("degrades instead of failing when the GPU budget is tiny", async () => {
    const { engine, backend, settle } = rig({ gpuBudgetBytes: 256 * 1024 });
    const limited: boolean[] = [];
    engine.on("limited", (l) => limited.push(l));
    engine.open(source(town), "b1");
    await settle();
    engine.setCamera({ target: { x: 96, y: 0, z: 96 }, distance: 25, bearing: 225, elevation: 30 });
    await settle();
    expect(limited).toContain(true);
    expect(backend.heldBytes()).toBeLessThanOrEqual(256 * 1024);
    expect(backend.last.instances).toBeGreaterThan(0);
  });

  it("reports a missing scene as a typed error", async () => {
    const { engine, settle } = rig();
    engine.open(source(town), "nope");
    await settle();
    expect(engine.state).toMatchObject({ kind: "error", error: { code: "source", sourceCode: "not-found" } });
  });

  it("picks what is under the cursor and frames it", async () => {
    const { engine, settle } = rig();
    engine.open(source(town), "b1");
    await settle();
    const picks: (number | null)[] = [];
    engine.on("pick", (p) => picks.push(p ? p.id : null));
    // look straight down on a floor tile: it is at the picture's centre
    const floor = town.instances.find((i) => i.role === "floor" && i.layer !== "roof");
    expect(floor).toBeDefined();
    const at = floor ? { x: floor.at.x + 0.5, y: 0, z: floor.at.z + 0.5 } : { x: 0, y: 0, z: 0 };
    engine.setCamera({ target: at, distance: 30, bearing: 180, elevation: 89.5 });
    const p = engine.clickAt(W / 2, H / 2);
    expect(p).not.toBeNull();
    expect(picks).toEqual([p?.id]);
    expect(p?.levelName).toMatch(/^Level/);
    expect(engine.frameSelection()).toBe(true);
    await settle();
    expect(engine.getCamera().distance).toBeLessThan(40);
    if (p?.elementId) expect(engine.frameElement(p.elementId)).toBe(true);
    engine.select(null);
    expect(engine.selection).toBeNull();
  });

  it("never lets the camera under the ground or out of reach", async () => {
    const { engine, settle } = rig();
    engine.open(source(town), "b1");
    await settle();
    engine.setCamera({ target: { x: 1e6, y: -100, z: -1e6 }, distance: 1e7, bearing: 0, elevation: -45 });
    const c = engine.getCamera();
    const lim = engine.getLimits();
    expect(c.distance).toBeLessThanOrEqual(lim.maxDistance);
    expect(c.elevation).toBeGreaterThan(0);
    expect(c.target.y).toBeGreaterThanOrEqual(lim.ground);
    expect(c.target.x).toBeLessThanOrEqual(lim.box.max.x);
  });

  it("frees everything on close", async () => {
    const { engine, backend, settle } = rig();
    engine.open(source(town), "b1");
    await settle();
    engine.close();
    expect(backend.heldBytes()).toBe(0);
    expect(engine.header).toBeNull();
  });
});

describe("budgets on a 1024 × 1024 map (synthetic town, ≥ 300,000 pieces)", () => {
  it("first frame, frame time while moving, memory, and degradation", async () => {
    const t0 = performance.now();
    const big = await syntheticTown({ side: 1024 });
    const buildMs = performance.now() - t0;
    expect(big.instances.length).toBeGreaterThanOrEqual(300_000);
    const { engine, backend, settle } = rig();
    const open0 = performance.now();
    engine.open(source(big), "b1");
    const first = { ms: -1 };
    engine.on("frame", (s) => {
      if (first.ms < 0 && s.instancesDrawn > 0) first.ms = performance.now() - open0;
    });
    await settle(2000);
    const loadMs = performance.now() - open0;
    const overview = engine.stats();
    const heapMb = overview.sceneBytes / 1e6;
    // moving: orbit and fly over the map, one frame each (CPU side: planning + submission)
    const times: number[] = [];
    engine.on("frame", (s) => times.push(s.frameMs));
    for (let i = 0; i < 60; i++) {
      engine.orbit(3, 0);
      await settle(5);
    }
    engine.setCamera({ target: { x: 512, y: 0, z: 512 }, distance: 30, bearing: 225, elevation: 25 });
    await settle(200);
    for (let i = 0; i < 60; i++) {
      engine.pan(8, 0);
      await settle(5);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)] ?? 0;
    const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
    const close = engine.stats();
    console.log(
      `viewer budget: ${big.instances.length} pieces, ${overview.chunks} chunks; scene build ${buildMs.toFixed(0)} ms; ` +
        `first frame ${first.ms.toFixed(0)} ms, all loaded ${loadMs.toFixed(0)} ms; ` +
        `scene data in the viewer ${heapMb.toFixed(1)} MB; overview ${overview.drawCalls} calls ${overview.triangles} tris lod ${overview.lodChunks.join("/")}; ` +
        `moving frame median ${median.toFixed(2)} ms p95 ${p95.toFixed(2)} ms; close ${close.drawCalls} calls ${close.triangles} tris ` +
        `meshes ${close.meshesResident}/${close.meshesWithDetail}; GPU ${(close.gpuBytes / 1e6).toFixed(1)} MB`,
    );
    expect(first.ms).toBeGreaterThanOrEqual(0);
    expect(first.ms).toBeLessThan(5000);
    expect(overview.triangles).toBeLessThanOrEqual(3_000_000 + overview.chunks * 64 * 12);
    expect(overview.drawCalls).toBeLessThanOrEqual(1_500);
    expect(median).toBeLessThan(16);
    expect(close.gpuBytes).toBeLessThanOrEqual(close.gpuBudgetBytes);
    expect(backend.heldBytes()).toBeLessThan(384 * 1024 * 1024);
    // about 60 bytes per piece (the wire's arrays and a world box)
    expect(overview.sceneBytes / big.instances.length).toBeLessThan(80);
    // a tiny budget on the same map: detail is limited, nothing fails
    const tiny = rig({ gpuBudgetBytes: 4 * 1024 * 1024 });
    tiny.engine.open(source(big), "b1");
    await tiny.settle(2000);
    expect(tiny.backend.heldBytes()).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(tiny.engine.stats().instancesDrawn + tiny.backend.last.instances).toBeGreaterThan(0);
    expect(tiny.engine.state.kind).toBe("ready");
  }, 120_000);
});
