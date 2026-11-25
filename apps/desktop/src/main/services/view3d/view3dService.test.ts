/**
 * The 3D view's scenes and the model's pictures through the real scene-worker handler run in-process: chunks and
 * meshes on demand under the reply cap, the mesh budget (boxes past it), cancellation and the out-of-memory retry
 * with boxes, deterministic pictures, and the large synthetic map's numbers. Temp dirs, synthetic meshes only.
 */
import * as fsp from "node:fs/promises";
import type { MapPlan } from "@slabyrinth/core";
import type { BundleExtractor } from "@slabyrinth/scene3d";
import { afterEach, describe, expect, it } from "vitest";
import type { IpcEvents } from "../../../shared/ipc";
import type { ProjectFile } from "../../../shared/project";
import { FIXTURE_PLAN } from "../../fixturePlan";
import { memoryLogger } from "../../logger";
import { createMeshHandler } from "../../workers/meshHandler";
import type { MeshWorkerRequest, MeshWorkerResponse } from "../../workers/meshProtocol";
import { createSceneHandler } from "../../workers/sceneHandler";
import { sceneWorkerLoop } from "../../workers/sceneLoop";
import type {
  SceneWorkerMessage,
  SceneWorkerRequest,
  SceneWorkerResponse,
} from "../../workers/sceneProtocol";
import { MeshService } from "../meshes/meshService";
import type { ScenePort } from "./sceneLane";
import {
  gridPlan,
  inProcessPort,
  oomError,
  syntheticInstall,
  SYNTH_INSTALL,
  tempDir,
} from "../testing/view3dRig";
import { TOO_BIG, View3dService, type SceneOwner } from "./view3dService";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

type TestPort = ScenePort & { terminated: boolean; posted: SceneWorkerMessage[] };
type Handler = (msg: SceneWorkerRequest, post: (r: SceneWorkerResponse) => void) => Promise<void>;

/** A scene worker in-process: the real queue (sceneLoop) over `handle` (a fresh scene keeper per worker). */
const scenePort = (handle: Handler): TestPort =>
  inProcessPort<SceneWorkerMessage, SceneWorkerResponse>(sceneWorkerLoop(handle));

