/** The fake main's 3D view: a real box scene of the open plan, packed and capped as main packs it. */
import { beforeEach, describe, expect, it } from "vitest";
import type { IpcEvents } from "../../../shared/ipc";
import { call, setBridge } from "../client";
import { createFakeBridge } from "./fakeBridge";

describe("fake view3d channels", () => {
  let progress: Array<IpcEvents["view3d:progress"]> = [];
  beforeEach(async () => {
    const bridge = createFakeBridge({ speed: 0 });
    progress = [];
    bridge.on("view3d:progress", (p) => progress.push(p));
    setBridge(bridge);
    const list = await call("project:list", undefined);
    const abbey = list.find((p) => p.name === "The Drowned Abbey");
    if (!abbey) throw new Error("fixture project missing");
    await call("project:open", { path: abbey.path });
  });

  it("opens the head's scene, serves its chunks and meshes as typed arrays, and a picture", async () => {
    const h = await call("view3d:open", {});
    expect(h.version).toBe(4);
    expect(h.counts.instances).toBeGreaterThan(50);
    expect(h.counts.boxes).toBe(h.counts.instances);
    expect(h.boxes.note).toMatch(/box/);
    expect(progress.at(-1)).toMatchObject({ sceneId: h.sceneId, stage: "layout" });
    const total = h.chunks.reduce((n, c) => n + c.instances, 0);
    expect(total).toBe(h.counts.instances);
    const { chunks, more } = await call("view3d:chunks", {
      sceneId: h.sceneId,
      chunkIds: h.chunks.map((c) => c.id),
    });
    expect(more).toEqual([]);
    const c = chunks[0];
    expect(c?.transform).toBeInstanceOf(Float32Array);
    expect(c?.transform.length).toBe((c?.count ?? 0) * 4);
    expect(c?.mesh).toBeInstanceOf(Uint32Array);
    const used = [...new Set(chunks.flatMap((x) => [...x.mesh]))].map((i) => h.meshes[i]?.key ?? "");
    const m = await call("view3d:meshes", { sceneId: h.sceneId, keys: used });
    expect(m.meshes.length).toBe(used.length);
    expect(m.meshes[0]?.positions).toBeInstanceOf(Float32Array);
    const shot = await call("view3d:shot", { sceneId: h.sceneId, shot: "overview", width: 256, height: 192 });
    expect([...shot.png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    await call("view3d:close", { sceneId: h.sceneId });
    await expect(call("view3d:chunks", { sceneId: h.sceneId, chunkIds: ["L0:0:0"] })).rejects.toMatchObject({
      appError: { code: "not_found" },
    });
  });
});
