/** The SceneSource over the bridge, against the renderer's fake main (real box scenes of the open plan). */
import { describe, expect, it } from "vitest";
import { NO_CELL } from "../../../shared/view3dWire";
import { call, setBridge } from "../../bridge/client";
import { createFakeBridge, type FakeScenario } from "../../bridge/fake/fakeBridge";
import { View3dEngine } from "./engine/engine";
import { fakeBackend } from "./engine/fakeBackend";
import { ipcSceneSource, type View3dBridge } from "./ipcSceneSource";
import { SceneSourceError, type SceneHeader } from "./sceneSource";

async function openAbbey(scenario: FakeScenario = {}): Promise<ReturnType<typeof createFakeBridge>> {
  const bridge = createFakeBridge({ speed: 0, scenario });
  setBridge(bridge);
  const list = await call("project:list", undefined);
  const abbey = list.find((p) => p.name === "The Drowned Abbey");
  if (!abbey) throw new Error("fixture project missing");
  await call("project:open", { path: abbey.path });
  return bridge;
}

describe("ipcSceneSource", () => {
  it("opens a version, pulls chunks with roles and cells, meshes, and closes", async () => {
    await openAbbey();
    const src = ipcSceneSource();
    const h = await src.open({ version: 4 });
    expect(h.version).toBe(4);
    const { chunks, more } = await src.chunks(
      h.sceneId,
      h.chunks.map((c) => c.id),
    );
    expect(more).toEqual([]);
    const all = chunks.flatMap((c) => [...c.role].map((r) => (r < 0 ? null : (c.roles[r] ?? "?"))));
    expect(all).toHaveLength(h.counts.instances);
    // every piece of a build has its placement's role, from the chunk's role table
    expect(all.every((r) => r !== null && r !== "?")).toBe(true);
    expect(all).toContain("floor");
    expect(all).toContain("wall");
    const c0 = chunks[0];
    if (!c0) throw new Error("no chunk");
    expect(c0.role).toBeInstanceOf(Int8Array);
    expect(c0.cell).toBeInstanceOf(Int16Array);
    expect(c0.cell.length).toBe(c0.count * 2);
    const cells = chunks.flatMap((c) => [...c.cell]);
    expect(cells.some((v) => v !== NO_CELL)).toBe(true);
    const keys = [...new Set(chunks.flatMap((c) => [...c.mesh]))].map((i) => h.meshes[i]?.key ?? "");
    const m = await src.meshes(h.sceneId, keys);
    expect(m.meshes).toHaveLength(keys.length);
    src.close(h.sceneId);
    await expect(src.chunks(h.sceneId, [c0.id])).rejects.toMatchObject({ code: "not-found" });
  });

  it("turns the bridge's failures into source errors", async () => {
    await openAbbey();
    const src = ipcSceneSource();
    await expect(src.open({ version: 99 })).rejects.toBeInstanceOf(SceneSourceError);
    await expect(src.open({ version: 99 })).rejects.toMatchObject({ code: "not-found" });
    await expect(src.open({ buildId: "no-such-build" })).rejects.toMatchObject({ code: "not-found" });
  });

  it("sends cancel and close to main, and maps a stopped open to cancelled", async () => {
    const bridge = await openAbbey();
    const sent: Array<[string, unknown]> = [];
    let stopNext = false;
    const invoke: View3dBridge["invoke"] = (channel, req) => {
      sent.push([channel, req]);
      if (channel === "view3d:open" && stopNext)
        return Promise.resolve({ ok: false, error: { code: "cancelled", message: "Stopped." } });
      return bridge.invoke(channel, req);
    };
    const src = ipcSceneSource({ invoke, on: bridge.on.bind(bridge) });
    const h = await src.open({});
    src.cancel();
    src.cancel(h.sceneId);
    src.close(h.sceneId);
    stopNext = true;
    await expect(src.open({ version: 4 })).rejects.toMatchObject({ code: "cancelled" });
    expect(sent).toEqual([
      ["view3d:open", {}],
      ["view3d:cancel", {}],
      ["view3d:cancel", { sceneId: h.sceneId }],
      ["view3d:close", { sceneId: h.sceneId }],
      ["view3d:open", { version: 4 }],
    ]);
  });

  it("forwards progress, and the engine swaps to the detailed scene when detail completes", async () => {
    await openAbbey({ meshes: "reading" });
    const src = ipcSceneSource();
    const stages: string[] = [];
    const off = src.onProgress((p) => stages.push(p.stage));
    const canvas = {
      clientWidth: 800,
      clientHeight: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
    };
    const engine = new View3dEngine(fakeBackend(), canvas, {
      schedule: (fn) =>
        setTimeout(() => {
          fn(performance.now());
        }, 0),
      cancelSchedule: (h) => {
        clearTimeout(h);
      },
      reducedMotion: () => true,
    });
    engine.resize(800, 600);
    const headers: SceneHeader[] = [];
    engine.on("header", (h) => headers.push(h));
    engine.open(src, { version: 4 });
    await expect.poll(() => headers.length, { timeout: 5000 }).toBe(2);
    const [boxes, detailed] = headers;
    expect(boxes?.pendingDetail).toBeGreaterThan(0);
    expect(boxes?.boxes.reasons.map((r) => r.reason)).toEqual(["not-read-yet"]);
    expect(detailed?.pendingDetail).toBe(0);
    expect(detailed?.sceneId).not.toBe(boxes?.sceneId);
    expect(stages).toContain("layout");
    expect(stages).toContain("detail");
    expect(engine.state.kind).toBe("ready");
    // the boxes scene was released: main no longer serves it
    await expect(src.chunks(boxes?.sceneId ?? "", ["L0:0:0"])).rejects.toMatchObject({ code: "not-found" });
    engine.close();
    engine.dispose();
    off();
  });
});