/** A scene keeper whose builds take `ms` longer (a big map's layout). */
function slowBuilds(ms: number): Handler {
  const handle = createSceneHandler();
  return async (msg, post) => {
    if (msg.type === "build") await sleep(ms);
    await handle(msg, post);
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A scene keeper that starts every job and never finishes it. */
const hung: Handler = () => new Promise<void>(() => undefined);

interface Rig {
  svc: View3dService;
  meshes: MeshService;
  events: Array<{ c: string; p: unknown }>;
  ports: Array<TestPort & { owner: SceneOwner }>;
  install: ReturnType<typeof syntheticInstall>;
}

/** A project of `plans` (v1..vn); a synthetic install that knows `uuids` (none: no install). */
async function rig(
  plans: MapPlan[],
  o: {
    uuids?: string[];
    budget?: number;
    scenePort?: (n: number, owner: SceneOwner) => TestPort | null;
    deadlines?: { buildMs?: number; requestMs?: number };
    /** The reader's decoder (default: the synthetic install's, which reads every piece). */
    extract?: BundleExtractor;
  } = {},
): Promise<Rig> {
  const cacheDir = await tempDir("slab-v3d-");
  dirs.push(cacheDir);
  const install = syntheticInstall(o.uuids ?? []);
  const events: Rig["events"] = [];
  const emit = (c: string, p: unknown): void => {
    events.push({ c, p });
  };
  const meshHandler = createMeshHandler({ fs: install.fs, extract: o.extract ?? install.extract });
  const meshes = new MeshService({
    cacheDir,
    installPath: () => Promise.resolve(o.uuids ? SYNTH_INSTALL : null),
    enabled: () => true,
    spawn: () => inProcessPort<MeshWorkerRequest, MeshWorkerResponse>(meshHandler),
    emit: emit,
    logger: memoryLogger(),
  });
  const ports: Rig["ports"] = [];
  const project = {
    history: {
      head: plans.length,
      versions: plans.map((_, i) => ({ number: i + 1, parentNumber: i })),
    },
    builds: [{ id: "b1", versionNumber: 1 }],
  } as unknown as ProjectFile;
  const svc = new View3dService({
    spawn: (owner) => {
      const p = o.scenePort?.(ports.length, owner) ?? scenePort(createSceneHandler({ fs: install.fs }));
      ports.push(Object.assign(p, { owner }));
      return p;
    },
    ...(o.deadlines ? { deadlines: o.deadlines } : {}),
    projects: {
      isOpen: true,
      getProject: () => project,
      getPlan: (v) => plans[(v ?? plans.length) - 1] ?? null,
    },
    inputs: () => ({ userPalettes: [], orientationOverride: null, catalog: null }),
    meshes,
    emit: emit,
    logger: memoryLogger(),
    ...(o.budget !== undefined ? { meshBudgetBytes: o.budget } : {}),
  });
  return { svc, meshes, events, ports, install };
}

/** The asset ids of a plan's scene (laid out once with boxes). */
async function uuidsOf(plan: MapPlan): Promise<string[]> {
  const r = await rig([plan]);
  const h = await r.svc.open({});
  const keys = h.meshes.map((m) => m.key.replace(/^box:/, ""));
  r.svc.dispose();
  return keys.filter((k) => k !== "?");
}

describe("3D view scenes", () => {
  it("lays out a plan in the worker; chunks and meshes come as typed arrays; boxes without an install", async () => {
    const r = await rig([FIXTURE_PLAN]);
    const h = await r.svc.open({});
    expect(h).toMatchObject({ version: 1, buildId: null, pendingDetail: 0, limited: null });
    expect(h.counts.instances).toBeGreaterThan(20);
    expect(h.counts.boxes).toBe(h.counts.instances);
    expect(h.boxes.reasons).toEqual([{ reason: "no-install", pieces: h.counts.instances }]);
    expect(r.events.some((e) => e.c === "view3d:progress")).toBe(true);
    const all = await r.svc.chunks({ sceneId: h.sceneId, chunkIds: h.chunks.map((c) => c.id) });
    expect(all.chunks.reduce((n, c) => n + c.count, 0)).toBe(h.counts.instances);
    expect(all.chunks[0]?.transform).toBeInstanceOf(Float32Array);
    const m = await r.svc.meshes({ sceneId: h.sceneId, keys: h.meshes.map((x) => x.key) });
    expect(m.meshes.length).toBe(h.meshes.length);
    // by build id: the build's plan version
    const b = await r.svc.open({ buildId: "b1" });
    expect(b).toMatchObject({ version: 1, buildId: "b1" });
    // hand-over: the scene the window showed is still served until the window closes it
    const ids = [h.chunks[0]?.id ?? ""];
    expect((await r.svc.chunks({ sceneId: h.sceneId, chunkIds: ids })).chunks).toHaveLength(1);
    // one scene per window: the next open releases every view scene but the one shown (b)
    const c = await r.svc.open({});
    await expect(r.svc.chunks({ sceneId: h.sceneId, chunkIds: ids })).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await r.svc.chunks({ sceneId: b.sceneId, chunkIds: ids })).chunks).toHaveLength(1);
    await r.svc.close(b.sceneId);
    await expect(r.svc.chunks({ sceneId: b.sceneId, chunkIds: ids })).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await r.svc.chunks({ sceneId: c.sceneId, chunkIds: ids })).chunks).toHaveLength(1);
    await expect(r.svc.open({ version: 9 })).rejects.toMatchObject({ code: "not_found" });
    r.svc.dispose();
  });

  it("game shapes come from the cache: boxes until read, then the detailed scene on opening again", async () => {
    const ids = await uuidsOf(FIXTURE_PLAN);
    const r = await rig([FIXTURE_PLAN], { uuids: ids });
    const first = await r.svc.open({});
    expect(first.pendingDetail).toBe(ids.length);
    expect(first.boxes.reasons[0]?.reason).toBe("not-read-yet");
    await r.meshes.warm([]); // the background read
    const done = r.events
      .filter((e) => e.c === "view3d:progress")
      .map((e) => e.p as IpcEvents["view3d:progress"])
      .filter((p) => p.sceneId === first.sceneId && p.stage === "detail");
    expect(done.at(-1)).toEqual({
      sceneId: first.sceneId,
      stage: "detail",
      done: ids.length,
      total: ids.length,
    });
    const second = await r.svc.open({});
    expect(second.pendingDetail).toBe(0);
    expect(second.counts.boxes).toBe(0);
    expect(second.meshes.every((m) => !m.box)).toBe(true);
    r.svc.dispose();
  });

  it("pieces that cannot be read are tried once: opening again reads nothing and waits for no detail", async () => {
    const ids = await uuidsOf(FIXTURE_PLAN);
    // a reader that decodes nothing (a game update our reader does not handle)
    const r = await rig([FIXTURE_PLAN], { uuids: ids, extract: () => new Map() });
    const bundleReads = (): number => r.install.reads.filter((x) => x.includes("/Assets/")).length;
    const first = await r.svc.open({});
    expect(first.pendingDetail).toBe(ids.length);
    await r.meshes.warm([]);
    const read = bundleReads();
    expect(read).toBeGreaterThan(0);
    // the window's swap after "detail" (or reopening the tab): nothing new to read, so no detail to wait for
    const second = await r.svc.open({});
    expect(second.pendingDetail).toBe(0);
    await r.meshes.warm([]);
    expect(bundleReads()).toBe(read);
    const detail = r.events
      .map((e) => e.p as IpcEvents["view3d:progress"])
      .filter((p) => p.sceneId === second.sceneId && p.stage === "detail");
    expect(detail).toEqual([]);
    // clearing the cache starts over
    await r.svc.meshesApi.clear();
    expect((await r.svc.open({})).pendingDetail).toBe(ids.length);
    r.svc.dispose();
  });

  it("past the mesh budget pieces are boxes and the header says detail was limited", async () => {
    const ids = await uuidsOf(FIXTURE_PLAN);
    const r = await rig([FIXTURE_PLAN], { uuids: ids, budget: 3 * 500 });
    await r.svc.open({});
    await r.meshes.warm([]);
    const h = await r.svc.open({});
    expect(h.limited).toMatch(/Detail limited/);
    expect(h.boxes.reasons.map((x) => x.reason)).toContain("budget");
    expect(h.meshes.filter((m) => !m.box).length).toBeGreaterThan(0);
    expect(h.meshes.filter((m) => !m.box).reduce((n, m) => n + m.bytes, 0)).toBeLessThan(3 * 500 + 2000);
    r.svc.dispose();
  });

  it("view3d:cancel stops the layout: the open fails 'cancelled' and the worker is stopped", async () => {
    const r = await rig([FIXTURE_PLAN], {
      // the first worker starts the layout and never finishes it
      scenePort: (n) => (n === 0 ? scenePort(hung) : null),
    });
    const opening = r.svc.open({});
    await new Promise((res) => setTimeout(res, 10));
    r.svc.cancel(undefined);
    await expect(opening).rejects.toMatchObject({ code: "cancelled" });
    expect(r.ports[0]?.terminated).toBe(true);
    // the next request starts a new worker
    const h = await r.svc.open({});
    expect(h.counts.instances).toBeGreaterThan(0);
    r.svc.dispose();
  });

  it("a worker out of memory lays the scene out once more with boxes only, and says so", async () => {
    const r = await rig([FIXTURE_PLAN], {
      scenePort: (n) =>
        n === 0
          ? inProcessPort<SceneWorkerMessage, SceneWorkerResponse>(() => undefined, { failWith: oomError() })
          : null,
    });
    const h = await r.svc.open({});
    expect(h.limited).toBe(TOO_BIG);
    expect(h.counts.boxes).toBe(h.counts.instances);
    r.svc.dispose();
  });

  it("a large synthetic map: layout, chunks under the 8 MB cap, a picture, within budget", async () => {
    // 24 × 24 walled rooms of 8 × 8 on a 242 × 242 level
    const plan = gridPlan(24);
    const r = await rig([plan]);
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const h = await r.svc.open({});
    const layoutMs = performance.now() - t0;
    const ids = h.chunks.map((c) => c.id);
    let fetched = 0;
    let replies = 0;
    let pending = ids;
    while (pending.length > 0) {
      const got = await r.svc.chunks({ sceneId: h.sceneId, chunkIds: pending });
      replies++;
      fetched += got.chunks.reduce((n, c) => n + c.count, 0);
      pending = got.more;
    }
    const t1 = performance.now();
    const pic = await r.svc.render3d({ shots: ["overview"] });
    const pictureMs = performance.now() - t1;
    const heapMb = (process.memoryUsage().heapUsed - heap0) / 1e6;
    console.info(
      `large map: ${String(h.counts.instances)} pieces in ${String(h.chunks.length)} chunks, layout ${String(Math.round(layoutMs))} ms, ` +
        `${String(replies)} chunk replies, picture ${String(Math.round(pictureMs))} ms, heap +${String(Math.round(heapMb))} MB`,
    );
    expect(h.counts.instances).toBeGreaterThan(20_000);
    expect(fetched).toBe(h.counts.instances);
    expect(h.chunks.every((c) => c.bytes < 8 * 1024 * 1024)).toBe(true);
    expect([...pic.png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    expect(layoutMs).toBeLessThan(60_000);
    expect(pictureMs).toBeLessThan(20_000);
    r.svc.dispose();
  }, 120_000);
});

describe("the model's 3D pictures", () => {
  it("one numbered sheet, captions per view, the same bytes for the same request", async () => {
    const r = await rig([FIXTURE_PLAN]);
    const a = await r.svc.render3d({});
    const b = await r.svc.render3d({});
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
    expect(a.captions.length).toBeGreaterThan(0);
    expect(a.captions.length).toBeLessThanOrEqual(4);
    a.captions.forEach((c, i) => {
      expect(c.startsWith(`${String(i + 1)}. `)).toBe(true);
    });
    expect(a.captions[0]).toMatch(/boxes: \d+/);
    // 1024 × 768 PNG
    const dv = new DataView(a.png.buffer, a.png.byteOffset);
    expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([1024, 768]);
    const one = await r.svc.render3d({ shots: ["overview"], max: 1 });
    expect(one.captions).toHaveLength(1);
    expect(one.captions[0]).toMatch(/^1\. The whole map/);
    const lvl = await r.svc.render3d({
      shots: [`level:${FIXTURE_PLAN.levels[0]?.id ?? ""}`, "front:nowhere"],
    });
    expect(lvl.captions).toHaveLength(1);
    expect(lvl.suggestions).toMatch(/Nothing to show for: front:nowhere/);
    r.svc.dispose();
  });

  it("changed: frames what the last version added or changed", async () => {
    const v2: MapPlan = structuredClone(FIXTURE_PLAN);
    const l = v2.levels[0];
    if (!l) throw new Error("fixture");
    l.areas.push({ id: "annex", kind: "room", shape: { type: "rect", x: 1, y: 14, w: 5, h: 4 } } as never);
    l.bounds = { ...l.bounds, h: Math.max(l.bounds.h, 20) };
    const r = await rig([FIXTURE_PLAN, v2]);
    const p = await r.svc.render3d({ shots: ["changed"] });
    expect(p.captions).toHaveLength(1);
    expect(p.captions[0]).toMatch(/What the last change touched: annex/);
    r.svc.dispose();
  });
});

describe("each owner's work stays its own (review A2)", () => {
  it("a request queued behind a long layout gets its full deadline: time queued does not count", async () => {
    const r = await rig([FIXTURE_PLAN], {
      deadlines: { requestMs: 80 },
      scenePort: () => scenePort(slowBuilds(250)),
    });
    const h = await r.svc.open({});
    // the window's swap lays the scene out again (250 ms) while it keeps pulling from the scene it shows
    const swapping = r.svc.open({});
    await sleep(20);
    const got = await r.svc.chunks({ sceneId: h.sceneId, chunkIds: [h.chunks[0]?.id ?? ""] });
    expect(got.chunks).toHaveLength(1);
    const next = await swapping;
    expect(next.sceneId).not.toBe(h.sceneId);
    expect(r.ports.filter((p) => p.owner === "view").map((p) => p.terminated)).toEqual([false]);
    r.svc.dispose();
  });

  it("opening the 3D tab again while the model's picture is made leaves the picture alone", async () => {
    const r = await rig([FIXTURE_PLAN], {
      scenePort: (_n, owner) => (owner === "model" ? scenePort(slowBuilds(200)) : null),
    });
    const picture = r.svc.render3d({ shots: ["overview"] });
    await sleep(20);
    // the GM opens the tab, then opens it again at once (the first layout is cancelled)
    const a = r.svc.open({});
    const b = r.svc.open({});
    await expect(a).rejects.toMatchObject({ code: "cancelled" });
    expect((await b).counts.instances).toBeGreaterThan(0);
    const p = await picture;
    expect(p.captions).toHaveLength(1);
    r.svc.dispose();
  });

  it("Stop in chat stops the model's picture only: the 3D tab's scene stays", async () => {
    const r = await rig([FIXTURE_PLAN], {
      scenePort: (_n, owner) => (owner === "model" ? scenePort(hung) : null),
    });
    const h = await r.svc.open({});
    const stop = new AbortController();
    const picture = r.svc.render3d({}, stop.signal);
    await sleep(20);
    stop.abort();
    await expect(picture).rejects.toMatchObject({ code: "cancelled" });
    expect(r.ports.find((p) => p.owner === "model")?.terminated).toBe(true);
    const got = await r.svc.chunks({ sceneId: h.sceneId, chunkIds: [h.chunks[0]?.id ?? ""] });
    expect(got.chunks).toHaveLength(1);
    expect(r.ports.find((p) => p.owner === "view")?.terminated).toBe(false);
    r.svc.dispose();
  });

  it("a view layout past its deadline costs the view's scenes only: they answer not_found, the model's stay", async () => {
    let views = 0;
    const r = await rig([FIXTURE_PLAN], {
      deadlines: { buildMs: 3_000 },
      // the view's first worker lays out once, then hangs on the next layout
      scenePort: (_n, owner) => {
        if (owner !== "view" || views++ > 0) return null;
        const handle = createSceneHandler();
        let builds = 0;
        return scenePort(async (msg, post) => {
          if (msg.type === "build" && builds++ > 0) return new Promise<void>(() => undefined);
          await handle(msg, post);
        });
      },
    });
    const h = await r.svc.open({});
    await r.svc.render3d({ shots: ["overview"] });
    await expect(r.svc.open({})).rejects.toMatchObject({ message: /didn't answer in time/ });
    await expect(
      r.svc.chunks({ sceneId: h.sceneId, chunkIds: [h.chunks[0]?.id ?? ""] }),
    ).rejects.toMatchObject({ code: "not_found" });
    // the model's scene was kept: the next picture lays nothing out again
    const modelPorts = r.ports.filter((p) => p.owner === "model");
    await r.svc.render3d({ shots: ["overview"] });
    expect(modelPorts.map((p) => p.terminated)).toEqual([false]);
    expect(modelPorts[0]?.posted.filter((m) => m.type === "build")).toHaveLength(1);
    // the window opens again on a new worker
    expect((await r.svc.open({})).counts.instances).toBeGreaterThan(0);
    r.svc.dispose();
  }, 20_000);
});
